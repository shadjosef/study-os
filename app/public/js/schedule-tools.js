'use strict';

window.StudySchedule = (() => {
  const zone = 'Europe/Oslo';
  const minute = 60_000;
  const day = 24 * 60 * minute;
  const clock = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const pieces = (time, formatter = clock) => Object.fromEntries(
    formatter.formatToParts(time).filter(part => part.type !== 'literal').map(part => [part.type, part.value])
  );
  const pad = n => String(n).padStart(2, '0');
  const dateKey = time => {
    const { year, month, day } = pieces(time);
    return `${year}-${month}-${day}`;
  };
  const timeLabel = time => {
    const { hour, minute } = pieces(time);
    return `${hour}:${minute}`;
  };
  function wallTime(date, time, formatter = clock) {
    const target = Date.parse(`${date}T${time.length === 5 ? time + ':00' : time}Z`);
    let instant = target;
    for (let i = 0; i < 2; i++) {
      const { year, month, day, hour, minute, second } = pieces(instant, formatter);
      instant += target - Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    }
    return instant;
  }
  const moveDate = (date, days) => new Date(Date.parse(date) + days * day).toISOString().slice(0, 10);
  const atMinutes = (date, minutes) => minutes === 1440
    ? wallTime(moveDate(date, 1), '00:00')
    : wallTime(date, `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
  const iso = time => new Date(time).toISOString();
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

  function bounds(wake, sleep) {
    if (!timePattern.test(wake) || !timePattern.test(sleep)) throw new Error('Enter a wake-up time and a bedtime.');
    const toMinutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const awake = toMinutes(wake);
    const sleeping = toMinutes(sleep);
    if (awake === sleeping) throw new Error('Wake-up time and bedtime must be different.');
    // Keep study blocks 30 minutes away from waking up or going to bed.
    return [awake + 30, Math.min(1440, sleeping + (sleeping < awake ? 1440 : 0) - 30)];
  }

  const courseFor = (summary, catalog) => {
    const text = summary.toLowerCase().replace(/\s+/g, '');
    return catalog.find(course => [course.code, course.title, course.shortTitle].some(value =>
      value && value.length >= 4 && text.includes(value.toLowerCase().replace(/\s+/g, ''))
    ));
  };

  function block(id, summary, start, end, kind, courseId = '', dlpfcMode = '', topicIds = [], topicTitle = '') {
    const mins = Math.max(0, Math.round((end - start) / minute));
    return {
      eventId: id, summary, courseId, date: dateKey(start), startIso: iso(start), endIso: iso(end),
      startLabel: timeLabel(start), endLabel: timeLabel(end), blockKind: kind,
      focusMinutes: mins, attemptBudgetMinutes: Math.floor(mins * 0.85), recommendedProfile: 'learning',
      ...(dlpfcMode ? { dlpfcMode } : {}),
      ...(topicIds?.length ? { topicIds } : {}),
      ...(topicTitle ? { topicTitle } : {}),
    };
  }

  async function readCalendar(text, now = Date.now(), { includeTransparent = false } = {}) {
    if (text.length > 2_000_000 || !/BEGIN:VCALENDAR/i.test(text)) {
      throw new Error('Choose a valid .ics calendar file under 2 MB.');
    }
    const { default: ICAL } = await import('../vendor/ical-2.2.1.mjs');
    const calendar = new ICAL.Component(ICAL.parse(text));
    const from = wallTime(dateKey(now), '00:00');
    const until = wallTime(moveDate(dateKey(now), 14), '00:00');
    ICAL.TimezoneService.reset();
    for (const component of calendar.getAllSubcomponents('vtimezone')) {
      ICAL.TimezoneService.register(new ICAL.Timezone(component));
    }
    const events = calendar.getAllSubcomponents('vevent').map(component => new ICAL.Event(component));
    const exceptions = new Map();
    for (const event of events.filter(item => item.isRecurrenceException())) {
      if (!exceptions.has(event.uid)) exceptions.set(event.uid, []);
      exceptions.get(event.uid).push(event);
    }
    const tzFormatters = new Map();
    function epoch(time, tzid) {
      if (!time) return NaN;
      if (time.zone !== ICAL.Timezone.localTimezone && !time.isDate) return time.toUnixTime() * 1000;
      if (tzid && !tzFormatters.has(tzid)) {
        try { tzFormatters.set(tzid, new Intl.DateTimeFormat('en-CA', { ...clock.resolvedOptions(), timeZone: tzid })); }
        catch { throw new Error(`Calendar uses an unknown time zone (${tzid}).`); }
      }
      return wallTime(
        `${time.year}-${pad(time.month)}-${pad(time.day)}`,
        `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`,
        tzFormatters.get(tzid) || clock,
      );
    }

    const fixed = new Map();
    let iterations = 0;
    function addEvent(original, details) {
      const item = details?.item || original;
      const transparent = item.component.getFirstPropertyValue('transp')?.toUpperCase() === 'TRANSPARENT';
      if (item.component.getFirstPropertyValue('status')?.toUpperCase() === 'CANCELLED' ||
          (transparent && !includeTransparent)) return;
      const dateProperty = item.component.getFirstProperty('dtstart');
      const tzid = dateProperty?.getParameter('tzid');
      const start = epoch(details?.startDate || item.startDate, tzid);
      const reportedEnd = epoch(details?.endDate || item.endDate, tzid);
      const end = Number.isFinite(reportedEnd) && reportedEnd > start ? reportedEnd : start + 60 * minute;
      if (!Number.isFinite(start) || end <= from || start >= until) return;
      const summary = item.summary?.trim() || 'Busy';
      const uid = `${original.uid || summary}-${start}`;
      fixed.set(uid, { uid, start, end, summary, allDay: Boolean(item.startDate?.isDate), transparent });
      if (fixed.size > 1500) throw new Error('This calendar has too many events in the next two weeks.');
    }
    for (const event of events) {
      if (event.isRecurrenceException() || !event.startDate) continue;
      if (!event.isRecurring()) { addEvent(event); continue; }
      for (const exception of exceptions.get(event.uid) || []) event.relateException(exception);
      const iterator = event.iterator();
      const tzid = event.component.getFirstProperty('dtstart')?.getParameter('tzid');
      for (let next = iterator.next(); next && epoch(next, tzid) < until; next = iterator.next()) {
        if (++iterations > 70_000) throw new Error('This calendar repeats too frequently. Export the dates you need as a new .ics file.');
        addEvent(event, event.getOccurrenceDetails(next));
      }
    }
    if (!events.length) throw new Error('This calendar contains no events.');
    return [...fixed.values()];
  }

  function importStudyPlan(events, catalog, currentBlocks, now = Date.now()) {
    const normalize = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const courseNames = new Map();
    for (const course of catalog) {
      for (const name of [course.code, course.title, course.shortTitle].filter(Boolean)) {
        courseNames.set(normalize(name), course);
      }
      const shortName = course.shortTitle?.split(' & ')[0];
      if (shortName) courseNames.set(normalize(shortName), course);
      if (shortName === 'Mathematics') {
        courseNames.set('maths', course);
        courseNames.set('math', course);
      }
    }
    const appliedIds = new Set(currentBlocks.map(item => item.eventId));
    const result = [];
    for (const event of events) {
      if (event.allDay) continue;
      const title = event.summary.replace(/^\[(?:high|med(?:ium)?|low)\s*dlpfc\]\s*/i, '');
      const [, name, topic] = /^(.+?)(?:\s*[:·]\s*|\s+[–—-]\s+)(.+)$/.exec(title) || [];
      const course = courseNames.get(normalize(name || title));
      if (!course) continue;
      const id = `calendar-plan-${event.uid}`;
      if (event.end <= now && !appliedIds.has(id)) continue;
      const kind = /^(?:(?:home|final|written|oral)\s+)?(?:exam|eksamen)(?:\s*[·:–—-]|$)/i.test(topic || '')
        ? 'exam' : 'study_block';
      result.push({ ...block(id, event.summary, event.start, event.end, kind, course.courseId),
        optional: event.transparent });
    }
    return result.sort((a, b) => a.startIso.localeCompare(b.startIso));
  }

  function plan(fixed, prefs, catalog, courseProgress, estimate, now = Date.now()) {
    const [from, until] = bounds(prefs.wakeTime, prefs.bedTime);
    const date = dateKey(now);
    const noStudy = new Set(prefs.restDays);
    const length = prefs.blockMinutes * minute;
    const rest = prefs.breakMinutes * minute;
    const weekEnd = wallTime(moveDate(date, 7), '00:00');
    const classHours = fixed.reduce((sum, event) => sum + (event.allDay ? 0 :
      Math.max(0, Math.min(weekEnd, event.end) - Math.max(now, event.start)) / (60 * minute)), 0);
    const load = estimate(prefs.weeklyWorkHours, classHours, catalog.length);
    const target = prefs.autoAdjustStudy ? load.recommendedStudyHours : prefs.targetStudyHours;
    const perWeek = Math.max(0, Math.floor((target * 60 + 1e-6) / prefs.blockMinutes));
    const out = fixed.map(event => ({ ...block(event.uid, event.summary, event.start, event.end,
      /\b(exam|eksamen|midterm)\b/i.test(event.summary) ? 'exam' : 'class_session',
      courseFor(event.summary, catalog)?.courseId), allDay: event.allDay }));
    const activeDays = 7 - noStudy.size;
    let studyCount = 0;
    let placed = 0;
    const scores = new Map();
    const topicCursor = new Map();

    for (let index = 0; index < 14 && activeDays > 0; index++) {
      if (index === 7) placed = 0;
      const current = moveDate(date, index);
      if (noStudy.has((new Date(current).getUTCDay() + 6) % 7)) continue;
      const candidates = catalog.filter(course => !course.examInfo?.date || course.examInfo.date >= current);
      if (!candidates.length) continue;
      const close = atMinutes(current, until);
      const wakeEpoch = atMinutes(current, Math.max(0, from - 30));
      let start = Math.max(atMinutes(current, Math.min(1440, from)), Math.ceil(now / (15 * minute)) * 15 * minute);
      let today = 0;
      let todayHighMin = 0;
      const cap = Math.ceil(perWeek / activeDays);
      while (start + length <= close && placed < perWeek && today < cap) {
        const conflict = fixed.find(event => start < event.end + rest && start + length + rest > event.start);
        if (conflict) {
          start = Math.ceil((conflict.end + rest) / (5 * minute)) * 5 * minute;
          continue;
        }
        // Circadian DLPFC window relative to student's wake-up time (4.5h / 270m daily High DLPFC cap)
        const hoursAwake = (start - wakeEpoch) / (60 * minute);
        let dlpfcMode = 'low_dlpfc';
        let phaseLabel = 'Low DLPFC · Recall';
        if (hoursAwake < 7.0 && todayHighMin + prefs.blockMinutes <= 270) {
          dlpfcMode = 'high_dlpfc';
          phaseLabel = 'High DLPFC · Synthesis';
        } else if (hoursAwake < 11.0) {
          dlpfcMode = 'med_dlpfc';
          phaseLabel = 'Med DLPFC · Procedural';
        }

        let weightSum = 0;
        for (const course of candidates) {
          const remaining = Math.max(0, 1 - (courseProgress[course.courseId]?.done || 0) / Math.max(1, course.questionCount || 1));
          const days = (Date.parse(course.examInfo?.date) - Date.parse(current)) / day;
          const urgency = days <= 7 ? 2.4 : days <= 14 ? 1.8 : 1;
          const totalQ = Math.max(1, course.questionCount || 1);
          const tierMatch = dlpfcMode === 'high_dlpfc'
            ? 0.85 + 0.55 * (Number(course.highDlpfcCount || 0) / totalQ)
            : dlpfcMode === 'med_dlpfc'
            ? 0.9 + 0.35 * (Number(course.medDlpfcCount || 0) / totalQ)
            : 0.85 + 0.55 * (Number(course.lowDlpfcCount || 0) / totalQ);
          const weight = (prefs.courseWeights[course.courseId] || 1) * (0.45 + 0.75 * remaining) * urgency * tierMatch;
          scores.set(course.courseId, (scores.get(course.courseId) || 0) + weight);
          weightSum += weight;
        }
        const chosen = candidates.reduce((a, b) => scores.get(a.courseId) >= scores.get(b.courseId) ? a : b);
        scores.set(chosen.courseId, scores.get(chosen.courseId) - weightSum);
        if (dlpfcMode === 'high_dlpfc') todayHighMin += prefs.blockMinutes;
        const kind = dlpfcMode === 'low_dlpfc' ? 'recall_sprint' : 'study_block';
        const courseTopics = Array.isArray(chosen.topics) ? chosen.topics.filter((t) => t && t.title) : [];
        let pickedTopic = null;
        if (courseTopics.length) {
          const tIdx = topicCursor.get(chosen.courseId) || 0;
          pickedTopic = courseTopics[tIdx % courseTopics.length];
          topicCursor.set(chosen.courseId, tIdx + 1);
        }
        const topicIds = pickedTopic ? [String(pickedTopic.id)] : [];
        const topicTitle = pickedTopic ? String(pickedTopic.title) : '';
        const cleanSummary = topicTitle || `${chosen.shortTitle || chosen.title} · ${phaseLabel.split(' · ')[1]}`;
        out.push(block(
          `study-${chosen.courseId}-${start}`,
          cleanSummary,
          start,
          start + length,
          kind,
          chosen.courseId,
          dlpfcMode,
          topicIds,
          topicTitle,
        ));
        studyCount++;
        placed++;
        today++;
        start += length + rest;
      }
    }
    return { blocks: out.sort((a, b) => a.startIso.localeCompare(b.startIso)),
      estimate: { ...load, activeTargetStudyHours: target }, studyCount };
  }

  function download(blocks) {
    const escape = value => String(value).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, c => '\\' + c);
    const stamp = time => new Date(time).toISOString().replace(/[-:]|\.\d{3}/g, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Study-OS//Circadian DLPFC Schedule//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Study-OS (DLPFC)'];
    for (const entry of blocks) {
      if (!['study_block', 'recall_sprint'].includes(entry.blockKind) ||
          !Number.isFinite(Date.parse(entry.startIso)) || !Number.isFinite(Date.parse(entry.endIso))) continue;
      const mode = entry.dlpfcMode || (entry.blockKind === 'recall_sprint' ? 'low_dlpfc' : 'med_dlpfc');
      const modeTag = mode === 'high_dlpfc' ? '[High DLPFC]' : mode === 'med_dlpfc' ? '[Med DLPFC]' : '[Low DLPFC]';
      const rawSummary = String(entry.summary || 'Study block').trim();
      const icsSummary = /dlpfc/i.test(rawSummary) ? rawSummary : `${modeTag} ${rawSummary}`;
      const modeDesc = mode === 'high_dlpfc'
        ? 'High DLPFC peak synthesis window (max ~4.5h/day). Take a real 1:5 off-screen break afterward.'
        : mode === 'med_dlpfc'
        ? 'Med DLPFC procedural drills & applied problems. Follow with a 1:5 off-screen break.'
        : 'Low DLPFC wind-down recall, concept checks & spaced-repetition review.';
      const launchUrl = entry.courseId
        ? `https://studyos.no/?course=${encodeURIComponent(entry.courseId)}&autostart=1&dlpfc=${encodeURIComponent(mode)}`
        : 'https://studyos.no/';
      const desc = `${modeDesc}\nStart directly in Study-OS: ${launchUrl}`;
      lines.push('BEGIN:VEVENT', `UID:${String(entry.eventId).replace(/[^\w.-]/g, '-')}@studyos.no`,
        `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(entry.startIso)}`, `DTEND:${stamp(entry.endIso)}`,
        `SUMMARY:${escape(icsSummary)}`,
        `DESCRIPTION:${escape(desc)}`, 'END:VEVENT');
    }
    if (lines.length <= 5) throw new Error('Generate or import study blocks before exporting.');
    lines.push('END:VCALENDAR', '');
    const encoder = new TextEncoder();
    const content = lines.map(line => {
      let out = '', size = 0;
      for (const character of line) {
        const width = encoder.encode(character).length;
        if (size + width > 75) { out += '\r\n '; size = 1; }
        out += character;
        size += width;
      }
      return out;
    }).join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'study-os.ics';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { bounds, download, importStudyPlan, plan, readCalendar };
})();
