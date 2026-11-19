/* Study-OS Main Application Controller:
 * - View 1: Command Center (Zero-Decision-Fatigue Calendar Hero + 5 Course Cards)
 * - View 2: Exam Simulator Hub (All 5 Subjects · WISEflow FLOWmulti ±2% & Past Papers)
 * - View 3: Course Explorer & Bulk Task Manager (Mark Uncomplete, Filter, FLOWmulti filter)
 * - View 4: Metrics, Subgroups, Correlations & Copyable AI Coach Brief
 */
'use strict';

window.StudyApp = (() => {
  const { esc, examLabel, clockSec, minLabel, toast, openReferenceDrawer, bindGlobalChrome } = window.StudyUI;

  let boot = {
    mode: 'local',
    catalog: [],
    references: [],
    canvasArchive: { connected: false, courses: [], unimportedCount: 0 },
    scheduleConfig: { enabled: false, prefs: {} },
    progress: { records: {} },
    calendar: { blocks: [] },
    analytics: {},
    recentSessions: [],
  };
  const bankCache = {};
  const staticRefCache = {};
  const isStaticWeb = document.documentElement.dataset.studyMode === 'web';
  const members = window.StudyMembers;
  const WEB_STATE_KEY = 'study-os-web-state-v1';
  let offlineStatus = navigator.serviceWorker?.controller ? 'Saved for offline' : '';

  let currentView = 'home';
  let openCanvasSync;
  let selectedCourseId = '';
  let selectedSemester = 'all';
  let selectedRefFile = '';
  let selectedRefSemester = 'all';
  let selectedExamStyle = 'blind'; // 'blind' (Strict WISEflow Sit) | 'guided' (Instant Section Check)
  let sessionFocusMode = (() => {
    let saved = 'auto';
    try {
      saved = sessionStorage.getItem('study-os-focus-mode') || saved;
    } catch {}
    if (saved === 'deep') return 'high_dlpfc';
    if (saved === 'balanced') return 'med_dlpfc';
    if (saved === 'light') return 'low_dlpfc';
    return ['auto', 'high_dlpfc', 'med_dlpfc', 'low_dlpfc'].includes(saved) ? saved : 'auto';
  })();
  const pendingDrafts = new Map();

  const HIGH_DLPFC_CAP_MIN = 270; // 4.5h/day max-intensity novel synthesis budget

  function getCircadianAutoTarget() {
    const hr = new Date().getHours();
    const usedHighMin = Number(boot.analytics?.dlpfcBudget?.todayHighMinutes || 0);
    if (hr >= 6 && hr < 15) {
      if (usedHighMin >= HIGH_DLPFC_CAP_MIN) {
        return {
          mode: 'med_dlpfc',
          windowLabel: 'Pre-15:00 · 4.5h Cap Reached',
          explain: `4.5h Hard novel cap reached (${(usedHighMin / 60).toFixed(1)}h) — auto-downshifted to Medium procedural drills.`,
        };
      }
      return {
        mode: 'high_dlpfc',
        windowLabel: '08:00–15:00 Peak Capacity Window',
        explain: 'Hard · Multi-step Active — Prioritizes unseen derivations, cases & multi-box problems (interleaved across topics).',
      };
    }
    if (hr >= 15 && hr < 18) {
      return {
        mode: 'med_dlpfc',
        windowLabel: '15:00–18:00 Procedural Window',
        explain: 'Medium · Standard practice Active — Prioritizes standard drills & chunked mastered problems without heavy prefrontal strain.',
      };
    }
    return {
      mode: 'low_dlpfc',
      windowLabel: 'Evening Consolidation Window',
      explain: 'Easy · Recall Active — Prioritizes fast FSRS spaced reviews, conceptual MCQs & low-friction recall.',
    };
  }

  function getResolvedFocusMode() {
    if (sessionFocusMode === 'auto') {
      return getCircadianAutoTarget().mode;
    }
    return sessionFocusMode;
  }

  function setSessionFocusMode(mode) {
    sessionFocusMode = mode;
    try {
      sessionStorage.setItem('study-os-focus-mode', mode);
    } catch {}
    if (currentView === 'home') renderHome();
  }

  async function apiGet(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function apiPost(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function getProgressRecord(qid) {
    return boot.progress?.records?.[qid] || null;
  }

  function effectiveDifficulty(q, rec = getProgressRecord(q?.id) || {}) {
    const authored = Number(q?.difficulty || 2);
    if (rec?.personalDifficulty && [1, 2, 3].includes(Number(rec.personalDifficulty))) {
      return Number(rec.personalDifficulty);
    }
    const lastG = rec?.fsrs?.lastGrade;
    if (lastG === 1 || lastG === 2) return Math.min(3, authored + 1);
    if (lastG === 4) return Math.max(1, authored - 1);
    return authored;
  }

  function effectiveDlpfc(q, rec = getProgressRecord(q?.id)) {
    if (!q) return { base: 2, tier: 2, chunked: false };
    const rawBase = Number(q.dlpfcBase);
    const base =
      [1, 2, 3].includes(rawBase)
        ? rawBase
        : q.kind === 'mcq'
        ? Number(q.difficulty || 1) >= 3
          ? 2
          : 1
        : Number(q.difficulty || 2) >= 3 || (q.wiseflowFields || []).length >= 4
        ? 3
        : 2;

    if (!rec) return { base, tier: base, chunked: false };
    const st = rec.status || 'not_started';
    const pDiff = Number(rec.personalDifficulty || 0);
    const fsrs = rec.fsrs || {};
    const lastG = fsrs.lastGrade != null ? Number(fsrs.lastGrade) : null;
    const reps = Number(fsrs.reps || 0);
    const stab = Number(fsrs.stability || 0);

    if (pDiff === 3 || st === 'revisit' || lastG === 1) {
      const escalated = Math.min(3, Math.max(base, q.kind === 'mcq' ? 2 : 3));
      return { base, tier: escalated, chunked: false };
    }
    if (st === 'done' && (lastG === null || lastG >= 3)) {
      if (pDiff === 1 || (reps >= 2 && stab >= 5.0)) {
        return { base, tier: 1, chunked: base > 1 };
      }
      if (base === 3 && reps >= 1) {
        return { base, tier: 2, chunked: true };
      }
    }
    return { base, tier: base, chunked: false };
  }

  function loadWebState() {
    try {
      const raw = JSON.parse(localStorage.getItem(WEB_STATE_KEY) || '{}');
      return {
        records: raw.records || {},
        attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
        customSchedule: raw.customSchedule || { enabled: false, prefs: {}, blocks: [] },
      };
    } catch {
      return { records: {}, attempts: [], sessions: [], customSchedule: { enabled: false, prefs: {}, blocks: [] } };
    }
  }

  function saveWebState(st) {
    try {
      localStorage.setItem(WEB_STATE_KEY, JSON.stringify(st));
      return true;
    } catch {
      toast('This browser could not save your progress. Check its storage settings.');
      return false;
    }
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function backupTime(value) {
    return typeof value === 'string' ? Date.parse(value) || 0 : 0;
  }

  function restoreWebBackup(data) {
    const incomingRecords = data?.progress?.records ?? data?.records;
    if (!isRecord(incomingRecords)) throw new Error('Choose a Study-OS progress backup.');

    const ws = loadWebState();
    const incomingAttempts = Array.isArray(data.attempts) ? data.attempts.filter((row) =>
      isRecord(row) && typeof row.questionId === 'string' && backupTime(row.timestamp)
    ) : [];
    const incomingSessions = Array.isArray(data.sessions) ? data.sessions.filter((row) =>
      isRecord(row) && typeof row.sessionId === 'string' && backupTime(row.endedAt)
    ) : [];
    const lastAttempt = (attempts) => {
      const times = new Map();
      for (const row of attempts) {
        times.set(row.questionId, Math.max(times.get(row.questionId) || 0, backupTime(row.timestamp)));
      }
      return times;
    };
    const existingTimes = lastAttempt(ws.attempts);
    const incomingTimes = lastAttempt(incomingAttempts);
    const timeOf = (record, attemptTime) => Math.max(
      backupTime(record.updatedAt), backupTime(record.lastAttemptAt), attemptTime || 0
    );
    const mergedRecords = new Map(Object.entries(ws.records));
    let changed = 0;
    for (const [qid, incoming] of Object.entries(incomingRecords)) {
      if (!qid.includes(':') || !isRecord(incoming)) continue;
      const existing = mergedRecords.get(qid);
      if (!existing || timeOf(incoming, incomingTimes.get(qid)) > timeOf(existing, existingTimes.get(qid))) {
        mergedRecords.set(qid, incoming);
        changed++;
      }
    }
    ws.records = Object.fromEntries(mergedRecords);

    function mergeHistory(existing, incoming, timeKey, identity) {
      const unique = new Map(existing.map((row) => [identity(row), row]));
      for (const row of incoming) {
        const id = identity(row);
        if (!unique.has(id)) unique.set(id, row);
      }
      return [...unique.values()].sort((a, b) => backupTime(a[timeKey]) - backupTime(b[timeKey]));
    }

    const originalAttemptCount = ws.attempts.length;
    const originalSessionCount = ws.sessions.length;
    ws.attempts = mergeHistory(ws.attempts, incomingAttempts, 'timestamp', (row) =>
      JSON.stringify([row.questionId, row.sessionId || '', backupTime(row.timestamp)])
    );
    ws.sessions = mergeHistory(ws.sessions, incomingSessions, 'endedAt', (row) => row.sessionId);

    const schedule = data.customSchedule;
    const currentSchedule = ws.customSchedule;
    const scheduleChanged = isRecord(schedule) && typeof schedule.enabled === 'boolean'
      && isRecord(schedule.prefs) && Array.isArray(schedule.blocks) && schedule.blocks.every(isRecord)
      && ((!currentSchedule.enabled && !currentSchedule.updatedAt)
        || backupTime(schedule.updatedAt) > backupTime(currentSchedule.updatedAt));
    if (scheduleChanged) ws.customSchedule = schedule;
    if (!saveWebState(ws)) return '';

    const restored = [
      changed ? `${changed} progress records` : '',
      ws.attempts.length > originalAttemptCount ? `${ws.attempts.length - originalAttemptCount} attempts` : '',
      ws.sessions.length > originalSessionCount ? `${ws.sessions.length - originalSessionCount} sessions` : '',
      scheduleChanged ? 'your schedule' : '',
    ].filter(Boolean);
    return restored.length ? `Restored ${restored.join(', ')}.` : 'This backup contains no newer study data.';
  }

  function recomputeWebAnalytics() {
    const ws = loadWebState();
    const records = ws.records || {};
    const attempts = ws.attempts || [];
    const courseProgress = {};
    for (const c of boot.catalog || []) {
      courseProgress[c.courseId] = { total: c.questionCount || 0, done: 0, revisit: 0, in_progress: 0, dueFsrs: 0 };
    }
    const nowIso = new Date().toISOString();
    for (const [qid, rec] of Object.entries(records)) {
      const cid = qid.split(':')[0];
      if (!courseProgress[cid]) continue;
      if (rec.status === 'done') courseProgress[cid].done++;
      else if (rec.status === 'revisit') courseProgress[cid].revisit++;
      else if (rec.status === 'in_progress') courseProgress[cid].in_progress++;
      if (rec.fsrs?.due && rec.fsrs.due <= nowIso) courseProgress[cid].dueFsrs++;
    }
    const n = attempts.length;
    const avgAcc = n ? attempts.reduce((s, a) => s + Number(a.qualityAccuracy || 0), 0) / n : null;
    const beatRate = n ? attempts.filter((a) => a.beatAi).length / n : null;
    const avgPr = n ? attempts.reduce((s, a) => s + Math.min(1.35, Number(a.paceRatio || 0.85)), 0) / n : null;
    const upi = n ? Math.round(100 * (0.45 * avgAcc + 0.35 * avgPr + 0.2 * 0.9)) : null;
    const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' });
    const today = dayFormat.format(new Date());
    const isToday = (timestamp) => {
      const date = new Date(timestamp);
      return !Number.isNaN(date.getTime()) && dayFormat.format(date) === today;
    };
    const todayAttempts = attempts.filter((a) => isToday(a.timestamp));
    const todayMin = Math.round(todayAttempts.reduce((s, a) => s + Number(a.activeSec || 0), 0) / 60);
    const minutesAtTier = (tier) => todayAttempts.reduce((sum, attempt) =>
      sum + (Number(attempt.dlpfcTier) === tier ? Number(attempt.activeSec || 0) : 0), 0) / 60;
    const todayHighMinutes = minutesAtTier(3);
    const todaySessions = ws.sessions.filter((session) => isToday(session.endedAt));

    boot.progress = { records };
    boot.recentSessions = (ws.sessions || []).slice(-25).reverse();
    boot.analytics = {
      totalAttempts: n,
      totalSessions: (ws.sessions || []).length,
      totalXp: n * 20,
      streakDays: todayAttempts.length ? 1 : 0,
      overall: { count: n, avgAccuracy: avgAcc, beatAiRate: beatRate, upi },
      last7Days: { upi, totalActiveMinutes: todayMin },
      today: { count: todayAttempts.length, totalActiveMinutes: todayMin },
      dlpfcBudget: {
        todayHighMinutes,
        todayMedMinutes: minutesAtTier(2),
        remainingHighMinutes: Math.max(0, 270 - todayHighMinutes),
        todayAwayMinutes: todaySessions.reduce((sum, session) => sum + Number(session.awaySec || 0), 0) / 60,
        todayFocusSwitches: todaySessions.reduce((sum, session) => sum + Number(session.focusSwitchCount || 0), 0),
      },
      courseProgress,
      subgroups: { byCourse: {}, byDlpfcTier: {}, byKind: {}, byTimeSlot: {} },
    };
    if (ws.customSchedule?.enabled && ws.customSchedule.blocks?.length) {
      boot.calendar = {
        updatedAt: ws.customSchedule.updatedAt || nowIso,
        source: ws.customSchedule.source || 'browser_schedule',
        estimate: ws.customSchedule.estimate || null,
        blocks: ws.customSchedule.blocks,
      };
      boot.scheduleConfig = {
        enabled: true,
        source: ws.customSchedule.source || 'browser_schedule',
        prefs: ws.customSchedule.prefs || {},
        estimate: ws.customSchedule.estimate || null,
      };
    }
  }

  function isStaticMode() {
    return isStaticWeb;
  }

  function communityStats() {
    const state = loadWebState();
    const attempts = state.attempts;
    return {
      minutes: Math.round(attempts.reduce((total, attempt) => total + (Number(attempt.activeSec) || 0), 0) / 60),
      completed: Object.values(state.records).filter((record) => record.status === 'done').length,
      attempts: attempts.length,
      accuracy: attempts.length
        ? Math.round(100 * attempts.reduce((total, attempt) => total + (Number(attempt.qualityAccuracy) || 0), 0) / attempts.length)
        : 0,
    };
  }

  function findPublicReference(file) {
    for (const entry of boot.references) {
      for (const note of [entry, ...(entry.companions || [])]) {
        if (note.file.replace(/\.md$/i, '') === file.replace(/\.md$/i, '')) {
          return { entry, file: note.file };
        }
      }
    }
    return null;
  }

  function publicReferenceUrl(file, heading = '') {
    if (!findPublicReference(file)) return '';
    return `?${new URLSearchParams({ view: 'references', note: file, section: heading })}`;
  }

  async function ensureCourseBank(courseId) {
    if (bankCache[courseId]) return bankCache[courseId];
    if (isStaticWeb && members.course(courseId)) {
      const bank = await members.loadBank(courseId);
      bankCache[courseId] = bank;
      return bank;
    }
    const url = isStaticWeb
      ? `./static-data/courses/${encodeURIComponent(courseId)}.json`
      : `/api/course/${encodeURIComponent(courseId)}`;
    const bank = await apiGet(url);
    bankCache[courseId] = bank;
    return bank;
  }

  function refSlug(relFile) {
    return String(relFile || '')
      .replace(/\.md$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  async function fetchReferenceSection(relFile, heading = '') {
    if (!isStaticWeb) {
      return apiGet(`/api/obsidian/section?file=${encodeURIComponent(relFile)}&heading=${encodeURIComponent(heading || '')}`);
    }
    const slug = refSlug(relFile);
    if (!findPublicReference(relFile)) {
      return { available: false, error: 'This source is available in the local archive or through your course.' };
    }
    if (!staticRefCache[slug]) {
      staticRefCache[slug] = await apiGet(`./static-data/references/${encodeURIComponent(slug)}.json`);
    }
    const doc = staticRefCache[slug];
    if (!doc || !doc.markdown) {
      return { available: false, error: 'Reference sheet not bundled in this web build.' };
    }
    if (!heading) {
      return { available: true, markdown: doc.markdown, toc: doc.toc || [], selectedHeading: '', obsidianUri: '' };
    }
    const lines = doc.markdown.split('\n');
    const qNorm = heading.trim().toLowerCase().replace(/^#+\s*/, '');
    const toc = doc.toc || [];
    const match = toc.find((h) => h.title.toLowerCase() === qNorm) || toc.find((h) => {
      const hNorm = h.title.toLowerCase();
      return hNorm.includes(qNorm) || (hNorm.length >= 10 && qNorm.includes(hNorm));
    });
    if (!match) {
      return { available: true, markdown: doc.markdown, toc: doc.toc || [], selectedHeading: '', obsidianUri: '' };
    }
    let endIdx = lines.length;
    for (const h of toc) {
      if (h.line > match.line && h.level <= match.level) {
        endIdx = h.line;
        break;
      }
    }
    return {
      available: true,
      markdown: lines.slice(match.line, endIdx).join('\n'),
      toc,
      selectedHeading: match.title,
      obsidianUri: '',
    };
  }

  async function refreshBootstrap(forceCalendar = false) {
    if (isStaticWeb) {
      boot = await apiGet('./static-data/bootstrap.json');
      if (members.isUnlocked()) {
        boot.catalog = boot.catalog.map((entry) => ({
          ...entry, ...members.course(entry.courseId)?.catalog,
        }));
        for (const ref of boot.references) {
          const course = members.course(ref.courseId);
          if (course) ref.questionCount = course.catalog.questionCount;
        }
      }
      recomputeWebAnalytics();
    } else {
      boot = await apiGet(`/api/bootstrap${forceCalendar ? '?refresh_calendar=1' : ''}`);
    }
    if (!selectedCourseId && boot.catalog.length) {
      selectedCourseId = boot.catalog[0].courseId;
    }
    if (!selectedRefFile && (boot.references || []).length) {
      selectedRefFile = boot.references[0].file;
    }
    window.StudyUI.workClock?.syncBackendToday?.(
      boot.analytics?.today?.totalActiveMinutes || 0,
      boot.analytics?.dlpfcBudget?.todayAwayMinutes || 0
    );
    updateHeaderStats();
    if (currentView === 'home') renderHome();
    else if (currentView === 'references') await renderReferencesHub();
    else if (currentView === 'schedule') renderScheduleStudio();
    else if (currentView === 'exams') renderExamsHub();
    else if (currentView === 'course') await renderCourseExplorer(selectedCourseId);
    else if (currentView === 'analytics') renderAnalytics();
  }

  function updateHeaderStats() {
    const a = boot.analytics || {};
    const upi = a.overall?.upi;
    document.getElementById('hdr-upi').textContent = upi != null ? String(upi) : '—';
    document.getElementById('hdr-streak').textContent = `${a.streakDays || 0}d`;
    document.getElementById('hdr-xp').textContent = `${a.totalXp || 0} XP`;
  }

  function showRawView(name) {
    for (const v of ['home', 'references', 'schedule', 'exams', 'course', 'runner', 'analytics', 'community', 'room']) {
      const sec = document.getElementById(`view-${v}`);
      if (sec) sec.hidden = v !== name;
    }
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.nav === name);
      if (b.dataset.nav === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  async function navigate(viewName, opts = {}) {
    currentView = viewName;
    if (opts.courseId) selectedCourseId = opts.courseId;
    if (opts.refFile) selectedRefFile = opts.refFile;
    showRawView(viewName);
    if (viewName === 'home') renderHome();
    else if (viewName === 'references') await renderReferencesHub(opts.refDoc, opts.heading);
    else if (viewName === 'schedule') renderScheduleStudio();
    else if (viewName === 'exams') {
      renderExamsHub(opts.focusCourseId || '');
    } else if (viewName === 'course') await renderCourseExplorer(selectedCourseId, opts.preset || '');
    else if (viewName === 'analytics') renderAnalytics();
    else if (viewName === 'community') await window.StudyCommunity.render();
    else if (viewName === 'room') await window.StudyRooms.render();
  }

  function daysUntilDateStr(isoDate) {
    if (!isoDate || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return null;
    const now = new Date();
    const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
    const targetUtc = Date.UTC(y, m - 1, d);
    return Math.round((targetUtc - todayUtc) / 86400000);
  }

  // ---------------------------------------------------------------------------
  // VIEW 1: COMMAND CENTER (Zero-Decision-Fatigue Calendar Hero + Courses Grid)
  // ---------------------------------------------------------------------------
  function renderHome() {
    document.getElementById('btn-refresh-cal').hidden = isStaticWeb;
    const memberButton = document.getElementById('btn-member-library');
    memberButton.hidden = !members.enabled;
    memberButton.textContent = members.isUnlocked() ? 'Lock full library' : 'Unlock full library';
    document.getElementById('home-metrics-strip').hidden = isStaticWeb && !boot.analytics.totalAttempts;
    // 1. Paused Run Banner
    const paused = window.StudyRunner.getRun();
    const resumeEl = document.getElementById('resume-banner');
    if (paused) {
      resumeEl.hidden = false;
      resumeEl.innerHTML = `
        <div>
          <strong>Active Run Open:</strong> ${esc(paused.courseMeta.title)} (${paused.index + 1} of ${paused.questionIds.length})
        </div>
        <button type="button" class="primary-btn" id="btn-resume-paused">Resume Run →</button>
      `;
      document.getElementById('btn-resume-paused').onclick = () => window.StudyRunner.resumePausedRun();
    } else {
      resumeEl.hidden = true;
    }

    // 2. Circadian Difficulty Bar + Zero-Decision-Fatigue Google Calendar Hero
    const resolvedFocus = getResolvedFocusMode();
    const autoTarget = getCircadianAutoTarget();
    const focusExplain =
      sessionFocusMode === 'auto'
        ? autoTarget.explain
        : resolvedFocus === 'high_dlpfc'
        ? 'Hard · Multi-step Override — Excludes Easy recall and interleaves novel multi-step problems.'
        : resolvedFocus === 'med_dlpfc'
        ? 'Medium · Standard practice Override — Prioritizes standard calculation drills & mastered chunked exercises.'
        : 'Easy · Recall Override — Prioritizes fast FSRS spaced reviews & recognition MCQs.';

    const autoShort =
      autoTarget.mode === 'high_dlpfc' ? 'Hard' : autoTarget.mode === 'med_dlpfc' ? 'Medium' : 'Easy';

    const focusBarHtml = `
      <div class="focus-mode-bar ${resolvedFocus === 'high_dlpfc' ? 'pre15-active' : ''}">
        <div>
          <span class="eyebrow" style="margin:0">${esc(autoTarget.windowLabel)}</span>
          <div style="font-size:13.5px;font-weight:600;margin-top:2px">${esc(focusExplain)}</div>
        </div>
        <div class="focus-mode-pills" role="group" aria-label="Session difficulty">
          <button type="button" class="preset-chip ${sessionFocusMode === 'auto' ? 'active' : ''}" data-focus-mode="auto">
            Auto (${autoShort})
          </button>
          <button type="button" class="preset-chip ${sessionFocusMode === 'high_dlpfc' ? 'active' : ''}" data-focus-mode="high_dlpfc">
            Hard (&lt;15:00)
          </button>
          <button type="button" class="preset-chip ${sessionFocusMode === 'med_dlpfc' ? 'active' : ''}" data-focus-mode="med_dlpfc">
            Medium (15–18)
          </button>
          <button type="button" class="preset-chip ${sessionFocusMode === 'low_dlpfc' ? 'active' : ''}" data-focus-mode="low_dlpfc">
            Easy (Eve)
          </button>
        </div>
      </div>
    `;

    const heroEl = document.getElementById('up-next-hero');
    const blocks = (boot.calendar?.blocks || []).filter(
      (b) => b.timingState !== 'past' && (b.blockKind === 'study_block' || b.blockKind === 'recall_sprint') && !b.completed
    );
    const primary = blocks[0];
    const nextStrip = blocks.slice(1, 5);

    if (primary && primary.courseId) {
      const cMeta = boot.catalog.find((c) => c.courseId === primary.courseId);
      const qCount = primary.autoQueue?.questionIds?.length || 0;
      const liveBadge =
        primary.timingState === 'live_now'
          ? '<span class="badge live">LIVE NOW</span>'
          : `<span class="badge">UP NEXT · ${esc(primary.date)} ${esc(primary.startLabel)}–${esc(primary.endLabel)}</span>`;
      const modeNote =
        sessionFocusMode !== 'auto'
          ? `Mode: ${resolvedFocus === 'high_dlpfc' ? 'Hard · Multi-step' : resolvedFocus === 'low_dlpfc' ? 'Easy · Recall' : 'Medium · Standard practice'}`
          : primary.autoQueue?.strategy || `${primary.focusMinutes}m block`;

      heroEl.innerHTML = `
        ${focusBarHtml}
        <div class="hero-top">
          <div style="flex:1;min-width:260px">
            <span class="eyebrow">Scheduled Queue</span>
            <h1 class="hero-title">${esc(primary.summary)}</h1>
            <div class="hero-meta">
              ${liveBadge}
              ${primary.location ? `<span class="badge">${esc(primary.location)}</span>` : ''}
              <span class="badge gold">${esc(modeNote)}</span>
            </div>
            ${primary.focusNote ? `<p class="muted" style="max-width:780px;font-size:14px">${esc(primary.focusNote)}</p>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;min-width:240px">
            <button type="button" class="primary-btn btn-lg" id="btn-launch-hero" ${qCount ? '' : 'disabled'}>
              Start ${primary.focusMinutes}m ${resolvedFocus === 'high_dlpfc' ? 'Hard ' : ''}Run →
            </button>
            <div class="row-actions" style="gap:6px">
              ${
                cMeta
                  ? `<button type="button" class="ghost-btn" style="flex:1" id="btn-hero-deep-filter">Hard practice</button>
                     <button type="button" class="ghost-btn" style="flex:1" id="btn-hero-ref">${esc(cMeta.shortTitle)} Ref</button>`
                  : ''
              }
            </div>
          </div>
        </div>
        ${
          nextStrip.length
            ? `<div class="schedule-strip">
                ${nextStrip
                  .map(
                    (b) => `<div class="sched-mini">
                      <div>
                        <small>${esc(b.date)} · ${esc(b.startLabel)}–${esc(b.endLabel)}</small>
                        <strong>${esc(b.summary)}</strong>
                      </div>
                      <div class="row-between" style="margin:4px 0 0">
                        <small>${b.autoQueue?.questionIds?.length || 0} queued${b.autoQueue?.cognitiveMode === 'high_dlpfc' ? ' · Hard' : b.autoQueue?.cognitiveMode === 'med_dlpfc' ? ' · Med' : ''}</small>
                        ${
                          b.courseId
                            ? `<button type="button" class="ghost-btn" style="padding:4px 9px;font-size:12px" data-launch-event="${esc(b.eventId)}">Start →</button>`
                            : ''
                        }
                      </div>
                    </div>`
                  )
                  .join('')}
              </div>`
            : ''
        }
      `;

      document.getElementById('btn-launch-hero')?.addEventListener('click', () => launchCalendarBlock(primary));
      document.getElementById('btn-hero-deep-filter')?.addEventListener('click', () =>
        navigate('course', { courseId: primary.courseId, preset: 'high_dlpfc' })
      );
      document.getElementById('btn-hero-ref')?.addEventListener('click', () => openReferenceDrawer(cMeta));
      heroEl.querySelectorAll('[data-launch-event]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const blk = (boot.calendar?.blocks || []).find((x) => x.eventId === btn.dataset.launchEvent);
          if (blk) launchCalendarBlock(blk);
        });
      });
    } else if (isStaticWeb) {
      const questionCount = boot.catalog.reduce((count, c) => count + c.questionCount, 0);
      heroEl.innerHTML = `
        <div class="hero-top">
          <div>
            <h1 class="hero-title">Study by subject</h1>
            <p class="muted">${boot.catalog.length} subjects and ${questionCount} practice questions with hints, worked answers and course notes.</p>
          </div>
          <div class="row-actions">
            <button type="button" class="primary-btn" id="btn-web-refs">Browse course notes</button>
            <button type="button" class="ghost-btn" id="btn-web-exams">Mock exams</button>
          </div>
        </div>`;
      document.getElementById('btn-web-refs').onclick = () => navigate('references');
      document.getElementById('btn-web-exams').onclick = () => navigate('exams');
    } else {
      heroEl.innerHTML = `
        ${focusBarHtml}
        <div class="hero-top">
          <div>
            <span class="eyebrow">Ready to Practice</span>
            <h1 class="hero-title">Pick a course below, launch an Interleaved Run, or sync Google Calendar</h1>
            <p class="muted">Choose a subject or let Study-OS build a practice session from your question bank.</p>
          </div>
          <div class="row-actions">
            <button type="button" class="primary-btn btn-lg" id="btn-hero-smart">${
              resolvedFocus === 'high_dlpfc' ? 'Start 45m Hard Run' : resolvedFocus === 'low_dlpfc' ? 'Start 25m Recall Run' : 'Start 40m Procedural Run'
            }</button>
            <button type="button" class="ghost-btn btn-lg" id="btn-hero-exams">Exam Simulator</button>
          </div>
        </div>
      `;
      document.getElementById('btn-hero-smart')?.addEventListener('click', () => {
        if (boot.catalog[0]) {
          const m = getResolvedFocusMode();
          launchSmartCourseRun(boot.catalog[0].courseId, m === 'high_dlpfc' ? 45 : m === 'low_dlpfc' ? 25 : 40, 'learning', '', m);
        }
      });
      document.getElementById('btn-hero-exams')?.addEventListener('click', () => navigate('exams'));
    }

    heroEl.querySelectorAll('[data-focus-mode]').forEach((btn) => {
      btn.addEventListener('click', () => setSessionFocusMode(btn.dataset.focusMode));
    });

    // 3. Global Metrics Strip
    const a = boot.analytics || {};
    const ov = a.overall || {};
    const db = a.dlpfcBudget || {};
    const highMin = Number(db.todayHighMinutes || 0);
    const medMin = Number(db.todayMedMinutes || 0);
    const focusSwitches = Number(db.todayFocusSwitches || 0);
    const totalDue = Object.values(a.courseProgress || {}).reduce((s, c) => s + (c.dueFsrs || 0), 0);
    const totalRevisit = Object.values(a.courseProgress || {}).reduce((s, c) => s + (c.revisit || 0), 0);
    const totalDone = Object.values(a.courseProgress || {}).reduce((s, c) => s + (c.done || 0), 0);
    const totalItems = Object.values(a.courseProgress || {}).reduce((s, c) => s + (c.total || 0), 0);

    document.getElementById('home-metrics-strip').innerHTML = `
      <div class="metric-tile" data-layout-performance>
        <small>Universal Productivity (UPI)</small>
        <b>${ov.upi ?? '—'}</b>
        <small>7-day: ${a.last7Days?.upi ?? '—'} · 100 = AI Par @ 100%</small>
      </div>
      <div class="metric-tile" data-layout-performance>
        <small>Beat AI Par Rate</small>
        <b>${ov.beatAiRate != null ? Math.round(ov.beatAiRate * 100) + '%' : '—'}</b>
        <small>Accuracy-gated (${ov.count || 0} attempts)</small>
      </div>
      <div class="metric-tile" data-layout-budget>
        <small>High dlPFC practice budget</small>
        <b>${(highMin / 60).toFixed(1)}h / 4.5h</b>
        <small>${Math.round(highMin)}m High · ${Math.round(medMin)}m Med</small>
      </div>
      <div class="metric-tile">
        <small>Mastery Completion</small>
        <b>${totalDone} / ${totalItems}</b>
        <small>${totalRevisit} revisit · ${totalDue} due FSRS</small>
      </div>
      <div class="metric-tile" data-layout-screen>
        <small>Screen Time Today</small>
        <b id="home-screen-today-val">${esc(window.StudyUI.workClock?.getScreenStats?.()?.screenLabel || `${a.today?.totalActiveMinutes || 0}m`)}</b>
        <small>${a.today?.count || 0} Qs · <span id="home-offscreen-today-val">${esc(window.StudyUI.workClock?.getScreenStats?.()?.offScreenLabel || '0m')}</span> off-screen · ${focusSwitches} sw.</small>
      </div>
    `;

    // 3B. Canvas-Archive Cookie-Session Strip & Fresh-Clone Onboarding
    renderCanvasBridgeStrip();

    // 4. Semester Filter + Courses Grid
    const semesters = [...new Set((boot.catalog || []).map((c) => c.semester).filter(Boolean))];
    const semSel = document.getElementById('home-semester-filter');
    if (semSel) {
      if (semesters.length > 1) {
        semSel.hidden = false;
        semSel.innerHTML =
          `<option value="all">All Semesters (${boot.catalog.length})</option>` +
          semesters.map((s) => `<option value="${esc(s)}" ${selectedSemester === s ? 'selected' : ''}>${esc(s)}</option>`).join('');
        semSel.onchange = () => {
          selectedSemester = semSel.value;
          renderHome();
        };
      } else {
        semSel.hidden = true;
      }
    }

    const visibleCourses =
      selectedSemester === 'all' ? boot.catalog : boot.catalog.filter((c) => c.semester === selectedSemester);

    const grid = document.getElementById('courses-grid');
    grid.innerHTML = visibleCourses
      .map((c) => {
        const cp = a.courseProgress?.[c.courseId] || { total: c.questionCount, done: 0, revisit: 0, in_progress: 0, dueFsrs: 0 };
        const cm = a.subgroups?.byCourse?.[c.courseId] || {};
        const pct = Math.round((cp.done / Math.max(1, cp.total)) * 100);
        const daysLeft = daysUntilDateStr(c.examInfo?.date);
        const examBadge = c.examInfo?.date
          ? `<span class="badge ${daysLeft !== null && daysLeft >= 0 && daysLeft <= 14 ? 'warn' : ''}">Exam ${esc(c.examInfo.date)}${
              daysLeft !== null && daysLeft >= 0 ? ` (${daysLeft}d)` : ''
            }</span>`
          : '';

        return `<article class="course-card">
          <div>
            <div class="row-between" style="margin:0 0 4px">
              <span class="eyebrow" style="color:${esc(c.color)}">${esc(c.code)}${semesters.length > 1 && c.semester ? ` · ${esc(c.semester)}` : ''}</span>
              <div class="row-actions">${examBadge}</div>
            </div>
            <h3>${esc(c.title)}</h3>
            <div class="course-bar"><div class="course-bar-fill" style="width:${pct}%;background:${esc(c.color)}"></div></div>
            <div class="course-stats-row">
              <span><b>${cp.done}</b>/${cp.total} done (${pct}%)</span>
              ${isStaticWeb ? '' : `<span>· <b>${c.highDlpfcCount ?? c.writtenOrCalcCount ?? 0}</b> Hard</span>`}
              <span>· <b>${cp.revisit}</b> revisit</span>
              <span>· UPI <b>${cm.upi ?? '—'}</b></span>
            </div>
          </div>
          <div class="course-actions">
            <button type="button" class="primary-btn" data-smart-course="${esc(c.courseId)}">${
              isStaticWeb ? 'Quick practice' : resolvedFocus === 'high_dlpfc' ? 'Hard 45m' : resolvedFocus === 'low_dlpfc' ? 'Recall 25m' : 'Procedural 40m'
            }</button>
            ${isStaticWeb ? '' : `<button type="button" class="ghost-btn" data-deep-course="${esc(c.courseId)}" title="Filter to Hard · Multi-step tasks">Hard</button>`}
            <button type="button" class="ghost-btn" data-open-course="${esc(c.courseId)}">${isStaticWeb ? 'Topics &amp; practice' : `All (${c.questionCount})`}</button>
            <button type="button" class="ghost-btn" data-exam-course="${esc(c.courseId)}">Exams</button>
            <button type="button" class="ghost-btn" data-ref-course="${esc(c.courseId)}">Notes</button>
          </div>
        </article>`;
      })
      .join('');

    grid.querySelectorAll('[data-smart-course]').forEach((b) => {
      const m = getResolvedFocusMode();
      const mins = m === 'high_dlpfc' ? 45 : m === 'low_dlpfc' ? 25 : 40;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await launchSmartCourseRun(b.dataset.smartCourse, isStaticWeb ? 10 : mins, 'learning', '', m, isStaticWeb);
        } catch {
          toast('Could not load this course. Check your connection and try again.');
        } finally {
          b.disabled = false;
        }
      });
    });
    grid.querySelectorAll('[data-deep-course]').forEach((b) => {
      b.addEventListener('click', () => navigate('course', { courseId: b.dataset.deepCourse, preset: 'high_dlpfc' }));
    });
    grid.querySelectorAll('[data-exam-course]').forEach((b) => {
      b.addEventListener('click', () => navigate('exams', { focusCourseId: b.dataset.examCourse }));
    });
    grid.querySelectorAll('[data-open-course]').forEach((b) => {
      b.addEventListener('click', () => navigate('course', { courseId: b.dataset.openCourse }));
    });
    grid.querySelectorAll('[data-ref-course]').forEach((b) => {
      b.addEventListener('click', () => {
        const cm = boot.catalog.find((x) => x.courseId === b.dataset.refCourse);
        if (cm) openReferenceDrawer(cm);
      });
    });
  }

  function renderCanvasBridgeStrip() {
    const strip = document.getElementById('canvas-bridge-strip');
    if (!strip) return;

    if (isStaticWeb) {
      strip.innerHTML = `
        <div class="canvas-connect-bar">
          <div>
            <strong>Study offline</strong>
            <small class="muted">Save the notes and questions to this browser. Use its Install app or Add to Home Screen option if you want an icon on your device.</small>
            <small id="offline-status" role="status">${esc(offlineStatus)}</small>
          </div>
          <div class="row-actions">
            <button type="button" class="ghost-btn" id="btn-save-offline">${offlineStatus === 'Saved for offline' ? 'Check offline copy' : 'Save for offline'}</button>
            <a class="ghost-btn" href="https://github.com/shadjosef/study-os#desktop-setup" target="_blank" rel="noopener">Desktop setup for Canvas and Obsidian ↗</a>
          </div>
        </div>
      `;
      document.getElementById('btn-save-offline').addEventListener('click', saveForOffline);
      return;
    }

    const ca = boot.canvasArchive || {};
    const syncTime = ca.lastSyncAt ? ca.lastSyncAt.slice(0, 16).replace('T', ' ') : 'not synced yet';
    const unimported = Number(ca.unimportedCount || 0);

    if (!boot.catalog.length) {
      strip.innerHTML = `
        <div class="panel" style="margin-bottom:18px">
          <span class="eyebrow">Plug-and-Play Student Setup</span>
          <h2 style="margin:4px 0 6px">Connect Canvas or try the demo</h2>
          <p class="muted" style="margin:0">Sync your courses and import them from Canvas-Archive to practice with your own course files.</p>
          <div class="onboarding-grid">
            <div class="onboarding-step">
              <div>
                <span class="badge ${ca.connected ? 'live' : ''}">${ca.connected ? 'Connected' : 'Step 1'}</span>
                <h4 style="margin:8px 0 4px">1. Sync Canvas</h4>
                <small class="muted">${
                  ca.connected
                    ? `Found <code>${esc(ca.archivePath)}</code> (${(ca.courses || []).length} folders · last sync ${esc(syncTime)}).`
                    : 'Place <code>Canvas-Archive</code> next to <code>Study-OS</code> or set its folder path below.'
                }</small>
              </div>
              <div class="row-actions">
                ${ca.hasResyncApp ? '<button type="button" class="primary-btn" id="btn-open-canvas-resync">Sync Canvas</button>' : '<a class="ghost-btn" href="https://github.com/shadjosef/canvas-study-sync" target="_blank" rel="noopener">Get Canvas Sync ↗</a>'}
                <button type="button" class="ghost-btn" id="btn-set-archive-path">Set Folder Path</button>
              </div>
            </div>
            <div class="onboarding-step">
              <div>
                <span class="badge gold">Step 2</span>
                <h4 style="margin:8px 0 4px">2. Import Courses into Study-OS</h4>
                <small class="muted">Builds Split-PDF exam &amp; exercise banks + timetable links directly from your synced Canvas folders.</small>
              </div>
              <div class="row-actions">
                <button type="button" class="primary-btn" id="btn-import-canvas-courses" ${ca.connected ? '' : 'disabled'}>
                  Import ${unimported || (ca.courses || []).length || ''} Canvas Courses →
                </button>
                <button type="button" class="ghost-btn" id="btn-install-demo">Load Demo Pack</button>
              </div>
            </div>
            <div class="onboarding-step">
              <div>
                <span class="badge">Step 3</span>
                <h4 style="margin:8px 0 4px">3. TimeEdit / AI Schedule</h4>
                <small class="muted">Paste your TimeEdit <code>.ics</code> link + weekly work hours, or generate a custom schedule with any LLM.</small>
              </div>
              <button type="button" class="ghost-btn" id="btn-onboard-sched">Open Schedule Studio →</button>
            </div>
          </div>
        </div>
      `;
    } else {
      strip.innerHTML = `
        <div class="canvas-connect-bar">
          <div>
            <span class="badge ${ca.connected ? 'live' : ''}">${ca.connected ? 'Canvas-Archive Linked' : 'Canvas-Archive'}</span>
            <small class="muted" style="margin-left:8px">${
              ca.connected
                ? `Last sync: <b>${esc(syncTime)}</b> · ${(ca.courses || []).filter((c) => !c.isProgramHub).length} courses${
                    unimported ? ` (<b>${unimported}</b> ready to import)` : ''
                  }`
                : 'Connect a sibling Canvas-Archive folder to sync PDFs &amp; TimeEdit via cookie session.'
            }</small>
          </div>
          <div class="row-actions">
            ${ca.hasResyncApp ? '<button type="button" class="ghost-btn" style="padding:5px 11px;font-size:12.5px" id="btn-open-canvas-resync">Sync Canvas</button>' : ''}
            ${
              unimported > 0
                ? `<button type="button" class="primary-btn" style="padding:5px 11px;font-size:12.5px" id="btn-import-canvas-courses">Import ${unimported} New Course${unimported > 1 ? 's' : ''} →</button>`
                : ''
            }
            ${!ca.connected ? '<button type="button" class="ghost-btn" style="padding:5px 11px;font-size:12.5px" id="btn-set-archive-path">Connect Canvas-Archive</button>' : ''}
          </div>
        </div>
      `;
    }

    document.getElementById('btn-open-canvas-resync')?.addEventListener('click', openCanvasSync);

    document.getElementById('btn-set-archive-path')?.addEventListener('click', async () => {
      const p = prompt('Enter full path to your local Canvas-Archive folder:', ca.configuredPath || ca.archivePath || '');
      if (p === null) return;
      boot = await apiPost('/api/canvas/config', { canvasArchivePath: p.trim() });
      toast('Updated Canvas-Archive path!');
      renderHome();
    });

    document.getElementById('btn-import-canvas-courses')?.addEventListener('click', () => {
      importCanvasCourses().catch(() => toast('Could not import courses. Check your Canvas-Archive folder.'));
    });

    document.getElementById('btn-install-demo')?.addEventListener('click', async () => {
      const res = await apiPost('/api/canvas/import', { action: 'demo' });
      if (res.bootstrap) boot = res.bootstrap;
      toast('Loaded Demo Showcase course!');
      renderHome();
    });

    document.getElementById('btn-onboard-sched')?.addEventListener('click', () => navigate('schedule'));
  }

  async function importCanvasCourses() {
    toast('Importing courses from Canvas-Archive…');
    const result = await apiPost('/api/canvas/import', {});
    if (result.bootstrap) boot = result.bootstrap;
    if (currentView === 'home') renderHome();
    const count = result.imported?.length || 0;
    toast(count ? `Imported ${count} Canvas course${count === 1 ? '' : 's'}.` : 'No new courses to import.');
    return count;
  }

  function bindCanvasSync() {
    const dialog = document.getElementById('canvas-sync-dialog');
    const form = document.getElementById('canvas-sync-form');
    const submit = form.querySelector('button[type="submit"]');
    const status = document.getElementById('canvas-sync-status');
    const log = document.getElementById('canvas-sync-log');
    const details = document.getElementById('canvas-sync-details');
    const importBtn = document.getElementById('canvas-sync-import');
    let pollTimer;
    let checking = false;
    let submitting = false;
    let refreshedRun;

    async function request(action, session) {
      const response = await fetch('/api/canvas/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, session }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    }

    async function readStatus() {
      if (checking || submitting) return;
      clearTimeout(pollTimer);
      checking = true;
      try {
        const state = await request('status');
        const running = ['preparing', 'syncing'].includes(state.phase);
        const minutes = Math.ceil(state.estimated_remaining_seconds / 60);
        status.textContent = (state.message || 'Canvas Sync is ready.')
          + (running && minutes > 0 ? ` About ${minutes} min remaining.` : '');
        log.textContent = state.log || '';
        details.hidden = !log.textContent;
        submit.disabled = running;
        importBtn.hidden = running || !boot.canvasArchive?.unimportedCount;
        if (running) {
          pollTimer = setTimeout(readStatus, 1800);
        } else if (state.finished && state.finished !== refreshedRun && ['done', 'notices'].includes(state.phase)) {
          for (const id of Object.keys(bankCache)) delete bankCache[id];
          await refreshBootstrap();
          refreshedRun = state.finished;
          importBtn.hidden = !boot.canvasArchive?.unimportedCount;
        }
      } catch (error) {
        status.textContent = error.message || 'Could not reach Canvas Sync. Reopen this dialog to retry.';
      } finally {
        checking = false;
      }
    }

    form.onsubmit = async (event) => {
      event.preventDefault();
      if (checking || submitting || submit.disabled) return;
      submitting = true;
      submit.disabled = true;
      importBtn.hidden = true;
      status.textContent = 'Starting Canvas Sync…';
      const session = form.elements.session.value.trim();
      form.reset();
      let started = false;
      try {
        await request('start', session);
        started = true;
      } catch (error) {
        status.textContent = error.message;
        submit.disabled = false;
      } finally {
        submitting = false;
      }
      if (started) await readStatus();
    };

    importBtn.onclick = async () => {
      importBtn.disabled = true;
      try {
        const count = await importCanvasCourses();
        importBtn.hidden = !boot.canvasArchive?.unimportedCount;
        status.textContent = count ? `Imported ${count} Canvas course${count === 1 ? '' : 's'}.` : 'No new courses to import.';
      } catch {
        status.textContent = 'Could not import courses. Check your Canvas-Archive folder.';
      } finally {
        importBtn.disabled = false;
      }
    };
    document.getElementById('canvas-sync-standalone').onclick = async () => {
      try {
        const result = await apiPost('/api/canvas/open-resync', {});
        status.textContent = result.message || 'Opened the standalone Canvas Sync app.';
      } catch {
        status.textContent = 'Could not launch the standalone app. Open it from Canvas-Archive.';
      }
    };
    dialog.addEventListener('close', () => form.reset());
    return () => {
      if (!dialog.open) dialog.showModal();
      if (!submitting && !checking) {
        status.textContent = 'Connecting to Canvas Sync…';
        submit.disabled = true;
        readStatus();
      }
    };
  }

  async function saveForOffline(event) {
    const button = event.currentTarget;
    const showStatus = (message) => {
      offlineStatus = message;
      const status = document.getElementById('offline-status');
      if (status) status.textContent = message;
    };
    if (!navigator.serviceWorker) {
      showStatus('Offline saving is unavailable in this browser.');
      return;
    }
    button.disabled = true;
    showStatus('Saving notes and questions…');
    try {
      const registration = await navigator.serviceWorker.register('./offline-worker.js');
      const worker = registration.installing || registration.waiting || registration.active;
      if (!worker) throw new Error('Offline worker missing');
      if (worker.state === 'installing') {
        await new Promise((resolve, reject) => {
          const onStateChange = () => {
            if (worker.state === 'installing') return;
            worker.removeEventListener('statechange', onStateChange);
            if (worker.state === 'redundant') reject(new Error('Offline install failed'));
            else resolve();
          };
          worker.addEventListener('statechange', onStateChange);
          onStateChange();
        });
      }
      showStatus('Saved for offline');
      button.textContent = 'Check offline copy';
    } catch {
      showStatus(navigator.serviceWorker.controller
        ? 'The saved copy is available. Connect to update it.'
        : 'Could not save. Check your connection and try again.');
    } finally {
      button.disabled = false;
    }
  }

  function bindMemberAccess(showWelcome = true) {
    if (!members.enabled) return;
    const dialog = document.getElementById('member-dialog');
    const form = document.getElementById('member-form');
    const key = document.getElementById('member-key');
    const feedback = document.getElementById('member-feedback');
    const submit = form.querySelector('button[type=submit]');
    const dismiss = () => {
      try { sessionStorage.setItem('study-os-member-dismissed', '1'); } catch {}
      key.value = '';
      dialog.close();
    };
    const show = () => {
      feedback.textContent = '';
      dialog.showModal();
    };
    dialog.addEventListener('cancel', dismiss);
    document.getElementById('member-dismiss').onclick = dismiss;
    document.getElementById('btn-member-library').onclick = async () => {
      if (members.isUnlocked()) {
        try {
          await members.forget();
        } catch {
          toast('Browser storage did not clear. Clear the stored site data to forget the key.');
          return;
        }
        try { sessionStorage.removeItem('study-os-member-dismissed'); } catch {}
        for (const courseId of Object.keys(bankCache)) delete bankCache[courseId];
        await refreshBootstrap();
        show();
      } else show();
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      submit.disabled = true;
      feedback.textContent = 'Opening your library…';
      try {
        const remember = document.getElementById('member-remember').checked;
        const remembered = await members.unlock(key.value, remember);
        key.value = '';
        for (const courseId of Object.keys(bankCache)) delete bankCache[courseId];
        await refreshBootstrap();
        dialog.close();
        toast(remember && !remembered ? 'Library unlocked for this visit. This browser could not save the key.' : 'Full library unlocked.');
      } catch (error) {
        feedback.textContent = error.message || 'Could not open the library.';
      } finally {
        submit.disabled = false;
      }
    };
    if (!showWelcome || members.isUnlocked()) return;
    try { if (sessionStorage.getItem('study-os-member-dismissed')) return; } catch {}
    show();
  }

  // ---------------------------------------------------------------------------
  // VIEW 2: EXAM SIMULATOR HUB (All 5 Subjects + WISEflow ±2% + Custom Papers)
  // ---------------------------------------------------------------------------
  function getExamPaperCollections(cMeta) {
    const colls = cMeta.collections || [];
    const examColls = colls.filter((col) =>
      /^(E\d|WF-MOCK|exam-|nov19-mock|wiseflow-mock|sample-exam|mock-exam-|official-mock|pandas-viz-exam2|multchoice-2025)/i.test(col.id) ||
      col.kind === 'mock_exam' ||
      col.kind === 'exam'
    );
    return examColls.length || isStaticWeb ? examColls : colls.slice(0, 4);
  }

  function renderExamsHub(focusCourseId = '') {
    const root = document.getElementById('exams-hub-root');
    if (!boot.catalog.length) {
      root.innerHTML = '<div class="panel"><p>No course banks loaded.</p></div>';
      return;
    }

    // Order courses chronologically by upcoming exam date
    const sortedCourses = [...boot.catalog].sort((a, b) => {
      const da = daysUntilDateStr(a.examInfo?.date);
      const db = daysUntilDateStr(b.examInfo?.date);
      const va = da !== null && da >= -2 ? da : 999;
      const vb = db !== null && db >= -2 ? db : 999;
      return va - vb;
    });

    const cardsHtml = sortedCourses
      .map((c) => {
        const daysLeft = daysUntilDateStr(c.examInfo?.date);
        const daysPill =
          daysLeft !== null
            ? `<span class="badge ${daysLeft <= 14 && daysLeft >= 0 ? 'warn' : 'gold'}">${esc(c.examInfo.date)}${
                daysLeft >= 0 ? ` · ${daysLeft}d left` : ''
              }</span>`
            : '';
        const durMin = c.examInfo?.durationMinutes || 180;
        const examColls = getExamPaperCollections(c);
        const mathPrep = c.courseId === 'math-2588' && c.obsidian?.practiceNote
          ? publicReferenceUrl(c.obsidian.practiceNote)
          : '';

        const packsHtml = examColls
          .map(
            (col) => {
              const colDur = Number(col.durationMinutes || durMin);
              return `<div class="exam-pack-card">
              <div>
                <strong>${esc(examLabel(col.title))}</strong>
                <small class="muted">${colDur} min${col.description ? ` · ${esc(col.description)}` : ''}</small>
              </div>
              <div class="row-actions">
                <button type="button" class="primary-btn" style="flex:1" data-sit-course="${esc(c.courseId)}" data-sit-coll="${esc(
              col.id
            )}" data-sit-dur="${colDur}" data-sit-title="${esc(examLabel(col.title))}">
                  ${members.isUnlocked() && col.kind === 'exam' ? 'Review paper' : 'Start paper'}
                </button>
              </div>
            </div>`;
            }
          )
          .join('');

        const customDesc =
          c.courseId === 'acct-2527'
            ? '10 random MCQs (40 pts) + 4 worksheets across Ch 2/3, Ch 5, Ch 7 & Ch 8/10 (140 pts).'
            : c.courseId === 'econ-2522'
            ? 'Official BI 3-part structure: 10 MCQs + 3 Short Answers + 1 Multi-Part Analytical Case (180m).'
            : c.courseId === 'math-2588'
            ? '12 stratified calculation problems spanning Financial Math, Algebra/Functions, Optimisation & Taylor (180m).'
            : c.courseId === 'ob-2537'
            ? 'Full 50-question randomized WISEflow MCQ paper balanced across Lessons 1–14.'
            : '4-task Home Exam 2 blueprint: (1) Loop/Simulation, (2) Function/Dict/DateTime, (3) Pandas/Seaborn Table, (4) Time Series/Resample/Plot + 2 rule checks (180m).';

        return `
          <section class="panel exam-course-card" id="exam-card-${esc(c.courseId)}" style="border-left-color:${esc(c.color)}">
            <div class="row-between" style="margin-top:0">
              <div style="flex:1;min-width:260px">
                <span class="eyebrow" style="color:${esc(c.color)}">${esc(c.code)} · ${esc(c.examInfo?.format || 'Exam Preparation')}</span>
                <h2>${esc(c.title)}</h2>
                ${c.examInfo?.notes ? `<p class="muted" style="font-size:13.5px;margin:6px 0 0">${esc(c.examInfo.notes)}</p>` : ''}
                ${mathPrep ? `<p><a href="${esc(mathPrep)}">2026 preparation guide</a></p>` : ''}
                ${c.courseId === 'math-2588' ? '<p><a href="https://www.dr-eriksen.no/teaching/EBA1180/exams.php" target="_blank" rel="noopener">Mathematics past papers and solutions ↗</a></p>' : ''}
              </div>
              <div class="row-actions">
                ${daysPill}
                <button type="button" class="ghost-btn" data-exam-ref="${esc(c.courseId)}">Reference</button>
              </div>
            </div>

            <div class="exam-pack-grid">
              ${packsHtml}
              <div class="exam-pack-card" style="border-style:dashed;border-color:var(--accent)">
                <div>
                  <strong>Randomized Full Mock Exam</strong>
                  <small class="muted">${esc(customDesc)}</small>
                </div>
                <button type="button" class="ghost-btn" data-gen-exam="${esc(c.courseId)}">Build &amp; Launch Paper →</button>
              </div>
            </div>
          </section>
        `;
      })
      .join('');

    root.innerHTML = `
      <div class="hero-card" style="margin-bottom:20px">
        <div class="hero-top">
          <div style="flex:1;min-width:260px">
            <span class="eyebrow">WISEflow &amp; Past Exam Simulator</span>
            <h1 class="hero-title" style="margin-bottom:6px">Mock exams and past papers</h1>
            <p class="muted" style="margin:0;font-size:14px">
              Choose a timed mock or a guided practice session. Accounting mocks include numerical entry with a 2% tolerance.
            </p>
            <p><a href="https://portal.bi.no/en/exams/former-examination-papers" target="_blank" rel="noopener">Official past papers and marking guides on the BI portal ↗</a></p>
          </div>
          <div>
            <small class="muted" style="display:block;margin-bottom:6px;font-weight:700">DELIVERY MODE:</small>
            <div class="exam-mode-switch" role="group" aria-label="Exam Simulation Mode">
              <button type="button" data-exam-style="blind" class="${selectedExamStyle === 'blind' ? 'active' : ''}">
                Blind Exam Sit
              </button>
              <button type="button" data-exam-style="guided" class="${selectedExamStyle === 'guided' ? 'active' : ''}">
                Guided Section Check
              </button>
            </div>
          </div>
        </div>
      </div>
      ${cardsHtml}
    `;

    root.querySelectorAll('[data-exam-style]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedExamStyle = btn.dataset.examStyle;
        renderExamsHub();
      });
    });

    root.querySelectorAll('[data-sit-course]').forEach((btn) => {
      btn.addEventListener('click', () =>
        launchCollectionExam(
          btn.dataset.sitCourse,
          btn.dataset.sitColl,
          btn.dataset.sitTitle,
          selectedExamStyle,
          Number(btn.dataset.sitDur || 0)
        )
      );
    });

    root.querySelectorAll('[data-gen-exam]').forEach((btn) => {
      btn.addEventListener('click', () => launchRandomizedFullExam(btn.dataset.genExam, selectedExamStyle));
    });

    root.querySelectorAll('[data-exam-ref]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cm = boot.catalog.find((x) => x.courseId === btn.dataset.examRef);
        if (cm) openReferenceDrawer(cm);
      });
    });

    if (focusCourseId) {
      document.getElementById(`exam-card-${focusCourseId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function shuffleArray(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  async function launchCollectionExam(courseId, collectionId, title, examStyle = 'blind', customDurationMin = 0) {
    const bank = await ensureCourseBank(courseId);
    const cMeta = boot.catalog.find((c) => c.courseId === courseId);
    const colObj = (bank.collections || []).find((c) => String(c.id) === String(collectionId));
    const questions = (bank.questions || [])
      .filter((q) => q.available !== false && String(q.collectionId) === String(collectionId));
    const qids = questions.map((q) => q.id);
    if (!qids.length) {
      toast('No available questions in that exam paper.');
      return;
    }
    const durMin = Number(customDurationMin || colObj?.durationMinutes || cMeta?.examInfo?.durationMinutes || 180);
    if (members.course(courseId) && questions.some((q) => !['synthetic_drill', 'mock_exam'].includes(q.origin))) {
      examStyle = 'guided';
    }
    window.StudyRunner.startRun({
      courseMeta: cMeta,
      bank,
      questionIds: qids,
      mode: 'exam',
      examStyle,
      examTitle: title,
      durationMinutes: durMin,
      freshExamSit: examStyle === 'blind',
      profile: 'exam',
    });
  }

  async function launchRandomizedFullExam(courseId, examStyle = 'blind') {
    const bank = await ensureCourseBank(courseId);
    const cMeta = boot.catalog.find((c) => c.courseId === courseId);
    const memberCourse = members.course(courseId);
    const avail = (bank.questions || []).filter((q) => q.available !== false
      && (!memberCourse || ['synthetic_drill', 'mock_exam'].includes(q.origin)));
    let picked = [];

    if (courseId === 'acct-2527') {
      // 10 MCQs + 4 multi-box FLOWmulti exercises spanning (1) Ch 2/3, (2) Ch 5, (3) Ch 7, (4) Ch 8 or Ch 10
      const mcqs = shuffleArray(avail.filter((q) => q.kind === 'mcq')).slice(0, 10);
      const wfPool = avail.filter((q) => Array.isArray(q.wiseflowFields) && q.wiseflowFields.length >= 4);
      const pickOne = (topics, excludeIds) => {
        const cands = shuffleArray(wfPool.filter((q) => topics.includes(String(q.topicId)) && !excludeIds.has(q.id)));
        return cands[0] || null;
      };
      const used = new Set();
      const exs = [];
      for (const grp of [['2', '3', 'DEB'], ['5'], ['7'], ['8'], ['10']]) {
        if (exs.length >= 4) break;
        const found = pickOne(grp, used);
        if (found) {
          used.add(found.id);
          exs.push(found);
        }
      }
      picked = [...mcqs, ...exs];
    } else if (courseId === 'econ-2522') {
      // 10 MCQs + 3 Short Answers + 1 Analytical Case
      const mcqs = shuffleArray(avail.filter((q) => q.kind === 'mcq')).slice(0, 10);
      const cases = shuffleArray(
        avail.filter((q) => q.collectionId === 'SYN-CASE' || (q.pacing?.exam?.target || 0) >= 15)
      ).slice(0, 1);
      const caseIds = new Set(cases.map((q) => q.id));
      const shorts = shuffleArray(
        avail.filter((q) => q.kind !== 'mcq' && !caseIds.has(q.id) && (q.pacing?.exam?.target || 6) <= 12)
      ).slice(0, 3);
      picked = [...mcqs, ...shorts, ...cases];
    } else if (courseId === 'math-2588') {
      // 12 calculation problems stratified across Finance (1-4), Algebra/Functions (5-10), Diff/Opt (11-15), Econ/Taylor (16-18)
      const calc = avail.filter((q) => q.kind === 'calculation');
      const b1 = shuffleArray(calc.filter((q) => ['1', '2', '3', '4'].includes(String(q.topicId)))).slice(0, 3);
      const b2 = shuffleArray(calc.filter((q) => ['5', '6', '7', '8', '9', '10'].includes(String(q.topicId)))).slice(0, 4);
      const b3 = shuffleArray(calc.filter((q) => ['11', '12', '13', '14', '15'].includes(String(q.topicId)))).slice(0, 3);
      const b4 = shuffleArray(calc.filter((q) => ['16', '17', '18'].includes(String(q.topicId)))).slice(0, 2);
      picked = [...b1, ...b2, ...b3, ...b4];
    } else if (courseId === 'ob-2537') {
      picked = shuffleArray(avail.filter((q) => q.kind === 'mcq')).slice(0, 50);
    } else if (courseId === 'prog-3021') {
      // Official Home Exam 2 4-task blueprint (Task 1: Loop/Cond, Task 2: Func/Dict/Date, Task 3: Pandas/Seaborn, Task 4: Time Series/Resample/Plot) + 2 rule/syntax checks
      const coding = avail.filter((q) => q.kind !== 'mcq');
      const t1 = shuffleArray(coding.filter((q) => ['1', '2'].includes(String(q.topicId)))).slice(0, 1);
      const t2 = shuffleArray(coding.filter((q) => ['3', '4'].includes(String(q.topicId)))).slice(0, 1);
      const t3 = shuffleArray(coding.filter((q) => String(q.topicId) === '5')).slice(0, 1);
      const t4 = shuffleArray(coding.filter((q) => String(q.topicId) === '6')).slice(0, 1);
      const mcqs = shuffleArray(avail.filter((q) => q.kind === 'mcq')).slice(0, 2);
      picked = [...t1, ...t2, ...t3, ...t4, ...mcqs];
    } else {
      // Fallback for any future course
      const coding = shuffleArray(avail.filter((q) => q.kind !== 'mcq')).slice(0, 7);
      const mcqs = shuffleArray(avail.filter((q) => q.kind === 'mcq')).slice(0, 3);
      picked = [...mcqs, ...coding];
    }

    if (!picked.length) picked = shuffleArray(avail).slice(0, 12);

    window.StudyRunner.startRun({
      courseMeta: cMeta,
      bank,
      questionIds: picked.map((q) => q.id),
      mode: 'exam',
      examStyle,
      examTitle: `${cMeta?.shortTitle || courseId} · Custom Randomized Mock Exam`,
      durationMinutes: cMeta?.examInfo?.durationMinutes || 180,
      freshExamSit: examStyle === 'blind',
      profile: 'exam',
    });
  }

  function interleaveByTopic(items, bandKeyFn) {
    if (items.length <= 2) return items;
    const out = [];
    let i = 0;
    while (i < items.length) {
      const key = bandKeyFn(items[i]);
      let j = i + 1;
      while (j < items.length && bandKeyFn(items[j]) === key) j++;
      const slice = items.slice(i, j);
      if (slice.length <= 2) {
        out.push(...slice);
      } else {
        const byTopic = new Map();
        for (const q of slice) {
          const tk = String(q.topicId || '0');
          if (!byTopic.has(tk)) byTopic.set(tk, []);
          byTopic.get(tk).push(q);
        }
        const queues = [...byTopic.values()];
        if (queues.length <= 1) {
          out.push(...slice);
        } else {
          let remaining = slice.length;
          while (remaining > 0) {
            for (const qArr of queues) {
              if (qArr.length) {
                out.push(qArr.shift());
                remaining--;
              }
            }
          }
        }
      }
      i = j;
    }
    return out;
  }

  function buildEffortSortedQueue(questions, budgetMinutes = 40, profile = 'learning', filterTopics = [], effortMode = 'auto') {
    const rawMode = effortMode === 'auto' ? getResolvedFocusMode() : effortMode;
    const mode =
      rawMode === 'deep'
        ? 'high_dlpfc'
        : rawMode === 'balanced'
        ? 'med_dlpfc'
        : rawMode === 'light'
        ? 'low_dlpfc'
        : rawMode;
    const nowIso = new Date().toISOString();
    const topicSet = new Set((filterTopics || []).filter(Boolean).map(String));

    let pool = (questions || []).filter((q) => {
      if (q.available === false) return false;
      if (topicSet.size && !topicSet.has(String(q.topicId))) return false;
      return true;
    });
    if (!pool.length && topicSet.size) {
      pool = (questions || []).filter((q) => q.available !== false);
    }

    const qMin = (q) => Number(q.pacing?.[profile]?.target || q.pacing?.learning?.target || (q.kind === 'mcq' ? 2 : 8));
    const qTier = (q) => effectiveDlpfc(q).tier;

    if (mode === 'high_dlpfc') {
      const highMedUnfinished = pool.filter(
        (q) => qTier(q) >= 2 && (getProgressRecord(q.id)?.status || 'not_started') !== 'done'
      );
      if (highMedUnfinished.length >= 1) {
        pool = pool.filter((q) => qTier(q) >= 2);
      } else {
        const highMedAny = pool.filter((q) => qTier(q) >= 2);
        if (highMedAny.length >= 2) pool = highMedAny;
      }
    } else if (mode === 'low_dlpfc') {
      const lowMedPool = pool.filter((q) => qTier(q) <= 2 || qMin(q) <= 8);
      if (lowMedPool.length >= 3) pool = lowMedPool;
    }

    const bucketRank = (q) => {
      const r = getProgressRecord(q.id) || {};
      const st = r.status || 'not_started';
      const isDue = r.fsrs?.due && r.fsrs.due <= nowIso;
      if (st === 'revisit') return 0;
      if (st === 'in_progress') return 1;
      if (isDue) return 2;
      if (st === 'not_started') return 3;
      return 4;
    };

    const tierRank = (q) => {
      const t = qTier(q);
      if (mode === 'high_dlpfc') return 3 - t; // 3 -> 2 -> 1
      if (mode === 'med_dlpfc') return t === 2 ? 0 : t === 1 ? 1 : 2; // 2 -> 1 -> 3
      return t - 1; // 1 -> 2 -> 3
    };

    pool.sort((a, b) => {
      const ba = bucketRank(a);
      const bb = bucketRank(b);
      if (ba !== bb) return ba - bb;

      const ta = tierRank(a);
      const tb = tierRank(b);
      if (ta !== tb) return ta - tb;

      if (mode === 'high_dlpfc') {
        const qa = qMin(a);
        const qb = qMin(b);
        if (Math.abs(qb - qa) > 0.2) return qb - qa;
      } else if (mode === 'low_dlpfc') {
        return qMin(a) - qMin(b);
      }

      const sa = a.origin === 'synthetic_drill' ? 1 : 0;
      const sb = b.origin === 'synthetic_drill' ? 1 : 0;
      if (sa !== sb) return sa - sb;
      return effectiveDifficulty(b) - effectiveDifficulty(a);
    });

    // Interleave distinct topics within each (statusBucket, dlpfcTier) band
    pool = interleaveByTopic(pool, (q) => `${bucketRank(q)}:${tierRank(q)}`);

    const chosen = [];
    let accMin = 0;
    for (const q of pool) {
      const qm = qMin(q);
      if (chosen.length && (accMin + qm > budgetMinutes * 1.28 || chosen.length >= 16)) {
        if (chosen.length >= (accMin >= budgetMinutes * 0.65 ? 1 : 2)) break;
        continue;
      }
      chosen.push(q.id);
      accMin += qm;
      if (accMin >= budgetMinutes * 0.92) break;
    }
    if (!chosen.length && pool.length) chosen.push(pool[0].id);
    return chosen;
  }

  async function launchCalendarBlock(block) {
    const bank = await ensureCourseBank(block.courseId);
    const cMeta = boot.catalog.find((c) => c.courseId === block.courseId);
    const prof = block.recommendedProfile || 'learning';
    let qids = block.autoQueue?.questionIds || [];
    if (sessionFocusMode !== 'auto' || !qids.length) {
      qids = buildEffortSortedQueue(
        bank.questions || [],
        Number(block.attemptBudgetMinutes || block.focusMinutes || 40),
        prof,
        block.topicIds || [],
        getResolvedFocusMode()
      );
    }
    window.StudyRunner.startRun({
      courseMeta: cMeta,
      bank,
      questionIds: qids,
      mode: 'practice',
      profile: prof,
      calendarBlock: block,
    });
  }

  async function launchSmartCourseRun(courseId, budgetMinutes = 40, profile = 'learning', filterTopic = '', effortMode = 'auto', quick = false) {
    const bank = await ensureCourseBank(courseId);
    const cMeta = boot.catalog.find((c) => c.courseId === courseId);
    let pool = bank.questions || [];
    if (quick) {
      const minutes = (q) => Number(q.pacing?.learning?.target || (q.kind === 'mcq' ? 2 : 8));
      const available = pool.filter((q) => q.available !== false);
      const short = available.filter((q) => minutes(q) <= budgetMinutes);
      pool = short.length ? short : available.sort((a, b) => minutes(a) - minutes(b)).slice(0, 1);
    }
    const chosen = buildEffortSortedQueue(
      pool,
      budgetMinutes,
      profile,
      filterTopic ? [filterTopic] : [],
      quick ? 'med_dlpfc' : effortMode
    );

    window.StudyRunner.startRun({
      courseMeta: cMeta,
      bank,
      questionIds: chosen,
      mode: 'practice',
      profile,
    });
  }

  // ---------------------------------------------------------------------------
  // VIEW 3: COURSE EXPLORER & TASK STATUS MANAGER (Difficulty, Horizon & Interleaving)
  // ---------------------------------------------------------------------------
  async function renderCourseExplorer(courseId, initialPreset = '') {
    const root = document.getElementById('course-explorer-root');
    if (!courseId && boot.catalog.length) courseId = boot.catalog[0].courseId;
    selectedCourseId = courseId;
    if (!courseId) {
      root.innerHTML = '<div class="panel"><p>No course banks loaded yet.</p></div>';
      return;
    }

    root.innerHTML = '<div class="panel"><p class="muted">Loading course bank…</p></div>';
    let bank;
    try {
      bank = await ensureCourseBank(courseId);
    } catch {
      root.innerHTML = '<div class="panel"><p>Could not load this course. Check your connection or open a course saved for offline.</p></div>';
      return;
    }
    if (selectedCourseId !== courseId || currentView !== 'course') return;
    const cMeta = boot.catalog.find((c) => c.courseId === courseId) || { courseId, title: bank.title, shortTitle: bank.shortTitle };
    const autoMode = getCircadianAutoTarget().mode;
    const defaultSort = autoMode === 'high_dlpfc' ? 'deep_first' : 'smart_priority';
    const documents = members.course(courseId)?.documents || [];
    const documentSections = new Map();
    for (const doc of documents) {
      if (!documentSections.has(doc.section)) documentSections.set(doc.section, []);
      documentSections.get(doc.section).push(doc);
    }
    const library = [...documentSections].map(([section, files]) => `
      <details class="course-document-group">
        <summary>${esc(section)} (${files.length})</summary>
        <ul>${files.map((doc) => `<li><button type="button" class="member-file"
          data-member-download="${esc(doc.id)}" data-member-mime="${esc(doc.mime)}" data-filename="${esc(doc.title)}">
          ${esc(doc.title)}</button></li>`).join('')}</ul>
      </details>`).join('');

    const courseOptions = boot.catalog
      .map((c) => `<option value="${esc(c.courseId)}" ${c.courseId === courseId ? 'selected' : ''}>${esc(c.code)} · ${esc(c.title)}</option>`)
      .join('');

    const topicOptions =
      `<option value="all">All Topics / Chapters</option>` +
      (bank.topics || []).map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('');

    const collOptions =
      `<option value="all">All Sources &amp; Past Papers</option>` +
      (bank.collections || []).map((c) => `<option value="${esc(c.id)}">${esc(examLabel(c.title))}</option>`).join('');

    const topicCounts = new Map();
    for (const question of bank.questions || []) {
      if (question.available !== false) {
        const key = String(question.topicId);
        topicCounts.set(key, (topicCounts.get(key) || 0) + 1);
      }
    }
    const curriculum = (bank.topics || []).map((topic) => {
      const count = topicCounts.get(String(topic.id)) || 0;
      const file = topic.obsidianFile || cMeta.obsidian?.mainReference || '';
      const ref = publicReferenceUrl(file, topic.obsidianHeading || '');
      const practice = count
        ? `<button type="button" class="ghost-btn" data-practice-topic="${esc(topic.id)}">Practice (${count})</button>`
        : '<small>Notes only</small>';
      return `<li>
        <span>${esc(topic.title)}</span>
        <div class="row-actions">
          ${ref ? `<a href="${esc(ref)}" class="ghost-btn">Notes</a>` : ''}
          ${practice}
        </div>
      </li>`;
    }).join('');

    root.innerHTML = `
      <div class="panel">
        <div class="row-between" style="margin-top:0">
          <div style="flex:1;min-width:260px">
            <span class="eyebrow">Course Builder &amp; Difficulty filters</span>
            <div style="margin-top:4px">
              <select id="exp-course-sel" aria-label="Choose subject" style="font-size:17px;font-weight:700;padding:8px 14px">${courseOptions}</select>
            </div>
          </div>
          <div class="row-actions">
            <button type="button" class="ghost-btn" id="exp-open-exams">Mock Exams</button>
            <button type="button" class="ghost-btn" id="exp-open-ref">Reference</button>
            ${cMeta.obsidianUri ? `<a class="ghost-btn" href="${esc(cMeta.obsidianUri)}">Obsidian ↗</a>` : ''}
          </div>
        </div>

        ${isStaticWeb && curriculum ? `<details class="curriculum">
          <summary>Curriculum and study materials</summary>
          <ol>${curriculum}</ol>
          <p><a href="https://canvas.bi.no/${cMeta.canvasId ? `courses/${encodeURIComponent(cMeta.canvasId)}` : ''}" target="_blank" rel="noopener">Course handouts and assignments in BI Canvas ↗</a></p>
        </details>` : ''}
        ${library ? `<details class="curriculum">
          <summary>Original course files (${documents.length})</summary>
          <input type="search" id="member-file-search" aria-label="Find course files" placeholder="Find a book, slide deck or exam">
          ${library}
        </details>` : ''}

        <div class="preset-chips-bar" role="group" aria-label="Practice difficulty presets">
          <small class="muted" style="font-weight:700;margin-right:4px">PRESETS:</small>
          <button type="button" class="preset-chip" data-exp-preset="high_dlpfc" data-layout-tier="3">${window.StudyLayout.label(3)}</button>
          <button type="button" class="preset-chip" data-exp-preset="med_dlpfc" data-layout-tier="2">${window.StudyLayout.label(2)}</button>
          <button type="button" class="preset-chip" data-exp-preset="low_dlpfc" data-layout-tier="1">${window.StudyLayout.label(1)}</button>
          <button type="button" class="preset-chip" data-exp-preset="long_horizon">Long Horizon (10m+)</button>
          ${cMeta.flowmultiCount ? '<button type="button" class="preset-chip" data-exp-preset="wiseflow_only">Worksheets</button>' : ''}
          <button type="button" class="preset-chip active" data-exp-preset="reset">All Tasks</button>
        </div>

        <div class="filter-grid" style="margin-top:12px">
          <label class="field-label">Topic / Chapter
            <select id="flt-topic">${topicOptions}</select>
          </label>
          <label class="field-label">Source / Paper
            <select id="flt-coll">${collOptions}</select>
          </label>
          <label class="field-label">Format
            <select id="flt-kind">
              <option value="all">All Formats</option>
              <option value="no_mcq">No Multiple Choice (Deep Work)</option>
              <option value="wiseflow">Worksheets</option>
              <option value="calculation">Calculation / Problem</option>
              <option value="written">Written / Analytical Case</option>
              <option value="coding">Coding</option>
              <option value="mcq">Multiple Choice (MCQ) Only</option>
            </select>
          </label>
          <label class="field-label">Difficulty
            <select id="flt-diff">
              <option value="all">All difficulty levels</option>
              <option value="3" data-layout-tier="3">${window.StudyLayout.label(3)}</option>
              <option value="2plus" data-layout-tier-group>${window.StudyLayout.label(2)} and ${window.StudyLayout.label(3)}</option>
              <option value="2" data-layout-tier="2">${window.StudyLayout.label(2)}</option>
              <option value="1" data-layout-tier="1">${window.StudyLayout.label(1)}</option>
            </select>
          </label>
          <label class="field-label">Time / Effort Horizon
            <select id="flt-horizon">
              <option value="all">All Time Horizons</option>
              <option value="6plus">6m+ Sustained (≥6m Par)</option>
              <option value="10plus">10m+ Deep Problem (≥10m Par)</option>
              <option value="15plus">15m+ Heavy Case (≥15m Par)</option>
              <option value="under6">Quick (&lt;6m Par)</option>
            </select>
          </label>
          <label class="field-label">Completion Status
            <select id="flt-status">
              <option value="all">All Statuses</option>
              <option value="unfinished">Unfinished (Todo + Revisit)</option>
              <option value="not_started">Uncomplete (Not started)</option>
              <option value="in_progress">In Progress</option>
              <option value="revisit">Revisit / Mistakes</option>
              <option value="due_fsrs">Due FSRS Review</option>
              <option value="done">Done</option>
            </select>
          </label>
          <label class="field-label">Sort Tasks By
            <select id="flt-sort">
              <option value="deep_first" ${defaultSort === 'deep_first' ? 'selected' : ''}>Hard First (Interleaved)</option>
              <option value="horizon_desc">Longest Horizon First (AI Par ↓)</option>
              <option value="diff_desc">Difficulty: hard first</option>
              <option value="smart_priority" ${defaultSort === 'smart_priority' ? 'selected' : ''}>Smart Priority (Revisit → Due → Todo)</option>
              <option value="horizon_asc">Quickest First (AI Par ↑)</option>
              <option value="bank_order">Original Paper / Bank Order</option>
            </select>
          </label>
          <label class="field-label">Run Mode &amp; Size
            <select id="flt-budget">
              <option value="budget:20">20 min Sprint</option>
              <option value="budget:45" selected>45 min Deep Wave</option>
              <option value="budget:65">65 min Extended Wave</option>
              <option value="count:5">Top 5 Matching Tasks</option>
              <option value="count:12">Top 12 Matching Tasks</option>
              <option value="all">All Matching (Full Set)</option>
              <option value="exam_sim">Blind Exam Sit (Countdown + Submit)</option>
            </select>
          </label>
        </div>

        <div class="row-between" style="margin:10px 0 0">
          <div class="row-actions" style="flex:1">
            <input type="search" id="flt-search" placeholder="Search concepts, formulas, question IDs…" style="min-width:240px;flex:1">
            <select id="flt-profile" title="AI Pace Benchmark" style="padding:7px 10px;font-size:13px">
              <option value="learning">Learning Par</option>
              <option value="exam">Exam Mastery Par</option>
            </select>
            <label style="font-size:13px;display:inline-flex;align-items:center;gap:6px">
              <input type="checkbox" id="flt-shuffle"> Shuffle
            </label>
          </div>
          <div class="row-actions">
            <span id="flt-summary-lbl" class="muted" style="font-size:13px"></span>
            <button type="button" class="primary-btn" id="btn-start-filtered">Start Selected Run →</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="row-between" style="margin-top:0">
          <div>
            <h3>Exercise Inventory &amp; Instant Status Controls</h3>
            <small class="muted">Difficulty can change as you practise and master a question.</small>
          </div>
          <div class="row-actions">
            <button type="button" class="ghost-btn" id="btn-bulk-uncomplete">Mark Matching Uncomplete</button>
            <button type="button" class="ghost-btn" id="btn-bulk-revisit">Mark Matching Revisit</button>
          </div>
        </div>
        <div class="task-table-wrap">
          <table class="task-table">
            <thead>
              <tr>
                <th>Question</th>
                <th>Topic</th>
                <th>Difficulty</th>
                <th>Format</th>
                <th>Horizon (Learn / Exam)</th>
                <th>Your Best</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="exp-table-body"></tbody>
          </table>
        </div>
      </div>
    `;

    const applyPreset = (rawPreset) => {
      const presetName = rawPreset === 'pre15_deep' ? 'high_dlpfc' : rawPreset === 'post15_mcq' ? 'low_dlpfc' : rawPreset;
      const kEl = document.getElementById('flt-kind');
      const dEl = document.getElementById('flt-diff');
      const hEl = document.getElementById('flt-horizon');
      const sEl = document.getElementById('flt-status');
      const sortEl = document.getElementById('flt-sort');
      const bEl = document.getElementById('flt-budget');

      if (presetName === 'high_dlpfc' || presetName === 'hard_only') {
        kEl.value = 'all';
        dEl.value = '3';
        hEl.value = 'all';
        sEl.value = 'unfinished';
        sortEl.value = 'deep_first';
        bEl.value = 'budget:45';
      } else if (presetName === 'med_dlpfc') {
        kEl.value = 'all';
        dEl.value = '2';
        hEl.value = 'all';
        sEl.value = 'all';
        sortEl.value = 'smart_priority';
        bEl.value = 'budget:45';
      } else if (presetName === 'low_dlpfc') {
        kEl.value = 'all';
        dEl.value = '1';
        hEl.value = 'all';
        sEl.value = 'all';
        sortEl.value = 'horizon_asc';
        bEl.value = 'budget:20';
      } else if (presetName === 'long_horizon') {
        kEl.value = 'no_mcq';
        dEl.value = 'all';
        hEl.value = '10plus';
        sEl.value = 'unfinished';
        sortEl.value = 'horizon_desc';
        bEl.value = 'budget:65';
      } else if (presetName === 'wiseflow_only') {
        kEl.value = 'wiseflow';
        dEl.value = 'all';
        hEl.value = 'all';
        sEl.value = 'all';
        sortEl.value = 'horizon_desc';
      } else {
        document.getElementById('flt-topic').value = 'all';
        document.getElementById('flt-coll').value = 'all';
        kEl.value = 'all';
        dEl.value = 'all';
        hEl.value = 'all';
        sEl.value = 'all';
        sortEl.value = defaultSort;
        document.getElementById('flt-search').value = '';
      }

      root.querySelectorAll('[data-exp-preset]').forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.expPreset === presetName);
      });
    };

    const getMatching = () => {
      const tVal = document.getElementById('flt-topic').value;
      const cVal = document.getElementById('flt-coll').value;
      const kVal = document.getElementById('flt-kind').value;
      const dVal = document.getElementById('flt-diff').value;
      const hVal = document.getElementById('flt-horizon').value;
      const sVal = document.getElementById('flt-status').value;
      const sortVal = document.getElementById('flt-sort').value;
      const prof = document.getElementById('flt-profile').value;
      const qTerm = document.getElementById('flt-search').value.trim().toLowerCase();
      const nowIso = new Date().toISOString();

      const qLearnMin = (q) => Number(q.pacing?.learning?.target || q.pacing?.[prof]?.target || (q.kind === 'mcq' ? 2 : 8));
      const qActiveMin = (q) => Number(q.pacing?.[prof]?.target || q.pacing?.learning?.target || (q.kind === 'mcq' ? 2 : 8));

      let filtered = (bank.questions || []).filter((q) => {
        if (q.available === false) return false;
        if (tVal !== 'all' && String(q.topicId) !== tVal) return false;
        if (cVal !== 'all' && String(q.collectionId) !== cVal) return false;
        if (kVal === 'no_mcq') {
          if (q.kind === 'mcq') return false;
        } else if (kVal === 'wiseflow') {
          if (!(Array.isArray(q.wiseflowFields) && q.wiseflowFields.length)) return false;
        } else if (kVal !== 'all' && q.kind !== kVal) {
          return false;
        }

        const rec = getProgressRecord(q.id);
        const dlpfc = effectiveDlpfc(q, rec).tier;
        if (dVal === '2plus' && dlpfc < 2) return false;
        if (dVal === '3' && dlpfc < 3) return false;
        if (dVal === '2' && dlpfc !== 2) return false;
        if (dVal === '1' && dlpfc !== 1) return false;

        const lMin = qLearnMin(q);
        if (hVal === '6plus' && lMin < 6) return false;
        if (hVal === '10plus' && lMin < 10) return false;
        if (hVal === '15plus' && lMin < 15) return false;
        if (hVal === 'under6' && lMin >= 6) return false;

        const st = rec?.status || 'not_started';
        if (sVal === 'unfinished') {
          if (st === 'done') return false;
        } else if (sVal === 'due_fsrs') {
          if (!(rec?.fsrs?.due && rec.fsrs.due <= nowIso)) return false;
        } else if (sVal !== 'all' && st !== sVal) {
          return false;
        }
        if (qTerm) {
          const hay = `${q.localId || ''} ${q.title || ''} ${q.promptMarkdown || ''} ${q.contextMarkdown || ''} ${q.searchText || ''} ${(q.tags || []).join(' ')}`.toLowerCase();
          if (!hay.includes(qTerm)) return false;
        }
        return true;
      });

      const smartBucket = (q) => {
        const r = getProgressRecord(q.id) || {};
        const st = r.status || 'not_started';
        const isDue = r.fsrs?.due && r.fsrs.due <= nowIso;
        if (st === 'revisit') return 0;
        if (st === 'in_progress') return 1;
        if (isDue) return 2;
        if (st === 'not_started') return 3;
        return 4;
      };

      if (sortVal === 'deep_first') {
        filtered.sort((a, b) => {
          const da = effectiveDlpfc(a).tier;
          const db = effectiveDlpfc(b).tier;
          if (da !== db) return db - da;
          const ba = smartBucket(a);
          const bb = smartBucket(b);
          if (ba !== bb) return ba - bb;
          return qActiveMin(b) - qActiveMin(a);
        });
        if (tVal === 'all') {
          filtered = interleaveByTopic(filtered, (q) => `${effectiveDlpfc(q).tier}:${smartBucket(q)}`);
        }
      } else if (sortVal === 'horizon_desc') {
        filtered.sort((a, b) => qActiveMin(b) - qActiveMin(a) || effectiveDlpfc(b).tier - effectiveDlpfc(a).tier);
      } else if (sortVal === 'diff_desc') {
        filtered.sort((a, b) => effectiveDlpfc(b).tier - effectiveDlpfc(a).tier || qActiveMin(b) - qActiveMin(a));
      } else if (sortVal === 'smart_priority') {
        filtered.sort((a, b) => smartBucket(a) - smartBucket(b) || effectiveDlpfc(b).tier - effectiveDlpfc(a).tier);
        if (tVal === 'all') {
          filtered = interleaveByTopic(filtered, (q) => `${smartBucket(q)}:${effectiveDlpfc(q).tier}`);
        }
      } else if (sortVal === 'horizon_asc') {
        filtered.sort((a, b) => qActiveMin(a) - qActiveMin(b));
      }

      return filtered;
    };

    const buildRunIds = (matches) => {
      const prof = document.getElementById('flt-profile').value;
      const spec = document.getElementById('flt-budget').value;
      let list = [...matches];
      if (document.getElementById('flt-shuffle').checked && spec !== 'exam_sim') {
        list = shuffleArray(list);
      }
      if (spec.startsWith('count:')) {
        list = list.slice(0, Number(spec.split(':')[1]));
      } else if (spec.startsWith('budget:')) {
        const bMin = Number(spec.split(':')[1]);
        const picked = [];
        let acc = 0;
        for (const q of list) {
          const m = Number(q.pacing?.[prof]?.target || 4);
          if (picked.length && acc + m > bMin * 1.28) {
            if (picked.length >= (acc >= bMin * 0.65 ? 1 : 2)) break;
            continue;
          }
          picked.push(q);
          acc += m;
          if (acc >= bMin * 0.92) break;
        }
        if (!picked.length && list.length) picked.push(list[0]);
        list = picked;
      }
      const estMin = list.reduce((s, q) => s + Number(q.pacing?.[prof]?.target || 4), 0);
      const isExamSim = spec === 'exam_sim';
      return {
        list,
        estMin,
        mode: isExamSim ? 'exam' : 'practice',
        examStyle: isExamSim ? 'blind' : 'guided',
        prof: isExamSim ? 'exam' : prof,
      };
    };

    const refreshTable = () => {
      const matches = getMatching();
      const { list, estMin } = buildRunIds(matches);
      document.getElementById('flt-summary-lbl').textContent = `${list.length} in run (of ${matches.length} matching) · ~${Math.round(estMin)}m AI Par`;

      const tbody = document.getElementById('exp-table-body');
      tbody.innerHTML = matches
        .slice(0, 350)
        .map((q) => {
          const rec = getProgressRecord(q.id);
          const st = rec?.status || 'not_started';
          const lp = q.pacing?.learning?.target ?? '—';
          const ep = q.pacing?.exam?.target ?? '—';
          const pb = rec?.pbEffectiveSec ? `${clockSec(rec.pbEffectiveSec)}${rec.beatAiCount ? ' · Par' : ''}` : '—';
          const hasWf = Array.isArray(q.wiseflowFields) && q.wiseflowFields.length > 0;
          const kindBadge = hasWf
            ? `<span class="badge live" style="font-size:11px">Worksheet</span>`
            : `<small>${esc(q.kind)}</small>`;
          const dlpfc = effectiveDlpfc(q, rec);
          const diffBadge = `<span class="diff-badge diff-${dlpfc.tier}" data-layout-tier="${dlpfc.tier}"${dlpfc.chunked
            ? ' title="Previously mastered problem with fewer new steps"' : ''}>${window.StudyLayout.label(dlpfc.tier)}</span>`;
          return `<tr>
            <td><strong>${esc(q.title)}</strong><br><small class="muted">${esc(q.localId || q.id)}</small></td>
            <td><span class="badge">T${esc(q.topicId)}</span></td>
            <td>${diffBadge}</td>
            <td>${kindBadge}</td>
            <td><small><b>${lp}m</b> / ${ep}m</small></td>
            <td><small>${pb}</small></td>
            <td>
              <div class="status-group">
                <button type="button" class="st-btn ${st === 'not_started' ? 'active-not_started' : ''}" data-row-qid="${esc(q.id)}" data-row-st="not_started" title="Mark Uncomplete">○</button>
                <button type="button" class="st-btn ${st === 'in_progress' ? 'active-in_progress' : ''}" data-row-qid="${esc(q.id)}" data-row-st="in_progress" title="In Progress">◐</button>
                <button type="button" class="st-btn ${st === 'done' ? 'active-done' : ''}" data-row-qid="${esc(q.id)}" data-row-st="done" title="Done">✓</button>
                <button type="button" class="st-btn ${st === 'revisit' ? 'active-revisit' : ''}" data-row-qid="${esc(q.id)}" data-row-st="revisit" title="Revisit">⚑</button>
              </div>
            </td>
            <td><button type="button" class="ghost-btn" style="padding:4px 10px;font-size:12px" data-solo-qid="${esc(q.id)}">Practice →</button></td>
          </tr>`;
        })
        .join('');

      tbody.querySelectorAll('[data-row-st]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await setQuestionStatus([btn.dataset.rowQid], btn.dataset.rowSt, false);
          refreshTable();
        });
      });

      tbody.querySelectorAll('[data-solo-qid]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const prof = document.getElementById('flt-profile').value;
          window.StudyRunner.startRun({
            courseMeta: cMeta,
            bank,
            questionIds: [btn.dataset.soloQid],
            mode: 'practice',
            profile: prof,
          });
        });
      });
    };

    root.querySelectorAll('[data-exp-preset]').forEach((chip) => {
      chip.addEventListener('click', () => {
        applyPreset(chip.dataset.expPreset);
        refreshTable();
      });
    });

    members.bindDownloads(root);
    const fileSearch = root.querySelector('#member-file-search');
    if (fileSearch) fileSearch.oninput = () => {
      const query = fileSearch.value.trim().toLowerCase();
      for (const group of root.querySelectorAll('.course-document-group')) {
        let any = false;
        for (const file of group.querySelectorAll('li')) {
          file.hidden = !file.textContent.toLowerCase().includes(query);
          any ||= !file.hidden;
        }
        group.hidden = !any;
        if (query && any) group.open = true;
      }
    };
    root.querySelectorAll('[data-practice-topic]').forEach((button) => {
      button.addEventListener('click', () => {
        const topic = document.getElementById('flt-topic');
        topic.value = button.dataset.practiceTopic;
        topic.dispatchEvent(new Event('change'));
        button.closest('details').open = false;
        topic.focus();
      });
    });
    document.getElementById('exp-course-sel').onchange = (e) => renderCourseExplorer(e.target.value, initialPreset);
    document.getElementById('exp-open-exams').onclick = () => navigate('exams', { focusCourseId: courseId });
    document.getElementById('exp-open-ref').onclick = () => openReferenceDrawer(cMeta);
    for (const id of ['flt-topic', 'flt-coll', 'flt-kind', 'flt-diff', 'flt-horizon', 'flt-status', 'flt-sort', 'flt-profile', 'flt-budget', 'flt-shuffle']) {
      document.getElementById(id).onchange = refreshTable;
    }
    document.getElementById('flt-search').oninput = refreshTable;

    if (initialPreset) {
      applyPreset(initialPreset);
    }

    document.getElementById('btn-start-filtered').onclick = () => {
      const matches = getMatching();
      const { list, estMin, mode, examStyle, prof } = buildRunIds(matches);
      window.StudyRunner.startRun({
        courseMeta: cMeta,
        bank,
        questionIds: list.map((q) => q.id),
        mode,
        examStyle,
        durationMinutes: Math.max(15, Math.round(estMin)),
        profile: prof,
      });
    };

    document.getElementById('btn-bulk-uncomplete').onclick = async () => {
      const matches = getMatching();
      if (!matches.length) return;
      if (!confirm(`Mark ${matches.length} matching exercise(s) as Uncomplete (Not Started)?`)) return;
      await setQuestionStatus(matches.map((q) => q.id), 'not_started', false);
      toast(`Marked ${matches.length} task(s) uncomplete.`);
      refreshTable();
    };

    document.getElementById('btn-bulk-revisit').onclick = async () => {
      const matches = getMatching();
      if (!matches.length) return;
      await setQuestionStatus(matches.map((q) => q.id), 'revisit', false);
      toast(`Flagged ${matches.length} task(s) for revisit.`);
      refreshTable();
    };

    refreshTable();
  }

  // ---------------------------------------------------------------------------
  // VIEW 4: METRICS, SUBGROUPS, CORRELATIONS & COPYABLE AI BRIEF
  // ---------------------------------------------------------------------------
  function renderAnalytics() {
    const root = document.getElementById('analytics-root');
    const a = boot.analytics || {};
    const ov = a.overall || {};
    const sub = a.subgroups || {};

    const subgroupRows = (obj, labelFn) => {
      const entries = Object.entries(obj || {});
      if (!entries.length) return '<tr><td colspan="6" class="muted">No timed attempts recorded yet.</td></tr>';
      return entries
        .map(
          ([k, v]) => `<tr>
          <td><strong>${esc(labelFn(k))}</strong></td>
          <td>${v.count}</td>
          <td><b>${v.upi ?? '—'}</b></td>
          <td>${v.avgAccuracy != null ? Math.round(v.avgAccuracy * 100) + '%' : '—'}</td>
          <td>${v.beatAiRate != null ? Math.round(v.beatAiRate * 100) + '%' : '—'}</td>
          <td>${v.totalActiveMinutes}m</td>
        </tr>`
        )
        .join('');
    };

    const courseNameMap = Object.fromEntries(boot.catalog.map((c) => [c.courseId, `${c.code} · ${c.shortTitle}`]));
    const slotNames = {
      morning_06_12: 'Morning (06:00–12:00)',
      afternoon_12_17: 'Afternoon (12:00–17:00)',
      evening_17_23: 'Evening (17:00–23:00)',
      night_23_06: 'Night (23:00–06:00)',
    };
    const dlpfcNames = {
      high_3: 'Hard',
      med_2: 'Medium',
      low_1: 'Easy',
    };
    const db = a.dlpfcBudget || {};

    const corrHtml = (a.correlations || [])
      .map(
        (c) => `<div class="metric-tile">
          <small>${esc(c.label)}</small>
          <p style="margin:6px 0 0;font-weight:600;font-size:14px">${esc(c.summary)}</p>
        </div>`
      )
      .join('');

    const aiBriefText = buildAiCoachBrief();

    root.innerHTML = `
      <div class="section-heading" style="margin-top:0">
        <div>
          <span class="eyebrow">Universal &amp; Subgroup Telemetry</span>
          <h2>Productivity Index, Study time &amp; Focus Telemetry</h2>
        </div>
      </div>

      <div class="metrics-grid">
        <div class="metric-tile"><small>All-Time UPI</small><b>${ov.upi ?? '—'}</b><small>${a.totalAttempts || 0} verified attempts</small></div>
        <div class="metric-tile"><small>Last 7 Days UPI</small><b>${a.last7Days?.upi ?? '—'}</b><small>${a.last7Days?.totalActiveMinutes || 0}m active</small></div>
        <div class="metric-tile"><small>Hard Today</small><b>${((db.todayHighMinutes || 0) / 60).toFixed(1)}h / 4.5h</b><small>${Math.round(db.remainingHighMinutes ?? 270)}m novel budget left</small></div>
        <div class="metric-tile"><small>Screen Time Today</small><b>${esc(window.StudyUI.workClock?.getScreenStats?.()?.screenLabel || `${a.today?.totalActiveMinutes || 0}m`)}</b><small>${esc(window.StudyUI.workClock?.getScreenStats?.()?.offScreenLabel || `${db.todayAwayMinutes || 0}m`)} off-screen · ${db.todayFocusSwitches || 0} focus sw.</small></div>
      </div>

      <div class="panel">
        <span class="eyebrow">Subjective Check-In ↔ Objective UPI</span>
        <h3>Personal Performance Correlations</h3>
        <div class="metrics-grid" style="margin-top:12px">${corrHtml || '<p class="muted">Log 3+ check-in sessions to unlock automatic state-to-UPI correlations.</p>'}</div>
      </div>

      <div class="courses-grid" style="margin-bottom:18px">
        <div class="panel" style="margin:0">
          <h3>UPI by Course</h3>
          <div class="task-table-wrap">
            <table class="task-table">
              <thead><tr><th>Course</th><th>Qs</th><th>UPI</th><th>Acc</th><th>Beat AI</th><th>Time</th></tr></thead>
              <tbody>${subgroupRows(sub.byCourse, (k) => courseNameMap[k] || k)}</tbody>
            </table>
          </div>
        </div>

        <div class="panel" style="margin:0">
          <h3>UPI by difficulty, Format &amp; Time</h3>
          <div class="task-table-wrap">
            <table class="task-table">
              <thead><tr><th>Subgroup</th><th>Qs</th><th>UPI</th><th>Acc</th><th>Beat AI</th><th>Time</th></tr></thead>
              <tbody>
                ${subgroupRows(sub.byDlpfcTier, (k) => dlpfcNames[k] || k)}
                ${subgroupRows(sub.byKind, (k) => `Format: ${k.toUpperCase()}`)}
                ${subgroupRows(sub.byTimeSlot, (k) => slotNames[k] || k)}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="row-between" style="margin-top:0">
          <div>
            <span class="eyebrow">Instant LLM Context</span>
            <h3>AI Coach &amp; Session Brief</h3>
            <small class="muted">Local agents (Antigravity / Codex / Claude) automatically read <code>Study-OS/data/logs/ai_context_snapshot.json</code>. Or copy this brief into any chat:</small>
          </div>
          <button type="button" class="primary-btn" id="btn-copy-ai-brief">Copy AI Brief</button>
        </div>
        <textarea id="txt-ai-brief" readonly style="font-family:ui-monospace,monospace;font-size:12.5px;min-height:220px;margin-top:10px">${esc(aiBriefText)}</textarea>
      </div>
    `;

    document.getElementById('btn-copy-ai-brief')?.addEventListener('click', async () => {
      const txt = document.getElementById('txt-ai-brief').value;
      try {
        await navigator.clipboard.writeText(txt);
        toast('Copied AI Coach Brief to clipboard!');
      } catch {
        document.getElementById('txt-ai-brief').select();
        document.execCommand('copy');
        toast('Copied AI Coach Brief!');
      }
    });
  }

  function buildAiCoachBrief() {
    const a = boot.analytics || {};
    const ov = a.overall || {};
    const db = a.dlpfcBudget || {};
    const lines = [
      'STUDY-OS — LIVE STUDENT TELEMETRY & PROGRESS BRIEF',
      `Generated: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/Oslo' })} (Europe/Oslo)`,
      `Canonical Data Path: Study-OS/data/logs/ai_context_snapshot.json`,
      '',
      `OVERALL METRICS & COGNITIVE BUDGET:`,
      `- Universal Productivity Index (UPI): ${ov.upi ?? 'N/A'} (7-day: ${a.last7Days?.upi ?? 'N/A'})`,
      `- Verified Attempts: ${a.totalAttempts || 0} | Accuracy: ${ov.avgAccuracy != null ? Math.round(ov.avgAccuracy * 100) + '%' : 'N/A'} | Beat AI Par: ${ov.beatAiRate != null ? Math.round(ov.beatAiRate * 100) + '%' : 'N/A'}`,
      `- Today Difficulty: High=${db.todayHighMinutes || 0}m / 270m cap, Med=${db.todayMedMinutes || 0}m, Low=${db.todayLowMinutes || 0}m | Focus Switches=${db.todayFocusSwitches || 0} (${db.todayAwayMinutes || 0}m away)`,
      `- Active Streak: ${a.streakDays || 0} day(s) | Logged Sessions: ${a.totalSessions || 0}`,
      '',
      'COURSE COMPLETION & UPI:',
    ];
    for (const c of boot.catalog) {
      const cp = a.courseProgress?.[c.courseId] || {};
      const cm = a.subgroups?.byCourse?.[c.courseId] || {};
      lines.push(
        `- ${c.code} ${c.shortTitle}: ${cp.done || 0}/${cp.total || c.questionCount} done, ${cp.revisit || 0} revisit, ${cp.dueFsrs || 0} due FSRS | UPI: ${cm.upi ?? '—'}`
      );
    }
    if ((a.weakTopics || []).length) {
      lines.push('', 'TOP FLAGGED / REVISIT TOPICS:');
      for (const w of a.weakTopics.slice(0, 6)) {
        lines.push(`- ${w.courseTitle} · ${w.topicTitle}: ${w.revisitCount} item(s) to revisit`);
      }
    }
    if ((a.correlations || []).length) {
      lines.push('', 'CHECK-IN CORRELATIONS:');
      for (const c of a.correlations) lines.push(`- ${c.label}: ${c.summary}`);
    }
    if ((boot.recentSessions || []).length) {
      lines.push('', 'RECENT STUDY SESSIONS & MICRO-JOURNAL:');
      for (const s of boot.recentSessions.slice(0, 6)) {
        const ci = s.checkIn || {};
        lines.push(
          `- [${(s.endedAt || '').slice(0, 16)}] ${s.courseId} | ${s.reviewedCount} Qs | UPI ${s.upi ?? '—'} | Focus=${ci.focus ?? '-'} Energy=${ci.energy ?? '-'} Inertia=${ci.startInertia ?? '-'} | Tags: ${(ci.tags || []).join(', ') || '-'} | Note: ${ci.note || '-'}`
        );
      }
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // VIEW 5: MULTI-SEMESTER REFERENCE HUB (Obsidian Reference Sheets + SVG + KaTeX)
  // ---------------------------------------------------------------------------
  async function renderReferencesHub(initialFile = '', initialHeading = '') {
    const root = document.getElementById('references-hub-root');
    const refs = boot.references || [];
    if (!refs.length) {
      root.innerHTML = `
        <div class="panel">
          <span class="eyebrow">Multi-Semester Reference Library</span>
          <h2>No Reference Sheets Found Yet</h2>
          <p class="muted">Place Markdown reference notes inside your sibling <code>Obsidian Vault</code> (or link <code>obsidian.mainReference</code> in any course <code>bank.json</code>) to read and share them across semesters.</p>
        </div>
      `;
      return;
    }

    const semesters = [...new Set(refs.map((r) => r.semester || 'Reference Library'))];
    const filteredRefs =
      selectedRefSemester === 'all' ? refs : refs.filter((r) => (r.semester || 'Reference Library') === selectedRefSemester);
    const activeEntry = filteredRefs.find((r) => r.file === selectedRefFile) || filteredRefs[0];
    if (activeEntry) selectedRefFile = activeEntry.file;

    root.innerHTML = `
      <div class="hero-card" style="margin-bottom:16px">
        <div class="row-between" style="margin:0;gap:14px;flex-wrap:wrap">
          <div>
            <span class="eyebrow">Canonical Semester Reference Sheets</span>
            <h1 class="hero-title" style="margin:2px 0 4px">Multi-Semester Reference Hub</h1>
            <p class="muted" style="margin:0;font-size:13.5px">Complete formula sheets, SVG diagrams, exam rules, and model derivations organized semester-by-semester.</p>
          </div>
          <div class="row-actions">
            <select id="ref-hub-sem-sel" style="padding:8px 12px;font-weight:600">
              <option value="all">All Semesters (${refs.length})</option>
              ${semesters
                .map((s) => `<option value="${esc(s)}" ${selectedRefSemester === s ? 'selected' : ''}>${esc(s)}</option>`)
                .join('')}
            </select>
            <input type="search" id="ref-hub-search" placeholder="Search sections or formulas…" style="min-width:210px">
          </div>
        </div>
      </div>

      <div class="ref-hub-layout">
        <aside class="ref-sidebar" id="ref-hub-sidebar">
          ${filteredRefs
            .map(
              (r) => `
            <div class="ref-note-card ${r.file === selectedRefFile ? 'active' : ''}" data-ref-card="${esc(r.file)}">
              <div class="row-between" style="margin:0 0 3px">
                <span class="eyebrow" style="color:${esc(r.color)};margin:0">${esc(r.code)} · ${esc(r.semester)}</span>
                <small class="muted">${r.headingCount || 0} sec</small>
              </div>
              <button type="button" class="ref-note-title" data-ref-pick="${esc(r.file)}"${r.file === selectedRefFile ? ' aria-current="true"' : ''}>${esc(r.title)}</button>
              <div class="row-actions" style="margin-top:8px;gap:6px">
                ${
                  r.courseId
                    ? `<button type="button" class="primary-btn" style="padding:4px 10px;font-size:12px" data-ref-practice="${esc(r.courseId)}">Practice (${r.questionCount}) →</button>`
                    : ''
                }
                ${
                  !isStaticWeb && r.obsidianUri
                    ? `<a class="ghost-btn" style="padding:4px 9px;font-size:12px" href="${esc(r.obsidianUri)}" onclick="event.stopPropagation()">Obsidian ↗</a>`
                    : ''
                }
              </div>
            </div>`
            )
            .join('')}
        </aside>

        <div class="ref-reader-pane">
          <div class="row-between" style="margin:0 0 14px;padding-bottom:12px;border-bottom:1px solid var(--line)">
            <div>
              <span class="eyebrow" id="ref-pane-eyebrow">${esc(activeEntry?.code || '')} · ${esc(activeEntry?.semester || '')}</span>
              <h2 id="ref-pane-title" style="margin:2px 0 0">${esc(activeEntry?.title || 'Reference')}</h2>
            </div>
            <div class="row-actions">
              <select id="ref-pane-doc-sel" aria-label="Reference document" style="max-width:210px;font-size:13px"></select>
              <select id="ref-pane-toc-sel" aria-label="Reference section" style="max-width:260px;font-size:13px"></select>
            </div>
          </div>
          <div id="ref-pane-body" class="markdown-body"><p class="muted">Loading reference sheet…</p></div>
        </div>
      </div>
    `;

    const loadReader = async (entry, fileOverride = '', heading = '') => {
      if (!entry) return;
      const targetDoc = fileOverride || entry.file;
      const docSel = document.getElementById('ref-pane-doc-sel');
      const tocSel = document.getElementById('ref-pane-toc-sel');
      const bodyEl = document.getElementById('ref-pane-body');
      const docs = [{ label: 'Main Reference Sheet', file: entry.file }, ...(entry.companions || [])];
      docSel.hidden = docs.length <= 1;
      docSel.innerHTML = docs
        .map((d) => `<option value="${esc(d.file)}" ${d.file === targetDoc ? 'selected' : ''}>${esc(d.label)}</option>`)
        .join('');

      bodyEl.innerHTML = '<p class="muted">Loading section…</p>';
      try {
        const res = await fetchReferenceSection(targetDoc, heading);
        if (!res.available) {
          bodyEl.innerHTML = `<p class="muted">${esc(res.error || 'Reference unavailable.')}</p>`;
          return;
        }
        tocSel.innerHTML =
          `<option value="">— Full Reference Sheet —</option>` +
          (res.toc || [])
            .map((h) => {
              const pad = '· '.repeat(Math.max(0, h.level - 1));
              return `<option value="${esc(h.title)}" ${res.selectedHeading === h.title ? 'selected' : ''}>${pad}${esc(h.title)}</option>`;
            })
            .join('');
        bodyEl.innerHTML = window.StudyUI.renderMarkdownWithMath(res.markdown);
      } catch {
        bodyEl.innerHTML = '<p class="muted">Could not load reference content.</p>';
      }

      docSel.onchange = () => loadReader(entry, docSel.value, '');
      tocSel.onchange = () => loadReader(entry, docSel.value, tocSel.value);
    };

    document.getElementById('ref-hub-sem-sel').onchange = (e) => {
      selectedRefSemester = e.target.value;
      renderReferencesHub();
    };

    document.getElementById('ref-hub-search').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      root.querySelectorAll('[data-ref-card]').forEach((card) => {
        const rf = refs.find((x) => x.file === card.dataset.refCard);
        const hay = `${rf?.code || ''} ${rf?.title || ''} ${(rf?.headings || []).join(' ')}`.toLowerCase();
        card.hidden = !!q && !hay.includes(q);
      });
    };

    root.querySelectorAll('[data-ref-pick]').forEach((card) => {
      card.addEventListener('click', () => {
        selectedRefFile = card.dataset.refPick;
        renderReferencesHub();
      });
    });

    root.querySelectorAll('[data-ref-practice]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate('course', { courseId: btn.dataset.refPractice });
      });
    });
    await loadReader(activeEntry, initialFile, initialHeading);
  }

  // ---------------------------------------------------------------------------
  // VIEW 6: SCHEDULE STUDIO (TimeEdit .ics + Work Hours Auto-Adjuster + Any-LLM Importer)
  // ---------------------------------------------------------------------------
  function computeClientStudyEstimate(workH, classH, courseCount) {
    const w = Math.max(0, Math.min(60, Number(workH) || 0));
    const c = Math.max(0, Math.min(35, Number(classH) || 0));
    const baseAcad = Math.max(12, Math.min(42, Math.max(1, courseCount) * 8));
    const rawSelf = Math.max(6, baseAcad - c);
    const penalty = Math.max(0, w - 6) * 0.6;
    const rec = Math.round(Math.max(5, Math.min(36, rawSelf - penalty)) * 10) / 10;
    return {
      recommendedStudyHours: rec,
      weeklyWorkHours: w,
      weeklyClassHours: Math.round(c * 10) / 10,
      totalCommittedHours: Math.round((w + c + rec) * 10) / 10,
    };
  }

  function parseClientSchedulePayload(rawText) {
    let cleaned = String(rawText || '').trim();
    if (!cleaned) throw new Error('Paste JSON or .ics output first.');
    const fence = cleaned.match(/```(?:json|ics|icalendar|calendar)?\s*([\s\S]+?)```/i);
    if (fence) cleaned = fence[1].trim();

    // Parse .ics client-side if in Hosted Static Mode
    if (/BEGIN:V(?:CALENDAR|EVENT)/i.test(cleaned)) {
      const unfolded = cleaned.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
      const out = [];
      let cur = null;
      for (const line of unfolded) {
        if (line.trim() === 'BEGIN:VEVENT') cur = {};
        else if (line.trim() === 'END:VEVENT' && cur?.DTSTART && cur?.SUMMARY) {
          const toIso = (s) => {
            const m = s.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/);
            if (!m) return null;
            return m[7] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
          };
          const sIso = toIso(cur.DTSTART);
          const eIso = toIso(cur.DTEND || cur.DTSTART);
          if (sIso) {
            const sd = new Date(sIso);
            const ed = eIso ? new Date(eIso) : new Date(sd.getTime() + 50 * 60000);
            const dur = Math.max(15, Math.round((ed - sd) / 60000));
            const matchCourse = (boot.catalog || []).find((c) =>
              cur.SUMMARY.toLowerCase().includes((c.code || '').toLowerCase()) ||
              cur.SUMMARY.toLowerCase().includes((c.shortTitle || '').toLowerCase())
            );
            out.push({
              eventId: `web-ics-${out.length + 1}`,
              summary: cur.SUMMARY,
              date: sd.toISOString().slice(0, 10),
              startIso: sd.toISOString(),
              endIso: ed.toISOString(),
              startLabel: sd.toTimeString().slice(0, 5),
              endLabel: ed.toTimeString().slice(0, 5),
              focusMinutes: dur,
              attemptBudgetMinutes: Math.round(dur * 0.85),
              courseId: matchCourse?.courseId || boot.catalog[0]?.courseId || '',
              blockKind: 'study_block',
              timingState: 'upcoming',
            });
          }
          cur = null;
        } else if (cur && line.includes(':')) {
          const [k, ...rest] = line.split(':');
          cur[k.split(';')[0].toUpperCase()] = rest.join(':').trim();
        }
      }
      if (!out.length) throw new Error('No valid VEVENT items found in .ics text.');
      return out;
    }

    const firstIdx = [cleaned.indexOf('{'), cleaned.indexOf('[')].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (firstIdx > 0) cleaned = cleaned.slice(firstIdx);
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed) ? parsed : parsed.blocks || parsed.events || [];
    if (!arr.length) throw new Error('JSON must contain a non-empty "blocks" array.');
    return arr.map((b, idx) => {
      const sIso = b.start?.includes('T') ? b.start : `${b.date}T${b.startTime || b.start || '09:00'}:00`;
      const sd = new Date(sIso);
      const dur = Number(b.durationMinutes || b.focusMinutes || 50);
      const ed = b.end?.includes('T') ? new Date(b.end) : new Date(sd.getTime() + dur * 60000);
      return {
        eventId: b.id || `web-llm-${idx + 1}`,
        summary: b.title || b.summary || `Study Block ${idx + 1}`,
        date: sd.toISOString().slice(0, 10),
        startIso: sd.toISOString(),
        endIso: ed.toISOString(),
        startLabel: sd.toTimeString().slice(0, 5),
        endLabel: ed.toTimeString().slice(0, 5),
        focusMinutes: dur,
        attemptBudgetMinutes: Math.round(dur * 0.85),
        courseId: b.courseId || boot.catalog[0]?.courseId || '',
        topicIds: b.topicIds || [],
        blockKind: b.blockType === 'lecture' ? 'class_session' : 'study_block',
        timingState: 'upcoming',
      };
    });
  }

  function buildUniversalLlmSchedulePrompt(prefs, customNotes = '') {
    const todayIso = new Date().toISOString().slice(0, 10);
    const coursesTxt = (boot.catalog || [])
      .map((c) => {
        const cp = boot.analytics?.courseProgress?.[c.courseId] || {};
        return `- courseId: "${c.courseId}" | ${c.code} · ${c.title} | Exam: ${c.examInfo?.date || 'TBD'} | Done: ${cp.done || 0}/${c.questionCount}`;
      })
      .join('\n');

    const fixedClasses = (boot.calendar?.blocks || [])
      .filter((b) => b.blockKind === 'class_session' || b.blockKind === 'exam')
      .slice(0, 20)
      .map((b) => `- ${b.date} ${b.startLabel}-${b.endLabel}: ${b.summary}`)
      .join('\n');

    const est = computeClientStudyEstimate(prefs.weeklyWorkHours || 0, 8, boot.catalog.length || 4);
    const targetH = prefs.autoAdjustStudy !== false ? est.recommendedStudyHours : prefs.targetStudyHours || 25;

    return [
      `Design an optimal, sustainable 7-day study schedule starting ${todayIso} in Universal Study-OS Calendar JSON format.`,
      '',
      'STUDENT CONSTRAINTS & COGNITIVE RULES:',
      `- Part-time job hours/week: ${prefs.weeklyWorkHours || 0}h -> Target self-study budget: ~${targetH}h/week`,
      `- Preferred daily study window: ${String(prefs.dayStartHour || 8).padStart(2, '0')}:00 to ${String(prefs.dayEndHour || 19).padStart(2, '0')}:00 (${prefs.blockMinutes || 50}m focus / ${prefs.breakMinutes || 10}m off-screen break)`,
      '- Circadian routing: schedule heavy quantitative/coding synthesis BEFORE 15:00 (Hard), procedural drills 15:00-18:00 (Medium), and light recall/MCQ review after 18:00 (Easy).',
      customNotes ? `- Personal constraints / shifts / preferences: ${customNotes}` : '',
      '',
      'ACTIVE COURSES (use exact courseId strings):',
      coursesTxt || '- courseId: "demo-101" | Demo Course',
      '',
      fixedClasses ? `FIXED LECTURES / TIMETABLE TO SCHEDULE AROUND:\n${fixedClasses}\n` : '',
      'OUTPUT ONLY VALID JSON MATCHING THIS EXACT SCHEMA (no prose outside the JSON code block):',
      '```json',
      '{',
      '  "format": "study-os-schedule-v1",',
      '  "blocks": [',
      '    {',
      `      "date": "${todayIso}",`,
      '      "startTime": "09:00",',
      '      "endTime": "09:50",',
      `      "courseId": "${boot.catalog[0]?.courseId || 'demo-101'}",`,
      '      "title": "Hard Deep Problem Block (50/10)",',
      '      "profile": "learning"',
      '    }',
      '  ]',
      '}',
      '```',
    ]
      .filter(Boolean)
      .join('\n');
  }

  function renderScheduleStudio() {
    const root = document.getElementById('schedule-studio-root');
    const cfg = boot.scheduleConfig || {};
    const prefs = {
      timeeditUrl: '',
      weeklyWorkHours: 0,
      autoAdjustStudy: true,
      targetStudyHours: 28,
      dayStartHour: 8,
      dayEndHour: 19,
      blockMinutes: 50,
      breakMinutes: 10,
      restDays: [6],
      courseWeights: {},
      ...(cfg.prefs || {}),
    };
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const classBlocksCount = (boot.calendar?.blocks || []).filter((b) => b.blockKind === 'class_session').length;
    const approxWeeklyClassH = classBlocksCount ? Math.round((classBlocksCount * 1.75) / 2) : 8;
    const est = cfg.estimate || computeClientStudyEstimate(prefs.weeklyWorkHours, approxWeeklyClassH, boot.catalog.length || 4);

    const courseWeightRows = (boot.catalog || [])
      .map((c) => {
        const w = prefs.courseWeights?.[c.courseId] ?? 1.0;
        return `
          <label class="field-label" style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:6px">
            <span><strong>${esc(c.code)}</strong> · ${esc(c.shortTitle)}</span>
            <select data-course-weight="${esc(c.courseId)}" style="width:145px;padding:5px 8px;font-size:12.5px">
              <option value="0.5" ${Number(w) === 0.5 ? 'selected' : ''}>0.5× Light</option>
              <option value="1" ${Number(w) === 1 ? 'selected' : ''}>1.0× Balanced</option>
              <option value="1.5" ${Number(w) === 1.5 ? 'selected' : ''}>1.5× High Priority</option>
              <option value="2" ${Number(w) === 2 ? 'selected' : ''}>2.0× Exam Sprint</option>
            </select>
          </label>`;
      })
      .join('');

    const upcomingBlocks = (boot.calendar?.blocks || []).filter((b) => b.timingState !== 'past').slice(0, 24);

    root.innerHTML = `
      <div class="hero-card" style="margin-bottom:18px">
        <div class="row-between" style="margin:0;flex-wrap:wrap;gap:12px">
          <div>
            <span class="eyebrow">TimeEdit (.ics) × Work-Load Adjuster × Universal LLM Calendar</span>
            <h1 class="hero-title" style="margin:2px 0 4px">Adaptive Schedule Studio</h1>
            <p class="muted" style="margin:0;font-size:13.5px">
              Active calendar source: <code>${esc(boot.calendar?.source || 'none')}</code> · Paste your TimeEdit link + weekly work hours for instant auto-scheduling, or use 1-Prompt Copy/Paste with any LLM.
            </p>
          </div>
          <div class="row-actions">
            ${!isStaticWeb ? '<a class="ghost-btn" href="/api/schedule/export.ics" download="study-os-schedule.ics">Export .ics Calendar</a>' : ''}
            ${cfg.enabled ? '<button type="button" class="ghost-btn" id="btn-reset-custom-sched">Revert to Default Calendar</button>' : ''}
          </div>
        </div>
      </div>

      <div class="schedule-studio-grid">
        <!-- PANEL A: TIMEEDIT + WORK HOURS AUTO-SCHEDULER -->
        <section class="panel" style="margin:0">
          <span class="eyebrow">Option 1 · Instant Algorithmic Scheduler</span>
          <h3 style="margin:4px 0 10px">TimeEdit Link + Weekly Work Hours</h3>

          <label class="field-label">TimeEdit Subscription URL (<code>.ics</code>) ${isStaticWeb ? '<small class="muted">(or upload .ics file below)</small>' : ''}
            <input type="url" id="sch-te-url" value="${esc(prefs.timeeditUrl || '')}" placeholder="https://cloud.timeedit.net/.../ri....ics">
          </label>

          <label class="field-label" style="margin-top:8px">Or Upload Saved TimeEdit / Calendar <code>.ics</code> File
            <input type="file" id="sch-ics-file" accept=".ics,text/calendar" style="font-size:12.5px">
          </label>

          <div class="filter-grid" style="margin-top:12px;grid-template-columns:1fr 1fr">
            <label class="field-label">Hours Worked / Week (Job)
              <input type="number" id="sch-work-h" min="0" max="50" step="1" value="${Number(prefs.weeklyWorkHours || 0)}">
            </label>
            <label class="field-label">Target Self-Study Hours / Week
              <input type="number" id="sch-study-h" min="4" max="45" step="1" value="${Number(prefs.targetStudyHours || est.recommendedStudyHours)}" ${prefs.autoAdjustStudy !== false ? 'disabled' : ''}>
            </label>
          </div>

          <label style="display:inline-flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;cursor:pointer">
            <input type="checkbox" id="sch-auto-adjust" ${prefs.autoAdjustStudy !== false ? 'checked' : ''}>
            <span><strong>Auto-adjust study hours</strong> from weekly job hours &amp; lecture load</span>
          </label>

          <div class="estimate-callout" id="sch-estimate-box">
            <strong>Rough Weekly Load Estimate:</strong>
            Job <b>${est.weeklyWorkHours}h</b> + Lectures <b>~${est.weeklyClassHours}h</b> → Recommended Deep Study: <b>${est.recommendedStudyHours}h/wk</b> (Total committed: <b>${est.totalCommittedHours}h/wk</b>)
          </div>

          <div class="filter-grid" style="grid-template-columns:1fr 1fr 1fr">
            <label class="field-label">Start Hour
              <input type="number" id="sch-start-h" min="6" max="14" value="${Number(prefs.dayStartHour || 8)}">
            </label>
            <label class="field-label">End Hour
              <input type="number" id="sch-end-h" min="15" max="23" value="${Number(prefs.dayEndHour || 19)}">
            </label>
            <label class="field-label">Block Rhythm
              <select id="sch-rhythm">
                <option value="50:10" ${Number(prefs.blockMinutes) === 50 ? 'selected' : ''}>50m / 10m</option>
                <option value="75:15" ${Number(prefs.blockMinutes) === 75 ? 'selected' : ''}>75m / 15m</option>
                <option value="40:10" ${Number(prefs.blockMinutes) === 40 ? 'selected' : ''}>40m / 10m</option>
              </select>
            </label>
          </div>

          <div style="margin-top:10px">
            <small class="muted" style="font-weight:700">REST / OFF DAYS:</small>
            <div class="day-toggle-row">
              ${dayLabels
                .map(
                  (lbl, idx) => `
                <label class="day-chip">
                  <input type="checkbox" data-rest-day="${idx}" ${(prefs.restDays || []).includes(idx) ? 'checked' : ''}>
                  ${lbl}
                </label>`
                )
                .join('')}
            </div>
          </div>

          ${courseWeightRows ? `<details style="margin-top:12px"><summary style="cursor:pointer;font-size:13px;font-weight:600">Customize Per-Course Weights</summary><div style="margin-top:6px">${courseWeightRows}</div></details>` : ''}

          <div class="row-actions" style="margin-top:14px">
            <button type="button" class="primary-btn" style="flex:1" id="btn-generate-sched">Generate &amp; Apply Schedule →</button>
          </div>
        </section>

        <!-- PANEL B: 1-PROMPT ANY-LLM COPY-PASTE SCHEDULE BUILDER -->
        <section class="panel" style="margin:0">
          <span class="eyebrow">Option 2 · Zero-API-Key Any-LLM Workflow</span>
          <h3 style="margin:4px 0 6px">1-Prompt LLM Schedule Designer</h3>
          <p class="muted" style="margin:0 0 10px;font-size:13px">
            Works with ChatGPT, Claude, Gemini, or any local on-device LLM (Ollama / LM Studio). Copy one prompt, let the LLM plan around your exact shifts, and paste its JSON or <code>.ics</code> reply below.
          </p>

          <label class="field-label">Your Personal Shifts / Preferences for the Prompt (optional)
            <input type="text" id="llm-custom-notes" placeholder="e.g. Work Tue &amp; Thu 16:00-21:00, gym Mon/Wed 17:00, focus extra on Accounting...">
          </label>

          <div class="row-actions" style="margin:10px 0 12px">
            <button type="button" class="ghost-btn" style="flex:1" id="btn-copy-llm-prompt">1. Copy Universal LLM Schedule Prompt</button>
          </div>

          <label class="field-label">2. Paste LLM Output Here (<code>study-os-schedule-v1</code> JSON or <code>BEGIN:VCALENDAR</code> .ics)
            <textarea id="llm-paste-box" style="min-height:165px;font-family:ui-monospace,monospace;font-size:12px" placeholder='Paste the JSON block or .ics calendar output from your LLM here...'></textarea>
          </label>

          <div class="row-actions" style="margin-top:10px">
            <button type="button" class="primary-btn" style="flex:1" id="btn-apply-llm-sched">Apply Pasted Schedule →</button>
          </div>
        </section>
      </div>

      <!-- UPCOMING SCHEDULE PREVIEW -->
      <div class="panel">
        <div class="row-between" style="margin-top:0">
          <div>
            <h3>Active Upcoming Schedule (${upcomingBlocks.length} blocks shown)</h3>
            <small class="muted">Click Start on any study block to launch its matching practice questions immediately.</small>
          </div>
        </div>
        <div class="task-table-wrap">
          <table class="task-table">
            <thead><tr><th>Date &amp; Time</th><th>Block / Lecture</th><th>Course</th><th>Type</th><th>Action</th></tr></thead>
            <tbody>
              ${
                upcomingBlocks.length
                  ? upcomingBlocks
                      .map(
                        (b) => `<tr>
                      <td><code>${esc(b.date)} ${esc(b.startLabel)}–${esc(b.endLabel)}</code></td>
                      <td><strong>${esc(b.summary)}</strong></td>
                      <td><span class="badge">${esc(b.courseId || 'general')}</span></td>
                      <td><small>${esc(b.blockKind || 'study_block')}</small></td>
                      <td>${
                        b.courseId && (b.blockKind === 'study_block' || b.blockKind === 'recall_sprint')
                          ? `<button type="button" class="ghost-btn" style="padding:4px 10px;font-size:12px" data-sched-start="${esc(b.eventId)}">Start →</button>`
                          : '<small class="muted">Fixed event</small>'
                      }</td>
                    </tr>`
                      )
                      .join('')
                  : '<tr><td colspan="5" class="muted">No upcoming blocks yet — generate a schedule above or paste an LLM schedule.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>
    `;

    const collectFormPrefs = () => {
      const [bMin, brkMin] = document.getElementById('sch-rhythm').value.split(':').map(Number);
      const restDays = [];
      root.querySelectorAll('[data-rest-day]').forEach((cb) => {
        if (cb.checked) restDays.push(Number(cb.dataset.restDay));
      });
      const courseWeights = {};
      root.querySelectorAll('[data-course-weight]').forEach((sel) => {
        courseWeights[sel.dataset.courseWeight] = Number(sel.value);
      });
      return {
        timeeditUrl: document.getElementById('sch-te-url').value.trim(),
        weeklyWorkHours: Number(document.getElementById('sch-work-h').value || 0),
        autoAdjustStudy: document.getElementById('sch-auto-adjust').checked,
        targetStudyHours: Number(document.getElementById('sch-study-h').value || 25),
        dayStartHour: Number(document.getElementById('sch-start-h').value || 8),
        dayEndHour: Number(document.getElementById('sch-end-h').value || 19),
        blockMinutes: bMin || 50,
        breakMinutes: brkMin || 10,
        restDays,
        courseWeights,
      };
    };

    const refreshEstimateUI = () => {
      const p = collectFormPrefs();
      const e = computeClientStudyEstimate(p.weeklyWorkHours, approxWeeklyClassH, boot.catalog.length || 4);
      const studyInput = document.getElementById('sch-study-h');
      studyInput.disabled = p.autoAdjustStudy;
      if (p.autoAdjustStudy) studyInput.value = e.recommendedStudyHours;
      document.getElementById('sch-estimate-box').innerHTML = `
        <strong>Rough Weekly Load Estimate:</strong>
        Job <b>${e.weeklyWorkHours}h</b> + Lectures <b>~${e.weeklyClassHours}h</b> → Recommended Deep Study: <b>${e.recommendedStudyHours}h/wk</b> (Total committed: <b>${
        Math.round((e.weeklyWorkHours + e.weeklyClassHours + (p.autoAdjustStudy ? e.recommendedStudyHours : p.targetStudyHours)) * 10) / 10
      }h/wk</b>)
      `;
    };

    document.getElementById('sch-work-h').oninput = refreshEstimateUI;
    document.getElementById('sch-study-h').oninput = refreshEstimateUI;
    document.getElementById('sch-auto-adjust').onchange = refreshEstimateUI;

    document.getElementById('btn-generate-sched').onclick = async () => {
      const formPrefs = collectFormPrefs();
      const fileEl = document.getElementById('sch-ics-file');
      const icsText = fileEl.files?.[0] ? await fileEl.files[0].text() : '';
      if (isStaticWeb) {
        if (!icsText) {
          toast('In static web mode, upload a downloaded .ics file or use Option 2 (LLM JSON/.ics paste).');
          return;
        }
        try {
          const blocks = parseClientSchedulePayload(icsText);
          const ws = loadWebState();
          ws.customSchedule = { enabled: true, source: 'browser_ics', prefs: formPrefs, blocks, updatedAt: new Date().toISOString() };
          saveWebState(ws);
          recomputeWebAnalytics();
          toast(`Loaded ${blocks.length} timetable events in browser!`);
          renderScheduleStudio();
        } catch (err) {
          toast(err.message || 'Could not parse .ics file.');
        }
        return;
      }

      toast('Generating adaptive 14-day schedule…');
      try {
        const res = await apiPost('/api/schedule/generate', { prefs: formPrefs, icsText });
        if (res.bootstrap) boot = res.bootstrap;
        toast(`Generated ${res.blockCount || 0} adaptive blocks!`);
        renderScheduleStudio();
      } catch (err) {
        toast('Schedule generation failed — verify your TimeEdit .ics link or upload the .ics file.');
      }
    };

    document.getElementById('btn-copy-llm-prompt').onclick = async () => {
      const promptTxt = buildUniversalLlmSchedulePrompt(
        collectFormPrefs(),
        document.getElementById('llm-custom-notes').value.trim()
      );
      try {
        await navigator.clipboard.writeText(promptTxt);
        toast('Copied Universal LLM Schedule Prompt! Paste it into any LLM.');
      } catch {
        document.getElementById('llm-paste-box').value = promptTxt;
        toast('Placed prompt in text box — copy and send to your LLM!');
      }
    };

    document.getElementById('btn-apply-llm-sched').onclick = async () => {
      const raw = document.getElementById('llm-paste-box').value.trim();
      if (!raw) {
        toast('Paste the JSON or .ics output from your LLM first.');
        return;
      }
      if (isStaticWeb) {
        try {
          const blocks = parseClientSchedulePayload(raw);
          const ws = loadWebState();
          ws.customSchedule = { enabled: true, source: 'llm_universal_import', prefs: collectFormPrefs(), blocks, updatedAt: new Date().toISOString() };
          saveWebState(ws);
          recomputeWebAnalytics();
          toast(`Applied ${blocks.length} LLM-scheduled study blocks!`);
          renderScheduleStudio();
        } catch (err) {
          toast(err.message || 'Invalid JSON / .ics payload.');
        }
        return;
      }

      try {
        const res = await apiPost('/api/schedule/import-llm', { payload: raw });
        if (res.bootstrap) boot = res.bootstrap;
        toast(`Applied ${res.blockCount || 0} scheduled blocks!`);
        renderScheduleStudio();
      } catch {
        toast('Could not parse pasted schedule — ensure valid JSON or .ics format.');
      }
    };

    document.getElementById('btn-reset-custom-sched')?.addEventListener('click', async () => {
      if (isStaticWeb) {
        const ws = loadWebState();
        ws.customSchedule = { enabled: false, prefs: {}, blocks: [], updatedAt: new Date().toISOString() };
        saveWebState(ws);
        await refreshBootstrap(false);
        return;
      }
      const res = await apiPost('/api/schedule/import-llm', { action: 'reset' });
      if (res.bootstrap) boot = res.bootstrap;
      toast('Reverted to default calendar feed.');
      renderScheduleStudio();
    });

    root.querySelectorAll('[data-sched-start]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const blk = (boot.calendar?.blocks || []).find((b) => b.eventId === btn.dataset.schedStart);
        if (blk) launchCalendarBlock(blk);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // STATE MUTATIONS (Local Python Server + Static Web Browser Fallback)
  // ---------------------------------------------------------------------------
  async function setQuestionStatus(questionIds, status, resetWork = false) {
    const ws = isStaticWeb ? loadWebState() : null;
    const records = ws ? ws.records : boot.progress.records;
    const updatedAt = new Date().toISOString();
    for (const qid of questionIds) {
      const rec = (records[qid] = records[qid] || {});
      rec.status = status;
      if (isStaticWeb) rec.updatedAt = updatedAt;
      if (resetWork) {
        delete rec.savedDraft;
        delete rec.savedChoice;
        delete rec.savedWiseflow;
        delete rec.checkedRubricIndices;
      }
    }
    if (ws) {
      if (saveWebState(ws)) window.StudyCommunity.queueStatsSync();
      recomputeWebAnalytics();
      updateHeaderStats();
      return;
    }
    await apiPost('/api/progress/status', { questionIds, status, resetWork });
  }

  async function saveDraft(questionId, fields) {
    const ws = isStaticWeb ? loadWebState() : null;
    const records = ws ? ws.records : boot.progress.records;
    const rec = (records[questionId] = records[questionId] || {});
    Object.assign(rec, {
      ...(fields.draft !== undefined ? { savedDraft: fields.draft } : {}),
      ...(fields.choice !== undefined ? { savedChoice: fields.choice } : {}),
      ...(fields.wiseflowAnswers !== undefined ? { savedWiseflow: fields.wiseflowAnswers } : {}),
    });
    if (ws) {
      rec.updatedAt = new Date().toISOString();
      if (saveWebState(ws)) boot.progress.records = ws.records;
      return;
    }
    try {
      await apiPost('/api/progress/draft', { questionId, ...fields });
    } catch {}
  }

  function debouncedSaveDraft(questionId, fields) {
    const pending = pendingDrafts.get(questionId);
    if (pending) clearTimeout(pending.timer);
    const next = { fields: { ...pending?.fields, ...fields } };
    next.timer = setTimeout(() => {
      pendingDrafts.delete(questionId);
      saveDraft(questionId, next.fields);
    }, 450);
    pendingDrafts.set(questionId, next);
  }

  function flushWebDrafts() {
    for (const [qid, pending] of pendingDrafts) {
      clearTimeout(pending.timer);
      saveDraft(qid, pending.fields);
    }
    pendingDrafts.clear();
  }

  async function logAttempt(payload) {
    if (isStaticWeb) {
      const ws = loadWebState();
      const qAcc = Number(payload.qualityAccuracy || 0);
      const effSec = Number(payload.activeSec || 1) + Number(payload.hintsUsed || 0) * Number(payload.hintHandicapSec || 30);
      const aiSec = Number(payload.aiParSec || 120);
      const beatAi = qAcc >= 0.85 && Number(payload.hintsUsed || 0) === 0 && !payload.assisted && effSec <= aiSec;
      const paceRatio = qAcc < 0.6 ? 0.35 : Math.min(1.5, aiSec / Math.max(1, effSec));
      const rec = (ws.records[payload.questionId] = ws.records[payload.questionId] || {});
      const timestamp = new Date().toISOString();
      rec.status = payload.explicitStatus || (qAcc >= 0.75 ? 'done' : 'revisit');
      rec.updatedAt = timestamp;
      rec.lastAttemptAt = timestamp;
      rec.attemptCount = (rec.attemptCount || 0) + 1;
      if (beatAi) rec.beatAiCount = (rec.beatAiCount || 0) + 1;
      if (qAcc >= 0.85 && (!rec.pbEffectiveSec || effSec < rec.pbEffectiveSec)) rec.pbEffectiveSec = effSec;
      const daysOut = qAcc >= 0.85 ? 4 : 1;
      rec.fsrs = {
        reps: (rec.fsrs?.reps || 0) + 1,
        stability: daysOut,
        lastGrade: qAcc >= 0.85 ? 3 : 1,
        due: new Date(Date.now() + daysOut * 86400000).toISOString(),
      };
      const attempt = { ...payload, timestamp, qualityAccuracy: qAcc, effectiveSec: effSec, beatAi, paceRatio };
      ws.attempts.push(attempt);
      const saved = saveWebState(ws);
      if (saved) {
        window.StudyCommunity.queueStatsSync();
        window.StudyRooms.recordAttempt();
      }
      recomputeWebAnalytics();
      updateHeaderStats();
      return { ok: saved, attempt, record: rec, analytics: boot.analytics };
    }
    const res = await apiPost('/api/attempt', payload);
    if (res.record) boot.progress.records[payload.questionId] = res.record;
    if (res.analytics) {
      boot.analytics = res.analytics;
      updateHeaderStats();
    }
    return res;
  }

  async function setQuestionDifficulty(questionId, fsrsGrade) {
    if (isStaticWeb) {
      const ws = loadWebState();
      const rec = (ws.records[questionId] = ws.records[questionId] || {});
      rec.personalDifficulty = fsrsGrade <= 2 ? 3 : fsrsGrade === 4 ? 1 : 2;
      rec.updatedAt = new Date().toISOString();
      saveWebState(ws);
      recomputeWebAnalytics();
      return { ok: true, record: rec, analytics: boot.analytics };
    }
    const res = await apiPost('/api/progress/difficulty', { questionId, fsrsGrade });
    if (res.record) boot.progress.records[questionId] = res.record;
    if (res.analytics) {
      boot.analytics = res.analytics;
      updateHeaderStats();
    }
    return res;
  }

  async function logSession(payload) {
    if (isStaticWeb) {
      const ws = loadWebState();
      ws.sessions.push({ ...payload, endedAt: new Date().toISOString() });
      saveWebState(ws);
      recomputeWebAnalytics();
      return { ok: true, analytics: boot.analytics };
    }
    return apiPost('/api/session', payload);
  }

  function exportBackupFile() {
    if (!isStaticWeb) {
      window.location.href = '/api/export-backup';
      return;
    }
    flushWebDrafts();
    const ws = loadWebState();
    const blob = new Blob(
      [
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            format: 'study-os-backup-v1',
            progress: { records: ws.records },
            attempts: ws.attempts,
            sessions: ws.sessions,
            customSchedule: ws.customSchedule,
          },
          null,
          2
        ),
      ],
      { type: 'application/json' }
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'study-os-web-backup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  // ---------------------------------------------------------------------------
  // INITIALIZATION & DEEP-LINK URL ROUTING
  // ---------------------------------------------------------------------------
  async function init() {
    bindGlobalChrome();
    if (!isStaticWeb) openCanvasSync = bindCanvasSync();
    window.StudyRunner.bindRunnerGlobals();
    document.querySelector('[data-nav="community"]').hidden = !window.StudyCommunity.enabled;
    document.getElementById('runner-room-btn').onclick = () => {
      document.getElementById('run-exit-btn').click();
      navigate('room');
    };
    window.StudyCommunity.queueStatsSync();
    if (isStaticWeb) window.addEventListener('pagehide', flushWebDrafts);

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => navigate(btn.dataset.nav));
    });
    document.getElementById('nav-brand')?.addEventListener('click', () => navigate('home'));
    document.getElementById('btn-open-schedule-studio')?.addEventListener('click', () => navigate('schedule'));
    document.getElementById('btn-export-backup')?.addEventListener('click', exportBackupFile);

    document.getElementById('btn-refresh-cal')?.addEventListener('click', async () => {
      if (isStaticWeb) {
        navigate('schedule');
        return;
      }
      toast('Refreshing calendar…');
      await refreshBootstrap(true);
      toast('Calendar synced!');
    });

    const impBtn = document.getElementById('btn-import-json');
    const impFile = document.getElementById('file-import-json');
    impBtn?.addEventListener('click', () => impFile.click());
    impFile?.addEventListener('change', async () => {
      const f = impFile.files?.[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (isStaticWeb) {
          flushWebDrafts();
          const message = restoreWebBackup(data);
          if (message) {
            window.StudyCommunity.queueStatsSync();
            await refreshBootstrap();
            toast(message);
          }
        } else {
          const res = await apiPost('/api/import-legacy', data);
          toast(`Imported ${res.importedRecords || 0} saved question records!`);
          await refreshBootstrap();
        }
      } catch {
        toast('Could not open this file. Choose a Study-OS JSON backup.');
      }
      impFile.value = '';
    });

    try {
      await window.StudyCommunity.requireProfile();
      await window.StudyRooms.restore();
      await members.restore();
      await refreshBootstrap(false);
      const openedStudySet = await window.StudySets.activateDraft();
      bindMemberAccess(!openedStudySet);
    } catch {
      const hero = document.getElementById('up-next-hero');
      hero.innerHTML = '<h1>Could not load Study-OS</h1><p>Check your connection and try again.</p><button type="button" class="primary-btn">Retry</button>';
      hero.querySelector('button').onclick = () => window.location.reload();
      return;
    }

    // Handle deep links (`?course=...&topic=...&autostart=1`, `?view=exams|references|schedule`, or `?autostart_event=...`)
    const params = new URLSearchParams(window.location.search);
    const autoEvent = params.get('autostart_event');
    const qCourse = params.get('course');
    const qTopic = params.get('topic') || '';
    const qView = params.get('view') || '';
    const autoStart = params.get('autostart') === '1';

    if (autoEvent) {
      const blk = (boot.calendar?.blocks || []).find((b) => b.eventId === autoEvent);
      if (blk && blk.courseId) {
        window.history.replaceState({}, '', window.location.pathname);
        await launchCalendarBlock(blk);
        return;
      }
    }
    if (['exams', 'references', 'schedule'].includes(qView)) {
      if (qView === 'references' && isStaticWeb) {
        const target = findPublicReference(params.get('note') || '');
        if (target) {
          await navigate('references', { refFile: target.entry.file, refDoc: target.file, heading: params.get('section') || '' });
          return;
        }
      }
      window.history.replaceState({}, '', window.location.pathname);
      await navigate(qView, { focusCourseId: qCourse || '' });
      return;
    }
    if (qCourse) {
      window.history.replaceState({}, '', window.location.pathname);
      if (autoStart) {
        await launchSmartCourseRun(qCourse, 40, 'learning', qTopic);
      } else {
        await navigate('course', { courseId: qCourse });
        if (qTopic) {
          const sel = document.getElementById('flt-topic');
          if (sel) {
            sel.value = qTopic;
            sel.dispatchEvent(new Event('change'));
          }
        }
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    isStaticMode,
    communityStats,
    publicReferenceUrl,
    fetchReferenceSection,
    getProgressRecord,
    effectiveDifficulty,
    effectiveDlpfc,
    refreshBootstrap,
    navigate,
    showRawView,
    setQuestionStatus,
    setQuestionDifficulty,
    saveDraft,
    debouncedSaveDraft,
    logAttempt,
    logSession,
  };
})();
