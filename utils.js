// ============================================
// إدارة الوقت
// ============================================
class TimeManager {
    constructor() {
        this.clockOffset = 0;
        this.lastSync = 0;
        this.syncInterval = 300000;
    }

    async syncTime() {
        for (const server of GTOON_CONFIG.TIME_SERVERS) {
            try {
                const beforeRequest = Date.now();
                const response = await fetch(server, { signal: AbortSignal.timeout(5000) });
                const afterRequest = Date.now();
                const data = await response.json();

                let serverTime;
                if (data.unixtime) {
                    serverTime = data.unixtime * 1000;
                } else if (data.dateTime) {
                    serverTime = new Date(data.dateTime).getTime();
                } else continue;

                const networkDelay = (afterRequest - beforeRequest) / 2;
                this.clockOffset = serverTime - afterRequest + networkDelay;
                this.lastSync = Date.now();
                Logger.log('Time', `مزامنة ناجحة. الانحراف: ${this.clockOffset}ms`);
                return true;
            } catch (e) {
                Logger.warn('Time', `فشل ${server}: ${e.message}`);
            }
        }
        Logger.warn('Time', 'فشلت المزامنة. استخدام ساعة الجهاز.');
        return false;
    }

    now() { return Date.now() + this.clockOffset; }

    getMeccaDate() {
        const utcMs = this.now();
        const utcDate = new Date(utcMs);
        // حساب توقيت مكة UTC+3
        const meccaOffset = GTOON_CONFIG.UTC_OFFSET * 60;
        const localOffset = utcDate.getTimezoneOffset();
        return new Date(utcMs + (meccaOffset + localOffset) * 60000);
    }

    getMeccaTimeString() {
        const d = this.getMeccaDate();
        return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    }

    getSecondsSinceMidnight() {
        const d = this.getMeccaDate();
        return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    }

    getDayName() {
        const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
        return days[this.getMeccaDate().getDay()];
    }

    static timeToSeconds(timeStr) {
        const p = timeStr.split(':');
        return parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + (p[2] ? parseInt(p[2]) : 0);
    }

    static secondsToTime(s) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    }

    static formatDuration(seconds) {
        if (seconds < 0) seconds = 0;
        if (seconds < 60) return `${Math.floor(seconds)} ثانية`;
        if (seconds < 3600) {
            const m = Math.floor(seconds / 60);
            const s = Math.floor(seconds % 60);
            return s > 0 ? `${m}:${String(s).padStart(2,'0')}` : `${m} دقيقة`;
        }
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return m > 0 ? `${h} ساعة ${m} دقيقة` : `${h} ساعة`;
    }

    needsResync() { return Date.now() - this.lastSync > this.syncInterval; }
}

// ============================================
// نظام اكتشاف مدد الفيديوهات التلقائي
// ============================================
class DurationProber {
    constructor() {
        this.cache = {};
        this.probeElement = null;
    }

    /**
     * اكتشاف مدة فيديو واحد
     */
    probeSingle(url) {
        if (this.cache[url]) return Promise.resolve(this.cache[url]);

        return new Promise((resolve) => {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;
            video.style.display = 'none';

            const timeout = setTimeout(() => {
                video.src = '';
                video.remove();
                Logger.warn('Prober', `مهلة اكتشاف المدة انتهت: ${url}`);
                resolve(1200); // افتراضي 20 دقيقة
            }, GTOON_CONFIG.DURATION_PROBE_TIMEOUT * 1000);

            video.addEventListener('loadedmetadata', () => {
                clearTimeout(timeout);
                const duration = Math.floor(video.duration);
                this.cache[url] = duration;
                video.src = '';
                video.remove();
                Logger.log('Prober', `✅ ${url.split('/').pop()}: ${duration}ث (${TimeManager.formatDuration(duration)})`);
                resolve(duration);
            }, { once: true });

            video.addEventListener('error', () => {
                clearTimeout(timeout);
                video.src = '';
                video.remove();
                Logger.error('Prober', `❌ فشل تحميل: ${url}`);
                resolve(0); // فيديو معطل
            }, { once: true });

            document.body.appendChild(video);
            video.src = url;
        });
    }

    /**
     * اكتشاف مدد مجموعة فيديوهات (بالتوازي مع حد أقصى)
     */
    async probeAll(urls, onProgress = null) {
        const results = {};
        const uniqueUrls = [...new Set(urls)];
        let completed = 0;

        Logger.log('Prober', `بدء فحص ${uniqueUrls.length} فيديو...`);

        // تقسيم إلى دفعات
        const batchSize = GTOON_CONFIG.DURATION_PROBE_BATCH_SIZE;

        for (let i = 0; i < uniqueUrls.length; i += batchSize) {
            const batch = uniqueUrls.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(url => this.probeSingle(url))
            );

            batch.forEach((url, idx) => {
                results[url] = batchResults[idx];
                completed++;
                if (onProgress) {
                    onProgress(completed, uniqueUrls.length, url, batchResults[idx]);
                }
            });
        }

