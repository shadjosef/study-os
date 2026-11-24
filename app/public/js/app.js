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

  // EBA 3400 Programming reopened with VS Code / Antigravity Companion v0.3 + Subpart Cards + Top-Center AI-Par Bar
  const MAINTENANCE_COURSES = {};
  function getCourseMaintenance(courseId) {
    return MAINTENANCE_COURSES[String(courseId || '')] || null;
  }
  function canBypassCourseMaintenance() {
    return !isStaticWeb || Boolean(window.StudyCommunity?.isAdmin?.());
  }
  function isCourseInMaintenanceForUser(courseId) {
    return Boolean(getCourseMaintenance(courseId) && !canBypassCourseMaintenance());
  }
  let offlineStatus = navigator.serviceWorker?.controller ? 'Saved for offline' : '';

  let currentView = 'home';
  let desktopImport = null;
  let openCanvasSync;
  let openCanvasFiles;
  let selectedCourseId = '';
  let selectedSemester = 'all';
  let homeDifficulty = (() => {
    try {
      const saved = localStorage.getItem('study-os-home-diff-v1') || 'all';
      return ['all', '1', '2', '3'].includes(saved) ? saved : 'all';
    } catch {
      return 'all';
    }
  })();
  let homeBlockMinutes = (() => {
    try {
      const saved = Number(localStorage.getItem('study-os-home-mins-v1') || 50);
      return [25, 50, 75].includes(saved) ? saved : 50;
    } catch {
      return 50;
    }
  })();
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
          explain: 'Switched to Med after reaching the 4.5h High practice limit.',
        };
      }
      return {
        mode: 'high_dlpfc',
        windowLabel: '08:00–15:00 Peak Capacity Window',
      };
    }
    if (hr >= 15 && hr < 18) {
      return {
        mode: 'med_dlpfc',
        windowLabel: '15:00–18:00 Procedural Window',
      };
    }
    return {
      mode: 'low_dlpfc',
      windowLabel: 'Evening Consolidation Window',
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
    hydratedBlockCache.clear();
    try {
      sessionStorage.setItem('study-os-focus-mode', mode);
    } catch {}
    if (currentView === 'home') renderHome();
  }

  async function apiGet(url) {
    const freshJson = /^(\.\/)?static-data\/(?:bootstrap|courses\/[^/]+)\.json(?:\?.*)?$/.test(url);
    const res = await fetch(url, freshJson ? { cache: 'no-cache' } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function apiPost(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      throw new Error(result.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  const hostedOrigin = 'https://studyos.no';

  function sendDesktopSetup() {
    const popup = window.open(hostedOrigin + '/?view=schedule&desktop=1', '_blank');
    if (!popup) {
      toast('Allow pop-ups from desktop Study-OS to send your schedule.');
      return;
    }
    const timeout = setTimeout(() => window.removeEventListener('message', send), 60_000);
    async function send(event) {
      if (event.origin !== hostedOrigin || event.source !== popup || event.data?.type !== 'study-os-ready') return;
      clearTimeout(timeout);
      window.removeEventListener('message', send);
      const { snapshot } = await apiGet('/api/canvas/browser/status').catch(() => ({}));
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const canvasSnapshot = snapshot ? { syncedAt: snapshot.syncedAt, courses: snapshot.courses.slice(0, 100).map(course => ({
        id: course.id, name: course.name, code: course.code, url: course.url,
        assignments: course.assignments.filter(task => Date.parse(task.dueAt) >= weekAgo).slice(0, 30),
      })) } : null;
      const cfg = boot.scheduleConfig;
      const customSchedule = cfg?.enabled ? {
        enabled: true, source: cfg.source, estimate: cfg.estimate, updatedAt: new Date().toISOString(),
        prefs: { ...cfg.prefs, timeeditUrl: undefined },
        blocks: (boot.calendar?.blocks || []).filter(b => b.timingState !== 'past').slice(0, 200)
          .map(({ autoQueue, ...block }) => block),
      } : null;
      popup.postMessage({ type: 'study-os-desktop-setup', customSchedule, canvasSnapshot }, hostedOrigin);
    }
    window.addEventListener('message', send);
  }

  function receiveDesktopSetup() {
    if (!isStaticWeb || location.origin !== hostedOrigin || !window.opener ||
        new URLSearchParams(location.search).get('desktop') !== '1') return;
    const opener = window.opener;
    window.addEventListener('message', function receive(event) {
      const local = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(event.origin);
      if (!local || event.source !== opener || event.data?.type !== 'study-os-desktop-setup') return;
      window.removeEventListener('message', receive);
      desktopImport = event.data;
      if (currentView === 'schedule') renderScheduleStudio();
    });
    // The receiver validates both the opener window and loopback origin before accepting data.
    opener.postMessage({ type: 'study-os-ready' }, '*');
  }

  async function saveDesktopSetup(share) {
    if (!window.StudyCommunity.isSignedIn()) {
      if (!await window.StudyCommunity.requireProfile({ allowDemo: true, forcePrompt: true })) return;
    }
    if (cloudSyncInFlight) {
      toast('Your current sync is finishing. Try saving again in a moment.');
      return;
    }
    const data = desktopImport;
    if (!data) return;
    const snapshot = data.canvasSnapshot;
    const ws = loadWebState();
    if (data.customSchedule?.enabled) ws.customSchedule = {
      ...data.customSchedule, prefs: { ...data.customSchedule.prefs, timeeditUrl: ws.customSchedule.prefs?.timeeditUrl || '' },
    };
    if (snapshot?.courses) ws.canvasSnapshot = snapshot;
    if (!saveWebState(ws)) return;
    try { localStorage.setItem('study-os-course-suggestions', share ? 'on' : 'off'); } catch {}
    recomputeWebAnalytics();
    const synced = await syncCloudProgress({ interactive: true });
    if (synced) desktopImport = null;
    if (currentView === 'schedule') renderScheduleStudio();
    if (synced && share && snapshot?.courses?.length) {
      const known = new Set(boot.catalog.map(course => (course.code || '').toUpperCase().replace(/\s/g, '')));
      const knownIds = new Set(boot.catalog.map(course => String(course.canvasId || course.courseId?.split('-').pop() || '')));
      const candidates = snapshot.courses.filter(course => !knownIds.has(course.id) && !known.has(course.code || '--'))
        .slice(0, 60).map(({ id, name, code }) => ({ id, name, code }));
      if (candidates.length) {
        try {
          await window.StudyCommunity.proposeCourses(candidates);
          toast('New courses sent for review. Assignments stay private.');
        } catch (error) { toast(error.message || 'Could not submit course suggestions.'); }
      }
    }
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

  const LOCAL_EXAM_RESULTS_KEY = 'study-os-exam-results-v1';

  function gradeFromPct(pct) {
    const p = Number(pct);
    if (!Number.isFinite(p)) return null;
    const clamped = Math.max(0, Math.min(100, Math.round(p * 10) / 10));
    const rounded = Math.round(clamped);
    if (clamped >= 85) return { letter: 'A', label: 'Excellent', cls: 'grade-a', points: 5, pct: rounded, toA: 0 };
    if (clamped >= 77) return { letter: 'B', label: 'Very Good', cls: 'grade-b', points: 4, pct: rounded, toA: Math.max(1, Math.ceil(85 - clamped)) };
    if (clamped >= 65) return { letter: 'C', label: 'Good', cls: 'grade-c', points: 3, pct: rounded, toA: Math.max(1, Math.ceil(85 - clamped)) };
    if (clamped >= 50) return { letter: 'D', label: 'Satisfactory', cls: 'grade-d', points: 2, pct: rounded, toA: Math.max(1, Math.ceil(85 - clamped)) };
    if (clamped >= 40) return { letter: 'E', label: 'Sufficient', cls: 'grade-e', points: 1, pct: rounded, toA: Math.max(1, Math.ceil(85 - clamped)) };
    return { letter: 'F', label: 'Fail', cls: 'grade-f', points: 0, pct: rounded, toA: Math.max(1, Math.ceil(85 - clamped)) };
  }

  function loadExamResultsMap() {
    if (isStaticWeb) {
      const ws = loadWebState();
      return isRecord(ws.examResults) ? ws.examResults : {};
    }
    try {
      const raw = JSON.parse(localStorage.getItem(LOCAL_EXAM_RESULTS_KEY) || '{}');
      return isRecord(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  function mergeExamResultsMaps(baseMap, incMap) {
    const base = isRecord(baseMap) ? baseMap : {};
    const inc = isRecord(incMap) ? incMap : {};
    const out = { ...base };
    let changed = 0;
    for (const [k, v] of Object.entries(inc)) {
      if (typeof k !== 'string' || !k.includes(':') || !isRecord(v)) continue;
      const cur = out[k];
      if (!cur) {
        out[k] = v;
        changed++;
        continue;
      }
      const curAt = backupTime(cur.completedAt);
      const incAt = backupTime(v.completedAt);
      const curBest = Number(cur.bestPct || 0);
      const incBest = Number(v.bestPct || 0);
      if (incAt > curAt || incBest > curBest || Number(v.attemptsCount || 0) > Number(cur.attemptsCount || 0)) {
        const latest = incAt >= curAt ? v : cur;
        const best = incBest >= curBest ? v : cur;
        out[k] = {
          ...latest,
          bestPct: Math.max(curBest, incBest),
          bestGrade: (gradeFromPct(Math.max(curBest, incBest))?.letter) || best.bestGrade || latest.lastGrade,
          bestAt: best.bestAt || latest.completedAt || '',
          attemptsCount: Math.max(Number(cur.attemptsCount || 1), Number(v.attemptsCount || 1)),
        };
        changed++;
      }
    }
    return { merged: out, changed };
  }

  function recordExamResult(courseId, collectionId, summary) {
    if (!courseId || !collectionId || !summary || !Number.isFinite(Number(summary.pct))) return null;
    if (isDevSandbox()) return null;
    const key = `${courseId}:${collectionId}`;
    const pct = Math.max(0, Math.min(100, Math.round(Number(summary.pct) * 10) / 10));
    const g = gradeFromPct(pct);
    const nowIso = new Date().toISOString();
    const saveInto = (map) => {
      const prev = isRecord(map[key]) ? map[key] : null;
      const prevBest = prev ? Number(prev.bestPct ?? prev.lastPct ?? -1) : -1;
      const isNewBest = pct >= prevBest;
      const bestPct = isNewBest ? pct : prevBest;
      const bestG = gradeFromPct(bestPct);
      const entry = {
        courseId: String(courseId),
        collectionId: String(collectionId),
        lastPct: pct,
        lastGrade: g.letter,
        bestPct,
        bestGrade: bestG.letter,
        earnedPts: Math.round(Number(summary.earnedPts || 0) * 10) / 10,
        totalPts: Math.round(Number(summary.totalPts || 0) * 10) / 10,
        gradedCount: Math.max(0, Math.round(Number(summary.gradedCount || 0))),
        totalCount: Math.max(0, Math.round(Number(summary.totalCount || 0))),
        gradingKind: ['auto', 'rubric', 'mixed'].includes(summary.gradingKind) ? summary.gradingKind : 'mixed',
        attemptsCount: Math.max(1, Number(prev?.attemptsCount || 0) + (summary.incrementAttempt ? 1 : prev ? 0 : 1)),
        completedAt: nowIso,
        bestAt: isNewBest ? nowIso : (prev?.bestAt || nowIso),
      };
      map[key] = entry;
      return entry;
    };
    if (isStaticWeb) {
      const ws = loadWebState();
      if (!isRecord(ws.examResults)) ws.examResults = {};
      const saved = saveInto(ws.examResults);
      saveWebState(ws);
      queueCloudSync();
      return saved;
    }
    const localMap = loadExamResultsMap();
    const saved = saveInto(localMap);
    try { localStorage.setItem(LOCAL_EXAM_RESULTS_KEY, JSON.stringify(localMap)); } catch {}
    return saved;
  }

  function loadWebState() {
    try {
      const raw = JSON.parse(localStorage.getItem(WEB_STATE_KEY) || '{}');
      return {
        records: raw.records || {},
        attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
        customSchedule: raw.customSchedule || { enabled: false, prefs: {}, blocks: [] },
        canvasSnapshot: raw.canvasSnapshot || null,
        edSnapshot: raw.edSnapshot || null,
        examResults: isRecord(raw.examResults) ? raw.examResults : {},
      };
    } catch {
      return { records: {}, attempts: [], sessions: [], customSchedule: { enabled: false, prefs: {}, blocks: [] }, canvasSnapshot: null, edSnapshot: null, examResults: {} };
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
    if (scheduleChanged) {
      const mergedCompleted = {
        ...(isRecord(currentSchedule.completedEvents) ? currentSchedule.completedEvents : {}),
        ...(isRecord(schedule.completedEvents) ? schedule.completedEvents : {}),
      };
      const mergedDismissed = {
        ...(isRecord(currentSchedule.dismissedEvents) ? currentSchedule.dismissedEvents : {}),
        ...(isRecord(schedule.dismissedEvents) ? schedule.dismissedEvents : {}),
      };
      ws.customSchedule = {
        ...schedule,
        completedEvents: mergedCompleted,
        dismissedEvents: mergedDismissed,
        prefs: {
          ...schedule.prefs,
          timeeditUrl: schedule.prefs.timeeditUrl || currentSchedule.prefs?.timeeditUrl || '',
        },
      };
    } else if (isRecord(schedule)) {
      // Still merge completion/dismissal checkoffs from another device even when base plan is identical
      let statusMerged = false;
      if (isRecord(schedule.completedEvents)) {
        ws.customSchedule.completedEvents = {
          ...(isRecord(ws.customSchedule.completedEvents) ? ws.customSchedule.completedEvents : {}),
          ...schedule.completedEvents,
        };
        statusMerged = true;
      }
      if (isRecord(schedule.dismissedEvents)) {
        ws.customSchedule.dismissedEvents = {
          ...(isRecord(ws.customSchedule.dismissedEvents) ? ws.customSchedule.dismissedEvents : {}),
          ...schedule.dismissedEvents,
        };
        statusMerged = true;
      }
      if (statusMerged && !ws.customSchedule.updatedAt) {
        ws.customSchedule.updatedAt = schedule.updatedAt || new Date().toISOString();
      }
    }
    const snapshot = data.canvasSnapshot;
    const canvasChanged = snapshot && Array.isArray(snapshot.courses) &&
      backupTime(snapshot.syncedAt) > backupTime(ws.canvasSnapshot?.syncedAt);
    if (canvasChanged) ws.canvasSnapshot = snapshot;
    const edSnap = data.edSnapshot;
    const edChanged = edSnap && (Array.isArray(edSnap.threads) || Array.isArray(edSnap.courses)) &&
      backupTime(edSnap.syncedAt) > backupTime(ws.edSnapshot?.syncedAt);
    if (edChanged) ws.edSnapshot = edSnap;
    const addedSets = Array.isArray(data.customSets)
      ? (window.StudySets?.mergeFromCloud?.(data.customSets) || 0)
      : 0;
    const screenMerged = isRecord(data.screenHistory)
      ? (window.StudyUI?.workClock?.mergeScreenHistory?.(data.screenHistory) || 0)
      : 0;
    const telemetryMerged = isRecord(data.telemetryByDevice)
      ? (window.StudyUI?.workClock?.mergeTelemetryByDevice?.(data.telemetryByDevice) || 0)
      : 0;
    const examResMerge = isRecord(data.examResults)
      ? mergeExamResultsMaps(ws.examResults, data.examResults)
      : { merged: ws.examResults || {}, changed: 0 };
    ws.examResults = examResMerge.merged;
    if (!saveWebState(ws)) return '';

    const restored = [
      changed ? `${changed} progress records` : '',
      ws.attempts.length > originalAttemptCount ? `${ws.attempts.length - originalAttemptCount} attempts` : '',
      ws.sessions.length > originalSessionCount ? `${ws.sessions.length - originalSessionCount} sessions` : '',
      scheduleChanged ? 'your schedule' : '',
      canvasChanged ? 'Canvas deadlines' : '',
      edChanged ? 'Ed Discussion posts' : '',
      addedSets ? `${addedSets} study set${addedSets === 1 ? '' : 's'}` : '',
      (screenMerged || telemetryMerged) ? 'Oslo telemetry history' : '',
      examResMerge.changed ? `${examResMerge.changed} exam grade${examResMerge.changed === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return restored.length ? `Restored ${restored.join(', ')}.` : 'This backup contains no newer study data.';
  }

  function calibratedParSec(q, profile = 'learning') {
    if (!q) return 90;
    const prof = profile === 'exam' ? 'exam' : 'learning';
    const rawLearnSec = Math.max(20, Math.round((Number(q.pacing?.learning?.target) || (q.kind === 'mcq' ? 2 : 6)) * 60));
    const rawExamSec = q.pacing?.exam?.target ? Math.max(20, Math.round(Number(q.pacing.exam.target) * 60)) : 0;

    if (q.kind === 'mcq') {
      const tier = effectiveDlpfc(q).tier;
      const textLen = (q.contextMarkdown?.length || 0)
        + (q.promptMarkdown?.length || 0)
        + (Array.isArray(q.options) ? q.options.join(' ').length : 0);
      const extraCap = tier === 1 ? 25 : tier === 2 ? 35 : 45;
      const extra = Math.min(extraCap, Math.round(Math.max(0, textLen - 160) / 14));
      const baseLearn = tier === 1 ? 50 : tier === 2 ? 80 : 120;
      const maxLearn = tier === 1 ? 85 : tier === 2 ? 135 : 190;
      const learnSec = Math.min(rawLearnSec, maxLearn, baseLearn + extra);
      if (prof === 'exam') {
        const examTarget = Math.max(30, Math.round(learnSec * 0.72));
        return rawExamSec ? Math.min(rawExamSec, examTarget) : examTarget;
      }
      return learnSec;
    }

    if (prof === 'exam') {
      if (rawExamSec && rawExamSec < rawLearnSec * 0.92) return rawExamSec;
      return Math.max(45, Math.round(rawLearnSec * 0.78));
    }
    return rawLearnSec;
  }

  function isAutoGradedAttempt(a) {
    if (typeof a?.autoGraded === 'boolean') return a.autoGraded;
    const k = String(a?.kind || '').toLowerCase();
    return k === 'mcq' || k === 'wiseflow' || k === 'flowmulti';
  }

  function computeWeightedUpi(attempts, focusDensity = 0.9) {
    if (!Array.isArray(attempts) || !attempts.length) return null;
    const fd = Math.max(0, Math.min(1, Number(focusDensity) || 0.9));
    let weightedSum = 0;
    let totalW = 0;
    for (const a of attempts) {
      const auto = isAutoGradedAttempt(a);
      const w = auto ? 1.0 : 0.45; // Conservative weight on self-graded written tasks
      const qAcc = Math.max(0, Math.min(1, Number(a.qualityAccuracy || 0)));
      const prCap = auto ? 1.35 : 1.0;
      const pr = Math.max(0, Math.min(prCap, Number(a.paceRatio || 0)));
      const tier = Number(a.dlpfcTier || (a.kind === 'mcq' ? 1 : 2));
      const tierMult = tier === 3 ? 1.22 : tier === 1 ? 0.85 : 1.0; // Reward selecting Hard
      const examMult = a.profile === 'exam' ? 1.08 : 1.0; // Reward Exam Par timing
      const score = Math.min(150, 100 * (0.45 * qAcc + 0.35 * pr + 0.2 * fd) * tierMult * examMult);
      weightedSum += w * score;
      totalW += w;
    }
    return totalW > 0 ? Math.round(weightedSum / totalW) : null;
  }

  const SCHED_DEBT_WINDOW_MS = 14 * 86_400_000;
  const LOCAL_SCHED_STATUS_KEY = 'study-os-local-sched-status-v1';
  const sandboxSchedCompleted = new Map();
  const sandboxSchedDismissed = new Set();
  const hydratedBlockCache = new Map(); // eventId -> { count, estMin, questionIds, topicIds, topicLabel }

  function recomputeWebAnalytics() {
    hydratedBlockCache.clear();
    const ws = loadWebState();
    const records = ws.records || {};
    const attempts = ws.attempts || [];
    const courseProgress = {};
    const qTierLookup = {};
    for (const c of boot.catalog || []) {
      const tIds = c.tierQuestionIds || null;
      const byTier = {
        '1': { total: tIds ? tIds['1'].length : Number(c.lowDlpfcCount || 0), done: 0, revisit: 0, in_progress: 0, dueFsrs: 0 },
        '2': { total: tIds ? tIds['2'].length : Number(c.medDlpfcCount || 0), done: 0, revisit: 0, in_progress: 0, dueFsrs: 0 },
        '3': { total: tIds ? tIds['3'].length : Number(c.highDlpfcCount || 0), done: 0, revisit: 0, in_progress: 0, dueFsrs: 0 },
      };
      if (tIds) {
        for (const t of ['1', '2', '3']) {
          for (const qid of tIds[t] || []) qTierLookup[qid] = t;
        }
      } else if (bankCache[c.courseId]?.questions) {
        for (const q of bankCache[c.courseId].questions) {
          qTierLookup[q.id] = String(effectiveDlpfc(q).tier);
        }
      }
      courseProgress[c.courseId] = {
        total: c.questionCount || 0,
        done: 0,
        revisit: 0,
        in_progress: 0,
        dueFsrs: 0,
        byTier,
      };
    }
    const nowIso = new Date().toISOString();
    for (const [qid, rec] of Object.entries(records)) {
      const cid = qid.split(':')[0];
      if (!courseProgress[cid]) continue;
      const tierStr = qTierLookup[qid] || (rec.dlpfcTier ? String(rec.dlpfcTier) : '');
      const tb = tierStr && courseProgress[cid].byTier[tierStr];
      if (rec.status === 'done') {
        courseProgress[cid].done++;
        if (tb) tb.done++;
      } else if (rec.status === 'revisit') {
        courseProgress[cid].revisit++;
        if (tb) tb.revisit++;
      } else if (rec.status === 'in_progress') {
        courseProgress[cid].in_progress++;
        if (tb) tb.in_progress++;
      }
      if (rec.fsrs?.due && rec.fsrs.due <= nowIso) {
        courseProgress[cid].dueFsrs++;
        if (tb) tb.dueFsrs++;
      }
    }
    const n = attempts.length;
    const avgAcc = n ? attempts.reduce((s, a) => s + Number(a.qualityAccuracy || 0), 0) / n : null;
    const beatRate = n ? attempts.filter((a) => a.beatAi).length / n : null;
    const paceList = attempts.filter((a) => Number.isFinite(Number(a.paceRatio)) && Number(a.paceRatio) > 0);
    const avgPaceRatio = paceList.length
      ? Math.round((paceList.reduce((s, a) => s + Number(a.paceRatio), 0) / paceList.length) * 100) / 100
      : null;
    const upi = computeWeightedUpi(attempts, 0.9);

    const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' });
    const osloHourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', hourCycle: 'h23' });
    const today = dayFormat.format(new Date());
    const toOsloDay = (ts) => {
      const d = new Date(ts);
      return Number.isNaN(d.getTime()) ? '' : dayFormat.format(d);
    };
    const toOsloSlot = (ts) => {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '';
      const h = Number(osloHourFmt.format(d));
      if (h >= 6 && h < 12) return 'morning_06_12';
      if (h >= 12 && h < 17) return 'afternoon_12_17';
      if (h >= 17 && h < 23) return 'evening_17_23';
      return 'night_23_06';
    };
    const attemptTier = (a) => {
      const raw = Number(a.dlpfcTier || qTierLookup[a.questionId] || (a.kind === 'mcq' ? 1 : 2));
      return Math.min(3, Math.max(1, Number.isFinite(raw) ? raw : 2));
    };
    const attemptAdjUnits = (a) => {
      const tier = attemptTier(a);
      const tierW = tier === 3 ? 1.35 : tier === 1 ? 0.75 : 1.0;
      const parSec = Math.max(45, Number(a.aiParSec || a.parSec || (a.kind === 'mcq' ? 90 : 300)));
      const qAcc = Math.max(0.3, Math.min(1, Number(a.qualityAccuracy ?? 0.8)));
      return (parSec / 180) * tierW * qAcc;
    };

    const byCourseBuckets = {};
    const byCourseTierBuckets = {};
    const byDlpfcBuckets = {};
    const byKindBuckets = {};
    const bySlotBuckets = {};
    const dayMap = new Map();
    const ensureDay = (dayKey) => {
      let row = dayMap.get(dayKey);
      if (!row) {
        row = {
          day: dayKey,
          isToday: dayKey === today,
          activeSec: 0,
          highSec: 0,
          medSec: 0,
          lowSec: 0,
          screenSec: 0,
          offScreenSec: 0,
          attempts: [],
          adjustedUnits: 0,
          byCourseSec: {},
        };
        dayMap.set(dayKey, row);
      }
      return row;
    };

    // Ensure at least the last 14 Oslo days exist on the timeline
    for (let i = 13; i >= 0; i--) {
      ensureDay(dayFormat.format(new Date(Date.now() - i * 86_400_000)));
    }

    const qTopicLookup = {};
    for (const c of boot.catalog || []) {
      for (const ts of c.topicStats || []) {
        for (const qid of ts.questionIds || []) {
          qTopicLookup[qid] = { courseId: c.courseId, topicId: String(ts.id) };
        }
      }
    }
    const topicAttemptSec = {};
    const topicAttempts = {};

    for (const a of attempts) {
      const cid = a.courseId || String(a.questionId || '').split(':')[0];
      const tier = attemptTier(a);
      const kind = String(a.kind || 'written').toLowerCase();
      const slot = toOsloSlot(a.timestamp);
      const dk = toOsloDay(a.timestamp);
      if (cid) {
        (byCourseBuckets[cid] = byCourseBuckets[cid] || []).push(a);
        const ctKey = `${cid}:${tier}`;
        (byCourseTierBuckets[ctKey] = byCourseTierBuckets[ctKey] || []).push(a);
      }
      const tierKey = tier === 3 ? 'high_3' : tier === 1 ? 'low_1' : 'med_2';
      (byDlpfcBuckets[tierKey] = byDlpfcBuckets[tierKey] || []).push(a);
      (byKindBuckets[kind] = byKindBuckets[kind] || []).push(a);
      if (slot) (bySlotBuckets[slot] = bySlotBuckets[slot] || []).push(a);

      const sec = Math.max(0, Number(a.activeSec || 0));
      const tInfo = qTopicLookup[a.questionId] || (cid && a.topicId != null ? { courseId: cid, topicId: String(a.topicId) } : null);
      if (tInfo) {
        const tk = `${tInfo.courseId}::${tInfo.topicId}`;
        topicAttemptSec[tk] = (topicAttemptSec[tk] || 0) + sec;
        (topicAttempts[tk] = topicAttempts[tk] || []).push(a);
      }

      if (dk) {
        const dr = ensureDay(dk);
        dr.attempts.push(a);
        dr.activeSec += sec;
        if (tier === 3) dr.highSec += sec;
        else if (tier === 1) dr.lowSec += sec;
        else dr.medSec += sec;
        dr.adjustedUnits += attemptAdjUnits(a);
        if (cid) dr.byCourseSec[cid] = (dr.byCourseSec[cid] || 0) + sec;
      }
    }

    // Fold session timing & away time into Oslo days
    const sessionDayActive = {};
    const sessionDayAway = {};
    for (const sess of ws.sessions || []) {
      const dk = toOsloDay(sess.endedAt || sess.startedAt);
      if (!dk) continue;
      sessionDayActive[dk] = (sessionDayActive[dk] || 0) + Math.max(0, Number(sess.activeSec || 0));
      sessionDayAway[dk] = (sessionDayAway[dk] || 0) + Math.max(0, Number(sess.awaySec || 0));
      ensureDay(dk);
    }

    // Fold live & historical Oslo screen time + multi-device additive Telemetry Ledger from workClock
    const screenHist = window.StudyUI?.workClock?.getScreenHistory?.() || {};
    const telSummary = window.StudyUI?.workClock?.getTelemetrySummary?.() || null;
    const telByDay = telSummary?.byDay || {};
    for (const [dk, sh] of Object.entries(screenHist)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
      const dr = ensureDay(dk);
      dr.screenSec = Math.max(dr.screenSec, Number(sh?.screenSec || 0));
      dr.offScreenSec = Math.max(dr.offScreenSec, Number(sh?.offScreenSec || 0));
      dr.hasScreenLog = dr.hasScreenLog || Number(sh?.screenSec || 0) >= 60;
      if (Number(sh?.activeSec || 0) > dr.activeSec && dk === today) {
        dr.liveActiveSec = Number(sh.activeSec);
      }
    }
    for (const [dk, td] of Object.entries(telByDay)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || !td) continue;
      const dr = ensureDay(dk);
      dr.telemetry = td;
      const telTracked = (td.solvingSec || 0) + (td.readingSec || 0) + (td.appBrowseSec || 0) + (td.afkIdleSec || 0) + (td.extStudySec || 0) + (td.extDistractSec || 0);
      const telProd = (td.solvingSec || 0) + (td.readingSec || 0) + (td.extStudySec || 0);
      if (telTracked >= 60) {
        dr.hasScreenLog = true;
        dr.screenSec = Math.max(dr.screenSec, telTracked);
        dr.offScreenSec = Math.max(dr.offScreenSec, (td.awaySec || 0) + (td.breakSec || 0));
      }
      if (telProd > (dr.liveActiveSec || 0) && dk === today) {
        dr.liveActiveSec = Math.max(dr.liveActiveSec || 0, telProd);
      }
      // Sync live per-course seconds so Today's Hours Worked Breakdown matches KPIs
      if (td.courseSec && typeof td.courseSec === 'object') {
        for (const [cid, cSec] of Object.entries(td.courseSec)) {
          if (Number(cSec) > (dr.byCourseSec[cid] || 0)) {
            dr.byCourseSec[cid] = Number(cSec);
          }
        }
      }
    }

    const dailySeries = [...dayMap.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((dr) => {
        const sessAct = sessionDayActive[dr.day] || 0;
        const sessAway = sessionDayAway[dr.day] || 0;
        const effActiveSec = Math.max(dr.activeSec, dr.liveActiveSec || 0, Math.min(sessAct, dr.activeSec + 1800));
        const activeMin = Math.round((effActiveSec / 60) * 10) / 10;
        const td = dr.telemetry || null;
        const telTracked = td ? ((td.solvingSec || 0) + (td.readingSec || 0) + (td.appBrowseSec || 0) + (td.afkIdleSec || 0) + (td.extStudySec || 0) + (td.extDistractSec || 0)) : 0;
        const telProd = td ? ((td.solvingSec || 0) + (td.readingSec || 0) + (td.extStudySec || 0)) : 0;
        const hasRealScreen = Boolean(dr.hasScreenLog || sessAway > 0 || telTracked >= 60);
        const screenSecFinal = hasRealScreen
          ? Math.max(dr.screenSec, telTracked, effActiveSec + (dr.screenSec === 0 ? sessAway : 0))
          : effActiveSec;
        const screenMin = Math.round((screenSecFinal / 60) * 10) / 10;
        const offScreenMin = Math.round((Math.max(dr.offScreenSec, sessAway) / 60) * 10) / 10;
        // Honest Focus Efficiency: NEVER fabricate 100% on past days without real screen/telemetry logs!
        const efficiencyPct = telTracked >= 60
          ? Math.min(100, Math.round((telProd / telTracked) * 100))
          : (hasRealScreen && screenMin > 0.5)
          ? Math.min(100, Math.round((activeMin / screenMin) * 100))
          : null;
        const arr = dr.attempts;
        const pArr = arr.filter((a) => Number.isFinite(Number(a.paceRatio)) && Number(a.paceRatio) > 0);
        const byCourseMin = Object.fromEntries(
          Object.entries(dr.byCourseSec).map(([cid, s]) => [cid, Math.round((s / 60) * 10) / 10])
        );
        return {
          day: dr.day,
          isToday: dr.isToday,
          activeMin,
          highMin: Math.round((dr.highSec / 60) * 10) / 10,
          medMin: Math.round((dr.medSec / 60) * 10) / 10,
          lowMin: Math.round((dr.lowSec / 60) * 10) / 10,
          screenMin,
          offScreenMin,
          hasScreenLog: hasRealScreen,
          efficiencyPct,
          telemetry: td,
          attempts: arr.length,
          adjustedUnits: Math.round(dr.adjustedUnits * 10) / 10,
          avgPaceRatio: pArr.length ? Math.round((pArr.reduce((s, a) => s + Number(a.paceRatio), 0) / pArr.length) * 100) / 100 : null,
          upi: arr.length ? computeWeightedUpi(arr, 0.9) : null,
          accuracyPct: arr.length ? Math.round((arr.reduce((s, a) => s + Number(a.qualityAccuracy || 0), 0) / arr.length) * 100) : null,
          byCourseMin,
        };
      });

    const summarizeBucket = (arr) => {
      const totalSec = arr.reduce((s, a) => s + Math.max(0, Number(a.activeSec || 0)), 0);
      const pArr = arr.filter((a) => Number.isFinite(Number(a.paceRatio)) && Number(a.paceRatio) > 0);
      return {
        count: arr.length,
        avgAccuracy: arr.reduce((s, a) => s + Number(a.qualityAccuracy || 0), 0) / arr.length,
        beatAiRate: arr.filter((a) => a.beatAi).length / arr.length,
        avgPaceRatio: pArr.length ? Math.round((pArr.reduce((s, a) => s + Number(a.paceRatio), 0) / pArr.length) * 100) / 100 : null,
        totalActiveMinutes: Math.round(totalSec / 60),
        adjustedUnits: Math.round(arr.reduce((s, a) => s + attemptAdjUnits(a), 0) * 10) / 10,
        upi: computeWeightedUpi(arr, 0.9),
      };
    };
    const byCourse = Object.fromEntries(Object.entries(byCourseBuckets).map(([k, arr]) => [k, summarizeBucket(arr)]));
    const byCourseTier = Object.fromEntries(Object.entries(byCourseTierBuckets).map(([k, arr]) => [k, summarizeBucket(arr)]));
    const byDlpfcTier = Object.fromEntries(Object.entries(byDlpfcBuckets).map(([k, arr]) => [k, summarizeBucket(arr)]));
    const byKind = Object.fromEntries(Object.entries(byKindBuckets).map(([k, arr]) => [k, summarizeBucket(arr)]));
    const byTimeSlot = Object.fromEntries(Object.entries(bySlotBuckets).map(([k, arr]) => [k, summarizeBucket(arr)]));

    const last7Set = new Set();
    const prev7Set = new Set();
    for (let i = 0; i < 7; i++) {
      last7Set.add(dayFormat.format(new Date(Date.now() - i * 86_400_000)));
      prev7Set.add(dayFormat.format(new Date(Date.now() - (i + 7) * 86_400_000)));
    }
    const last7Attempts = attempts.filter((a) => last7Set.has(toOsloDay(a.timestamp)));
    const prev7Attempts = attempts.filter((a) => prev7Set.has(toOsloDay(a.timestamp)));
    const last7ActiveMin = Math.round(
      dailySeries.filter((d) => last7Set.has(d.day)).reduce((s, d) => s + d.activeMin, 0)
    );
    const last7Adj = Math.round(last7Attempts.reduce((s, a) => s + attemptAdjUnits(a), 0) * 10) / 10;
    const prev7Adj = Math.round(prev7Attempts.reduce((s, a) => s + attemptAdjUnits(a), 0) * 10) / 10;

    // Streak in Oslo days
    let streakDays = 0;
    for (let i = 0; i < 60; i++) {
      const dk = dayFormat.format(new Date(Date.now() - i * 86_400_000));
      const dr = dayMap.get(dk);
      if (dr && (dr.attempts.length > 0 || dr.activeSec >= 180)) {
        streakDays++;
      } else if (i > 0) {
        break;
      }
    }

    const todayRow = dayMap.get(today);
    const todayAttempts = todayRow ? todayRow.attempts : [];
    const todayMin = Math.round((todayRow?.activeSec || 0) / 60);
    const todayHighMinutes = (todayRow?.highSec || 0) / 60;
    const todayMedMinutes = (todayRow?.medSec || 0) / 60;
    const todayLowMinutes = (todayRow?.lowSec || 0) / 60;
    const todaySessions = (ws.sessions || []).filter((session) => toOsloDay(session.endedAt) === today);

    // Check-in subjective-to-UPI correlations (when 3+ check-in sessions exist)
    const checkedSessions = (ws.sessions || []).filter((s) => s?.checkIn && Number.isFinite(Number(s.upi)));
    const correlations = [];
    if (checkedSessions.length >= 3) {
      for (const [field, label] of [['focus', 'Focus Rating ↔ Session UPI'], ['energy', 'Energy Level ↔ Session UPI'], ['startInertia', 'Start Inertia ↔ Session UPI']]) {
        const hi = checkedSessions.filter((s) => Number(s.checkIn[field] || 0) >= 4);
        const lo = checkedSessions.filter((s) => Number(s.checkIn[field] || 0) > 0 && Number(s.checkIn[field]) <= 2);
        if (hi.length && lo.length) {
          const avgHi = Math.round(hi.reduce((sum, s) => sum + Number(s.upi), 0) / hi.length);
          const avgLo = Math.round(lo.reduce((sum, s) => sum + Number(s.upi), 0) / lo.length);
          const diff = avgHi - avgLo;
          correlations.push({
            label,
            summary: `High (${avgHi} UPI) vs Low (${avgLo} UPI) → ${diff >= 0 ? '+' : ''}${diff} UPI impact across ${hi.length + lo.length} sessions.`,
          });
        }
      }
    }

    // Topic Coverage & Hours Worked vs AI-Par Recommended Hours Before Exam
    const topicMatrix = {};
    for (const c of boot.catalog || []) {
      const statsList = Array.isArray(c.topicStats) && c.topicStats.length
        ? c.topicStats
        : (c.topics || []).map((t) => ({
            id: String(t.id),
            title: t.title || `Topic ${t.id}`,
            questionCount: Math.max(1, Math.round((c.questionCount || 10) / Math.max(1, (c.topics || []).length))),
            parMinutes: Math.max(20, Math.round(((c.questionCount || 10) * 3.5) / Math.max(1, (c.topics || []).length))),
            questionIds: [],
          }));
      topicMatrix[c.courseId] = statsList.map((ts, orderIdx) => {
        const tid = String(ts.id);
        const qIds = Array.isArray(ts.questionIds) ? ts.questionIds : [];
        let doneCount = 0;
        let revisitCount = 0;
        let recordCreditMin = 0;
        const avgQParMin = ts.questionCount > 0 ? (Number(ts.parMinutes) || 20) / ts.questionCount : 3;
        const attemptedQids = new Set((topicAttempts[`${c.courseId}::${tid}`] || []).map((a) => a.questionId));
        for (const qid of qIds) {
          const rec = records[qid];
          if (!rec) continue;
          if (rec.status === 'done') {
            doneCount++;
            if (!attemptedQids.has(qid)) recordCreditMin += avgQParMin * 0.85;
          } else if (rec.status === 'revisit') {
            revisitCount++;
          }
        }
        const tk = `${c.courseId}::${tid}`;
        const tAtts = topicAttempts[tk] || [];
        const workedMin = Math.round(((topicAttemptSec[tk] || 0) / 60 + recordCreditMin) * 10) / 10;
        // Exact 1.0x AI-Par target summed across this topic's exercises
        const recommendedMin = Math.max(15, Math.round(Number(ts.parMinutes) || 20));
        const ratioToPar = recommendedMin > 0 ? workedMin / recommendedMin : 0;
        const totalCount = Math.max(1, Number(ts.questionCount) || qIds.length || 1);
        const coveragePct = Math.min(100, Math.round((doneCount / totalCount) * 100));
        const tPaceArr = tAtts.filter((a) => Number.isFinite(Number(a.paceRatio)) && Number(a.paceRatio) > 0);
        const avgTopicPace = tPaceArr.length
          ? Math.round((tPaceArr.reduce((s, a) => s + Number(a.paceRatio), 0) / tPaceArr.length) * 100) / 100
          : null;
        const avgTopicAcc = tAtts.length
          ? tAtts.reduce((s, a) => s + Number(a.qualityAccuracy || 0), 0) / tAtts.length
          : null;
        const status = (ratioToPar >= 0.72 || coveragePct >= 75) && (avgTopicAcc == null || avgTopicAcc >= 0.72) && revisitCount <= 1
          ? 'ready'
          : (ratioToPar >= 0.3 || coveragePct >= 30)
          ? 'building'
          : 'lacking';
        return {
          id: tid,
          order: orderIdx,
          title: ts.title || `Topic ${tid}`,
          workedMin,
          recommendedMin,
          ratioToPar,
          doneCount,
          totalCount,
          revisitCount,
          coveragePct,
          avgPaceRatio: avgTopicPace,
          avgAccuracy: avgTopicAcc,
          status,
        };
      });
    }

    const verification = { auto_graded: 0, ide_verified: 0, self_verified: 0, fast_flag: 0 };
    for (const a of attempts) {
      const vt = a.verificationTier || (
        isAutoGradedAttempt(a)
          ? 'auto_graded'
          : a.source === 'ide_companion'
          ? 'ide_verified'
          : (Number(a.activeSec || 0) > 0 && Number(a.aiParSec || 0) >= 120 && Number(a.activeSec) < Number(a.aiParSec) * 0.12)
          ? 'fast_flag'
          : 'self_verified'
      );
      verification[vt] = (verification[vt] || 0) + 1;
    }

    boot.progress = { records };
    boot.recentSessions = (ws.sessions || []).slice(-25).reverse();
    boot.analytics = {
      totalAttempts: n,
      totalSessions: (ws.sessions || []).length,
      totalXp: n * 20,
      streakDays,
      verification,
      telemetrySummary: telSummary,
      overall: { count: n, avgAccuracy: avgAcc, beatAiRate: beatRate, avgPaceRatio, upi },
      last7Days: {
        upi: last7Attempts.length ? computeWeightedUpi(last7Attempts, 0.9) : null,
        prev7Upi: prev7Attempts.length ? computeWeightedUpi(prev7Attempts, 0.9) : null,
        totalActiveMinutes: last7ActiveMin,
        attempts: last7Attempts.length,
        adjustedUnits: last7Adj,
        prevAdjustedUnits: prev7Adj,
      },
      today: {
        count: todayAttempts.length,
        totalActiveMinutes: todayMin,
        liveActiveSec: todayRow?.liveActiveSec || 0,
      },
      dlpfcBudget: {
        todayHighMinutes,
        todayMedMinutes,
        todayLowMinutes,
        remainingHighMinutes: Math.max(0, 270 - todayHighMinutes),
        todayAwayMinutes: todaySessions.reduce((sum, session) => sum + Number(session.awaySec || 0), 0) / 60,
        todayFocusSwitches: todaySessions.reduce((sum, session) => sum + Number(session.focusSwitchCount || 0), 0),
      },
      courseProgress,
      subgroups: { byCourse, byCourseTier, byDlpfcTier, byKind, byTimeSlot },
      correlations,
      dailySeries,
      topicMatrix,
    };
    if (ws.customSchedule?.enabled && ws.customSchedule.blocks?.length) {
      const completedFromSessions = new Map();
      for (const sess of ws.sessions || []) {
        if (!sess?.calendarEventId) continue;
        if (Number(sess.reviewedCount || 0) > 0 || Number(sess.activeSec || 0) >= 60) {
          completedFromSessions.set(sess.calendarEventId, {
            at: sess.endedAt || sess.startedAt || nowIso,
            method: 'session',
          });
        }
      }
      const savedCompleted = isRecord(ws.customSchedule.completedEvents) ? ws.customSchedule.completedEvents : {};
      const savedDismissed = isRecord(ws.customSchedule.dismissedEvents) ? ws.customSchedule.dismissedEvents : {};
      const at = Date.parse(nowIso);
      const debtCutoff = at - SCHED_DEBT_WINDOW_MS;
      boot.calendar = {
        updatedAt: ws.customSchedule.updatedAt || nowIso,
        source: ws.customSchedule.source || 'browser_schedule',
        estimate: ws.customSchedule.estimate || null,
        blocks: ws.customSchedule.blocks.map((block) => {
          const start = Date.parse(block.startIso);
          const end = Date.parse(block.endIso);
          const timingState = Number.isFinite(end) && end <= at
            ? 'past'
            : Number.isFinite(start) && start <= at
            ? 'live_now'
            : 'upcoming';
          const compInfo = savedCompleted[block.eventId] || completedFromSessions.get(block.eventId) || null;
          const completed = Boolean(compInfo) || Boolean(block.completed);
          const completedAt = compInfo?.at || block.completedAt || '';
          const completedEarly = Boolean(
            completed && (compInfo?.early || (completedAt && Number.isFinite(start) && Date.parse(completedAt) < start))
          );
          const dismissed = !completed && Boolean(savedDismissed[block.eventId]);
          const isStudy = block.blockKind === 'study_block' || block.blockKind === 'recall_sprint';
          const isDebt = Boolean(isStudy && !block.optional && timingState === 'past' && !completed && !dismissed && Number.isFinite(end) && end >= debtCutoff);
          return { ...block, timingState, completed, completedAt, completedEarly, dismissed, isDebt };
        }),
      };
      boot.scheduleConfig = {
        enabled: true,
        source: ws.customSchedule.source || 'browser_schedule',
        prefs: ws.customSchedule.prefs || {},
        estimate: ws.customSchedule.estimate || null,
        aiSummary: ws.customSchedule.aiSummary || '',
        modelLabel: ws.customSchedule.modelLabel || '',
      };
    } else {
      boot.calendar = { source: 'static_web', blocks: [] };
      boot.scheduleConfig = { enabled: false, prefs: ws.customSchedule?.prefs || {} };
    }
  }

  // ---------------------------------------------------------------------------
  // SCHEDULED QUEUE: CLEAR METADATA, EARLY COMPLETION & ROLLOVER STUDY DEBT
  // ---------------------------------------------------------------------------
  function readLocalSchedStatus() {
    try {
      const raw = JSON.parse(localStorage.getItem(LOCAL_SCHED_STATUS_KEY) || '{}');
      return {
        completed: isRecord(raw.completed) ? raw.completed : {},
        dismissed: isRecord(raw.dismissed) ? raw.dismissed : {},
      };
    } catch {
      return { completed: {}, dismissed: {} };
    }
  }

  function writeLocalSchedStatus(data) {
    try { localStorage.setItem(LOCAL_SCHED_STATUS_KEY, JSON.stringify(data)); } catch {}
  }

  function getBlockEffectiveState(block) {
    const id = String(block?.eventId || '');
    const nowMs = Date.now();
    const startMs = Date.parse(block?.startIso || '');
    const endMs = Date.parse(block?.endIso || '');
    const timingState = Number.isFinite(endMs) && endMs <= nowMs
      ? 'past'
      : Number.isFinite(startMs) && startMs <= nowMs
      ? 'live_now'
      : block?.timingState || 'upcoming';

    let completed = Boolean(block?.completed);
    let completedAt = block?.completedAt || '';
    let completedEarly = Boolean(block?.completedEarly);
    let dismissed = Boolean(block?.dismissed);

    if (!isStaticWeb) {
      const loc = readLocalSchedStatus();
      if (loc.completed[id]) {
        completed = true;
        completedAt = loc.completed[id].at || completedAt;
        completedEarly = Boolean(loc.completed[id].early);
      } else if (loc.completed[id] === false) {
        completed = false;
      }
      if (!completed && loc.dismissed[id]) dismissed = true;
    }

    if (isDevSandbox()) {
      if (sandboxSchedCompleted.has(id)) {
        const s = sandboxSchedCompleted.get(id);
        completed = Boolean(s);
        completedEarly = Boolean(s?.early);
        completedAt = s?.at || '';
      }
      if (sandboxSchedDismissed.has(id)) dismissed = true;
    }

    const isStudy = block?.blockKind === 'study_block' || block?.blockKind === 'recall_sprint';
    const isDebt = Boolean(
      isStudy && !block.optional && timingState === 'past' && !completed && !dismissed && Number.isFinite(endMs) && endMs >= nowMs - SCHED_DEBT_WINDOW_MS
    );
    return { timingState, completed, completedAt, completedEarly, dismissed, isDebt, startMs, endMs };
  }

  function setScheduleBlockCompleted(eventId, done, block = null, method = 'manual') {
    const id = String(eventId || '');
    if (!id) return;
    const nowIso = new Date().toISOString();
    const startMs = Date.parse(block?.startIso || '');
    const isEarly = Boolean(done && Number.isFinite(startMs) && startMs > Date.now());
    const wasDebt = Boolean(block && getBlockEffectiveState(block).isDebt);

    if (isDevSandbox()) {
      if (done) {
        sandboxSchedCompleted.set(id, { at: nowIso, early: isEarly, method });
        sandboxSchedDismissed.delete(id);
      } else {
        sandboxSchedCompleted.set(id, false);
      }
      if (currentView === 'home') renderHome();
      else if (currentView === 'schedule') renderScheduleStudio();
      toast(done ? (wasDebt ? 'Dev Sandbox · Debt cleared ✓' : isEarly ? 'Dev Sandbox · Completed early ✓' : 'Dev Sandbox · Marked done ✓') : 'Dev Sandbox · Returned to queue');
      return;
    }

    if (isStaticWeb) {
      const ws = loadWebState();
      if (!isRecord(ws.customSchedule)) ws.customSchedule = { enabled: false, prefs: {}, blocks: [] };
      if (!isRecord(ws.customSchedule.completedEvents)) ws.customSchedule.completedEvents = {};
      if (!isRecord(ws.customSchedule.dismissedEvents)) ws.customSchedule.dismissedEvents = {};
      if (done) {
        ws.customSchedule.completedEvents[id] = { at: nowIso, early: isEarly, method };
        delete ws.customSchedule.dismissedEvents[id];
      } else {
        delete ws.customSchedule.completedEvents[id];
        delete ws.customSchedule.dismissedEvents[id];
      }
      ws.customSchedule.updatedAt = nowIso;
      saveWebState(ws);
      recomputeWebAnalytics();
      queueCloudSync();
    } else {
      const loc = readLocalSchedStatus();
      if (done) {
        loc.completed[id] = { at: nowIso, early: isEarly, method };
        delete loc.dismissed[id];
      } else {
        loc.completed[id] = false;
        delete loc.dismissed[id];
      }
      writeLocalSchedStatus(loc);
    }

    if (method === 'manual') {
      toast(done ? (wasDebt ? 'Study debt cleared ✓' : isEarly ? 'Completed ahead of schedule ✓' : 'Block marked done ✓') : 'Returned to active queue.');
      if (currentView === 'home') renderHome();
      else if (currentView === 'schedule') renderScheduleStudio();
    }
  }

  function dismissScheduleDebt(eventIds) {
    const ids = (Array.isArray(eventIds) ? eventIds : [eventIds]).filter(Boolean);
    if (!ids.length) return;
    const nowIso = new Date().toISOString();
    if (isDevSandbox()) {
      ids.forEach((id) => sandboxSchedDismissed.add(id));
      if (currentView === 'home') renderHome();
      else if (currentView === 'schedule') renderScheduleStudio();
      toast(`Dev Sandbox · Cleared ${ids.length} overdue block${ids.length === 1 ? '' : 's'}.`);
      return;
    }
    if (isStaticWeb) {
      const ws = loadWebState();
      if (!isRecord(ws.customSchedule)) return;
      if (!isRecord(ws.customSchedule.dismissedEvents)) ws.customSchedule.dismissedEvents = {};
      ids.forEach((id) => { ws.customSchedule.dismissedEvents[id] = nowIso; });
      ws.customSchedule.updatedAt = nowIso;
      saveWebState(ws);
      recomputeWebAnalytics();
      queueCloudSync();
    } else {
      const loc = readLocalSchedStatus();
      ids.forEach((id) => { loc.dismissed[id] = nowIso; });
      writeLocalSchedStatus(loc);
    }
    toast(`Forgave ${ids.length} overdue block${ids.length === 1 ? '' : 's'}.`);
    if (currentView === 'home') renderHome();
    else if (currentView === 'schedule') renderScheduleStudio();
  }

  function formatDurationShort(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const r = m % 60;
      return r ? `${h}h ${r}m` : `${h}h`;
    }
    return `${m}m`;
  }

  function formatRelativeScheduleWhen(block, st) {
    const osloDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' });
    const shortDateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', weekday: 'short', day: 'numeric', month: 'short' });
    const now = new Date();
    const todayKey = osloDayFmt.format(now);
    const tomorrowKey = osloDayFmt.format(new Date(now.getTime() + 86_400_000));
    const yesterdayKey = osloDayFmt.format(new Date(now.getTime() - 86_400_000));
    const bDate = block.date || (Number.isFinite(st.startMs) ? osloDayFmt.format(new Date(st.startMs)) : '');
    const timeRange = block.startLabel && block.endLabel ? `${block.startLabel}–${block.endLabel}` : (block.startLabel || '');
    const dayWord = bDate === todayKey
      ? 'Today'
      : bDate === tomorrowKey
      ? 'Tomorrow'
      : bDate === yesterdayKey
      ? 'Yesterday'
      : (Number.isFinite(st.startMs) ? shortDateFmt.format(new Date(st.startMs)) : bDate);

    if (st.isDebt) {
      return `Overdue · ${dayWord}${block.startLabel ? ` ${block.startLabel}` : ''}`;
    }
    if (st.timingState === 'live_now') {
      return `LIVE NOW · ${timeRange}`;
    }
    return `${dayWord}${timeRange ? ` · ${timeRange}` : ''}`;
  }

  const SCHED_STOP_WORDS = new Set([
    'hard', 'medium', 'easy', 'high', 'med', 'low', 'dlpfc', 'synthesis', 'drills', 'drill',
    'recap', 'practice', 'block', 'study', 'timed', 'lecture', 'session', 'review', 'recall',
    'sprint', 'procedural', 'active', 'and', 'the', 'for', 'from', 'with', 'into', 'build', 'clean',
  ]);

  function inferBlockDlpfc(block) {
    const rawMode = block.dlpfcMode || block.autoQueue?.cognitiveMode || '';
    const sum = String(block.summary || '');
    let mode = rawMode;
    if (!mode) {
      if (/\b(high\s*dlpfc|hard)\b/i.test(sum)) mode = 'high_dlpfc';
      else if (/\b(low\s*dlpfc|easy|recall)\b/i.test(sum) || block.blockKind === 'recall_sprint') mode = 'low_dlpfc';
      else if (/\b(med(?:ium)?\s*dlpfc|medium)\b/i.test(sum)) mode = 'med_dlpfc';
      else {
        const h = Number(String(block.startLabel || '').split(':')[0]);
        if (Number.isFinite(h)) mode = h < 15 ? 'high_dlpfc' : h < 18 ? 'med_dlpfc' : 'low_dlpfc';
        else mode = getResolvedFocusMode();
      }
    }
    const tier = mode === 'high_dlpfc' ? 3 : mode === 'low_dlpfc' ? 1 : 2;
    const label = window.StudyLayout?.label?.(tier) || (tier === 3 ? 'High DLPFC' : tier === 2 ? 'Med DLPFC' : 'Low DLPFC');
    return { mode, tier, label };
  }

  function cleanBlockSummary(summary, course) {
    let s = String(summary || '').trim();
    s = s.replace(/^\[(?:high|med(?:ium)?|low)\s*dlpfc\]\s*/i, '');
    s = s.replace(/^(?:high|med(?:ium)?|low)\s*dlpfc\s*[·:\-—]\s*/i, '');
    s = s.replace(/^(?:hard|medium|easy|deep|recall)\s*[·:\-—]\s*/i, '');
    if (course?.code) {
      const codeRe = new RegExp(`^${course.code.replace(/\s+/g, '\\s*')}\\s*[·:\\-—]\\s*`, 'i');
      s = s.replace(codeRe, '');
    }
    if (course?.shortTitle) {
      const shortRe = new RegExp(`^${course.shortTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[·:\\-—]\\s*`, 'i');
      s = s.replace(shortRe, '');
    }
    return s.trim() || String(summary || 'Study block').trim();
  }

  function matchBlockTopics(block, course) {
    const topics = Array.isArray(course?.topics) ? course.topics : [];
    if (!topics.length) return [];
    const byId = new Map(topics.map((t) => [String(t.id), t]));
    if (Array.isArray(block.topicIds) && block.topicIds.length) {
      const explicit = block.topicIds.map((id) => byId.get(String(id))).filter(Boolean);
      if (explicit.length) return explicit.slice(0, 2);
    }
    const text = `${block.summary || ''} ${block.focusNote || ''}`.toLowerCase();
    const tokens = text
      .replace(/[^a-z0-9æøå]+/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !SCHED_STOP_WORDS.has(w));
    if (!tokens.length) return [];

    let best = null;
    let bestScore = 0;
    for (const t of topics) {
      const hay = `${t.title || ''} ${(t.keywords || []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        const stem = tok.replace(/(?:ing|tion|sation|zation|ies|es|s)$/, '');
        if (hay.includes(tok)) score += 3;
        else if (stem.length >= 4 && hay.includes(stem)) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best && bestScore >= 2 ? [best] : [];
  }

  function formatTopicShort(topic) {
    if (!topic) return '';
    const raw = String(topic.title || '').replace(/^(?:chapter|lesson|topic)\s*\d+\s*[·:\-—]\s*/i, '').trim();
    return `T${topic.id} · ${raw}`;
  }

  const homeDifficultyLabels = ['', 'Low', 'Med', 'High'];

  function homeBlockTitle(topicLabel, course) {
    return String(topicLabel || '').replace(/^T\d+ · /, '').trim() || course?.title || 'Study block';
  }

  function homeBlockDifficulty(tier) {
    return tier > 1
      ? `<span class="diff-badge diff-${tier}">${homeDifficultyLabels[tier]}</span>`
      : '';
  }

  function describeScheduledBlock(block) {
    const st = getBlockEffectiveState(block);
    const catalog = boot.catalog || [];
    let course = catalog.find((c) => c.courseId === block.courseId) || null;
    if (!course && block.summary) {
      const low = String(block.summary).toLowerCase();
      course = catalog.find((c) =>
        (c.code && low.includes(c.code.toLowerCase())) ||
        (c.shortTitle && c.shortTitle.length >= 4 && low.includes(c.shortTitle.toLowerCase()))
      ) || null;
    }
    const dlpfc = inferBlockDlpfc(block);
    const hydrated = hydratedBlockCache.get(block.eventId) || null;
    const matched = matchBlockTopics(block, course);
    const cleanTitle = cleanBlockSummary(block.summary, course);

    let topicIds = matched.map((t) => String(t.id));
    let topicLabel = matched.length ? formatTopicShort(matched[0]) : '';
    if (!topicLabel && hydrated?.topicLabel) {
      topicLabel = hydrated.topicLabel;
      topicIds = hydrated.topicIds || topicIds;
    } else if (!topicLabel && block.topicTitle) {
      topicLabel = block.topicTitle;
    }

    const isGenericTitle = /^(synthesis|procedural|recall|study block|practice)$/i.test(cleanTitle);
    const displayTitle = isGenericTitle && topicLabel ? topicLabel : cleanTitle;
    const showTopicPill = Boolean(topicLabel && topicLabel.toLowerCase() !== displayTitle.toLowerCase());

    const serverQCount = block.autoQueue?.questionIds?.length || 0;
    const qCount = hydrated ? hydrated.count : serverQCount;
    const mins = hydrated?.estMin || Number(block.focusMinutes || 50);
    const queueLabel = qCount > 0
      ? `${qCount} ${qCount === 1 ? 'task' : 'tasks'} · ~${Math.max(10, Math.round(mins))}m`
      : `${Math.max(15, Number(block.focusMinutes || 50))}m block`;

    return {
      block,
      st,
      course,
      dlpfc,
      topicIds,
      topicLabel,
      showTopicPill,
      displayTitle,
      whenLabel: formatRelativeScheduleWhen(block, st),
      queueLabel,
      canLaunch: Boolean(course?.courseId || block.courseId),
    };
  }

  function getScheduledQueueState() {
    const allStudy = (boot.calendar?.blocks || [])
      .filter((b) => b.blockKind === 'study_block' || b.blockKind === 'recall_sprint');
    const debtBlocks = [];
    const liveBlocks = [];
    const upcomingBlocks = [];
    const completedBlocks = [];

    for (const b of allStudy) {
      const st = getBlockEffectiveState(b);
      if (st.completed) {
        completedBlocks.push(b);
      } else if (st.isDebt) {
        debtBlocks.push(b);
      } else if (st.timingState === 'live_now') {
        liveBlocks.push(b);
      } else if (st.timingState === 'upcoming') {
        upcomingBlocks.push(b);
      }
    }
    debtBlocks.sort((a, b) => Date.parse(a.startIso || '') - Date.parse(b.startIso || ''));
    liveBlocks.sort((a, b) => Date.parse(a.startIso || '') - Date.parse(b.startIso || ''));
    upcomingBlocks.sort((a, b) => Date.parse(a.startIso || '') - Date.parse(b.startIso || ''));
    completedBlocks.sort((a, b) => Date.parse(b.startIso || '') - Date.parse(a.startIso || ''));

    const debtMinutes = debtBlocks.reduce((sum, b) => sum + Number(b.focusMinutes || 50), 0);
    const earlyCount = completedBlocks.filter((b) => getBlockEffectiveState(b).completedEarly).length;
    const queue = [...liveBlocks, ...debtBlocks, ...upcomingBlocks];
    return { debtBlocks, liveBlocks, upcomingBlocks, completedBlocks, queue, debtMinutes, earlyCount };
  }

  async function hydrateVisibleScheduledBlocks(blocks) {
    const targets = (blocks || []).filter((b) => {
      const cid = describeScheduledBlock(b).course?.courseId || b.courseId;
      return cid && !b.autoQueue?.questionIds?.length && !hydratedBlockCache.has(b.eventId);
    });
    if (!targets.length) return;
    const uniqueCourseIds = [...new Set(targets.map((b) => describeScheduledBlock(b).course?.courseId || b.courseId).filter(Boolean))];
    await Promise.all(uniqueCourseIds.map((cid) => ensureCourseBank(cid).catch(() => null)));

    for (const b of targets) {
      const meta = describeScheduledBlock(b);
      const cid = meta.course?.courseId || b.courseId;
      const bank = bankCache[cid];
      if (!bank?.questions?.length) continue;
      const prof = b.recommendedProfile || 'learning';
      const budget = Number(b.attemptBudgetMinutes || b.focusMinutes || homeBlockMinutes || 50);
      const effMode = sessionFocusMode !== 'auto' ? getResolvedFocusMode() : meta.dlpfc.mode;
      const qids = buildEffortSortedQueue(bank.questions, budget, prof, meta.topicIds, effMode);
      const qById = new Map(bank.questions.map((q) => [q.id, q]));
      const chosenQs = qids.map((id) => qById.get(id)).filter(Boolean);
      const estMin = Math.round(chosenQs.reduce((s, q) => s + calibratedParSec(q, prof) / 60, 0));
      const firstQ = chosenQs[0] || null;
      const topTopic = firstQ ? (bank.topics || []).find((t) => String(t.id) === String(firstQ.topicId)) : null;
      const info = {
        questionIds: qids,
        count: chosenQs.length,
        estMin: estMin || Number(b.focusMinutes || 50),
        topicIds: meta.topicIds.length ? meta.topicIds : (topTopic ? [String(topTopic.id)] : []),
        topicLabel: meta.topicLabel || (topTopic ? formatTopicShort(topTopic) : ''),
      };
      hydratedBlockCache.set(b.eventId, info);

      // Update live Home DOM cleanly without full re-render flicker
      const escId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(b.eventId) : b.eventId.replace(/"/g, '\\"');
      document.querySelectorAll(`[data-sched-count-for="${escId}"]`).forEach((el) => {
        el.textContent = info.count > 0
          ? `${info.count} ${info.count === 1 ? 'task' : 'tasks'} · ~${Math.max(10, info.estMin)}m`
          : `${Number(b.focusMinutes || 50)}m review`;
      });
      if (info.topicLabel) {
        const title = homeBlockTitle(info.topicLabel, meta.course);
        document.querySelectorAll(`[data-sched-topic-for="${escId}"]`).forEach((el) => {
          el.textContent = title;
          el.closest('#hero-active-block')?.setAttribute('aria-label', `Launch ${title}`);
        });
      }
    }
  }

  function isStaticMode() {
    return isStaticWeb;
  }

  function communityStats() {
    const state = loadWebState();
    const attempts = state.attempts;
    const brk = window.StudyUI.workClock?.getBreakStats?.() || { totalBreakMinutes: 0, totalBreaks: 0, lastBreakAtMs: 0 };
    return {
      minutes: Math.round(attempts.reduce((total, attempt) => total + (Number(attempt.activeSec) || 0), 0) / 60),
      completed: Object.values(state.records).filter((record) => record.status === 'done').length,
      attempts: attempts.length,
      accuracy: attempts.length
        ? Math.round(100 * attempts.reduce((total, attempt) => total + (Number(attempt.qualityAccuracy) || 0), 0) / attempts.length)
        : 0,
      breakMinutes: Math.max(0, Math.round(Number(brk.totalBreakMinutes) || 0)),
      breakCount: Math.max(0, Math.round(Number(brk.totalBreaks) || 0)),
      lastBreakAt: Math.max(0, Math.round(Number(brk.lastBreakAtMs) || 0)),
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
    const staticUrl = `./static-data/courses/${encodeURIComponent(courseId)}.json`;
    if (isStaticWeb && members.course(courseId)) {
      const [bank, pubBank] = await Promise.all([
        members.loadBank(courseId),
        apiGet(staticUrl).catch(() => null),
      ]);
      if (bank && pubBank) {
        const seenCols = new Map((bank.collections || []).map((c) => [c.id, c]));
        for (const pc of pubBank.collections || []) {
          if (!seenCols.has(pc.id)) {
            (bank.collections ||= []).push(pc);
            seenCols.set(pc.id, pc);
          } else if (pc.id === 'tutoring' && pc.title && seenCols.get(pc.id).title !== pc.title) {
            seenCols.get(pc.id).title = pc.title;
          }
        }
        const existingById = new Map((bank.questions || []).map((q) => [q.id, q]));
        for (const pq of pubBank.questions || []) {
          if (!pq?.id) continue;
          const cur = existingById.get(pq.id);
          if (!cur) {
            (bank.questions ||= []).push(pq);
            existingById.set(pq.id, pq);
          } else if (pq.provenance?.category !== 'book') {
            const revBump = Number(pq.contentRevision || 0) > Number(cur.contentRevision || 0);
            const richerPrompt = Boolean(pq.promptMarkdown)
              && pq.promptMarkdown.length > (cur.promptMarkdown || '').length + 120;
            const addedSlots = Array.isArray(pq.wiseflowFields) && pq.wiseflowFields.length > 0
              && (!Array.isArray(cur.wiseflowFields) || cur.wiseflowFields.length === 0);
            if (revBump || richerPrompt || addedSlots) {
              if (pq.promptMarkdown) cur.promptMarkdown = pq.promptMarkdown;
              if (Array.isArray(pq.wiseflowFields) && pq.wiseflowFields.length) cur.wiseflowFields = pq.wiseflowFields;
              if (pq.solutionMarkdown && (revBump || pq.solutionMarkdown.length > (cur.solutionMarkdown || '').length)) {
                cur.solutionMarkdown = pq.solutionMarkdown;
              }
              if (revBump && Array.isArray(pq.hints) && pq.hints.length) cur.hints = pq.hints;
              if (revBump && Array.isArray(pq.rubricChecks) && pq.rubricChecks.length) cur.rubricChecks = pq.rubricChecks;
              if (revBump && pq.pitfall) cur.pitfall = pq.pitfall;
              if (pq.contentRevision) cur.contentRevision = pq.contentRevision;
            }
          }
        }
        bank.sources ||= {};
        for (const [sid, smeta] of Object.entries(pubBank.sources || {})) {
          if (!(sid in bank.sources)) bank.sources[sid] = smeta;
        }
      }
      bankCache[courseId] = bank;
      return bank;
    }
    const url = isStaticWeb ? staticUrl : `/api/course/${encodeURIComponent(courseId)}`;
    const bank = await apiGet(url);
    bankCache[courseId] = bank;
    return bank;
  }

  async function refreshArchiveViews() {
    for (const courseId of Object.keys(bankCache)) delete bankCache[courseId];
    await refreshBootstrap();
    if (!document.getElementById('view-runner').hidden) window.StudyRunner.refreshCurrent();
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

  function readCourseFiltersFromSearch(searchStr = window.location.search) {
    const p = new URLSearchParams(searchStr || '');
    const dRaw = (p.get('diff') || '').trim().toLowerCase();
    const dlRaw = (p.get('dlpfc') || '').trim().toLowerCase();
    const v = dRaw || dlRaw;
    const diff = (v === '3' || v === 'high' || v === 'high_dlpfc' || v === 'hard') ? '3'
      : (v === '2' || v === 'med' || v === 'medium' || v === 'med_dlpfc') ? '2'
      : (v === '1' || v === 'low' || v === 'low_dlpfc' || v === 'easy') ? '1'
      : (v === '2plus' || v === 'med_high') ? '2plus'
      : '';
    return {
      preset: (p.get('preset') || '').trim(),
      origin: (p.get('origin') || '').trim(),
      real: p.get('real') === '1' || p.get('real') === 'true',
      topic: (p.get('topic') || '').trim(),
      coll: (p.get('coll') || p.get('collection') || '').trim(),
      kind: (p.get('kind') || p.get('format') || '').trim(),
      diff,
      horizon: (p.get('horizon') || '').trim(),
      status: (p.get('status') || '').trim(),
      sort: (p.get('sort') || '').trim(),
      budget: (p.get('budget') || '').trim(),
      profile: (p.get('profile') || '').trim(),
      q: (p.get('q') || p.get('search') || '').trim(),
    };
  }

  async function refreshBootstrap(forceCalendar = false) {
    if (isStaticWeb) {
      const bootVer = document.documentElement.dataset.bootV || '';
      boot = await apiGet(`./static-data/bootstrap.json${bootVer ? `?v=${encodeURIComponent(bootVer)}` : ''}`);
      if (members.isUnlocked()) {
        boot.catalog = boot.catalog.map((entry) => {
          const mCat = members.course(entry.courseId)?.catalog;
          if (!mCat) return entry;
          const entryColls = Array.isArray(entry.collections) ? entry.collections : [];
          const mColls = Array.isArray(mCat.collections) ? mCat.collections : [];
          const entryById = new Map(entryColls.map((col) => [String(col.id), col]));
          const seenCollIds = new Set();
          const mergedColls = [];
          for (const mc of mColls) {
            const cid = String(mc.id || '');
            const ec = entryById.get(cid);
            seenCollIds.add(cid);
            if (ec) {
              const mergedQids = (Array.isArray(ec.questionIds) && ec.questionIds.length)
                ? ec.questionIds
                : (Array.isArray(mc.questionIds) ? mc.questionIds : []);
              mergedColls.push({
                ...mc,
                ...ec,
                questionIds: mergedQids,
                questionCount: Math.max(Number(ec.questionCount || 0), Number(mc.questionCount || 0), mergedQids.length),
                parMinutes: Number(ec.parMinutes || mc.parMinutes || 0),
                totalPoints: Number(ec.totalPoints || mc.totalPoints || 0),
                gradingMode: ec.gradingMode || mc.gradingMode || '',
                durationMinutes: Number(ec.durationMinutes || mc.durationMinutes || 0) || undefined,
              });
            } else {
              mergedColls.push(mc);
            }
          }
          for (const ec of entryColls) {
            const cid = String(ec.id || '');
            if (!seenCollIds.has(cid)) mergedColls.push(ec);
          }
          return {
            ...entry,
            ...mCat,
            collections: mergedColls,
            questionCount: Math.max(Number(entry.questionCount || 0), Number(mCat.questionCount || 0)),
          };
        });
        for (const ref of boot.references) {
          const course = members.course(ref.courseId);
          if (course) ref.questionCount = Math.max(Number(ref.questionCount || 0), Number(course.catalog?.questionCount || 0));
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
    else if (currentView === 'course') await renderCourseExplorer(selectedCourseId, '', readCourseFiltersFromSearch());
    else if (currentView === 'analytics') renderAnalytics();
  }

  function updateHeaderStats() {
    const a = boot.analytics || {};
    const upi = a.overall?.upi;
    const upiEl = document.getElementById('hdr-upi');
    if (upiEl) upiEl.textContent = upi != null ? String(upi) : '—';
    const streakEl = document.getElementById('hdr-streak');
    if (streakEl) streakEl.textContent = `${a.streakDays || 0}d`;
    const xpEl = document.getElementById('hdr-xp');
    if (xpEl) xpEl.textContent = `${a.totalXp || 0} XP`;
    syncSettingsRows();
  }

  let cloudSyncTimer = null;
  let cloudSyncInFlight = false;
  let cloudSyncMeta = { status: '', updatedAt: 0, recordCount: 0 };

  function screenHistoryTotalSec(hist) {
    if (!isRecord(hist)) return 0;
    let total = 0;
    for (const v of Object.values(hist)) {
      if (!isRecord(v)) continue;
      total += Math.max(0, Number(v.screenSec) || 0) + Math.max(0, Number(v.activeSec) || 0);
    }
    return Math.round(total);
  }

  function buildWebBackupPayload() {
    flushPendingDrafts();
    const ws = loadWebState();
    return {
      exportedAt: new Date().toISOString(),
      format: 'study-os-backup-v1',
      progress: { records: ws.records },
      attempts: ws.attempts,
      sessions: ws.sessions,
      customSchedule: {
        ...ws.customSchedule,
        prefs: { ...ws.customSchedule.prefs, timeeditUrl: undefined },
      },
      canvasSnapshot: ws.canvasSnapshot,
      edSnapshot: ws.edSnapshot,
      customSets: window.StudySets?.exportForSync?.() || [],
      screenHistory: window.StudyUI?.workClock?.getScreenHistory?.() || {},
      telemetryByDevice: window.StudyUI?.workClock?.getTelemetryByDevice?.() || {},
      examResults: isRecord(ws.examResults) ? ws.examResults : {},
    };
  }

  const isDevSandbox = () => Boolean(window.StudyUI?.devMode?.isActive?.());

  async function syncCloudProgress({ interactive = false, pushOnly = false } = {}) {
    if (isDevSandbox()) {
      if (interactive) toast('Dev Mode ON — cloud sync is paused.');
      return false;
    }
    if (!isStaticWeb || !window.StudyCommunity?.isSignedIn?.()) return;
    if (cloudSyncInFlight) return;
    cloudSyncInFlight = true;
    cloudSyncMeta.status = 'Syncing…';
    syncSettingsRows();
    try {
      let mergedFromCloud = false;
      let cloudRecCount = 0;
      let cloudAttemptCount = 0;
      let cloudSessionCount = 0;
      let cloudScheduleAt = 0;
      let cloudCanvasAt = 0;
      let cloudEdAt = 0;
      let cloudSetCount = 0;
      let cloudScreenTotal = 0;
      let cloudExamResCount = 0;
      if (!pushOnly) {
        const remote = await window.StudyCommunity.fetchCloudBackup();
        if (remote?.hasBackup && remote.data) {
          cloudRecCount = Number(remote.recordCount || 0);
          cloudAttemptCount = Number(remote.attemptCount || 0);
          cloudSessionCount = Number(remote.sessionCount || 0);
          cloudScheduleAt = backupTime(remote.data.customSchedule?.updatedAt);
          cloudCanvasAt = backupTime(remote.data.canvasSnapshot?.syncedAt);
          cloudEdAt = backupTime(remote.data.edSnapshot?.syncedAt);
          cloudSetCount = Array.isArray(remote.data.customSets) ? remote.data.customSets.length : 0;
          cloudScreenTotal = screenHistoryTotalSec(remote.data.screenHistory);
          cloudExamResCount = isRecord(remote.data.examResults) ? Object.keys(remote.data.examResults).length : 0;
          const msg = restoreWebBackup(remote.data);
          if (msg && msg.startsWith('Restored ')) {
            mergedFromCloud = true;
            recomputeWebAnalytics();
            updateHeaderStats();
            if (currentView === 'home') renderHome();
            else if (currentView === 'analytics') renderAnalytics();
            else if (currentView === 'schedule') renderScheduleStudio();
            else if (currentView === 'exams') renderExamsHub();
          }
        }
      }
      const payload = buildWebBackupPayload();
      const localRecCount = Object.keys(payload.progress.records || {}).length;
      const localAttemptCount = (payload.attempts || []).length;
      const localSessionCount = (payload.sessions || []).length;
      const localSetCount = (payload.customSets || []).length;
      const localScreenTotal = screenHistoryTotalSec(payload.screenHistory);
      const localExamResCount = isRecord(payload.examResults) ? Object.keys(payload.examResults).length : 0;
      const scheduleAt = backupTime(payload.customSchedule.updatedAt);
      const canvasAt = backupTime(payload.canvasSnapshot?.syncedAt);
      const edAt = backupTime(payload.edSnapshot?.syncedAt);
      const hasLocalData = localRecCount > 0 || localAttemptCount > 0 || localSessionCount > 0 || localSetCount > 0 || localScreenTotal > 60 || localExamResCount > 0 || scheduleAt > 0 || canvasAt > 0 || edAt > 0;
      const shouldPush = pushOnly || interactive || (hasLocalData && (
        localRecCount !== cloudRecCount || localAttemptCount !== cloudAttemptCount || localSessionCount !== cloudSessionCount ||
        localSetCount !== cloudSetCount || localScreenTotal > cloudScreenTotal + 60 || localExamResCount !== cloudExamResCount || scheduleAt > cloudScheduleAt || canvasAt > cloudCanvasAt || edAt > cloudEdAt || mergedFromCloud
      ));
      if (shouldPush) {
        const res = await window.StudyCommunity.pushCloudBackup(payload);
        cloudSyncMeta = {
          status: 'Synced',
          updatedAt: Number(res?.updatedAt || Date.now()),
          recordCount: Number(res?.recordCount ?? localRecCount),
        };
      } else {
        cloudSyncMeta = {
          status: 'Synced',
          updatedAt: Date.now(),
          recordCount: Math.max(localRecCount, cloudRecCount),
        };
      }
      if (interactive) {
        toast(mergedFromCloud ? 'Study data merged across your devices.' : 'Study data synced across your devices.');
      }
      return true;
    } catch (err) {
      cloudSyncMeta.status = 'Retry';
      if (interactive) toast(err?.message || 'Could not sync progress right now.');
      return false;
    } finally {
      cloudSyncInFlight = false;
      syncSettingsRows();
    }
  }

  function queueCloudSync() {
    if (isDevSandbox()) return;
    if (!isStaticWeb || !window.StudyCommunity?.isSignedIn?.()) return;
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(() => {
      syncCloudProgress({ pushOnly: true }).catch(() => {});
    }, 2500);
  }

  let adminAutoUnlockAttempted = false;
  function syncSettingsRows() {
    window.StudyUI?.devMode?.syncUi?.();
    const communityOn = Boolean(window.StudyCommunity?.enabled);
    const signedIn = Boolean(window.StudyCommunity?.isSignedIn?.());
    const prof = window.StudyCommunity?.getCurrentProfile?.() || null;
    if (signedIn && prof?.isAdmin && prof?.memberKey && members.enabled && !members.isUnlocked() && !adminAutoUnlockAttempted) {
      adminAutoUnlockAttempted = true;
      members.unlock(prof.memberKey, true).then(refreshArchiveViews).catch(() => {});
    }
    const hdrSignIn = document.getElementById('hdr-signin-btn');
    if (hdrSignIn) hdrSignIn.hidden = !isStaticWeb || !communityOn || signedIn;
    const syncTip = document.getElementById('mobile-sync-tip');
    let tipDismissed = false;
    try { tipDismissed = sessionStorage.getItem('study-os-dismiss-mobile-sync') === '1'; } catch {}
    syncTip.hidden = !isStaticWeb || !communityOn || tipDismissed ||
      (signedIn && boot.scheduleConfig?.enabled && Boolean(loadWebState().canvasSnapshot));
    document.getElementById('mobile-sync-action').textContent = signedIn ? 'Open Schedule' : 'Sign in';

    const profileAvatar = document.getElementById('settings-profile-avatar');
    const runnerAvatar = document.getElementById('run-profile-avatar');
    const runnerIcon = document.getElementById('run-profile-icon');
    const hasRunnerAvatar = Boolean(signedIn && prof);
    if (runnerAvatar) {
      runnerAvatar.hidden = !hasRunnerAvatar;
      runnerAvatar.style.display = hasRunnerAvatar ? '' : 'none';
      runnerAvatar.innerHTML = hasRunnerAvatar ? window.StudyCommunity.avatarHtml(prof.nickname, prof.avatar, 24) : '';
    }
    if (runnerIcon) {
      runnerIcon.toggleAttribute('hidden', hasRunnerAvatar);
      runnerIcon.style.display = hasRunnerAvatar ? 'none' : '';
    }
    const profileName = document.getElementById('settings-profile-name');
    const modeBadge = document.getElementById('settings-mode-badge');
    if (signedIn && prof) {
      if (profileAvatar) {
        profileAvatar.classList.add('ios-profile-has-avatar');
        profileAvatar.innerHTML = window.StudyCommunity.avatarHtml(prof.nickname, prof.avatar, 44);
      }
      if (profileName) {
        profileName.innerHTML = `${esc(prof.nickname)}${prof.isAdmin ? ' <span class="badge admin-badge" style="font-size:10.5px;padding:1px 7px;vertical-align:middle">Admin</span>' : ''}`;
      }
      if (modeBadge) {
        modeBadge.textContent = 'Profile';
        modeBadge.classList.toggle('ios-val-live', false);
      }
    } else {
      if (profileAvatar && profileAvatar.classList.contains('ios-profile-has-avatar')) {
        profileAvatar.classList.remove('ios-profile-has-avatar');
        profileAvatar.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>';
      }
      if (profileName) profileName.textContent = isStaticWeb && communityOn ? 'Study-OS · Demo' : 'Study-OS';
      if (modeBadge) modeBadge.textContent = isStaticWeb ? (communityOn ? 'Sign in' : 'Web') : 'Desktop';
    }

    const profileChevron = document.getElementById('settings-profile-chevron');
    if (profileChevron) profileChevron.hidden = !communityOn;
    const profileCard = document.getElementById('settings-profile-card');
    if (profileCard) profileCard.classList.toggle('ios-row-static', !communityOn);

    // Account, Passkeys & Cloud Sync Section
    const acctSec = document.getElementById('settings-account-section');
    if (acctSec) acctSec.hidden = !isStaticWeb || !communityOn;
    const signinBtn = document.getElementById('settings-signin-btn');
    if (signinBtn) signinBtn.hidden = !isStaticWeb || !communityOn || signedIn;
    const passkeysBtn = document.getElementById('settings-passkeys-btn');
    if (passkeysBtn) passkeysBtn.hidden = !isStaticWeb || !communityOn || !signedIn;
    const cloudSyncBtn = document.getElementById('settings-cloud-sync-btn');
    if (cloudSyncBtn) {
      cloudSyncBtn.hidden = !isStaticWeb || !communityOn || !signedIn;
      const valEl = document.getElementById('settings-sync-value');
      const subEl = document.getElementById('settings-sync-sub');
      if (valEl) {
        valEl.textContent = cloudSyncMeta.status || 'Sync';
        valEl.classList.toggle('ios-val-live', cloudSyncMeta.status === 'Synced');
      }
      if (subEl) {
        if (cloudSyncMeta.status === 'Synced' && cloudSyncMeta.updatedAt) {
          const t = new Date(cloudSyncMeta.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          subEl.textContent = `Last synced ${t} · ${cloudSyncMeta.recordCount} saved records`;
        } else {
          subEl.textContent = 'Syncs answers, FSRS & schedule across your devices';
        }
      }
    }
    const signoutBtn = document.getElementById('settings-signout-btn');
    if (signoutBtn) signoutBtn.hidden = !isStaticWeb || !communityOn || !signedIn;

    const refreshCal = document.getElementById('btn-refresh-cal');
    if (refreshCal) refreshCal.hidden = isStaticWeb;

    const adminBtn = document.getElementById('btn-study-admin');
    if (adminBtn) adminBtn.hidden = isStaticWeb;

    const desktopSetup = document.getElementById('settings-desktop-setup-link');
    if (desktopSetup) desktopSetup.hidden = !isStaticWeb;

    const memberButton = document.getElementById('btn-member-library');
    if (memberButton) {
      const unlocked = members.isUnlocked();
      memberButton.hidden = !members.enabled;
      const valEl = document.getElementById('settings-member-value');
      if (valEl) {
        valEl.textContent = unlocked ? 'Unlocked' : 'Locked';
        valEl.classList.toggle('ios-val-live', unlocked);
      }
      const subEl = document.getElementById('settings-member-sub');
      if (subEl) {
        subEl.textContent = unlocked
          ? 'Tap to lock the archive on this browser'
          : 'Open the encrypted archive with its key';
      }
    }

    const offlineBtn = document.getElementById('btn-save-offline');
    if (offlineBtn) {
      offlineBtn.hidden = !isStaticWeb;
      const saved = offlineStatus === 'Saved for offline';
      const statusEl = document.getElementById('offline-status');
      if (statusEl) statusEl.textContent = offlineStatus || 'Save notes & questions to this browser';
      const valEl = document.getElementById('settings-offline-value');
      if (valEl) {
        valEl.textContent = saved ? 'Saved' : 'Save';
        valEl.classList.toggle('ios-val-live', saved);
      }
    }

    const ca = boot.canvasArchive || {};
    const biSyncBtn = document.getElementById('settings-bi-sync-btn');
    if (biSyncBtn) {
      biSyncBtn.hidden = !isStaticWeb;
      const biSub = document.getElementById('settings-bi-sync-sub');
      const snap = isStaticWeb ? loadWebState().canvasSnapshot : null;
      if (biSub) {
        biSub.textContent = snap?.courses?.length
          ? `${snap.courses.length} synced courses · click to pair or refresh`
          : '1-click Chrome extension for BI Canvas, TimeEdit & Ed';
      }
    }
    const canvasBrowserLink = document.getElementById('settings-canvas-browser-link');
    if (canvasBrowserLink) canvasBrowserLink.hidden = isStaticWeb;
    const syncTime = ca.lastSyncAt ? ca.lastSyncAt.slice(0, 16).replace('T', ' ') : 'Not synced yet';
    const canvasSyncBtn = document.getElementById('settings-canvas-sync-btn');
    if (canvasSyncBtn) {
      canvasSyncBtn.hidden = isStaticWeb || !ca.hasResyncApp;
      const sub = document.getElementById('settings-canvas-sync-sub');
      if (sub) sub.textContent = ca.connected ? `Last sync: ${syncTime}` : 'Pull updated slides, handouts & PDFs';
    }
    const edSyncBtn = document.getElementById('settings-ed-sync-btn');
    if (edSyncBtn) edSyncBtn.hidden = isStaticWeb || !ca.hasResyncApp;
    const addFilesBtn = document.getElementById('settings-add-files-btn');
    if (addFilesBtn) addFilesBtn.hidden = isStaticWeb || !(ca.hasResyncApp && ca.courses?.length);
    const archivePathBtn = document.getElementById('settings-archive-path-btn');
    if (archivePathBtn) {
      archivePathBtn.hidden = isStaticWeb;
      const sub = document.getElementById('settings-archive-path-sub');
      if (sub) sub.textContent = ca.connected ? (ca.archivePath || 'Connected') : 'Not connected — tap to choose folder';
    }

    window.StudyUI.updateSettingsIndicators?.();
  }

  function showRawView(name, { resetScroll = true } = {}) {
    const wasRunner = document.body.classList.contains('in-runner');
    const isRunner = name === 'runner';
    document.body.classList.toggle('in-runner', isRunner);
    document.body.classList.toggle('in-references', name === 'references');
    if (!isRunner) {
      if (wasRunner) window.StudyRunner?.pauseIfRunning?.();
      document.body.classList.remove('runner-split-wide', 'runner-split-pdf', 'runner-split-ref', 'runner-foveal-compact');
      const gh = document.getElementById('global-header');
      const rh = document.getElementById('runner-header');
      if (gh) gh.hidden = false;
      if (rh) rh.hidden = true;
      const obsLink = document.getElementById('run-obsidian-app-link');
      if (obsLink) obsLink.hidden = true;
      const railRef = document.getElementById('run-ref-btn');
      if (railRef) railRef.hidden = false;
    }
    if (window.StudyUI?.isReferenceDrawerOpen?.()) window.StudyUI.closeReferenceDrawer();
    if (resetScroll) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    for (const v of ['home', 'references', 'schedule', 'exams', 'course', 'runner', 'analytics', 'community', 'room']) {
      const sec = document.getElementById(`view-${v}`);
      if (sec) sec.hidden = v !== name;
    }
    document.querySelectorAll('.tab-btn, .mobile-dock-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.nav === name);
      if (b.dataset.nav === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (resetScroll) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    window.StudyTutor.changed();
    window.StudyAiTutor?.syncContext?.();
  }

  async function navigate(viewName, opts = {}) {
    currentView = viewName;
    if (opts.courseId) selectedCourseId = opts.courseId;
    if (opts.refFile) selectedRefFile = opts.refFile;
    if (viewName !== 'course' && window.location.search) {
      const curParams = new URLSearchParams(window.location.search);
      const keepRefQuery = viewName === 'references' && curParams.get('view') === 'references';
      if (!keepRefQuery && (curParams.has('course') || curParams.has('origin') || curParams.has('diff') || curParams.has('dlpfc') || curParams.has('sort'))) {
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
    const hasScrollTarget = Boolean(opts.focusCourseId || opts.heading || opts.preserveScroll);
    showRawView(viewName, { resetScroll: !opts.preserveScroll });
    const activeCourse = (boot?.catalog || []).find((c) => c.courseId === selectedCourseId);
    const titleMap = {
      home: 'Study-OS · Free Canvas LMS Sync, Exam Prep & WISEflow Workspace',
      references: 'Course Notes & Reference Hub · Study-OS',
      exams: 'WISEflow Mock Exams Hub · Study-OS',
      course: activeCourse ? `${activeCourse.code} ${activeCourse.title} · Study-OS` : 'Courses · Study-OS',
      schedule: 'Adaptive Schedule Studio · Study-OS',
      analytics: 'Study Metrics & UPI · Study-OS',
      community: 'Study Community · Study-OS',
      room: 'Study Room · Study-OS',
    };
    if (titleMap[viewName]) document.title = titleMap[viewName];
    if (viewName === 'home') renderHome();
    else if (viewName === 'references') await renderReferencesHub(opts.refDoc, opts.heading);
    else if (viewName === 'schedule') renderScheduleStudio();
    else if (viewName === 'exams') {
      renderExamsHub(opts.focusCourseId || '');
    } else if (viewName === 'course') await renderCourseExplorer(selectedCourseId, opts.preset || '', opts.filters || null);
    else if (viewName === 'analytics') renderAnalytics();
    else if (viewName === 'community') await window.StudyCommunity.render();
    else if (viewName === 'room') await window.StudyRooms.render();
    if (!hasScrollTarget) {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }
  }

  function daysUntilDateStr(isoDate) {
    if (!isoDate || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return null;
    const now = new Date();
    const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
    const targetUtc = Date.UTC(y, m - 1, d);
    return Math.round((targetUtc - todayUtc) / 86400000);
  }

  function osloDateTimeMs(isoDate, hhmm = '09:00') {
    if (!isoDate || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return null;
    const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
    const match = String(hhmm || '09:00').match(/^(\d{1,2}):(\d{2})$/);
    const hh = match ? Number(match[1]) : 9;
    const mm = match ? Number(match[2]) : 0;
    const guessUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Oslo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(guessUtc));
      const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
      const osloAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
      return guessUtc - (osloAsUtc - guessUtc);
    } catch {
      return guessUtc - 3600000;
    }
  }

  function examTargetMs(examInfo) {
    if (!examInfo?.date) return null;
    const startTime =
      examInfo.startTime ||
      String(examInfo.notes || '').match(/\b(\d{2}:\d{2})\s*[–-]\s*\d{2}:\d{2}\b/)?.[1] ||
      '09:00';
    return osloDateTimeMs(examInfo.date, startTime);
  }

  function formatExamHoverTip(examInfo, targetMs) {
    if (!examInfo?.date) return '';
    const startTime =
      examInfo.startTime ||
      String(examInfo.notes || '').match(/\b(\d{2}:\d{2})\s*[–-]\s*\d{2}:\d{2}\b/)?.[1] ||
      '09:00';
    let dateLabel = examInfo.date;
    try {
      const dt = new Date(Number.isFinite(targetMs) ? targetMs : `${examInfo.date}T09:00:00+01:00`);
      dateLabel = new Intl.DateTimeFormat('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Oslo',
      }).format(dt);
    } catch {}
    const totalHours = Number.isFinite(targetMs) ? Math.max(0, Math.floor((targetMs - Date.now()) / 3600000)) : null;
    return `Exam: ${dateLabel} · ${startTime} Oslo${totalHours !== null ? ` (${totalHours}h left)` : ''}`;
  }

  function formatExamCountdown(targetMs, mode = 'card', nowMs = Date.now()) {
    if (!Number.isFinite(targetMs)) return '';
    const diffSec = Math.floor((targetMs - nowMs) / 1000);
    if (diffSec <= 0) return diffSec > -14400 ? 'Live now' : 'Done';
    const d = Math.floor(diffSec / 86400);
    const h = Math.floor((diffSec % 86400) / 3600);
    const m = Math.floor((diffSec % 3600) / 60);
    const s = diffSec % 60;
    const totalH = Math.floor(diffSec / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    if (mode === 'exam') {
      const core = d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s` : `${pad(h)}h ${pad(m)}m ${pad(s)}s`;
      return `${core} · ${totalH}h left`;
    }
    if (mode === 'hero' || d <= 7) {
      return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s` : `${pad(h)}h ${pad(m)}m ${pad(s)}s`;
    }
    return `${d}d ${pad(h)}h ${pad(m)}m`;
  }

  let examTickerStarted = false;
  function tickExamCountdowns() {
    if (document.hidden) return;
    const nowMs = Date.now();
    document.querySelectorAll('[data-exam-target-ms]').forEach((el) => {
      const targetMs = Number(el.dataset.examTargetMs);
      if (!Number.isFinite(targetMs)) return;
      const mode = el.dataset.examCountdownMode || 'card';
      const next = formatExamCountdown(targetMs, mode, nowMs);
      if (el.textContent !== next) el.textContent = next;
    });
  }
  function ensureExamCountdownTicker() {
    if (examTickerStarted) return;
    examTickerStarted = true;
    setInterval(tickExamCountdowns, 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tickExamCountdowns();
    });
  }

  // ---------------------------------------------------------------------------
  // VIEW 1: COMMAND CENTER (Zero-Decision-Fatigue Calendar Hero + Courses Grid)
  // ---------------------------------------------------------------------------
  const BI_SYNC_STALE_DAYS = 5;

  const KNOWN_CANVAS_SCHOOL_LABELS = {
    'canvas.bi.no': 'BI Oslo',
    'bi.instructure.com': 'BI Oslo',
    'uia.instructure.com': 'UiA',
    'canvas.uia.no': 'UiA',
    'mitt.uib.no': 'UiB',
    'uib.instructure.com': 'UiB',
    'uio.instructure.com': 'UiO',
    'canvas.uio.no': 'UiO',
    'ntnu.instructure.com': 'NTNU',
    'canvas.ntnu.no': 'NTNU',
    'oslomet.instructure.com': 'OsloMet',
    'canvas.oslomet.no': 'OsloMet',
    'nhh.instructure.com': 'NHH',
    'canvas.nhh.no': 'NHH',
    'uis.instructure.com': 'UiS',
    'canvas.uis.no': 'UiS',
    'uit.instructure.com': 'UiT',
    'canvas.uit.no': 'UiT',
    'usn.instructure.com': 'USN',
    'canvas.usn.no': 'USN',
    'nmbu.instructure.com': 'NMBU',
    'canvas.nmbu.no': 'NMBU',
    'hvl.instructure.com': 'HVL',
    'canvas.hvl.no': 'HVL',
    'kristiania.instructure.com': 'Kristiania',
    'canvas.kristiania.no': 'Kristiania',
  };

  function safeCanvasOrigin(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return 'https://canvas.bi.no';
    try {
      const u = new URL(raw.trim());
      if (u.protocol !== 'https:') return 'https://canvas.bi.no';
      const host = u.hostname.toLowerCase();
      if (KNOWN_CANVAS_SCHOOL_LABELS[host]) return `https://${host}`;
      if (/^canvas\.[a-z0-9-]+\.no$/.test(host)) return `https://${host}`;
      const m = host.match(/^([a-z0-9-]+)\.instructure\.com$/);
      if (m && !['login', 'sso', 'sso-login', 'cdn', 'canvas-cdn', 'community', 'www', 'status'].includes(m[1])) {
        return `https://${host}`;
      }
    } catch {}
    return 'https://canvas.bi.no';
  }

  function schoolLabelForCanvasOrigin(raw) {
    try {
      const host = new URL(safeCanvasOrigin(raw)).hostname.toLowerCase();
      if (KNOWN_CANVAS_SCHOOL_LABELS[host]) return KNOWN_CANVAS_SCHOOL_LABELS[host];
      const mNo = host.match(/^canvas\.([a-z0-9-]+)\.no$/);
      if (mNo) return mNo[1].toUpperCase();
      const m = host.match(/^([a-z0-9-]+)\.instructure\.com$/);
      if (m) return m[1].length <= 4 ? m[1].toUpperCase() : m[1].charAt(0).toUpperCase() + m[1].slice(1);
    } catch {}
    return 'BI Oslo';
  }

  function getUserSchoolConfig() {
    const comm = window.StudyCommunity;
    const prof = comm?.getCurrentProfile?.() || null;
    const local = comm?.readLocalSchool?.() || { school: '', canvasOrigin: '' };
    const snap = isStaticWeb ? loadWebState().canvasSnapshot : null;
    const rawName = (prof?.school || '').trim() || (local.school || '').trim() || (snap?.school || '').trim();
    const rawOrigin = (prof?.canvasOrigin || '').trim() || (local.canvasOrigin || '').trim()
      || (snap?.canvasOrigin || snap?.courses?.[0]?.url || '').trim();
    if (comm?.schoolConfigFor) {
      return comm.schoolConfigFor(rawName, rawOrigin);
    }
    return {
      name: rawName,
      short: rawName === 'BI Oslo' ? 'BI' : rawName,
      canvasOrigin: rawOrigin,
      timetableUrl: 'https://cloud.timeedit.net/',
      timetableLabel: 'TimeEdit / TP',
    };
  }

  function getSyncedSchoolInfo() {
    if (!isStaticWeb) return { origin: 'https://canvas.bi.no', school: 'BI Oslo', shortSchool: 'BI' };
    const snap = loadWebState().canvasSnapshot;
    const rawOrigin = snap?.canvasOrigin || snap?.courses?.[0]?.url || '';
    if (rawOrigin) {
      const origin = safeCanvasOrigin(rawOrigin);
      const school = (typeof snap?.school === 'string' && snap.school.trim())
        ? snap.school.trim().slice(0, 32)
        : schoolLabelForCanvasOrigin(origin);
      const shortSchool = school === 'BI Oslo' ? 'BI' : school;
      return { origin, school, shortSchool };
    }
    const cfg = getUserSchoolConfig();
    return {
      origin: cfg.canvasOrigin ? safeCanvasOrigin(cfg.canvasOrigin) : '',
      school: cfg.name || '',
      shortSchool: cfg.short || '',
    };
  }

  function onSchoolChanged() {
    if (currentView === 'home') renderHome();
    else if (currentView === 'schedule') renderScheduleStudio();
  }

  function matchRelatedPracticeCourse(syncedCourse) {
    if (!syncedCourse || !Array.isArray(boot.catalog) || !boot.catalog.length) return null;
    const hay = [
      syncedCourse.code || '',
      syncedCourse.name || '',
      ...(Array.isArray(syncedCourse.topics) ? syncedCourse.topics.slice(0, 12) : []),
    ].join(' ').toLowerCase();
    const rules = [
      {
        courseId: 'acct-2527',
        re: /\b(bed[- ]?\d|bøa|regnskap|bedriftsøk|finans|investering|økonomistyring|kostnad|revisjon|skatt|accounting|finance|financial|corporate finance|auditing|fie\d|exc[- ]?3430)\b/i,
      },
      {
        courseId: 'econ-2522',
        re: /\b(se[- ]?\d|søk[- ]?\d|samfunnsøk|mikroøk|makroøk|mikro|makro|næringsøk|sam[- ]?[12]\b|econ\d*|economics|microeconomics|macroeconomics|exc[- ]?3420)\b/i,
      },
      {
        courseId: 'math-2588',
        re: /\b(ma[- ]?\d|mat[- ]?\d|me[- ]?\d|sta[- ]?\d|met[- ]?\d|matematikk|matte|kalkulus|statistikk|kvantitativ|økonometri|metode|mathematics|calculus|linear algebra|statistics|econometrics|eba[- ]?1181)\b/i,
      },
      {
        courseId: 'ob-2537',
        re: /\b(org[- ]?\d|led[- ]?\d|mf[- ]?\d|sol[- ]?\d|organisasjon|ledelse|strategi|markedsføring|etikk|personal|organizational|organisation|leadership|management|strategy|marketing|exc[- ]?3460)\b/i,
      },
      {
        courseId: 'prog-3021',
        re: /\b(inf[- ]?\d|tdt[- ]?\d|in[- ]?1\d|dat[- ]?\d|is[- ]?\d|ikt[- ]?\d|programmering|python|informatikk|algoritm|database|sql|programming|data science|visualisation|visualization|eba[- ]?3400)\b/i,
      },
    ];
    for (const rule of rules) {
      if (rule.re.test(hay)) {
        const found = boot.catalog.find((c) => c.courseId === rule.courseId);
        if (found) return found;
      }
    }
    return null;
  }

  function getBiSyncStatus() {
    if (!isStaticWeb) return { hasEverSynced: true, lastSyncMs: Date.now(), daysSinceSync: 0, isStale: false };
    const ws = loadWebState();
    const candidates = [
      ws.canvasSnapshot?.syncedAt ? Date.parse(ws.canvasSnapshot.syncedAt) : 0,
      ws.canvasSnapshot?.capturedAt ? Date.parse(ws.canvasSnapshot.capturedAt) : 0,
      ws.customSchedule?.syncedAt ? Date.parse(ws.customSchedule.syncedAt) : 0,
    ];
    try {
      const saved = Number(localStorage.getItem('study-os-bi-last-sync') || 0);
      if (Number.isFinite(saved) && saved > 0) candidates.push(saved);
    } catch {}
    const lastSyncMs = Math.max(0, ...candidates.filter((n) => Number.isFinite(n) && n > 0));
    const hasData = Boolean(
      ws.canvasSnapshot?.courses?.length ||
      (ws.customSchedule?.enabled && ws.customSchedule?.blocks?.length) ||
      lastSyncMs > 0
    );
    const daysSinceSync = lastSyncMs > 0 ? Math.floor((Date.now() - lastSyncMs) / 86_400_000) : null;
    const isStale = Boolean(hasData && daysSinceSync !== null && daysSinceSync >= BI_SYNC_STALE_DAYS);
    return { hasEverSynced: hasData, lastSyncMs, daysSinceSync, isStale };
  }

  function markBiSyncedNow() {
    try { localStorage.setItem('study-os-bi-last-sync', String(Date.now())); } catch {}
    try { localStorage.removeItem('study-os-bi-banner-snooze'); } catch {}
  }

  function biSyncHeroButtonHtml() {
    const st = getBiSyncStatus();
    const info = getSyncedSchoolInfo();
    const label = info.shortSchool || 'Canvas';
    if (!st.hasEverSynced) {
      return '<button type="button" class="primary-btn bi-sync-cta-prominent" id="btn-web-bi-sync"><span class="bi-sync-pulse" aria-hidden="true"></span>Sync Canvas &amp; Schedule</button>';
    }
    if (st.isStale) {
      return `<button type="button" class="ghost-btn bi-sync-cta-stale" id="btn-web-bi-sync"><span class="bi-sync-stale-dot" aria-hidden="true"></span>Sync ${esc(label)} · ${st.daysSinceSync}d ago</button>`;
    }
    return `<button type="button" class="ghost-btn" id="btn-web-bi-sync">${esc(label)} Synced ✓</button>`;
  }

  function maybePromptFirstLoginBiSync() {
    if (!isStaticWeb || !window.StudyCommunity?.isSignedIn?.()) return;
    const st = getBiSyncStatus();
    if (st.hasEverSynced) return;
    try {
      if (localStorage.getItem('study-os-bi-sync-prompted') === '1') return;
      localStorage.setItem('study-os-bi-sync-prompted', '1');
    } catch {
      return;
    }
    setTimeout(() => {
      if (!document.querySelector('dialog[open]')) {
        openBiSyncHub({ firstLogin: true });
      }
    }, 550);
  }

  function biSyncWalkthroughHtml() {
    return `
      <div class="bi-demo-card" id="bi-demo-card">
        <div class="row-between" style="margin-bottom:8px;gap:8px">
          <div style="display:flex;align-items:center;gap:7px">
            <span class="badge live">10s Walkthrough</span>
            <strong style="font-size:13px">How 1-Click &amp; Auto-Sync works</strong>
          </div>
          <button type="button" class="ghost-btn" id="bi-demo-toggle" style="padding:3px 10px;font-size:11.5px">Pause</button>
        </div>
        <div class="bi-demo-viewport" aria-label="Animated walkthrough of pairing Study-OS Sync and syncing Canvas LMS, TimeEdit or TP, and Ed Discussion">
          <div class="bi-demo-camera">
            <div class="bi-demo-browser">
              <div class="bi-demo-chrome">
                <span class="bi-demo-dots"><i></i><i></i><i></i></span>
                <div class="bi-demo-tab active">studyos.no</div>
                <div class="bi-demo-tab">● your Canvas</div>
                <div class="bi-demo-tab">● TimeEdit / TP</div>
                <div class="bi-demo-tab">● eu.edstem.org</div>
              </div>
              <div class="bi-demo-canvas">
                <div class="bi-demo-left">
                  <div class="bi-demo-eyebrow">Study-OS · Sync</div>
                  <div class="bi-demo-h">Pair once in 10 seconds</div>
                  <div class="bi-demo-code-btn">Generate 6-char code</div>
                  <div class="bi-demo-code-pill">K7M-9P2</div>
                </div>
                <div class="bi-demo-popup">
                  <div class="bi-demo-phead">
                    <span class="bi-demo-pdot"></span>
                    <b>Study-OS Sync</b>
                    <span class="bi-demo-ppill">3 tabs ready</span>
                  </div>
                  <div class="bi-demo-pchips">
                    <span>Canvas LMS<i>● Ready</i></span>
                    <span>Timetable<i>● Ready</i></span>
                    <span>Ed<i>● Ready</i></span>
                  </div>
                  <div class="bi-demo-pbtn">Sync all 3 open tabs</div>
                  <div class="bi-demo-presults">
                    <div class="bi-demo-res r1">✓ Canvas: 5 courses, 18 deadlines</div>
                    <div class="bi-demo-res r2">✓ TimeEdit: 42 classes synced</div>
                    <div class="bi-demo-res r3">✓ Ed: 2 courses · Auto-sync ON</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="bi-demo-cursor" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="#ffffff" stroke="#0f172a" stroke-width="1.8" stroke-linejoin="round">
                <path d="M5 3l14 9-6.5 1.4L9 20z"></path>
              </svg>
              <span class="bi-demo-ripple"></span>
            </div>
          </div>
          <div class="bi-demo-caption">
            <span class="bi-demo-cap c1">1. Click <b>Generate 6-char code</b> on studyos.no</span>
            <span class="bi-demo-cap c2">2. Paste once in <b>Study-OS Sync</b> &amp; click Sync</span>
            <span class="bi-demo-cap c3">3. <b>Canvas, TimeEdit &amp; Ed</b> stay synced automatically ✓</span>
          </div>
          <div class="bi-demo-progress"><i></i></div>
        </div>
      </div>
    `;
  }

  function renderHome() {
    ensureExamCountdownTicker();
    syncSettingsRows();
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
    const focusExplain = (sessionFocusMode === 'auto' && autoTarget.explain) ||
      (resolvedFocus === 'high_dlpfc'
        ? 'Prioritizes new multi-step problems across topics.'
        : resolvedFocus === 'med_dlpfc'
        ? 'Prioritizes standard calculations and familiar problems.'
        : 'Prioritizes spaced reviews and concept checks.');

    const autoShort =
      autoTarget.mode === 'high_dlpfc' ? 'High' : autoTarget.mode === 'med_dlpfc' ? 'Med' : 'Low';

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
            High
          </button>
          <button type="button" class="preset-chip ${sessionFocusMode === 'med_dlpfc' ? 'active' : ''}" data-focus-mode="med_dlpfc">
            Med
          </button>
          <button type="button" class="preset-chip ${sessionFocusMode === 'low_dlpfc' ? 'active' : ''}" data-focus-mode="low_dlpfc">
            Low
          </button>
        </div>
      </div>
    `;

    const heroEl = document.getElementById('up-next-hero');
    const qState = getScheduledQueueState();
    const primary = qState.queue[0] || null;
    const nextStrip = qState.queue.slice(1, 5);

    if (primary && describeScheduledBlock(primary).canLaunch) {
      const pMeta = describeScheduledBlock(primary);
      const cMeta = pMeta.course;
      const isDebt = pMeta.st.isDebt;
      const isLive = pMeta.st.timingState === 'live_now';
      const debtBannerHtml = qState.debtBlocks.length
        ? `<div class="sched-debt-banner">
            <div class="sched-debt-banner-left">
              <span class="badge debt">STUDY DEBT</span>
              <strong>${qState.debtBlocks.length} overdue ${qState.debtBlocks.length === 1 ? 'block' : 'blocks'} (+${esc(formatDurationShort(qState.debtMinutes))} rolled over)</strong>
              <span class="muted">Missed blocks stack here until cleared — complete upcoming blocks early to avoid debt.</span>
            </div>
            <div class="row-actions" style="gap:6px;flex-shrink:0">
              <button type="button" class="ghost-btn" id="btn-hero-forgive-debt" style="padding:4px 10px;font-size:12px" title="Dismiss all overdue blocks without losing your future plan">Forgive all</button>
              <button type="button" class="ghost-btn" id="btn-hero-open-sched-debt" style="padding:4px 10px;font-size:12px">Manage →</button>
            </div>
          </div>`
        : '';

      const whenBadge = isDebt
        ? `<span class="badge debt">${esc(pMeta.whenLabel)}</span>`
        : isLive
        ? `<span class="badge live">${esc(pMeta.whenLabel)}</span>`
        : `<span class="badge">${esc(pMeta.whenLabel)}</span>`;
      const coursePill = cMeta
        ? `<span class="sched-course-pill" style="--sched-accent:${esc(cMeta.color)}"><i aria-hidden="true"></i><b>${esc(cMeta.code)}</b> ${esc(cMeta.shortTitle || cMeta.title)}</span>`
        : '';
      const title = homeBlockTitle(pMeta.topicLabel, cMeta);

      heroEl.innerHTML = `
        ${focusBarHtml}
        ${debtBannerHtml}
        <div class="hero-queue-card ${isDebt ? 'is-debt' : isLive ? 'is-live' : ''}" id="hero-active-block" role="button" tabindex="0" style="--sched-accent:${esc(cMeta?.color || 'var(--accent)')}" aria-label="Launch ${esc(title)}">
          <div class="hero-queue-main">
            <div class="hero-queue-pills">
              ${whenBadge}
              ${coursePill}
              ${homeBlockDifficulty(pMeta.dlpfc.tier)}
              ${primary.location ? `<span class="badge">${esc(primary.location)}</span>` : ''}
            </div>
            <h1 class="hero-title" data-sched-topic-for="${esc(primary.eventId)}" style="margin:6px 0 4px">${esc(title)}</h1>
            <div class="hero-queue-sub">
              <span class="sched-count-pill" data-sched-count-for="${esc(primary.eventId)}">${esc(pMeta.queueLabel)}</span>
            </div>
          </div>
          <div class="hero-queue-side">
            <span class="hero-queue-go">${isDebt ? 'Clear debt →' : isLive ? 'Open live run →' : 'Open run →'}</span>
            <div class="hero-queue-tools">
              <button type="button" class="ghost-btn sched-tool-btn" id="btn-hero-mark-done" title="${isDebt ? 'Mark overdue block completed' : 'Mark completed ahead of schedule'}">✓ ${isDebt ? 'Clear' : 'Done'}</button>
              ${cMeta ? `<button type="button" class="ghost-btn sched-tool-btn" id="btn-hero-ref">${esc(cMeta.shortTitle)} Ref</button>` : ''}
              <button type="button" class="ghost-btn sched-tool-btn" id="btn-hero-sched">Schedule</button>
              ${isStaticWeb ? biSyncHeroButtonHtml() : ''}
            </div>
          </div>
        </div>
        ${
          nextStrip.length
            ? `<div class="schedule-strip">
                ${nextStrip
                  .map((b) => {
                    const m = describeScheduledBlock(b);
                    const bc = m.course;
                    return `<div class="sched-mini is-clickable ${m.st.isDebt ? 'is-debt' : ''}" data-launch-event="${esc(b.eventId)}" role="button" tabindex="0" style="--sched-accent:${esc(bc?.color || 'var(--accent)')}" title="Click to launch this block immediately (you can complete upcoming blocks early)">
                      <div class="sched-mini-top">
                        <div class="sched-mini-badges">
                          ${bc ? `<span class="sched-course-pill compact" style="--sched-accent:${esc(bc.color)}"><i aria-hidden="true"></i><b>${esc(bc.code)}</b> ${esc(bc.shortTitle || '')}</span>` : ''}
                          ${homeBlockDifficulty(m.dlpfc.tier)}
                        </div>
                        <button type="button" class="sched-check-btn" data-mark-done-event="${esc(b.eventId)}" title="${m.st.isDebt ? 'Mark overdue debt cleared' : 'Mark completed early'}" aria-label="Mark block completed">✓</button>
                      </div>
                      <strong class="sched-mini-title" data-sched-topic-for="${esc(b.eventId)}">${esc(homeBlockTitle(m.topicLabel, bc))}</strong>
                      <div class="sched-mini-foot">
                        <small class="${m.st.isDebt ? 'sched-when-debt' : 'muted'}">${esc(m.whenLabel)}</small>
                        <small class="sched-mini-go"><span data-sched-count-for="${esc(b.eventId)}">${esc(m.queueLabel)}</span> <span class="sched-arrow" aria-hidden="true">→</span></small>
                      </div>
                    </div>`;
                  })
                  .join('')}
              </div>`
            : ''
        }
      `;

      const heroBlockEl = document.getElementById('hero-active-block');
      heroBlockEl?.addEventListener('click', (ev) => {
        if (ev.target.closest('button, a')) return;
        launchCalendarBlock(primary);
      });
      heroBlockEl?.addEventListener('keydown', (ev) => {
        if ((ev.key === 'Enter' || ev.key === ' ') && !ev.target.closest('button, a')) {
          ev.preventDefault();
          launchCalendarBlock(primary);
        }
      });
      document.getElementById('btn-hero-mark-done')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setScheduleBlockCompleted(primary.eventId, true, primary, 'manual');
      });
      document.getElementById('btn-hero-ref')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (cMeta) openReferenceDrawer(cMeta);
      });
      document.getElementById('btn-hero-sched')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        navigate('schedule');
      });
      document.getElementById('btn-hero-forgive-debt')?.addEventListener('click', () => {
        dismissScheduleDebt(qState.debtBlocks.map((b) => b.eventId));
      });
      document.getElementById('btn-hero-open-sched-debt')?.addEventListener('click', () => navigate('schedule'));
      document.getElementById('btn-web-bi-sync')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openBiSyncHub();
      });

      heroEl.querySelectorAll('[data-mark-done-event]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const blk = (boot.calendar?.blocks || []).find((x) => x.eventId === btn.dataset.markDoneEvent);
          if (blk) setScheduleBlockCompleted(blk.eventId, true, blk, 'manual');
        });
      });
      heroEl.querySelectorAll('[data-launch-event]').forEach((card) => {
        const launch = () => {
          const blk = (boot.calendar?.blocks || []).find((x) => x.eventId === card.dataset.launchEvent);
          if (blk) launchCalendarBlock(blk);
        };
        card.addEventListener('click', (ev) => {
          if (ev.target.closest('button, a')) return;
          launch();
        });
        card.addEventListener('keydown', (ev) => {
          if ((ev.key === 'Enter' || ev.key === ' ') && !ev.target.closest('button, a')) {
            ev.preventDefault();
            launch();
          }
        });
      });

      // Lazily hydrate exact task counts + topics from course banks so cards never show "0 queued"
      hydrateVisibleScheduledBlocks([primary, ...nextStrip]).catch(() => {});
    } else if (isStaticWeb) {
      const activeCatalog = boot.catalog.filter((c) => !isCourseInMaintenanceForUser(c.courseId));
      const questionCount = activeCatalog.reduce((count, c) => count + c.questionCount, 0);
      const nextExam = [...activeCatalog]
        .map((c) => ({ c, targetMs: examTargetMs(c.examInfo), days: daysUntilDateStr(c.examInfo?.date) }))
        .filter((x) => Number.isFinite(x.targetMs) && x.targetMs > Date.now() - 14400_000)
        .sort((x, y) => x.targetMs - y.targetMs)[0];
      const nextExamTip = nextExam ? formatExamHoverTip(nextExam.c.examInfo, nextExam.targetMs) : '';
      const nextExamChip = nextExam
        ? `<button type="button" class="hero-exam-chip exam-tip-host exam-tip-left" id="btn-hero-next-exam" data-exam-tip="${esc(nextExamTip)}" aria-label="${esc(nextExamTip)}">
             <span class="hero-exam-dot" style="background:${esc(nextExam.c.color)}"></span>
             <span>Next exam · <b>${esc(nextExam.c.code)}</b> in <b class="exam-countdown-live" data-exam-target-ms="${nextExam.targetMs}" data-exam-countdown-mode="hero">${esc(formatExamCountdown(nextExam.targetMs, 'hero'))}</b></span>
             <span aria-hidden="true">→</span>
           </button>`
        : '';
      heroEl.innerHTML = `
        <div class="hero-top">
          <div style="flex:1;min-width:240px">
            ${nextExamChip}
            <h1 class="hero-title">Study by subject</h1>
            <p class="muted" style="margin:0">${activeCatalog.length} active subjects · ${questionCount} questions · ${(boot.references || []).length} course notes</p>
          </div>
          <div class="row-actions">
            <button type="button" class="primary-btn" id="btn-web-refs">Course notes</button>
            <button type="button" class="ghost-btn" id="btn-web-exams">Mock exams</button>
            ${biSyncHeroButtonHtml()}
          </div>
        </div>`;
      document.getElementById('btn-web-refs').onclick = () => navigate('references');
      document.getElementById('btn-web-exams').onclick = () => navigate('exams');
      document.getElementById('btn-web-bi-sync').onclick = () => openBiSyncHub();
      if (nextExam) {
        document.getElementById('btn-hero-next-exam').onclick = () => navigate('exams', { focusCourseId: nextExam.c.courseId });
      }
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
              homeDifficulty === '1' ? `Start Easy ${homeBlockMinutes}m` : homeDifficulty === '2' ? `Start Medium ${homeBlockMinutes}m` : homeDifficulty === '3' ? `Start Hard ${homeBlockMinutes}m` : `Start ${homeBlockMinutes}m Block`
            }</button>
            <button type="button" class="ghost-btn btn-lg" id="btn-hero-exams">Exam Simulator</button>
          </div>
        </div>
      `;
      document.getElementById('btn-hero-smart')?.addEventListener('click', () => {
        if (boot.catalog[0]) {
          const exactDiff = homeDifficulty === 'all' ? 0 : Number(homeDifficulty);
          const m = exactDiff === 3 ? 'high_dlpfc' : exactDiff === 2 ? 'med_dlpfc' : exactDiff === 1 ? 'low_dlpfc' : getResolvedFocusMode();
          launchSmartCourseRun(boot.catalog[0].courseId, homeBlockMinutes, 'learning', '', m, false, exactDiff);
        }
      });
      document.getElementById('btn-hero-exams')?.addEventListener('click', () => navigate('exams'));
    }

    heroEl.querySelectorAll('[data-focus-mode]').forEach((btn) => {
      btn.addEventListener('click', () => setSessionFocusMode(btn.dataset.focusMode));
    });

    // 3. Global Metrics Strip
    const a = boot.analytics || {};
    const db = a.dlpfcBudget || {};
    const highMin = Number(db.todayHighMinutes || 0);
    const medMin = Number(db.todayMedMinutes || 0);
    const focusSwitches = Number(db.todayFocusSwitches || 0);
    const totalDue = Object.values(a.courseProgress || {}).reduce((s, c) => s + (c.dueFsrs || 0), 0);
    const totalRevisit = Object.values(a.courseProgress || {}).reduce((s, c) => s + (c.revisit || 0), 0);
    const totalDone = Object.values(a.courseProgress || {}).reduce((s, c) => s + (c.done || 0), 0);
    const totalItems = Object.values(a.courseProgress || {}).reduce((s, c) => s + (c.total || 0), 0);

    document.getElementById('home-metrics-strip').innerHTML = `
      <div class="metric-tile" data-layout-budget>
        <small>High practice budget</small>
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

    // 3C. Synced Personal Canvas Courses (UiA, NHH, UiO, NTNU, extra electives, etc.)
    renderSyncedCoursesSection();

    // 4. Difficulty / DLPFC Picker + Duration Picker + Semester Filter + Courses Grid
    const diffWord = homeDifficultyLabels[Number(homeDifficulty)] || '';
    const diffSeg = document.getElementById('home-difficulty-seg');
    if (diffSeg) {
      diffSeg.querySelectorAll('[data-home-diff]').forEach((btn) => {
        const val = btn.dataset.homeDiff;
        const active = val === homeDifficulty;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.onclick = () => {
          if (homeDifficulty === val) return;
          homeDifficulty = val;
          try { localStorage.setItem('study-os-home-diff-v1', homeDifficulty); } catch {}
          renderHome();
        };
      });
    }
    const durSeg = document.getElementById('home-duration-seg');
    if (durSeg) {
      durSeg.querySelectorAll('[data-home-mins]').forEach((btn) => {
        const mins = Number(btn.dataset.homeMins);
        const active = mins === homeBlockMinutes;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.onclick = () => {
          if (homeBlockMinutes === mins) return;
          homeBlockMinutes = mins;
          try { localStorage.setItem('study-os-home-mins-v1', String(homeBlockMinutes)); } catch {}
          renderHome();
        };
      });
    }
    const primaryCtaLabel = diffWord ? `${diffWord} · ${homeBlockMinutes}m` : `Start ${homeBlockMinutes}m`;

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
        const fullCp = a.courseProgress?.[c.courseId] || { total: c.questionCount, done: 0, revisit: 0, in_progress: 0, dueFsrs: 0 };
        const tierCp = homeDifficulty !== 'all' ? fullCp.byTier?.[homeDifficulty] : null;
        const fallbackTierTotal = homeDifficulty === '1'
          ? Number(c.lowDlpfcCount || 0)
          : homeDifficulty === '2'
          ? Number(c.medDlpfcCount || 0)
          : homeDifficulty === '3'
          ? Number(c.highDlpfcCount || 0)
          : Number(c.questionCount || 0);
        const cp = tierCp || (homeDifficulty !== 'all'
          ? { total: fallbackTierTotal, done: 0, revisit: 0, in_progress: 0, dueFsrs: 0 }
          : fullCp);
        const pct = cp.total ? Math.round((cp.done / cp.total) * 100) : 0;
        const daysLeft = daysUntilDateStr(c.examInfo?.date);
        const targetMs = examTargetMs(c.examInfo);
        const examTip = formatExamHoverTip(c.examInfo, targetMs);
        const examBadge = Number.isFinite(targetMs) && targetMs > Date.now() - 14400_000
          ? `<span class="badge exam-tip-host ${daysLeft !== null && daysLeft >= 0 && daysLeft <= 14 ? 'warn' : ''}" data-exam-tip="${esc(examTip)}" aria-label="${esc(examTip)}" tabindex="0"><span class="exam-countdown-live" data-exam-target-ms="${targetMs}" data-exam-countdown-mode="card">${esc(formatExamCountdown(targetMs, 'card'))}</span></span>`
          : '';
        const noItemsInDiff = homeDifficulty !== 'all' && cp.total === 0;
        const provMixParts = [];
        if (Number(c.officialCount) > 0) provMixParts.push(`<span><b>${c.officialCount}</b> BI</span>`);
        if (Number(c.bookCount) > 0) provMixParts.push(`<span><b>${c.bookCount}</b> Book</span>`);
        if (Number(c.aiSyntheticCount) > 0) provMixParts.push(`<span><b>${c.aiSyntheticCount}</b> Al</span>`);
        const provMixHtml = homeDifficulty === 'all' && provMixParts.length
          ? `<div class="course-prov-mix" title="Authentic BI past exams, exercises &amp; tutoring are prioritized before Al synthetics">${provMixParts.join(' · ')}</div>`
          : '';

        const maint = getCourseMaintenance(c.courseId);
        const maintLocked = Boolean(maint && !canBypassCourseMaintenance());
        const maintBadgeHtml = maint
          ? `<span class="badge maintenance" title="${esc(maint.eta)}">${maintLocked ? esc(maint.badge) : 'Maintenance · Admin'}</span>`
          : '';
        if (maintLocked) {
          return `<article class="course-card course-card-maintenance" style="--course-accent:${esc(c.color)}">
            <div>
              <div class="row-between" style="margin:0 0 8px">
                <span class="course-code-pill" style="--pill-color:${esc(c.color)}">${esc(c.code)}${semesters.length > 1 && c.semester ? ` · ${esc(c.semester)}` : ''}</span>
                <div class="row-actions">${maintBadgeHtml}${examBadge}</div>
              </div>
              <h3 class="course-card-title" data-open-course="${esc(c.courseId)}" role="button" tabindex="0">${esc(c.title)}</h3>
              <p class="muted course-maintenance-note">${esc(maint.shortNote)}</p>
            </div>
            <div class="course-actions">
              <button type="button" class="ghost-btn" disabled aria-disabled="true">${esc(maint.badge)}</button>
              <button type="button" class="ghost-btn" data-ref-course="${esc(c.courseId)}">Notes</button>
            </div>
          </article>`;
        }

        return `<article class="course-card" style="--course-accent:${esc(c.color)}">
          <div>
            <div class="row-between" style="margin:0 0 8px">
              <span class="course-code-pill" style="--pill-color:${esc(c.color)}">${esc(c.code)}${semesters.length > 1 && c.semester ? ` · ${esc(c.semester)}` : ''}</span>
              <div class="row-actions">${maintBadgeHtml}${examBadge}</div>
            </div>
            <h3 class="course-card-title" data-open-course="${esc(c.courseId)}" role="button" tabindex="0">${esc(c.title)}</h3>
            <div class="course-progress-wrap">
              <div class="course-bar"><div class="course-bar-fill" style="width:${pct}%;background:${esc(c.color)}"></div></div>
              <span class="course-pct">${pct}%</span>
            </div>
            <div class="course-stats-row">
              <span><b>${cp.done}</b>/${cp.total} ${diffWord ? `${diffWord.toLowerCase()} ` : ''}done</span>
              <span>· <b>${cp.revisit}</b> revisit</span>
            </div>
            ${provMixHtml}
          </div>
          <div class="course-actions">
            <button type="button" class="primary-btn" data-smart-course="${esc(c.courseId)}" ${noItemsInDiff ? 'disabled' : ''}>${noItemsInDiff ? `No ${diffWord} Qs` : primaryCtaLabel}</button>
            <button type="button" class="ghost-btn" data-open-course="${esc(c.courseId)}">${isStaticWeb ? 'Topics' : `All (${c.questionCount})`}</button>
            <button type="button" class="ghost-btn" data-exam-course="${esc(c.courseId)}">Exams</button>
            <button type="button" class="ghost-btn" data-ref-course="${esc(c.courseId)}">Notes</button>
          </div>
        </article>`;
      })
      .join('');

    grid.querySelectorAll('[data-smart-course]').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const exactDiff = homeDifficulty === 'all' ? 0 : Number(homeDifficulty);
          const m = exactDiff === 3 ? 'high_dlpfc' : exactDiff === 2 ? 'med_dlpfc' : exactDiff === 1 ? 'low_dlpfc' : getResolvedFocusMode();
          await launchSmartCourseRun(b.dataset.smartCourse, homeBlockMinutes, 'learning', '', m, false, exactDiff);
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
      if (b.tagName !== 'BUTTON') {
        b.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            navigate('course', { courseId: b.dataset.openCourse });
          }
        });
      }
    });
    grid.querySelectorAll('[data-ref-course]').forEach((b) => {
      b.addEventListener('click', () => {
        const cm = boot.catalog.find((x) => x.courseId === b.dataset.refCourse);
        if (cm) openReferenceDrawer(cm);
      });
    });

    window.StudySets?.render?.();
  }

  function renderSyncedCoursesSection() {
    const section = document.getElementById('synced-courses-section');
    const headingEl = document.getElementById('home-courses-heading-title');
    if (!section) return;
    if (!isStaticWeb) {
      section.hidden = true;
      section.innerHTML = '';
      if (headingEl) headingEl.textContent = 'Courses';
      return;
    }
    const snap = loadWebState().canvasSnapshot;
    const rawCourses = Array.isArray(snap?.courses) ? snap.courses : [];
    const catalogCanvasIds = new Set(
      (boot.catalog || []).map((c) => String(c.canvasId || c.courseId?.split('-').pop() || '')).filter(Boolean)
    );
    const catalogCodes = new Set(
      (boot.catalog || []).map((c) => String(c.code || '').toUpperCase().replace(/[\s-]+/g, '')).filter(Boolean)
    );
    const schoolInfo = getSyncedSchoolInfo();
    const isBiOrigin = schoolInfo.origin === 'https://canvas.bi.no' || schoolInfo.origin === 'https://bi.instructure.com';

    const syncedExtra = rawCourses.filter((c) => {
      if (!c || !c.name) return false;
      const cid = String(c.id || '');
      const normCode = String(c.code || '').toUpperCase().replace(/[\s-]+/g, '');
      if (isBiOrigin && cid && catalogCanvasIds.has(cid)) return false;
      if (normCode && catalogCodes.has(normCode)) return false;
      return true;
    });

    if (!syncedExtra.length) {
      section.hidden = true;
      section.innerHTML = '';
      if (headingEl) headingEl.textContent = 'Courses';
      return;
    }

    if (headingEl) {
      headingEl.textContent = isBiOrigin ? 'Core Practice Courses' : 'Practice Banks & Exam Prep';
    }

    const nowMs = Date.now();
    const fmtShortDate = (isoStr) => {
      try {
        return new Date(isoStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      } catch {
        return '';
      }
    };

    section.hidden = false;
    section.innerHTML = `
      <div class="synced-courses-head">
        <div class="synced-courses-head-left">
          <h2>Your synced courses</h2>
          ${schoolInfo.school ? `<span class="badge live">${esc(schoolInfo.school)}</span>` : ''}
          <span class="course-school-pill">${syncedExtra.length} Canvas course${syncedExtra.length === 1 ? '' : 's'}</span>
        </div>
        <div class="row-actions">
          <button type="button" class="ghost-btn" id="btn-synced-manage">Sync / Drop PDFs</button>
          <a class="ghost-btn" href="${esc(schoolInfo.origin)}/" target="_blank" rel="noopener">Open ${esc(schoolInfo.shortSchool || 'Canvas')} ↗</a>
        </div>
      </div>
      <div class="courses-grid">
        ${syncedExtra.map((c, idx) => {
          const validId = /^[1-9][0-9]{0,19}$/.test(String(c.id || ''));
          const courseOrigin = typeof c.url === 'string' && c.url.startsWith('https://')
            ? safeCanvasOrigin(c.url)
            : schoolInfo.origin;
          const courseUrl = validId ? `${courseOrigin}/courses/${c.id}` : `${courseOrigin}/`;
          const upcoming = (Array.isArray(c.assignments) ? c.assignments : [])
            .filter((a) => a && Number.isFinite(Date.parse(a.dueAt)) && Date.parse(a.dueAt) >= nowMs)
            .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
          const nextDue = upcoming[0] || null;
          const topics = Array.isArray(c.topics) ? c.topics.filter(Boolean) : [];
          const related = matchRelatedPracticeCourse(c);
          const mySets = window.StudySets?.getSetsForCourse?.(c.code || '', c.name || '') || [];
          const latestSet = mySets[0] || null;
          const accent = related?.color || '#0f766e';
          const codeLabel = c.code || (schoolInfo.shortSchool ? `${schoolInfo.shortSchool} Course` : 'Canvas Course');

          return `<article class="course-card synced-course-card" style="--course-accent:${esc(accent)}">
            <div>
              <div class="row-between" style="margin:0 0 8px;gap:6px">
                <span class="course-code-pill" style="--pill-color:${esc(accent)}">${esc(codeLabel)}</span>
                <div class="row-actions" style="gap:5px">
                  ${mySets.length ? `<span class="badge good">${mySets.length} set${mySets.length === 1 ? '' : 's'}</span>` : ''}
                  ${upcoming.length
                    ? `<span class="badge ${Date.parse(nextDue.dueAt) - nowMs <= 7 * 86_400_000 ? 'warn' : ''}">${upcoming.length} due</span>`
                    : `<span class="course-school-pill">${esc(schoolInfo.shortSchool || 'Canvas')}</span>`}
                </div>
              </div>
              <h3 class="course-card-title" style="cursor:default">${esc(c.name)}</h3>
              ${nextDue
                ? `<p class="synced-course-deadlines">Next: <strong>${esc(nextDue.name)}</strong> · ${esc(fmtShortDate(nextDue.dueAt))}</p>`
                : `<p class="synced-course-deadlines">Synced from ${esc(schoolInfo.school || 'Canvas')} · ${topics.length ? `${topics.length} module${topics.length === 1 ? '' : 's'}` : 'Ready for custom study sets'}</p>`}
              ${topics.length
                ? `<div class="community-course-topics">${topics.slice(0, 4).map((t) => `<span class="topic-mini-chip">${esc(t)}</span>`).join('')}${topics.length > 4 ? `<span class="topic-mini-chip">+${topics.length - 4}</span>` : ''}</div>`
                : ''}
              ${related
                ? `<div class="synced-match-strip">
                     <span>Shared bank: <b>${esc(related.shortTitle || related.title)}</b> (${related.questionCount} Qs)</span>
                     <div class="row-actions" style="gap:4px;flex-shrink:0">
                       <button type="button" class="ghost-btn" style="padding:3px 8px;font-size:11.5px" data-synced-practice="${esc(related.courseId)}">Bank</button>
                       <button type="button" class="ghost-btn" style="padding:3px 8px;font-size:11.5px" data-synced-notes="${esc(related.courseId)}">Notes</button>
                     </div>
                   </div>`
                : ''}
            </div>
            <div class="course-actions">
              ${latestSet
                ? `<button type="button" class="primary-btn" data-synced-launch-set="${esc(latestSet.id)}">Practice Set (${latestSet.questions.length} Qs) →</button>
                   <button type="button" class="ghost-btn" data-synced-gen="${idx}" title="Build a new custom study set for this course">+ Study Set</button>`
                : `<button type="button" class="primary-btn" data-synced-gen="${idx}">Build Study Set</button>`}
              <button type="button" class="ghost-btn" data-synced-ai="${idx}">Al</button>
              <a class="ghost-btn" href="${esc(courseUrl)}" target="_blank" rel="noopener">Canvas ↗</a>
            </div>
          </article>`;
        }).join('')}
      </div>
    `;

    section.querySelector('#btn-synced-manage')?.addEventListener('click', () => openBiSyncHub());
    section.querySelectorAll('[data-synced-launch-set]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const set = (window.StudySets?.list?.() || []).find((s) => s.id === btn.dataset.syncedLaunchSet);
        if (set) window.StudySets.launchSet(set);
      });
    });
    section.querySelectorAll('[data-synced-gen]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const c = syncedExtra[Number(btn.dataset.syncedGen)];
        if (!c || !window.StudySets?.openGenerator) return;
        window.StudySets.openGenerator({
          courseCode: c.code || '',
          courseTitle: c.name || '',
          school: schoolInfo.school || '',
          topics: Array.isArray(c.topics) ? c.topics : [],
        });
      });
    });
    section.querySelectorAll('[data-synced-practice]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('course', { courseId: btn.dataset.syncedPractice }));
    });
    section.querySelectorAll('[data-synced-notes]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cm = boot.catalog.find((x) => x.courseId === btn.dataset.syncedNotes);
        if (cm) openReferenceDrawer(cm);
      });
    });
    section.querySelectorAll('[data-synced-ai]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const c = syncedExtra[Number(btn.dataset.syncedAi)];
        if (!c || !window.StudyAiTutor?.openForCourse) return;
        const upcomingNames = (Array.isArray(c.assignments) ? c.assignments : [])
          .filter((a) => a && Date.parse(a.dueAt) >= Date.now())
          .slice(0, 6)
          .map((a) => `${a.name} (due ${new Date(a.dueAt).toISOString().slice(0, 10)})`);
        window.StudyAiTutor.openForCourse({
          id: `canvas-${c.id}`,
          code: c.code || schoolInfo.shortSchool || 'Canvas',
          title: schoolInfo.school ? `${c.name} (${schoolInfo.school})` : c.name,
          topics: [
            ...(Array.isArray(c.topics) ? c.topics : []),
            ...upcomingNames.map((u) => `Upcoming deadline: ${u}`),
          ],
        });
      });
    });
  }

  function renderCanvasBridgeStrip() {
    const strip = document.getElementById('canvas-bridge-strip');
    if (!strip) return;

    if (isStaticWeb) {
      const syncSt = getBiSyncStatus();
      const schoolInfo = getSyncedSchoolInfo();
      const schoolTag = schoolInfo.school || 'Canvas';
      let snoozeUntil = 0;
      try { snoozeUntil = Number(localStorage.getItem('study-os-bi-banner-snooze') || 0); } catch {}
      const snoozed = Number.isFinite(snoozeUntil) && snoozeUntil > Date.now();
      if (!syncSt.hasEverSynced && !snoozed) {
        strip.innerHTML = `
          <div class="panel bi-sync-banner">
            <div class="row-between" style="gap:14px;flex-wrap:wrap;align-items:center">
              <div style="flex:1;min-width:240px">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
                  <span class="badge live">Canvas LMS · TimeEdit / TP · Ed</span>
                  <span class="badge">Multi-School v1.6.0</span>
                </div>
                <h3 style="margin:0 0 4px;font-size:16px">Connect Canvas, Timetable &amp; Ed in 30 seconds</h3>
                <p class="muted" style="margin:0;font-size:13.5px;line-height:1.45">
                  Works for <b>BI Oslo, UiA, NHH, UiO, NTNU, OsloMet, UiB</b> &amp; any Canvas school. Pull your courses, deadlines, and timetable in 1 click — and stay synced automatically.
                </p>
              </div>
              <div class="row-actions" style="flex-wrap:wrap">
                <button type="button" class="primary-btn" id="btn-banner-bi-setup">Set up Canvas Sync →</button>
                <button type="button" class="ghost-btn" id="btn-banner-bi-demo">▶ 10s Demo</button>
                <button type="button" class="ghost-btn" id="btn-banner-bi-snooze" title="Hide for 3 days">Later</button>
              </div>
            </div>
          </div>
        `;
        strip.querySelector('#btn-banner-bi-setup')?.addEventListener('click', () => openBiSyncHub());
        strip.querySelector('#btn-banner-bi-demo')?.addEventListener('click', () => openBiSyncHub({ showDemo: true }));
        strip.querySelector('#btn-banner-bi-snooze')?.addEventListener('click', () => {
          try { localStorage.setItem('study-os-bi-banner-snooze', String(Date.now() + 3 * 86_400_000)); } catch {}
          strip.innerHTML = '';
        });
      } else if (syncSt.isStale && !snoozed) {
        strip.innerHTML = `
          <div class="panel bi-sync-banner is-stale">
            <div class="row-between" style="gap:14px;flex-wrap:wrap;align-items:center">
              <div style="flex:1;min-width:240px">
                <span class="badge warn" style="margin-bottom:4px">Resync reminder · ${syncSt.daysSinceSync} days ago</span>
                <h3 style="margin:0 0 4px;font-size:15.5px">Refresh your ${esc(schoolTag)} Canvas &amp; Ed deadlines</h3>
                <p class="muted" style="margin:0;font-size:13.5px;line-height:1.45">
                  It's been ${syncSt.daysSinceSync} days since your last sync. Open your Canvas or Ed tab (v1.6.0 auto-syncs silently) or click Sync now to pull new assignments.
                </p>
              </div>
              <div class="row-actions" style="flex-wrap:wrap">
                <button type="button" class="primary-btn" id="btn-banner-bi-resync">Sync now</button>
                <button type="button" class="ghost-btn" id="btn-banner-bi-snooze">Remind in 3 days</button>
              </div>
            </div>
          </div>
        `;
        strip.querySelector('#btn-banner-bi-resync')?.addEventListener('click', () => openBiSyncHub());
        strip.querySelector('#btn-banner-bi-snooze')?.addEventListener('click', () => {
          try { localStorage.setItem('study-os-bi-banner-snooze', String(Date.now() + 3 * 86_400_000)); } catch {}
          strip.innerHTML = '';
          toast('Got it — we will remind you in 3 days.');
        });
      } else {
        strip.innerHTML = '';
      }
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
                ${ca.hasResyncApp ? '<button type="button" class="primary-btn" id="btn-open-canvas-resync">Sync Canvas</button><button type="button" class="ghost-btn" id="btn-open-ed-sync">Sync Ed</button>' : '<a class="ghost-btn" href="https://github.com/shadjosef/canvas-study-sync" target="_blank" rel="noopener">Get Canvas Sync ↗</a>'}
                ${ca.hasResyncApp && ca.courses?.length ? '<button type="button" class="ghost-btn" id="btn-add-canvas-files">Add books or PDFs</button>' : ''}
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
                <h4 style="margin:8px 0 4px">3. TimeEdit / Al Schedule</h4>
                <small class="muted">Paste your TimeEdit <code>.ics</code> link + weekly work hours, or generate a custom schedule with any LLM.</small>
              </div>
              <button type="button" class="ghost-btn" id="btn-onboard-sched">Open Schedule Studio →</button>
            </div>
          </div>
        </div>
      `;
    } else if (unimported > 0) {
      strip.innerHTML = `
        <div class="canvas-connect-bar">
          <div>
            <span class="badge live">Canvas-Archive</span>
            <small class="muted" style="margin-left:8px"><b>${unimported}</b> new course${unimported > 1 ? 's' : ''} ready to import</small>
          </div>
          <div class="row-actions">
            <button type="button" class="primary-btn" style="padding:5px 12px;font-size:12.5px" id="btn-import-canvas-courses">Import ${unimported} New Course${unimported > 1 ? 's' : ''} →</button>
          </div>
        </div>
      `;
    } else {
      strip.innerHTML = '';
      return;
    }

    document.getElementById('btn-open-canvas-resync')?.addEventListener('click', () => openCanvasSync('canvas'));
    document.getElementById('btn-open-ed-sync')?.addEventListener('click', () => openCanvasSync('ed'));
    document.getElementById('btn-add-canvas-files')?.addEventListener('click', () => openCanvasFiles());

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

  async function importCanvasCourses(canvasIds) {
    toast('Importing courses from Canvas-Archive…');
    const result = await apiPost('/api/canvas/import', { canvasIds });
    if (result.bootstrap) boot = result.bootstrap;
    if (currentView === 'home') renderHome();
    const count = result.imported?.length || 0;
    toast(count ? `Imported ${count} Canvas course${count === 1 ? '' : 's'}.` : 'No new courses to import.');
    return count;
  }

  function bindCanvasFiles() {
    const dialog = document.getElementById('canvas-files-dialog');
    const form = document.getElementById('canvas-files-form');
    const feedback = document.getElementById('canvas-files-feedback');
    const openLibrary = document.getElementById('canvas-open-library');
    const submit = form.querySelector('button[type="submit"]');
    const { course, files } = form.elements;
    let uploading = false;
    let addedTo = '';
    const linkedCourse = (canvasId) => boot.catalog.find((item) => String(item.canvasId) === canvasId);

    form.onsubmit = async (event) => {
      event.preventDefault();
      if (uploading) return;
      const selected = Array.from(files.files);
      if (!selected.length) return;
      const canvasId = course.value;
      const failures = [];
      let copied = 0;
      let reused = 0;
      uploading = submit.disabled = course.disabled = files.disabled = true;
      openLibrary.hidden = true;
      for (const [index, file] of selected.entries()) {
        feedback.textContent = `Adding ${index + 1} of ${selected.length} · ${file.name}`;
        try {
          const response = await fetch('/api/canvas/add-file', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Study-Course': canvasId,
              'X-Study-Name': encodeURIComponent(file.name),
            },
            body: file,
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error);
          if (result.reused) reused += 1;
          else copied += 1;
        } catch (error) {
          failures.push(`${file.name} · ${error.message}`);
        }
      }
      uploading = submit.disabled = course.disabled = files.disabled = false;
      feedback.textContent = [`${copied} added`, reused ? `${reused} already in this course` : '',
        ...failures].filter(Boolean).join(' · ');
      if (!failures.length) files.value = '';
      if (copied || reused) {
        addedTo = canvasId;
        openLibrary.hidden = false;
        openLibrary.textContent = linkedCourse(canvasId) ? 'Open course files' : 'Import course and open files';
        if (currentView === 'course' && linkedCourse(canvasId)?.courseId === selectedCourseId) {
          await renderCourseExplorer(selectedCourseId);
          document.getElementById('course-local-documents')?.setAttribute('open', '');
        }
      }
    };

    openLibrary.onclick = async () => {
      openLibrary.disabled = true;
      try {
        if (!linkedCourse(addedTo)) await importCanvasCourses([addedTo]);
        const courseId = linkedCourse(addedTo)?.courseId;
        if (!courseId) throw new Error('The course could not be opened.');
        dialog.close();
        await navigate('course', { courseId });
        document.getElementById('course-local-documents')?.setAttribute('open', '');
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        openLibrary.disabled = false;
      }
    };
    return (canvasId) => {
      if (!uploading) {
        course.innerHTML = (boot.canvasArchive?.courses || []).map((item) =>
          `<option value="${esc(item.canvasId)}">${esc(item.title)}</option>`).join('');
        if (canvasId) course.value = canvasId;
        files.value = '';
        feedback.textContent = '';
        openLibrary.hidden = true;
      }
      if (!dialog.open) dialog.showModal();
    };
  }

  function openLocalPdf(name, rawUrl, localSourceKey = '') {
    const dialog = document.getElementById('local-book-dialog');
    const reader = document.getElementById('local-book-reader');
    document.getElementById('local-book-title').textContent = name;
    reader.innerHTML = window.StudyPdf.viewer();
    dialog.showModal();
    const src = localSourceKey ? { localSourceKey, title: name, page: 1 } : { rawUrl, title: name, page: 1 };
    window.StudyPdf.mount(reader, src, { page: 1, zoom: 100, trim: false });
  }

  function bindStudyAdmin() {
    const button = document.getElementById('btn-study-admin');
    const dialog = document.getElementById('study-admin-dialog');
    const form = document.getElementById('study-admin-source');
    const status = document.getElementById('study-admin-status');
    const clearBtn = document.getElementById('admin-clear-link');
    const { course, filter, exercise, file, page } = form.elements;
    const submit = form.querySelector('button[type=submit]');
    let questions = [];

    function renderExerciseOptions(keepId = '') {
      const qTerm = String(filter?.value || '').trim().toLowerCase();
      const visible = qTerm
        ? questions.filter((q) => `${q.title} ${q.id} ${q.localId || ''}`.toLowerCase().includes(qTerm))
        : questions;
      exercise.innerHTML = visible.length
        ? visible.map((q) => {
            const linked = q.extraReference ? ' [PDF linked]' : '';
            return `<option value="${esc(q.id)}">${esc(q.title)}${linked}</option>`;
          }).join('')
        : '<option value="">No matching exercises</option>';
      if (keepId && visible.some((q) => q.id === keepId)) exercise.value = keepId;
      submit.disabled = !visible.length;
      showSavedLink();
    }

    function showSavedLink() {
      const ref = questions.find((question) => question.id === exercise.value)?.extraReference;
      file.value = ref?.path || '';
      page.value = ref?.page || 1;
      if (clearBtn) clearBtn.hidden = !ref?.path;
    }

    async function loadCourse(keepId = '') {
      const courseId = course.value;
      submit.disabled = true;
      if (!courseId) return;
      status.textContent = 'Loading exercises and course files…';
      try {
        const bank = await ensureCourseBank(courseId);
        const docs = await apiGet(`/api/canvas/documents?course=${encodeURIComponent(bank.canvasId || '')}`);
        if (course.value !== courseId) return;
        questions = bank.questions.filter((question) => question.available !== false);
        const pdfs = (docs.files || []).filter((doc) => doc.kind === 'pdf');
        file.innerHTML = '<option value="">No additional PDF</option>'
          + pdfs.map((doc) => `<option value="${esc(doc.path)}">${esc(doc.name)}</option>`).join('');
        renderExerciseOptions(keepId);
        const linkedCount = questions.filter((q) => q.extraReference).length;
        status.textContent = pdfs.length
          ? `${pdfs.length} PDFs available · ${linkedCount} exercise link${linkedCount === 1 ? '' : 's'} saved.`
          : 'Add a PDF to this course to link a source.';
      } catch {
        status.textContent = 'Restart your desktop Study-OS server to open course admin.';
      }
    }

    button.hidden = false;
    button.onclick = () => {
      window.StudyUI.closeSettings?.();
      course.innerHTML = boot.catalog.map((entry) =>
        `<option value="${esc(entry.courseId)}">${esc(entry.title)}</option>`).join('');
      if (selectedCourseId) course.value = selectedCourseId;
      if (filter) filter.value = '';
      document.getElementById('admin-add-files').disabled =
        !boot.canvasArchive?.hasResyncApp || !boot.canvasArchive.courses?.length;
      dialog.showModal();
      loadCourse();
    };
    course.onchange = () => {
      if (filter) filter.value = '';
      loadCourse();
    };
    if (filter) filter.oninput = () => renderExerciseOptions(exercise.value);
    exercise.onchange = showSavedLink;

    async function submitSourceLink(selectionFile) {
      submit.disabled = true;
      const selection = exercise.value;
      const courseId = course.value;
      try {
        const response = await fetch('/api/tutor/source-link', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ courseId, questionId: selection, path: selectionFile, page: Number(page.value) }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        delete bankCache[courseId];
        await loadCourse(selection);
        if (course.value === courseId) {
          status.textContent = selectionFile ? 'PDF page linked to this exercise.' : 'Extra PDF link removed.';
        }
      } catch (error) {
        status.textContent = error.message || 'Could not save the source link.';
        submit.disabled = false;
      }
    }

    form.onsubmit = async (event) => {
      event.preventDefault();
      await submitSourceLink(file.value);
    };
    if (clearBtn) {
      clearBtn.onclick = () => submitSourceLink('');
    }
    document.getElementById('admin-open-sync').onclick = () => {
      dialog.close();
      openCanvasSync('canvas');
    };
    document.getElementById('admin-add-files').onclick = () => {
      const entry = boot.catalog.find((item) => item.courseId === course.value);
      dialog.close();
      openCanvasFiles(String(entry?.canvasId || ''));
    };
    document.getElementById('admin-open-tutor').onclick = () => {
      dialog.close();
      window.StudyTutor.open();
    };
  }

  function bindCanvasSync() {
    const dialog = document.getElementById('canvas-sync-dialog');
    const form = document.getElementById('canvas-sync-form');
    const { mode, session, edToken, edRegion, rememberEd } = form.elements;
    const submit = form.querySelector('button[type="submit"]');
    const status = document.getElementById('canvas-sync-status');
    const log = document.getElementById('canvas-sync-log');
    const details = document.getElementById('canvas-sync-details');
    const importBtn = document.getElementById('canvas-sync-import');
    let pollTimer;
    let checking = false;
    let submitting = false;
    let refreshedRun;

    function updateFields() {
      document.getElementById('canvas-session-fields').hidden = mode.value === 'ed';
      document.getElementById('canvas-ed-fields').hidden = mode.value === 'canvas';
      session.disabled = mode.value === 'ed';
      session.required = !session.disabled;
      document.getElementById('canvas-ed-token-link').href = `https://edstem.org/${edRegion.value}/settings/api-tokens`;
    }

    function clearCredentials() {
      session.value = '';
      edToken.value = '';
    }

    mode.onchange = updateFields;
    edRegion.onchange = updateFields;
    for (const button of form.querySelectorAll('[data-paste-credential]')) {
      button.onclick = async () => {
        const field = form.elements[button.dataset.pasteCredential];
        field.focus();
        try {
          const value = (await navigator.clipboard.readText()).trim();
          if (dialog.open && field.offsetWidth && value) field.value = value;
        } catch {
          status.textContent = 'Paste into the selected field with ⌘V or Ctrl+V.';
        }
      };
    }

    async function request(action, options) {
      const response = await fetch('/api/canvas/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...options }),
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
      status.textContent = 'Starting sync…';
      const options = { mode: mode.value };
      if (mode.value !== 'ed') options.session = session.value.trim();
      if (mode.value !== 'canvas') {
        options.edToken = edToken.value.trim();
        options.edRegion = edRegion.value;
        options.rememberEd = rememberEd.checked;
      }
      clearCredentials();
      let started = false;
      try {
        await request('start', options);
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
    dialog.addEventListener('close', clearCredentials);
    return (source) => {
      mode.value = source;
      updateFields();
      if (!dialog.open) {
        dialog.showModal();
        (source === 'ed' ? edToken : session).focus();
      }
      if (!submitting && !checking) {
        status.textContent = 'Connecting to Canvas Sync…';
        submit.disabled = true;
        readStatus();
      }
    };
  }

  async function saveForOffline(event) {
    const button = event.currentTarget;
    const valEl = document.getElementById('settings-offline-value');
    const showStatus = (message, valLabel = '') => {
      offlineStatus = message;
      const status = document.getElementById('offline-status');
      if (status) status.textContent = message;
      if (valEl && valLabel) {
        valEl.textContent = valLabel;
        valEl.classList.toggle('ios-val-live', valLabel === 'Saved');
      }
    };
    if (!navigator.serviceWorker) {
      showStatus('Offline saving is unavailable in this browser.', 'Unavailable');
      return;
    }
    button.disabled = true;
    showStatus('Saving notes and questions…', 'Saving…');
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
      showStatus('Saved for offline', 'Saved');
      toast('Saved notes & questions for offline use.');
    } catch {
      showStatus(
        navigator.serviceWorker.controller
          ? 'The saved copy is available. Connect to update it.'
          : 'Could not save. Check your connection and try again.',
        navigator.serviceWorker.controller ? 'Saved' : 'Retry'
      );
    } finally {
      button.disabled = false;
    }
  }

  function bindMemberAccess() {
    if (!members.enabled) return;
    const dialog = document.getElementById('member-dialog');
    const form = document.getElementById('member-form');
    const key = document.getElementById('member-key');
    const toggleBtn = document.getElementById('member-key-toggle');
    const feedback = document.getElementById('member-feedback');
    const submit = document.getElementById('member-submit-btn') || form.querySelector('button[type=submit]');

    const setFeedback = (text, kind = '') => {
      feedback.textContent = text || '';
      feedback.hidden = !text;
      feedback.classList.remove('is-error', 'is-success', 'is-loading', 'is-shake');
      if (kind) feedback.classList.add(`is-${kind}`);
      if (kind === 'error') {
        void feedback.offsetWidth;
        feedback.classList.add('is-shake');
      }
    };

    const dismiss = () => {
      try { sessionStorage.setItem('study-os-member-dismissed', '1'); } catch {}
      key.value = '';
      key.type = 'password';
      if (toggleBtn) toggleBtn.textContent = 'Show';
      setFeedback('');
      dialog.close();
    };
    const show = () => {
      window.StudyUI.closeSettings?.();
      key.type = 'password';
      if (toggleBtn) toggleBtn.textContent = 'Show';
      setFeedback('');
      dialog.showModal();
      setTimeout(() => key.focus(), 20);
    };

    if (toggleBtn) {
      toggleBtn.onclick = () => {
        const nextVisible = key.type === 'password';
        key.type = nextVisible ? 'text' : 'password';
        toggleBtn.textContent = nextVisible ? 'Hide' : 'Show';
        toggleBtn.setAttribute('aria-label', nextVisible ? 'Hide access string' : 'Show access string');
      };
    }
    key.addEventListener('input', () => {
      if (feedback.classList.contains('is-error')) setFeedback('');
    });
    dialog.addEventListener('cancel', dismiss);
    document.getElementById('member-dismiss').onclick = dismiss;
    document.getElementById('btn-member-library').onclick = async () => {
      window.StudyUI.closeSettings?.();
      if (members.isUnlocked()) {
        try {
          await members.forget();
        } catch {
          toast('Browser storage did not clear. Clear the stored site data to forget the key.');
          return;
        }
        try { sessionStorage.removeItem('study-os-member-dismissed'); } catch {}
        await refreshArchiveViews();
        toast('Private PDF archive locked.');
        show();
      } else {
        await members.restore();
        if (members.isUnlocked()) {
          await refreshArchiveViews();
          toast('Private PDF archive restored.');
        } else {
          show();
        }
      }
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const origLabel = submit.textContent;
      submit.disabled = true;
      submit.textContent = 'Unlocking…';
      setFeedback('Decrypting private PDF archive…', 'loading');
      try {
        const rawInput = String(key.value || '').trim().replace(/^["'`]+|["'`]+$/g, '');
        if (/^[A-Za-z0-9_-]{4,24}$/.test(rawInput) && !/^sos1_/i.test(rawInput) && window.StudyCommunity?.isSignedIn?.()) {
          const res = await window.StudyCommunity.redeemAccessCode(rawInput);
          if (!res?.archiveUnlocked) {
            throw new Error('Access code saved, but temporary PDF archive access is currently disabled by the admin. Use Sync BI Canvas instead.');
          }
          key.value = '';
          key.type = 'password';
          if (toggleBtn) toggleBtn.textContent = 'Show';
          const totalQ = (boot.catalog || []).reduce((s, c) => s + Number(c.questionCount || 0), 0);
          setFeedback(`Temporary PDF pass activated (${totalQ} questions + original PDFs).`, 'success');
          dialog.close();
          toast(`Access code accepted — course PDFs unlocked!`);
          return;
        }
        const rawKey = rawInput.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const remember = document.getElementById('member-remember').checked;
        const remembered = await members.unlock(rawKey, remember);
        if (window.StudyCommunity?.isAdmin?.()) {
          const canonKey = rawKey.startsWith('sos1_') ? rawKey : `sos1_${rawKey}`;
          window.StudyCommunity.saveAdminMemberKey?.(canonKey).catch(() => {});
        }
        key.value = '';
        key.type = 'password';
        if (toggleBtn) toggleBtn.textContent = 'Show';
        await refreshArchiveViews();
        const totalQ = (boot.catalog || []).reduce((s, c) => s + Number(c.questionCount || 0), 0);
        setFeedback(`Archive unlocked (${totalQ} questions + original PDFs).`, 'success');
        dialog.close();
        toast(remember && !remembered
          ? `Private PDF archive unlocked for this visit (${totalQ} questions).`
          : `Private PDF archive unlocked (${totalQ} questions + PDFs).`);
      } catch (error) {
        setFeedback(error.message || 'Could not open the private archive.', 'error');
        key.focus();
        key.select?.();
      } finally {
        submit.disabled = false;
        submit.textContent = origLabel;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // VIEW 2: EXAM SIMULATOR HUB (All 5 Subjects + Verified Past Papers + Progress)
  // ---------------------------------------------------------------------------
  let selectedExamFilter = 'all'; // 'all' | 'todo' | 'past' | 'done'

  const EXCLUDED_NON_EXAM_COLLS = new Set(['multchoice-2025', 'pandas-viz-exam2']);

  function getExamPaperCollections(cMeta) {
    const colls = cMeta.collections || [];
    const examColls = colls.filter((col) => {
      const id = String(col.id || '');
      if (EXCLUDED_NON_EXAM_COLLS.has(id)) return false;
      const qCount = Array.isArray(col.questionIds) ? col.questionIds.length : Number(col.questionCount || 0);
      if (Array.isArray(col.questionIds) && qCount === 0) return false;
      return (
        /^(E\d|WF-MOCK|exam-|nov19-mock|wiseflow-mock|sample-exam|mock-exam-|official-mock)/i.test(id) ||
        col.kind === 'mock_exam' ||
        col.kind === 'exam'
      );
    });
    return examColls;
  }

  function examSortYearScore(col) {
    const hay = `${col.id || ''} ${col.title || ''}`;
    const mFull = hay.match(/\b(20\d{2})\s*([hvsf]|autumn|spring|fall)?/i);
    if (mFull) {
      const yr = Number(mFull[1]) * 10;
      const term = String(mFull[2] || '').toLowerCase();
      return yr + (term.startsWith('h') || term.startsWith('f') || term.startsWith('a') ? 8 : 4);
    }
    const mShort = String(col.id || '').match(/^E(\d{2})([FS])/i);
    if (mShort) {
      return (2000 + Number(mShort[1])) * 10 + (mShort[2].toUpperCase() === 'F' ? 8 : 4);
    }
    return 0;
  }

  function classifyExamPaper(col, cMeta) {
    const id = String(col.id || '');
    const cid = String(cMeta?.courseId || '');
    const qIds = Array.isArray(col.questionIds) ? col.questionIds : [];
    const qCount = qIds.length || Number(col.questionCount || 0);
    const colProv = window.StudyProvenance?.describeCollection?.(col, cid);
    const defaultDur = Number(cMeta?.examInfo?.durationMinutes || 180);

    // Explicit verified durations where collection omitted durationMinutes
    let durMin = Number(col.durationMinutes || 0);
    if (!durMin) {
      if (id === 'sample-exam') durMin = 60;
      else if (id === 'official-mock-2') durMin = 60;
      else if (id === 'official-mock') durMin = 45;
      else if (id === 'wiseflow-mock-1') durMin = 180;
      else if (cid === 'econ-2522' && /^E(23F|24S)$/i.test(id) && qCount > 0 && qCount < 12) durMin = 90;
      else durMin = defaultDur;
    }

    const isOfficialSample = id === 'sample-exam' || /^official-mock/i.test(id);
    const isSynthetic = Boolean(colProv?.synthetic) || col.kind === 'mock_exam' || col.kind === 'mock' || /^(WF-MOCK|nov19-mock|wiseflow-mock|mock-exam)/i.test(id);
    const isPartialPast = !isSynthetic && !isOfficialSample && cid === 'econ-2522' && qCount > 0 && qCount < 12;

    if (!isSynthetic && !isOfficialSample) {
      return {
        group: 'past',
        tier: isPartialPast ? 'partial_past' : 'full_past',
        badgeText: isPartialPast ? 'Partial Past Exam' : 'Full Past Exam',
        badgeClass: isPartialPast ? 'exam-type-partial' : 'exam-type-past',
        tooltip: isPartialPast
          ? `Official BI past paper extract (${qCount} text-complete questions online; original PDF figures require BI Canvas sync or archive).`
          : 'Verified full official BI past examination paper.',
        durMin,
        qCount,
        qIds,
        isPast: true,
        isFullPast: !isPartialPast,
        sortScore: (isPartialPast ? 0 : 100000) + examSortYearScore(col),
      };
    }

    if (isOfficialSample) {
      return {
        group: 'mock',
        tier: 'official_sample',
        badgeText: id === 'sample-exam' ? 'Official BI Sample' : 'Official Short Mock',
        badgeClass: 'exam-type-sample',
        tooltip: 'Official BI sample or short rehearsal paper — shorter than a full 3-hour final exam.',
        durMin,
        qCount,
        qIds,
        isPast: false,
        isFullPast: false,
        sortScore: 50000 + qCount,
      };
    }

    const modelShort = colProv?.llmModel
      ? colProv.llmModel.replace(/\s*\(legacy[^)]*\)/i, '').replace(/Antigravity format/i, 'Antigravity')
      : '';
    return {
      group: 'mock',
      tier: 'ai_mock',
      badgeText: durMin >= 150 ? 'AI Full Mock' : 'AI Rehearsal Mock',
      badgeClass: 'exam-type-ai',
      tooltip: `Synthetically constructed mock paper${modelShort ? ` (${modelShort})` : ''} matching official BI exam format.`,
      durMin,
      qCount,
      qIds,
      isPast: false,
      isFullPast: false,
      sortScore: 10000 + durMin * 10 + qCount,
    };
  }

  function computeExamPaperProgress(qIds, records, attemptsByQid, savedResult = null, col = null) {
    const total = qIds.length;
    let done = 0;
    let revisit = 0;
    let inProgress = 0;
    let firstUndoneIdx = 0;
    let foundUndone = false;
    let accSum = 0;
    let accCount = 0;

    qIds.forEach((qid, idx) => {
      const rec = records[qid];
      const st = rec?.status || 'not_started';
      if (st === 'done') {
        done++;
      } else {
        if (!foundUndone) {
          firstUndoneIdx = idx;
          foundUndone = true;
        }
        if (st === 'revisit') revisit++;
        else if (st === 'in_progress') inProgress++;
      }
      const latestAcc = attemptsByQid.get(qid);
      if (Number.isFinite(latestAcc)) {
        accSum += latestAcc;
        accCount++;
      }
    });

    const touched = done + revisit + inProgress;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const revisitPct = total > 0 ? Math.min(100 - pct, Math.round((revisit / total) * 100)) : 0;
    const hasSavedSit = Boolean(savedResult && Number.isFinite(Number(savedResult.bestPct ?? savedResult.lastPct)));
    const status = (total > 0 && done >= total) || (hasSavedSit && Number(savedResult.gradedCount || 0) >= Math.max(1, total))
      ? 'completed'
      : touched > 0 || hasSavedSit
      ? 'in_progress'
      : 'not_started';
    const avgAccPct = accCount > 0 ? Math.round((accSum / accCount) * 100) : null;

    // Resolve BI Letter Grade (official saved exam sit takes precedence; else derive from graded questions)
    let grade = null;
    let gradeSource = '';
    let bestPct = null;
    let lastPct = null;
    if (hasSavedSit) {
      bestPct = Math.round(Number(savedResult.bestPct ?? savedResult.lastPct));
      lastPct = Math.round(Number(savedResult.lastPct ?? bestPct));
      grade = gradeFromPct(bestPct);
      gradeSource = 'official';
    } else if (avgAccPct != null && total > 0) {
      const fullCoverage = accCount >= total || status === 'completed';
      bestPct = avgAccPct;
      lastPct = avgAccPct;
      grade = gradeFromPct(avgAccPct);
      gradeSource = fullCoverage ? 'derived' : 'estimate';
    }

    const gradingMode = savedResult?.gradingKind || col?.gradingMode || '';
    const gradingLabel = gradingMode === 'auto'
      ? 'Auto-graded'
      : gradingMode === 'rubric'
      ? 'Rubric-graded'
      : gradingMode === 'mixed'
      ? 'Auto + Rubric'
      : '';

    return {
      total,
      done,
      revisit,
      inProgress,
      touched,
      pct: status === 'completed' ? 100 : pct,
      revisitPct: status === 'completed' ? 0 : revisitPct,
      status,
      avgAccPct,
      firstUndoneIdx,
      grade,
      gradeSource,
      bestPct,
      lastPct,
      savedResult,
      gradingMode,
      gradingLabel,
      isGradeA: Boolean(grade && gradeSource !== 'estimate' && grade.letter === 'A'),
    };
  }

  function renderExamsHub(focusCourseId = '') {
    const root = document.getElementById('exams-hub-root');
    if (isStaticWeb) recomputeWebAnalytics();
    if (!boot.catalog.length) {
      root.innerHTML = '<div class="panel"><p>No course banks loaded.</p></div>';
      return;
    }

    ensureExamCountdownTicker();
    const sortedCourses = [...boot.catalog].sort((a, b) => {
      const da = daysUntilDateStr(a.examInfo?.date);
      const db = daysUntilDateStr(b.examInfo?.date);
      const va = da !== null && da >= -2 ? da : 999;
      const vb = db !== null && db >= -2 ? db : 999;
      return va - vb;
    });

    const records = boot.progress?.records || {};
    const examResultsMap = loadExamResultsMap();
    const attemptsByQid = new Map();
    if (isStaticWeb) {
      const ws = loadWebState();
      for (const a of ws.attempts || []) {
        if (a?.questionId && Number.isFinite(Number(a.qualityAccuracy))) {
          attemptsByQid.set(a.questionId, Number(a.qualityAccuracy));
        }
      }
    } else {
      for (const [qid, rec] of Object.entries(records)) {
        if (Number.isFinite(Number(rec?.lastAccuracy))) {
          attemptsByQid.set(qid, Number(rec.lastAccuracy));
        }
      }
    }

    // Aggregate global exam progress & BI grades across all active courses
    let globalPapersTotal = 0;
    let globalPapersDone = 0;
    let globalPapersInProg = 0;
    let globalFullPastTotal = 0;
    let globalFullPastDone = 0;
    let globalAGrades = 0;
    let globalNeedsA = 0;
    let globalGradePctSum = 0;
    let globalGradedPapers = 0;
    let globalQsTotal = 0;
    let globalQsDone = 0;

    const coursePrepared = sortedCourses.map((c) => {
      const maint = getCourseMaintenance(c.courseId);
      const maintLocked = Boolean(maint && !canBypassCourseMaintenance());
      const rawColls = getExamPaperCollections(c);
      const papers = rawColls.map((col) => {
        const meta = classifyExamPaper(col, c);
        const savedRes = examResultsMap[`${c.courseId}:${col.id}`] || null;
        const prog = computeExamPaperProgress(meta.qIds, records, attemptsByQid, savedRes, col);
        return { col, meta, prog };
      });
      if (!maintLocked) {
        for (const p of papers) {
          globalPapersTotal++;
          if (p.prog.status === 'completed') globalPapersDone++;
          else if (p.prog.status === 'in_progress') globalPapersInProg++;
          if (p.meta.isFullPast) {
            globalFullPastTotal++;
            if (p.prog.status === 'completed') globalFullPastDone++;
          }
          if (p.prog.grade && p.prog.gradeSource !== 'estimate') {
            globalGradedPapers++;
            globalGradePctSum += Number(p.prog.bestPct || 0);
            if (p.prog.grade.letter === 'A') globalAGrades++;
            else globalNeedsA++;
          } else {
            globalNeedsA++;
          }
          globalQsTotal += p.prog.total;
          globalQsDone += Math.min(p.prog.total, p.prog.done);
        }
      }
      return { c, maint, maintLocked, papers };
    });

    const globalQPct = globalQsTotal > 0 ? Math.min(100, Math.round((globalQsDone / globalQsTotal) * 100)) : 0;
    const globalAvgPct = globalGradedPapers > 0 ? Math.round(globalGradePctSum / globalGradedPapers) : null;
    const globalAvgGrade = globalAvgPct != null ? gradeFromPct(globalAvgPct) : null;

    const renderPackCard = (c, item) => {
      const { col, meta, prog } = item;
      const g = prog.grade;
      const isOfficialOrFullGrade = Boolean(g && prog.gradeSource !== 'estimate');

      let rightBadgeHtml = '';
      if (isOfficialOrFullGrade) {
        const star = g.letter === 'A' ? '★ ' : '';
        const tip = `${prog.gradingLabel || 'Graded'} · Best ${prog.bestPct}% (BI Grade ${g.letter} · ${g.label})${prog.savedResult?.attemptsCount > 1 ? ` · ${prog.savedResult.attemptsCount} sits` : ''}`;
        rightBadgeHtml = `<span class="exam-grade-medal ${g.cls}" title="${esc(tip)}"><b>${star}${g.letter}</b><small>${prog.bestPct}%</small></span>`;
      } else if (g && prog.gradeSource === 'estimate') {
        rightBadgeHtml = `<span class="exam-grade-medal is-est ${g.cls}" title="Projected BI grade from ${prog.touched} attempted question(s)"><b>Est. ${g.letter}</b><small>${prog.bestPct}%</small></span>`;
      } else if (prog.status === 'in_progress') {
        rightBadgeHtml = `<span class="exam-status-pill is-prog">In progress</span>`;
      } else {
        rightBadgeHtml = `<span class="exam-status-pill is-todo">Not started</span>`;
      }

      const qUnit = c.courseId === 'prog-3021'
        ? (meta.qCount === 1 ? 'task' : 'tasks')
        : (meta.qCount === 1 ? 'Q' : 'Qs');
      const metaBits = [
        meta.qCount ? `${meta.qCount} ${qUnit}` : '',
        `${meta.durMin} min`,
        prog.gradingLabel,
        prog.revisit > 0 ? `${prog.revisit} revisit` : '',
      ].filter(Boolean).join(' · ');

      const cardClasses = [
        'exam-pack-card',
        'exam-pack-clickable',
        meta.isPast ? 'exam-pack-official' : '',
        prog.isGradeA ? 'is-grade-a' : prog.status === 'completed' ? 'is-completed' : prog.status === 'in_progress' ? 'is-in-progress' : '',
      ].filter(Boolean).join(' ');

      const fillClass = prog.isGradeA
        ? 'is-grade-a'
        : isOfficialOrFullGrade
        ? g.cls
        : prog.status === 'completed'
        ? 'is-done'
        : '';

      let slotLeft = '';
      let slotRight = '';
      if (prog.isGradeA) {
        const countDone = Math.min(prog.total, Math.max(prog.done, Number(prog.savedResult?.gradedCount || 0)));
        slotLeft = `<strong>★ Grade A · ${prog.bestPct}%</strong><span>${prog.total ? `${countDone}/${prog.total} ${prog.done >= countDone ? 'done' : 'graded'}` : 'Mastered'}</span>`;
        slotRight = 'Retake ↻';
      } else if (isOfficialOrFullGrade) {
        slotLeft = `<strong>Grade ${g.letter} · ${prog.bestPct}%</strong><span>+${g.toA}% to A</span>`;
        slotRight = 'Aim for A →';
      } else if (prog.status === 'completed') {
        slotLeft = `<strong>✓ Completed</strong><span>${prog.total}/${prog.total} done</span>`;
        slotRight = 'Retake ↻';
      } else if (prog.status === 'in_progress') {
        slotLeft = `<strong>${prog.pct}%</strong><span>${prog.done}/${prog.total} done</span>`;
        slotRight = 'Continue →';
      } else {
        slotLeft = `<strong>0%</strong><span>${meta.qCount ? `0/${meta.qCount} ${qUnit}` : 'Ready'} · Target A</span>`;
        slotRight = 'Play →';
      }

      const barPct = prog.status === 'completed' ? 100 : prog.pct;
      const startIdx = selectedExamStyle === 'guided' && prog.status === 'in_progress' ? prog.firstUndoneIdx : 0;

      return `<div class="${cardClasses}" role="button" tabindex="0" aria-label="${esc(examLabel(col.title))} — ${esc(slotRight)}" data-sit-course="${esc(c.courseId)}" data-sit-coll="${esc(col.id)}" data-sit-dur="${meta.durMin}" data-sit-title="${esc(examLabel(col.title))}" data-sit-start-idx="${startIdx}">
        <div class="exam-pack-body">
          <div class="exam-pack-top">
            <span class="prov-badge ${meta.badgeClass}" title="${esc(meta.tooltip)}">${esc(meta.badgeText)}</span>
            ${rightBadgeHtml}
          </div>
          <strong class="exam-pack-title">${esc(examLabel(col.title))}</strong>
          <small class="muted exam-pack-meta">${esc(metaBits)}</small>
        </div>
        <div class="exam-card-prog-cta ${prog.isGradeA ? 'is-grade-a' : prog.status === 'in_progress' ? 'is-active' : ''}">
          <div class="exam-card-prog-row">
            <span class="exam-card-prog-stat">${slotLeft}</span>
            <span class="exam-card-prog-cue">${esc(slotRight)}</span>
          </div>
          <div class="exam-prog-track is-card-cta" role="progressbar" aria-valuenow="${barPct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(examLabel(col.title))} progress">
            <div class="exam-prog-fill ${fillClass}" style="width:${barPct}%"></div>
            ${prog.revisitPct > 0 ? `<div class="exam-prog-revisit" style="width:${prog.revisitPct}%;left:${barPct}%"></div>` : ''}
          </div>
        </div>
      </div>`;
    };

    const matchesFilter = (item) => {
      if (selectedExamFilter === 'todo') return item.prog.status !== 'completed';
      if (selectedExamFilter === 'done') return item.prog.status === 'completed';
      if (selectedExamFilter === 'past') return item.meta.isPast;
      if (selectedExamFilter === 'needs_a') return !item.prog.isGradeA;
      return true;
    };

    const cardsHtml = coursePrepared
      .map(({ c, maint, maintLocked, papers }) => {
        const daysLeft = daysUntilDateStr(c.examInfo?.date);
        const targetMs = examTargetMs(c.examInfo);
        const examTip = formatExamHoverTip(c.examInfo, targetMs);
        const daysPill =
          Number.isFinite(targetMs) && targetMs > Date.now() - 14400_000
            ? `<span class="badge exam-tip-host ${daysLeft !== null && daysLeft <= 14 && daysLeft >= 0 ? 'warn' : 'gold'}" data-exam-tip="${esc(examTip)}" aria-label="${esc(examTip)}" tabindex="0"><span class="exam-countdown-live" data-exam-target-ms="${targetMs}" data-exam-countdown-mode="exam">${esc(formatExamCountdown(targetMs, 'exam'))}</span></span>`
            : '';
        const mathPrep = c.courseId === 'math-2588' && c.obsidian?.practiceNote
          ? publicReferenceUrl(c.obsidian.practiceNote)
          : '';
        const maintBadgeHtml = maint
          ? `<span class="badge maintenance" title="${esc(maint.eta)}">${maintLocked ? esc(maint.badge) : 'Maintenance · Admin'}</span>`
          : '';

        if (maintLocked) {
          return `
            <section class="panel exam-course-card course-card-maintenance" id="exam-card-${esc(c.courseId)}" style="border-left-color:${esc(c.color)}">
              <div class="row-between" style="margin-top:0">
                <div style="flex:1;min-width:260px">
                  <span class="eyebrow" style="color:${esc(c.color)}">${esc(c.code)} · ${esc(maint.eta)}</span>
                  <h2>${esc(c.title)}</h2>
                  <p class="muted" style="font-size:13.5px;margin:6px 0 0">${esc(maint.detail)}</p>
                </div>
                <div class="row-actions">
                  ${maintBadgeHtml}
                  ${daysPill}
                  <button type="button" class="ghost-btn" data-exam-ref="${esc(c.courseId)}">Reference</button>
                </div>
              </div>
            </section>
          `;
        }

        const cPastPapers = papers.filter((p) => p.meta.group === 'past').sort((a, b) => b.meta.sortScore - a.meta.sortScore);
        const cMockPapers = papers.filter((p) => p.meta.group !== 'past').sort((a, b) => b.meta.sortScore - a.meta.sortScore);
        const visPast = cPastPapers.filter(matchesFilter);
        const visMocks = cMockPapers.filter(matchesFilter);

        const cPapersDone = papers.filter((p) => p.prog.status === 'completed').length;
        const cPastDone = cPastPapers.filter((p) => p.prog.status === 'completed').length;
        const cQsTotal = papers.reduce((s, p) => s + p.prog.total, 0);
        const cQsDone = papers.reduce((s, p) => s + Math.min(p.prog.total, p.prog.done), 0);
        const cPct = cQsTotal > 0 ? Math.min(100, Math.round((cQsDone / cQsTotal) * 100)) : 0;
        const cGraded = papers.filter((p) => p.prog.grade && p.prog.gradeSource !== 'estimate');
        const cACount = cGraded.filter((p) => p.prog.grade.letter === 'A').length;
        const cAvgPct = cGraded.length ? Math.round(cGraded.reduce((s, p) => s + Number(p.prog.bestPct || 0), 0) / cGraded.length) : null;
        const cAvgGrade = cAvgPct != null ? gradeFromPct(cAvgPct) : null;

        if (selectedExamFilter !== 'all' && !visPast.length && !visMocks.length) {
          return '';
        }

        const customDesc =
          c.courseId === 'acct-2527'
            ? '10 random MCQs (40 pts) + 4 worksheets across Ch 2/3, Ch 5, Ch 7 & Ch 8/10 (140 pts).'
            : c.courseId === 'econ-2522'
            ? 'Official BI 3-part structure: 10 MCQs + 3 Short Answers + 1 Multi-Part Analytical Case (180m).'
            : c.courseId === 'math-2588'
            ? '12 stratified calculation problems spanning Financial Math, Algebra/Functions, Optimisation & Taylor (180m).'
            : c.courseId === 'ob-2537'
            ? 'Full 50-question randomized WISEflow MCQ paper balanced across Lessons 1–14 (180m).'
            : '4-task Home Exam 2 blueprint: (1) Loop/Simulation, (2) Function/Dict/DateTime, (3) Pandas/Seaborn Table, (4) Time Series/Resample/Plot + 2 checks (180m).';

        const showRandomBuilder = selectedExamFilter === 'all' || selectedExamFilter === 'todo' || selectedExamFilter === 'needs_a';

        return `
          <section class="panel exam-course-card" id="exam-card-${esc(c.courseId)}" style="border-left-color:${esc(c.color)}">
            <div class="row-between" style="margin-top:0;align-items:flex-start">
              <div style="flex:1;min-width:260px">
                <span class="eyebrow" style="color:${esc(c.color)}">${esc(c.code)} · ${esc(c.examInfo?.format || 'Exam Preparation')}</span>
                <h2>${esc(c.title)}</h2>
                <div class="exam-course-prog">
                  <div class="exam-course-prog-meta">
                    <span><strong>${cPapersDone}/${papers.length}</strong> papers done${cPastPapers.length ? ` · <strong>${cPastDone}/${cPastPapers.length}</strong> past exams` : ''} · ${cQsDone}/${cQsTotal} Qs${cGraded.length ? ` · <strong class="exam-inline-grade ${cAvgGrade.cls}">★ ${cACount}/${papers.length} A · Avg ${cAvgGrade.letter} (${cAvgPct}%)</strong>` : ''}</span>
                    <strong>${cPct}%</strong>
                  </div>
                  <div class="exam-prog-track"><div class="exam-prog-fill ${cACount === papers.length && papers.length > 0 ? 'is-grade-a' : cPct >= 100 ? 'is-done' : ''}" style="width:${cPct}%"></div></div>
                </div>
                ${c.examInfo?.notes ? `<p class="muted" style="font-size:13px;margin:8px 0 0">${esc(c.examInfo.notes)}</p>` : ''}
                <div class="row-actions" style="gap:12px;margin-top:6px;font-size:12.5px">
                  ${mathPrep ? `<a href="${esc(mathPrep)}">2026 preparation guide</a>` : ''}
                  ${c.courseId === 'math-2588' ? '<a href="https://www.dr-eriksen.no/teaching/EBA1180/exams.php" target="_blank" rel="noopener">Dr. Eriksen EBA 1180 archive ↗</a>' : ''}
                </div>
              </div>
              <div class="row-actions">
                ${maintBadgeHtml}
                ${daysPill}
                <button type="button" class="ghost-btn" data-exam-ref="${esc(c.courseId)}">Reference</button>
              </div>
            </div>

            ${visPast.length ? `
              <div class="exam-group-head">
                <span class="exam-group-label">Official BI Past Exams (${visPast.length})</span>
                <small class="muted">Click any paper to sit or continue · real BI exam papers</small>
              </div>
              <div class="exam-pack-grid">
                ${visPast.map((p) => renderPackCard(c, p)).join('')}
              </div>
            ` : ''}

            ${(visMocks.length || showRandomBuilder) ? `
              <div class="exam-group-head">
                <span class="exam-group-label">${visPast.length ? 'Mock Exams & Official Samples' : 'Official Samples & Mock Exams'}</span>
                <small class="muted">${visMocks.length} paper${visMocks.length === 1 ? '' : 's'}${showRandomBuilder ? ' + randomized builder' : ''}</small>
              </div>
              <div class="exam-pack-grid">
                ${visMocks.map((p) => renderPackCard(c, p)).join('')}
                ${showRandomBuilder ? `
                  <div class="exam-pack-card exam-pack-clickable exam-pack-builder" role="button" tabindex="0" aria-label="Build and launch randomized full mock exam for ${esc(c.title)}" data-gen-exam="${esc(c.courseId)}">
                    <div class="exam-pack-body">
                      <div class="exam-pack-top">
                        <span class="prov-badge exam-type-ai">Dynamic Generator</span>
                        <span class="exam-status-pill is-todo">Unlimited</span>
                      </div>
                      <strong class="exam-pack-title">Randomized Full Mock Exam</strong>
                      <small class="muted exam-pack-meta">${esc(customDesc)}</small>
                    </div>
                    <div class="exam-card-prog-cta is-builder">
                      <div class="exam-card-prog-row">
                        <span class="exam-card-prog-stat"><strong>Fresh draw</strong><span>Auto-graded · Target A</span></span>
                        <span class="exam-card-prog-cue">Build &amp; Play →</span>
                      </div>
                      <div class="exam-prog-track is-card-cta"><div class="exam-prog-fill is-builder" style="width:100%"></div></div>
                    </div>
                  </div>
                ` : ''}
              </div>
            ` : ''}
          </section>
        `;
      })
      .filter(Boolean)
      .join('');

    const emptyFilterHtml = !cardsHtml
      ? `<div class="panel" style="text-align:center;padding:28px"><p class="muted" style="margin:0 0 10px">No exam papers match this filter yet.</p><button type="button" class="ghost-btn" data-exam-filter="all">Show all exams</button></div>`
      : '';

    root.innerHTML = `
      <div class="hero-card" style="margin-bottom:20px">
        <div class="hero-top">
          <div style="flex:1;min-width:260px">
            <span class="eyebrow">WISEflow &amp; Past Exam Simulator · Target A (85%+)</span>
            <h1 class="hero-title" style="margin-bottom:6px">Mock exams and past papers</h1>
            <p class="muted" style="margin:0;font-size:13.5px">
              Click any paper to play or resume. MCQs &amp; FLOWmulti sheets are auto-graded; written, math &amp; Python papers compute a live BI letter grade (A–F) from your verified rubric steps.
            </p>
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

        <div class="exam-summary-bar">
          <div class="exam-summary-stats">
            <div class="exam-stat-chip ${globalAGrades > 0 ? 'is-gold' : ''}"><b>★ ${globalAGrades} / ${globalPapersTotal}</b><span>A-Grades Earned</span></div>
            <div class="exam-stat-chip"><b>${globalPapersDone} / ${globalPapersTotal}</b><span>Papers Completed</span></div>
            <div class="exam-stat-chip"><b>${globalFullPastDone} / ${globalFullPastTotal}</b><span>Full Past Exams</span></div>
            <div class="exam-stat-chip"><b>${globalAvgGrade ? `<span class="exam-inline-grade ${globalAvgGrade.cls}">${globalAvgGrade.letter} · ${globalAvgPct}%</span>` : '—'}</b><span>Avg Exam Grade</span></div>
            <div class="exam-stat-chip"><b>${globalQsDone} / ${globalQsTotal}</b><span>Exam Qs (${globalQPct}%)</span></div>
          </div>
          <div class="exam-prog-track is-hero"><div class="exam-prog-fill ${globalAGrades === globalPapersTotal && globalPapersTotal > 0 ? 'is-grade-a' : globalQPct >= 100 ? 'is-done' : ''}" style="width:${globalQPct}%"></div></div>
          <div class="exam-grade-scale-bar">
            <span class="muted">BI Scale:</span>
            <span class="exam-scale-chip grade-a">A ≥85%</span>
            <span class="exam-scale-chip grade-b">B ≥77%</span>
            <span class="exam-scale-chip grade-c">C ≥65%</span>
            <span class="exam-scale-chip grade-d">D ≥50%</span>
            <span class="exam-scale-chip grade-e">E ≥40%</span>
            <span class="exam-scale-chip grade-f">F &lt;40%</span>
          </div>
        </div>

        <div class="exam-toolbar-foot">
          <div class="exam-filter-row" role="group" aria-label="Filter exams">
            <button type="button" class="preset-chip ${selectedExamFilter === 'all' ? 'active' : ''}" data-exam-filter="all">All (${globalPapersTotal})</button>
            <button type="button" class="preset-chip ${selectedExamFilter === 'todo' ? 'active' : ''}" data-exam-filter="todo">Not Completed (${Math.max(0, globalPapersTotal - globalPapersDone)})</button>
            <button type="button" class="preset-chip ${selectedExamFilter === 'needs_a' ? 'active' : ''}" data-exam-filter="needs_a">Needs A (${globalNeedsA})</button>
            <button type="button" class="preset-chip ${selectedExamFilter === 'past' ? 'active' : ''}" data-exam-filter="past">Past Exams Only</button>
            <button type="button" class="preset-chip ${selectedExamFilter === 'done' ? 'active' : ''}" data-exam-filter="done">Completed (${globalPapersDone})</button>
          </div>
          <div class="row-actions" style="gap:8px;flex-wrap:wrap">
            ${isStaticWeb && !getBiSyncStatus().hasEverSynced
              ? `<button type="button" class="primary-btn" id="btn-exams-sync-bi" style="padding:6px 12px;font-size:12.5px">Sync BI Canvas</button>`
              : ''}
            <a class="ghost-btn" href="https://portal.bi.no/en/exams/former-examination-papers" target="_blank" rel="noopener" style="padding:6px 11px;font-size:12.5px">BI past papers ↗</a>
            ${isStaticWeb && members.enabled && !members.isUnlocked()
              ? `<button type="button" class="ghost-btn" id="btn-exams-unlock-member" style="padding:6px 11px;font-size:12.5px">Owner PDF key</button>`
              : isStaticWeb && members.enabled && members.isUnlocked()
              ? `<span class="badge good">Private PDF archive unlocked</span>`
              : ''}
          </div>
        </div>
      </div>
      ${cardsHtml || emptyFilterHtml}
    `;

    root.querySelector('#btn-exams-sync-bi')?.addEventListener('click', () => {
      openBiSyncHub();
    });
    root.querySelector('#btn-exams-unlock-member')?.addEventListener('click', () => {
      document.getElementById('btn-member-library')?.click();
    });

    root.querySelectorAll('[data-exam-style]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedExamStyle = btn.dataset.examStyle;
        renderExamsHub();
      });
    });

    root.querySelectorAll('[data-exam-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedExamFilter = btn.dataset.examFilter || 'all';
        renderExamsHub();
      });
    });

    const bindCardTrigger = (el, handler) => {
      el.addEventListener('click', handler);
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          handler();
        }
      });
    };

    root.querySelectorAll('[data-sit-course]').forEach((card) => {
      bindCardTrigger(card, () =>
        launchCollectionExam(
          card.dataset.sitCourse,
          card.dataset.sitColl,
          card.dataset.sitTitle,
          selectedExamStyle,
          Number(card.dataset.sitDur || 0),
          Number(card.dataset.sitStartIdx || 0)
        )
      );
    });

    root.querySelectorAll('[data-gen-exam]').forEach((card) => {
      bindCardTrigger(card, () => launchRandomizedFullExam(card.dataset.genExam, selectedExamStyle));
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

  async function launchCollectionExam(courseId, collectionId, title, examStyle = 'blind', customDurationMin = 0, startIndex = 0) {
    if (isCourseInMaintenanceForUser(courseId)) {
      const m = getCourseMaintenance(courseId);
      toast(`${m?.badge || 'Under maintenance'} — ${m?.eta || 'reworking soon'}.`);
      return;
    }
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
      startIndex: examStyle === 'guided' ? startIndex : 0,
      mode: 'exam',
      examStyle,
      examCollectionId: colObj?.id || collectionId,
      examTitle: title,
      durationMinutes: durMin,
      freshExamSit: examStyle === 'blind',
      profile: 'exam',
    });
  }

  async function launchRandomizedFullExam(courseId, examStyle = 'blind') {
    if (isCourseInMaintenanceForUser(courseId)) {
      const m = getCourseMaintenance(courseId);
      toast(`${m?.badge || 'Under maintenance'} — ${m?.eta || 'reworking soon'}.`);
      return;
    }
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
      examCollectionId: 'randomized-mock',
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

  // Exam Relevance Judge (0-100) across all 5 BI courses + universal fallback for synced courses.
  // Prioritises real official exams, weekly tutoring sessions, lecture-slide exercises, and official assignments
  // ahead of reading warmups, AI mocks, synthetic drills, and textbook index exercises.
  function examRelevanceScore(q, bank = null) {
    if (!q) return 50;
    const cid = String(q.courseId || bank?.courseId || '');
    const col = String(q.collectionId || '');
    const tid = String(q.topicId || '');
    const hasWf = Array.isArray(q.wiseflowFields) && q.wiseflowFields.length > 0;
    const prov = window.StudyProvenance?.describe?.(q, bank);
    const cat = prov?.category || '';

    if (cid === 'acct-2527') {
      const coreAcctTopic = ['2', '3', '5', '7', '8', '10'].includes(tid);
      if (col === 'E23F' || cat === 'past_exam') return hasWf || q.kind !== 'mcq' ? 99 : 96;
      if (col === 'tutoring' || cat === 'tutoring') return 94 + (hasWf ? 2 : coreAcctTopic ? 1 : 0);
      if (col === 'lecture' || cat === 'lecture') return 91 + (hasWf ? 2 : coreAcctTopic ? 1 : 0);
      if (col === 'home') return 88 + (coreAcctTopic ? 2 : 0);
      if (col === 'diagnostics') return 84 + (coreAcctTopic ? 1 : 0);
      if (col === 'reading' || cat === 'reading') return 75 + (coreAcctTopic ? 1 : 0);
      if (col === 'WF-MOCK-D') return 67;
      if (col.startsWith('WF-MOCK-') || cat === 'ai_mock') return 65;
      if (col === 'book-ch1') return 46;
      if (col.startsWith('book-') || cat === 'book') return 54 + (Number(q.difficulty || 1) >= 2 ? 1 : 0);
    } else if (cid === 'prog-3021') {
      if (col === 'exam-2025h-2') return 100;
      if (col === 'exam-2024h-2') return 98;
      if (col === 'official-mock-2') return 96;
      if (col === 'pandas-viz-exam2') return cat === 'past_exam' || cat === 'lecture' ? 94 : 92;
      if (col === 'official-mock') return 89;
      if (col === 'debugging-practice') return 87;
      if (col === 'mock-exam-a' || col === 'mock-exam-b' || cat === 'ai_mock') return 66;
      if (col === 'concept-mcq') return 63;
      if (col.startsWith('foundation-')) return 56;
    } else if (cid === 'math-2588') {
      const tier = Number(q.dlpfcBase || q.difficulty || 2);
      // In EBA 1181, weekly tutoring problem sets (especially Medium-difficulty core problems) are #1 exam priority,
      // followed by Tutoring Hard/Easy + Week 43 tutoring paper, then recent official past exams (EBA11805).
      if (col.startsWith('tut-') || cat === 'tutoring') {
        const coreMathTopic = !['1', '2'].includes(tid);
        if (tier === 2) return coreMathTopic ? 100 : 99;
        if (tier === 3) return coreMathTopic ? 97 : 96;
        return q.kind === 'mcq' ? 92 : 94;
      }
      if (col === 'paper-2022a') return 96; // Official Week 43 Oct 21 tutoring session paper
      const mathExamRanks = {
        'exam-2025h': 95,
        'exam-2024h': 94,
        'exam-2024v': 93,
        'exam-2023h': 93,
        'exam-2023v': 92,
        'exam-2022h': 91,
      };
      if (mathExamRanks[col]) return mathExamRanks[col];
      if (col.startsWith('paper-')) return 89;
      if (col === 'multchoice-2025') return 88;
      if (col.startsWith('mc-')) return 78;
      if (col === 'mock-exam-math-autumn-2026' || cat === 'ai_mock') return 65;
      if (cat === 'ai_synthetic') return 58;
    } else if (cid === 'econ-2522') {
      const econExamRanks = { E26S: 100, E25F: 99, E25S: 97, E24F: 96, E24S: 94, E23F: 93 };
      if (econExamRanks[col]) return Math.min(100, econExamRanks[col] + (q.kind !== 'mcq' ? 1 : 0));
      if (['L16', 'L11', 'L7', 'L4'].includes(col)) return 91 + (q.kind !== 'mcq' ? 1 : 0);
      if (/^T\d/.test(col)) return 89 + (q.kind !== 'mcq' ? 1 : 0);
      if (col === 'OBSID-BANK') return 64;
      if (col === 'SYN-CASE') return 62;
      if (col === 'SYN-SHORT') return 60;
      if (col === 'SYN-MCQ') return 55;
    } else if (cid === 'ob-2537') {
      if (col === 'sample-exam') return 99;
      if (col === 'lesson-8' || col === 'tech-structure') return 92;
      if (col === 'diagnostics') return 91;
      if (col === 'nov19-mock-25') return 68;
      if (col === 'wiseflow-mock-1') return 65;
    }

    // Universal fallback for any other synced / custom course
    if (cat === 'past_exam') return 95;
    if (cat === 'tutoring') return 91;
    if (cat === 'lecture') return 89;
    if (cat === 'exercise') return 85;
    if (cat === 'reading') return 74;
    if (cat === 'ai_mock') return 64;
    if (cat === 'ai_synthetic') return 56;
    if (cat === 'book') return 50;
    return ['synthetic_drill', 'mock_exam'].includes(q.origin) ? 58 : 82;
  }

  function examRelevanceBand(q, bank = null) {
    const score = examRelevanceScore(q, bank);
    const cid = String(q?.courseId || bank?.courseId || '');
    if (cid === 'math-2588') {
      if (score >= 99) return 0; // Top Math Priority: Medium-difficulty weekly tutoring session problems
      if (score >= 96) return 1; // Other weekly tutoring Hard problems & Week 43 tutoring paper
      if (score >= 88) return 2; // Recent official EBA11805 past exams, tutoring warmups & course papers
      if (score >= 70) return 3; // Older midterm MC drills
      return 4;                  // AI mock & synthetic practice
    }
    if (score >= 88) return 0; // Core Exam Priority (Official Exams, Tutoring, Lecture Exercises, Home Assignments)
    if (score >= 70) return 1; // Official Supporting (Diagnostics, Readings, Extra MC Drills)
    if (score >= 52) return 2; // Exam-Calibrated Mocks & Core Textbook
    return 3;                  // Supplementary Drills / Intro
  }

  function buildEffortSortedQueue(questions, budgetMinutes = 75, profile = 'learning', filterTopics = [], effortMode = 'auto', quick = false, exactDifficulty = 0, bank = null) {
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
    const qTier = (q) => effectiveDlpfc(q).tier;

    let pool = (questions || []).filter((q) => {
      if (q.available === false) return false;
      if (getProgressRecord(q.id)?.status === 'done') return false;
      if (topicSet.size && !topicSet.has(String(q.topicId))) return false;
      if (exactDifficulty && qTier(q) !== exactDifficulty) return false;
      return true;
    });

    const qMin = (q) => calibratedParSec(q, profile) / 60;
    if (quick) {
      const short = pool.filter((q) => qMin(q) <= budgetMinutes);
      pool = short.length ? short : pool.sort((a, b) => qMin(a) - qMin(b)).slice(0, 1);
    }

    if (!exactDifficulty && mode === 'high_dlpfc') {
      const highMedUnfinished = pool.filter(
        (q) => qTier(q) >= 2 && (getProgressRecord(q.id)?.status || 'not_started') !== 'done'
      );
      if (highMedUnfinished.length >= 1) {
        pool = pool.filter((q) => qTier(q) >= 2);
      } else {
        const highMedAny = pool.filter((q) => qTier(q) >= 2);
        if (highMedAny.length >= 2) pool = highMedAny;
      }
    } else if (!exactDifficulty && mode === 'low_dlpfc') {
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

    const relBand = (q) => examRelevanceBand(q, bank);
    const relScore = (q) => examRelevanceScore(q, bank);

    pool.sort((a, b) => {
      const ba = bucketRank(a);
      const bb = bucketRank(b);
      if (ba !== bb) return ba - bb;

      // Prioritise unfinished core exam-relevant BI tasks (Official Exams, Tutoring, Lecture Slides, Assignments) first!
      const ra = relBand(a);
      const rb = relBand(b);
      if (ra !== rb) return ra - rb;

      const ta = tierRank(a);
      const tb = tierRank(b);
      if (ta !== tb) return ta - tb;

      const sa = relScore(a);
      const sb = relScore(b);
      if (sa !== sb) return sb - sa;

      if (mode === 'high_dlpfc') {
        const qa = qMin(a);
        const qb = qMin(b);
        if (Math.abs(qb - qa) > 0.2) return qb - qa;
      } else if (mode === 'low_dlpfc') {
        return qMin(a) - qMin(b);
      }

      return effectiveDifficulty(b) - effectiveDifficulty(a);
    });

    // Interleave distinct topics within each (statusBucket, relevanceBand, dlpfcTier) band so core exam tasks always lead
    pool = interleaveByTopic(pool, (q) => `${bucketRank(q)}:${relBand(q)}:${tierRank(q)}`);

    const maxItems = Math.max(30, Math.min(80, Math.round(budgetMinutes * 1.1)));
    const chosen = [];
    let accMin = 0;
    for (const q of pool) {
      const qm = qMin(q);
      if (chosen.length && (accMin + qm > budgetMinutes * 1.25 || chosen.length >= maxItems)) {
        if (chosen.length >= (accMin >= budgetMinutes * 0.7 ? 1 : 2)) break;
        continue;
      }
      chosen.push(q.id);
      accMin += qm;
      if (accMin >= budgetMinutes * 0.94) break;
    }
    if (!chosen.length && pool.length) chosen.push(pool[0].id);
    return chosen;
  }

  async function launchCalendarBlock(block) {
    const meta = describeScheduledBlock(block);
    const courseId = meta.course?.courseId || block.courseId;
    if (!courseId) {
      toast('This block is not linked to a course yet.');
      return;
    }
    let bank;
    try {
      bank = await ensureCourseBank(courseId);
    } catch {
      toast('Could not load this course bank. Check your connection and try again.');
      return;
    }
    const cMeta = meta.course || boot.catalog.find((c) => c.courseId === courseId);
    const prof = block.recommendedProfile || 'learning';
    const blockDlpfcMode = sessionFocusMode !== 'auto' ? getResolvedFocusMode() : meta.dlpfc.mode;
    const topicIds = meta.topicIds?.length ? meta.topicIds : (block.topicIds || []);
    const hydratedQids = (hydratedBlockCache.get(block.eventId)?.questionIds || []).filter((id) => getProgressRecord(id)?.status !== 'done');
    let qids = (block.autoQueue?.questionIds || []).filter((id) => getProgressRecord(id)?.status !== 'done');
    if (!qids.length && sessionFocusMode === 'auto' && hydratedQids.length) {
      qids = hydratedQids;
    }
    if (sessionFocusMode !== 'auto' || !qids.length) {
      qids = buildEffortSortedQueue(
        bank.questions || [],
        Number(block.attemptBudgetMinutes || block.focusMinutes || homeBlockMinutes || 50),
        prof,
        topicIds,
        blockDlpfcMode,
        false,
        0,
        bank
      );
    }
    if (!qids.length) {
      // Fallback: review completed questions from that topic/course rather than failing silently
      const fallback = (bank.questions || []).filter((q) => q.available !== false);
      qids = fallback.slice(0, 8).map((q) => q.id);
    }
    if (!qids.length) {
      toast('No practice questions available in this course.');
      return;
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

  async function launchSmartCourseRun(courseId, budgetMinutes = 75, profile = 'learning', filterTopic = '', effortMode = 'auto', quick = false, exactDifficulty = 0) {
    if (isCourseInMaintenanceForUser(courseId)) {
      const m = getCourseMaintenance(courseId);
      toast(`${m?.badge || 'Under maintenance'} — ${m?.eta || 'reworking soon'}.`);
      return;
    }
    const bank = await ensureCourseBank(courseId);
    const cMeta = boot.catalog.find((c) => c.courseId === courseId);
    const chosen = buildEffortSortedQueue(
      bank.questions || [],
      budgetMinutes,
      profile,
      filterTopic ? [filterTopic] : [],
      quick ? 'med_dlpfc' : effortMode,
      quick,
      exactDifficulty,
      bank
    );
    if (!chosen.length) {
      const diffLbl = exactDifficulty === 1 ? 'Easy' : exactDifficulty === 2 ? 'Medium' : exactDifficulty === 3 ? 'Hard' : '';
      toast(diffLbl
        ? `No unfinished ${diffLbl} questions left in ${cMeta?.code || 'this course'}. Switch to All or open Topics.`
        : 'No unfinished questions here. Open Topics & practice to review completed questions.');
      return;
    }

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
  async function renderCourseExplorer(courseId, initialPreset = '', initialFilters = null) {
    const root = document.getElementById('course-explorer-root');
    if (!courseId && boot.catalog.length) courseId = boot.catalog[0].courseId;
    selectedCourseId = courseId;
    if (!courseId) {
      root.innerHTML = '<div class="panel"><p>No course banks loaded yet.</p></div>';
      return;
    }

    const maint = getCourseMaintenance(courseId);
    if (maint && !canBypassCourseMaintenance()) {
      const cMeta = boot.catalog.find((c) => c.courseId === courseId) || { courseId, code: 'EBA 3400', title: 'Programming, Data Extraction and Visualisation', color: '#2563eb' };
      document.title = `${cMeta.code ? `${cMeta.code} ` : ''}${cMeta.title} (Under Maintenance) · Study-OS`;
      const coursePillsHtml = boot.catalog
        .map((c) => {
          const active = c.courseId === courseId;
          const m = isCourseInMaintenanceForUser(c.courseId);
          return `<button type="button" class="exp-course-pill ${active ? 'active' : ''} ${m ? 'exp-course-pill-maintenance' : ''}" data-pick-course="${esc(c.courseId)}" role="tab" aria-selected="${active}" style="--pill-accent:${esc(c.color)}">
            <span class="exp-course-dot" aria-hidden="true"></span>
            <strong>${esc(c.code)}</strong>
            <span class="exp-course-pill-name">${esc(c.shortTitle || c.title)}</span>
            <small>${m ? 'Maint.' : Number(c.questionCount || 0)}</small>
          </button>`;
        })
        .join('');
      const otherCourses = boot.catalog.filter((c) => !isCourseInMaintenanceForUser(c.courseId));
      root.innerHTML = `
        <div class="panel">
          <div class="row-between" style="margin-top:0;align-items:flex-start;gap:10px">
            <div>
              <span class="eyebrow">Courses · Click a subject to switch</span>
              <h2 style="margin:2px 0 0;font-size:19px">${esc(cMeta.code || '')} · ${esc(cMeta.title || '')}</h2>
            </div>
            <div class="row-actions" style="flex-shrink:0">
              <span class="badge maintenance">${esc(maint.badge)}</span>
              <button type="button" class="ghost-btn" id="exp-open-ref">Course Notes</button>
            </div>
          </div>
          <div class="exp-course-pills" role="tablist" aria-label="Choose course">${coursePillsHtml}</div>

          <div class="maintenance-notice-box">
            <span class="badge maintenance">${esc(maint.badge)} · ${esc(maint.eta)}</span>
            <h3 style="margin:10px 0 6px">${esc(cMeta.code || '')} is being reworked for December</h3>
            <p class="muted" style="max-width:56ch;margin:0 auto 14px">${esc(maint.detail)}</p>
            <div class="row-actions" style="justify-content:center;flex-wrap:wrap;gap:8px">
              ${otherCourses.map((oc) => `<button type="button" class="ghost-btn" data-pick-course="${esc(oc.courseId)}">${esc(oc.code)} ${esc(oc.shortTitle || oc.title)} →</button>`).join('')}
            </div>
          </div>
        </div>
      `;
      root.querySelectorAll('[data-pick-course]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const nextId = btn.dataset.pickCourse;
          if (nextId && nextId !== courseId) {
            window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
            renderCourseExplorer(nextId, '');
          }
        });
      });
      root.querySelector('#exp-open-ref')?.addEventListener('click', () => openReferenceDrawer(cMeta));
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
    if (cMeta?.code || cMeta?.title) {
      document.title = `${cMeta.code ? `${cMeta.code} ` : ''}${cMeta.title || bank.title || 'Courses'} · Study-OS`;
    }
    const localCanvasId = String(cMeta.canvasId || bank.canvasId || '');
    const localCourse = !isStaticWeb && boot.canvasArchive?.courses?.some((item) => String(item.canvasId) === localCanvasId);
    const localFiles = localCourse
      ? await apiGet(`/api/canvas/documents?course=${encodeURIComponent(localCanvasId)}`)
        .then((result) => result.files || []).catch(() => [])
      : [];
    if (selectedCourseId !== courseId || currentView !== 'course') return;
    const localLibrary = localCourse ? `<details class="curriculum" id="course-local-documents">
      <summary>Course files on this device (${localFiles.length})</summary>
      ${boot.canvasArchive.hasResyncApp ? '<button type="button" class="ghost-btn" id="exp-add-canvas-files">Add books or PDFs</button>' : ''}
      ${localFiles.length ? `
        <label class="field-label">Find a local file <input type="search" id="exp-find-local-file"></label>
        <ul>${localFiles.map((file, index) => {
          const url = `/api/canvas-file?path=${encodeURIComponent(file.path)}`;
          return `<li>${file.kind === 'pdf'
            ? `<button type="button" class="member-file" data-local-pdf="${index}">${esc(file.name)}</button>`
            : `<a href="${esc(url)}" download>${esc(file.name)}</a>`}</li>`;
        }).join('')}</ul>` : ''}
    </details>` : '';
    const defaultSort = 'exam_relevance';
    const documents = members.course(courseId)?.documents || [];
    const documentSections = new Map();
    for (const doc of documents) {
      if (!documentSections.has(doc.section)) documentSections.set(doc.section, []);
      documentSections.get(doc.section).push(doc);
    }
    const canEditPdf = Boolean(window.StudyPdfCraft?.isAvailable?.());
    const library = [...documentSections].map(([section, files]) => `
      <details class="course-document-group">
        <summary>${esc(section)} (${files.length})</summary>
        <ul>${files.map((doc) => `<li class="row-between" style="gap:8px"><button type="button" class="member-file"
          data-member-download="${esc(doc.id)}" data-member-mime="${esc(doc.mime)}" data-filename="${esc(doc.title)}">
          ${esc(doc.title)}</button>${canEditPdf && doc.mime === 'application/pdf' ? `<button type="button" class="ghost-btn pdf-row-edit-btn" data-member-pdfcraft="${esc(doc.id)}" data-member-pdfcraft-name="${esc(doc.title)}" title="Edit, highlight, annotate, or OCR in PdfCraft">Edit</button>` : ''}</li>`).join('')}</ul>
      </details>`).join('');

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

    const coursePillsHtml = boot.catalog
      .map((c) => {
        const active = c.courseId === courseId;
        const mLocked = isCourseInMaintenanceForUser(c.courseId);
        const mMeta = getCourseMaintenance(c.courseId);
        return `<button type="button" class="exp-course-pill ${active ? 'active' : ''} ${mLocked ? 'exp-course-pill-maintenance' : ''}" data-pick-course="${esc(c.courseId)}" role="tab" aria-selected="${active}" style="--pill-accent:${esc(c.color)}"${mMeta ? ` title="${esc(mMeta.badge)} · ${esc(mMeta.eta)}"` : ''}>
          <span class="exp-course-dot" aria-hidden="true"></span>
          <strong>${esc(c.code)}</strong>
          <span class="exp-course-pill-name">${esc(c.shortTitle || c.title)}</span>
          <small>${mLocked ? 'Maint.' : Number(c.questionCount || 0)}</small>
        </button>`;
      })
      .join('');

    const adminMaintBanner = maint && canBypassCourseMaintenance()
      ? `<div class="admin-maintenance-banner">
           <span class="badge maintenance">Under maintenance for students</span>
           <span>Marked as <strong>${esc(maint.eta)}</strong> for classmates — unlocked with full access for your Admin account.</span>
         </div>`
      : '';

    const hasBookItems = (bank.questions || []).some((q) => (q.provenance?.category || q.origin) === 'book' || q.origin === 'textbook');

    root.innerHTML = `
      <div class="panel">
        <div class="row-between" style="margin-top:0;align-items:flex-start;gap:10px">
          <div>
            <span class="eyebrow">Courses · Click a subject to switch</span>
            <h2 style="margin:2px 0 0;font-size:19px">${esc(cMeta.code || '')} · ${esc(cMeta.title || bank.title || '')}</h2>
          </div>
          <div class="row-actions" style="flex-shrink:0">
            <button type="button" class="ghost-btn" id="exp-open-exams">Mock Exams</button>
            <button type="button" class="ghost-btn" id="exp-open-ref">Reference</button>
            ${cMeta.obsidianUri ? `<a class="ghost-btn" href="${esc(cMeta.obsidianUri)}">Obsidian ↗</a>` : ''}
          </div>
        </div>
        <div class="exp-course-pills" role="tablist" aria-label="Choose course">${coursePillsHtml}</div>
        ${adminMaintBanner}

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
        ${isStaticWeb ? (() => {
          const browserFiles = window.StudyLocalSources?.list?.(courseId) || [];
          const hasBookSources = Object.values(bank.sources || {}).some((s) => s?.kind === 'book');
          const syncNow = getBiSyncStatus().hasEverSynced;
          return `<details class="curriculum" id="course-browser-vault">
            <summary>Your local books &amp; BI PDFs in this browser (${browserFiles.length})</summary>
            <p class="muted" style="font-size:13px;margin:6px 0 10px">
              Drop your own ${hasBookSources ? 'textbook PDF (e.g. Atrill &amp; McLaney 12th ed.) or ' : ''}downloaded BI Canvas PDFs here to unlock side-by-side page reading across exercises. Files stay <strong>100% private in this browser</strong> (never uploaded).
            </p>
            <div class="row-actions" style="gap:8px;margin-bottom:10px;flex-wrap:wrap">
              <label class="primary-btn source-gate-upload-btn" style="padding:7px 13px;font-size:13px">
                + Add PDFs / Textbook to Browser
                <input type="file" id="exp-browser-pdf-input" accept=".pdf,application/pdf" multiple hidden>
              </label>
              ${!syncNow ? '<button type="button" class="ghost-btn" id="exp-open-bi-sync">Sync BI Canvas →</button>' : '<span class="badge good">BI Canvas Connected</span>'}
            </div>
            ${browserFiles.length ? `<ul>${browserFiles.map((f) => `<li class="row-between" style="gap:8px">
              <button type="button" class="member-file" data-browser-pdf-key="${esc(f.key)}" data-browser-pdf-title="${esc(f.title || f.filename)}">${esc(f.filename)} <small class="muted">(${esc(window.StudyLocalSources.formatBytes(f.size))})</small></button>
              <span class="row-actions" style="gap:4px;flex-shrink:0">
                ${canEditPdf ? `<button type="button" class="ghost-btn pdf-row-edit-btn" data-browser-pdf-edit="${esc(f.key)}" data-browser-pdf-title="${esc(f.title || f.filename)}" title="Edit in PdfCraft">Edit</button>` : ''}
                <button type="button" class="ghost-btn" style="padding:2px 8px;font-size:11.5px" data-browser-pdf-del="${esc(f.key)}">Remove</button>
              </span>
            </li>`).join('')}</ul>` : '<p class="muted" style="font-size:12.5px;margin:4px 0 0">No local PDFs attached to this course yet.</p>'}
          </details>`;
        })() : ''}
        ${localLibrary}

        <div class="preset-chips-bar exp-composable-filters" role="group" aria-label="Composable source and difficulty filters">
          <div class="exp-filter-row">
            <small class="muted" style="font-weight:700;margin-right:2px">SOURCE:</small>
            <button type="button" class="preset-chip exp-real-chip" id="chip-real-only" aria-pressed="false" title="Hide all Al mocks &amp; synthetic drills — show only authentic BI course tasks">Real BI Tasks Only</button>
            <button type="button" class="preset-chip" data-chip-origin="past_exam" aria-pressed="false">Past Exams</button>
            <button type="button" class="preset-chip" data-chip-origin="exercise_tutoring" aria-pressed="false">Exercises &amp; Tutoring</button>
            ${hasBookItems ? '<button type="button" class="preset-chip" data-chip-origin="book" aria-pressed="false">Book Exercises</button>' : ''}
            <button type="button" class="preset-chip" data-chip-origin="ai_only" aria-pressed="false">Al Practice</button>
          </div>
          <div class="exp-filter-row">
            <small class="muted" style="font-weight:700;margin-right:2px">DLPFC:</small>
            <button type="button" class="preset-chip" data-chip-diff="3" data-layout-tier="3" aria-pressed="false">${window.StudyLayout.label(3)}</button>
            <button type="button" class="preset-chip" data-chip-diff="2" data-layout-tier="2" aria-pressed="false">${window.StudyLayout.label(2)}</button>
            <button type="button" class="preset-chip" data-chip-diff="1" data-layout-tier="1" aria-pressed="false">${window.StudyLayout.label(1)}</button>
            <button type="button" class="preset-chip" data-chip-horizon="10plus" aria-pressed="false">10m+ Horizon</button>
            ${cMeta.flowmultiCount ? '<button type="button" class="preset-chip" data-chip-kind="wiseflow" aria-pressed="false">Worksheets</button>' : ''}
            <button type="button" class="preset-chip" id="chip-reset-filters">Reset</button>
            <button type="button" class="preset-chip exp-share-chip" id="chip-share-filters" title="Copy a direct link with all active filters applied">Share Link</button>
          </div>
        </div>

        <div class="explorer-primary-bar" style="margin-top:12px">
          <input type="search" id="flt-search" placeholder="Search concepts, formulas, question IDs…" style="min-width:190px;flex:1.2">
          <select id="flt-origin" aria-label="Source provenance" style="min-width:165px">
            <option value="all">All Sources (Official First)</option>
            <option value="official_only">Real BI Tasks Only (No Al)</option>
            <option value="past_exam">Past Exams Only</option>
            <option value="exercise_tutoring">BI Exercises &amp; Tutoring</option>
            <option value="tutoring">Tutoring Sessions Only</option>
            <option value="lecture_reading">Lectures &amp; Readings</option>
            <option value="book">Book Exercises (BYOB)</option>
            <option value="ai_only">Al Mocks &amp; Synthetics</option>
          </select>
          <select id="flt-topic" aria-label="Topic or chapter" style="min-width:160px;flex:1">${topicOptions}</select>
          <select id="flt-status" aria-label="Completion status" style="min-width:145px">
            <option value="unfinished">Unfinished (Todo + Revisit)</option>
            <option value="all">All Statuses</option>
            <option value="not_started">Uncomplete (Not started)</option>
            <option value="in_progress">In Progress</option>
            <option value="revisit">Revisit / Mistakes</option>
            <option value="due_fsrs">Due FSRS Review</option>
            <option value="done">Done</option>
          </select>
          <button type="button" class="primary-btn" id="btn-start-filtered">Start Selected Run →</button>
        </div>

        <div class="row-between" style="margin:8px 0 0">
          <span id="flt-summary-lbl" class="muted" style="font-size:13px"></span>
        </div>

        <details class="explorer-advanced-filters">
          <summary>More filters, run size &amp; bulk actions</summary>
          <div class="filter-grid" style="margin-top:12px">
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
            <label class="field-label">Sort Tasks By
              <select id="flt-sort">
                <option value="exam_relevance" ${defaultSort === 'exam_relevance' ? 'selected' : ''}>Exam Relevance (BI Exam · Tutoring · Slides)</option>
                <option value="deep_first" ${defaultSort === 'deep_first' ? 'selected' : ''}>Hard First (Interleaved)</option>
                <option value="horizon_desc">Longest Horizon First (Al Par ↓)</option>
                <option value="diff_desc">Difficulty: hard first</option>
                <option value="smart_priority" ${defaultSort === 'smart_priority' ? 'selected' : ''}>Smart Priority (Revisit → Due → Todo)</option>
                <option value="horizon_asc">Quickest First (Al Par ↑)</option>
                <option value="bank_order">Original Paper / Bank Order</option>
              </select>
            </label>
            <label class="field-label">Run Mode &amp; Size
              <select id="flt-budget">
                <option value="budget:25">25 min Focus Block (Al Par)</option>
                <option value="budget:50" selected>50 min Study Block (Al Par)</option>
                <option value="budget:75">75 min Deep Block (Al Par)</option>
                <option value="count:12">Top 12 Matching Tasks</option>
                <option value="all">All Matching (Full Set)</option>
                <option value="exam_sim">Blind Exam Sit (Countdown + Submit)</option>
              </select>
            </label>
            <label class="field-label">Al Pace Benchmark
              <select id="flt-profile">
                <option value="learning">Learning Par</option>
                <option value="exam">Exam Mastery Par</option>
              </select>
            </label>
          </div>
          <div class="row-between" style="margin:10px 0 0">
            <label style="font-size:13px;display:inline-flex;align-items:center;gap:6px">
              <input type="checkbox" id="flt-shuffle"> Shuffle question order
            </label>
            <div class="row-actions">
              <button type="button" class="ghost-btn" id="btn-bulk-uncomplete">Mark Matching Uncomplete</button>
              <button type="button" class="ghost-btn" id="btn-bulk-revisit">Mark Matching Revisit</button>
            </div>
          </div>
        </details>
      </div>

      <div class="panel">
        <div class="row-between" style="margin-top:0">
          <div>
            <h3>Exercises</h3>
            <small class="muted">Click any column header to sort (↑ → ↓ → default), or click Practice to launch.</small>
          </div>
        </div>
        <div class="task-table-wrap">
          <table class="task-table">
            <thead>
              <tr>
                <th aria-sort="none"><button type="button" class="th-sort-btn" data-sort-col="question">Question <span class="th-sort-ind" aria-hidden="true">⇅</span></button></th>
                <th aria-sort="none"><button type="button" class="th-sort-btn" data-sort-col="topic">Topic <span class="th-sort-ind" aria-hidden="true">⇅</span></button></th>
                <th aria-sort="none"><button type="button" class="th-sort-btn" data-sort-col="difficulty">Difficulty <span class="th-sort-ind" aria-hidden="true">⇅</span></button></th>
                <th aria-sort="none"><button type="button" class="th-sort-btn" data-sort-col="format">Format <span class="th-sort-ind" aria-hidden="true">⇅</span></button></th>
                <th aria-sort="none"><button type="button" class="th-sort-btn" data-sort-col="horizon">Horizon (Learn / Exam) <span class="th-sort-ind" aria-hidden="true">⇅</span></button></th>
                <th aria-sort="none"><button type="button" class="th-sort-btn" data-sort-col="best">Your Best <span class="th-sort-ind" aria-hidden="true">⇅</span></button></th>
                <th aria-sort="none"><button type="button" class="th-sort-btn" data-sort-col="status">Status <span class="th-sort-ind" aria-hidden="true">⇅</span></button></th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="exp-table-body"></tbody>
          </table>
        </div>
      </div>
    `;

    // Composable filter + 3-state column header sort state
    let realTasksOnly = false;
    let colSort = { col: null, dir: null };
    const COL_FIRST_DIR = {
      question: 'asc',
      topic: 'asc',
      difficulty: 'desc',
      format: 'asc',
      horizon: 'desc',
      best: 'asc',
      status: 'asc',
    };

    const syncFilterChipUi = () => {
      const oVal = document.getElementById('flt-origin')?.value || 'all';
      const dVal = document.getElementById('flt-diff')?.value || 'all';
      const hVal = document.getElementById('flt-horizon')?.value || 'all';
      const kVal = document.getElementById('flt-kind')?.value || 'all';

      const realChip = document.getElementById('chip-real-only');
      if (realChip) {
        const isRealActive = realTasksOnly || oVal === 'official_only';
        realChip.classList.toggle('active', isRealActive);
        realChip.setAttribute('aria-pressed', String(isRealActive));
      }
      root.querySelectorAll('[data-chip-origin]').forEach((chip) => {
        const on = oVal === chip.dataset.chipOrigin;
        chip.classList.toggle('active', on);
        chip.setAttribute('aria-pressed', String(on));
      });
      root.querySelectorAll('[data-chip-diff]').forEach((chip) => {
        const on = dVal === chip.dataset.chipDiff;
        chip.classList.toggle('active', on);
        chip.setAttribute('aria-pressed', String(on));
      });
      root.querySelectorAll('[data-chip-horizon]').forEach((chip) => {
        const on = hVal === chip.dataset.chipHorizon;
        chip.classList.toggle('active', on);
        chip.setAttribute('aria-pressed', String(on));
      });
      root.querySelectorAll('[data-chip-kind]').forEach((chip) => {
        const on = kVal === chip.dataset.chipKind;
        chip.classList.toggle('active', on);
        chip.setAttribute('aria-pressed', String(on));
      });
      root.querySelectorAll('.th-sort-btn').forEach((btn) => {
        const isCol = colSort.col === btn.dataset.sortCol && Boolean(colSort.dir);
        btn.classList.toggle('active', isCol);
        const ind = btn.querySelector('.th-sort-ind');
        if (ind) ind.textContent = !isCol ? '⇅' : colSort.dir === 'asc' ? '↑' : '↓';
        btn.closest('th')?.setAttribute('aria-sort', !isCol ? 'none' : colSort.dir === 'asc' ? 'ascending' : 'descending');
      });
    };

    const applyPreset = (rawPreset) => {
      const presetName = rawPreset === 'pre15_deep' ? 'high_dlpfc' : rawPreset === 'post15_mcq' ? 'low_dlpfc' : rawPreset;
      const oEl = document.getElementById('flt-origin');
      const kEl = document.getElementById('flt-kind');
      const dEl = document.getElementById('flt-diff');
      const hEl = document.getElementById('flt-horizon');
      const sEl = document.getElementById('flt-status');
      const sortEl = document.getElementById('flt-sort');
      const bEl = document.getElementById('flt-budget');

      if (presetName === 'official_only') {
        realTasksOnly = true;
        oEl.value = 'official_only';
      } else if (presetName === 'past_exams') {
        oEl.value = 'past_exam';
        sEl.value = 'all';
      } else if (presetName === 'course_work') {
        oEl.value = 'exercise_tutoring';
      } else if (presetName === 'book_only') {
        oEl.value = 'book';
      } else if (presetName === 'ai_only') {
        realTasksOnly = false;
        oEl.value = 'ai_only';
      } else if (presetName === 'high_dlpfc' || presetName === 'hard_only') {
        dEl.value = '3';
        sortEl.value = 'deep_first';
        bEl.value = 'budget:50';
      } else if (presetName === 'med_dlpfc') {
        dEl.value = '2';
        sortEl.value = 'smart_priority';
        bEl.value = 'budget:50';
      } else if (presetName === 'low_dlpfc') {
        dEl.value = '1';
        sortEl.value = 'horizon_asc';
        bEl.value = 'budget:50';
      } else if (presetName === 'long_horizon') {
        kEl.value = 'no_mcq';
        hEl.value = '10plus';
        sortEl.value = 'horizon_desc';
        bEl.value = 'budget:75';
      } else if (presetName === 'wiseflow_only') {
        kEl.value = 'wiseflow';
        sortEl.value = 'horizon_desc';
      } else {
        realTasksOnly = false;
        colSort = { col: null, dir: null };
        oEl.value = 'all';
        document.getElementById('flt-topic').value = 'all';
        document.getElementById('flt-coll').value = 'all';
        kEl.value = 'all';
        dEl.value = 'all';
        hEl.value = 'all';
        sEl.value = 'unfinished';
        sortEl.value = defaultSort;
        document.getElementById('flt-search').value = '';
      }
      syncFilterChipUi();
    };

    const getMatching = () => {
      const oVal = document.getElementById('flt-origin')?.value || 'all';
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

      const qLearnMin = (q) => calibratedParSec(q, 'learning') / 60;
      const qActiveMin = (q) => calibratedParSec(q, prof) / 60;

      let filtered = (bank.questions || []).filter((q) => {
        if (q.available === false) return false;
        const prov = window.StudyProvenance?.describe?.(q, bank);
        if (realTasksOnly && prov?.synthetic) return false;
        if (oVal === 'official_only') {
          if (prov?.synthetic) return false;
        } else if (oVal === 'past_exam') {
          if (prov?.category !== 'past_exam') return false;
        } else if (oVal === 'exercise_tutoring') {
          if (!['exercise', 'tutoring'].includes(prov?.category)) return false;
        } else if (oVal === 'tutoring') {
          if (prov?.category !== 'tutoring') return false;
        } else if (oVal === 'lecture_reading') {
          if (!['lecture', 'reading'].includes(prov?.category)) return false;
        } else if (oVal === 'book') {
          if (prov?.category !== 'book') return false;
        } else if (oVal === 'ai_only') {
          if (!prov?.synthetic) return false;
        }
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

      const provOrder = (q) => window.StudyProvenance?.describe?.(q, bank)?.priorityRank ?? 3;
      const topicNum = (q) => {
        const m = String(q.topicId ?? '').match(/\d+/);
        return m ? Number(m[0]) : 999;
      };
      const formatKey = (q) => (Array.isArray(q.wiseflowFields) && q.wiseflowFields.length ? 'worksheet' : String(q.kind || ''));
      const statusRank = (q) => {
        const st = getProgressRecord(q.id)?.status || 'not_started';
        return st === 'revisit' ? 0 : st === 'in_progress' ? 1 : st === 'not_started' ? 2 : 3;
      };

      if (colSort.col && colSort.dir) {
        const mult = colSort.dir === 'asc' ? 1 : -1;
        filtered.sort((a, b) => {
          let cmp = 0;
          if (colSort.col === 'question') {
            cmp = String(a.title || a.id || '').localeCompare(String(b.title || b.id || ''), undefined, { numeric: true, sensitivity: 'base' });
          } else if (colSort.col === 'topic') {
            cmp = topicNum(a) - topicNum(b) || String(a.topicId || '').localeCompare(String(b.topicId || ''), undefined, { numeric: true });
          } else if (colSort.col === 'difficulty') {
            cmp = effectiveDlpfc(a, getProgressRecord(a.id)).tier - effectiveDlpfc(b, getProgressRecord(b.id)).tier;
          } else if (colSort.col === 'format') {
            cmp = formatKey(a).localeCompare(formatKey(b));
          } else if (colSort.col === 'horizon') {
            cmp = qActiveMin(a) - qActiveMin(b);
          } else if (colSort.col === 'best') {
            const pa = getProgressRecord(a.id)?.pbEffectiveSec;
            const pb = getProgressRecord(b.id)?.pbEffectiveSec;
            if (pa == null && pb == null) cmp = 0;
            else if (pa == null) return 1; // unattempted always stays at bottom
            else if (pb == null) return -1;
            else cmp = Number(pa) - Number(pb);
          } else if (colSort.col === 'status') {
            cmp = statusRank(a) - statusRank(b);
          }
          if (cmp !== 0) return cmp * mult;
          return provOrder(a) - provOrder(b) || String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true });
        });
      } else if (sortVal === 'exam_relevance') {
        filtered.sort((a, b) => {
          const doneA = (getProgressRecord(a.id)?.status || 'not_started') === 'done' ? 1 : 0;
          const doneB = (getProgressRecord(b.id)?.status || 'not_started') === 'done' ? 1 : 0;
          if (doneA !== doneB) return doneA - doneB;

          const ba = examRelevanceBand(a, bank);
          const bb = examRelevanceBand(b, bank);
          if (ba !== bb) return ba - bb;

          // Keep revisited/missed exam tasks near the top of their relevance band
          const revA = (getProgressRecord(a.id)?.status || '') === 'revisit' ? 0 : 1;
          const revB = (getProgressRecord(b.id)?.status || '') === 'revisit' ? 0 : 1;
          if (revA !== revB) return revA - revB;

          const sa = examRelevanceScore(a, bank);
          const sb = examRelevanceScore(b, bank);
          if (sa !== sb) return sb - sa;

          const da = effectiveDlpfc(a).tier;
          const db = effectiveDlpfc(b).tier;
          if (da !== db) return db - da;

          return qActiveMin(b) - qActiveMin(a);
        });
        if (tVal === 'all' && cVal === 'all') {
          filtered = interleaveByTopic(filtered, (q) => {
            const done = (getProgressRecord(q.id)?.status || 'not_started') === 'done' ? 1 : 0;
            const sc = examRelevanceScore(q, bank);
            const tier = sc >= 99 ? 50 : Math.floor(sc / 3);
            return `${done}:${examRelevanceBand(q, bank)}:${tier}`;
          });
        }
      } else if (sortVal === 'deep_first') {
        filtered.sort((a, b) => {
          const da = effectiveDlpfc(a).tier;
          const db = effectiveDlpfc(b).tier;
          if (da !== db) return db - da;
          const ba = smartBucket(a);
          const bb = smartBucket(b);
          if (ba !== bb) return ba - bb;
          const pa = provOrder(a) >= 4 ? 1 : 0;
          const pb = provOrder(b) >= 4 ? 1 : 0;
          if (pa !== pb) return pa - pb;
          return qActiveMin(b) - qActiveMin(a);
        });
        if (tVal === 'all') {
          filtered = interleaveByTopic(filtered, (q) => `${effectiveDlpfc(q).tier}:${smartBucket(q)}:${provOrder(q) >= 4 ? 1 : 0}`);
        }
      } else if (sortVal === 'horizon_desc') {
        filtered.sort((a, b) => qActiveMin(b) - qActiveMin(a) || effectiveDlpfc(b).tier - effectiveDlpfc(a).tier);
      } else if (sortVal === 'diff_desc') {
        filtered.sort((a, b) => effectiveDlpfc(b).tier - effectiveDlpfc(a).tier || qActiveMin(b) - qActiveMin(a));
      } else if (sortVal === 'smart_priority') {
        filtered.sort((a, b) => smartBucket(a) - smartBucket(b) || (provOrder(a) >= 4 ? 1 : 0) - (provOrder(b) >= 4 ? 1 : 0) || effectiveDlpfc(b).tier - effectiveDlpfc(a).tier);
        if (tVal === 'all') {
          filtered = interleaveByTopic(filtered, (q) => `${smartBucket(q)}:${provOrder(q) >= 4 ? 1 : 0}:${effectiveDlpfc(q).tier}`);
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
          const m = calibratedParSec(q, prof) / 60;
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
      const estMin = list.reduce((s, q) => s + calibratedParSec(q, prof) / 60, 0);
      const isExamSim = spec === 'exam_sim';
      return {
        list,
        estMin,
        mode: isExamSim ? 'exam' : 'practice',
        examStyle: isExamSim ? 'blind' : 'guided',
        prof: isExamSim ? 'exam' : prof,
      };
    };

    const COURSE_SEO_SLUGS = {
      'acct-2527': 'exc3430-accounting',
      'econ-2522': 'exc3420-economics',
      'math-2588': 'eba1181-mathematics',
      'ob-2537': 'exc3460-leadership',
      'prog-3021': 'eba3400-programming',
    };
    const buildShareableCoursePath = ({ includeDefaultSort = false } = {}) => {
      const sp = new URLSearchParams();
      sp.set('course', COURSE_SEO_SLUGS[courseId] || courseId);
      const oVal = document.getElementById('flt-origin')?.value || 'all';
      const effectiveOrigin = realTasksOnly && oVal === 'all' ? 'official_only' : oVal;
      if (effectiveOrigin !== 'all') sp.set('origin', effectiveOrigin);
      const tVal = document.getElementById('flt-topic')?.value || 'all';
      if (tVal !== 'all') sp.set('topic', tVal);
      const cVal = document.getElementById('flt-coll')?.value || 'all';
      if (cVal !== 'all') sp.set('coll', cVal);
      const kVal = document.getElementById('flt-kind')?.value || 'all';
      if (kVal !== 'all') sp.set('kind', kVal);
      const dVal = document.getElementById('flt-diff')?.value || 'all';
      if (dVal !== 'all') sp.set('diff', dVal);
      const hVal = document.getElementById('flt-horizon')?.value || 'all';
      if (hVal !== 'all') sp.set('horizon', hVal);
      const sVal = document.getElementById('flt-status')?.value || 'unfinished';
      if (sVal !== 'unfinished') sp.set('status', sVal);
      const sortVal = document.getElementById('flt-sort')?.value || defaultSort;
      if (includeDefaultSort || sortVal !== defaultSort) sp.set('sort', sortVal);
      const bVal = document.getElementById('flt-budget')?.value || 'budget:50';
      if (bVal !== 'budget:50') sp.set('budget', bVal);
      const pVal = document.getElementById('flt-profile')?.value || 'learning';
      if (pVal !== 'learning') sp.set('profile', pVal);
      const qTerm = (document.getElementById('flt-search')?.value || '').trim();
      if (qTerm) sp.set('q', qTerm);
      return `${window.location.pathname}?${sp.toString()}`;
    };

    const syncCourseFilterUrl = () => {
      if (currentView !== 'course' || selectedCourseId !== courseId) return;
      try {
        window.history.replaceState({}, '', buildShareableCoursePath({ includeDefaultSort: false }));
      } catch {}
    };

    const refreshTable = () => {
      const matches = getMatching();
      const { list, estMin } = buildRunIds(matches);
      document.getElementById('flt-summary-lbl').textContent = `${list.length} in run (of ${matches.length} matching) · ~${Math.round(estMin)}m Al Par`;
      syncCourseFilterUrl();

      const tbody = document.getElementById('exp-table-body');
      tbody.innerHTML = matches
        .slice(0, 500)
        .map((q) => {
          const rec = getProgressRecord(q.id);
          const st = rec?.status || 'not_started';
          const lp = clockSec(calibratedParSec(q, 'learning'));
          const ep = clockSec(calibratedParSec(q, 'exam'));
          const pb = rec?.pbEffectiveSec ? `${clockSec(rec.pbEffectiveSec)}${rec.beatAiCount ? ' · Par' : ''}` : '—';
          const hasWf = Array.isArray(q.wiseflowFields) && q.wiseflowFields.length > 0;
          const kindBadge = hasWf
            ? `<span class="badge live" style="font-size:11px">Worksheet</span>`
            : `<small>${esc(q.kind)}</small>`;
          const dlpfc = effectiveDlpfc(q, rec);
          const diffBadge = `<span class="diff-badge diff-${dlpfc.tier}" data-layout-tier="${dlpfc.tier}"${dlpfc.chunked
            ? ' title="Previously mastered problem with fewer new steps"' : ''}>${window.StudyLayout.label(dlpfc.tier)}</span>`;
          const provPill = window.StudyProvenance
            ? window.StudyProvenance.badgeHtml(q, bank, { showModel: true, short: true })
            : '';
          const relScore = examRelevanceScore(q, bank);
          const priorityPill = relScore >= 88
            ? `<span class="exam-priority-pill" title="High exam relevance: official BI exam, tutoring, lecture slide, or assignment task">★ Exam Priority</span>`
            : '';
          return `<tr>
            <td><strong>${esc(q.title)}</strong><div class="exp-row-meta">${priorityPill}${provPill}<small class="muted">${esc(q.localId || q.id)}</small></div></td>
            <td><span class="badge">T${esc(q.topicId)}</span></td>
            <td>${diffBadge}</td>
            <td>${kindBadge}</td>
            <td><small><b>${lp}</b> / ${ep}</small></td>
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

    root.querySelectorAll('[data-pick-course]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextId = btn.dataset.pickCourse;
        if (nextId && nextId !== courseId) {
          window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
          renderCourseExplorer(nextId, '');
        }
      });
    });

    // Composable Source + DLPFC + Real BI Tasks Only filter chips
    document.getElementById('chip-real-only')?.addEventListener('click', () => {
      const oEl = document.getElementById('flt-origin');
      realTasksOnly = !realTasksOnly;
      if (realTasksOnly && oEl.value === 'ai_only') oEl.value = 'all';
      if (!realTasksOnly && oEl.value === 'official_only') oEl.value = 'all';
      syncFilterChipUi();
      refreshTable();
    });

    root.querySelectorAll('[data-chip-origin]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const oEl = document.getElementById('flt-origin');
        const val = chip.dataset.chipOrigin;
        const next = oEl.value === val ? 'all' : val;
        oEl.value = next;
        if (next === 'ai_only') realTasksOnly = false;
        if (next === 'past_exam') document.getElementById('flt-status').value = 'all';
        syncFilterChipUi();
        refreshTable();
      });
    });

    root.querySelectorAll('[data-chip-diff]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const dEl = document.getElementById('flt-diff');
        const val = chip.dataset.chipDiff;
        dEl.value = dEl.value === val ? 'all' : val;
        syncFilterChipUi();
        refreshTable();
      });
    });

    root.querySelectorAll('[data-chip-horizon]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const hEl = document.getElementById('flt-horizon');
        const val = chip.dataset.chipHorizon;
        hEl.value = hEl.value === val ? 'all' : val;
        syncFilterChipUi();
        refreshTable();
      });
    });

    root.querySelectorAll('[data-chip-kind]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const kEl = document.getElementById('flt-kind');
        const val = chip.dataset.chipKind;
        kEl.value = kEl.value === val ? 'all' : val;
        syncFilterChipUi();
        refreshTable();
      });
    });

    document.getElementById('chip-reset-filters')?.addEventListener('click', () => {
      applyPreset('reset');
      refreshTable();
    });

    document.getElementById('chip-share-filters')?.addEventListener('click', async () => {
      const shareUrl = `${window.location.origin}${buildShareableCoursePath({ includeDefaultSort: true })}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        toast('Filter link copied — ready to share!');
      } catch {
        window.prompt('Copy this shareable filter link:', shareUrl);
      }
    });

    // 3-state clickable table header sorting (1st click -> 2nd click flip -> 3rd click default)
    root.querySelectorAll('.th-sort-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const col = btn.dataset.sortCol;
        const firstDir = COL_FIRST_DIR[col] || 'asc';
        const secondDir = firstDir === 'asc' ? 'desc' : 'asc';
        if (colSort.col !== col) {
          colSort = { col, dir: firstDir };
        } else if (colSort.dir === firstDir) {
          colSort = { col, dir: secondDir };
        } else {
          colSort = { col: null, dir: null };
        }
        syncFilterChipUi();
        refreshTable();
      });
    });

    members.bindDownloads(root);
    root.querySelectorAll('[data-member-pdfcraft]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const docId = btn.dataset.memberPdfcraft;
        const name = btn.dataset.memberPdfcraftName || 'course-document.pdf';
        window.StudyPdfCraft?.openSource?.({
          memberAsset: { id: docId, mime: 'application/pdf', title: name },
          courseId,
          title: name,
          pathStr: name,
        }, {
          onSaved: async () => {
            await renderCourseExplorer(courseId, initialPreset);
            document.getElementById('course-browser-vault')?.setAttribute('open', '');
          },
        });
      });
    });
    root.querySelector('#exp-open-bi-sync')?.addEventListener('click', () => openBiSyncHub());
    root.querySelector('#exp-browser-pdf-input')?.addEventListener('change', async (ev) => {
      const files = ev.target.files;
      if (!files?.length || !window.StudyLocalSources) return;
      const res = await window.StudyLocalSources.saveBatch(courseId, files, bank.sources || {});
      ev.target.value = '';
      if (res.saved.length) {
        toast(`Saved ${res.saved.length} PDF${res.saved.length === 1 ? '' : 's'} privately in this browser.`);
        await renderCourseExplorer(courseId, initialPreset);
        document.getElementById('course-browser-vault')?.setAttribute('open', '');
      }
      if (res.errors.length) toast(res.errors[0]);
    });
    root.querySelectorAll('[data-browser-pdf-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openLocalPdf(btn.dataset.browserPdfTitle || 'Local PDF', '', btn.dataset.browserPdfKey);
      });
    });
    root.querySelectorAll('[data-browser-pdf-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.StudyPdfCraft?.openSource?.({
          localSourceKey: btn.dataset.browserPdfEdit,
          courseId,
          title: btn.dataset.browserPdfTitle || 'Local PDF',
        });
      });
    });
    root.querySelectorAll('[data-browser-pdf-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await window.StudyLocalSources?.remove?.(btn.dataset.browserPdfDel);
        toast('Removed local PDF from this browser.');
        await renderCourseExplorer(courseId, initialPreset);
        document.getElementById('course-browser-vault')?.setAttribute('open', '');
      });
    });
    root.querySelector('#exp-add-canvas-files')?.addEventListener('click', () => openCanvasFiles(localCanvasId));
    for (const button of root.querySelectorAll('[data-local-pdf]')) {
      button.onclick = () => {
        const file = localFiles[Number(button.dataset.localPdf)];
        openLocalPdf(file.name, `/api/canvas-file?path=${encodeURIComponent(file.path)}`);
      };
    }
    const localSearch = root.querySelector('#exp-find-local-file');
    if (localSearch) localSearch.oninput = () => {
      const query = localSearch.value.trim().toLowerCase();
      for (const file of root.querySelectorAll('#course-local-documents li')) {
        file.hidden = !file.textContent.toLowerCase().includes(query);
      }
    };
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
    document.getElementById('exp-open-exams').onclick = () => navigate('exams', { focusCourseId: courseId });
    document.getElementById('exp-open-ref').onclick = () => openReferenceDrawer(cMeta);
    for (const id of ['flt-origin', 'flt-topic', 'flt-coll', 'flt-kind', 'flt-diff', 'flt-horizon', 'flt-status', 'flt-sort', 'flt-profile', 'flt-budget', 'flt-shuffle']) {
      const el = document.getElementById(id);
      if (el) {
        el.onchange = () => {
          if (id === 'flt-sort') colSort = { col: null, dir: null };
          if (id === 'flt-origin') {
            if (el.value === 'official_only') realTasksOnly = true;
            else if (el.value === 'ai_only' || el.value === 'all') realTasksOnly = false;
          }
          syncFilterChipUi();
          refreshTable();
        };
      }
    }
    document.getElementById('flt-search').oninput = refreshTable;
    syncFilterChipUi();

    if (initialPreset) {
      applyPreset(initialPreset);
    }

    if (initialFilters && typeof initialFilters === 'object') {
      const setSelectIfValid = (id, val) => {
        if (!val) return false;
        const el = document.getElementById(id);
        if (!el) return false;
        const ok = Array.from(el.options || []).some((opt) => opt.value === val);
        if (ok) {
          el.value = val;
          return true;
        }
        return false;
      };
      if (initialFilters.preset) applyPreset(initialFilters.preset);
      if (setSelectIfValid('flt-origin', initialFilters.origin)) {
        realTasksOnly = initialFilters.origin === 'official_only';
      } else if (initialFilters.real) {
        realTasksOnly = true;
        setSelectIfValid('flt-origin', 'official_only');
      }
      setSelectIfValid('flt-topic', initialFilters.topic);
      setSelectIfValid('flt-coll', initialFilters.coll);
      setSelectIfValid('flt-kind', initialFilters.kind);
      setSelectIfValid('flt-diff', initialFilters.diff);
      setSelectIfValid('flt-horizon', initialFilters.horizon);
      setSelectIfValid('flt-status', initialFilters.status);
      setSelectIfValid('flt-sort', initialFilters.sort);
      setSelectIfValid('flt-budget', initialFilters.budget);
      setSelectIfValid('flt-profile', initialFilters.profile);
      if (initialFilters.q) {
        const sEl = document.getElementById('flt-search');
        if (sEl) sEl.value = initialFilters.q;
      }
      syncFilterChipUi();
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
  // VIEW 4: METRICS, SUBGROUPS, INTERACTIVE CHARTS & COPYABLE AI BRIEF
  // ---------------------------------------------------------------------------
  function renderAnalytics() {
    const root = document.getElementById('analytics-root');
    if (isStaticWeb) {
      recomputeWebAnalytics();
    } else if (boot.analytics) {
      // Fold live browser Oslo screen-time history into local Python server analytics
      const screenHist = window.StudyUI?.workClock?.getScreenHistory?.() || {};
      const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' });
      const todayKey = dayFmt.format(new Date());
      const byDay = new Map((Array.isArray(boot.analytics.dailySeries) ? boot.analytics.dailySeries : []).map((d) => [d.day, { ...d }]));
      for (let i = 13; i >= 0; i--) {
        const dk = dayFmt.format(new Date(Date.now() - i * 86_400_000));
        if (!byDay.has(dk)) {
          byDay.set(dk, {
            day: dk,
            isToday: dk === todayKey,
            activeMin: 0, highMin: 0, medMin: 0, lowMin: 0,
            screenMin: 0, offScreenMin: 0, efficiencyPct: null,
            attempts: 0, adjustedUnits: 0, avgPaceRatio: null, upi: null, accuracyPct: null, byCourseMin: {},
          });
        }
      }
      for (const [dk, sh] of Object.entries(screenHist)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
        const row = byDay.get(dk) || {
          day: dk, isToday: dk === todayKey, activeMin: 0, highMin: 0, medMin: 0, lowMin: 0,
          screenMin: 0, offScreenMin: 0, efficiencyPct: null,
          attempts: 0, adjustedUnits: 0, avgPaceRatio: null, upi: null, accuracyPct: null, byCourseMin: {},
        };
        const shActMin = Math.round(((Number(sh?.activeSec) || 0) / 60) * 10) / 10;
        if (dk === todayKey) row.activeMin = Math.max(row.activeMin, shActMin);
        row.screenMin = Math.max(row.screenMin, row.activeMin, Math.round(((Number(sh?.screenSec) || 0) / 60) * 10) / 10);
        row.offScreenMin = Math.max(row.offScreenMin, Math.round(((Number(sh?.offScreenSec) || 0) / 60) * 10) / 10);
        row.efficiencyPct = row.screenMin > 0.5 ? Math.min(100, Math.round((row.activeMin / row.screenMin) * 100)) : null;
        byDay.set(dk, row);
      }
      boot.analytics.dailySeries = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
      const liveTodaySec = Number(screenHist[todayKey]?.activeSec || 0);
      if (boot.analytics.today) boot.analytics.today.liveActiveSec = liveTodaySec;
    }
    const aiBriefText = buildAiCoachBrief();
    if (window.StudyMetrics?.renderDashboard) {
      window.StudyMetrics.renderDashboard(root, {
        analytics: boot.analytics || {},
        catalog: boot.catalog || [],
        aiBriefText,
        onPracticeTopic: (courseId, topicId) => {
          launchSmartCourseRun(courseId, 45, 'learning', String(topicId), 'auto', false, 0);
        },
      });
      return;
    }
    root.innerHTML = `<div class="panel"><p class="muted">Loading metrics…</p></div>`;
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
      `- Verified Attempts: ${a.totalAttempts || 0} | Accuracy: ${ov.avgAccuracy != null ? Math.round(ov.avgAccuracy * 100) + '%' : 'N/A'} | Beat Al Par: ${ov.beatAiRate != null ? Math.round(ov.beatAiRate * 100) + '%' : 'N/A'}`,
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
  // VIEW 5: OBSIDIAN-GRADE MULTI-SEMESTER NOTES WORKBENCH (Zero-Lag 3-Pane Reader)
  // ---------------------------------------------------------------------------
  const REF_FILES_PREF_KEY = 'study-os-notes-files-open';
  const REF_OUTLINE_PREF_KEY = 'study-os-notes-outline-open';

  function getNotesPanePref(key, fallback = true) {
    try {
      const v = localStorage.getItem(key);
      if (v === '0') return false;
      if (v === '1') return true;
    } catch {}
    return fallback;
  }
  function setNotesPanePref(key, val) {
    try { localStorage.setItem(key, val ? '1' : '0'); } catch {}
  }

  function toggleSiteReferenceSidebar() {
    if (window.StudyUI.isReferenceDrawerOpen?.()) {
      window.StudyUI.closeReferenceDrawer();
      return;
    }
    const cat = boot.catalog || [];
    let targetCourse = null;
    if (currentView === 'course' && selectedCourseId) {
      targetCourse = cat.find((c) => c.courseId === selectedCourseId);
    } else if (currentView === 'references' && selectedRefFile) {
      const refEntry = (boot.references || []).find((r) => r.file === selectedRefFile);
      if (refEntry?.courseId) targetCourse = cat.find((c) => c.courseId === refEntry.courseId);
    }
    if (!targetCourse) {
      targetCourse = cat.find((c) => c.courseId === selectedCourseId && !isCourseInMaintenanceForUser(c.courseId))
        || cat.find((c) => !isCourseInMaintenanceForUser(c.courseId) && c.obsidian?.mainReference)
        || cat.find((c) => c.obsidian?.mainReference)
        || cat[0];
    }
    if (targetCourse) openReferenceDrawer(targetCourse);
    else navigate('references');
  }

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

    const semesters = [...new Set(refs.map((r) => r.semester || 'Course Notes'))];
    const filteredRefs =
      selectedRefSemester === 'all' ? refs : refs.filter((r) => (r.semester || 'Course Notes') === selectedRefSemester);
    const activeEntry = filteredRefs.find((r) => r.file === selectedRefFile) || filteredRefs[0];
    if (activeEntry) selectedRefFile = activeEntry.file;

    // Group notes cleanly by semester like Obsidian's left file explorer
    const groupedBySem = new Map();
    for (const r of filteredRefs) {
      const sem = r.semester || 'Course Notes';
      if (!groupedBySem.has(sem)) groupedBySem.set(sem, []);
      groupedBySem.get(sem).push(r);
    }

    const filesOpen = getNotesPanePref(REF_FILES_PREF_KEY, true);
    const outlineOpen = getNotesPanePref(REF_OUTLINE_PREF_KEY, true);
    const activeMaintLocked = activeEntry?.courseId ? isCourseInMaintenanceForUser(activeEntry.courseId) : false;

    const fileTreeHtml = [...groupedBySem.entries()]
      .map(([sem, items]) => `
        <details class="obs-folder" open>
          <summary class="obs-folder-head">
            <span class="obs-outline-chev" aria-hidden="true"></span>
            <span>${esc(sem)}</span>
          </summary>
          <div class="obs-folder-items">
            ${items.map((r) => {
              const isAct = r.file === selectedRefFile;
              const isMaint = r.courseId ? isCourseInMaintenanceForUser(r.courseId) : false;
              const label = r.code ? `${r.code} · ${r.title}` : r.title;
              return `<button type="button" class="obs-file-item ${isAct ? 'is-active' : ''}" data-ref-pick="${esc(r.file)}" data-ref-card="${esc(r.file)}"${isAct ? ' aria-current="true"' : ''} title="${esc(label)}">
                <svg class="obs-file-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                </svg>
                <span class="obs-file-name">
                  <span class="obs-file-code" style="--note-dot:${esc(r.color)}">${esc(r.code || '')}</span>
                  <span class="obs-file-title">${esc(r.title)}</span>
                </span>
                ${isMaint ? '<span class="obs-file-tag">Maint.</span>' : ''}
              </button>`;
            }).join('')}
          </div>
        </details>
      `)
      .join('');

    const mobileChipsHtml = filteredRefs.map((r) => {
      const isAct = r.file === selectedRefFile;
      return `<button type="button" class="ref-mobile-chip ${isAct ? 'is-active' : ''}" data-ref-pick="${esc(r.file)}" style="--chip-color:${esc(r.color)}">
        <span class="exp-course-dot" aria-hidden="true"></span>
        <strong>${esc(r.code || r.title)}</strong>
      </button>`;
    }).join('');

    root.innerHTML = `
      <div class="ref-mobile-strip" role="tablist" aria-label="Choose course note">
        ${mobileChipsHtml}
      </div>

      <div class="ref-workbench ${filesOpen ? '' : 'files-collapsed'} ${outlineOpen ? '' : 'outline-collapsed'}" id="ref-workbench">
        <aside class="ref-file-pane" id="ref-hub-sidebar" aria-label="Course notes explorer">
          <div class="ref-pane-head">
            <span class="ref-pane-head-title">Notes</span>
            <div class="ref-pane-head-tools">
              ${semesters.length > 1 ? `<select id="ref-hub-sem-sel" class="ref-mini-select" aria-label="Filter semester">
                <option value="all">All (${refs.length})</option>
                ${semesters.map((s) => `<option value="${esc(s)}" ${selectedRefSemester === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
              </select>` : ''}
              <button type="button" class="runner-icon-btn ref-pane-close-btn" id="ref-toggle-files-inner" title="Collapse file sidebar" aria-label="Collapse file sidebar">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2.5"></rect><line x1="9" y1="4" x2="9" y2="20"></line>
                </svg>
              </button>
            </div>
          </div>
          <div class="ref-pane-search-wrap">
            <input type="search" id="ref-hub-search" class="ref-outline-filter" placeholder="Filter notes…" aria-label="Filter notes">
          </div>
          <div class="ref-file-tree-scroll" id="ref-file-tree-scroll">
            ${fileTreeHtml}
          </div>
        </aside>

        <article class="ref-reader-pane">
          <header class="ref-reader-bar">
            <div class="ref-reader-bar-left">
              <button type="button" class="runner-icon-btn ref-bar-toggle" id="ref-toggle-files-btn" title="Toggle files sidebar" aria-label="Toggle files sidebar" aria-expanded="${filesOpen}">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2.5"></rect><line x1="9" y1="4" x2="9" y2="20"></line>
                </svg>
              </button>
              <div class="ref-breadcrumb" id="ref-pane-title" tabindex="-1">
                <span class="ref-breadcrumb-code" style="--note-dot:${esc(activeEntry?.color || 'var(--accent)')}">${esc(activeEntry?.code || '')}</span>
                <span class="ref-breadcrumb-sep" aria-hidden="true">/</span>
                <strong class="ref-breadcrumb-name">${esc(activeEntry?.title || 'Reference')}</strong>
              </div>
            </div>
            <div class="ref-reader-bar-right">
              <select id="ref-pane-doc-sel" class="ref-bar-select" aria-label="Reference document" hidden></select>
              ${activeEntry?.courseId && !activeMaintLocked ? `<button type="button" class="ghost-btn ref-bar-btn" data-ref-practice="${esc(activeEntry.courseId)}">Practice →</button>` : ''}
              ${!isStaticWeb && activeEntry?.obsidianUri ? `<a class="ghost-btn ref-bar-btn" href="${esc(activeEntry.obsidianUri)}">Obsidian ↗</a>` : ''}
              <button type="button" class="runner-icon-btn ref-bar-toggle" id="ref-toggle-outline-btn" title="Toggle chapter outline" aria-label="Toggle chapter outline" aria-expanded="${outlineOpen}">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line>
                  <line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>
                </svg>
              </button>
            </div>
          </header>
          <div id="ref-pane-body" class="markdown-body obs-prose"><p class="muted">Loading reference sheet…</p></div>
        </article>

        <aside class="ref-outline-pane" id="ref-outline-pane" aria-label="Chapter and subchapter outline">
          <div class="ref-pane-head">
            <span class="ref-pane-head-title">Outline</span>
            <div class="ref-pane-head-tools">
              <button type="button" class="runner-icon-btn" id="ref-outline-collapse-all" title="Collapse / Expand all chapters" aria-label="Collapse or expand all chapters">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="7 8 12 3 17 8"></polyline><polyline points="7 16 12 21 17 16"></polyline>
                </svg>
              </button>
              <button type="button" class="runner-icon-btn" id="ref-outline-close-btn" title="Close outline" aria-label="Close outline">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2.5"></rect><line x1="15" y1="4" x2="15" y2="20"></line>
                </svg>
              </button>
            </div>
          </div>
          <div class="ref-pane-search-wrap">
            <input type="search" id="ref-outline-search" class="ref-outline-filter" placeholder="Search chapters…" aria-label="Search chapters and subchapters">
          </div>
          <div class="ref-outline-scroll">
            <div id="ref-outline-tree" class="obs-outline-tree"></div>
          </div>
        </aside>
      </div>
      <div id="ref-outline-scrim" class="ref-outline-scrim" hidden></div>
    `;

    const workbench = document.getElementById('ref-workbench');
    const outlinePane = document.getElementById('ref-outline-pane');
    const outlineScrim = document.getElementById('ref-outline-scrim');
    const outlineSearchEl = document.getElementById('ref-outline-search');
    const outlineTreeEl = document.getElementById('ref-outline-tree');
    const isCompactOutlineBp = () => window.matchMedia('(max-width: 1120px)').matches;

    let currentToc = [];
    let activeOutlineHeading = '';
    let allCollapsed = false;
    let activeReaderCtrl = null;
    let currentDocPath = '';

    const setOutlineDrawerMobile = (open) => {
      if (!outlinePane || !outlineScrim) return;
      outlinePane.classList.toggle('is-mobile-open', open);
      outlineScrim.hidden = !open;
    };

    const toggleFilesPane = () => {
      const nextCollapsed = !workbench.classList.contains('files-collapsed');
      workbench.classList.toggle('files-collapsed', nextCollapsed);
      setNotesPanePref(REF_FILES_PREF_KEY, !nextCollapsed);
      document.getElementById('ref-toggle-files-btn')?.setAttribute('aria-expanded', String(!nextCollapsed));
    };

    const toggleOutlinePane = () => {
      if (isCompactOutlineBp()) {
        setOutlineDrawerMobile(!outlinePane.classList.contains('is-mobile-open'));
        return;
      }
      const nextCollapsed = !workbench.classList.contains('outline-collapsed');
      workbench.classList.toggle('outline-collapsed', nextCollapsed);
      setNotesPanePref(REF_OUTLINE_PREF_KEY, !nextCollapsed);
      document.getElementById('ref-toggle-outline-btn')?.setAttribute('aria-expanded', String(!nextCollapsed));
    };

    document.getElementById('ref-toggle-files-btn')?.addEventListener('click', toggleFilesPane);
    document.getElementById('ref-toggle-files-inner')?.addEventListener('click', toggleFilesPane);
    document.getElementById('ref-toggle-outline-btn')?.addEventListener('click', toggleOutlinePane);
    document.getElementById('ref-outline-close-btn')?.addEventListener('click', () => {
      if (isCompactOutlineBp()) setOutlineDrawerMobile(false);
      else toggleOutlinePane();
    });
    outlineScrim?.addEventListener('click', () => setOutlineDrawerMobile(false));

    const paintOutline = () => {
      if (!outlineTreeEl) return;
      outlineTreeEl.innerHTML = window.StudyUI.buildOutlineTreeHtml(currentToc, {
        activeHeading: activeOutlineHeading,
        filter: outlineSearchEl?.value || '',
        collapsedByDefault: allCollapsed,
      });
      outlineTreeEl.querySelectorAll('[data-outline-heading]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const targetH = btn.dataset.outlineHeading || '';
          activeOutlineHeading = targetH;
          highlightActiveOutline(targetH);
          activeReaderCtrl?.jumpToHeading?.(targetH, true);
          if (isCompactOutlineBp()) setOutlineDrawerMobile(false);
        });
      });
    };

    const highlightActiveOutline = (headingTitle) => {
      if (!outlineTreeEl || !headingTitle) return;
      const cleanT = window.StudyUI.cleanOutlineTitle(headingTitle).toLowerCase();
      outlineTreeEl.querySelectorAll('.obs-outline-link').forEach((btn) => {
        const match = (btn.dataset.outlineHeading || '').toLowerCase() === headingTitle.toLowerCase()
          || window.StudyUI.cleanOutlineTitle(btn.dataset.outlineHeading || '').toLowerCase() === cleanT;
        btn.classList.toggle('is-active', match);
        if (match) {
          let p = btn.parentElement?.closest('details.obs-outline-branch');
          while (p) {
            p.open = true;
            p = p.parentElement?.closest('details.obs-outline-branch');
          }
        }
      });
    };

    document.getElementById('ref-outline-collapse-all')?.addEventListener('click', () => {
      allCollapsed = !allCollapsed;
      outlineTreeEl.querySelectorAll('details.obs-outline-branch').forEach((d) => {
        d.open = !allCollapsed;
      });
    });
    outlineSearchEl?.addEventListener('input', paintOutline);

    const loadReader = async (entry, fileOverride = '', heading = '') => {
      if (!entry) return;
      const targetDoc = fileOverride || entry.file;
      currentDocPath = targetDoc;
      const docSel = document.getElementById('ref-pane-doc-sel');
      const bodyEl = document.getElementById('ref-pane-body');
      const docs = [{ label: 'Main Reference', file: entry.file }, ...(entry.companions || [])];
      docSel.hidden = docs.length <= 1;
      docSel.innerHTML = docs
        .map((d) => `<option value="${esc(d.file)}" ${d.file === targetDoc ? 'selected' : ''}>${esc(d.label)}</option>`)
        .join('');

      bodyEl.innerHTML = '<p class="muted">Loading note…</p>';
      try {
        // Always load the full note markdown for progressive chapter-chunked rendering + full outline scroll-spy
        const res = await fetchReferenceSection(targetDoc, '');
        if (!res.available) {
          bodyEl.innerHTML = `<p class="muted">${esc(res.error || 'Reference unavailable.')}</p>`;
          currentToc = [];
          paintOutline();
          return;
        }
        currentToc = res.toc || [];
        activeOutlineHeading = heading || (currentToc.find((h) => h.level === 2)?.title || '');
        paintOutline();

        activeReaderCtrl = window.StudyUI.renderNoteProgressive(bodyEl, res.markdown || '', {
          scrollRoot: null,
          initialHeading: heading,
          onLinkJump: async (jumpFile, jumpHeading) => {
            const normCur = currentDocPath.replace(/\.md$/i, '').toLowerCase();
            const normTarget = jumpFile.replace(/\.md$/i, '').toLowerCase();
            if (!jumpFile || normTarget === normCur || normCur.endsWith(normTarget)) {
              if (jumpHeading) {
                activeOutlineHeading = jumpHeading;
                highlightActiveOutline(jumpHeading);
                activeReaderCtrl?.jumpToHeading?.(jumpHeading, true);
              } else {
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }
              return;
            }
            // Jump to a companion document or another subject note
            const found = findPublicReference(jumpFile);
            if (found) {
              selectedRefFile = found.entry.file;
              await renderReferencesHub(found.file, jumpHeading);
            }
          },
          onActiveHeading: (hTitle) => {
            if (hTitle && hTitle !== activeOutlineHeading) {
              activeOutlineHeading = hTitle;
              highlightActiveOutline(hTitle);
            }
          },
        });
      } catch {
        bodyEl.innerHTML = '<p class="muted">Could not load reference content.</p>';
      }

      docSel.onchange = () => loadReader(entry, docSel.value, '');
    };

    const semSel = document.getElementById('ref-hub-sem-sel');
    if (semSel) {
      semSel.onchange = (e) => {
        selectedRefSemester = e.target.value;
        renderReferencesHub();
      };
    }

    document.getElementById('ref-hub-search')?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      root.querySelectorAll('[data-ref-card]').forEach((card) => {
        const rf = refs.find((x) => x.file === card.dataset.refCard);
        const hay = `${rf?.code || ''} ${rf?.title || ''} ${(rf?.headings || []).join(' ')}`.toLowerCase();
        card.hidden = !!q && !hay.includes(q);
      });
    });

    root.querySelectorAll('[data-ref-pick]').forEach((card) => {
      card.addEventListener('click', async () => {
        const file = card.dataset.refPick;
        if (file === selectedRefFile) return;
        selectedRefFile = file;
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        await renderReferencesHub();
      });
    });

    root.querySelectorAll('[data-ref-practice]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate('course', { courseId: btn.dataset.refPractice });
      });
    });

    // Personal synced curriculum PDFs neatly inside a collapsible Obsidian folder
    if (isStaticWeb && window.StudyCommunity?.isSignedIn?.() && window.StudyCommunity?.listMaterials) {
      const treeScroll = document.getElementById('ref-file-tree-scroll');
      if (treeScroll) {
        const box = document.createElement('details');
        box.className = 'obs-folder ref-personal-folder';
        box.innerHTML = `
          <summary class="obs-folder-head">
            <span class="obs-outline-chev" aria-hidden="true"></span>
            <span>Personal PDFs</span>
            <button type="button" class="obs-mini-add-btn" id="ref-add-materials-btn" title="Add personal PDFs">+ Add</button>
          </summary>
          <div class="obs-folder-items" id="ref-personal-materials-list"><small class="muted" style="padding:4px 8px;display:block">Loading…</small></div>
        `;
        treeScroll.appendChild(box);
        box.querySelector('#ref-add-materials-btn').onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openBiSyncHub({ focusMaterials: true });
        };
        window.StudyCommunity.listMaterials().then((res) => {
          const listEl = box.querySelector('#ref-personal-materials-list');
          if (!listEl || !listEl.isConnected) return;
          const items = Array.isArray(res?.items) ? res.items : [];
          if (!items.length) {
            listEl.innerHTML = '<small class="muted" style="padding:4px 8px;display:block">No personal PDFs yet.</small>';
            return;
          }
          box.open = true;
          listEl.innerHTML = items.map((m) => `
            <button type="button" class="obs-file-item" data-open-mat="${esc(m.id)}" data-mat-title="${esc(m.title)}" title="${esc(m.title)}">
              <span class="obs-file-name">
                ${m.courseCode ? `<span class="obs-file-code">${esc(m.courseCode)}</span>` : ''}
                <span class="obs-file-title">${esc(m.title)}</span>
              </span>
            </button>
          `).join('');
          listEl.querySelectorAll('[data-open-mat]').forEach((btn) => {
            btn.onclick = async () => {
              btn.disabled = true;
              try {
                await window.StudyCommunity.openMaterial(btn.dataset.openMat, btn.dataset.matTitle);
              } catch (err) {
                toast(err?.message || 'Could not open file.');
              } finally {
                btn.disabled = false;
              }
            };
          });
        }).catch(() => {
          const listEl = box.querySelector('#ref-personal-materials-list');
          if (listEl) listEl.innerHTML = '<small class="muted" style="padding:4px 8px;display:block">Could not load PDFs.</small>';
        });
      }
    }

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
      const duration = Number(b.durationMinutes || b.focusMinutes || 50);
      const ed = b.end?.includes('T') ? new Date(b.end) : b.endTime
        ? new Date(`${b.date}T${b.endTime}:00`)
        : new Date(sd.getTime() + duration * 60000);
      const dur = Math.round((ed - sd) / 60000);
      if (!Number.isFinite(dur) || dur <= 0) throw new Error('Choose a valid end time after the start time.');
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
        return `- courseId: "${c.courseId}" | ${c.code} · ${c.title} | Exam: ${c.examInfo?.date || 'TBD'} | Done: ${cp.done || 0}/${c.questionCount} | High/Med/Low DLPFC Qs: ${c.highDlpfcCount || 0}/${c.medDlpfcCount || 0}/${c.lowDlpfcCount || 0}`;
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
      `Design an optimal, sustainable 7-day circadian DLPFC study schedule starting ${todayIso} in Universal Study-OS Calendar JSON format.`,
      '',
      'STUDENT CONSTRAINTS & CIRCADIAN DLPFC RULES:',
      `- Part-time job hours/week: ${prefs.weeklyWorkHours || 0}h -> Target self-study budget: ~${targetH}h/week`,
      `- Wake up at ${prefs.wakeTime} and go to bed at ${prefs.bedTime}. Leave 30 minutes at each end of the awake window. Use ${prefs.blockMinutes || 50}m focus / ${prefs.breakMinutes || 10}m off-screen break.`,
      '- High DLPFC peak window (wake +30m to wake +7h, max 4.5h/day cap): schedule heavy synthesis, proofs, coding & financial cases and prefix summaries with "[High DLPFC]".',
      '- Med DLPFC mid-day window (wake +7h to wake +11h): schedule procedural drills & standard calculations and prefix summaries with "[Med DLPFC]".',
      '- Low DLPFC evening wind-down (wake +11h to bedtime -30m): schedule conceptual recall MCQs & spaced-repetition reviews and prefix summaries with "[Low DLPFC]".',
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

  function parseHmToMins(hm, fallback = 450) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hm || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
  }

  function minsToHm(mins) {
    const n = ((Math.round(mins) % 1440) + 1440) % 1440;
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  }

  function deriveSleepWindow(wakeTime, sleepHours = 8) {
    const wakeMins = parseHmToMins(wakeTime, 7 * 60 + 30);
    const sleep = Math.max(6, Math.min(10, Number(sleepHours) || 8));
    const bedMins = wakeMins - Math.round(sleep * 60);
    return {
      wakeTime: minsToHm(wakeMins),
      bedTime: minsToHm(bedMins),
      studyStart: minsToHm(wakeMins + 30),
      studyEnd: minsToHm(bedMins - 30),
      sleepHours: sleep,
    };
  }

  function formatRelativePostAge(iso) {
    const ts = Date.parse(iso || '');
    if (!Number.isFinite(ts)) return '';
    const diffMin = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
    if (diffMin < 2) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const hrs = Math.floor(diffMin / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function renderEdFeedInto(container, opts = {}) {
    if (!container) return 0;
    const snap = isStaticWeb ? loadWebState().edSnapshot : null;
    const allThreads = Array.isArray(snap?.threads) ? snap.threads : [];
    if (!allThreads.length) {
      if (opts.emptyHint) {
        container.innerHTML = `<p class="muted ed-feed-empty-hint">${esc(opts.emptyHint)}</p>`;
      } else {
        container.innerHTML = '';
      }
      return 0;
    }

    const courses = [...new Map(
      allThreads.map((t) => [t.courseId || t.courseCode || t.courseName, {
        key: t.courseId || t.courseCode || t.courseName,
        label: t.courseCode || t.courseName || 'Ed',
      }])
    ).values()];

    let activeCourse = 'all';
    let showAll = false;
    const baseLimit = Math.max(2, Number(opts.limit) || 5);
    const title = opts.title || 'Ed Discussion';

    const paint = () => {
      const filtered = activeCourse === 'all'
        ? allThreads
        : allThreads.filter((t) => (t.courseId || t.courseCode || t.courseName) === activeCourse);
      const visible = showAll ? filtered : filtered.slice(0, baseLimit);
      const syncedAgo = formatRelativePostAge(snap?.syncedAt);

      container.innerHTML = `
        <div class="ed-feed-wrap">
          <div class="row-between ed-feed-head">
            <div class="row-actions" style="gap:7px;flex-wrap:wrap">
              <h3 class="ed-feed-title">${esc(title)}</h3>
              <span class="badge">${filtered.length} post${filtered.length === 1 ? '' : 's'}</span>
              ${syncedAgo ? `<small class="muted">Synced ${esc(syncedAgo)}</small>` : ''}
            </div>
            ${courses.length > 1 ? `
              <div class="ed-feed-pills" role="tablist" aria-label="Filter Ed posts by course">
                <button type="button" class="ed-filter-pill ${activeCourse === 'all' ? 'active' : ''}" data-ed-feed-course="all">All</button>
                ${courses.slice(0, 6).map((c) => `
                  <button type="button" class="ed-filter-pill ${activeCourse === c.key ? 'active' : ''}" data-ed-feed-course="${esc(c.key)}">${esc(c.label)}</button>
                `).join('')}
              </div>` : ''}
          </div>
          <div class="ed-feed-list">
            ${visible.map((t, idx) => {
              const snippet = String(t.snippet || '').trim();
              const isLong = snippet.length > 180 || snippet.split('\n').length > 3;
              const safeUrl = /^https:\/\/(?:(?:eu|us|au)\.)?edstem\.org\/courses\/\d+\/discussion\/\d+$/.test(t.url || '')
                ? t.url
                : `https://${/^(?:(?:eu|us|au)\.)?edstem\.org$/.test(t.host || '') ? t.host : 'eu.edstem.org'}/courses/${encodeURIComponent(t.courseId || '')}/discussion/${encodeURIComponent(t.id || '')}`;
              const age = formatRelativePostAge(t.updatedAt || t.createdAt);
              return `
                <article class="ed-feed-item ${t.isPinned || t.type === 'announcement' ? 'is-pinned' : ''}">
                  <div class="ed-feed-meta">
                    <div class="ed-feed-tags">
                      ${t.courseCode || t.courseName ? `<span class="course-code-pill">${esc(t.courseCode || t.courseName)}</span>` : ''}
                      ${t.isPinned ? '<span class="badge live">Pinned</span>' : ''}
                      ${t.type === 'announcement' ? '<span class="badge live">Announcement</span>' : ''}
                      ${t.isStaff && t.type !== 'announcement' ? '<span class="badge">Staff</span>' : ''}
                      ${t.isAnswered ? '<span class="badge good">Answered</span>' : ''}
                      ${t.category ? `<span class="topic-mini-chip">${esc(t.category)}</span>` : ''}
                    </div>
                    <small class="muted ed-feed-age">${t.number ? `#${t.number} · ` : ''}${esc(age)}</small>
                  </div>
                  <a class="ed-feed-post-title" href="${esc(safeUrl)}" target="_blank" rel="noopener">${esc(t.title)}</a>
                  ${snippet ? `<div class="ed-feed-snippet ${isLong ? 'is-clamped' : ''}" data-ed-snippet="${idx}">${esc(snippet)}</div>` : ''}
                  <div class="ed-feed-foot">
                    <small class="muted">
                      ${t.author ? `${esc(t.author)} · ` : ''}${t.replyCount} repl${t.replyCount === 1 ? 'y' : 'ies'}
                    </small>
                    <div class="row-actions" style="gap:8px">
                      ${isLong ? `<button type="button" class="link-btn ed-feed-more-btn" data-ed-expand="${idx}">Read more</button>` : ''}
                      <a class="link-btn" href="${esc(safeUrl)}" target="_blank" rel="noopener">Open in Ed ↗</a>
                    </div>
                  </div>
                </article>`;
            }).join('')}
          </div>
          ${filtered.length > baseLimit ? `
            <div class="ed-feed-toggle-row">
              <button type="button" class="ghost-btn" id="btn-ed-feed-toggle" style="padding:5px 12px;font-size:12px">
                ${showAll ? 'Show fewer posts' : `Show all ${filtered.length} posts`}
              </button>
            </div>` : ''}
        </div>`;

      container.querySelectorAll('[data-ed-feed-course]').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeCourse = btn.dataset.edFeedCourse || 'all';
          showAll = false;
          paint();
        });
      });
      container.querySelectorAll('[data-ed-expand]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const snip = container.querySelector(`[data-ed-snippet="${btn.dataset.edExpand}"]`);
          if (!snip) return;
          const expanded = !snip.classList.toggle('is-clamped');
          btn.textContent = expanded ? 'Show less' : 'Read more';
        });
      });
      container.querySelector('#btn-ed-feed-toggle')?.addEventListener('click', () => {
        showAll = !showAll;
        paint();
      });
    };

    paint();
    return allThreads.length;
  }

  function renderScheduleStudio() {
    const root = document.getElementById('schedule-studio-root');
    const cfg = boot.scheduleConfig || {};
    const wsNow = isStaticWeb ? loadWebState() : {};
    const personalCanvas = isStaticWeb ? wsNow.canvasSnapshot : null;
    const personalEd = isStaticWeb ? wsNow.edSnapshot : null;
    const edThreads = Array.isArray(personalEd?.threads) ? personalEd.threads : [];
    const snapOrigin = safeCanvasOrigin(personalCanvas?.canvasOrigin || personalCanvas?.courses?.[0]?.url || '');
    const validCanvasId = id => /^[1-9][0-9]{0,19}$/.test(id || '');
    const due = (personalCanvas?.courses || []).filter(course => validCanvasId(course.id)).flatMap(course => {
      const cOrigin = typeof course.url === 'string' && course.url.startsWith('https://')
        ? safeCanvasOrigin(course.url)
        : snapOrigin;
      return (course.assignments || [])
        .filter(task => validCanvasId(task.id) && Date.parse(task.dueAt) >= Date.now())
        .map(task => ({
          ...task,
          course: course.name,
          url: typeof task.url === 'string' && task.url.startsWith('https://')
            ? task.url
            : `${cOrigin}/courses/${course.id}/assignments/${task.id}`,
        }));
    }).sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 15);
    let suggestCourses = true;
    try { suggestCourses = localStorage.getItem('study-os-course-suggestions') !== 'off'; } catch {}
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
      customNotes: '',
      ...(cfg.prefs || {}),
    };
    prefs.wakeTime ||= `${String(Math.max(5, (prefs.dayStartHour || 8) - 1)).padStart(2, '0')}:30`;
    const sleepWin = deriveSleepWindow(prefs.wakeTime, 8);
    prefs.bedTime = sleepWin.bedTime;

    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const fixedUpcoming = (boot.calendar?.blocks || [])
      .filter((b) => (b.blockKind === 'class_session' || b.blockKind === 'exam') && getBlockEffectiveState(b).timingState !== 'past');
    const classBlocksCount = (boot.calendar?.blocks || []).filter((b) => b.blockKind === 'class_session').length;
    const approxWeeklyClassH = classBlocksCount ? Math.max(2, Math.round((classBlocksCount * 1.75) / 2)) : 8;
    const est = cfg.estimate || computeClientStudyEstimate(prefs.weeklyWorkHours, approxWeeklyClassH, boot.catalog.length || 4);
    const isHydrogenPlan = cfg.enabled && cfg.source === 'gemini_hydrogen_schedule';
    const aiSummary = typeof cfg.aiSummary === 'string' ? cfg.aiSummary : (wsNow.customSchedule?.aiSummary || '');
    const aiModelLabel = typeof cfg.modelLabel === 'string' ? cfg.modelLabel : (wsNow.customSchedule?.modelLabel || 'Gemini 4 Hydrogen');

    const syncStatusPill = classBlocksCount > 0
      ? `<span class="badge good">TimeEdit synced · ${classBlocksCount} class${classBlocksCount === 1 ? '' : 'es'}</span>`
      : isHydrogenPlan
      ? `<span class="badge live">${esc(aiModelLabel)} plan</span>`
      : cfg.source === 'calendar_plan_import'
      ? '<span class="badge">Imported .ics plan</span>'
      : '<span class="badge">Default timetable</span>';

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

    const qState = getScheduledQueueState();
    const activeRows = [
      ...qState.debtBlocks,
      ...[...qState.liveBlocks, ...qState.upcomingBlocks, ...fixedUpcoming].sort(
        (a, b) => Date.parse(a.startIso || '') - Date.parse(b.startIso || '')
      ),
    ].slice(0, 32);
    const doneRows = qState.completedBlocks.slice(0, 15);
    const hasUpdates = due.length > 0 || edThreads.length > 0;

    root.innerHTML = `
      <div class="sch-top-bar">
        <div class="sch-top-left">
          <h1 class="sch-page-title">Study schedule</h1>
          ${syncStatusPill}
        </div>
        <div class="row-actions" style="gap:6px;flex-wrap:wrap">
          ${isStaticWeb
            ? '<button type="button" class="ghost-btn" id="btn-pair-sync-ext">Sync TimeEdit / Ed</button>'
            : '<button type="button" class="ghost-btn" id="btn-send-desktop-setup">Send to phone ↗</button>'}
          <button type="button" class="ghost-btn" id="btn-export-schedule">Download .ics</button>
          ${!isStaticWeb ? '<a class="ghost-btn" href="./canvas-connect.html" target="_blank" rel="noopener">Canvas ↗</a>' : ''}
          ${cfg.enabled ? '<button type="button" class="ghost-btn" id="btn-reset-custom-sched">Reset</button>' : ''}
        </div>
      </div>

      ${desktopImport ? `
        <section class="panel device-setup-card" style="margin-bottom:14px">
          <h2>Desktop setup is ready to import</h2>
          ${desktopImport.customSchedule || desktopImport.canvasSnapshot ? `
            <p class="muted">Save your ${desktopImport.customSchedule ? 'study plan' : ''}${desktopImport.customSchedule && desktopImport.canvasSnapshot ? ' and ' : ''}${desktopImport.canvasSnapshot ? 'Canvas deadlines' : ''} to your Study-OS profile.</p>
            ${desktopImport.canvasSnapshot ? `<label class="check-row"><input type="checkbox" id="desktop-suggest-courses" ${suggestCourses ? 'checked' : ''}> Suggest new course names and codes for admin review</label>` : ''}
            <button type="button" class="primary-btn" id="btn-save-desktop-setup">Save to my profile</button>
          ` : '<p class="muted">Build a study plan or run Canvas Browser Sync on your computer, then send it again.</p>'}
        </section>` : ''}

      <section class="panel sch-planner-card">
        <div class="sch-core-grid">
          <div class="sch-field-group">
            <label class="field-label sch-slider-label" for="sch-work-h">
              <span>Paid work per week</span>
              <output id="sch-work-output" for="sch-work-h">${Number(prefs.weeklyWorkHours || 0)} h</output>
            </label>
            <input type="range" id="sch-work-h" class="sch-range" min="0" max="45" step="1" value="${Number(prefs.weeklyWorkHours || 0)}">
            <div class="sch-load-hint" id="sch-estimate-box">
              Classes <b>~${est.weeklyClassHours}h</b> · Study <b>${est.recommendedStudyHours}h/wk</b> · Total <b>${est.totalCommittedHours}h/wk</b>
            </div>
          </div>

          <div class="sch-field-group sch-wake-group">
            <label class="field-label" for="sch-wake">
              <span>Wake-up time</span>
              <input type="time" id="sch-wake" required value="${esc(sleepWin.wakeTime)}">
            </label>
            <div class="sch-load-hint" id="sch-sleep-hint">
              8h sleep protected · Bedtime <b>${esc(sleepWin.bedTime)}</b> · Study <b>${esc(sleepWin.studyStart)}–${esc(sleepWin.studyEnd)}</b>
            </div>
          </div>
        </div>

        <label class="field-label sch-notes-field">
          <span>Shifts, workouts or priorities <small class="muted">(optional — used by Gemini 4 Hydrogen)</small></span>
          <input type="text" id="llm-custom-notes" maxlength="500" value="${esc(prefs.customNotes || '')}" placeholder="e.g. Work Tue &amp; Thu 16:00–21:00, gym Mon/Wed 18:00, focus extra on Accounting">
        </label>

        <div class="sch-action-bar">
          <button type="button" class="primary-btn" id="btn-hydrogen-sched">${isHydrogenPlan ? 'Update with Hydrogen' : 'Plan with Hydrogen'}</button>
          <button type="button" class="ghost-btn" id="btn-generate-sched">Quick auto-plan</button>
          <span class="muted sch-plan-status" id="sch-plan-status" role="status"></span>
        </div>

        ${isHydrogenPlan && aiSummary ? `
          <div class="sch-ai-summary">
            <span class="badge good">${esc(aiModelLabel)}</span>
            <span>${esc(aiSummary)}</span>
          </div>` : ''}

        <details class="sch-more-details">
          <summary>More options · Timetable .ics, rhythm, weights &amp; external LLM</summary>
          <div class="sch-more-body">
            <div class="sch-more-col">
              <h4>Timetable &amp; calendar import</h4>
              <div class="row-actions" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">
                ${isStaticWeb ? `<button type="button" class="ghost-btn" id="btn-pull-ext-timeedit">${cfg.enabled && cfg.source !== 'timeedit_extension_sync' ? 'Pull synced TimeEdit' : 'Import synced TimeEdit'}</button>` : ''}
                ${isStaticWeb ? `<button type="button" class="ghost-btn" id="btn-import-calendar-plan">Import calendar (.ics)</button><input type="file" id="sch-calendar-plan" accept=".ics,text/calendar" hidden>` : ''}
                ${(() => {
                  const sc = getUserSchoolConfig();
                  const primary = sc.name && sc.timetableUrl
                    ? `<a class="ghost-btn" href="${esc(sc.timetableUrl)}" target="_blank" rel="noopener">${esc(sc.timetableLabel)} ↗</a>`
                    : '';
                  return `${primary}<a class="ghost-btn" href="https://cloud.timeedit.net/" target="_blank" rel="noopener">TimeEdit ↗</a><a class="ghost-btn" href="https://tp.educloud.no/" target="_blank" rel="noopener">TP ↗</a>`;
                })()}
              </div>
              <label class="field-label">TimeEdit or TP iCal / .ics link
                <input type="url" id="sch-te-url" value="${esc(prefs.timeeditUrl || '')}" placeholder="https://cloud.timeedit.net/… or https://tp.educloud.no/…" autocomplete="off" autocapitalize="off" spellcheck="false">
              </label>
              <label class="field-label" style="margin-top:6px">Or upload an .ics file
                <input type="file" id="sch-ics-file" accept=".ics,text/calendar" style="font-size:12.5px">
              </label>
              <div class="row-actions" style="flex-wrap:wrap;gap:6px;margin-top:8px">
                <a class="ghost-btn" href="https://calendar.google.com/calendar/r/settings/export" target="_blank" rel="noopener">Google Calendar import ↗</a>
                <a class="ghost-btn" href="https://support.apple.com/guide/calendar/icl1023/mac" target="_blank" rel="noopener">Apple Calendar import ↗</a>
                <a class="ghost-btn" href="https://github.com/shadjosef/study-os/blob/main/docs/canvas-browser-sync.md" target="_blank" rel="noopener">Extension guide ↗</a>
              </div>
            </div>

            <div class="sch-more-col">
              <h4>Fine-tune blocks &amp; weights</h4>
              <div class="sch-finetune-row">
                <label class="field-label" for="sch-study-h" style="flex:1">
                  <span>Study hrs/wk <output id="sch-study-output" for="sch-study-h"></output></span>
                  <input type="range" id="sch-study-h" class="sch-range" min="2" max="45" step="0.5" value="${Number(prefs.targetStudyHours || est.recommendedStudyHours)}" ${prefs.autoAdjustStudy !== false ? 'disabled' : ''}>
                </label>
                <label class="field-label" style="width:128px">Block rhythm
                  <select id="sch-rhythm">
                    <option value="50:10" ${Number(prefs.blockMinutes) === 50 ? 'selected' : ''}>50m / 10m</option>
                    <option value="75:15" ${Number(prefs.blockMinutes) === 75 ? 'selected' : ''}>75m / 15m</option>
                    <option value="40:10" ${Number(prefs.blockMinutes) === 40 ? 'selected' : ''}>40m / 10m</option>
                  </select>
                </label>
              </div>
              <label style="display:inline-flex;align-items:center;gap:8px;margin-top:4px;font-size:12.5px;cursor:pointer">
                <input type="checkbox" id="sch-auto-adjust" ${prefs.autoAdjustStudy !== false ? 'checked' : ''}>
                <span>Auto-adjust study hours from work &amp; lectures</span>
              </label>
              <div style="margin-top:8px">
                <small class="muted" style="font-weight:700">REST / OFF DAYS</small>
                <div class="day-toggle-row">
                  ${dayLabels.map((lbl, idx) => `
                    <label class="day-chip">
                      <input type="checkbox" data-rest-day="${idx}" ${(prefs.restDays || []).includes(idx) ? 'checked' : ''}>
                      ${lbl}
                    </label>`).join('')}
                </div>
              </div>
              ${courseWeightRows ? `<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12.5px;font-weight:600">Per-course weights</summary><div style="margin-top:4px">${courseWeightRows}</div></details>` : ''}
            </div>

            <div class="sch-more-col sch-more-full">
              <h4>External LLM (ChatGPT, Claude, Ollama)</h4>
              <div class="row-actions" style="flex-wrap:wrap;gap:8px;margin-bottom:8px">
                <button type="button" class="ghost-btn" id="btn-copy-llm-prompt">Copy schedule prompt</button>
                <button type="button" class="primary-btn" id="btn-apply-llm-sched">Apply pasted JSON / .ics →</button>
              </div>
              <textarea id="llm-paste-box" style="min-height:92px;font-family:ui-monospace,monospace;font-size:12px" placeholder='Paste study-os-schedule-v1 JSON or BEGIN:VCALENDAR .ics here…'></textarea>
            </div>
          </div>
        </details>
      </section>

      ${hasUpdates ? `
        <div class="sch-updates-grid ${due.length && edThreads.length ? 'two-col' : ''}">
          ${due.length ? `
            <section class="panel sch-compact-panel">
              <div class="row-between" style="margin:0 0 8px;gap:8px">
                <div class="row-actions" style="gap:7px">
                  <h3 style="margin:0;font-size:15px">Canvas deadlines${personalCanvas?.school ? ` · ${esc(personalCanvas.school)}` : ''}</h3>
                  <span class="badge">${due.length}</span>
                </div>
              </div>
              <ul class="sch-deadline-list">
                ${due.slice(0, 6).map((task) => `
                  <li>
                    <a href="${esc(task.url)}" target="_blank" rel="noopener">${esc(task.name)}</a>
                    <small>${esc(task.course)} · ${esc(new Date(task.dueAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</small>
                  </li>`).join('')}
              </ul>
              ${due.length > 6 ? `
                <details style="margin-top:6px">
                  <summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--muted)">Show ${due.length - 6} more deadlines</summary>
                  <ul class="sch-deadline-list" style="margin-top:6px">
                    ${due.slice(6).map((task) => `
                      <li>
                        <a href="${esc(task.url)}" target="_blank" rel="noopener">${esc(task.name)}</a>
                        <small>${esc(task.course)} · ${esc(new Date(task.dueAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</small>
                      </li>`).join('')}
                  </ul>
                </details>` : ''}
            </section>` : ''}
          ${edThreads.length ? `<section class="panel sch-compact-panel" id="sch-ed-feed-slot"></section>` : ''}
        </div>` : ''}

      <!-- ACTIVE SCHEDULE, STUDY DEBT ROLLOVER & EARLY COMPLETION -->
      <div class="panel">
        <div class="row-between" style="margin-top:0;flex-wrap:wrap;gap:10px">
          <div>
            <h3>Active Schedule &amp; Study Debt (${activeRows.length} shown)</h3>
            <small class="muted">Click any study row to launch right away — complete upcoming blocks early, or clear rolled-over debt.</small>
          </div>
          <div class="row-actions" style="gap:8px;flex-wrap:wrap">
            ${qState.debtBlocks.length
              ? `<span class="badge debt">Debt: ${qState.debtBlocks.length} overdue (+${esc(formatDurationShort(qState.debtMinutes))})</span>
                 <button type="button" class="ghost-btn" id="btn-forgive-all-debt" style="padding:4px 10px;font-size:12px">Forgive all debt</button>`
              : '<span class="badge good">0 Study Debt ✓</span>'}
            <span class="badge">${qState.completedBlocks.length} done${qState.earlyCount ? ` (${qState.earlyCount} early)` : ''}</span>
          </div>
        </div>
        <div class="task-table-wrap">
          <table class="task-table">
            <thead><tr><th>When</th><th>Course</th><th>Topic &amp; Focus</th><th>DLPFC</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${
                activeRows.length
                  ? activeRows
                      .map((b) => {
                        const isStudy = b.blockKind === 'study_block' || b.blockKind === 'recall_sprint';
                        const m = describeScheduledBlock(b);
                        const bc = m.course;
                        const statusPill = m.st.isDebt
                          ? '<span class="badge debt">DEBT</span>'
                          : m.st.timingState === 'live_now'
                          ? '<span class="badge live">LIVE</span>'
                          : isStudy
                          ? '<span class="badge">Queued</span>'
                          : `<span class="badge">${b.blockKind === 'exam' ? 'Exam' : 'Lecture'}</span>`;
                        return `<tr class="${isStudy && m.canLaunch ? 'sched-row-clickable' : ''} ${m.st.isDebt ? 'is-debt-row' : ''}" ${isStudy && m.canLaunch ? `data-sched-start="${esc(b.eventId)}" tabindex="0"` : ''}>
                          <td><span class="${m.st.isDebt ? 'sched-when-debt' : ''}" style="font-size:12.5px;white-space:nowrap">${esc(m.whenLabel)}</span></td>
                          <td>${bc
                            ? `<span class="sched-course-pill compact" style="--sched-accent:${esc(bc.color)}"><i aria-hidden="true"></i><b>${esc(bc.code)}</b> ${esc(bc.shortTitle || '')}</span>`
                            : '<span class="badge">General</span>'}</td>
                          <td>
                            ${m.showTopicPill ? `<div class="sched-mini-topic">${esc(m.topicLabel)}</div>` : ''}
                            <strong>${esc(m.displayTitle)}</strong>
                          </td>
                          <td>${isStudy ? `<span class="diff-badge diff-${m.dlpfc.tier}" data-layout-tier="${m.dlpfc.tier}">${esc(m.dlpfc.label)}</span>` : '<small class="muted">—</small>'}</td>
                          <td>${statusPill}</td>
                          <td style="white-space:nowrap">${
                            isStudy
                              ? `<div class="row-actions" style="gap:5px;justify-content:flex-end">
                                  <button type="button" class="ghost-btn" style="padding:3px 8px;font-size:12px" data-sched-mark-done="${esc(b.eventId)}" title="${m.st.isDebt ? 'Mark debt cleared' : 'Mark completed early'}">✓</button>
                                  ${m.st.isDebt ? `<button type="button" class="ghost-btn" style="padding:3px 8px;font-size:12px" data-sched-dismiss="${esc(b.eventId)}" title="Forgive this overdue block">Skip</button>` : ''}
                                </div>`
                              : '<small class="muted">Fixed</small>'
                          }</td>
                        </tr>`;
                      })
                      .join('')
                  : '<tr><td colspan="6" class="muted">No queued blocks yet — click Plan with Hydrogen or Quick auto-plan above.</td></tr>'
              }
            </tbody>
          </table>
        </div>
        ${doneRows.length ? `
          <details style="margin-top:12px">
            <summary style="cursor:pointer;font-size:13px;font-weight:600">Completed blocks (${doneRows.length}${qState.earlyCount ? ` · ${qState.earlyCount} finished early ✓` : ''})</summary>
            <div class="task-table-wrap" style="margin-top:8px">
              <table class="task-table">
                <tbody>
                  ${doneRows.map((b) => {
                    const m = describeScheduledBlock(b);
                    const bc = m.course;
                    return `<tr>
                      <td><small class="muted">${esc(b.date)} ${esc(b.startLabel || '')}</small></td>
                      <td>${bc ? `<span class="sched-course-pill compact" style="--sched-accent:${esc(bc.color)}"><i aria-hidden="true"></i><b>${esc(bc.code)}</b></span>` : ''}</td>
                      <td><span class="muted" style="text-decoration:line-through">${esc(m.displayTitle)}</span></td>
                      <td><span class="badge good">${m.st.completedEarly ? 'Done early ✓' : 'Done ✓'}</span></td>
                      <td><button type="button" class="ghost-btn" style="padding:2px 8px;font-size:11.5px" data-sched-undo="${esc(b.eventId)}">Undo</button></td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </details>
        ` : ''}
      </div>
    `;

    const edSlot = document.getElementById('sch-ed-feed-slot');
    if (edSlot) renderEdFeedInto(edSlot, { limit: 4, title: 'Ed Discussion' });

    const collectFormPrefs = () => {
      const [bMin, brkMin] = (document.getElementById('sch-rhythm')?.value || '50:10').split(':').map(Number);
      const restDays = [];
      root.querySelectorAll('[data-rest-day]').forEach((cb) => {
        if (cb.checked) restDays.push(Number(cb.dataset.restDay));
      });
      const courseWeights = {};
      root.querySelectorAll('[data-course-weight]').forEach((sel) => {
        courseWeights[sel.dataset.courseWeight] = Number(sel.value);
      });
      const wakeVal = document.getElementById('sch-wake')?.value || '07:30';
      const win = deriveSleepWindow(wakeVal, 8);
      return {
        timeeditUrl: document.getElementById('sch-te-url')?.value.trim() || '',
        weeklyWorkHours: Number(document.getElementById('sch-work-h')?.value || 0),
        autoAdjustStudy: document.getElementById('sch-auto-adjust')?.checked ?? true,
        targetStudyHours: Number(document.getElementById('sch-study-h')?.value || 25),
        wakeTime: win.wakeTime,
        bedTime: win.bedTime,
        blockMinutes: bMin || 50,
        breakMinutes: brkMin || 10,
        restDays,
        courseWeights,
        customNotes: document.getElementById('llm-custom-notes')?.value.trim() || '',
      };
    };

    const refreshEstimateUI = () => {
      const p = collectFormPrefs();
      const e = computeClientStudyEstimate(p.weeklyWorkHours, approxWeeklyClassH, boot.catalog.length || 4);
      const studyInput = document.getElementById('sch-study-h');
      if (studyInput) {
        studyInput.disabled = p.autoAdjustStudy;
        if (p.autoAdjustStudy) studyInput.value = e.recommendedStudyHours;
      }
      const studyH = p.autoAdjustStudy ? e.recommendedStudyHours : p.targetStudyHours;
      const totalH = Math.round((e.weeklyWorkHours + e.weeklyClassHours + studyH) * 10) / 10;
      const workOut = document.getElementById('sch-work-output');
      const studyOut = document.getElementById('sch-study-output');
      if (workOut) workOut.value = `${p.weeklyWorkHours} h`;
      if (studyOut && studyInput) studyOut.value = `${studyInput.value} h`;
      const estBox = document.getElementById('sch-estimate-box');
      if (estBox) {
        estBox.innerHTML = `Classes <b>~${e.weeklyClassHours}h</b> · Study <b>${studyH}h/wk</b> · Total <b>${totalH}h/wk</b>`;
      }
      const win = deriveSleepWindow(p.wakeTime, 8);
      const sleepHint = document.getElementById('sch-sleep-hint');
      if (sleepHint) {
        sleepHint.innerHTML = `8h sleep protected · Bedtime <b>${esc(win.bedTime)}</b> · Study <b>${esc(win.studyStart)}–${esc(win.studyEnd)}</b>`;
      }
    };

    document.getElementById('sch-work-h')?.addEventListener('input', refreshEstimateUI);
    document.getElementById('sch-study-h')?.addEventListener('input', refreshEstimateUI);
    document.getElementById('sch-auto-adjust')?.addEventListener('change', refreshEstimateUI);
    document.getElementById('sch-wake')?.addEventListener('input', refreshEstimateUI);
    refreshEstimateUI();

    document.getElementById('btn-export-schedule').onclick = () => {
      try { window.StudySchedule.download(boot.calendar?.blocks || []); }
      catch (error) { toast(error.message); }
    };
    const calendarPlanInput = document.getElementById('sch-calendar-plan');
    const calendarPlanButton = document.getElementById('btn-import-calendar-plan');
    if (calendarPlanInput && calendarPlanButton) {
      calendarPlanButton.onclick = () => calendarPlanInput.click();
      calendarPlanInput.onchange = async () => {
        const file = calendarPlanInput.files?.[0];
        if (!file) return;
        calendarPlanButton.disabled = true;
        try {
          if (file.size > 2_000_000) throw new Error('Choose an .ics file under 2 MB.');
          const now = Date.now();
          const events = await window.StudySchedule.readCalendar(await file.text(), now, { includeTransparent: true });
          const ws = loadWebState();
          const blocks = window.StudySchedule.importStudyPlan(events, boot.catalog, ws.customSchedule.blocks || [], now);
          const studyCount = blocks.filter(block => block.blockKind === 'study_block').length;
          if (!blocks.length) throw new Error('No upcoming events matched your courses. Start event titles with the course name or code.');
          ws.customSchedule = {
            ...ws.customSchedule,
            enabled: true, source: 'calendar_plan_import', prefs: collectFormPrefs(), blocks,
            estimate: null, updatedAt: new Date().toISOString(),
          };
          saveWebState(ws);
          recomputeWebAnalytics();
          syncCloudProgress().catch(() => {});
          toast(`Imported ${studyCount} study blocks and ${blocks.length - studyCount} exams.`);
          renderScheduleStudio();
        } catch (error) {
          toast(error.message || 'Could not import that calendar.');
        } finally {
          calendarPlanInput.value = '';
          calendarPlanButton.disabled = false;
        }
      };
    }
    document.getElementById('btn-send-desktop-setup')?.addEventListener('click', sendDesktopSetup);
    document.getElementById('btn-save-desktop-setup')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await saveDesktopSetup(Boolean(document.getElementById('desktop-suggest-courses')?.checked)); }
      finally { button.disabled = false; }
    });

    async function resolveFixedTimetableEvents(formPrefs, icsText = '') {
      if (icsText) return window.StudySchedule.readCalendar(icsText);
      if (formPrefs.timeeditUrl) {
        const text = await window.StudyCommunity.fetchTimeEdit(formPrefs.timeeditUrl);
        return window.StudySchedule.readCalendar(text);
      }
      const ws = loadWebState();
      const existing = (ws.customSchedule?.blocks || [])
        .filter((b) => ['class_session', 'exam'].includes(b.blockKind) && Date.parse(b.endIso) > Date.now());
      if (existing.length) {
        return existing.map((b) => ({
          uid: b.eventId,
          summary: b.summary,
          start: Date.parse(b.startIso),
          end: Date.parse(b.endIso),
          allDay: b.allDay,
          kind: b.blockKind,
          courseId: b.courseId || '',
        }));
      }
      if (isStaticWeb && window.StudyCommunity?.isSignedIn?.()) {
        try {
          const feed = await window.StudyCommunity.fetchExtensionTimeEdit();
          if (feed?.hasFeed && feed.calendar) {
            return await window.StudySchedule.readCalendar(feed.calendar);
          }
        } catch {}
      }
      return [];
    }

    const hydrogenBtn = document.getElementById('btn-hydrogen-sched');
    if (hydrogenBtn) {
      hydrogenBtn.onclick = async () => {
        if (!window.StudyCommunity?.enabled) {
          toast('Hydrogen planner needs the online API — use Quick auto-plan here.');
          return;
        }
        if (!window.StudyCommunity.isSignedIn?.()) {
          window.StudyCommunity.requireProfile?.('Sign in to plan with Gemini 4 Hydrogen, or use Quick auto-plan.');
          return;
        }
        const statusEl = document.getElementById('sch-plan-status');
        hydrogenBtn.disabled = true;
        hydrogenBtn.textContent = 'Planning with Hydrogen…';
        if (statusEl) statusEl.textContent = 'Reading synced timetable & building 2-week plan…';
        try {
          const formPrefs = collectFormPrefs();
          window.StudySchedule.bounds(formPrefs.wakeTime, formPrefs.bedTime);
          const fileEl = document.getElementById('sch-ics-file');
          const file = fileEl?.files?.[0];
          if (file && file.size > 2_000_000) throw new Error('Choose an .ics file under 2 MB.');
          const icsText = file ? await file.text() : '';
          const fixed = await resolveFixedTimetableEvents(formPrefs, icsText);

          const fixedEvents = fixed
            .filter((ev) => !ev.allDay && Number.isFinite(ev.start) && Number.isFinite(ev.end) && ev.end > Date.now())
            .slice(0, 60)
            .map((ev) => {
              const sd = new Date(ev.start);
              const ed = new Date(ev.end);
              const dateStr = `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, '0')}-${String(sd.getDate()).padStart(2, '0')}`;
              return {
                date: dateStr,
                startTime: `${String(sd.getHours()).padStart(2, '0')}:${String(sd.getMinutes()).padStart(2, '0')}`,
                endTime: `${String(ed.getHours()).padStart(2, '0')}:${String(ed.getMinutes()).padStart(2, '0')}`,
                summary: String(ev.summary || 'Class').slice(0, 80),
                kind: /\b(eksamen|exam|midterm|final)\b/i.test(ev.summary || '') || ev.kind === 'exam' ? 'exam' : 'class',
              };
            });

          const weeklyClassH = fixedEvents.length ? Math.max(2, Math.round((fixedEvents.length * 1.75) / 2)) : approxWeeklyClassH;
          const liveEst = computeClientStudyEstimate(formPrefs.weeklyWorkHours, weeklyClassH, boot.catalog.length || 4);
          const targetStudyHours = formPrefs.autoAdjustStudy ? liveEst.recommendedStudyHours : formPrefs.targetStudyHours;
          const nowDate = new Date();
          const startDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' }).format(nowDate);
          const currentTime = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Oslo',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(nowDate);

          const coursesPayload = (boot.catalog || []).slice(0, 12).map((c) => {
            const cp = boot.analytics?.courseProgress?.[c.courseId] || {};
            return {
              courseId: c.courseId,
              code: c.code || '',
              title: c.shortTitle || c.title || '',
              examDate: c.examInfo?.date || '',
              done: Number(cp.done || 0),
              total: Number(c.questionCount || 0),
              weight: Number(formPrefs.courseWeights?.[c.courseId] ?? 1.0),
              topics: (c.topics || []).slice(0, 6).map((t) => String(t.title || '').slice(0, 60)).filter(Boolean),
            };
          });

          const res = await window.StudyCommunity.generateAiSchedule({
            wakeTime: formPrefs.wakeTime,
            sleepHours: 8,
            weeklyWorkHours: formPrefs.weeklyWorkHours,
            targetStudyHours,
            blockMinutes: formPrefs.blockMinutes,
            breakMinutes: formPrefs.breakMinutes,
            restDays: formPrefs.restDays,
            notes: formPrefs.customNotes,
            startDate,
            currentTime,
            horizonDays: 14,
            courses: coursesPayload,
            fixedEvents,
            deadlines: due.slice(0, 12).map((d) => ({
              date: String(d.dueAt || '').slice(0, 10),
              name: d.name,
              course: d.course,
            })),
          });

          const fixedBlocks = fixed
            .filter((ev) => !ev.allDay && Number.isFinite(ev.start) && Number.isFinite(ev.end) && ev.end > Date.now())
            .map((ev, i) => {
              const sd = new Date(ev.start);
              const ed = new Date(ev.end);
              const isExam = /\b(eksamen|exam|midterm|final)\b/i.test(ev.summary || '') || ev.kind === 'exam';
              const matchCourse = (boot.catalog || []).find((c) =>
                String(ev.summary || '').toLowerCase().includes((c.code || '').toLowerCase()) ||
                (c.shortTitle && String(ev.summary || '').toLowerCase().includes(c.shortTitle.toLowerCase()))
              );
              return {
                eventId: ev.uid || `te-fixed-${i + 1}`,
                summary: ev.summary || (isExam ? 'Exam' : 'Lecture'),
                date: `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, '0')}-${String(sd.getDate()).padStart(2, '0')}`,
                startIso: sd.toISOString(),
                endIso: ed.toISOString(),
                startLabel: `${String(sd.getHours()).padStart(2, '0')}:${String(sd.getMinutes()).padStart(2, '0')}`,
                endLabel: `${String(ed.getHours()).padStart(2, '0')}:${String(ed.getMinutes()).padStart(2, '0')}`,
                focusMinutes: Math.max(15, Math.round((ed - sd) / 60_000)),
                attemptBudgetMinutes: 0,
                courseId: ev.courseId || matchCourse?.courseId || '',
                blockKind: isExam ? 'exam' : 'class_session',
                timingState: 'upcoming',
              };
            });

          const nowThresholdMs = Date.now();
          const aiBlocks = (res.blocks || [])
            .map((b, i) => {
              const sd = new Date(`${b.date}T${b.startTime}:00`);
              const ed = new Date(`${b.date}T${b.endTime}:00`);
              if (!Number.isFinite(sd.getTime()) || !Number.isFinite(ed.getTime()) || ed.getTime() <= nowThresholdMs) {
                return null;
              }
              const dur = Math.max(20, Math.round((ed - sd) / 60_000));
              return {
                eventId: `hydrogen-${b.date}-${b.startTime.replace(':', '')}-${i + 1}`,
                summary: b.title || 'Focused study block',
                date: b.date,
                startIso: sd.toISOString(),
                endIso: ed.toISOString(),
                startLabel: b.startTime,
                endLabel: b.endTime,
                focusMinutes: dur,
                attemptBudgetMinutes: Math.round(dur * 0.85),
                courseId: b.courseId || boot.catalog[0]?.courseId || '',
                dlpfcMode: b.dlpfcMode || 'high_dlpfc',
                profile: b.profile === 'exam' ? 'exam' : 'learning',
                blockKind: 'study_block',
                timingState: 'upcoming',
              };
            })
            .filter(Boolean);

          const mergedBlocks = [...fixedBlocks, ...aiBlocks].sort(
            (a, b) => Date.parse(a.startIso || '') - Date.parse(b.startIso || '')
          );

          const ws = loadWebState();
          ws.customSchedule = {
            ...ws.customSchedule,
            enabled: true,
            source: 'gemini_hydrogen_schedule',
            prefs: formPrefs,
            blocks: mergedBlocks,
            estimate: liveEst,
            aiSummary: res.summary || '',
            modelLabel: res.modelLabel || 'Gemini 4 Hydrogen',
            updatedAt: new Date().toISOString(),
          };
          saveWebState(ws);
          recomputeWebAnalytics();
          syncCloudProgress().catch(() => {});
          toast(`Planned ${aiBlocks.length} study blocks with ${res.modelLabel || 'Gemini 4 Hydrogen'}${fixedBlocks.length ? ` around ${fixedBlocks.length} classes` : ''}.`);
          renderScheduleStudio();
        } catch (err) {
          if (statusEl) statusEl.textContent = '';
          toast(err?.message || 'Could not generate Hydrogen schedule — try Quick auto-plan.');
        } finally {
          if (hydrogenBtn.isConnected) {
            hydrogenBtn.disabled = false;
            hydrogenBtn.textContent = isHydrogenPlan ? 'Update with Hydrogen' : 'Plan with Hydrogen';
          }
        }
      };
    }

    document.getElementById('btn-generate-sched').onclick = async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      const formPrefs = collectFormPrefs();
      const fileEl = document.getElementById('sch-ics-file');
      try {
        window.StudySchedule.bounds(formPrefs.wakeTime, formPrefs.bedTime);
        const file = fileEl?.files?.[0];
        if (file && file.size > 2_000_000) throw new Error('Choose an .ics file under 2 MB.');
        const icsText = file ? await file.text() : '';
        if (file) formPrefs.timeeditUrl = '';
        if (isStaticWeb) {
          const fixed = await resolveFixedTimetableEvents(formPrefs, icsText);
          const plan = window.StudySchedule.plan(fixed, formPrefs, boot.catalog, boot.analytics?.courseProgress || {}, computeClientStudyEstimate);
          if (!plan.blocks.length) throw new Error('No time fits these settings. Adjust your wake-up time or rest days.');
          const ws = loadWebState();
          ws.customSchedule = {
            ...ws.customSchedule,
            enabled: true, source: 'timeedit_auto_scheduler', prefs: formPrefs, blocks: plan.blocks,
            estimate: plan.estimate, aiSummary: '', updatedAt: new Date().toISOString(),
          };
          saveWebState(ws);
          recomputeWebAnalytics();
          syncCloudProgress().catch(() => {});
          toast(`Scheduled ${plan.studyCount} study blocks around ${fixed.length} calendar events.`);
        } else {
          const res = await apiPost('/api/schedule/generate', { prefs: formPrefs, icsText });
          if (res.bootstrap) boot = res.bootstrap;
          toast(`Scheduled ${res.studyCount ?? res.blockCount ?? 0} study blocks.`);
        }
        renderScheduleStudio();
      } catch (err) {
        toast(err.message || 'Could not build the schedule.');
      } finally {
        button.disabled = false;
      }
    };

    document.getElementById('btn-copy-llm-prompt')?.addEventListener('click', async () => {
      const promptTxt = buildUniversalLlmSchedulePrompt(
        collectFormPrefs(),
        document.getElementById('llm-custom-notes')?.value.trim() || ''
      );
      try {
        await navigator.clipboard.writeText(promptTxt);
        toast('Copied Universal LLM Schedule Prompt! Paste it into any LLM.');
      } catch {
        const box = document.getElementById('llm-paste-box');
        if (box) box.value = promptTxt;
        toast('Placed prompt in text box — copy and send to your LLM!');
      }
    });

    document.getElementById('btn-apply-llm-sched')?.addEventListener('click', async () => {
      const raw = document.getElementById('llm-paste-box')?.value.trim() || '';
      if (!raw) {
        toast('Paste the JSON or .ics output from your LLM first.');
        return;
      }
      if (isStaticWeb) {
        try {
          const blocks = parseClientSchedulePayload(raw);
          const ws = loadWebState();
          ws.customSchedule = { enabled: true, source: 'llm_universal_import', prefs: collectFormPrefs(), blocks, aiSummary: '', updatedAt: new Date().toISOString() };
          saveWebState(ws);
          recomputeWebAnalytics();
          syncCloudProgress().catch(() => {});
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
    });

    document.getElementById('btn-reset-custom-sched')?.addEventListener('click', async () => {
      if (isStaticWeb) {
        const ws = loadWebState();
        ws.customSchedule = { enabled: false, prefs: {}, blocks: [], aiSummary: '', updatedAt: new Date().toISOString() };
        saveWebState(ws);
        await refreshBootstrap(false);
        syncCloudProgress().catch(() => {});
        return;
      }
      const res = await apiPost('/api/schedule/import-llm', { action: 'reset' });
      if (res.bootstrap) boot = res.bootstrap;
      toast('Reverted to default calendar feed.');
      renderScheduleStudio();
    });

    document.getElementById('btn-pair-sync-ext')?.addEventListener('click', () => openBiSyncHub());

    async function applyExtensionTimeEdit(silent = false) {
      if (!isStaticWeb || !window.StudyCommunity?.isSignedIn?.()) {
        if (!silent) toast('Sign in to your Study-OS profile first.');
        return;
      }
      try {
        const activePlan = loadWebState().customSchedule;
        if (silent && activePlan.enabled && activePlan.source !== 'timeedit_extension_sync') return;
        const feed = await window.StudyCommunity.fetchExtensionTimeEdit();
        if (!feed?.hasFeed || !feed.calendar) {
          if (!silent) toast('No TimeEdit timetable synced from the extension yet. Open TimeEdit or TP in Chrome and click Study-OS Sync.');
          return;
        }
        const formPrefs = collectFormPrefs();
        const fixed = await window.StudySchedule.readCalendar(feed.calendar);
        const plan = window.StudySchedule.plan(fixed, formPrefs, boot.catalog, boot.analytics?.courseProgress || {}, computeClientStudyEstimate);
        if (!plan.blocks.length) return;
        const ws = loadWebState();
        const lastApplied = Number(localStorage.getItem('study-os-ext-te-ts') || 0);
        if (silent && (feed.updatedAt <= lastApplied ||
            (ws.customSchedule.enabled && ws.customSchedule.source !== 'timeedit_extension_sync'))) return;
        ws.customSchedule = {
          ...ws.customSchedule,
          enabled: true, source: 'timeedit_extension_sync', prefs: formPrefs, blocks: plan.blocks,
          estimate: plan.estimate, updatedAt: new Date().toISOString(),
        };
        saveWebState(ws);
        try { localStorage.setItem('study-os-ext-te-ts', String(feed.updatedAt || Date.now())); } catch {}
        recomputeWebAnalytics();
        syncCloudProgress().catch(() => {});
        toast(`Synced TimeEdit from extension (${plan.studyCount} blocks around ${fixed.length} classes).`);
        renderScheduleStudio();
      } catch (err) {
        if (!silent) toast(err.message || 'Could not import TimeEdit from extension.');
      }
    }

    document.getElementById('btn-pull-ext-timeedit')?.addEventListener('click', () => applyExtensionTimeEdit(false));
    if (isStaticWeb && window.StudyCommunity?.isSignedIn?.()) {
      applyExtensionTimeEdit(true);
    }

    root.querySelectorAll('[data-sched-start]').forEach((row) => {
      const go = () => {
        const blk = (boot.calendar?.blocks || []).find((b) => b.eventId === row.dataset.schedStart);
        if (blk) launchCalendarBlock(blk);
      };
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('button, a')) return;
        go();
      });
      row.addEventListener('keydown', (ev) => {
        if ((ev.key === 'Enter' || ev.key === ' ') && !ev.target.closest('button, a')) {
          ev.preventDefault();
          go();
        }
      });
    });
    root.querySelectorAll('[data-sched-mark-done]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const blk = (boot.calendar?.blocks || []).find((b) => b.eventId === btn.dataset.schedMarkDone);
        if (blk) setScheduleBlockCompleted(blk.eventId, true, blk, 'manual');
      });
    });
    root.querySelectorAll('[data-sched-undo]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const blk = (boot.calendar?.blocks || []).find((b) => b.eventId === btn.dataset.schedUndo);
        setScheduleBlockCompleted(btn.dataset.schedUndo, false, blk, 'manual');
      });
    });
    root.querySelectorAll('[data-sched-dismiss]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dismissScheduleDebt(btn.dataset.schedDismiss);
      });
    });
    document.getElementById('btn-forgive-all-debt')?.addEventListener('click', () => {
      const ids = qState.debtBlocks.map((b) => b.eventId);
      if (ids.length) dismissScheduleDebt(ids);
    });
  }

  // ---------------------------------------------------------------------------
  async function renderCourseDirectory() {
    try {
      const items = await window.StudyCommunity.approvedCourses();
      const root = document.getElementById('community-course-directory');
      const grid = root.querySelector('.courses-grid');
      const currentIds = new Set(boot.catalog.map(course => String(course.canvasId || course.courseId?.split('-').pop() || '')));
      const currentCodes = new Set(boot.catalog.map(course => (course.code || '').toUpperCase().replace(/[\s-]+/g, '')));
      const shown = items.filter(course => {
        const hasCanvas = /^[1-9][0-9]{0,19}$/.test(course.canvasId || '');
        const hasEd = /^[1-9][0-9]{0,19}$/.test(course.edCourseId || '');
        if (!hasCanvas && !hasEd) return false;
        const origin = safeCanvasOrigin(course.canvasOrigin || '');
        const isBi = origin === 'https://canvas.bi.no' || origin === 'https://bi.instructure.com';
        if (hasCanvas && isBi && currentIds.has(course.canvasId)) return false;
        if (course.code && currentCodes.has(course.code.toUpperCase().replace(/[\s-]+/g, ''))) return false;
        return true;
      });
      grid.innerHTML = shown.map((course, idx) => {
        const topics = Array.isArray(course.topics) ? course.topics : [];
        const contrib = Number(course.contributorCount || 1);
        const origin = safeCanvasOrigin(course.canvasOrigin || '');
        const schoolName = (typeof course.school === 'string' && course.school.trim())
          ? course.school.trim()
          : schoolLabelForCanvasOrigin(origin);
        const topicsHtml = topics.length
          ? `<div class="community-course-topics">${topics.slice(0, 5).map(t => `<span class="topic-mini-chip">${esc(t)}</span>`).join('')}${topics.length > 5 ? `<span class="topic-mini-chip">+${topics.length - 5}</span>` : ''}</div>`
          : '';
        const edHost = /^(?:[a-z]{2}\.)?edstem\.org$/.test(course.edHost || '') ? course.edHost : 'eu.edstem.org';
        return `<article class="course-card">
          <div>
            <div class="row-between" style="margin:0 0 8px;gap:6px">
              <span class="course-code-pill">${esc(course.code || `${schoolName} Course`)}</span>
              <div class="row-actions" style="gap:5px">
                ${schoolName ? `<span class="course-school-pill">${esc(schoolName)}</span>` : ''}
                <span class="badge ${course.verified ? 'good' : ''}">${course.verified ? 'Verified' : 'Community'}</span>
              </div>
            </div>
            <h3 class="course-card-title" style="cursor:default">${esc(course.title)}</h3>
            <p class="muted course-contrib-meta">${contrib} student${contrib === 1 ? '' : 's'} synced${topics.length ? ` · ${topics.length} module${topics.length === 1 ? '' : 's'}` : ''}</p>
            ${topicsHtml}
          </div>
          <div class="course-actions">
            <button type="button" class="primary-btn" data-comm-gen="${idx}">Study Set</button>
            <button type="button" class="ghost-btn" data-comm-ai="${idx}">Al</button>
            ${/^[1-9][0-9]{0,19}$/.test(course.canvasId || '') ? `<a class="ghost-btn" target="_blank" rel="noopener" href="${esc(origin)}/courses/${course.canvasId}">Canvas ↗</a>` : ''}
            ${/^[1-9][0-9]{0,19}$/.test(course.edCourseId || '') ? `<a class="ghost-btn" target="_blank" rel="noopener" href="https://${edHost}/courses/${course.edCourseId}">Ed ↗</a>` : ''}
          </div>
        </article>`;
      }).join('');
      grid.querySelectorAll('[data-comm-gen]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const course = shown[Number(btn.dataset.commGen)];
          if (!course || !window.StudySets?.openGenerator) return;
          window.StudySets.openGenerator({
            courseCode: course.code || '',
            courseTitle: course.title || '',
            school: course.school || '',
            topics: Array.isArray(course.topics) ? course.topics : [],
          });
        });
      });
      grid.querySelectorAll('[data-comm-ai]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const course = shown[Number(btn.dataset.commAi)];
          if (course && window.StudyAiTutor?.openForCourse) window.StudyAiTutor.openForCourse(course);
        });
      });
      root.hidden = !shown.length;
    } catch {}
  }

  // STATE MUTATIONS (Local Python Server + Static Web Browser Fallback)
  // ---------------------------------------------------------------------------
  async function setQuestionStatus(questionIds, status, resetWork = false) {
    if (isDevSandbox()) return;
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
      if (saveWebState(ws)) {
        window.StudyCommunity.queueStatsSync();
        queueCloudSync();
      }
      recomputeWebAnalytics();
      updateHeaderStats();
      return;
    }
    await apiPost('/api/progress/status', { questionIds, status, resetWork });
  }

  async function saveDraft(questionId, fields) {
    if (isDevSandbox()) return;
    const ws = isStaticWeb ? loadWebState() : null;
    const records = ws ? ws.records : boot.progress.records;
    const rec = (records[questionId] = records[questionId] || {});
    Object.assign(rec, {
      ...(fields.draft !== undefined ? { savedDraft: fields.draft } : {}),
      ...(fields.choice !== undefined ? { savedChoice: fields.choice } : {}),
      ...(fields.wiseflowAnswers !== undefined ? { savedWiseflow: fields.wiseflowAnswers } : {}),
      ...(fields.draftImages !== undefined ? { savedDraftImages: Array.isArray(fields.draftImages) ? fields.draftImages.slice(0, 8) : [] } : {}),
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
    if (isDevSandbox()) return;
    const pending = pendingDrafts.get(questionId);
    if (pending) clearTimeout(pending.timer);
    const next = { fields: { ...pending?.fields, ...fields } };
    next.timer = setTimeout(() => {
      pendingDrafts.delete(questionId);
      saveDraft(questionId, next.fields);
    }, 450);
    pendingDrafts.set(questionId, next);
  }

  function flushPendingDrafts() {
    for (const [qid, pending] of pendingDrafts) {
      clearTimeout(pending.timer);
      saveDraft(qid, pending.fields);
    }
    pendingDrafts.clear();
  }

  async function logAttempt(payload) {
    if (isDevSandbox()) {
      const qAcc = Number(payload.qualityAccuracy || 0);
      const effSec = Number(payload.activeSec || 1) + Number(payload.hintsUsed || 0) * Number(payload.hintHandicapSec || 30);
      const aiSec = Number(payload.aiParSec || 120);
      const beatAi = qAcc >= 0.85 && Number(payload.hintsUsed || 0) === 0 && !payload.assisted && effSec <= aiSec;
      const autoGraded = isAutoGradedAttempt(payload);
      const maxPr = autoGraded ? 1.5 : 1.0;
      const paceRatio = qAcc < 0.6 ? 0.35 : Math.min(maxPr, aiSec / Math.max(1, effSec));
      const timestamp = new Date().toISOString();
      const attempt = { ...payload, timestamp, qualityAccuracy: qAcc, effectiveSec: effSec, beatAi, paceRatio, devMode: true };
      const record = { status: payload.explicitStatus || (qAcc >= 0.75 ? 'done' : 'revisit'), devMode: true };
      return { ok: true, devMode: true, attempt, record, analytics: boot.analytics };
    }
    if (isStaticWeb) {
      const ws = loadWebState();
      const qAcc = Number(payload.qualityAccuracy || 0);
      const effSec = Number(payload.activeSec || 1) + Number(payload.hintsUsed || 0) * Number(payload.hintHandicapSec || 30);
      const aiSec = Number(payload.aiParSec || 120);
      const beatAi = qAcc >= 0.85 && Number(payload.hintsUsed || 0) === 0 && !payload.assisted && effSec <= aiSec;
      const autoGraded = isAutoGradedAttempt(payload);
      const maxPr = autoGraded ? 1.5 : 1.0;
      const paceRatio = qAcc < 0.6 ? 0.35 : Math.min(maxPr, aiSec / Math.max(1, effSec));
      const verificationTier = payload.verificationTier || (
        autoGraded
          ? 'auto_graded'
          : (payload.source === 'ide_companion' || payload.ideVerified)
          ? 'ide_verified'
          : (aiSec >= 120 && effSec < aiSec * 0.12)
          ? 'fast_flag'
          : 'self_verified'
      );
      const rec = (ws.records[payload.questionId] = ws.records[payload.questionId] || {});
      const timestamp = new Date().toISOString();
      rec.status = payload.explicitStatus || (qAcc >= 0.75 ? 'done' : 'revisit');
      if (payload.dlpfcTier) rec.dlpfcTier = Number(payload.dlpfcTier);
      rec.updatedAt = timestamp;
      rec.lastAttemptAt = timestamp;
      rec.attemptCount = (rec.attemptCount || 0) + 1;
      if (beatAi) rec.beatAiCount = (rec.beatAiCount || 0) + 1;
      if (qAcc >= 0.85 && (!rec.pbEffectiveSec || effSec < rec.pbEffectiveSec)) rec.pbEffectiveSec = effSec;
      const daysOut = qAcc >= 0.85 ? 4 : 1;
      delete rec.lastUserGrade;
      rec.fsrs = {
        reps: (rec.fsrs?.reps || 0) + 1,
        stability: daysOut,
        scheduledDays: daysOut,
        lastGrade: qAcc >= 0.85 ? 3 : 1,
        due: new Date(Date.now() + daysOut * 86400000).toISOString(),
      };
      const attempt = { ...payload, timestamp, qualityAccuracy: qAcc, effectiveSec: effSec, beatAi, paceRatio, verificationTier };
      ws.attempts.push(attempt);
      const saved = saveWebState(ws);
      if (saved) {
        window.StudyCommunity.queueStatsSync();
        const cMeta = (boot.catalog || []).find((c) => c.courseId === payload.courseId);
        const actLabel = cMeta ? `${cMeta.code} · ${cMeta.shortTitle || cMeta.title}` : '';
        window.StudyRooms.recordAttempt(actLabel);
        queueCloudSync();
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
    if (isDevSandbox()) {
      return { ok: true, devMode: true, analytics: boot.analytics };
    }
    if (isStaticWeb) {
      const ws = loadWebState();
      const rec = (ws.records[questionId] = ws.records[questionId] || {});
      const grade = Math.max(1, Math.min(4, Math.round(Number(fsrsGrade) || 3)));
      const prevStab = Math.max(1, Number(rec.fsrs?.stability) || 1);
      const scheduledDays = grade === 1
        ? 1
        : grade === 2
        ? Math.max(1, Math.min(3, Math.round(prevStab * 0.6) || 2))
        : grade === 3
        ? Math.max(3, Math.round(prevStab * 1.5))
        : Math.max(7, Math.round(prevStab * 2.5));
      rec.lastUserGrade = grade;
      rec.personalDifficulty = grade <= 2 ? 3 : grade === 4 ? 1 : 2;
      if (grade === 1) {
        rec.status = 'revisit';
      } else if (!rec.status || rec.status === 'not_started' || rec.status === 'revisit') {
        rec.status = 'done';
      }
      rec.fsrs = {
        ...(rec.fsrs || {}),
        reps: Math.max(1, Number(rec.fsrs?.reps || 0)),
        lastGrade: grade,
        scheduledDays,
        stability: scheduledDays,
        due: new Date(Date.now() + scheduledDays * 86_400_000).toISOString(),
      };
      rec.updatedAt = new Date().toISOString();
      saveWebState(ws);
      queueCloudSync();
      recomputeWebAnalytics();
      updateHeaderStats();
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
    const earnedCompletion = Boolean(
      payload?.calendarEventId && (Number(payload.reviewedCount || 0) > 0 || Number(payload.activeSec || 0) >= 60)
    );
    const matchedBlk = earnedCompletion
      ? (boot.calendar?.blocks || []).find((b) => b.eventId === payload.calendarEventId) || null
      : null;

    if (isDevSandbox()) {
      if (earnedCompletion) setScheduleBlockCompleted(payload.calendarEventId, true, matchedBlk, 'session');
      return { ok: true, devMode: true, analytics: boot.analytics };
    }
    if (isStaticWeb) {
      const ws = loadWebState();
      ws.sessions.push({ ...payload, endedAt: new Date().toISOString() });
      saveWebState(ws);
      if (earnedCompletion) {
        setScheduleBlockCompleted(payload.calendarEventId, true, matchedBlk, 'session');
      } else {
        queueCloudSync();
        recomputeWebAnalytics();
      }
      return { ok: true, analytics: boot.analytics };
    }
    const res = await apiPost('/api/session', payload);
    if (earnedCompletion) setScheduleBlockCompleted(payload.calendarEventId, true, matchedBlk, 'session');
    return res;
  }

  function exportBackupFile() {
    if (!isStaticWeb) {
      window.location.href = '/api/export-backup';
      return;
    }
    flushPendingDrafts();
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

  function bindCommandPalette() {
    const dialog = document.getElementById('cmd-palette-dialog');
    const input = document.getElementById('cmd-palette-input');
    const list = document.getElementById('cmd-palette-results');
    if (!dialog || !input || !list) return;
    let items = [];
    let selectedIdx = 0;

    function buildItems() {
      const out = [];
      const leaveRunner = () => {
        if (!document.getElementById('view-runner')?.hidden) {
          document.getElementById('run-exit-btn')?.click();
        }
      };
      for (const c of boot.catalog || []) {
        const mLocked = isCourseInMaintenanceForUser(c.courseId);
        const mInfo = getCourseMaintenance(c.courseId);
        out.push({
          group: 'Courses',
          title: `${c.code} · ${c.title}`,
          sub: mLocked ? `${mInfo.badge} · ${mInfo.eta}` : `${c.questionCount} questions · Topics & practice`,
          keywords: `${c.code} ${c.title} ${c.shortTitle} course topics practice`,
          run: () => { leaveRunner(); navigate('course', { courseId: c.courseId }); },
        });
        out.push({
          group: 'Exams',
          title: `${c.code} Mock Exams`,
          sub: mLocked ? `${mInfo.badge} · ${mInfo.eta}` : (c.examInfo?.date ? `Exam ${c.examInfo.date}` : c.shortTitle),
          keywords: `${c.code} ${c.title} exam mock paper`,
          run: () => { leaveRunner(); navigate('exams', { focusCourseId: c.courseId }); },
        });
      }
      for (const r of boot.references || []) {
        out.push({
          group: 'Course Notes',
          title: r.title,
          sub: `${r.code} · ${r.semester || 'Reference'}`,
          keywords: `${r.code} ${r.title} notes reference formula`,
          run: () => { leaveRunner(); navigate('references', { refFile: r.file }); },
        });
      }
      const views = [
        ['Home', 'home', 'courses dashboard'],
        ['Notes', 'references', 'reference sheets formulas'],
        ['Exams', 'exams', 'mock exams past papers'],
        ['Courses', 'course', 'topics explorer filter'],
        ['Schedule', 'schedule', 'timeedit calendar planner'],
        ['Metrics', 'analytics', 'upi telemetry analytics ai brief'],
      ];
      if (window.StudyCommunity?.enabled) {
        views.push(['Community', 'community', 'leaderboard chat rooms profile ed discussion forum']);
        out.push({
          group: 'Views',
          title: 'Ed Discussion',
          sub: 'Course Q&A forums, categories & pinned Ed links inside Community',
          keywords: 'ed discussion edstem forum qa questions community',
          run: async () => {
            leaveRunner();
            await navigate('community');
            document.getElementById('community-ed-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        });
      }
      for (const [label, viewId, kw] of views) {
        out.push({
          group: 'Views',
          title: label,
          sub: `Go to ${label}`,
          keywords: `${label} ${kw}`,
          run: () => { leaveRunner(); navigate(viewId); },
        });
      }
      if (window.StudyUI?.devMode?.isAllowed?.()) {
        out.push({
          group: 'Actions',
          title: window.StudyUI.devMode.isActive() ? 'Exit Dev Mode (Restore Real Tracking)' : 'Enter Dev Mode (Sandbox)',
          sub: 'Freeze scores, UPI, break timer & cloud sync while testing',
          keywords: 'dev mode sandbox test debug freeze score break',
          run: () => window.StudyUI.devMode.toggle(),
        });
      }
      out.push(
        {
          group: 'Actions',
          title: 'Sync BI (Canvas · TimeEdit · Ed)',
          sub: 'Pair 1-click Chrome extension for courses, deadlines & schedule',
          keywords: 'canvas sync timeedit ed discussion chrome extension pair code bi',
          run: () => openBiSyncHub(),
        },
        {
          group: 'Actions',
          title: 'Study Playbook',
          sub: 'DLPFC energy routing, working blocks & study habits',
          keywords: 'study playbook habits dlpfc guide reading method',
          run: () => window.StudyPlaybook?.open?.(),
        },
        {
          group: 'Actions',
          title: 'Open Settings',
          sub: 'Appearance, sound, Adamlite & backup (,)',
          keywords: 'settings preferences theme sound backup',
          run: () => window.StudyUI.openSettings?.(),
        },
        {
          group: 'Actions',
          title: 'Cycle Appearance (System / Light / Dark)',
          sub: 'Switch color theme or follow OS',
          keywords: 'dark light bright system auto theme appearance mode',
          run: () => {
            const next = window.StudyUI.toggleTheme?.();
            if (next) toast(`Appearance: ${next[0].toUpperCase()}${next.slice(1)}`);
          },
        },
        {
          group: 'Actions',
          title: 'Use System Appearance',
          sub: 'Follow OS Light / Dark mode automatically',
          keywords: 'system auto default theme appearance bright dark light',
          run: () => {
            window.StudyUI.setTheme?.('system');
            toast('Appearance: System');
          },
        },
        {
          group: 'Actions',
          title: 'Toggle Background Sound',
          sub: 'Play or mute focus soundscape (M)',
          keywords: 'sound noise brown pink rain focus audio mute',
          run: () => {
            const on = window.StudyUI.soundMasker?.toggle?.();
            toast(on ? `Sound: ${window.StudyUI.soundMasker.getSummaryLabel()}` : 'Sound off');
          },
        },
        {
          group: 'Actions',
          title: 'Adamlite AI Chat',
          sub: 'Ask Adamlite about any question, formula, or mistake (T)',
          keywords: 'adamlite al ai tutor chat assistant history',
          run: () => window.StudyAiTutor?.toggle?.(),
        },
        ...(window.StudyCommunity?.enabled ? [{
          group: 'Actions',
          title: '⚔️ Challenge Classmate to Duel',
          sub: 'Send a break-aware 1v1 BI duel invite (pops up with 1 min left on their break)',
          keywords: 'duel challenge invite battle 1v1 classmate elo break',
          run: () => window.StudyDuels?.openChallengeModal?.(),
        }] : []),
        {
          group: 'Actions',
          title: 'Desktop MCP Bridge',
          sub: 'Live MCP exercise sharing & desktop setup',
          keywords: 'adamlite al ai tutor mcp claude codex prompt',
          run: () => window.StudyTutor?.open?.(),
        },
        ...(window.StudyPdfCraft?.isAvailable?.() ? [{
          group: 'Tools',
          title: 'PdfCraft PDF Editor',
          sub: 'Edit, highlight, annotate, sign, merge, or OCR any PDF (Rust WASM)',
          keywords: 'pdf pdfcraft edit annotate highlight sign merge split ocr redact compress',
          run: () => window.StudyPdfCraft.openBlank(),
        }] : []),
        {
          group: 'Actions',
          title: 'Export Backup',
          sub: 'Download study progress as JSON',
          keywords: 'export backup json download save',
          run: () => { exportBackupFile(); toast('Exported Study-OS backup.'); },
        }
      );
      return out;
    }

    function renderList() {
      const q = input.value.trim().toLowerCase();
      const all = buildItems();
      items = q
        ? all.filter((it) => `${it.title} ${it.sub} ${it.keywords}`.toLowerCase().includes(q)).slice(0, 14)
        : all.slice(0, 12);
      selectedIdx = Math.min(selectedIdx, Math.max(0, items.length - 1));
      if (!items.length) {
        list.innerHTML = '<p class="cmd-empty muted">No matching courses, notes, or actions.</p>';
        return;
      }
      list.innerHTML = items.map((it, idx) => `
        <button type="button" class="cmd-item ${idx === selectedIdx ? 'active' : ''}" data-cmd-idx="${idx}" role="option" aria-selected="${idx === selectedIdx ? 'true' : 'false'}">
          <span class="cmd-item-copy">
            <strong>${esc(it.title)}</strong>
            <small class="muted">${esc(it.sub)}</small>
          </span>
          <span class="cmd-group-pill">${esc(it.group)}</span>
        </button>
      `).join('');
      list.querySelectorAll('[data-cmd-idx]').forEach((btn) => {
        btn.addEventListener('click', () => runItem(Number(btn.dataset.cmdIdx)));
        btn.addEventListener('mouseenter', () => {
          selectedIdx = Number(btn.dataset.cmdIdx);
          updateActive();
        });
      });
    }

    function updateActive() {
      list.querySelectorAll('[data-cmd-idx]').forEach((btn, idx) => {
        const active = idx === selectedIdx;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
        if (active) btn.scrollIntoView({ block: 'nearest' });
      });
    }

    function runItem(idx) {
      const chosen = items[idx];
      if (!chosen) return;
      dialog.close();
      chosen.run();
    }

    function openPalette() {
      if (document.getElementById('break-modal')?.open) return;
      window.StudyUI.closeSettings?.();
      input.value = '';
      selectedIdx = 0;
      renderList();
      if (!dialog.open) dialog.showModal();
      input.focus();
    }

    input.addEventListener('input', () => {
      selectedIdx = 0;
      renderList();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (items.length) { selectedIdx = (selectedIdx + 1) % items.length; updateActive(); }
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (items.length) { selectedIdx = (selectedIdx - 1 + items.length) % items.length; updateActive(); }
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        runItem(selectedIdx);
      }
    });
    dialog.addEventListener('click', (ev) => {
      if (ev.target === dialog) dialog.close();
    });
    document.getElementById('hdr-al-btn')?.addEventListener('click', () => window.StudyAiTutor?.toggle?.());

    // VS Code-style Study Explorer Sidebar (#site-explorer-drawer)
    const expBtn = document.getElementById('rail-explorer-btn');
    const expDrawer = document.getElementById('site-explorer-drawer');
    const expBackdrop = document.getElementById('site-explorer-backdrop');
    const expTree = document.getElementById('site-explorer-tree');
    const expFilter = document.getElementById('explorer-filter-input');
    let expOpen = false;
    let expActions = [];

    const leaveRunnerForExplorer = () => {
      if (!document.getElementById('view-runner')?.hidden) {
        document.getElementById('run-exit-btn')?.click();
      }
    };

    const closeExplorer = () => {
      if (!expOpen) return;
      expOpen = false;
      if (expDrawer) expDrawer.hidden = true;
      if (expBackdrop) expBackdrop.hidden = true;
      document.body.classList.remove('explorer-open');
      if (expBtn) {
        expBtn.classList.remove('active');
        expBtn.setAttribute('aria-expanded', 'false');
      }
    };

    const renderExplorerTree = (rawQuery = '') => {
      if (!expTree) return;
      const q = String(rawQuery || '').trim().toLowerCase();
      expActions = [];
      const reg = (fn) => {
        const id = expActions.length;
        expActions.push(fn);
        return id;
      };
      const fileIcon = '<svg class="exp-svg" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 1.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V5.5l-4-4Z"/><path d="M9.5 1.5v4h4"/></svg>';
      const folderIcon = '<svg class="exp-svg" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h3l1.3 1.4h5.3A1.2 1.2 0 0 1 14 5.6v6.2a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8V4.2Z"/></svg>';

      const courseBranches = (boot.catalog || []).map((c) => {
        const mLocked = isCourseInMaintenanceForUser(c.courseId);
        const mInfo = getCourseMaintenance(c.courseId);
        const noteRef = (boot.references || []).find((r) => r.courseId === c.courseId || r.file === c.obsidian?.mainReference);
        const subItems = [
          {
            label: 'Practice Questions',
            badge: mLocked ? mInfo.badge : `${c.questionCount || 0}`,
            active: currentView === 'course' && selectedCourseId === c.courseId,
            hay: `${c.code} ${c.title} ${c.shortTitle} practice questions topics`,
            run: () => { leaveRunnerForExplorer(); navigate('course', { courseId: c.courseId }); },
          },
          {
            label: 'Mock Exams & Papers',
            badge: c.examInfo?.date ? c.examInfo.date.slice(0, 6) : '',
            active: currentView === 'exams',
            hay: `${c.code} ${c.title} ${c.shortTitle} exams mock papers`,
            run: () => { leaveRunnerForExplorer(); navigate('exams', { focusCourseId: c.courseId }); },
          },
          ...(noteRef ? [{
            label: 'Course Notes',
            badge: 'MD',
            active: currentView === 'references' && selectedRefFile === noteRef.file,
            hay: `${c.code} ${c.title} ${noteRef.title} notes reference formula`,
            run: () => { leaveRunnerForExplorer(); navigate('references', { refFile: noteRef.file }); },
          }] : []),
        ].filter((it) => !q || it.hay.toLowerCase().includes(q));
        if (!subItems.length) return '';
        const isCurrentCourse = selectedCourseId === c.courseId;
        const shouldOpen = Boolean(q || isCurrentCourse);
        return `
          <details class="exp-sub" ${shouldOpen ? 'open' : ''}>
            <summary class="exp-row exp-folder-row">
              <span class="exp-chev" aria-hidden="true"></span>
              ${folderIcon}
              <span class="exp-name">${esc(c.shortTitle || c.title)}</span>
              <span class="exp-tag">${esc(c.code)}</span>
            </summary>
            <div class="exp-children">
              ${subItems.map((it) => `
                <button type="button" class="exp-row exp-file-row ${it.active ? 'is-active' : ''}" data-exp-act="${reg(it.run)}">
                  ${fileIcon}
                  <span class="exp-name">${esc(it.label)}</span>
                  ${it.badge ? `<span class="exp-meta">${esc(it.badge)}</span>` : ''}
                </button>`).join('')}
            </div>
          </details>`;
      }).filter(Boolean).join('');

      const noteItems = (boot.references || [])
        .filter((r) => !q || `${r.title} ${r.code} ${r.semester || ''} notes reference`.toLowerCase().includes(q))
        .map((r) => {
          const isAct = currentView === 'references' && selectedRefFile === r.file;
          return `
            <button type="button" class="exp-row exp-file-row ${isAct ? 'is-active' : ''}" data-exp-act="${reg(() => { leaveRunnerForExplorer(); navigate('references', { refFile: r.file }); })}">
              ${fileIcon}
              <span class="exp-name">${esc(r.title)}</span>
              <span class="exp-meta">${esc(r.code || 'Note')}</span>
            </button>`;
        }).join('');

      const toolEntries = [
        { label: 'Home Dashboard', meta: '', active: currentView === 'home', hay: 'home dashboard overview', run: () => { leaveRunnerForExplorer(); navigate('home'); } },
        { label: 'All Mock Exams', meta: '', active: currentView === 'exams', hay: 'exams wiseflow mocks', run: () => { leaveRunnerForExplorer(); navigate('exams'); } },
        { label: 'Schedule & TimeEdit', meta: '', active: currentView === 'schedule', hay: 'schedule calendar timeedit', run: () => { leaveRunnerForExplorer(); navigate('schedule'); } },
        { label: 'Metrics & UPI', meta: '', active: currentView === 'analytics', hay: 'metrics analytics upi', run: () => { leaveRunnerForExplorer(); navigate('analytics'); } },
        ...(window.StudyCommunity?.enabled ? [
          { label: 'Community & Leaderboard', meta: '', active: currentView === 'community', hay: 'community leaderboard chat rooms ed', run: () => { leaveRunnerForExplorer(); navigate('community'); } },
          { label: '⚔️ Challenge to Duel', meta: '1v1', active: false, hay: 'duel challenge invite battle 1v1 break', run: () => window.StudyDuels?.openChallengeModal?.() },
        ] : []),
        ...(window.StudyPdfCraft?.isAvailable?.() ? [{ label: 'PdfCraft PDF Editor', meta: 'WASM', active: false, hay: 'pdf pdfcraft edit highlight sign merge ocr', run: () => window.StudyPdfCraft.openBlank() }] : []),
        { label: 'Adamlite AI Chat', meta: 'T', active: Boolean(window.StudyAiTutor?.isOpen?.()), hay: 'adamlite ai chat tutor history', run: () => window.StudyAiTutor?.toggle?.() },
        { label: 'Settings', meta: ',', active: false, hay: 'settings theme sound school major', run: () => window.StudyUI.openSettings?.() },
      ].filter((it) => !q || `${it.label} ${it.hay}`.toLowerCase().includes(q));

      const toolItems = toolEntries.map((it) => `
        <button type="button" class="exp-row exp-file-row ${it.active ? 'is-active' : ''}" data-exp-act="${reg(it.run)}">
          ${fileIcon}
          <span class="exp-name">${esc(it.label)}</span>
          ${it.meta ? `<span class="exp-meta">${esc(it.meta)}</span>` : ''}
        </button>`).join('');

      const sections = [
        courseBranches ? `<details class="exp-section" open><summary class="exp-section-head"><span class="exp-chev" aria-hidden="true"></span><span>COURSES</span></summary><div class="exp-section-body">${courseBranches}</div></details>` : '',
        noteItems ? `<details class="exp-section" ${q ? 'open' : ''}><summary class="exp-section-head"><span class="exp-chev" aria-hidden="true"></span><span>NOTES &amp; SHEETS</span></summary><div class="exp-section-body">${noteItems}</div></details>` : '',
        toolItems ? `<details class="exp-section" open><summary class="exp-section-head"><span class="exp-chev" aria-hidden="true"></span><span>WORKSPACE &amp; TOOLS</span></summary><div class="exp-section-body">${toolItems}</div></details>` : '',
      ].filter(Boolean).join('');

      expTree.innerHTML = sections || '<p class="muted" style="padding:14px 12px;font-size:12.5px">No matching items.</p>';
    };

    const openExplorer = () => {
      if (!expDrawer) return;
      if (window.StudyUI?.isReferenceDrawerOpen?.()) window.StudyUI.closeReferenceDrawer();
      expOpen = true;
      renderExplorerTree(expFilter?.value || '');
      expDrawer.hidden = false;
      if (expBackdrop) expBackdrop.hidden = false;
      document.body.classList.add('explorer-open');
      if (expBtn) {
        expBtn.classList.add('active');
        expBtn.setAttribute('aria-expanded', 'true');
      }
      setTimeout(() => expFilter?.focus?.(), 20);
    };

    const toggleExplorer = () => (expOpen ? closeExplorer() : openExplorer());

    expBtn?.addEventListener('click', toggleExplorer);
    expBackdrop?.addEventListener('click', closeExplorer);
    document.getElementById('explorer-close-btn')?.addEventListener('click', closeExplorer);
    document.getElementById('explorer-cmd-btn')?.addEventListener('click', () => {
      closeExplorer();
      openPalette();
    });
    expFilter?.addEventListener('input', () => renderExplorerTree(expFilter.value));
    expTree?.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('[data-exp-act]');
      if (!btn) return;
      const fn = expActions[Number(btn.dataset.expAct)];
      closeExplorer();
      if (typeof fn === 'function') fn();
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && expOpen) {
        ev.preventDefault();
        closeExplorer();
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        closeExplorer();
        if (dialog.open) dialog.close();
        else openPalette();
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (document.body.classList.contains('in-runner')) return;
      if (document.querySelector('dialog[open]')) return;
      const tag = ev.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ev.target?.isContentEditable) return;
      const k = ev.key.toLowerCase();
      if (k === 'e') {
        ev.preventDefault();
        toggleExplorer();
      } else if (k === 'o') {
        ev.preventDefault();
        closeExplorer();
        toggleSiteReferenceSidebar();
      } else if (k === 't') {
        ev.preventDefault();
        window.StudyAiTutor?.toggle?.();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // INITIALIZATION & DEEP-LINK URL ROUTING
  // ---------------------------------------------------------------------------
  async function init() {
    bindGlobalChrome();
    bindCommandPalette();
    receiveDesktopSetup();
    document.getElementById('mobile-sync-dismiss').onclick = () => {
      try { sessionStorage.setItem('study-os-dismiss-mobile-sync', '1'); } catch {}
      document.getElementById('mobile-sync-tip').hidden = true;
    };
    document.getElementById('mobile-sync-action').onclick = async () => {
      if (window.StudyCommunity.isSignedIn() ||
          await window.StudyCommunity.requireProfile({ allowDemo: true, forcePrompt: true })) navigate('schedule');
    };
    if (isStaticWeb && navigator.serviceWorker) {
      navigator.serviceWorker.getRegistration?.().then((reg) => reg?.update?.()).catch(() => {});
    }
    const globalHeader = document.getElementById('global-header');
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--notes-header-height', `${globalHeader.offsetHeight}px`);
    }).observe(globalHeader);
    if (!isStaticWeb) {
      openCanvasSync = bindCanvasSync();
      openCanvasFiles = bindCanvasFiles();
      bindStudyAdmin();
      document.getElementById('local-book-dialog').addEventListener('close', () => window.StudyPdf.dispose());
    }
    window.StudyRunner.bindRunnerGlobals();
    document.querySelector('[data-nav="community"]').hidden = !window.StudyCommunity.enabled;
    const mobComm = document.getElementById('mobile-dock-community');
    const mobExams = document.getElementById('mobile-dock-exams');
    if (mobComm) mobComm.hidden = !window.StudyCommunity.enabled;
    if (mobExams) mobExams.hidden = Boolean(window.StudyCommunity.enabled);
    document.getElementById('runner-room-btn').onclick = () => {
      document.getElementById('run-exit-btn').click();
      navigate('room');
    };
    window.StudyCommunity.queueStatsSync();
    window.StudyDuels?.init?.();
    if (isStaticWeb) window.addEventListener('pagehide', flushPendingDrafts);
    if (isStaticWeb) document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - cloudSyncMeta.updatedAt >= 60_000) {
        syncCloudProgress().catch(() => {});
      }
    });

    document.querySelectorAll('.tab-btn, .mobile-dock-btn').forEach((btn) => {
      btn.addEventListener('click', () => navigate(btn.dataset.nav));
    });
    document.getElementById('nav-brand')?.addEventListener('click', () => navigate('home'));
    document.getElementById('btn-export-backup')?.addEventListener('click', () => {
      exportBackupFile();
      toast('Exported Study-OS backup.');
    });
    document.getElementById('btn-home-tutor')?.addEventListener('click', () => {
      window.StudyUI.closeSettings?.();
      if (window.StudyAiTutor?.open) window.StudyAiTutor.open();
      else window.StudyTutor.open();
    });
    document.getElementById('btn-save-offline')?.addEventListener('click', saveForOffline);
    document.getElementById('settings-profile-card')?.addEventListener('click', async () => {
      if (!window.StudyCommunity?.enabled) return;
      window.StudyUI.closeSettings?.();
      if (!window.StudyCommunity.isSignedIn()) {
        const ok = await window.StudyCommunity.requireProfile({ allowDemo: true, forcePrompt: true });
        if (ok) {
          await window.StudyRooms.restore();
          await members.restore();
          await refreshBootstrap();
        }
        return;
      }
      if (!document.getElementById('view-runner').hidden) document.getElementById('run-exit-btn').click();
      navigate('community');
    });
    const openHeaderSignIn = async () => {
      window.StudyUI.closeSettings?.();
      const ok = await window.StudyCommunity.requireProfile({ allowDemo: true, forcePrompt: true });
      if (ok) {
        await window.StudyRooms.restore();
        await members.restore();
        await refreshBootstrap();
        if (!members.isUnlocked()) maybePromptFirstLoginBiSync();
      }
    };
    document.getElementById('settings-signin-btn')?.addEventListener('click', openHeaderSignIn);
    document.getElementById('hdr-signin-btn')?.addEventListener('click', openHeaderSignIn);
    document.getElementById('run-canvas-btn').addEventListener('click', () => openBiSyncHub());
    document.getElementById('run-profile-btn').addEventListener('click', () => {
      if (!window.StudyCommunity?.enabled) window.StudyUI.openSettings();
      else if (window.StudyCommunity.isSignedIn()) window.StudyCommunity.openSecuritySheet();
      else openHeaderSignIn();
    });
    document.getElementById('settings-passkeys-btn')?.addEventListener('click', () => {
      window.StudyUI.closeSettings?.();
      window.StudyCommunity.openSecuritySheet?.();
    });
    document.getElementById('settings-cloud-sync-btn')?.addEventListener('click', () => {
      syncCloudProgress({ interactive: true });
    });
    document.getElementById('settings-signout-btn')?.addEventListener('click', async () => {
      await window.StudyCommunity.signOut?.();
      cloudSyncMeta = { status: '', updatedAt: 0, recordCount: 0 };
      syncSettingsRows();
      toast('Signed out on this browser.');
      if (currentView === 'community') navigate('home');
      else await refreshBootstrap(false);
    });
    document.getElementById('settings-bi-sync-btn')?.addEventListener('click', () => {
      window.StudyUI.closeSettings?.();
      openBiSyncHub();
    });
    document.getElementById('settings-canvas-sync-btn')?.addEventListener('click', () => {
      window.StudyUI.closeSettings?.();
      openCanvasSync?.('canvas');
    });
    document.getElementById('settings-ed-sync-btn')?.addEventListener('click', () => {
      window.StudyUI.closeSettings?.();
      openCanvasSync?.('ed');
    });
    document.getElementById('settings-add-files-btn')?.addEventListener('click', () => {
      window.StudyUI.closeSettings?.();
      openCanvasFiles?.();
    });
    document.getElementById('settings-archive-path-btn')?.addEventListener('click', async () => {
      window.StudyUI.closeSettings?.();
      const ca = boot.canvasArchive || {};
      const p = prompt('Enter full path to your local Canvas-Archive folder:', ca.configuredPath || ca.archivePath || '');
      if (p === null) return;
      boot = await apiPost('/api/canvas/config', { canvasArchivePath: p.trim() });
      toast('Updated Canvas-Archive path!');
      syncSettingsRows();
      if (currentView === 'home') renderHome();
    });

    document.getElementById('btn-refresh-cal')?.addEventListener('click', async () => {
      window.StudyUI.closeSettings?.();
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
      window.StudyUI.closeSettings?.();
      try {
        const data = JSON.parse(await f.text());
        if (isStaticWeb) {
          flushPendingDrafts();
          const message = restoreWebBackup(data);
          if (message) {
            window.StudyCommunity.queueStatsSync();
            queueCloudSync();
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
      await window.StudyLocalSources?.init?.();
      const signedIn = await window.StudyCommunity.requireProfile({ allowDemo: true, silent: true });
      if (signedIn) {
        await window.StudyRooms.restore();
        await members.restore();
        const prof = window.StudyCommunity.getCurrentProfile?.();
        if (prof?.isAdmin && prof?.memberKey && members.enabled && !members.isUnlocked()) {
          await members.unlock(prof.memberKey, true).catch(() => {});
        }
      }
      await refreshBootstrap(false);
      syncSettingsRows();
      if (isStaticWeb) renderCourseDirectory();
      if (signedIn && isStaticWeb) {
        syncCloudProgress().catch(() => {});
        if (!members.isUnlocked()) maybePromptFirstLoginBiSync();
      }
      await window.StudySets.activateDraft();
      bindMemberAccess();
    } catch {
      const hero = document.getElementById('up-next-hero');
      hero.innerHTML = '<h1>Could not load Study-OS</h1><p>Check your connection and try again.</p><button type="button" class="primary-btn">Retry</button>';
      hero.querySelector('button').onclick = () => window.location.reload();
      return;
    }

    // Handle deep links (`?course=exc3430-accounting&origin=official_only&diff=2&sort=exam_relevance&code=BI2026`,
    // `?view=exams|references|schedule|community`, `?join_room=CODE`, or `?autostart_event=...`)
    const params = new URLSearchParams(window.location.search);
    const joinRoomCode = (params.get('join_room') || '').trim().toUpperCase();
    const qAccessCode = (params.get('code') || params.get('pass') || params.get('invite') || '').trim().slice(0, 120);
    const autoEvent = params.get('autostart_event');
    const qCourseRaw = (params.get('course') || '').trim();
    const qTopic = (params.get('topic') || '').trim();
    const qView = (params.get('view') || '').trim().toLowerCase();
    const qDlpfc = (params.get('dlpfc') || '').trim().toLowerCase();
    const qDiffRaw = (params.get('diff') || '').trim().toLowerCase();
    const autoStart = params.get('autostart') === '1';

    if (qAccessCode) {
      // Strip the code param from the visible address bar immediately while preserving target course/filters
      const cleanParams = new URLSearchParams(window.location.search);
      cleanParams.delete('code');
      cleanParams.delete('pass');
      cleanParams.delete('invite');
      const nextUrl = cleanParams.toString() ? `${window.location.pathname}?${cleanParams.toString()}` : window.location.pathname;
      window.history.replaceState({}, '', nextUrl);
      if (isStaticWeb && window.StudyCommunity?.isSignedIn?.() && !/^sos1_/i.test(qAccessCode)) {
        window.StudyCommunity.redeemAccessCode(qAccessCode).then(async (res) => {
          if (res?.archiveUnlocked) {
            await refreshBootstrap(false);
            toast('Access pass activated — BI course PDFs unlocked!');
          }
        }).catch(() => {});
      }
    }

    const COURSE_SLUG_ALIASES = {
      'exc3430-accounting': 'acct-2527',
      'accounting': 'acct-2527',
      'exc3420-economics': 'econ-2522',
      'economics': 'econ-2522',
      'econ': 'econ-2522',
      'eba1181-mathematics': 'math-2588',
      'mathematics': 'math-2588',
      'math': 'math-2588',
      'exc3460-leadership': 'ob-2537',
      'leadership': 'ob-2537',
      'ob': 'ob-2537',
      'eba3400-programming': 'prog-3021',
      'programming': 'prog-3021',
      'prog': 'prog-3021',
    };
    const resolveCourseIdParam = (raw) => {
      if (!raw) return '';
      const lower = raw.toLowerCase();
      if (COURSE_SLUG_ALIASES[lower]) return COURSE_SLUG_ALIASES[lower];
      const exact = (boot.catalog || []).find((c) => c.courseId === raw);
      if (exact) return exact.courseId;
      const norm = raw.toUpperCase().replace(/[\s_-]+/g, '');
      const byCode = (boot.catalog || []).find((c) => {
        const cNorm = String(c.code || '').toUpperCase().replace(/[\s_-]+/g, '');
        return cNorm === norm || String(c.canvasId || '') === raw || String(c.courseId || '').toUpperCase().replace(/[\s_-]+/g, '') === norm;
      });
      return byCode?.courseId || raw;
    };
    const qCourse = resolveCourseIdParam(qCourseRaw);

    const normalizeDiffParam = (dVal, dlpfcVal) => {
      const v = dVal || dlpfcVal;
      if (v === '3' || v === 'high' || v === 'high_dlpfc' || v === 'hard') return '3';
      if (v === '2' || v === 'med' || v === 'medium' || v === 'med_dlpfc') return '2';
      if (v === '1' || v === 'low' || v === 'low_dlpfc' || v === 'easy') return '1';
      if (v === '2plus' || v === 'med_high') return '2plus';
      return '';
    };

    if (/^[A-F0-9]{8}$/.test(joinRoomCode) && isStaticWeb && window.StudyCommunity?.enabled) {
      window.history.replaceState({}, '', window.location.pathname);
      if (await window.StudyCommunity.requireProfile({ allowDemo: false, forcePrompt: true })) {
        await window.StudyRooms.joinByCode(joinRoomCode);
      }
      return;
    }

    // Two-way sync callback from Study-OS Companion IDE extension (`?ide_complete=1&qid=...&sec=...&acc=...`)
    if (params.get('ide_complete') === '1' && params.get('qid')) {
      const ideQid = String(params.get('qid') || '').trim();
      const ideSec = Math.max(1, Math.min(18000, Math.round(Number(params.get('sec')) || 60)));
      const ideReview = params.get('review') === '1';
      const ideAccRaw = params.get('acc');
      const ideCells = String(params.get('cells') || '').trim();
      const ideTs = String(params.get('ts') || '').trim();
      window.history.replaceState({}, '', window.location.pathname);

      const courseIdFromQid = ideQid.includes(':') ? ideQid.split(':')[0] : 'prog-3021';
      const cMeta = (boot.catalog || []).find((c) => c.courseId === courseIdFromQid);
      if (cMeta) {
        try {
          const bank = await ensureCourseBank(cMeta.courseId);
          const qObj = (bank?.questions || []).find((q) => q.id === ideQid);
          if (qObj) {
            if (ideReview) {
              window.StudyRunner.startRun({
                courseMeta: cMeta,
                bank,
                questionIds: [qObj.id],
                mode: 'practice',
                profile: 'learning',
              });
              toast(`Opened ${qObj.title.slice(0, 48)} — click Reveal Solution to check your IDE output.`);
              return;
            }
            const nonceKey = 'study-os-ide-sync-nonces-v1';
            let seen = [];
            try { seen = JSON.parse(localStorage.getItem(nonceKey) || '[]'); } catch {}
            const dedupeId = ideTs ? `${ideQid}:${ideTs}` : '';
            if (!dedupeId || !seen.includes(dedupeId)) {
              if (dedupeId) {
                seen = [...seen.slice(-30), dedupeId];
                try { localStorage.setItem(nonceKey, JSON.stringify(seen)); } catch {}
              }
              const qAcc = Math.max(0, Math.min(1, Number(ideAccRaw ?? 1)));
              const aiParSec = calibratedParSec(qObj, 'learning');
              const dlpfcTier = effectiveDlpfc(qObj).tier;
              const res = await logAttempt({
                questionId: qObj.id,
                courseId: cMeta.courseId,
                topicId: qObj.topicId,
                kind: qObj.kind || 'coding',
                profile: 'learning',
                dlpfcTier,
                activeSec: ideSec,
                wallSec: ideSec,
                aiParSec,
                hintsUsed: 0,
                hintHandicapSec: 30,
                qualityAccuracy: qAcc,
                focusSwitchCount: 0,
                awayElapsedSec: 0,
                source: 'ide_companion',
                ideVerified: true,
                verificationTier: 'ide_verified',
              });
              const beatTxt = res?.attempt?.beatAi ? ' · Beat AI Par!' : '';
              const cellTxt = ideCells ? ` · ${ideCells} cells` : '';
              toast(`Synced ${ideQid.split(':')[1] || ideQid} from IDE (${window.StudyUI.clockSec(ideSec)}${cellTxt}${beatTxt})`);
            }
            navigate('course', { courseId: cMeta.courseId });
            return;
          }
        } catch {}
      }
    }

    if (qView === 'playbook') {
      window.history.replaceState({}, '', window.location.pathname);
      window.StudyPlaybook?.open?.();
      return;
    }

    if (autoEvent) {
      const blk = (boot.calendar?.blocks || []).find((b) => b.eventId === autoEvent);
      if (blk && blk.courseId) {
        window.history.replaceState({}, '', window.location.pathname);
        await launchCalendarBlock(blk);
        return;
      }
    }
    if (qView === 'community' && window.StudyCommunity?.enabled) {
      const section = (params.get('section') || '').trim().toLowerCase();
      await navigate('community');
      if (section === 'ed' || section === 'ed-discussion') {
        document.getElementById('community-ed-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } else if (['exams', 'references', 'schedule'].includes(qView)) {
      if (qView === 'references' && isStaticWeb) {
        const target = findPublicReference(params.get('note') || '');
        if (target) {
          await navigate('references', { refFile: target.entry.file, refDoc: target.file, heading: params.get('section') || '' });
        } else {
          window.history.replaceState({}, '', window.location.pathname);
          await navigate(qView, { focusCourseId: qCourse || '' });
        }
      } else {
        window.history.replaceState({}, '', window.location.pathname);
        await navigate(qView, { focusCourseId: qCourse || '' });
      }
    } else if (qCourse || qView === 'course' || qView === 'courses') {
      const targetCourseId = qCourse || boot.catalog?.[0]?.courseId || '';
      if (targetCourseId) {
        if (autoStart) {
          window.history.replaceState({}, '', window.location.pathname);
          const normDiff = normalizeDiffParam(qDiffRaw, qDlpfc);
          const mode = normDiff === '3' ? 'high_dlpfc' : normDiff === '2' ? 'med_dlpfc' : normDiff === '1' ? 'low_dlpfc' : 'auto';
          const exact = normDiff === '3' ? 3 : normDiff === '2' ? 2 : normDiff === '1' ? 1 : 0;
          await launchSmartCourseRun(targetCourseId, homeBlockMinutes || 50, 'learning', qTopic, mode, false, exact);
        } else {
          const filters = {
            preset: (params.get('preset') || '').trim(),
            origin: (params.get('origin') || '').trim(),
            real: params.get('real') === '1' || params.get('real') === 'true',
            topic: qTopic,
            coll: (params.get('coll') || params.get('collection') || '').trim(),
            kind: (params.get('kind') || params.get('format') || '').trim(),
            diff: normalizeDiffParam(qDiffRaw, qDlpfc),
            horizon: (params.get('horizon') || '').trim(),
            status: (params.get('status') || '').trim(),
            sort: (params.get('sort') || '').trim(),
            budget: (params.get('budget') || '').trim(),
            profile: (params.get('profile') || '').trim(),
            q: (params.get('q') || params.get('search') || '').trim(),
          };
          await navigate('course', { courseId: targetCourseId, filters });
        }
      }
    }

    // Prompt unsigned-in visitors to unlock full Study-OS right on opening ANY link (drops them right on target course/filters after login!)
    if (isStaticWeb && window.StudyCommunity?.enabled && !window.StudyCommunity.isSignedIn() && !/bot|crawler|spider|lighthouse/i.test(navigator.userAgent || '')) {
      window.StudyCommunity.requireProfile({
        allowDemo: true,
        forcePrompt: Boolean(qAccessCode),
        prefillCode: qAccessCode,
      }).then(async (ok) => {
        if (!ok) return;
        await window.StudyRooms.restore().catch(() => {});
        await members.restore().catch(() => {});
        await syncCloudProgress().catch(() => {});
        await refreshBootstrap(false);
        syncSettingsRows();
      }).catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  function formatFileSize(bytes) {
    const n = Number(bytes || 0);
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${n} B`;
  }

  function openBiSyncHub(opts = {}) {
    if (!isStaticWeb) {
      openCanvasSync?.('canvas');
      return;
    }
    let dlg = document.getElementById('bi-sync-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'bi-sync-dialog';
      dlg.className = 'member-dialog playbook-sheet';
      dlg.tabIndex = -1;
      dlg.setAttribute('aria-labelledby', 'bi-sync-title');
      dlg.addEventListener('click', (ev) => {
        if (ev.target === dlg) dlg.close();
      });
      document.body.appendChild(dlg);
    }

    let materialsState = { loaded: false, items: [], usedBytes: 0, maxBytes: 200 * 1024 * 1024 };
    let selectedMatCourse = '';
    let uploadStatusText = '';
    let lastMatchBanner = '';
    let syncCloudToo = true;
    let customSchoolMode = false;

    const getCourseChoices = () => {
      const seen = new Set();
      const out = [];
      for (const c of boot.catalog || []) {
        const code = String(c.code || '').trim();
        if (!code || seen.has(code)) continue;
        seen.add(code);
        out.push({ code, title: c.title || code, courseId: c.courseId });
      }
      const snap = loadWebState().canvasSnapshot;
      for (const c of snap?.courses || []) {
        const code = String(c.code || '').trim() || String(c.name || '').slice(0, 18);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        out.push({ code, title: c.name || code, courseId: '' });
      }
      return out;
    };

    const loadPersonalMaterials = async (linkCode) => {
      if (!window.StudyCommunity?.isSignedIn?.() || !window.StudyCommunity?.listMaterials) return;
      try {
        const res = await window.StudyCommunity.listMaterials();
        materialsState = {
          loaded: true,
          items: Array.isArray(res?.items) ? res.items : [],
          usedBytes: Number(res?.usedBytes || 0),
          maxBytes: Number(res?.maxBytes || 200 * 1024 * 1024),
        };
        if (dlg.open) renderBiDialog(linkCode);
      } catch {}
    };

    const renderBiDialog = (linkCode = null) => {
      const signedIn = Boolean(window.StudyCommunity?.isSignedIn?.());
      const ws = loadWebState();
      const snap = ws.canvasSnapshot;
      const syncedCourses = snap?.courses?.length || 0;
      const syncedDeadlines = (snap?.courses || []).reduce((n, c) => n + (c.assignments?.length || 0), 0);
      const hasTe = Boolean(ws.customSchedule?.enabled && ws.customSchedule?.blocks?.length);
      const formattedCode = linkCode?.code
        ? String(linkCode.code).replace(/^([A-Z0-9]{3})([A-Z0-9]{3})$/, '$1-$2')
        : '';
      const courseChoices = getCourseChoices();
      const usedLabel = `${(materialsState.usedBytes / (1024 * 1024)).toFixed(1)} / ${Math.round(materialsState.maxBytes / (1024 * 1024))} MB`;

      const schoolInfo = getSyncedSchoolInfo();
      const schoolCfg = getUserSchoolConfig();
      const catalog = window.StudyCommunity?.SCHOOL_CATALOG || [];
      const matchedPreset = catalog.find((s) => s.name.toLowerCase() === (schoolCfg.name || '').toLowerCase());
      const schoolSelectVal = customSchoolMode ? '__custom__' : matchedPreset ? matchedPreset.name : (schoolCfg.name || schoolCfg.canvasOrigin) ? '__custom__' : '';
      const activeCanvasUrl = schoolInfo.origin || schoolCfg.canvasOrigin || '';
      const activeSchoolName = schoolCfg.short || schoolCfg.name || schoolInfo.shortSchool || '';

      dlg.innerHTML = `
        <div class="playbook-head">
          <div>
            <span class="eyebrow">${opts.firstLogin ? 'Welcome to Study-OS · Quick 30s Setup' : 'Multi-School 1-Click &amp; Auto Browser Sync'}</span>
            <h2 id="bi-sync-title" style="margin:2px 0 4px">${opts.firstLogin ? 'Connect Canvas, Timetable &amp; Ed' : 'Sync Canvas · TimeEdit / TP · Ed'}</h2>
            <p class="muted" style="margin:0;font-size:13px">Works for any Instructure Canvas university worldwide — uses your already signed-in browser tabs, zero passwords copied.</p>
          </div>
          <button type="button" class="ios-done-btn" id="bi-sync-done">Done</button>
        </div>
        <div class="playbook-body">
          ${biSyncWalkthroughHtml()}
          <article class="playbook-card">
            <div class="row-between" style="margin:0 0 6px;gap:8px">
              <h3 style="margin:0;font-size:15px">1. Install Study-OS Sync extension</h3>
              <span class="badge live">v1.6.0 · Multi-School</span>
            </div>
            <p class="muted" style="margin:0 0 10px;font-size:13px;line-height:1.45">
              Works in Chrome, Brave, Edge, and Vivaldi. Pulls <b>Canvas LMS</b> courses &amp; deadlines (any <code>*.instructure.com</code> or Norwegian Canvas), <b>TimeEdit / TP</b> timetables, and <b>Ed Discussion</b> in 1 click — and auto-refreshes quietly when you open a signed-in tab.
            </p>
            <div class="row-actions">
              <a class="primary-btn" href="./downloads/study-os-sync-extension.zip" download="study-os-sync-extension.zip">Download Extension (.zip)</a>
              <a class="ghost-btn" href="https://github.com/shadjosef/study-os/blob/main/docs/canvas-browser-sync.md" target="_blank" rel="noopener">Install steps ↗</a>
            </div>
            <small class="muted" style="display:block;margin-top:8px">Unzip → open <code>chrome://extensions</code> → turn on <b>Developer mode</b> → <b>Load unpacked</b> (Chrome Web Store approval in review — seamless 1-click install soon!).</small>
          </article>

          <article class="playbook-card">
            <div class="row-between" style="margin:0 0 6px;gap:8px">
              <h3 style="margin:0;font-size:15px">2. Pair once with a 6-char code</h3>
              ${signedIn ? '<span class="badge live">Signed in</span>' : '<span class="badge gold">Sign in needed</span>'}
            </div>
            <p class="muted" style="margin:0 0 10px;font-size:13px;line-height:1.45">
              ${signedIn
                ? 'Generate a 5-minute pairing code and paste it into the Study-OS Sync extension once.'
                : 'Sign in with Google or a Passkey first so your synced courses, AI study sets, timetable, and personal PDFs carry across desktop and phone.'}
            </p>
            ${formattedCode ? `
              <div class="row-between" style="padding:10px 14px;border-radius:14px;background:var(--panel);border:1px solid var(--accent);margin-bottom:8px;gap:10px">
                <strong style="font-size:20px;letter-spacing:0.12em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${esc(formattedCode)}</strong>
                <button type="button" class="ghost-btn" id="bi-copy-code">Copy code</button>
              </div>
            ` : ''}
            <div class="row-actions">
              ${signedIn
                ? `<button type="button" class="primary-btn" id="bi-gen-code">${formattedCode ? 'New 6-char code' : 'Generate 6-char pairing code'}</button>`
                : '<button type="button" class="primary-btn" id="bi-signin-btn">Sign in to Study-OS</button>'}
            </div>
          </article>

          <article class="playbook-card">
            <div class="row-between" style="margin:0 0 6px;gap:8px;flex-wrap:wrap">
              <h3 style="margin:0;font-size:15px">3. Open your school's Canvas tab &amp; click Sync</h3>
              <span class="badge ${syncedCourses || hasTe ? 'live' : ''}">${syncedCourses ? `${schoolInfo.shortSchool ? `${esc(schoolInfo.shortSchool)} · ` : ''}${syncedCourses} courses · ${syncedDeadlines} deadlines` : hasTe ? 'Timetable active' : 'Ready'}</span>
            </div>
            <div class="sync-school-bar">
              <label class="field-label" style="margin:0;flex:1;min-width:190px">Your university / school
                <select id="bi-sync-school-select">
                  <option value="" ${!schoolSelectVal ? 'selected' : ''}>Choose your school (or just open any Canvas tab)…</option>
                  ${catalog.map((s) => `<option value="${esc(s.name)}" ${schoolSelectVal === s.name ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                  <option value="__custom__" ${schoolSelectVal === '__custom__' ? 'selected' : ''}>Not listed here (enter custom…)</option>
                  <option value="__private__" ${schoolSelectVal === '__private__' ? 'selected' : ''}>Prefer not to say</option>
                </select>
              </label>
            </div>
            ${schoolSelectVal === '__custom__' ? `
              <div class="sync-school-custom-row" style="margin-top:8px">
                <input type="text" id="bi-sync-custom-name" maxlength="48" value="${esc(matchedPreset ? '' : (schoolCfg.name || ''))}" placeholder="University name (e.g. CBS, Stockholm Uni)">
                <input type="text" id="bi-sync-custom-url" maxlength="120" value="${esc(matchedPreset ? '' : (schoolCfg.canvasOrigin || ''))}" placeholder="https://yourschool.instructure.com" autocomplete="off" spellcheck="false">
                <button type="button" class="ghost-btn" id="bi-sync-custom-save" style="padding:6px 12px;font-size:12.5px">Save</button>
              </div>
            ` : ''}
            <p class="muted" style="margin:8px 0 10px;font-size:13px;line-height:1.45">
              Keep your school's Canvas tab open (plus TimeEdit/TP or Ed if you use them) and click the <b>Study-OS Sync</b> icon once. Any <code>*.instructure.com</code> school is auto-detected immediately.
            </p>
            <div class="row-actions" style="flex-wrap:wrap">
              ${activeCanvasUrl
                ? `<a class="primary-btn" style="padding:7px 13px;font-size:13px" href="${esc(activeCanvasUrl)}/" target="_blank" rel="noopener">Open ${esc(activeSchoolName || 'My')} Canvas ↗</a>`
                : ''}
              ${schoolCfg.name && schoolCfg.timetableUrl
                ? `<a class="ghost-btn" href="${esc(schoolCfg.timetableUrl)}" target="_blank" rel="noopener">${esc(schoolCfg.timetableLabel)} ↗</a>`
                : `<a class="ghost-btn" href="https://cloud.timeedit.net/" target="_blank" rel="noopener">TimeEdit ↗</a>
                   <a class="ghost-btn" href="https://tp.educloud.no/" target="_blank" rel="noopener">TP Timetable ↗</a>`}
              <a class="ghost-btn" href="https://eu.edstem.org/" target="_blank" rel="noopener">Ed ↗</a>
              ${signedIn ? '<button type="button" class="ghost-btn" id="bi-refresh-sync">Refresh synced data</button>' : ''}
            </div>
          </article>

          <article class="playbook-card" id="bi-materials-card">
            <div class="row-between" style="margin:0 0 6px;gap:8px;flex-wrap:wrap">
              <h3 style="margin:0;font-size:15px">4. Drop textbooks &amp; course PDFs to unlock Study-OS pages</h3>
              <span class="badge good">${window.StudyLocalSources?.list?.().length ? `${window.StudyLocalSources.list().length} local PDF${window.StudyLocalSources.list().length === 1 ? '' : 's'}` : 'Up to 260 MB/file local'}${signedIn ? ` · Cloud ${esc(usedLabel)}` : ''}</span>
            </div>
            <p class="muted" style="margin:0 0 10px;font-size:13px;line-height:1.45">
              Drop multiple Canvas PDFs, slides, past exams, or full textbooks (like <b>Atrill &amp; McLaney 12th ed.</b>) at once — even <b>over 40 MB</b>. Study-OS automatically matches your files privately in this browser to unlock inline page-by-page jumps inside exercises.
            </p>
            <div style="margin-bottom:8px">
              <select id="bi-mat-course" aria-label="Course tag for uploaded files" style="width:100%;font-size:13px;padding:7px 10px">
                <option value="">Auto-detect course (recommended)</option>
                ${courseChoices.map((c) => `<option value="${esc(c.code)}" data-title="${esc(c.title)}" data-course-id="${esc(c.courseId || '')}" ${selectedMatCourse === c.code ? 'selected' : ''}>${esc(c.code)} · ${esc(c.title)}</option>`).join('')}
              </select>
            </div>
            <label class="bi-dropzone" id="bi-mat-dropzone" tabindex="0">
              <input type="file" id="bi-mat-file-input" multiple accept=".pdf,.md,.txt,.csv,.png,.jpg,.jpeg,.webp,.docx,.pptx" hidden>
              <strong>Drop multiple PDFs, textbooks, or slides here — or click to choose</strong>
              <small class="muted">No 40 MB cap locally (up to 260 MB/PDF in browser) · unlocks Study-OS exercise pages instantly${signedIn ? ' · files ≤ 50 MB can also sync across devices (200 MB cloud locker)' : ''}</small>
            </label>
            ${signedIn ? `<label class="check-row" style="margin-top:8px;font-size:12.5px">
              <input type="checkbox" id="bi-mat-sync-cloud" ${syncCloudToo ? 'checked' : ''}>
              <span>Also sync files ≤ 50 MB to my Study-OS cloud locker (200 MB total, phone + laptop)</span>
            </label>` : ''}
            ${lastMatchBanner ? `<p style="margin:8px 0 0;padding:8px 10px;border-radius:10px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.28);font-size:12.5px;font-weight:600;color:var(--accent)">${esc(lastMatchBanner)}</p>` : ''}
            ${uploadStatusText ? `<p class="muted" id="bi-mat-upload-status" style="margin:8px 0 0;font-size:12.5px;color:var(--accent);font-weight:600">${esc(uploadStatusText)}</p>` : ''}
            ${(() => {
              const localItems = window.StudyLocalSources?.list?.() || [];
              if (!localItems.length) return '';
              return `<div class="bi-materials-list" style="margin-top:10px">
                <small class="muted" style="font-weight:700;display:block;margin-bottom:4px">LOCAL IN THIS BROWSER (UNLOCKED IN EXERCISES · ${localItems.length})</small>
                ${localItems.slice(0, 12).map((f) => `
                  <div class="bi-material-row">
                    <div class="bi-material-meta">
                      <span class="badge ${f.kind === 'book' ? 'gold' : 'good'}">${f.kind === 'book' ? 'Book' : 'Local PDF'}</span>
                      <span class="bi-material-title" title="${esc(f.filename)}">${esc(f.filename)}</span>
                      <small class="muted">${esc(window.StudyLocalSources.formatBytes(f.size))}</small>
                    </div>
                    <div class="row-actions" style="gap:4px;flex-shrink:0">
                      <button type="button" class="ghost-btn bi-mat-mini-btn" data-bi-open-local="${esc(f.key)}" data-bi-local-title="${esc(f.title || f.filename)}">Read</button>
                      ${window.StudyPdfCraft?.isAvailable?.() ? `<button type="button" class="ghost-btn bi-mat-mini-btn" data-bi-edit-local="${esc(f.key)}" data-bi-local-title="${esc(f.title || f.filename)}">Edit</button>` : ''}
                      <button type="button" class="ghost-btn bi-mat-mini-btn" data-bi-del-local="${esc(f.key)}">Remove</button>
                    </div>
                  </div>
                `).join('')}
              </div>`;
            })()}
            ${signedIn ? `
              <div class="bi-materials-list" id="bi-materials-list">
                ${!materialsState.loaded
                  ? '<small class="muted">Loading your cloud-synced files…</small>'
                  : materialsState.items.length
                    ? `<small class="muted" style="font-weight:700;display:block;margin:8px 0 4px">CLOUD-SYNCED ACROSS DEVICES (${materialsState.items.length})</small>` + materialsState.items.map((m) => `
                        <div class="bi-material-row">
                          <div class="bi-material-meta">
                            ${m.courseCode ? `<span class="badge">${esc(m.courseCode)}</span>` : ''}
                            <span class="bi-material-title" title="${esc(m.title)}">${esc(m.title)}</span>
                            <small class="muted">${esc(formatFileSize(m.sizeBytes))}</small>
                          </div>
                          <div class="row-actions" style="gap:4px;flex-shrink:0">
                            <button type="button" class="ghost-btn bi-mat-mini-btn" data-bi-open-mat="${esc(m.id)}" data-bi-mat-title="${esc(m.title)}">Open ↗</button>
                            <button type="button" class="ghost-btn bi-mat-mini-btn" data-bi-del-mat="${esc(m.id)}">Remove</button>
                          </div>
                        </div>
                      `).join('')
                    : ''}
              </div>
            ` : ''}
          </article>
        </div>
      `;

      dlg.querySelector('#bi-sync-done')?.addEventListener('click', () => dlg.close());
      const biSchoolSel = dlg.querySelector('#bi-sync-school-select');
      window.StudyCommunity?.bindTypeaheadSelect?.(biSchoolSel);
      biSchoolSel?.addEventListener('change', async (ev) => {
        const val = ev.currentTarget.value;
        if (val === '__custom__') {
          customSchoolMode = true;
          renderBiDialog(linkCode);
          dlg.querySelector('#bi-sync-custom-name')?.focus();
          return;
        }
        customSchoolMode = false;
        if (val === '__private__') {
          await window.StudyCommunity?.updateProfileSchool?.('Prefer not to say', '');
          toast('School hidden.');
          renderBiDialog(linkCode);
          return;
        }
        const preset = (window.StudyCommunity?.SCHOOL_CATALOG || []).find((s) => s.name === val);
        if (preset) {
          await window.StudyCommunity?.updateProfileSchool?.(preset.name, preset.canvasOrigin);
          toast(`School set to ${preset.name}.`);
        } else {
          await window.StudyCommunity?.updateProfileSchool?.('', '');
        }
        renderBiDialog(linkCode);
      });
      dlg.querySelector('#bi-sync-custom-save')?.addEventListener('click', async () => {
        const name = String(dlg.querySelector('#bi-sync-custom-name')?.value || '').trim();
        const url = String(dlg.querySelector('#bi-sync-custom-url')?.value || '').trim();
        customSchoolMode = Boolean(name || url);
        await window.StudyCommunity?.updateProfileSchool?.(name, url);
        toast(name || url ? `Saved school: ${name || url}.` : 'Cleared custom school.');
        renderBiDialog(linkCode);
      });
      const demoCard = dlg.querySelector('#bi-demo-card');
      const demoToggle = dlg.querySelector('#bi-demo-toggle');
      demoToggle?.addEventListener('click', () => {
        if (!demoCard) return;
        const paused = demoCard.classList.toggle('is-paused');
        demoToggle.textContent = paused ? 'Play' : 'Pause';
      });
      const triggerSignin = async () => {
        dlg.close();
        const ok = await window.StudyCommunity?.requireProfile?.({ allowDemo: true, forcePrompt: true });
        if (ok) openBiSyncHub(opts);
      };
      dlg.querySelector('#bi-signin-btn')?.addEventListener('click', triggerSignin);
      dlg.querySelector('#bi-mat-signin-btn')?.addEventListener('click', triggerSignin);

      dlg.querySelector('#bi-gen-code')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Generating…';
        try {
          const res = await window.StudyCommunity.createLinkCode();
          renderBiDialog(res);
          toast('6-character pairing code ready (valid 5 min).');
        } catch (err) {
          toast(err?.message || 'Could not generate pairing code.');
          btn.disabled = false;
          btn.textContent = 'Generate 6-char pairing code';
        }
      });
      dlg.querySelector('#bi-copy-code')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(formattedCode);
          toast('Copied pairing code.');
        } catch {
          toast('Select and copy the code above.');
        }
      });
      dlg.querySelector('#bi-refresh-sync')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Refreshing…';
        try {
          await renderCourseDirectory();
          await syncCloudProgress({ interactive: true });
          const afterWs = loadWebState();
          if (afterWs.canvasSnapshot?.courses?.length || (afterWs.customSchedule?.enabled && afterWs.customSchedule?.blocks?.length)) {
            markBiSyncedNow();
          }
          await loadPersonalMaterials(linkCode);
          renderBiDialog(linkCode);
          if (currentView === 'home') renderHome();
          else if (currentView === 'schedule') renderScheduleStudio();
        } finally {
          btn.disabled = false;
        }
      });

      const courseSel = dlg.querySelector('#bi-mat-course');
      courseSel?.addEventListener('change', () => {
        selectedMatCourse = courseSel.value;
      });
      const cloudCb = dlg.querySelector('#bi-mat-sync-cloud');
      cloudCb?.addEventListener('change', () => {
        syncCloudToo = cloudCb.checked;
      });

      const handleUploadFiles = async (fileList) => {
        const files = Array.from(fileList || []).filter(Boolean);
        if (!files.length) return;
        const opt = courseSel?.selectedOptions?.[0];
        const courseCode = courseSel?.value || '';
        const courseTitle = opt?.dataset?.title || '';
        const preferredCourseId = opt?.dataset?.courseId || '';

        // 1. Instantly save & auto-match PDFs locally in IndexedDB (no 40 MB limit — up to 260 MB per PDF!)
        const pdfFiles = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
        let matchedCount = 0;
        let unlockedExercises = 0;
        if (pdfFiles.length && window.StudyLocalSources?.saveBatchAcrossCourses) {
          uploadStatusText = `Matching ${pdfFiles.length} PDF${pdfFiles.length === 1 ? '' : 's'} against Study-OS courses…`;
          renderBiDialog(linkCode);
          const banksByCourse = {};
          await Promise.all((boot.catalog || []).map(async (c) => {
            try { banksByCourse[c.courseId] = await ensureCourseBank(c.courseId); } catch {}
          }));
          const localRes = await window.StudyLocalSources.saveBatchAcrossCourses(pdfFiles, banksByCourse, preferredCourseId);
          for (const rec of localRes.saved) {
            if (rec.matched) {
              matchedCount += 1;
              unlockedExercises += Number(rec.matchedExercises || 0);
            }
          }
          if (localRes.saved.length) {
            lastMatchBanner = matchedCount
              ? `Matched ${matchedCount} PDF${matchedCount === 1 ? '' : 's'} → unlocked Study-OS inline page jumps across ${unlockedExercises} exercises!`
              : `Saved ${localRes.saved.length} PDF${localRes.saved.length === 1 ? '' : 's'} privately in this browser for instant local reading.`;
          }
          if (localRes.errors.length) toast(localRes.errors[0]);
        }

        // 2. Optionally cloud-sync files ≤ 50 MB across devices (200 MB profile locker)
        const signedInNow = Boolean(window.StudyCommunity?.isSignedIn?.());
        const CLOUD_MAX_FILE = 50 * 1024 * 1024;
        if (signedInNow && syncCloudToo) {
          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (file.size > CLOUD_MAX_FILE) {
              toast(`"${file.name}" (${formatFileSize(file.size)}) saved locally in browser — skipped cloud sync (>50 MB).`);
              continue;
            }
            uploadStatusText = `Cloud-syncing ${i + 1}/${files.length}: ${file.name}…`;
            renderBiDialog(linkCode);
            try {
              await window.StudyCommunity.uploadMaterial(file, {
                courseCode,
                courseTitle,
                onProgress: (done, total) => {
                  const st = dlg.querySelector('#bi-mat-upload-status');
                  if (st) st.textContent = `Cloud-syncing ${file.name} (${done}/${total})…`;
                },
              });
            } catch (err) {
              toast(err?.message || `Saved locally; cloud sync skipped for ${file.name}.`);
            }
          }
        }
        uploadStatusText = '';
        await loadPersonalMaterials(linkCode);
        renderBiDialog(linkCode);
        if (currentView === 'references') renderReferencesHub();
        if (currentView === 'course') await renderCourseExplorer(selectedCourseId);
      };

      dlg.querySelectorAll('[data-bi-open-local]').forEach((btn) => {
        btn.addEventListener('click', () => {
          openLocalPdf(btn.dataset.biLocalTitle || 'Local PDF', '', btn.dataset.biOpenLocal);
        });
      });
      dlg.querySelectorAll('[data-bi-edit-local]').forEach((btn) => {
        btn.addEventListener('click', () => {
          window.StudyPdfCraft?.openSource?.({
            localSourceKey: btn.dataset.biEditLocal,
            title: btn.dataset.biLocalTitle || 'Local PDF',
          }, {
            onSaved: () => renderBiDialog(linkCode),
          });
        });
      });
      dlg.querySelectorAll('[data-bi-del-local]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await window.StudyLocalSources?.remove?.(btn.dataset.biDelLocal);
          toast('Removed local PDF from this browser.');
          renderBiDialog(linkCode);
          if (currentView === 'course') await renderCourseExplorer(selectedCourseId);
        });
      });

      const fileInput = dlg.querySelector('#bi-mat-file-input');
      fileInput?.addEventListener('change', () => {
        handleUploadFiles(fileInput.files);
      });
      const dropzone = dlg.querySelector('#bi-mat-dropzone');
      if (dropzone) {
        dropzone.addEventListener('dragover', (ev) => {
          ev.preventDefault();
          dropzone.classList.add('is-dragover');
        });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
        dropzone.addEventListener('drop', (ev) => {
          ev.preventDefault();
          dropzone.classList.remove('is-dragover');
          handleUploadFiles(ev.dataTransfer?.files);
        });
      }

      dlg.querySelectorAll('[data-bi-open-mat]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await window.StudyCommunity.openMaterial(btn.dataset.biOpenMat, btn.dataset.biMatTitle);
          } catch (err) {
            toast(err?.message || 'Could not open file.');
          } finally {
            btn.disabled = false;
          }
        });
      });
      dlg.querySelectorAll('[data-bi-del-mat]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await window.StudyCommunity.deleteMaterial(btn.dataset.biDelMat);
            toast('Removed file from your profile.');
            await loadPersonalMaterials(linkCode);
            if (currentView === 'references') renderReferencesHub();
          } catch (err) {
            toast(err?.message || 'Could not remove file.');
            btn.disabled = false;
          }
        });
      });
    };

    renderBiDialog();
    if (!dlg.open) {
      dlg.showModal();
      dlg.focus({ preventScroll: true });
    }
    loadPersonalMaterials();
    if (opts.focusMaterials) {
      setTimeout(() => dlg.querySelector('#bi-materials-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
  }

  const pendingExtFetches = new Map();

  function fetchCanvasPdfViaExtension(courseId, fileId, canvasOrigin = '') {
    return new Promise((resolve, reject) => {
      if (!document.documentElement.dataset.studyOsSyncExt) {
        reject(new Error('Install or reload Study-OS Sync v1.6.0 in Chrome to load Canvas PDFs inline.'));
        return;
      }
      const origin = canvasOrigin ? safeCanvasOrigin(canvasOrigin) : getSyncedSchoolInfo().origin;
      const requestId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pendingExtFetches.delete(requestId);
        reject(new Error(`Timed out loading PDF from Canvas (${new URL(origin).hostname}). Make sure you are signed in to Canvas in Chrome.`));
      }, 28_000);
      pendingExtFetches.set(requestId, { resolve, reject, timer });
      window.postMessage({
        type: 'STUDY_OS_FETCH_CANVAS_FILE',
        requestId,
        courseId: String(courseId || ''),
        fileId: String(fileId || ''),
        canvasOrigin: origin,
      }, window.location.origin);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'STUDY_OS_EXT_READY') {
      if (msg.version) document.documentElement.dataset.studyOsSyncExt = String(msg.version);
      window.StudyRunner?.refreshCurrent?.();
      return;
    }

    if (msg.type === 'STUDY_OS_CANVAS_FILE_RESULT' && msg.requestId) {
      const pending = pendingExtFetches.get(msg.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingExtFetches.delete(msg.requestId);
      if (!msg.ok || !msg.dataBase64) {
        pending.reject(new Error(msg.error || 'Could not load PDF from Canvas.'));
        return;
      }
      try {
        const bin = atob(msg.dataBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], msg.filename || 'canvas-source.pdf', { type: 'application/pdf' });
        pending.resolve(file);
      } catch {
        pending.reject(new Error('Could not decode PDF received from Canvas.'));
      }
      return;
    }

    if (msg.type === 'STUDY_OS_SYNC_COMPLETE') {
      markBiSyncedNow();
      if (isDevSandbox()) {
        toast('Sync completed in cloud (turn off Dev Sandbox to pull live updates into this tab).');
        return;
      }
      if (isStaticWeb && window.StudyCommunity?.isSignedIn?.()) {
        syncCloudProgress({ interactive: false }).then(() => {
          if (currentView === 'home') {
            renderHome();
            renderCourseDirectory();
          } else if (currentView === 'schedule') renderScheduleStudio();
          else if (currentView === 'exams') renderExamsHub();
          const sInfo = getSyncedSchoolInfo();
          toast(`${sInfo.shortSchool ? `${sInfo.shortSchool} ` : ''}Canvas & Schedule updated from Study-OS Sync!`);
        }).catch(() => {});
      }
    }
  });

  function onDevModeChange(active) {
    if (!active) {
      if (isStaticWeb) {
        recomputeWebAnalytics();
        updateHeaderStats();
      } else {
        refreshBootstrap().catch(() => {});
      }
      if (currentView === 'analytics') renderAnalytics();
    }
    if (currentView === 'home') renderHome();
    syncSettingsRows();
  }

  return {
    isStaticMode,
    getCatalog: () => boot.catalog || [],
    launchCourseBlock: (courseId, mins = 50) => launchSmartCourseRun(courseId, mins, 'learning', '', getResolvedFocusMode()),
    communityStats,
    publicReferenceUrl,
    fetchReferenceSection,
    getProgressRecord,
    effectiveDifficulty,
    effectiveDlpfc,
    calibratedParSec,
    computeWeightedUpi,
    gradeFromPct,
    recordExamResult,
    refreshBootstrap,
    refreshArchiveViews,
    syncSettingsRows,
    syncCloudProgress,
    queueCloudSync,
    getUserSchoolConfig,
    onSchoolChanged,
    getBiSyncStatus,
    openBiSyncHub,
    getEdSnapshot: () => (isStaticWeb ? loadWebState().edSnapshot : null),
    renderEdFeedInto,
    fetchCanvasPdfViaExtension,
    onDevModeChange,
    navigate,
    toggleSiteReferenceSidebar,
    renderHome,
    showRawView,
    setQuestionStatus,
    setQuestionDifficulty,
    saveDraft,
    debouncedSaveDraft,
    flushPendingDrafts,
    logAttempt,
    logSession,
  };
})();
