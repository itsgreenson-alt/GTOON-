const GTOON_CONFIG = {
    CHANNEL_NAME: 'GTOON FAST',
    TIMEZONE: 'Asia/Riyadh',
    UTC_OFFSET: 3,

    SCHEDULE_URL: 'data/schedule.json',

    PRELOAD_TIMEOUT: 15,
    VIDEO_LOAD_TIMEOUT: 30,
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 3,
    WATCHDOG_INTERVAL: 10,
    MAX_CLOCK_DRIFT: 5,

    DEFAULT_AD_BREAK_DURATION: 60,
    MAX_ADS_PER_BREAK: 3,
    MAX_AD_PLAYS_PER_DAY: 10,

    MAX_EPISODE_REPEATS: 4,
    MAX_GAP_WITHOUT_CONTENT: 30,
    ALLOW_SCHEDULE_DELAY: false,

    CONTROLS_HIDE_DELAY: 5,
    UI_UPDATE_INTERVAL: 1000,
    SHOW_PROGRESS_BAR: true,
    SHOW_EPG: true,

    // مدة اكتشاف المدة لكل فيديو (بالثواني)
    DURATION_PROBE_TIMEOUT: 15,

    // عدد الفيديوهات المتزامنة في فحص المدد
    DURATION_PROBE_BATCH_SIZE: 3,

    TIME_SERVERS: [
        'https://worldtimeapi.org/api/timezone/Asia/Riyadh',
        'https://timeapi.io/api/Time/current/zone?timeZone=Asia/Riyadh'
    ],

    STATES: {
        IDLE: 'IDLE',
        LOADING: 'LOADING',
        PROBING: 'PROBING_DURATIONS',
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
