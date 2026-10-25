class ScheduleManager {
    constructor(timeManager) {
        this.timeManager = timeManager;
        this.rawSchedule = null;
        this.compiledSchedule = null;
        this.bumpers = [];
        this.ads = [];
        this.backupLibrary = [];
        this.emergencyContent = null;
        this.adPlayCounts = {};
        this.episodePlayCounts = {};
        this.lastCompiledDay = null;
        this.prober = new DurationProber();
    }

    async loadSchedule() {
        try {
            const response = await fetch(GTOON_CONFIG.SCHEDULE_URL + '?t=' + Date.now());
            this.rawSchedule = await response.json();

            this.bumpers = this.rawSchedule.bumpers || [];
            this.ads = this.rawSchedule.ads || [];
            this.backupLibrary = this.rawSchedule.backupLibrary || [];
            this.emergencyContent = this.rawSchedule.emergencyContent || null;

            Logger.log('Schedule', 'تم تحميل الجدول');
            return true;
        } catch (error) {
            Logger.error('Schedule', 'فشل تحميل الجدول', error.message);
            return false;
        }
    }

    /**
     * فحص واكتشاف المدد الحقيقية لجميع الفيديوهات
     */
    async probeDurations(onProgress = null) {
        if (!this.rawSchedule) return false;

        const urls = this.prober.extractAllUrls(this.rawSchedule);
        Logger.log('Schedule', `فحص مدد ${urls.length} فيديو فريد...`);

        const durations = await this.prober.probeAll(urls, onProgress);
        const result = this.prober.applyDurations(this.rawSchedule, durations);

        // تحديث المراجع المحلية
        this.bumpers = this.rawSchedule.bumpers || [];
        this.ads = this.rawSchedule.ads || [];
        this.backupLibrary = this.rawSchedule.backupLibrary || [];
        this.emergencyContent = this.rawSchedule.emergencyContent || null;

        return result;
    }

    /**
     * تجميع جدول يوم كامل 24 ساعة
     */
    compileDaySchedule(dayName = null) {
        if (!dayName) dayName = this.timeManager.getDayName();
        Logger.log('Schedule', `تجميع جدول: ${dayName}`);

        this.adPlayCounts = {};
        this.episodePlayCounts = {};

        let daySchedule = this.rawSchedule?.weeklySchedule?.[dayName] || [];

        // إذا جدول اليوم فارغ، نستخدم يوم الأحد كافتراضي
        if (daySchedule.length === 0) {
            Logger.warn('Schedule', `جدول ${dayName} فارغ. استخدام يوم الأحد.`);
            daySchedule = this.rawSchedule?.weeklySchedule?.sunday || [];
        }

        let timeline;
        if (daySchedule.length === 0) {
            timeline = this._buildFullDayFromBackup();
        } else {
            timeline = this._buildTimelineFromSchedule(daySchedule);
        }

        timeline = this._ensureFullDayCoverage(timeline);
        timeline = this._insertBumpersAndAds(timeline);

        // إعادة حساب أوقات البداية والنهاية بشكل متسلسل
        timeline = this._recalculateTimeline(timeline);

        this.compiledSchedule = timeline;
        this.lastCompiledDay = dayName;
        this._logScheduleReport(timeline);

        return timeline;
    }

    _buildTimelineFromSchedule(programs) {
        let timeline = [];

        for (let i = 0; i < programs.length; i++) {
            const program = programs[i];
            const startSeconds = TimeManager.timeToSeconds(program.start);

            let nextStart;
            if (i + 1 < programs.length) {
                nextStart = TimeManager.timeToSeconds(programs[i + 1].start);
            } else {
                nextStart = 86400;
            }

            let availableTime = nextStart - startSeconds;
            let currentTime = startSeconds;
            let remaining = availableTime;

            if (program.episodes && program.episodes.length > 0) {
                for (const episode of program.episodes) {
                    if (remaining <= 0) break;

                    const duration = episode.duration || 1200; // 20 دقيقة افتراضي

                    if (duration <= 0) {
                        Logger.warn('Schedule', `تخطي حلقة بدون مدة: ${episode.title}`);
                        continue;
                    }

                    // إذا الحلقة تتناسب أو نسمح بالتأخير
                    if (duration <= remaining + 60 || GTOON_CONFIG.ALLOW_SCHEDULE_DELAY) {
                        timeline.push({
                            type: 'episode',
                            startTime: currentTime,
                            duration: duration,
                            endTime: currentTime + duration,
                            title: `${program.title} - ${episode.title}`,
                            programTitle: program.title,
                            episodeTitle: episode.title,
                            url: episode.url,
                            adBreakAfter: program.adBreakAfter || false
                        });
                        currentTime += duration;
                        remaining -= duration;
                    } else {
                        // الحلقة أطول من الوقت المتبقي
                        Logger.warn('Schedule',
                            `"${episode.title}" (${duration}ث) > الوقت المتاح (${remaining}ث)`);

                        const filler = this._findFillerContent(remaining);
                        if (filler) {
                            timeline.push({
                                ...filler,
                                startTime: currentTime,
                                endTime: currentTime + filler.duration
                            });
                            currentTime += filler.duration;
                            remaining -= filler.duration;
                        }
                        break;
                    }
                }
            }

            // ملء الوقت المتبقي
            if (remaining > GTOON_CONFIG.MAX_GAP_WITHOUT_CONTENT) {
                const fillers = this._fillGap(currentTime, remaining);
                timeline.push(...fillers);
                currentTime += fillers.reduce((s, f) => s + f.duration, 0);
            }
        }

        return timeline;
    }

    _fillGap(startTime, duration) {
        Logger.log('Schedule', `ملء فجوة ${TimeManager.secondsToTime(startTime)} (${duration}ث)`);

        let fillers = [];
        let remaining = duration;
        let currentTime = startTime;
        let safetyCounter = 0;

        while (remaining > GTOON_CONFIG.MAX_GAP_WITHOUT_CONTENT && safetyCounter < 100) {
            safetyCounter++;

            const content = this._findFillerContent(remaining);
            if (!content) {
                // فاصل طوارئ
                if (this.emergencyContent && this.emergencyContent.duration > 0) {
                    const dur = Math.min(remaining, this.emergencyContent.duration);
                    fillers.push({
                        type: 'emergency',
                        startTime: currentTime,
                        duration: dur,
                        endTime: currentTime + dur,
                        title: this.emergencyContent.title,
                        url: this.emergencyContent.url,
                        loop: true
                    });
                    currentTime += dur;
                    remaining -= dur;
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

    _findFillerContent(maxDuration) {
        // 1. بحث في المكتبة الاحتياطية
        const available = this.backupLibrary
            .filter(item => {
                const plays = this.episodePlayCounts[item.id] || 0;
                return item.duration > 0 && item.duration <= maxDuration &&
                       plays < GTOON_CONFIG.MAX_EPISODE_REPEATS;
            })
            .sort((a, b) => b.duration - a.duration);

        if (available.length > 0) {
            const selected = available[0];
            this.episodePlayCounts[selected.id] = (this.episodePlayCounts[selected.id] || 0) + 1;
            return {
                type: 'backup',
                duration: selected.duration,
                title: selected.title + ' (إعادة)',
                url: selected.url,
                id: selected.id
            };
        }

        // 2. بحث في الفواصل
        const bumpers = this.bumpers
            .filter(b => b.duration > 0 && b.duration <= maxDuration)
            .sort((a, b) => b.duration - a.duration);

        if (bumpers.length > 0) {
            return {
                type: 'bumper',
                duration: bumpers[0].duration,
                title: bumpers[0].title,
                url: bumpers[0].url,
                id: bumpers[0].id
            };
        }

        return null;
    }

    _buildFullDayFromBackup() {
        return this._fillGap(0, 86400);
    }

    _ensureFullDayCoverage(timeline) {
        if (timeline.length === 0) return this._buildFullDayFromBackup();

        timeline.sort((a, b) => a.startTime - b.startTime);
        let full = [];

        // من بداية اليوم
        if (timeline[0].startTime > GTOON_CONFIG.MAX_GAP_WITHOUT_CONTENT) {
            full.push(...this._fillGap(0, timeline[0].startTime));
        }

        // بين البرامج
        for (let i = 0; i < timeline.length; i++) {
            full.push(timeline[i]);

            if (i + 1 < timeline.length) {
                const gap = timeline[i + 1].startTime - timeline[i].endTime;
                if (gap > GTOON_CONFIG.MAX_GAP_WITHOUT_CONTENT) {
                    full.push(...this._fillGap(timeline[i].endTime, gap));
                }
            }
        }

        // حتى نهاية اليوم
        const last = full[full.length - 1];
        if (last && last.endTime < 86400 - GTOON_CONFIG.MAX_GAP_WITHOUT_CONTENT) {
            full.push(...this._fillGap(last.endTime, 86400 - last.endTime));
        }

        return full;
    }

    _insertBumpersAndAds(timeline) {
        let enriched = [];

        for (let i = 0; i < timeline.length; i++) {
            const item = { ...timeline[i] };
            enriched.push(item);

            if (item.adBreakAfter && item.type === 'episode') {
                const adBreak = this._createAdBreak();
                if (adBreak.length > 0) {
                    enriched.push(...adBreak);
                }
            }
        }

        return enriched;
    }

    _createAdBreak() {
        let adBreak = [];

        // فاصل عشوائي من القناة
        const availableBumpers = this.bumpers.filter(b => b.duration > 0);
        if (availableBumpers.length > 0) {
            const randomBumper = availableBumpers[Math.floor(Math.random() * availableBumpers.length)];
            adBreak.push({
                type: 'bumper',
                duration: randomBumper.duration,
                title: randomBumper.title,
                url: randomBumper.url,
                startTime: 0,
                endTime: 0
            });
        }

        // إعلانات (لو موجودة)
        const availableAds = this.ads.filter(ad => {
            const plays = this.adPlayCounts[ad.id] || 0;
            return plays < (ad.maxPlaysPerDay || GTOON_CONFIG.MAX_AD_PLAYS_PER_DAY);
        });

        for (const ad of availableAds.slice(0, GTOON_CONFIG.MAX_ADS_PER_BREAK)) {
            adBreak.push({
                type: 'ad',
                duration: ad.duration,
                title: ad.title,
                url: ad.url,
                adId: ad.id,
                startTime: 0,
                endTime: 0
            });
            this.adPlayCounts[ad.id] = (this.adPlayCounts[ad.id] || 0) + 1;
        }

        return adBreak;
    }

    /**
     * إعادة حساب الجدول بشكل متسلسل (الأهم!)
     * يضمن أن كل عنصر يبدأ بعد انتهاء السابق بالضبط
     */
    _recalculateTimeline(timeline) {
        if (timeline.length === 0) return timeline;

        let currentTime = timeline[0].startTime || 0;

        for (let i = 0; i < timeline.length; i++) {
            timeline[i].startTime = currentTime;
            timeline[i].endTime = currentTime + timeline[i].duration;
            currentTime = timeline[i].endTime;
        }

        // إذا الجدول أقصر من 24 ساعة
        if (currentTime < 86400 - 60) {
            Logger.warn('Schedule', `الجدول ينتهي عند ${TimeManager.secondsToTime(currentTime)}. إضافة محتوى...`);
            const extra = this._fillGap(currentTime, 86400 - currentTime);
            for (const item of extra) {
                item.startTime = currentTime;
                item.endTime = currentTime + item.duration;
                currentTime = item.endTime;
                timeline.push(item);
            }
        }

        return timeline;
    }

    getCurrentItem() {
        if (!this.compiledSchedule) return null;

        const now = this.timeManager.getSecondsSinceMidnight();

        // تحقق من تغير اليوم
        const currentDay = this.timeManager.getDayName();
        if (this.lastCompiledDay !== currentDay) {
            Logger.log('Schedule', 'يوم جديد! إعادة التجميع...');
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

        // فجوة غير متوقعة
        Logger.warn('Schedule', `لا يوجد عنصر للوقت ${TimeManager.secondsToTime(now)}`);

        // بحث عن أقرب عنصر قادم
        for (let i = 0; i < this.compiledSchedule.length; i++) {
            if (this.compiledSchedule[i].startTime > now) {
                return {
                    ...this.compiledSchedule[i],
                    index: i,
                    elapsed: 0,
                    remaining: this.compiledSchedule[i].duration,
                    seekPosition: 0
                };
            }
        }

        return this._getEmergencyItem();
    }

    getNextItem(currentIndex) {
        if (!this.compiledSchedule || currentIndex === undefined) return null;

        if (currentIndex + 1 < this.compiledSchedule.length) {
            return { ...this.compiledSchedule[currentIndex + 1], index: currentIndex + 1 };
        }

        return { type: 'info', title: 'نهاية جدول اليوم', startTime: 86400 };
    }

    getEPG(count = 10) {
        if (!this.compiledSchedule) return [];

        const now = this.timeManager.getSecondsSinceMidnight();
        return this.compiledSchedule
            .filter(item => item.endTime > now)
            .slice(0, count)
            .map(item => ({
                time: TimeManager.secondsToTime(item.startTime),
                title: item.title,
                type: item.type,
                duration: TimeManager.formatDuration(item.duration),
                isNow: now >= item.startTime && now < item.endTime
            }));
    }

    _getEmergencyItem() {
        if (this.emergencyContent) {
            return {
                type: 'emergency',
                title: this.emergencyContent.title,
                url: this.emergencyContent.url,
                duration: this.emergencyContent.duration || 60,
                loop: true,
                seekPosition: 0,
                index: -1,
                remaining: 60,
                elapsed: 0
            };
        }
        return null;
    }

    _logScheduleReport(timeline) {
        const totalDuration = timeline.reduce((s, i) => s + i.duration, 0);
        const types = {};
        timeline.forEach(i => { types[i.type] = (types[i.type] || 0) + 1; });

        Logger.log('Schedule', '📋 تقرير الجدول:', {
            عناصر: timeline.length,
            المدة: TimeManager.formatDuration(totalDuration),
            التغطية: `${((totalDuration / 86400) * 100).toFixed(1)}%`,
            التوزيع: types,
            أول: timeline[0] ? `${TimeManager.secondsToTime(timeline[0].startTime)} ${timeline[0].title}` : '-',
            آخر: timeline.length ? `${TimeManager.secondsToTime(timeline[timeline.length-1].startTime)} ${timeline[timeline.length-1].title}` : '-'
        });
    }
}
