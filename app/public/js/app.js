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

  function loadWebState() {
    try {
      const raw = JSON.parse(localStorage.getItem(WEB_STATE_KEY) || '{}');
      return {
        records: raw.records || {},
        attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
        customSchedule: raw.customSchedule || { enabled: false, prefs: {}, blocks: [] },
        canvasSnapshot: raw.canvasSnapshot || null,
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
    if (scheduleChanged) {
      ws.customSchedule = { ...schedule, prefs: { ...schedule.prefs,
        timeeditUrl: schedule.prefs.timeeditUrl || currentSchedule.prefs?.timeeditUrl || '',
      } };
    }
    const snapshot = data.canvasSnapshot;
    const canvasChanged = snapshot && Array.isArray(snapshot.courses) &&
      backupTime(snapshot.syncedAt) > backupTime(ws.canvasSnapshot?.syncedAt);
    if (canvasChanged) ws.canvasSnapshot = snapshot;
    if (!saveWebState(ws)) return '';

    const restored = [
      changed ? `${changed} progress records` : '',
      ws.attempts.length > originalAttemptCount ? `${ws.attempts.length - originalAttemptCount} attempts` : '',
      ws.sessions.length > originalSessionCount ? `${ws.sessions.length - originalSessionCount} sessions` : '',
      scheduleChanged ? 'your schedule' : '',
      canvasChanged ? 'Canvas deadlines' : '',
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

  function recomputeWebAnalytics() {
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
    const upi = computeWeightedUpi(attempts, 0.9);
    const byCourseBuckets = {};
    const byCourseTierBuckets = {};
    for (const a of attempts) {
      const cid = a.courseId || String(a.questionId || '').split(':')[0];
      if (!cid) continue;
      (byCourseBuckets[cid] = byCourseBuckets[cid] || []).push(a);
      const t = String(a.dlpfcTier || qTierLookup[a.questionId] || (a.kind === 'mcq' ? 1 : 2));
      const ctKey = `${cid}:${t}`;
      (byCourseTierBuckets[ctKey] = byCourseTierBuckets[ctKey] || []).push(a);
    }
    const summarizeBucket = (arr) => ({
      count: arr.length,
      avgAccuracy: arr.reduce((s, a) => s + Number(a.qualityAccuracy || 0), 0) / arr.length,
      beatAiRate: arr.filter((a) => a.beatAi).length / arr.length,
      upi: computeWeightedUpi(arr, 0.9),
    });
    const byCourse = Object.fromEntries(Object.entries(byCourseBuckets).map(([k, arr]) => [k, summarizeBucket(arr)]));
    const byCourseTier = Object.fromEntries(Object.entries(byCourseTierBuckets).map(([k, arr]) => [k, summarizeBucket(arr)]));
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
      subgroups: { byCourse, byCourseTier, byDlpfcTier: {}, byKind: {}, byTimeSlot: {} },
    };
    if (ws.customSchedule?.enabled && ws.customSchedule.blocks?.length) {
      boot.calendar = {
        updatedAt: ws.customSchedule.updatedAt || nowIso,
        source: ws.customSchedule.source || 'browser_schedule',
        estimate: ws.customSchedule.estimate || null,
        blocks: ws.customSchedule.blocks.map(block => {
          const start = Date.parse(block.startIso);
          const end = Date.parse(block.endIso);
          const at = Date.parse(nowIso);
          const timingState = end <= at ? 'past' : start <= at ? 'live_now' : 'upcoming';
          return { ...block, timingState };
        }),
      };
      boot.scheduleConfig = {
        enabled: true,
        source: ws.customSchedule.source || 'browser_schedule',
        prefs: ws.customSchedule.prefs || {},
        estimate: ws.customSchedule.estimate || null,
      };
    } else {
      boot.calendar = { source: 'static_web', blocks: [] };
      boot.scheduleConfig = { enabled: false, prefs: ws.customSchedule?.prefs || {} };
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

  function buildWebBackupPayload() {
    flushWebDrafts();
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
      if (!pushOnly) {
        const remote = await window.StudyCommunity.fetchCloudBackup();
        if (remote?.hasBackup && remote.data) {
          cloudRecCount = Number(remote.recordCount || 0);
          cloudAttemptCount = Number(remote.attemptCount || 0);
          cloudSessionCount = Number(remote.sessionCount || 0);
          cloudScheduleAt = backupTime(remote.data.customSchedule?.updatedAt);
          cloudCanvasAt = backupTime(remote.data.canvasSnapshot?.syncedAt);
          const msg = restoreWebBackup(remote.data);
          if (msg && msg.startsWith('Restored ')) {
            mergedFromCloud = true;
            recomputeWebAnalytics();
            updateHeaderStats();
            if (currentView === 'home') renderHome();
            else if (currentView === 'analytics') renderAnalytics();
            else if (currentView === 'schedule') renderScheduleStudio();
          }
        }
      }
      const payload = buildWebBackupPayload();
      const localRecCount = Object.keys(payload.progress.records || {}).length;
      const localAttemptCount = (payload.attempts || []).length;
      const localSessionCount = (payload.sessions || []).length;
      const scheduleAt = backupTime(payload.customSchedule.updatedAt);
      const canvasAt = backupTime(payload.canvasSnapshot?.syncedAt);
      const hasLocalData = localRecCount > 0 || localAttemptCount > 0 || localSessionCount > 0 || scheduleAt > 0 || canvasAt > 0;
      const shouldPush = pushOnly || interactive || (hasLocalData && (
        localRecCount !== cloudRecCount || localAttemptCount !== cloudAttemptCount || localSessionCount !== cloudSessionCount ||
        scheduleAt > cloudScheduleAt || canvasAt > cloudCanvasAt || mergedFromCloud
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

  function syncSettingsRows() {
    window.StudyUI?.devMode?.syncUi?.();
    const communityOn = Boolean(window.StudyCommunity?.enabled);
    const signedIn = Boolean(window.StudyCommunity?.isSignedIn?.());
    const prof = window.StudyCommunity?.getCurrentProfile?.() || null;
    const syncTip = document.getElementById('mobile-sync-tip');
    let tipDismissed = false;
    try { tipDismissed = sessionStorage.getItem('study-os-dismiss-mobile-sync') === '1'; } catch {}
    syncTip.hidden = !isStaticWeb || !communityOn || tipDismissed ||
      (signedIn && boot.scheduleConfig?.enabled && Boolean(loadWebState().canvasSnapshot));
    document.getElementById('mobile-sync-action').textContent = signedIn ? 'Open Schedule' : 'Sign in';

    const profileAvatar = document.getElementById('settings-profile-avatar');
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
          ? 'Full library active — tap to lock on this browser'
          : 'Unlock question banks, sources & worked answers';
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

  function showRawView(name) {
    document.body.classList.toggle('in-runner', name === 'runner');
    for (const v of ['home', 'references', 'schedule', 'exams', 'course', 'runner', 'analytics', 'community', 'room']) {
      const sec = document.getElementById(`view-${v}`);
      if (sec) sec.hidden = v !== name;
    }
    document.querySelectorAll('.tab-btn, .mobile-dock-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.nav === name);
      if (b.dataset.nav === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    window.StudyTutor.changed();
    window.StudyAiTutor?.syncContext?.();
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
      const tierLabel = (t) => window.StudyLayout?.label?.(t) || (t === 1 ? 'Low DLPFC' : t === 2 ? 'Med DLPFC' : 'High DLPFC');
      const modeNote =
        sessionFocusMode !== 'auto'
          ? `Mode: ${resolvedFocus === 'high_dlpfc' ? `${tierLabel(3)} · Multi-step` : resolvedFocus === 'low_dlpfc' ? `${tierLabel(1)} · Recall` : `${tierLabel(2)} · Standard practice`}`
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
              Start ${primary.focusMinutes}m ${resolvedFocus === 'high_dlpfc' ? `${tierLabel(3)} ` : resolvedFocus === 'low_dlpfc' ? `${tierLabel(1)} ` : ''}Run →
            </button>
            <div class="row-actions" style="gap:6px">
              ${
                cMeta
                  ? `<button type="button" class="ghost-btn" style="flex:1" id="btn-hero-deep-filter">${esc(tierLabel(3))}</button>
                     <button type="button" class="ghost-btn" style="flex:1" id="btn-hero-ref">${esc(cMeta.shortTitle)} Ref</button>`
                  : ''
              }
              ${isStaticWeb ? '<button type="button" class="ghost-btn" id="btn-web-bi-sync">Sync BI</button>' : ''}
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
                        <small>${b.autoQueue?.questionIds?.length || 0} queued${b.autoQueue?.cognitiveMode === 'high_dlpfc' ? ` · ${esc(tierLabel(3))}` : b.autoQueue?.cognitiveMode === 'med_dlpfc' ? ` · ${esc(tierLabel(2))}` : b.autoQueue?.cognitiveMode === 'low_dlpfc' ? ` · ${esc(tierLabel(1))}` : ''}</small>
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
      document.getElementById('btn-web-bi-sync')?.addEventListener('click', () => openBiSyncHub());
      heroEl.querySelectorAll('[data-launch-event]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const blk = (boot.calendar?.blocks || []).find((x) => x.eventId === btn.dataset.launchEvent);
          if (blk) launchCalendarBlock(blk);
        });
      });
    } else if (isStaticWeb) {
      const questionCount = boot.catalog.reduce((count, c) => count + c.questionCount, 0);
      const nextExam = [...boot.catalog]
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
            <p class="muted" style="margin:0">${boot.catalog.length} subjects · ${questionCount} questions · ${(boot.references || []).length} course notes</p>
          </div>
          <div class="row-actions">
            <button type="button" class="primary-btn" id="btn-web-refs">Course notes</button>
            <button type="button" class="ghost-btn" id="btn-web-exams">Mock exams</button>
            <button type="button" class="ghost-btn" id="btn-web-bi-sync">Sync BI</button>
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

    // 4. Difficulty / DLPFC Picker + Duration Picker + Semester Filter + Courses Grid
    const tierLbl = (t) => window.StudyLayout?.label?.(t) || (t === 1 ? 'Low DLPFC' : t === 2 ? 'Med DLPFC' : 'High DLPFC');
    const diffWord = homeDifficulty === 'all' ? '' : tierLbl(Number(homeDifficulty));
    const eyebrowEl = document.getElementById('home-courses-eyebrow');
    if (eyebrowEl) {
      eyebrowEl.textContent = `Active Semester Courses · ${homeBlockMinutes}m AI Par Blocks${diffWord ? ` · ${diffWord}` : ''}`;
    }
    const diffSeg = document.getElementById('home-difficulty-seg');
    if (diffSeg) {
      diffSeg.querySelectorAll('[data-home-diff]').forEach((btn) => {
        const val = btn.dataset.homeDiff;
        if (val !== 'all') btn.textContent = tierLbl(Number(val));
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
        const cm = homeDifficulty !== 'all'
          ? (a.subgroups?.byCourseTier?.[`${c.courseId}:${homeDifficulty}`] || {})
          : (a.subgroups?.byCourse?.[c.courseId] || {});
        const pct = cp.total ? Math.round((cp.done / cp.total) * 100) : 0;
        const daysLeft = daysUntilDateStr(c.examInfo?.date);
        const targetMs = examTargetMs(c.examInfo);
        const examTip = formatExamHoverTip(c.examInfo, targetMs);
        const examBadge = Number.isFinite(targetMs) && targetMs > Date.now() - 14400_000
          ? `<span class="badge exam-tip-host ${daysLeft !== null && daysLeft >= 0 && daysLeft <= 14 ? 'warn' : ''}" data-exam-tip="${esc(examTip)}" aria-label="${esc(examTip)}" tabindex="0"><span class="exam-countdown-live" data-exam-target-ms="${targetMs}" data-exam-countdown-mode="card">${esc(formatExamCountdown(targetMs, 'card'))}</span></span>`
          : '';
        const noItemsInDiff = homeDifficulty !== 'all' && cp.total === 0;

        return `<article class="course-card" style="--course-accent:${esc(c.color)}">
          <div>
            <div class="row-between" style="margin:0 0 8px">
              <span class="course-code-pill" style="--pill-color:${esc(c.color)}">${esc(c.code)}${semesters.length > 1 && c.semester ? ` · ${esc(c.semester)}` : ''}</span>
              <div class="row-actions">${examBadge}</div>
            </div>
            <h3 class="course-card-title" data-open-course="${esc(c.courseId)}" role="button" tabindex="0">${esc(c.title)}</h3>
            <div class="course-progress-wrap">
              <div class="course-bar"><div class="course-bar-fill" style="width:${pct}%;background:${esc(c.color)}"></div></div>
              <span class="course-pct">${pct}%</span>
            </div>
            <div class="course-stats-row">
              <span><b>${cp.done}</b>/${cp.total} ${diffWord ? `${diffWord.toLowerCase()} ` : ''}done</span>
              ${isStaticWeb || homeDifficulty !== 'all' ? '' : `<span>· <b>${c.highDlpfcCount ?? c.writtenOrCalcCount ?? 0}</b> Hard</span>`}
              <span>· <b>${cp.revisit}</b> revisit</span>
              <span>· UPI <b>${cm.upi ?? '—'}</b></span>
            </div>
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
  }

  function renderCanvasBridgeStrip() {
    const strip = document.getElementById('canvas-bridge-strip');
    if (!strip) return;

    if (isStaticWeb) {
      strip.innerHTML = '';
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
                <h4 style="margin:8px 0 4px">3. TimeEdit / AI Schedule</h4>
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

  function openLocalPdf(name, rawUrl) {
    const dialog = document.getElementById('local-book-dialog');
    const reader = document.getElementById('local-book-reader');
    document.getElementById('local-book-title').textContent = name;
    reader.innerHTML = window.StudyPdf.viewer();
    dialog.showModal();
    window.StudyPdf.mount(reader, { rawUrl, page: 1 }, { page: 1, zoom: 100, trim: false });
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
    const feedback = document.getElementById('member-feedback');
    const submit = form.querySelector('button[type=submit]');
    const dismiss = () => {
      try { sessionStorage.setItem('study-os-member-dismissed', '1'); } catch {}
      key.value = '';
      dialog.close();
    };
    const show = () => {
      window.StudyUI.closeSettings?.();
      feedback.textContent = '';
      dialog.showModal();
    };
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
        for (const courseId of Object.keys(bankCache)) delete bankCache[courseId];
        await refreshBootstrap();
        show();
      } else {
        if (!window.StudyCommunity.hasProfile()
            && !await window.StudyCommunity.requireProfile({ allowDemo: true, forcePrompt: true })) return;
        await members.restore();
        if (members.isUnlocked()) await refreshBootstrap();
        else show();
      }
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
    ensureExamCountdownTicker();
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
        const targetMs = examTargetMs(c.examInfo);
        const examTip = formatExamHoverTip(c.examInfo, targetMs);
        const daysPill =
          Number.isFinite(targetMs) && targetMs > Date.now() - 14400_000
            ? `<span class="badge exam-tip-host ${daysLeft !== null && daysLeft <= 14 && daysLeft >= 0 ? 'warn' : 'gold'}" data-exam-tip="${esc(examTip)}" aria-label="${esc(examTip)}" tabindex="0"><span class="exam-countdown-live" data-exam-target-ms="${targetMs}" data-exam-countdown-mode="exam">${esc(formatExamCountdown(targetMs, 'exam'))}</span></span>`
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

  function buildEffortSortedQueue(questions, budgetMinutes = 75, profile = 'learning', filterTopics = [], effortMode = 'auto', quick = false, exactDifficulty = 0) {
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
    const bank = await ensureCourseBank(block.courseId);
    const cMeta = boot.catalog.find((c) => c.courseId === block.courseId);
    const prof = block.recommendedProfile || 'learning';
    const blockDlpfcMode = block.dlpfcMode
      || (/high\s*dlpfc/i.test(block.summary || '') ? 'high_dlpfc'
        : /low\s*dlpfc/i.test(block.summary || '') || block.blockKind === 'recall_sprint' ? 'low_dlpfc'
        : /med(?:ium)?\s*dlpfc/i.test(block.summary || '') ? 'med_dlpfc'
        : getResolvedFocusMode());
    let qids = (block.autoQueue?.questionIds || []).filter((id) => getProgressRecord(id)?.status !== 'done');
    if (sessionFocusMode !== 'auto' || block.dlpfcMode || !qids.length) {
      qids = buildEffortSortedQueue(
        bank.questions || [],
        Number(block.attemptBudgetMinutes || block.focusMinutes || homeBlockMinutes || 50),
        prof,
        block.topicIds || [],
        blockDlpfcMode
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

  async function launchSmartCourseRun(courseId, budgetMinutes = 75, profile = 'learning', filterTopic = '', effortMode = 'auto', quick = false, exactDifficulty = 0) {
    const bank = await ensureCourseBank(courseId);
    const cMeta = boot.catalog.find((c) => c.courseId === courseId);
    const chosen = buildEffortSortedQueue(
      bank.questions || [],
      budgetMinutes,
      profile,
      filterTopic ? [filterTopic] : [],
      quick ? 'med_dlpfc' : effortMode,
      quick,
      exactDifficulty
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
        ${localLibrary}

        <div class="preset-chips-bar" role="group" aria-label="Practice difficulty presets">
          <small class="muted" style="font-weight:700;margin-right:4px">PRESETS:</small>
          <button type="button" class="preset-chip" data-exp-preset="high_dlpfc" data-layout-tier="3">${window.StudyLayout.label(3)}</button>
          <button type="button" class="preset-chip" data-exp-preset="med_dlpfc" data-layout-tier="2">${window.StudyLayout.label(2)}</button>
          <button type="button" class="preset-chip" data-exp-preset="low_dlpfc" data-layout-tier="1">${window.StudyLayout.label(1)}</button>
          <button type="button" class="preset-chip" data-exp-preset="long_horizon">Long Horizon (10m+)</button>
          ${cMeta.flowmultiCount ? '<button type="button" class="preset-chip" data-exp-preset="wiseflow_only">Worksheets</button>' : ''}
          <button type="button" class="preset-chip active" data-exp-preset="reset">Reset filters</button>
        </div>

        <div class="explorer-primary-bar" style="margin-top:12px">
          <input type="search" id="flt-search" placeholder="Search concepts, formulas, question IDs…" style="min-width:210px;flex:1.4">
          <select id="flt-topic" aria-label="Topic or chapter" style="min-width:170px;flex:1">${topicOptions}</select>
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
                <option value="budget:25">25 min Focus Block (AI Par)</option>
                <option value="budget:50" selected>50 min Study Block (AI Par)</option>
                <option value="budget:75">75 min Deep Block (AI Par)</option>
                <option value="count:12">Top 12 Matching Tasks</option>
                <option value="all">All Matching (Full Set)</option>
                <option value="exam_sim">Blind Exam Sit (Countdown + Submit)</option>
              </select>
            </label>
            <label class="field-label">AI Pace Benchmark
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
            <small class="muted">Click any status dot or Practice to launch straight into a question.</small>
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
        bEl.value = 'budget:50';
      } else if (presetName === 'med_dlpfc') {
        kEl.value = 'all';
        dEl.value = '2';
        hEl.value = 'all';
        sEl.value = 'unfinished';
        sortEl.value = 'smart_priority';
        bEl.value = 'budget:50';
      } else if (presetName === 'low_dlpfc') {
        kEl.value = 'all';
        dEl.value = '1';
        hEl.value = 'all';
        sEl.value = 'unfinished';
        sortEl.value = 'horizon_asc';
        bEl.value = 'budget:50';
      } else if (presetName === 'long_horizon') {
        kEl.value = 'no_mcq';
        dEl.value = 'all';
        hEl.value = '10plus';
        sEl.value = 'unfinished';
        sortEl.value = 'horizon_desc';
        bEl.value = 'budget:75';
      } else if (presetName === 'wiseflow_only') {
        kEl.value = 'wiseflow';
        dEl.value = 'all';
        hEl.value = 'all';
        sEl.value = 'unfinished';
        sortEl.value = 'horizon_desc';
      } else {
        document.getElementById('flt-topic').value = 'all';
        document.getElementById('flt-coll').value = 'all';
        kEl.value = 'all';
        dEl.value = 'all';
        hEl.value = 'all';
        sEl.value = 'unfinished';
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

      const qLearnMin = (q) => calibratedParSec(q, 'learning') / 60;
      const qActiveMin = (q) => calibratedParSec(q, prof) / 60;

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
          return `<tr>
            <td><strong>${esc(q.title)}</strong><br><small class="muted">${esc(q.localId || q.id)}</small></td>
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

    root.querySelectorAll('[data-exp-preset]').forEach((chip) => {
      chip.addEventListener('click', () => {
        applyPreset(chip.dataset.expPreset);
        refreshTable();
      });
    });

    members.bindDownloads(root);
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
              <h2 id="ref-pane-title" tabindex="-1" style="margin:2px 0 0">${esc(activeEntry?.title || 'Reference')}</h2>
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
      card.addEventListener('click', async () => {
        const file = card.dataset.refPick;
        selectedRefFile = file;
        await renderReferencesHub();
        if (selectedRefFile === file && currentView === 'references' && matchMedia('(max-width: 980px)').matches) {
          root.querySelector('#ref-pane-title')?.focus({ preventScroll: true });
          root.querySelector('.ref-reader-pane')?.scrollIntoView({ block: 'start' });
        }
      });
    });

    root.querySelectorAll('[data-ref-practice]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate('course', { courseId: btn.dataset.refPractice });
      });
    });

    // Show user's personal synced curriculum PDFs & materials cleanly in the Notes sidebar
    if (isStaticWeb && window.StudyCommunity?.isSignedIn?.() && window.StudyCommunity?.listMaterials) {
      const aside = root.querySelector('.ref-sidebar');
      if (aside) {
        const box = document.createElement('div');
        box.className = 'ref-personal-materials';
        box.innerHTML = `
          <div class="row-between" style="margin:0 0 8px;gap:8px">
            <strong style="font-size:13px">My synced PDFs &amp; materials</strong>
            <button type="button" class="ghost-btn" id="ref-add-materials-btn" style="padding:4px 10px;font-size:12px">+ Add PDFs</button>
          </div>
          <div id="ref-personal-materials-list"><small class="muted">Loading…</small></div>
        `;
        aside.appendChild(box);
        box.querySelector('#ref-add-materials-btn').onclick = () => openBiSyncHub({ focusMaterials: true });
        window.StudyCommunity.listMaterials().then((res) => {
          const listEl = box.querySelector('#ref-personal-materials-list');
          if (!listEl || !listEl.isConnected) return;
          const items = Array.isArray(res?.items) ? res.items : [];
          if (!items.length) {
            listEl.innerHTML = '<small class="muted">No personal PDFs uploaded yet. Tap + Add PDFs to sync curriculum files to your profile.</small>';
            return;
          }
          listEl.innerHTML = items.map((m) => `
            <div class="bi-material-row">
              <div class="bi-material-meta">
                ${m.courseCode ? `<span class="badge">${esc(m.courseCode)}</span>` : ''}
                <span class="bi-material-title" title="${esc(m.title)}">${esc(m.title)}</span>
              </div>
              <button type="button" class="ghost-btn bi-mat-mini-btn" data-open-mat="${esc(m.id)}" data-mat-title="${esc(m.title)}">Open ↗</button>
            </div>
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
          if (listEl) listEl.innerHTML = '<small class="muted">Could not load personal materials.</small>';
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

  function renderScheduleStudio() {
    const root = document.getElementById('schedule-studio-root');
    const cfg = boot.scheduleConfig || {};
    const personalCanvas = isStaticWeb ? loadWebState().canvasSnapshot : null;
    const validCanvasId = id => /^[1-9][0-9]{0,19}$/.test(id || '');
    const due = (personalCanvas?.courses || []).filter(course => validCanvasId(course.id)).flatMap(course => (course.assignments || [])
      .filter(task => validCanvasId(task.id) && Date.parse(task.dueAt) >= Date.now())
      .map(task => ({ ...task, course: course.name, url: `https://canvas.bi.no/courses/${course.id}/assignments/${task.id}` })))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 15);
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
      ...(cfg.prefs || {}),
    };
    prefs.wakeTime ||= `${String(prefs.dayStartHour - 1).padStart(2, '0')}:30`;
    prefs.bedTime ||= `${String(prefs.dayEndHour).padStart(2, '0')}:30`;
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
            <h1 class="hero-title" style="margin:2px 0 4px">Study schedule</h1>
            <p class="muted" style="margin:0;font-size:13.5px">
              Plan two weeks around your classes, work hours, and sleep.
            </p>
          </div>
          <div class="row-actions">
            <button type="button" class="ghost-btn" id="btn-export-schedule">Download calendar (.ics)</button>
            ${!isStaticWeb ? '<a class="ghost-btn" href="./canvas-connect.html" target="_blank" rel="noopener">Canvas deadlines ↗</a>' : ''}
            ${cfg.enabled ? '<button type="button" class="ghost-btn" id="btn-reset-custom-sched">Revert to Default Calendar</button>' : ''}
          </div>
        </div>
      </div>

      ${desktopImport ? `
        <section class="panel device-setup-card">
          <h2>Desktop setup is ready to import</h2>
          ${desktopImport.customSchedule || desktopImport.canvasSnapshot ? `
            <p class="muted">Save your ${desktopImport.customSchedule ? 'study plan' : ''}${desktopImport.customSchedule && desktopImport.canvasSnapshot ? ' and ' : ''}${desktopImport.canvasSnapshot ? 'Canvas deadlines' : ''} to your Study-OS profile.</p>
            ${desktopImport.canvasSnapshot ? `<label class="check-row"><input type="checkbox" id="desktop-suggest-courses" ${suggestCourses ? 'checked' : ''}> Suggest new course names and codes for admin review</label>` : ''}
            <button type="button" class="primary-btn" id="btn-save-desktop-setup">Save to my profile</button>
          ` : '<p class="muted">Build a study plan or run Canvas Browser Sync on your computer, then send it again.</p>'}
        </section>` : ''}

      <section class="panel device-setup-card">
        <h2>One-click browser sync (Canvas · TimeEdit · Ed)</h2>
        ${isStaticWeb
          ? `<p class="muted">Install the Study-OS Chrome extension once, pair it with a 6-char device code, then click the extension while on <b>BI Canvas</b>, <b>TimeEdit</b>, or <b>Ed Discussion</b> to sync automatically across desktop and phone.</p>
             <div class="row-actions" style="flex-wrap:wrap">
               <button type="button" class="primary-btn" id="btn-pair-sync-ext">Get 6-char pairing code</button>
               <button type="button" class="ghost-btn" id="btn-pull-ext-timeedit">Import synced TimeEdit</button>
               <a class="ghost-btn" href="https://github.com/shadjosef/study-os/blob/main/docs/canvas-browser-sync.md" target="_blank" rel="noopener">Extension guide ↗</a>
             </div>`
          : '<p class="muted">After syncing your courses in Chrome, send your plan and Canvas deadlines to your online profile.</p><button type="button" class="ghost-btn" id="btn-send-desktop-setup">Send to phone ↗</button>'}
        ${personalCanvas ? '<h3>Canvas deadlines</h3>' + (due.length ? '<ul class="mobile-deadline-list">' +
          due.map(task => `<li><a href="${esc(task.url)}" target="_blank" rel="noopener">${esc(task.name)}</a><small>${esc(task.course)} · ${esc(new Date(task.dueAt).toLocaleString())}</small></li>`).join('') + '</ul>'
          : '<p class="muted">No upcoming Canvas deadlines.</p>') : ''}
      </section>

      <div class="schedule-studio-grid">
        <!-- PANEL A: TIMEEDIT + WORK HOURS AUTO-SCHEDULER -->
        <section class="panel" style="margin:0">
          <h2>Plan around TimeEdit</h2>
          <p class="muted">Open your timetable in TimeEdit, choose Subscribe (Abonnér), and copy the .ics link.</p>
          <div class="row-actions timetable-links">
            <a class="ghost-btn" href="https://cloud.timeedit.net/bi/web/public/ri1Q7.html" target="_blank" rel="noopener">Open BI TimeEdit ↗</a>
          </div>

          <label class="field-label">TimeEdit subscription link
            <input type="url" id="sch-te-url" value="${esc(prefs.timeeditUrl || '')}" placeholder="https://cloud.timeedit.net/… .ics" autocomplete="off" autocapitalize="off" spellcheck="false">
          </label>

          <label class="field-label" style="margin-top:8px">Or upload an .ics file
            <input type="file" id="sch-ics-file" accept=".ics,text/calendar" style="font-size:12.5px">
          </label>

          <div class="schedule-range-fields">
            <label class="field-label" for="sch-work-h">
              <span>Paid work per week <output id="sch-work-output" for="sch-work-h"></output></span>
              <input type="range" id="sch-work-h" min="0" max="50" step="1" value="${Number(prefs.weeklyWorkHours || 0)}">
            </label>
            <label class="field-label" for="sch-study-h">
              <span>Study time outside class <output id="sch-study-output" for="sch-study-h"></output></span>
              <input type="range" id="sch-study-h" min="2" max="45" step="0.5" value="${Number(prefs.targetStudyHours || est.recommendedStudyHours)}" ${prefs.autoAdjustStudy !== false ? 'disabled' : ''}>
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

          <div class="schedule-time-fields">
            <label class="field-label">Wake-up time
              <input type="time" id="sch-wake" required value="${esc(prefs.wakeTime)}">
            </label>
            <label class="field-label">Bedtime
              <input type="time" id="sch-bed" required value="${esc(prefs.bedTime)}">
            </label>
            <label class="field-label">Block Rhythm
              <select id="sch-rhythm">
                <option value="50:10" ${Number(prefs.blockMinutes) === 50 ? 'selected' : ''}>50m / 10m</option>
                <option value="75:15" ${Number(prefs.blockMinutes) === 75 ? 'selected' : ''}>75m / 15m</option>
                <option value="40:10" ${Number(prefs.blockMinutes) === 40 ? 'selected' : ''}>40m / 10m</option>
              </select>
            </label>
          </div>
          <p class="muted schedule-field-tip">Study starts at least 30 minutes after waking and ends at least 30 minutes before bedtime.</p>

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
            <button type="button" class="primary-btn" id="btn-generate-sched">Build my study plan</button>
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

      <section class="panel timetable-links">
        <h2>Add your plan to a calendar</h2>
        <p class="muted">Download your study blocks. Import the file into Google Calendar on a computer, or open it in Calendar on a Mac and choose your iCloud calendar.</p>
        <div class="row-actions">
          <a class="ghost-btn" href="https://calendar.google.com/calendar/r/settings/export" target="_blank" rel="noopener">Google Calendar import ↗</a>
          <a class="ghost-btn" href="https://support.apple.com/guide/calendar/icl1023/mac" target="_blank" rel="noopener">Apple Calendar import ↗</a>
        </div>
      </section>
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
        wakeTime: document.getElementById('sch-wake').value,
        bedTime: document.getElementById('sch-bed').value,
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
      document.getElementById('sch-work-output').value = `${p.weeklyWorkHours} h`;
      document.getElementById('sch-study-output').value = `${studyInput.value} h`;
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
    refreshEstimateUI();

    document.getElementById('btn-export-schedule').onclick = () => {
      try { window.StudySchedule.download(boot.calendar?.blocks || []); }
      catch (error) { toast(error.message); }
    };
    document.getElementById('btn-send-desktop-setup')?.addEventListener('click', sendDesktopSetup);
    document.getElementById('btn-save-desktop-setup')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await saveDesktopSetup(Boolean(document.getElementById('desktop-suggest-courses')?.checked)); }
      finally { button.disabled = false; }
    });

    document.getElementById('btn-generate-sched').onclick = async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      const formPrefs = collectFormPrefs();
      const fileEl = document.getElementById('sch-ics-file');
      try {
        window.StudySchedule.bounds(formPrefs.wakeTime, formPrefs.bedTime);
        const file = fileEl.files?.[0];
        if (file && file.size > 2_000_000) throw new Error('Choose an .ics file under 2 MB.');
        const icsText = file ? await file.text() : '';
        if (file) formPrefs.timeeditUrl = '';
        if (isStaticWeb) {
          const text = icsText || (formPrefs.timeeditUrl ? await window.StudyCommunity.fetchTimeEdit(formPrefs.timeeditUrl) : '');
          const ws = loadWebState();
          const fixed = text ? await window.StudySchedule.readCalendar(text) : (ws.customSchedule?.blocks || [])
            .filter(b => ['class_session', 'exam'].includes(b.blockKind) && Date.parse(b.endIso) > Date.now())
            .map(b => ({ uid: b.eventId, summary: b.summary, start: Date.parse(b.startIso), end: Date.parse(b.endIso), allDay: b.allDay }));
          const plan = window.StudySchedule.plan(fixed, formPrefs, boot.catalog, boot.analytics?.courseProgress || {}, computeClientStudyEstimate);
          if (!plan.blocks.length) throw new Error('No time fits these settings. Widen your awake hours or choose fewer rest days.');
          ws.customSchedule = {
            enabled: true, source: 'timeedit_auto_scheduler', prefs: formPrefs, blocks: plan.blocks,
            estimate: plan.estimate, updatedAt: new Date().toISOString(),
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
    };

    document.getElementById('btn-reset-custom-sched')?.addEventListener('click', async () => {
      if (isStaticWeb) {
        const ws = loadWebState();
        ws.customSchedule = { enabled: false, prefs: {}, blocks: [], updatedAt: new Date().toISOString() };
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
        const feed = await window.StudyCommunity.fetchExtensionTimeEdit();
        if (!feed?.hasFeed || !feed.calendar) {
          if (!silent) toast('No TimeEdit timetable synced from the extension yet. Open BI TimeEdit in Chrome and click Study-OS Sync.');
          return;
        }
        const lastApplied = Number(localStorage.getItem('study-os-ext-te-ts') || 0);
        if (silent && feed.updatedAt <= lastApplied) return;
        const formPrefs = collectFormPrefs();
        const fixed = await window.StudySchedule.readCalendar(feed.calendar);
        const plan = window.StudySchedule.plan(fixed, formPrefs, boot.catalog, boot.analytics?.courseProgress || {}, computeClientStudyEstimate);
        if (!plan.blocks.length) return;
        const ws = loadWebState();
        ws.customSchedule = {
          enabled: true, source: 'timeedit_extension_sync', prefs: formPrefs, blocks: plan.blocks,
          estimate: plan.estimate, updatedAt: new Date(feed.updatedAt || Date.now()).toISOString(),
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

    root.querySelectorAll('[data-sched-start]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const blk = (boot.calendar?.blocks || []).find((b) => b.eventId === btn.dataset.schedStart);
        if (blk) launchCalendarBlock(blk);
      });
    });
  }

  // ---------------------------------------------------------------------------
  async function renderCourseDirectory() {
    try {
      const items = await window.StudyCommunity.approvedCourses();
      const root = document.getElementById('community-course-directory');
      const grid = root.querySelector('.courses-grid');
      const currentIds = new Set(boot.catalog.map(course => String(course.canvasId || course.courseId?.split('-').pop() || '')));
      const currentCodes = new Set(boot.catalog.map(course => (course.code || '').toUpperCase().replace(/\s/g, '')));
      const shown = items.filter(course => {
        const hasCanvas = /^[1-9][0-9]{0,19}$/.test(course.canvasId || '');
        const hasEd = /^[1-9][0-9]{0,19}$/.test(course.edCourseId || '');
        if (!hasCanvas && !hasEd) return false;
        if (hasCanvas && currentIds.has(course.canvasId)) return false;
        if (course.code && currentCodes.has(course.code.toUpperCase().replace(/\s/g, ''))) return false;
        return true;
      });
      grid.innerHTML = shown.map((course, idx) => {
        const topics = Array.isArray(course.topics) ? course.topics : [];
        const contrib = Number(course.contributorCount || 1);
        const topicsHtml = topics.length
          ? `<div class="community-course-topics">${topics.slice(0, 5).map(t => `<span class="topic-mini-chip">${esc(t)}</span>`).join('')}${topics.length > 5 ? `<span class="topic-mini-chip">+${topics.length - 5}</span>` : ''}</div>`
          : '';
        const edHost = /^(?:[a-z]{2}\.)?edstem\.org$/.test(course.edHost || '') ? course.edHost : 'eu.edstem.org';
        return `<article class="course-card">
          <div>
            <div class="row-between" style="margin:0 0 8px">
              <span class="course-code-pill">${esc(course.code || 'BI Course')}</span>
              <span class="badge ${course.verified ? 'good' : ''}">${course.verified ? 'Verified' : 'Community'}</span>
            </div>
            <h3 class="course-card-title" style="cursor:default">${esc(course.title)}</h3>
            <p class="muted course-contrib-meta">${contrib} student${contrib === 1 ? '' : 's'} synced${topics.length ? ` · ${topics.length} module${topics.length === 1 ? '' : 's'}` : ''}</p>
            ${topicsHtml}
          </div>
          <div class="course-actions">
            <button type="button" class="primary-btn" data-comm-ai="${idx}">✨ AI Study</button>
            ${/^[1-9][0-9]{0,19}$/.test(course.canvasId || '') ? `<a class="ghost-btn" target="_blank" rel="noopener" href="https://canvas.bi.no/courses/${course.canvasId}">Canvas ↗</a>` : ''}
            ${/^[1-9][0-9]{0,19}$/.test(course.edCourseId || '') ? `<a class="ghost-btn" target="_blank" rel="noopener" href="https://${edHost}/courses/${course.edCourseId}">Ed ↗</a>` : ''}
          </div>
        </article>`;
      }).join('');
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

  function flushWebDrafts() {
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
      rec.personalDifficulty = fsrsGrade <= 2 ? 3 : fsrsGrade === 4 ? 1 : 2;
      rec.updatedAt = new Date().toISOString();
      saveWebState(ws);
      queueCloudSync();
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
    if (isDevSandbox()) {
      return { ok: true, devMode: true, analytics: boot.analytics };
    }
    if (isStaticWeb) {
      const ws = loadWebState();
      ws.sessions.push({ ...payload, endedAt: new Date().toISOString() });
      saveWebState(ws);
      queueCloudSync();
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
        out.push({
          group: 'Courses',
          title: `${c.code} · ${c.title}`,
          sub: `${c.questionCount} questions · Topics & practice`,
          keywords: `${c.code} ${c.title} ${c.shortTitle} course topics practice`,
          run: () => { leaveRunner(); navigate('course', { courseId: c.courseId }); },
        });
        out.push({
          group: 'Exams',
          title: `${c.code} Mock Exams`,
          sub: c.examInfo?.date ? `Exam ${c.examInfo.date}` : c.shortTitle,
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
      if (window.StudyCommunity?.enabled) views.push(['Community', 'community', 'leaderboard chat rooms profile']);
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
          sub: 'Appearance, sound, AI tutor & backup (,)',
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
          title: 'AI Tutor',
          sub: 'Live MCP exercise sharing & tutor prompt',
          keywords: 'ai tutor mcp claude codex prompt',
          run: () => window.StudyTutor?.open?.(),
        },
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
    document.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        if (dialog.open) dialog.close();
        else openPalette();
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
    if (isStaticWeb) window.addEventListener('pagehide', flushWebDrafts);
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
    document.getElementById('settings-signin-btn')?.addEventListener('click', async () => {
      window.StudyUI.closeSettings?.();
      const ok = await window.StudyCommunity.requireProfile({ allowDemo: true, forcePrompt: true });
      if (ok) {
        await window.StudyRooms.restore();
        await members.restore();
        await refreshBootstrap();
      }
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
          flushWebDrafts();
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
      const signedIn = await window.StudyCommunity.requireProfile({ allowDemo: true });
      if (signedIn) {
        await window.StudyRooms.restore();
        await members.restore();
      }
      await refreshBootstrap(false);
      if (isStaticWeb) renderCourseDirectory();
      if (signedIn && isStaticWeb) {
        syncCloudProgress().catch(() => {});
      }
      await window.StudySets.activateDraft();
      bindMemberAccess();
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
    const qDlpfc = params.get('dlpfc') || '';
    const autoStart = params.get('autostart') === '1';

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
        const mode = ['high_dlpfc', 'med_dlpfc', 'low_dlpfc'].includes(qDlpfc) ? qDlpfc : 'auto';
        const exact = mode === 'high_dlpfc' ? 3 : mode === 'med_dlpfc' ? 2 : mode === 'low_dlpfc' ? 1 : 0;
        await launchSmartCourseRun(qCourse, homeBlockMinutes || 50, 'learning', qTopic, mode, false, exact);
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

    let materialsState = { loaded: false, items: [], usedBytes: 0, maxBytes: 40 * 1024 * 1024 };
    let selectedMatCourse = '';
    let uploadStatusText = '';

    const getCourseChoices = () => {
      const seen = new Set();
      const out = [];
      for (const c of boot.catalog || []) {
        const code = String(c.code || '').trim();
        if (!code || seen.has(code)) continue;
        seen.add(code);
        out.push({ code, title: c.title || code });
      }
      const snap = loadWebState().canvasSnapshot;
      for (const c of snap?.courses || []) {
        const code = String(c.code || '').trim() || String(c.name || '').slice(0, 18);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        out.push({ code, title: c.name || code });
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
          maxBytes: Number(res?.maxBytes || 40 * 1024 * 1024),
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

      dlg.innerHTML = `
        <div class="playbook-head">
          <div>
            <span class="eyebrow">1-Click Multi-Tab Browser Sync</span>
            <h2 id="bi-sync-title" style="margin:2px 0 4px">Sync BI Canvas · TimeEdit · Ed</h2>
            <p class="muted" style="margin:0;font-size:13px">Uses your already signed-in browser tabs — no Canvas OAuth or session token copying needed.</p>
          </div>
          <button type="button" class="ios-done-btn" id="bi-sync-done">Done</button>
        </div>
        <div class="playbook-body">
          <article class="playbook-card">
            <div class="row-between" style="margin:0 0 6px;gap:8px">
              <h3 style="margin:0;font-size:15px">1. Install Study-OS Sync extension</h3>
              <span class="badge live">v1.3.1 · MV3</span>
            </div>
            <p class="muted" style="margin:0 0 10px;font-size:13px;line-height:1.45">
              Works in Chrome, Brave, Edge, and Vivaldi. One click pulls <b>BI Canvas</b> courses &amp; deadlines, <b>TimeEdit</b> lectures, and <b>Ed Discussion</b> courses from all open signed-in tabs at once.
            </p>
            <div class="row-actions">
              <a class="primary-btn" href="./downloads/study-os-sync-extension.zip" download="study-os-sync-extension.zip">Download Extension (.zip)</a>
              <a class="ghost-btn" href="https://github.com/shadjosef/study-os/blob/main/docs/canvas-browser-sync.md" target="_blank" rel="noopener">Install steps ↗</a>
            </div>
            <small class="muted" style="display:block;margin-top:8px">Unzip → open <code>chrome://extensions</code> → turn on <b>Developer mode</b> → <b>Load unpacked</b> (Chrome Web Store listing coming soon).</small>
          </article>

          <article class="playbook-card">
            <div class="row-between" style="margin:0 0 6px;gap:8px">
              <h3 style="margin:0;font-size:15px">2. Pair once with a 6-char code</h3>
              ${signedIn ? '<span class="badge live">Signed in</span>' : '<span class="badge gold">Sign in needed</span>'}
            </div>
            <p class="muted" style="margin:0 0 10px;font-size:13px;line-height:1.45">
              ${signedIn
                ? 'Generate a 5-minute pairing code and paste it into the Study-OS Sync extension once.'
                : 'Sign in with Google or a Passkey first so your synced courses, TimeEdit schedule, and personal PDFs carry across desktop and phone.'}
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
            <div class="row-between" style="margin:0 0 6px;gap:8px">
              <h3 style="margin:0;font-size:15px">3. Keep signed-in tabs open &amp; click Sync</h3>
              <span class="badge ${syncedCourses || hasTe ? 'live' : ''}">${syncedCourses ? `${syncedCourses} courses · ${syncedDeadlines} deadlines` : hasTe ? 'TimeEdit active' : 'Ready'}</span>
            </div>
            <p class="muted" style="margin:0 0 10px;font-size:13px;line-height:1.45">
              Open whichever tabs you want to sync, stay signed in, and click the <b>Study-OS Sync</b> icon once — TimeEdit only needs to be synced once per semester.
            </p>
            <div class="row-actions">
              <a class="ghost-btn" href="https://canvas.bi.no/" target="_blank" rel="noopener">BI Canvas ↗</a>
              <a class="ghost-btn" href="https://cloud.timeedit.net/bi/web/public/" target="_blank" rel="noopener">BI TimeEdit ↗</a>
              <a class="ghost-btn" href="https://eu.edstem.org/" target="_blank" rel="noopener">Ed Discussion ↗</a>
              ${signedIn ? '<button type="button" class="ghost-btn" id="bi-refresh-sync">Refresh synced data</button>' : ''}
            </div>
          </article>

          <article class="playbook-card" id="bi-materials-card">
            <div class="row-between" style="margin:0 0 6px;gap:8px">
              <h3 style="margin:0;font-size:15px">4. Add external curriculum PDFs &amp; materials</h3>
              <span class="badge">${signedIn ? esc(usedLabel) : 'Private to profile'}</span>
            </div>
            <p class="muted" style="margin:0 0 10px;font-size:13px;line-height:1.45">
              Drop your own lecture slides, syllabi, compendiums, or notes here. Files stay <b>100% private to your profile</b> and sync across desktop and phone (also accessible under <b>Notes</b>).
            </p>
            ${signedIn ? `
              <div style="margin-bottom:8px">
                <select id="bi-mat-course" aria-label="Course tag for uploaded files" style="width:100%;font-size:13px;padding:7px 10px">
                  <option value="">General / All courses</option>
                  ${courseChoices.map((c) => `<option value="${esc(c.code)}" data-title="${esc(c.title)}" ${selectedMatCourse === c.code ? 'selected' : ''}>${esc(c.code)} · ${esc(c.title)}</option>`).join('')}
                </select>
              </div>
              <label class="bi-dropzone" id="bi-mat-dropzone" tabindex="0">
                <input type="file" id="bi-mat-file-input" multiple accept=".pdf,.md,.txt,.csv,.png,.jpg,.jpeg,.webp,.docx,.pptx" hidden>
                <strong>Drop PDFs, slides, or notes here — or click to choose files</strong>
                <small class="muted">PDF, MD, TXT, PNG, JPG, DOCX, PPTX · up to 12 MB per file · private profile locker</small>
              </label>
              ${uploadStatusText ? `<p class="muted" id="bi-mat-upload-status" style="margin:8px 0 0;font-size:12.5px;color:var(--accent);font-weight:600">${esc(uploadStatusText)}</p>` : ''}
              <div class="bi-materials-list" id="bi-materials-list">
                ${!materialsState.loaded
                  ? '<small class="muted">Loading your synced files…</small>'
                  : materialsState.items.length
                    ? materialsState.items.map((m) => `
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
                    : '<small class="muted">No external files added yet.</small>'}
              </div>
            ` : `
              <button type="button" class="ghost-btn" id="bi-mat-signin-btn">Sign in to add &amp; sync your PDFs</button>
            `}
          </article>
        </div>
      `;

      dlg.querySelector('#bi-sync-done')?.addEventListener('click', () => dlg.close());
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

      const handleUploadFiles = async (fileList) => {
        const files = Array.from(fileList || []).filter(Boolean);
        if (!files.length) return;
        const opt = courseSel?.selectedOptions?.[0];
        const courseCode = courseSel?.value || '';
        const courseTitle = opt?.dataset?.title || '';
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          uploadStatusText = `Uploading ${file.name}…`;
          renderBiDialog(linkCode);
          try {
            await window.StudyCommunity.uploadMaterial(file, {
              courseCode,
              courseTitle,
              onProgress: (done, total) => {
                const st = dlg.querySelector('#bi-mat-upload-status');
                if (st) st.textContent = `Uploading ${file.name} (${done}/${total})…`;
              },
            });
            toast(`Synced "${file.name}" to your profile.`);
          } catch (err) {
            toast(err?.message || `Could not upload ${file.name}.`);
          }
        }
        uploadStatusText = '';
        await loadPersonalMaterials(linkCode);
        if (currentView === 'references') renderReferencesHub();
      };

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

  function onDevModeChange(active) {
    if (!active) {
      if (isStaticWeb) {
        recomputeWebAnalytics();
        updateHeaderStats();
      } else {
        refreshBootstrap().catch(() => {});
      }
      if (currentView === 'home') renderHome();
      else if (currentView === 'analytics') renderAnalytics();
    }
    syncSettingsRows();
  }

  return {
    isStaticMode,
    communityStats,
    publicReferenceUrl,
    fetchReferenceSection,
    getProgressRecord,
    effectiveDifficulty,
    effectiveDlpfc,
    calibratedParSec,
    computeWeightedUpi,
    refreshBootstrap,
    syncSettingsRows,
    syncCloudProgress,
    onDevModeChange,
    navigate,
    renderHome,
    showRawView,
    setQuestionStatus,
    setQuestionDifficulty,
    saveDraft,
    debouncedSaveDraft,
    logAttempt,
    logSession,
  };
})();