        Logger.log('Prober', `✅ اكتمل فحص ${uniqueUrls.length} فيديو`);
        return results;
    }

    /**
     * تحديث المدد في الجدول
     */
    applyDurations(schedule, durations) {
        let updated = 0;
        let issues = [];

        // تحديث الحلقات
        const days = Object.keys(schedule.weeklySchedule || {});
        for (const day of days) {
            const programs = schedule.weeklySchedule[day] || [];
            for (const program of programs) {
                if (program.episodes) {
                    for (const episode of program.episodes) {
                        if (durations[episode.url] !== undefined) {
                            const newDuration = durations[episode.url];
                            if (newDuration > 0) {
                                if (episode.duration !== newDuration) {
                                    episode.duration = newDuration;
                                    updated++;
                                }
                            } else {
                                issues.push({
                                    url: episode.url,
                                    title: episode.title,
                                    problem: 'فيديو معطل أو غير قابل للتحميل'
                                });
                            }
                        }
                    }
                }
            }
        }

        // تحديث الفواصل
        for (const bumper of (schedule.bumpers || [])) {
            if (durations[bumper.url] !== undefined && durations[bumper.url] > 0) {
                bumper.duration = durations[bumper.url];
                updated++;
            }
        }

        // تحديث المكتبة الاحتياطية
        for (const item of (schedule.backupLibrary || [])) {
            if (durations[item.url] !== undefined && durations[item.url] > 0) {
                item.duration = durations[item.url];
                updated++;
            }
        }

        // تحديث محتوى الطوارئ
        if (schedule.emergencyContent && durations[schedule.emergencyContent.url]) {
            schedule.emergencyContent.duration = durations[schedule.emergencyContent.url];
            updated++;
        }

        Logger.log('Prober', `تم تحديث ${updated} مدة. مشاكل: ${issues.length}`);

        if (issues.length > 0) {
            Logger.warn('Prober', '⚠️ فيديوهات بها مشاكل:', issues);
        }

        return { updated, issues };
    }

    /**
     * جمع كل الروابط الفريدة من الجدول
     */
    extractAllUrls(schedule) {
        const urls = new Set();

        // حلقات
        const days = Object.keys(schedule.weeklySchedule || {});
        for (const day of days) {
            for (const program of (schedule.weeklySchedule[day] || [])) {
                for (const episode of (program.episodes || [])) {
                    if (episode.url) urls.add(episode.url);
                }
            }
        }

        // فواصل
        for (const b of (schedule.bumpers || [])) {
            if (b.url) urls.add(b.url);
        }

        // إعلانات
        for (const a of (schedule.ads || [])) {
            if (a.url) urls.add(a.url);
        }

        // مكتبة احتياطية
        for (const item of (schedule.backupLibrary || [])) {
            if (item.url) urls.add(item.url);
        }

        // طوارئ
        if (schedule.emergencyContent?.url) {
            urls.add(schedule.emergencyContent.url);
        }

        return [...urls];
    }
}

// ============================================
// السجل
// ============================================
class Logger {
    static logs = [];
    static maxLogs = 500;

    static _add(level, module, message, data) {
        const entry = { time: new Date().toISOString(), level, module, message, data };
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) this.logs.shift();
    }

    static log(module, message, data = null) {
        this._add('info', module, message, data);
        console.log(`[${module}] ${message}`, data || '');
    }

    static warn(module, message, data = null) {
        this._add('warn', module, message, data);
        console.warn(`[${module}] ⚠️ ${message}`, data || '');
    }

    static error(module, message, data = null) {
        this._add('error', module, message, data);
        console.error(`[${module}] ❌ ${message}`, data || '');
    }

    static getErrors() { return this.logs.filter(l => l.level === 'error'); }
    static exportLogs() { return JSON.stringify(this.logs, null, 2); }
}

// ============================================
// مراقبة الشبكة
// ============================================
class NetworkMonitor {
    constructor(onStatusChange) {
        this.online = navigator.onLine;
        this.onStatusChange = onStatusChange;

        window.addEventListener('online', () => {
            this.online = true;
            Logger.log('Network', 'الاتصال عاد');
            this.onStatusChange(true);
        });

        window.addEventListener('offline', () => {
            this.online = false;
            Logger.warn('Network', 'انقطع الاتصال');
            this.onStatusChange(false);
        });
    }

    isOnline() { return this.online; }
}
