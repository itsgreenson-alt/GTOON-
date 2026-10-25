const GTOON_CONFIG = {
    // ============================================
    // إعدادات القناة
    // ============================================
    CHANNEL_NAME: 'GTOON FAST',
    TIMEZONE: 'Asia/Riyadh',
    UTC_OFFSET: 3, // توقيت مكة UTC+3

    // ============================================
    // إعدادات البث
    // ============================================
    SCHEDULE_URL: 'data/schedule.json',

    // مهلة التحميل المسبق (بالثواني)
    PRELOAD_TIMEOUT: 15,

    // مهلة تحميل الفيديو قبل اعتباره معطل (بالثواني)
    VIDEO_LOAD_TIMEOUT: 20,

    // عدد محاولات إعادة التحميل عند الفشل
    MAX_RETRY_ATTEMPTS: 3,

    // وقت الانتظار بين محاولات إعادة التحميل (بالثواني)
    RETRY_DELAY: 3,

    // مهلة Watchdog - إذا لم يتقدم الفيديو خلالها يعتبر معلق (بالثواني)
    WATCHDOG_INTERVAL: 10,

    // أقصى فرق مسموح بين ساعة الجهاز والوقت الفعلي (بالثواني)
    MAX_CLOCK_DRIFT: 5,

    // ============================================
    // إعدادات الإعلانات
    // ============================================
    // مدة الفاصل الإعلاني الافتراضية (بالثواني)
    DEFAULT_AD_BREAK_DURATION: 60,

    // أقصى عدد إعلانات في الفاصل الواحد
    MAX_ADS_PER_BREAK: 3,

    // أقصى تكرار لإعلان واحد في اليوم
    MAX_AD_PLAYS_PER_DAY: 10,

    // ============================================
    // إعدادات الجدول
    // ============================================
    // أقصى تكرار لحلقة واحدة في اليوم (عند ملء الفجوات)
    MAX_EPISODE_REPEATS: 3,

    // الحد الأقصى للفجوة المسموحة بدون محتوى (بالثواني)
    MAX_GAP_WITHOUT_CONTENT: 30,

    // السماح بتأخير البرنامج التالي إذا الحلقة أطول
    ALLOW_SCHEDULE_DELAY: false,

    // ============================================
    // إعدادات الواجهة
    // ============================================
    // إخفاء عناصر التحكم بعد (بالثواني)
    CONTROLS_HIDE_DELAY: 5,

    // تحديث الواجهة كل (بالمللي ثانية)
    UI_UPDATE_INTERVAL: 1000,

    // إظهار شريط التقدم
    SHOW_PROGRESS_BAR: true,

    // إظهار دليل البرامج
    SHOW_EPG: true,

    // ============================================
    // مصادر الوقت الخارجية
    // ============================================
    TIME_SERVERS: [
        'https://worldtimeapi.org/api/timezone/Asia/Riyadh',
        'https://timeapi.io/api/Time/current/zone?timeZone=Asia/Riyadh'
    ],

    // ============================================
    // حالات محرك البث (State Machine)
    // ============================================
    STATES: {
        IDLE: 'IDLE',
        LOADING: 'LOADING',
        PLAYING_EPISODE: 'PLAYING_EPISODE',
        PRELOADING_NEXT: 'PRELOADING_NEXT',
        PLAYING_BUMPER: 'PLAYING_BUMPER',
        PLAYING_ADS: 'PLAYING_ADS',
        PLAYING_BACKUP: 'PLAYING_BACKUP',
        PLAYING_EMERGENCY: 'PLAYING_EMERGENCY',
        RECOVERING: 'RECOVERING',
        ERROR: 'ERROR'
    }
};
