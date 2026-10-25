class TimeManager {
    constructor() {
        this.clockOffset = 0;
        this.lastSync = 0;
        this.syncInterval = 300000; // مزامنة كل 5 دقائق
    }

    /**
     * مزامنة الوقت مع خادم خارجي
     */
    async syncTime() {
        for (const server of GTOON_CONFIG.TIME_SERVERS) {
            try {
                const beforeRequest = Date.now();
                const response = await fetch(server, {
                    signal: AbortSignal.timeout(5000)
                });
                const afterRequest = Date.now();
                const data = await response.json();

                let serverTime;
                if (data.unixtime) {
                    serverTime = data.unixtime * 1000;
                } else if (data.dateTime) {
                    serverTime = new Date(data.dateTime).getTime();
                } else {
                    continue;
                }

                // حساب التأخير في الشبكة
                const networkDelay = (afterRequest - beforeRequest) / 2;
                this.clockOffset = serverTime - afterRequest + networkDelay;
                this.lastSync = Date.now();

                console.log(`[TimeManager] تمت مزامنة الوقت. الانحراف: ${this.clockOffset}ms`);
                return true;
            } catch (error) {
                console.warn(`[TimeManager] فشل الاتصال بـ ${server}:`, error.message);
            }
        }

        console.warn('[TimeManager] فشلت مزامنة الوقت مع جميع المصادر. استخدام ساعة الجهاز.');
        return false;
    }

    /**
     * الوقت الحالي بتوقيت مكة (بالمللي ثانية)
     */
    now() {
        return Date.now() + this.clockOffset;
    }

    /**
     * الوقت الحالي بتوقيت مكة كـ Date object
     */
    getMeccaDate() {
        const utc = this.now();
        return new Date(utc + (GTOON_CONFIG.UTC_OFFSET * 3600000) - (new Date().getTimezoneOffset() * 60000));
    }

    /**
     * الوقت بتوقيت مكة بصيغة HH:MM:SS
     */
    getMeccaTimeString() {
        const d = this.getMeccaDate();
        return d.toTimeString().slice(0, 8);
    }

    /**
     * عدد الثواني منذ بداية اليوم بتوقيت مكة
     */
    getSecondsSinceMidnight() {
        const d = this.getMeccaDate();
        return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    }

    /**
     * اسم اليوم الحالي بالإنجليزية
     */
    getDayName() {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        return days[this.getMeccaDate().getDay()];
    }

    /**
     * تحويل وقت "HH:MM" إلى ثواني من بداية اليوم
     */
    static timeToSeconds(timeStr) {
        const parts = timeStr.split(':');
        const hours = parseInt(parts[0]);
        const minutes = parseInt(parts[1]);
        const seconds = parts.length > 2 ? parseInt(parts[2]) : 0;
        return hours * 3600 + minutes * 60 + seconds;
    }

    /**
     * تحويل ثواني إلى صيغة HH:MM:SS
     */
    static secondsToTime(totalSeconds) {
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    /**
     * تحويل ثواني إلى صيغة مقروءة (X ساعة Y دقيقة)
     */
    static formatDuration(seconds) {
        if (seconds < 60) return `${Math.floor(seconds)} ثانية`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)} دقيقة`;
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return m > 0 ? `${h} ساعة ${m} دقيقة` : `${h} ساعة`;
    }

    /**
     * التحقق من الحاجة لإعادة المزامنة
     */
    needsResync() {
        return Date.now() - this.lastSync > this.syncInterval;
    }
}


class Logger {
    static logs = [];
    static maxLogs = 500;

    static log(module, message, data = null) {
        const entry = {
            time: new Date().toISOString(),
            module,
            message,
            data,
            level: 'info'
        };
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) this.logs.shift();
        console.log(`[${module}] ${message}`, data || '');
    }

    static warn(module, message, data = null) {
        const entry = {
            time: new Date().toISOString(),
            module,
            message,
            data,
            level: 'warn'
        };
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) this.logs.shift();
        console.warn(`[${module}] ⚠️ ${message}`, data || '');
    }

    static error(module, message, data = null) {
        const entry = {
            time: new Date().toISOString(),
            module,
            message,
            data,
            level: 'error'
        };
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) this.logs.shift();
        console.error(`[${module}] ❌ ${message}`, data || '');
    }

    static getErrors() {
        return this.logs.filter(l => l.level === 'error');
    }

    static exportLogs() {
        return JSON.stringify(this.logs, null, 2);
    }
}


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

    isOnline() {
        return this.online;
    }
}
