class PlayerUI {
    constructor(engine) {
        this.engine = engine;
        this.controlsVisible = true;
        this.controlsTimeout = null;

        this._bindEngineCallbacks();
        this._bindUserControls();
        this._bindKeyboard();
    }

    /**
     * ربط callbacks المحرك بالواجهة
     */
    _bindEngineCallbacks() {
        // تحديث الوقت والمعلومات
        this.engine.onTimeUpdate = (data) => this._updateDisplay(data);

        // تغير العنصر الحالي
        this.engine.onItemChange = (item) => this._onItemChanged(item);

        // تغير الحالة
        this.engine.onStateChange = (newState) => this._onStateChanged(newState);

        // التخزين المؤقت
        this.engine.onBuffering = (isBuffering) => this._onBuffering(isBuffering);

        // الأخطاء
        this.engine.onError = (errorType) => this._onError(errorType);
    }

    /**
     * ربط عناصر التحكم
     */
    _bindUserControls() {
        // زر التشغيل/الإيقاف (للحالات الطارئة فقط)
        const playBtn = document.getElementById('btn-play');
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                const video = this.engine._getActiveVideo();
                if (video.paused) {
                    video.play();
                } else {
                    // لا نسمح بالإيقاف في البث الخطي
                }
            });
        }

        // زر كتم الصوت
        const muteBtn = document.getElementById('btn-mute');
        if (muteBtn) {
            muteBtn.addEventListener('click', () => {
                const muted = this.engine.toggleMute();
                muteBtn.innerHTML = muted ?
                    '<i class="icon-muted"></i>' :
                    '<i class="icon-volume"></i>';
                this._updateVolumeSlider();
            });
        }

        // شريط الصوت
        const volumeSlider = document.getElementById('volume-slider');
        if (volumeSlider) {
            volumeSlider.addEventListener('input', (e) => {
                this.engine.setVolume(e.target.value / 100);
            });
        }

        // زر ملء الشاشة
        const fsBtn = document.getElementById('btn-fullscreen');
        if (fsBtn) {
            fsBtn.addEventListener('click', () => {
                this.engine.toggleFullscreen();
            });
        }

        // زر PiP
        const pipBtn = document.getElementById('btn-pip');
        if (pipBtn) {
            pipBtn.addEventListener('click', () => {
                this.engine.togglePiP();
            });
        }

        // إخفاء/إظهار التحكم عند تحريك الماوس
        const playerWrapper = document.getElementById('player-wrapper');
        if (playerWrapper) {
            playerWrapper.addEventListener('mousemove', () => this._showControls());
            playerWrapper.addEventListener('mouseleave', () => this._scheduleHideControls());
            playerWrapper.addEventListener('click', (e) => {
                // النقر على المشغل يبدأ التشغيل (لحل مشكلة Autoplay)
                if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') {
                    const video = this.engine._getActiveVideo();
                    if (video && video.paused) {
                        video.play();
                        this._hideOverlay('autoplay-overlay');
                    }
                }
            });
        }
    }

    /**
     * اختصارات لوحة المفاتيح
     */
    _bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            switch (e.key) {
                case 'f':
                case 'F':
                    e.preventDefault();
                    this.engine.toggleFullscreen();
                    break;
                case 'm':
                case 'M':
                    e.preventDefault();
                    this.engine.toggleMute();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this.engine.setVolume(this.engine.getVolume() + 0.1);
                    this._updateVolumeSlider();
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    this.engine.setVolume(this.engine.getVolume() - 0.1);
                    this._updateVolumeSlider();
                    break;
                case 'i':
                case 'I':
                    e.preventDefault();
                    this._toggleEPG();
                    break;
                case 'p':
                case 'P':
                    e.preventDefault();
                    this.engine.togglePiP();
                    break;
                case 'Escape':
                    this._hideEPG();
                    break;
            }
        });
    }

    /**
     * تحديث العرض (يتم استدعاؤها كل ثانية)
     */
    _updateDisplay(data) {
        // الوقت الحالي
        const clockEl = document.getElementById('current-time');
        if (clockEl) clockEl.textContent = data.currentTime;

        // اسم البرنامج الحالي
        const titleEl = document.getElementById('current-title');
        if (titleEl) titleEl.textContent = data.itemTitle;

        // الوقت المتبقي
        const remainingEl = document.getElementById('time-remaining');
        if (remainingEl) {
            remainingEl.textContent = TimeManager.formatDuration(data.itemRemaining);
        }

        // شريط التقدم
        const progressBar = document.getElementById('progress-bar');
        if (progressBar && data.videoDuration > 0) {
            const percent = (data.videoPosition / data.videoDuration) * 100;
            progressBar.style.width = `${percent}%`;
        }

        // شريط التخزين المؤقت
        const bufferBar = document.getElementById('buffer-bar');
        if (bufferBar) {
            bufferBar.style.width = `${data.buffered}%`;
        }

        // البرنامج التالي
        this._updateNextProgram();
    }

    /**
     * تحديث معلومات البرنامج التالي
     */
    _updateNextProgram() {
        const nextItem = this.engine.scheduleManager.getNextItem(this.engine.currentIndex);
        const nextTitleEl = document.getElementById('next-title');
        const nextTimeEl = document.getElementById('next-time');

        if (nextItem && nextTitleEl) {
            nextTitleEl.textContent = nextItem.title || 'نهاية البث';
            if (nextTimeEl) {
                nextTimeEl.textContent = nextItem.startTime ?
                    TimeManager.secondsToTime(nextItem.startTime) : '';
            }
        }
    }

    /**
     * عند تغير العنصر الحالي
     */
    _onItemChanged(item) {
        // تحديث نوع المحتوى المعروض
        const typeEl = document.getElementById('content-type');
        if (typeEl) {
            const typeLabels = {
                'episode': '📺 برنامج',
                'bumper': '🎬 فاصل',
                'ad': '📢 إعلان',
                'backup': '🔄 إعادة عرض',
                'emergency': '⚠️ بث احتياطي'
            };
            typeEl.textContent = typeLabels[item.type] || '';
            typeEl.className = `content-type type-${item.type}`;
        }

        // تحديث EPG
        this._updateEPG();

        // إشعار بالبرنامج الحالي (صغير)
        this._showNotification(item.title, 3000);
    }

    /**
     * عند تغير حالة المحرك
     */
    _onStateChanged(state) {
        const stateEl = document.getElementById('engine-state');
        if (stateEl) {
            const stateLabels = {
                [GTOON_CONFIG.STATES.LOADING]: 'جاري التحميل...',
                [GTOON_CONFIG.STATES.PLAYING_EPISODE]: '▶ على الهواء',
                [GTOON_CONFIG.STATES.PLAYING_BUMPER]: '🎬 فاصل',
                [GTOON_CONFIG.STATES.PLAYING_ADS]: '📢 فاصل إعلاني',
                [GTOON_CONFIG.STATES.PLAYING_BACKUP]: '🔄 إعادة عرض',
                [GTOON_CONFIG.STATES.PLAYING_EMERGENCY]: '⚠️ بث احتياطي',
                [GTOON_CONFIG.STATES.RECOVERING]: '🔄 جاري الاستعادة...',
                [GTOON_CONFIG.STATES.ERROR]: '❌ خطأ'
            };
            stateEl.textContent = stateLabels[state] || state;
        }

        // مؤشر البث المباشر
        const liveIndicator = document.getElementById('live-indicator');
        if (liveIndicator) {
            if (state === GTOON_CONFIG.STATES.PLAYING_EPISODE ||
                state === GTOON_CONFIG.STATES.PLAYING_BUMPER ||
                state === GTOON_CONFIG.STATES.PLAYING_ADS) {
                liveIndicator.classList.add('live');
                liveIndicator.textContent = '🔴 LIVE';
            } else {
                liveIndicator.classList.remove('live');
            }
        }
    }

    /**
     * عند التخزين المؤقت
     */
    _onBuffering(isBuffering) {
        const spinner = document.getElementById('buffering-spinner');
        if (spinner) {
            spinner.style.display = isBuffering ? 'flex' : 'none';
        }
    }

    /**
     * عند حدوث خطأ
     */
    _onError(errorType) {
        switch (errorType) {
            case 'autoplay_blocked':
                this._showOverlay('autoplay-overlay');
                break;
            case 'offline':
                this._showOverlay('offline-overlay');
                break;
            case 'total_failure':
                this._showOverlay('error-overlay');
                break;
            case 'no_content':
                this._showOverlay('error-overlay');
                break;
        }
    }

    /**
     * تحديث دليل البرامج (EPG)
     */
    _updateEPG() {
        const epgList = document.getElementById('epg-list');
        if (!epgList) return;

        const programs = this.engine.scheduleManager.getEPG(8);
        epgList.innerHTML = '';

        programs.forEach(program => {
            const li = document.createElement('li');
            li.className = `epg-item ${program.isNow ? 'epg-now' : ''}`;
            li.innerHTML = `
                <span class="epg-time">${program.time.slice(0, 5)}</span>
                <span class="epg-title">${program.title}</span>
                <span class="epg-duration">${program.duration}</span>
                ${program.isNow ? '<span class="epg-live">الآن</span>' : ''}
            `;
            epgList.appendChild(li);
        });
    }

    /**
     * إظهار/إخفاء EPG
     */
    _toggleEPG() {
        const epg = document.getElementById('epg-panel');
        if (epg) {
            epg.classList.toggle('visible');
            if (epg.classList.contains('visible')) {
                this._updateEPG();
            }
        }
    }

    _hideEPG() {
        const epg = document.getElementById('epg-panel');
        if (epg) epg.classList.remove('visible');
    }

    /**
     * إظهار إشعار مؤقت
     */
    _showNotification(text, duration = 3000) {
        const notif = document.getElementById('notification');
        if (!notif) return;

        notif.textContent = text;
        notif.classList.add('show');

        setTimeout(() => {
            notif.classList.remove('show');
        }, duration);
    }

    /**
     * إظهار/إخفاء عناصر التحكم
     */
    _showControls() {
        clearTimeout(this.controlsTimeout);
        const controls = document.getElementById('player-controls');
        const info = document.getElementById('player-info');
        if (controls) controls.classList.add('visible');
        if (info) info.classList.add('visible');
        this._scheduleHideControls();
    }

    _scheduleHideControls() {
        clearTimeout(this.controlsTimeout);
        this.controlsTimeout = setTimeout(() => {
            const controls = document.getElementById('player-controls');
            const info = document.getElementById('player-info');
            if (controls) controls.classList.remove('visible');
            if (info) info.classList.remove('visible');
        }, GTOON_CONFIG.CONTROLS_HIDE_DELAY * 1000);
    }

    _showOverlay(id) {
        const overlay = document.getElementById(id);
        if (overlay) overlay.style.display = 'flex';
    }

    _hideOverlay(id) {
        const overlay = document.getElementById(id);
        if (overlay) overlay.style.display = 'none';
    }

    _updateVolumeSlider() {
        const slider = document.getElementById('volume-slider');
        if (slider) {
            slider.value = this.engine.getVolume() * 100;
        }
    }
}
