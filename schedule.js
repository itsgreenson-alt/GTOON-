class ScheduleManager {
    constructor(timeManager) {
        this.timeManager = timeManager;
        this.rawSchedule = null;
        this.compiledSchedule = null; // الجدول المجمّع لـ 24 ساعة
        this.bumpers = [];
        this.ads = [];
        this.backupLibrary = [];
        this.emergencyContent = null;
        this.adPlayCounts = {}; // عداد تشغيل الإعلانات اليومي
        this.episodePlayCounts = {}; // عداد تشغيل الحلقات
        this.lastCompiledDay = null;
    }

    /**
     * تحميل الجدول من ملف JSON
     */
    async loadSchedule() {
        try {
            const response = await fetch(GTOON_CONFIG.SCHEDULE_URL + '?t=' + Date.now());
            this.rawSchedule = await response.json();

            this.bumpers = this.rawSchedule.bumpers || [];
            this.ads = this.rawSchedule.ads || [];
            this.backupLibrary = this.rawSchedule.backupLibrary || [];
            this.emergencyContent = this.rawSchedule.emergencyContent || null;

            Logger.log('Schedule', 'تم تحميل الجدول بنجاح');
            return true;
        } catch (error) {
            Logger.error('Schedule', 'فشل تحميل الجدول', error.message);
            return false;
        }
    }

    /**
     * تجميع جدول اليوم الكامل (24 ساعة)
     * هذه هي الخطوة الأساسية: تحويل الجدول الخام إلى قائمة متسلسلة دقيقة
     */
    compileDaySchedule(dayName = null) {
        if (!dayName) dayName = this.timeManager.getDayName();

        Logger.log('Schedule', `تجميع جدول يوم: ${dayName}`);

        // إعادة تعيين العدادات
        this.adPlayCounts = {};
        this.episodePlayCounts = {};

        const daySchedule = this.rawSchedule?.weeklySchedule?.[dayName] || [];
        let timeline = []; // القائمة النهائية المتسلسلة

        if (daySchedule.length === 0) {
            Logger.warn('Schedule', `جدول يوم ${dayName} فارغ. سيتم استخدام المكتبة الاحتياطية.`);
            timeline = this._buildFullDayFromBackup();
        } else {
            timeline = this._buildTimelineFromSchedule(daySchedule);
        }

        // التحقق من التغطية الكاملة لـ 24 ساعة
        timeline = this._ensureFullDayCoverage(timeline);

        // إضافة الفواصل والإعلانات
        timeline = this._insertBumpersAndAds(timeline);

        this.compiledSchedule = timeline;
        this.lastCompiledDay = dayName;

        // تقرير الجدول
        this._logScheduleReport(timeline);

        return timeline;
    }

    /**
     * بناء الجدول من البرامج المحددة
     */
    _buildTimelineFromSchedule(programs) {
        let timeline = [];

        for (let i = 0; i < programs.length; i++) {
            const program = programs[i];
            const startSeconds = TimeManager.timeToSeconds(program.start);

            // حساب الوقت المتاح حتى البرنامج التالي
            let availableTime;
            if (i + 1 < programs.length) {
                availableTime = TimeManager.timeToSeconds(programs[i + 1].start) - startSeconds;
            } else {
                availableTime = 86400 - startSeconds; // حتى نهاية اليوم
            }

            // إضافة حلقات البرنامج
            let currentTime = startSeconds;
            let remainingTime = availableTime;

            if (program.episodes && program.episodes.length > 0) {
                for (const episode of program.episodes) {
                    if (remainingTime <= 0) break;

                    // التحقق: هل الحلقة تناسب الوقت المتبقي؟
                    if (episode.duration <= remainingTime || GTOON_CONFIG.ALLOW_SCHEDULE_DELAY) {
                        timeline.push({
                            type: 'episode',
                            startTime: currentTime,
                            duration: episode.duration,
                            endTime: currentTime + episode.duration,
                            title: `${program.title} - ${episode.title}`,
                            programTitle: program.title,
                            episodeTitle: episode.title,
                            url: episode.url,
                            adBreakAfter: program.adBreakAfter || false
                        });
                        currentTime += episode.duration;
                        remainingTime -= episode.duration;
                    } else {
                        // الحلقة أطول من الوقت المتاح
                        Logger.warn('Schedule',
                            `الحلقة "${episode.title}" (${episode.duration}ث) أطول من الوقت المتاح (${remainingTime}ث). ` +
                            'سيتم البحث عن محتوى أقصر.');

                        // البحث عن محتوى احتياطي مناسب للمدة
                        const filler = this._findFillerContent(remainingTime);
                        if (filler) {
                            timeline.push({
                                ...filler,
                                startTime: currentTime,
                                endTime: currentTime + filler.duration
                            });
                            currentTime += filler.duration;
                            remainingTime -= filler.duration;
                        }
                        break;
                    }
                }
            }

            // إذا بقي وقت فارغ بعد حلقات البرنامج
            if (remainingTime > GTOON_CONFIG.MAX_GAP_WITHOUT_CONTENT) {
                const fillers = this._fillGap(currentTime, remainingTime);
                timeline.push(...fillers);
            }
        }

        return timeline;
    }

    /**
     * ملء فجوة زمنية بمحتوى مناسب
     */
    _fillGap(startTime, duration) {
        Logger.log('Schedule', `ملء فجوة: ${TimeManager.secondsToTime(startTime)} - المدة: ${duration}ث`);

        let fillers = [];
        let remaining = duration;
        let currentTime = startTime;

        while (remaining > GTOON_CONFIG.MAX_GAP_WITHOUT_CONTENT) {
            const content = this._findFillerContent(remaining);
            if (!content) {
                // لا يوجد محتوى مناسب، استخدام المحتوى الطارئ
                if (this.emergencyContent) {
                    fillers.push({
                        type: 'emergency',
                        startTime: currentTime,
                        duration: Math.min(remaining, this.emergencyContent.duration),
                        endTime: currentTime + Math.min(remaining, this.emergencyContent.duration),
                        title: this.emergencyContent.title,
                        url: this.emergencyContent.url,
                        loop: this.emergencyContent.loop
                    });
                }
                break;
            }

            fillers.push({
                ...content,
                startTime: currentTime,
                endTime: currentTime + content.duration
            });

            currentTime += content.duration;
            remaining -= content.duration;
        }

        return fillers;
    }

    /**
     * البحث عن محتوى احتياطي يناسب المدة المتاحة
     */
    _findFillerContent(maxDuration) {
        // البحث في المكتبة الاحتياطية عن محتوى مناسب
        const available = this.backupLibrary
            .filter(item => {
                const playCount = this.episodePlayCounts[item.id] || 0;
                return item.duration <= maxDuration && playCount < GTOON_CONFIG.MAX_EPISODE_REPEATS;
            })
            .sort((a, b) => b.duration - a.duration); // الأطول أولاً

        if (available.length > 0) {
            const selected = available[0];
            this.episodePlayCounts[selected.id] = (this.episodePlayCounts[selected.id] || 0) + 1;
            return {
                type: 'backup',
                duration: selected.duration,
                title: selected.title,
                url: selected.url,
                id: selected.id
            };
        }

        // إذا لم يوجد محتوى مناسب في المكتبة، البحث عن فاصل
        const bumper = this.bumpers.find(b => b.duration <= maxDuration);
        if (bumper) {
            return {
                type: 'bumper',
                duration: bumper.duration,
                title: bumper.title,
                url: bumper.url,
                id: bumper.id
            };
        }

        return null;
    }

    /**
     * بناء يوم كامل من المكتبة الاحتياطية
     */
    _buildFullDayFromBackup() {
        return this._fillGap(0, 86400);
    }

    /**
     * التأكد من تغطية 24 ساعة كاملة
     */
    _ensureFullDayCoverage(timeline) {
        if (timeline.length === 0) {
            return this._buildFullDayFromBackup();
        }

        // ترتيب حسب وقت البداية
        timeline.sort((a, b) => a.startTime - b.startTime);

        let fullTimeline = [];

        // ملء الفجوة من بداية اليوم
        if (timeline[0].startTime > GTOON_CONFIG.MAX_GAP_WITHOUT_CONTENT) {
            const fillers = this._fillGap(0, timeline[0].startTime);
            fullTimeline.push(...fillers);
        }

        // ملء الفجوات بين البرامج
        for (let i = 0; i < timeline.length; i++) {
            fullTimeline.push(timeline[i]);

            if (i + 1 < timeline.length) {
                const gap = timeline[i + 1].startTime - timeline[i].endTime;
                if (gap > GTOON_CONFIG.MAX_GAP_WITHOUT_CONTENT) {
                    const fillers = this._fillGap(timeline[i].endTime, gap);
                    fullTimeline.push(...fillers);
                }
            }
        }

        // ملء الفجوة حتى نهاية اليوم
        const lastItem = fullTimeline[fullTimeline.length - 1];
        if (lastItem && lastItem.endTime < 86400 - GTOON_CONFIG.MAX_GAP_WITHOUT_CONTENT) {
            const fillers = this._fillGap(lastItem.endTime, 86400 - lastItem.endTime);
            fullTimeline.push(...fillers);
        }

        return fullTimeline;
    }

    /**
     * إضافة الفواصل والإعلانات بين البرامج
     */
    _insertBumpersAndAds(timeline) {
        let enrichedTimeline = [];
        let timeShift = 0; // التأخير التراكمي بسبب الفواصل

        for (let i = 0; i < timeline.length; i++) {
            const item = { ...timeline[i] };
            item.startTime += timeShift;
            item.endTime += timeShift;
            enrichedTimeline.push(item);

            // إضافة فاصل إعلاني بعد البرنامج إذا مطلوب
            if (item.adBreakAfter && item.type === 'episode') {
                const adBreak = this._createAdBreak(item.endTime + timeShift);
                if (adBreak.length > 0) {
                    enrichedTimeline.push(...adBreak);
                    const adDuration = adBreak.reduce((sum, ad) => sum + ad.duration, 0);
                    timeShift += adDuration;
                }
            }
        }

        return enrichedTimeline;
    }

    /**
     * إنشاء فاصل إعلاني
     */
    _createAdBreak(startTime) {
        let adBreak = [];
        let currentTime = startTime;
        let totalDuration = 0;

        // فاصل "نعود بعد قليل"
        const brbBumper = this.bumpers.find(b => b.id === 'bumper_brb');
        if (brbBumper) {
            adBreak.push({
                type: 'bumper',
                startTime: currentTime,
                duration: brbBumper.duration,
                endTime: currentTime + brbBumper.duration,
                title: brbBumper.title,
                url: brbBumper.url
            });
            currentTime += brbBumper.duration;
            totalDuration += brbBumper.duration;
        }

        // إعلانات
        const availableAds = this.ads.filter(ad => {
            const playCount = this.adPlayCounts[ad.id] || 0;
            return playCount < (ad.maxPlaysPerDay || GTOON_CONFIG.MAX_AD_PLAYS_PER_DAY);
        });

        let adsAdded = 0;
        for (const ad of availableAds) {
            if (adsAdded >= GTOON_CONFIG.MAX_ADS_PER_BREAK) break;
            if (totalDuration + ad.duration > GTOON_CONFIG.DEFAULT_AD_BREAK_DURATION) break;

            adBreak.push({
                type: 'ad',
                startTime: currentTime,
                duration: ad.duration,
                endTime: currentTime + ad.duration,
                title: ad.title,
                url: ad.url,
                adId: ad.id
            });

            this.adPlayCounts[ad.id] = (this.adPlayCounts[ad.id] || 0) + 1;
            currentTime += ad.duration;
            totalDuration += ad.duration;
            adsAdded++;
        }

        // فاصل "عدنا"
        const backBumper = this.bumpers.find(b => b.id === 'bumper_back');
        if (backBumper) {
            adBreak.push({
                type: 'bumper',
                startTime: currentTime,
                duration: backBumper.duration,
                endTime: currentTime + backBumper.duration,
                title: backBumper.title,
                url: backBumper.url
            });
        }

        return adBreak;
    }

    /**
     * العثور على العنصر الحالي في الجدول
     */
    getCurrentItem() {
        if (!this.compiledSchedule) return null;

        const now = this.timeManager.getSecondsSinceMidnight();

        // التحقق من تغير اليوم
        const currentDay = this.timeManager.getDayName();
        if (this.lastCompiledDay !== currentDay) {
            Logger.log('Schedule', 'تغير اليوم، إعادة تجميع الجدول');
            this.compileDaySchedule(currentDay);
        }

        for (let i = 0; i < this.compiledSchedule.length; i++) {
            const item = this.compiledSchedule[i];
            if (now >= item.startTime && now < item.endTime) {
                return {
                    ...item,
                    index: i,
                    elapsed: now - item.startTime,
                    remaining: item.endTime - now,
                    seekPosition: now - item.startTime
                };
            }
        }

        // إذا لم نجد عنصر (فجوة غير متوقعة)
        Logger.warn('Schedule', 'لم يتم العثور على عنصر للوقت الحالي', {
            currentTime: TimeManager.secondsToTime(now)
        });

        return this._getEmergencyItem();
    }

    /**
     * العنصر التالي في الجدول
     */
    getNextItem(currentIndex) {
        if (!this.compiledSchedule || currentIndex === undefined) return null;

        if (currentIndex + 1 < this.compiledSchedule.length) {
            return {
                ...this.compiledSchedule[currentIndex + 1],
                index: currentIndex + 1
            };
        }

        // نهاية اليوم - الجدول سيعاد تجميعه
        return {
            type: 'info',
            title: 'نهاية جدول اليوم',
            startTime: 86400
        };
    }

    /**
     * الحصول على جدول اليوم للعرض (EPG)
     */
    getEPG(count = 10) {
        if (!this.compiledSchedule) return [];

        const now = this.timeManager.getSecondsSinceMidnight();
        const upcoming = this.compiledSchedule
            .filter(item => item.endTime > now && item.type !== 'bumper')
            .slice(0, count);

        return upcoming.map(item => ({
            time: TimeManager.secondsToTime(item.startTime),
            title: item.title,
            type: item.type,
            duration: TimeManager.formatDuration(item.duration),
            isNow: now >= item.startTime && now < item.endTime
        }));
    }

    /**
     * عنصر طوارئ
     */
    _getEmergencyItem() {
        if (this.emergencyContent) {
            return {
                type: 'emergency',
                title: this.emergencyContent.title,
                url: this.emergencyContent.url,
                duration: this.emergencyContent.duration,
                loop: true,
                seekPosition: 0,
                index: -1
            };
        }
        return null;
    }

    /**
     * تقرير الجدول المجمّع
     */
    _logScheduleReport(timeline) {
        const totalDuration = timeline.reduce((sum, item) => sum + item.duration, 0);
        const types = {};
        timeline.forEach(item => {
            types[item.type] = (types[item.type] || 0) + 1;
        });

        Logger.log('Schedule', '📋 تقرير الجدول:', {
            عددالعناصر: timeline.length,
            المدةالإجمالية: TimeManager.formatDuration(totalDuration),
            التغطية: `${((totalDuration / 86400) * 100).toFixed(1)}%`,
            التوزيع: types,
            أولعنصر: timeline[0] ? `${TimeManager.secondsToTime(timeline[0].startTime)} - ${timeline[0].title}` : 'فارغ',
            آخرعنصر: timeline[timeline.length - 1] ?
                `${TimeManager.secondsToTime(timeline[timeline.length - 1].startTime)} - ${timeline[timeline.length - 1].title}` : 'فارغ'
        });
    }
}
