class BroadcastEngine {
    constructor() {
        this.timeManager = new TimeManager();
        this.scheduleManager = new ScheduleManager(this.timeManager);
        this.networkMonitor = new NetworkMonitor(this._onNetworkChange.bind(this));

        this.state = GTOON_CONFIG.STATES.IDLE;
        this.currentItem = null;
        this.currentIndex = -1;

        this.videoA = null;
        this.videoB = null;
        this.activeVideo = 'A';

        this.watchdogTimer = null;
        this.uiUpdateTimer = null;
        this.syncTimer = null;

        this.retryCount = 0;
        this.lastVideoTime = 0;
        this.stalledSince = 0;

        // Callbacks
        this.onStateChange = null;
        this.onItemChange = null;
        this.onTimeUpdate = null;
        this.onError = null;
        this.onBuffering = null;
        this.onProbeProgress = null;
    }

    async initialize() {
        Logger.log('Engine', '🚀 بدء التهيئة...');
        this._setState(GTOON_CONFIG.STATES.LOADING);

        this._createVideoElements();

        // 1. مزامنة الوقت
        await this.timeManager.syncTime();

        // 2. تحميل الجدول
        const loaded = await this.scheduleManager.loadSchedule();
        if (!loaded) {
            this._setState(GTOON_CONFIG.STATES.ERROR);
            if (this.onError) this.onError('schedule_load_failed');
            return false;
        }

        // 3. فحص مدد الفيديوهات
        this._setState(GTOON_CONFIG.STATES.PROBING);
        Logger.log('Engine', '🔍 فحص مدد الفيديوهات...');

        const probeResult = await this.scheduleManager.probeDurations((done, total, url, dur) => {
            Logger.log('Engine', `فحص ${done}/${total}: ${url.split('/').pop()} = ${dur}ث`);
            if (this.onProbeProgress) this.onProbeProgress(done, total, url, dur);
        });

        Logger.log('Engine', `✅ تم فحص المدد: ${probeResult.updated} محدّثة، ${probeResult.issues.length} مشاكل`);

        // 4. تجميع الجدول
        this.scheduleManager.compileDaySchedule();

        // 5. بدء البث
        await this._startPlayback();

        // 6. المراقبة
        this._startWatchdog();
        this._startUIUpdates();
        this._startPeriodicSync();
        this._setupVisibilityHandler();

        Logger.log('Engine', '✅ المحرك يعمل!');
        return true;
    }

    _createVideoElements() {
        const container = document.getElementById('video-container');

        this.videoA = document.createElement('video');
        this.videoA.id = 'video-a';
        this.videoA.className = 'broadcast-video active';
        this.videoA.playsInline = true;
        this.videoA.preload = 'auto';
        this.videoA.crossOrigin = 'anonymous';
        container.appendChild(this.videoA);

        this.videoB = document.createElement('video');
        this.videoB.id = 'video-b';
        this.videoB.className = 'broadcast-video';
        this.videoB.playsInline = true;
        this.videoB.preload = 'auto';
        this.videoB.crossOrigin = 'anonymous';
        container.appendChild(this.videoB);

        this._bindVideoEvents(this.videoA, 'A');
        this._bindVideoEvents(this.videoB, 'B');
    }

    _bindVideoEvents(video, label) {
        video.addEventListener('ended', () => {
            if (this._getActiveLabel() === label) {
                Logger.log('Engine', `انتهى ${label}`);
                this._onVideoEnded();
            }
        });

        video.addEventListener('error', () => {
            if (this._getActiveLabel() === label) {
                Logger.error('Engine', `خطأ في ${label}`, {
                    code: video.error?.code,
                    message: video.error?.message
                });
                this._onVideoError();
            }
        });

        video.addEventListener('waiting', () => {
            if (this._getActiveLabel() === label && this.onBuffering) {
                this.onBuffering(true);
            }
        });

        video.addEventListener('playing', () => {
            if (this._getActiveLabel() === label && this.onBuffering) {
                this.onBuffering(false);
            }
        });

        video.addEventListener('loadedmetadata', () => {
            Logger.log('Engine', `بيانات ${label}: ${video.duration.toFixed(1)}ث`);

            // تصحيح المدة تلقائياً
            if (this.currentItem && this._getActiveLabel() === label) {
                const expected = this.currentItem.duration;
                const actual = Math.floor(video.duration);
                const diff = Math.abs(expected - actual);

                if (diff > 2 && expected > 0) {
                    Logger.warn('Engine', `تصحيح المدة: ${expected}→${actual}ث (فرق ${diff}ث)`);

                    if (this.currentItem.index >= 0 && this.scheduleManager.compiledSchedule) {
                        const schedItem = this.scheduleManager.compiledSchedule[this.currentItem.index];
                        if (schedItem) {
                            schedItem.duration = actual;
                            schedItem.endTime = schedItem.startTime + actual;

                            // إعادة حساب العناصر بعده
                            let t = schedItem.endTime;
                            for (let i = this.currentItem.index + 1; i < this.scheduleManager.compiledSchedule.length; i++) {
                                this.scheduleManager.compiledSchedule[i].startTime = t;
                                this.scheduleManager.compiledSchedule[i].endTime = t + this.scheduleManager.compiledSchedule[i].duration;
                                t = this.scheduleManager.compiledSchedule[i].endTime;
                            }

                            this.currentItem.duration = actual;
                            this.currentItem.endTime = this.currentItem.startTime + actual;
                        }
                    }
                }
            }
        });
    }

