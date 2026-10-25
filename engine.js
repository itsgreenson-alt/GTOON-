class BroadcastEngine {
    constructor() {
        // المكونات الأساسية
        this.timeManager = new TimeManager();
        this.scheduleManager = new ScheduleManager(this.timeManager);
        this.networkMonitor = new NetworkMonitor(this._onNetworkChange.bind(this));

        // حالة المحرك
        this.state = GTOON_CONFIG.STATES.IDLE;
        this.currentItem = null;
        this.currentIndex = -1;

        // عناصر الفيديو (نظام Dual Video للتبديل السلس)
        this.videoA = null;
        this.videoB = null;
        this.activeVideo = 'A';

        // مؤقتات
        this.watchdogTimer = null;
        this.uiUpdateTimer = null;
        this.syncTimer = null;
        this.transitionTimer = null;

        // عدادات
        this.retryCount = 0;
        this.lastVideoTime = 0;
        this.stalledSince = 0;

        // Callbacks
        this.onStateChange = null;
        this.onItemChange = null;
        this.onTimeUpdate = null;
        this.onError = null;
        this.onBuffering = null;
    }

    /**
     * تهيئة المحرك
     */
    async initialize() {
        Logger.log('Engine', '🚀 بدء تهيئة محرك البث...');
        this._setState(GTOON_CONFIG.STATES.LOADING);

        // 1. إنشاء عناصر الفيديو
        this._createVideoElements();

        // 2. مزامنة الوقت
        await this.timeManager.syncTime();

        // 3. تحميل الجدول
        const scheduleLoaded = await this.scheduleManager.loadSchedule();
        if (!scheduleLoaded) {
            Logger.error('Engine', 'فشل تحميل الجدول');
            this._setState(GTOON_CONFIG.STATES.ERROR);
            return false;
        }

        // 4. تجميع جدول اليوم
        this.scheduleManager.compileDaySchedule();

        // 5. بدء البث
        await this._startPlayback();

        // 6. بدء المراقبة
        this._startWatchdog();
        this._startUIUpdates();
        this._startPeriodicSync();
        this._setupVisibilityHandler();

        Logger.log('Engine', '✅ تم تهيئة المحرك بنجاح');
        return true;
    }

    /**
     * إنشاء عناصر الفيديو المزدوجة
     */
    _createVideoElements() {
        const container = document.getElementById('video-container');

        // فيديو A (الرئيسي)
        this.videoA = document.createElement('video');
        this.videoA.id = 'video-a';
        this.videoA.className = 'broadcast-video active';
        this.videoA.playsInline = true;
        this.videoA.preload = 'auto';
        container.appendChild(this.videoA);

        // فيديو B (للتبديل السلس)
        this.videoB = document.createElement('video');
        this.videoB.id = 'video-b';
        this.videoB.className = 'broadcast-video';
        this.videoB.playsInline = true;
        this.videoB.preload = 'auto';
        container.appendChild(this.videoB);

        // ربط الأحداث لكلا الفيديوهين
        this._bindVideoEvents(this.videoA, 'A');
        this._bindVideoEvents(this.videoB, 'B');
    }

    /**
     * ربط أحداث الفيديو
     */
    _bindVideoEvents(video, label) {
        video.addEventListener('ended', () => {
            if (this._getActiveLabel() === label) {
                Logger.log('Engine', `انتهى الفيديو ${label}`);
                this._onVideoEnded();
            }
        });

        video.addEventListener('error', (e) => {
            if (this._getActiveLabel() === label) {
                Logger.error('Engine', `خطأ في الفيديو ${label}`, {
                    code: video.error?.code,
                    message: video.error?.message
                });
                this._onVideoError();
            }
        });

        video.addEventListener('waiting', () => {
            if (this._getActiveLabel() === label) {
                if (this.onBuffering) this.onBuffering(true);
            }
        });

        video.addEventListener('playing', () => {
            if (this._getActiveLabel() === label) {
                if (this.onBuffering) this.onBuffering(false);
            }
        });

        video.addEventListener('canplay', () => {
            Logger.log('Engine', `الفيديو ${label} جاهز للتشغيل`);
        });

        video.addEventListener('loadedmetadata', () => {
            Logger.log('Engine', `بيانات الفيديو ${label} محمّلة. المدة: ${video.duration}ث`);

            // التحقق من تطابق المدة مع الجدول
            if (this.currentItem && this._getActiveLabel() === label) {
                const expectedDuration = this.currentItem.duration;
                const actualDuration = video.duration;
                const diff = Math.abs(expectedDuration - actualDuration);

                if (diff > 5) {
                    Logger.warn('Engine',
                        `فرق في المدة! المتوقع: ${expectedDuration}ث، الفعلي: ${actualDuration.toFixed(1)}ث، الفرق: ${diff.toFixed(1)}ث`);

                    // تحديث المدة في الجدول
                    if (this.currentItem.index >= 0 && this.scheduleManager.compiledSchedule) {
                        const item = this.scheduleManager.compiledSchedule[this.currentItem.index];
                        if (item) {
                            item.duration = Math.floor(actualDuration);
                            item.endTime = item.startTime + item.duration;
                            Logger.log('Engine', 'تم تحديث المدة في الجدول تلقائياً');
                        }
                    }
                }
            }
        });
    }

    /**
     * بدء التشغيل
     */
    async _startPlayback() {
        const item = this.scheduleManager.getCurrentItem();

        if (!item) {
            Logger.error('Engine', 'لا يوجد محتوى للتشغيل');
            this._playEmergencyContent();
            return;
        }

        Logger.log('Engine', `▶️ تشغيل: ${item.title}`, {
            seekTo: `${item.seekPosition}ث`,
            remaining: TimeManager.formatDuration(item.remaining)
        });

        this.currentItem = item;
        this.currentIndex = item.index;
        this.retryCount = 0;

        const video = this._getActiveVideo();
        await this._loadAndPlay(video, item.url, item.seekPosition, item.loop);

        this._setState(this._stateForItemType(item.type));

        if (this.onItemChange) this.onItemChange(item);

        // بدء التحميل المسبق للعنصر التالي
        this._preloadNext();
    }

    /**
     * تحميل وتشغيل فيديو
     */
    async _loadAndPlay(video, url, seekTo = 0, loop = false) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                Logger.warn('Engine', 'مهلة تحميل الفيديو انتهت');
                reject(new Error('Timeout'));
            }, GTOON_CONFIG.VIDEO_LOAD_TIMEOUT * 1000);

            const onCanPlay = () => {
                clearTimeout(timeout);
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);

                if (seekTo > 0) {
                    video.currentTime = seekTo;
                }
                video.loop = loop || false;

                video.play()
                    .then(() => {
                        Logger.log('Engine', 'بدأ التشغيل');
                        resolve();
                    })
                    .catch(err => {
                        Logger.warn('Engine', 'فشل التشغيل التلقائي (يحتاج تفاعل المستخدم)', err.message);
                        // عرض زر التشغيل
                        if (this.onError) this.onError('autoplay_blocked');
                        resolve(); // لا نريد إعادة المحاولة
                    });
            };

            const onError = () => {
                clearTimeout(timeout);
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);
                reject(new Error('Video load error'));
            };

            video.addEventListener('canplay', onCanPlay, { once: true });
            video.addEventListener('error', onError, { once: true });

            video.src = url;
            video.load();
        });
    }

    /**
     * التحميل المسبق للعنصر التالي
     */
    _preloadNext() {
        const nextItem = this.scheduleManager.getNextItem(this.currentIndex);
        if (!nextItem || !nextItem.url) return;

        const inactiveVideo = this._getInactiveVideo();

        Logger.log('Engine', `⏳ تحميل مسبق: ${nextItem.title}`);

        const preloadTimeout = setTimeout(() => {
            Logger.warn('Engine', 'مهلة التحميل المسبق انتهت');
            inactiveVideo.src = '';
        }, GTOON_CONFIG.PRELOAD_TIMEOUT * 1000);

        inactiveVideo.src = nextItem.url;
        inactiveVideo.preload = 'auto';
        inactiveVideo.load();

        inactiveVideo.addEventListener('canplay', () => {
            clearTimeout(preloadTimeout);
            Logger.log('Engine', '✅ التحميل المسبق مكتمل');
        }, { once: true });

        inactiveVideo.addEventListener('error', () => {
            clearTimeout(preloadTimeout);
            Logger.warn('Engine', '⚠️ فشل التحميل المسبق');
        }, { once: true });
    }

    /**
     * عند انتهاء الفيديو الحالي
     */
    async _onVideoEnded() {
        Logger.log('Engine', '⏭️ انتهى المحتوى الحالي، الانتقال للتالي...');

        // تحقق: هل يجب الانتقال حسب الجدول أم حسب نهاية الفيديو؟
        const nextScheduleItem = this.scheduleManager.getCurrentItem();

        if (nextScheduleItem && nextScheduleItem.index !== this.currentIndex) {
            // الجدول يقول ننتقل لعنصر مختلف
            this.currentItem = nextScheduleItem;
            this.currentIndex = nextScheduleItem.index;
        } else {
            // الانتقال للعنصر التالي في القائمة
            const nextItem = this.scheduleManager.getNextItem(this.currentIndex);
            if (nextItem && nextItem.url) {
                this.currentItem = nextItem;
                this.currentIndex = nextItem.index;
            } else {
                // نهاية الجدول - إعادة التجميع
                Logger.log('Engine', 'نهاية الجدول، إعادة تجميع...');
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
        }

        this.retryCount = 0;

        // التبديل بين الفيديوهين (Dual Video Swap)
        const nextVideo = this._getInactiveVideo();
        const currentVideo = this._getActiveVideo();

        try {
            if (nextVideo.src && nextVideo.readyState >= 2) {
                // الفيديو التالي جاهز - تبديل سلس
                if (this.currentItem.seekPosition > 0) {
                    nextVideo.currentTime = this.currentItem.seekPosition;
                }
                nextVideo.loop = this.currentItem.loop || false;
                await nextVideo.play();

                // تبديل العرض
                this._swapVideos();

                // إيقاف القديم
                currentVideo.pause();
                currentVideo.src = '';
            } else {
                // الفيديو التالي غير جاهز - تحميل مباشر
                await this._loadAndPlay(
                    currentVideo,
                    this.currentItem.url,
                    this.currentItem.seekPosition || 0,
                    this.currentItem.loop
                );
            }

            this._setState(this._stateForItemType(this.currentItem.type));
            if (this.onItemChange) this.onItemChange(this.currentItem);

            // تحميل مسبق للعنصر بعد التالي
            this._preloadNext();

        } catch (error) {
            Logger.error('Engine', 'فشل الانتقال للعنصر التالي', error.message);
            this._onVideoError();
        }
    }

    /**
     * عند حدوث خطأ في الفيديو
     */
    async _onVideoError() {
        this.retryCount++;

        if (this.retryCount <= GTOON_CONFIG.MAX_RETRY_ATTEMPTS) {
            Logger.warn('Engine', `إعادة المحاولة ${this.retryCount}/${GTOON_CONFIG.MAX_RETRY_ATTEMPTS}...`);
            this._setState(GTOON_CONFIG.STATES.RECOVERING);

            await this._delay(GTOON_CONFIG.RETRY_DELAY * 1000);

            const video = this._getActiveVideo();
            try {
                await this._loadAndPlay(
                    video,
                    this.currentItem.url,
                    this.currentItem.seekPosition || 0,
                    this.currentItem.loop
                );
                this._setState(this._stateForItemType(this.currentItem.type));
            } catch (error) {
                this._onVideoError();
            }
        } else {
            Logger.error('Engine', 'استنفدت جميع محاولات إعادة التحميل. تخطي العنصر.');
            this.retryCount = 0;

            // تخطي للعنصر التالي
            this._onVideoEnded();
        }
    }

    /**
     * تشغيل المحتوى الطارئ
     */
    _playEmergencyContent() {
        Logger.warn('Engine', '🆘 تشغيل المحتوى الطارئ');
        this._setState(GTOON_CONFIG.STATES.PLAYING_EMERGENCY);

        const emergency = this.scheduleManager.emergencyContent;
        if (emergency) {
            this.currentItem = {
                type: 'emergency',
                title: emergency.title,
                url: emergency.url,
                duration: emergency.duration,
                loop: true,
                index: -1,
                seekPosition: 0
            };

            const video = this._getActiveVideo();
            this._loadAndPlay(video, emergency.url, 0, true).catch(() => {
                Logger.error('Engine', 'فشل حتى المحتوى الطارئ!');
                if (this.onError) this.onError('total_failure');
            });

            if (this.onItemChange) this.onItemChange(this.currentItem);
        } else {
            if (this.onError) this.onError('no_content');
        }
    }

    /**
     * Watchdog - مراقبة صحة البث
     */
    _startWatchdog() {
        this.watchdogTimer = setInterval(() => {
            const video = this._getActiveVideo();

            if (!video || video.paused || video.ended) return;

            // التحقق من تقدم الفيديو
            if (video.currentTime === this.lastVideoTime) {
                if (this.stalledSince === 0) {
                    this.stalledSince = Date.now();
                } else if (Date.now() - this.stalledSince > GTOON_CONFIG.WATCHDOG_INTERVAL * 1000) {
                    Logger.warn('Engine', '🐛 Watchdog: الفيديو متوقف عن التقدم!');
                    this.stalledSince = 0;
                    this._onVideoError();
                }
            } else {
                this.stalledSince = 0;
                this.lastVideoTime = video.currentTime;
            }

            // التحقق من تزامن الوقت مع الجدول
            this._checkScheduleSync();

        }, GTOON_CONFIG.WATCHDOG_INTERVAL * 1000);
    }

    /**
     * التحقق من التزامن مع الجدول
     */
    _checkScheduleSync() {
        const expectedItem = this.scheduleManager.getCurrentItem();
        if (!expectedItem) return;

        // إذا تغير العنصر المتوقع (مثلاً المستخدم ترك التبويب وعاد)
        if (expectedItem.index !== this.currentIndex && expectedItem.index >= 0) {
            Logger.warn('Engine', 'عدم تزامن مع الجدول! إعادة المزامنة...');
            this._resync();
        }
    }

    /**
     * إعادة المزامنة مع الجدول
     */
    async _resync() {
        Logger.log('Engine', '🔄 إعادة مزامنة البث...');

        // إيقاف الفيديو الحالي
        const video = this._getActiveVideo();
        video.pause();

        // بدء التشغيل من الموضع الصحيح
        await this._startPlayback();
    }

    /**
     * معالجة إخفاء/إظهار الصفحة
     */
    _setupVisibilityHandler() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                Logger.log('Engine', 'الصفحة مخفية');
            } else {
                Logger.log('Engine', 'الصفحة ظاهرة - التحقق من التزامن');
                this._checkScheduleSync();
            }
        });
    }

    /**
     * تحديثات الواجهة الدورية
     */
    _startUIUpdates() {
        this.uiUpdateTimer = setInterval(() => {
            if (this.onTimeUpdate) {
                const video = this._getActiveVideo();
                const now = this.timeManager.getSecondsSinceMidnight();

                this.onTimeUpdate({
                    currentTime: this.timeManager.getMeccaTimeString(),
                    videoPosition: video ? video.currentTime : 0,
                    videoDuration: video ? video.duration : 0,
                    itemTitle: this.currentItem ? this.currentItem.title : '',
                    itemRemaining: this.currentItem ?
                        Math.max(0, this.currentItem.endTime - now) : 0,
                    state: this.state,
                    buffered: video ? this._getBufferedPercentage(video) : 0
                });
            }
        }, GTOON_CONFIG.UI_UPDATE_INTERVAL);
    }

    /**
     * مزامنة دورية للوقت
     */
    _startPeriodicSync() {
        this.syncTimer = setInterval(async () => {
            if (this.timeManager.needsResync()) {
                await this.timeManager.syncTime();
            }
        }, 60000); // كل دقيقة تحقق
    }

    /**
     * تغيير حالة المحرك
     */
    _setState(newState) {
        if (this.state !== newState) {
            const oldState = this.state;
            this.state = newState;
            Logger.log('Engine', `حالة: ${oldState} → ${newState}`);
            if (this.onStateChange) this.onStateChange(newState, oldState);
        }
    }

    /**
     * تحديد الحالة حسب نوع العنصر
     */
    _stateForItemType(type) {
        const map = {
            'episode': GTOON_CONFIG.STATES.PLAYING_EPISODE,
            'bumper': GTOON_CONFIG.STATES.PLAYING_BUMPER,
            'ad': GTOON_CONFIG.STATES.PLAYING_ADS,
            'backup': GTOON_CONFIG.STATES.PLAYING_BACKUP,
            'emergency': GTOON_CONFIG.STATES.PLAYING_EMERGENCY
        };
        return map[type] || GTOON_CONFIG.STATES.PLAYING_EPISODE;
    }

    // ============================================
    // أدوات الفيديو المزدوج
    // ============================================

    _getActiveVideo() {
        return this.activeVideo === 'A' ? this.videoA : this.videoB;
    }

    _getInactiveVideo() {
        return this.activeVideo === 'A' ? this.videoB : this.videoA;
    }

    _getActiveLabel() {
        return this.activeVideo;
    }

    _swapVideos() {
        const oldActive = this._getActiveVideo();
        const newActive = this._getInactiveVideo();

        oldActive.classList.remove('active');
        newActive.classList.add('active');

        this.activeVideo = this.activeVideo === 'A' ? 'B' : 'A';
        Logger.log('Engine', `تبديل الفيديو → ${this.activeVideo}`);
    }

    _getBufferedPercentage(video) {
        if (video.buffered.length > 0 && video.duration > 0) {
            return (video.buffered.end(video.buffered.length - 1) / video.duration) * 100;
        }
        return 0;
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ============================================
    // واجهة التحكم العامة
    // ============================================

    /**
     * كتم/إلغاء كتم الصوت
     */
    toggleMute() {
        const video = this._getActiveVideo();
        video.muted = !video.muted;
        return video.muted;
    }

    /**
     * تعيين مستوى الصوت (0-1)
     */
    setVolume(level) {
        const video = this._getActiveVideo();
        video.volume = Math.max(0, Math.min(1, level));
        video.muted = false;
        return video.volume;
    }

    /**
     * الحصول على مستوى الصوت
     */
    getVolume() {
        return this._getActiveVideo()?.volume || 1;
    }

    /**
     * ملء الشاشة
     */
    toggleFullscreen() {
        const container = document.getElementById('player-wrapper');
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            container.requestFullscreen();
        }
    }

    /**
     * Picture in Picture
     */
    async togglePiP() {
        const video = this._getActiveVideo();
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        } else if (video.requestPictureInPicture) {
            await video.requestPictureInPicture();
        }
    }

    /**
     * الحصول على حالة المحرك
     */
    getStatus() {
        return {
            state: this.state,
            currentItem: this.currentItem,
            currentTime: this.timeManager.getMeccaTimeString(),
            dayName: this.timeManager.getDayName(),
            clockOffset: this.timeManager.clockOffset,
            online: this.networkMonitor.isOnline(),
            retryCount: this.retryCount
        };
    }

    /**
     * معالجة تغير حالة الشبكة
     */
    _onNetworkChange(isOnline) {
        if (isOnline) {
            Logger.log('Engine', '🌐 الإنترنت عاد - إعادة المزامنة');
            this._resync();
        } else {
            Logger.warn('Engine', '📡 انقطع الإنترنت');
            if (this.onError) this.onError('offline');
        }
    }

    /**
     * إيقاف المحرك
     */
    destroy() {
        clearInterval(this.watchdogTimer);
        clearInterval(this.uiUpdateTimer);
        clearInterval(this.syncTimer);
        clearTimeout(this.transitionTimer);

        if (this.videoA) { this.videoA.pause(); this.videoA.src = ''; }
        if (this.videoB) { this.videoB.pause(); this.videoB.src = ''; }

        Logger.log('Engine', '🛑 تم إيقاف المحرك');
    }
}
