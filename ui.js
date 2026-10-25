class PlayerUI {
    constructor(engine) {
        this.engine = engine;
        this.controlsTimeout = null;
        this._bindEngine();
        this._bindControls();
        this._bindKeyboard();
    }

    _bindEngine() {
        this.engine.onTimeUpdate = (data) => this._updateDisplay(data);
        this.engine.onItemChange = (item) => this._onItemChanged(item);
        this.engine.onStateChange = (state) => this._onStateChanged(state);
        this.engine.onBuffering = (b) => this._onBuffering(b);
        this.engine.onError = (type) => this._onError(type);
        this.engine.onProbeProgress = (done, total) => this._onProbeProgress(done, total);
    }

    _bindControls() {
        const $ = id => document.getElementById(id);

        // كتم الصوت
        $('btn-mute')?.addEventListener('click', () => {
            const muted = this.engine.toggleMute();
            $('btn-mute').textContent = muted ? '🔇' : '🔊';
            this._updateVolume();
        });

        // شريط الصوت
        $('volume-slider')?.addEventListener('input', (e) => {
            this.engine.setVolume(e.target.value / 100);
        });

        // ملء الشاشة
        $('btn-fullscreen')?.addEventListener('click', () => this.engine.toggleFullscreen());

        // PiP
        $('btn-pip')?.addEventListener('click', () => this.engine.togglePiP());

        // EPG
        $('btn-epg')?.addEventListener('click', () => this._toggleEPG());

        // إخفاء/إظهار التحكم
        const wrapper = $('player-wrapper');
        wrapper?.addEventListener('mousemove', () => this._showControls());
        wrapper?.addEventListener('mouseleave', () => this._scheduleHide());
        wrapper?.addEventListener('touchstart', () => this._showControls());

        // النقر لبدء التشغيل
        wrapper?.addEventListener('click', (e) => {
            if (!['BUTTON','INPUT'].includes(e.target.tagName)) {
                const v = this.engine._getActiveVideo();
                if (v?.paused) {
                    v.play();
                    $('autoplay-overlay').style.display = 'none';
                }
            }
        });
    }

    _bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            switch(e.key.toLowerCase()) {
                case 'f': e.preventDefault(); this.engine.toggleFullscreen(); break;
                case 'm': e.preventDefault(); this.engine.toggleMute(); break;
                case 'arrowup': e.preventDefault(); this.engine.setVolume(this.engine.getVolume() + 0.1); this._updateVolume(); break;
                case 'arrowdown': e.preventDefault(); this.engine.setVolume(this.engine.getVolume() - 0.1); this._updateVolume(); break;
                case 'i': e.preventDefault(); this._toggleEPG(); break;
                case 'p': e.preventDefault(); this.engine.togglePiP(); break;
                case 'escape': this._hideEPG(); break;
            }
        });
    }

    _updateDisplay(data) {
        const $ = id => document.getElementById(id);

        const clock = $('current-time');
        if (clock) clock.textContent = data.currentTime;

        const title = $('current-title');
        if (title) title.textContent = data.itemTitle;

        const remaining = $('time-remaining');
        if (remaining) remaining.textContent = TimeManager.formatDuration(data.itemRemaining);

        const progress = $('progress-bar');
        if (progress && data.videoDuration > 0) {
            progress.style.width = `${(data.videoPosition / data.videoDuration) * 100}%`;
        }

        const buffer = $('buffer-bar');
        if (buffer) buffer.style.width = `${data.buffered}%`;

        // تحديث البرنامج التالي
        const next = this.engine.scheduleManager.getNextItem(this.engine.currentIndex);
        const nextTitle = $('next-title');
        const nextTime = $('next-time');
        if (nextTitle) nextTitle.textContent = next?.title || '-';
        if (nextTime) nextTime.textContent = next?.startTime ? TimeManager.secondsToTime(next.startTime).slice(0,5) : '';
    }

    _onItemChanged(item) {
        const typeEl = document.getElementById('content-type');
        if (typeEl) {
            const labels = {
                episode: '📺 برنامج', bumper: '🎬 فاصل', ad: '📢 إعلان',
                backup: '🔄 إعادة', emergency: '⚠️ احتياطي'
            };
            typeEl.textContent = labels[item.type] || '';
            typeEl.className = `content-type type-${item.type}`;
        }

        this._updateEPG();
        this._showNotification(item.title);
    }

    _onStateChanged(state) {
        const el = document.getElementById('engine-state');
        if (el) {
            const labels = {
                [GTOON_CONFIG.STATES.LOADING]: 'جاري التحميل...',
                [GTOON_CONFIG.STATES.PROBING]: '🔍 فحص الفيديوهات...',
                [GTOON_CONFIG.STATES.PLAYING_EPISODE]: '▶ على الهواء',
                [GTOON_CONFIG.STATES.PLAYING_BUMPER]: '🎬 فاصل',
                [GTOON_CONFIG.STATES.PLAYING_ADS]: '📢 إعلاني',
                [GTOON_CONFIG.STATES.PLAYING_BACKUP]: '🔄 إعادة',
                [GTOON_CONFIG.STATES.PLAYING_EMERGENCY]: '⚠️ احتياطي',
                [GTOON_CONFIG.STATES.RECOVERING]: '🔄 استعادة...',
                [GTOON_CONFIG.STATES.ERROR]: '❌ خطأ'
            };
            el.textContent = labels[state] || state;
        }

        const live = document.getElementById('live-indicator');
        if (live) {
            const isLive = [GTOON_CONFIG.STATES.PLAYING_EPISODE, GTOON_CONFIG.STATES.PLAYING_BUMPER, GTOON_CONFIG.STATES.PLAYING_ADS].includes(state);
            live.classList.toggle('live', isLive);
            live.textContent = isLive ? '🔴 LIVE' : '⏳ جاري التحميل...';
        }
    }

    _onBuffering(isBuffering) {
        const spinner = document.getElementById('buffering-spinner');
        if (spinner) spinner.style.display = isBuffering ? 'flex' : 'none';
    }

    _onError(type) {
        const $ = id => { const el = document.getElementById(id); if (el) el.style.display = 'flex'; };
        switch(type) {
            case 'autoplay_blocked': $('autoplay-overlay'); break;
            case 'offline': $('offline-overlay'); break;
            case 'total_failure': case 'no_content': case 'schedule_load_failed': $('error-overlay'); break;
        }
    }

    _onProbeProgress(done, total) {
        const el = document.getElementById('probe-progress');
        if (el) {
            el.textContent = `فحص الفيديوهات: ${done}/${total}`;
            el.style.display = 'block';
            if (done >= total) {
                setTimeout(() => { el.style.display = 'none'; }, 2000);
            }
        }
    }

    _updateEPG() {
        const list = document.getElementById('epg-list');
        if (!list) return;

        const programs = this.engine.scheduleManager.getEPG(10);
        list.innerHTML = programs.map(p => `
            <li class="epg-item ${p.isNow ? 'epg-now' : ''}">
                <span class="epg-time">${p.time.slice(0,5)}</span>
                <span class="epg-title">${p.title}</span>
                <span class="epg-duration">${p.duration}</span>
                ${p.isNow ? '<span class="epg-live">الآن</span>' : ''}
            </li>
        `).join('');
    }

    _toggleEPG() {
        const panel = document.getElementById('epg-panel');
        if (panel) {
            panel.classList.toggle('visible');
            if (panel.classList.contains('visible')) this._updateEPG();
        }
    }

    _hideEPG() {
        document.getElementById('epg-panel')?.classList.remove('visible');
    }

    _showNotification(text, dur = 3000) {
        const el = document.getElementById('notification');
        if (!el) return;
        el.textContent = text;
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), dur);
    }

    _showControls() {
        clearTimeout(this.controlsTimeout);
        document.getElementById('player-controls')?.classList.add('visible');
        document.getElementById('player-info')?.classList.add('visible');
        this._scheduleHide();
    }

    _scheduleHide() {
        clearTimeout(this.controlsTimeout);
        this.controlsTimeout = setTimeout(() => {
            document.getElementById('player-controls')?.classList.remove('visible');
            document.getElementById('player-info')?.classList.remove('visible');
        }, GTOON_CONFIG.CONTROLS_HIDE_DELAY * 1000);
    }

    _updateVolume() {
        const slider = document.getElementById('volume-slider');
        if (slider) slider.value = this.engine.getVolume() * 100;
    }
}