    async _startPlayback() {
        const item = this.scheduleManager.getCurrentItem();

        if (!item) {
            Logger.error('Engine', 'لا يوجد محتوى');
            this._playEmergencyContent();
            return;
        }

        Logger.log('Engine', `▶️ ${item.title} (seek: ${item.seekPosition}ث, remaining: ${item.remaining}ث)`);

        this.currentItem = item;
        this.currentIndex = item.index;
        this.retryCount = 0;

        const video = this._getActiveVideo();
        try {
            await this._loadAndPlay(video, item.url, item.seekPosition, item.loop);
            this._setState(this._stateForType(item.type));
            if (this.onItemChange) this.onItemChange(item);
            this._preloadNext();
        } catch (error) {
            Logger.error('Engine', `فشل التشغيل: ${error.message}`);
            this._onVideoError();
        }
    }

    _loadAndPlay(video, url, seekTo = 0, loop = false) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout'));
            }, GTOON_CONFIG.VIDEO_LOAD_TIMEOUT * 1000);

            const cleanup = () => {
                clearTimeout(timeout);
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);
            };

            const onCanPlay = () => {
                cleanup();
                if (seekTo > 0 && isFinite(seekTo)) {
                    video.currentTime = seekTo;
                }
                video.loop = loop || false;

                video.play().then(() => {
                    resolve();
                }).catch(err => {
                    Logger.warn('Engine', 'Autoplay محجوب', err.message);
                    if (this.onError) this.onError('autoplay_blocked');
                    resolve();
                });
            };

            const onError = () => {
                cleanup();
                reject(new Error('Video load error'));
            };

            video.addEventListener('canplay', onCanPlay, { once: true });
            video.addEventListener('error', onError, { once: true });

            video.src = url;
            video.load();
        });
    }

    _preloadNext() {
        const nextItem = this.scheduleManager.getNextItem(this.currentIndex);
        if (!nextItem || !nextItem.url) return;

        const inactive = this._getInactiveVideo();
        Logger.log('Engine', `⏳ تحميل مسبق: ${nextItem.title}`);

        const preloadTimeout = setTimeout(() => {
            inactive.src = '';
            Logger.warn('Engine', 'مهلة التحميل المسبق');
        }, GTOON_CONFIG.PRELOAD_TIMEOUT * 1000);

        inactive.src = nextItem.url;
        inactive.preload = 'auto';
        inactive.load();

        inactive.addEventListener('canplay', () => {
            clearTimeout(preloadTimeout);
            Logger.log('Engine', '✅ تحميل مسبق مكتمل');
        }, { once: true });

        inactive.addEventListener('error', () => {
            clearTimeout(preloadTimeout);
            Logger.warn('Engine', '⚠️ فشل التحميل المسبق');
        }, { once: true });
    }

    async _onVideoEnded() {
        Logger.log('Engine', '⏭️ انتقال...');

        // تحقق: هل يوجد عنصر تالي؟
        const nextItem = this.scheduleManager.getNextItem(this.currentIndex);

        if (!nextItem || !nextItem.url) {
            // تحقق من الجدول حسب الوقت
            const currentByTime = this.scheduleManager.getCurrentItem();
            if (currentByTime && currentByTime.index !== this.currentIndex) {
                this.currentItem = currentByTime;
                this.currentIndex = currentByTime.index;
            } else {
                // نهاية الجدول
                Logger.log('Engine', 'نهاية الجدول');
                this.scheduleManager.compileDaySchedule();
                const fresh = this.scheduleManager.getCurrentItem();
                if (fresh) {
                    this.currentItem = fresh;
                    this.currentIndex = fresh.index;
                } else {
                    this._playEmergencyContent();
                    return;
                }
            }
        } else {
            this.currentItem = nextItem;
            this.currentIndex = nextItem.index;
        }

        this.retryCount = 0;

        // محاولة التبديل السلس
        const nextVideo = this._getInactiveVideo();
        const currentVideo = this._getActiveVideo();

        try {
            if (nextVideo.src && nextVideo.readyState >= 2 &&
                nextVideo.src.includes(new URL(this.currentItem.url).pathname)) {
                // الفيديو جاهز - تبديل سلس
                if (this.currentItem.seekPosition > 0) {
                    nextVideo.currentTime = this.currentItem.seekPosition;
                } else {
                    nextVideo.currentTime = 0;
                }
                nextVideo.loop = this.currentItem.loop || false;
                await nextVideo.play();

                this._swapVideos();
                currentVideo.pause();
                currentVideo.removeAttribute('src');
                currentVideo.load();
            } else {
                // تحميل مباشر في نفس العنصر
                await this._loadAndPlay(
                    currentVideo,
                    this.currentItem.url,
                    this.currentItem.seekPosition || 0,
                    this.currentItem.loop
                );
            }

            this._setState(this._stateForType(this.currentItem.type));
            if (this.onItemChange) this.onItemChange(this.currentItem);
            this._preloadNext();

        } catch (error) {
            Logger.error('Engine', 'فشل الانتقال', error.message);
            this._onVideoError();
        }
    }

    async _onVideoError() {
        this.retryCount++;

        if (this.retryCount <= GTOON_CONFIG.MAX_RETRY_ATTEMPTS) {
            Logger.warn('Engine', `إعادة ${this.retryCount}/${GTOON_CONFIG.MAX_RETRY_ATTEMPTS}...`);
            this._setState(GTOON_CONFIG.STATES.RECOVERING);

            await this._delay(GTOON_CONFIG.RETRY_DELAY * 1000);

            try {
                const video = this._getActiveVideo();
                await this._loadAndPlay(video, this.currentItem.url, this.currentItem.seekPosition || 0, this.currentItem.loop);
                this._setState(this._stateForType(this.currentItem.type));
            } catch (e) {
                this._onVideoError();
            }
        } else {
            Logger.error('Engine', 'تخطي العنصر المعطل');
            this.retryCount = 0;
            this._onVideoEnded();
        }
    }

    _playEmergencyContent() {
        Logger.warn('Engine', '🆘 محتوى طوارئ');
        this._setState(GTOON_CONFIG.STATES.PLAYING_EMERGENCY);

        const em = this.scheduleManager.emergencyContent;
        if (em) {
            this.currentItem = {
                type: 'emergency', title: em.title, url: em.url,
                duration: em.duration, loop: true, index: -1, seekPosition: 0
            };

            const video = this._getActiveVideo();
            this._loadAndPlay(video, em.url, 0, true).catch(() => {
                if (this.onError) this.onError('total_failure');
            });

            if (this.onItemChange) this.onItemChange(this.currentItem);
        } else {
            if (this.onError) this.onError('no_content');
        }
    }

    _startWatchdog() {
        this.watchdogTimer = setInterval(() => {
            const video = this._getActiveVideo();
            if (!video || video.paused || video.ended) return;

            if (Math.abs(video.currentTime - this.lastVideoTime) < 0.1) {
                if (this.stalledSince === 0) {
                    this.stalledSince = Date.now();
                } else if (Date.now() - this.stalledSince > GTOON_CONFIG.WATCHDOG_INTERVAL * 1000) {
                    Logger.warn('Engine', '🐛 Watchdog: متوقف!');
                    this.stalledSince = 0;
                    this._onVideoError();
                }
            } else {
                this.stalledSince = 0;
                this.lastVideoTime = video.currentTime;
            }

            this._checkScheduleSync();
        }, GTOON_CONFIG.WATCHDOG_INTERVAL * 1000);
    }

    _checkScheduleSync() {
        const expected = this.scheduleManager.getCurrentItem();
        if (!expected || expected.index < 0) return;

        if (expected.index !== this.currentIndex) {
            const drift = Math.abs(expected.seekPosition - (this._getActiveVideo()?.currentTime || 0));
            if (drift > 30) {
                Logger.warn('Engine', `عدم تزامن (drift: ${drift.toFixed(0)}ث). إعادة مزامنة...`);
                this._resync();
            }
        }
    }

    async _resync() {
        Logger.log('Engine', '🔄 إعادة مزامنة...');
        const video = this._getActiveVideo();
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        await this._startPlayback();
    }

    _setupVisibilityHandler() {
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                Logger.log('Engine', 'الصفحة ظاهرة - تحقق من التزامن');
                setTimeout(() => this._checkScheduleSync(), 1000);
            }
        });
    }

    _startUIUpdates() {
        this.uiUpdateTimer = setInterval(() => {
            if (!this.onTimeUpdate) return;

            const video = this._getActiveVideo();
            const now = this.timeManager.getSecondsSinceMidnight();

            this.onTimeUpdate({
                currentTime: this.timeManager.getMeccaTimeString(),
                videoPosition: video?.currentTime || 0,
                videoDuration: video?.duration || 0,
                itemTitle: this.currentItem?.title || '',
                itemRemaining: this.currentItem ? Math.max(0, this.currentItem.endTime - now) : 0,
                state: this.state,
                buffered: this._getBuffered(video)
            });
        }, GTOON_CONFIG.UI_UPDATE_INTERVAL);
    }

    _startPeriodicSync() {
        this.syncTimer = setInterval(async () => {
            if (this.timeManager.needsResync()) await this.timeManager.syncTime();
        }, 60000);
    }

    // ============================================
    // أدوات
    // ============================================

    _setState(s) {
        if (this.state !== s) {
            const old = this.state;
            this.state = s;
            Logger.log('Engine', `${old} → ${s}`);
            if (this.onStateChange) this.onStateChange(s, old);
        }
    }

    _stateForType(type) {
        const map = {
            episode: GTOON_CONFIG.STATES.PLAYING_EPISODE,
            bumper: GTOON_CONFIG.STATES.PLAYING_BUMPER,
            ad: GTOON_CONFIG.STATES.PLAYING_ADS,
            backup: GTOON_CONFIG.STATES.PLAYING_BACKUP,
            emergency: GTOON_CONFIG.STATES.PLAYING_EMERGENCY
        };
        return map[type] || GTOON_CONFIG.STATES.PLAYING_EPISODE;
    }

    _getActiveVideo() { return this.activeVideo === 'A' ? this.videoA : this.videoB; }
    _getInactiveVideo() { return this.activeVideo === 'A' ? this.videoB : this.videoA; }
    _getActiveLabel() { return this.activeVideo; }

    _swapVideos() {
        this._getActiveVideo().classList.remove('active');
        this._getInactiveVideo().classList.add('active');
        this.activeVideo = this.activeVideo === 'A' ? 'B' : 'A';
        Logger.log('Engine', `تبديل → ${this.activeVideo}`);
    }

    _getBuffered(video) {
        if (video?.buffered?.length > 0 && video.duration > 0) {
            return (video.buffered.end(video.buffered.length - 1) / video.duration) * 100;
        }
        return 0;
    }

    _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    toggleMute() {
        const v = this._getActiveVideo();
        v.muted = !v.muted;
        return v.muted;
    }

    setVolume(level) {
        const v = this._getActiveVideo();
        v.volume = Math.max(0, Math.min(1, level));
        v.muted = false;
        return v.volume;
    }

    getVolume() { return this._getActiveVideo()?.volume || 1; }

    toggleFullscreen() {
        const el = document.getElementById('player-wrapper');
        if (document.fullscreenElement) document.exitFullscreen();
        else el.requestFullscreen();
    }

    async togglePiP() {
        const v = this._getActiveVideo();
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else if (v.requestPictureInPicture) await v.requestPictureInPicture();
    }

    getStatus() {
        return {
            state: this.state, currentItem: this.currentItem,
            currentTime: this.timeManager.getMeccaTimeString(),
            day: this.timeManager.getDayName(),
            clockOffset: this.timeManager.clockOffset,
            online: this.networkMonitor.isOnline(),
            retryCount: this.retryCount,
            scheduleItems: this.scheduleManager.compiledSchedule?.length || 0
        };
    }

    _onNetworkChange(isOnline) {
        if (isOnline) {
            Logger.log('Engine', '🌐 الإنترنت عاد');
            const overlay = document.getElementById('offline-overlay');
            if (overlay) overlay.style.display = 'none';
            this._resync();
        } else {
            if (this.onError) this.onError('offline');
        }
    }

    destroy() {
        clearInterval(this.watchdogTimer);
        clearInterval(this.uiUpdateTimer);
        clearInterval(this.syncTimer);
        if (this.videoA) { this.videoA.pause(); this.videoA.src = ''; }
        if (this.videoB) { this.videoB.pause(); this.videoB.src = ''; }
        Logger.log('Engine', '🛑 تم الإيقاف');
    }
}
