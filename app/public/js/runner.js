/* Competitive Study & WISEflow Exam Runner:
 * - Ghost Timer vs AI Learning/Exam Par & Accuracy-Gated Scoring
 * - WISEflow FLOWmulti Multi-Box Auto-Grader (2 decimals + ±2% rounding margin, minus-sign check)
 * - Strict Blind WISEflow Exam Paper Mode (Total Countdown + Flagging + Full Paper Submit)
 * - 5-Second Frictionless Post-Run Telemetry Check-In
 */
'use strict';

window.StudyRunner = (() => {
  const { esc, examLabel, clockSec, minLabel, renderMarkdownWithMath, toast, openReferenceDrawer, workClock } = window.StudyUI;

  let activeRun = null;
  let tickInterval = null;

  const RUNNER_UI_KEY = 'study-os-runner-ui-v3';
  function getRunnerUiPrefs() {
    try {
      return JSON.parse(localStorage.getItem(RUNNER_UI_KEY)) || {};
    } catch {
      return {};
    }
  }
  function saveRunnerUiPrefs(patch) {
    const next = { ...getRunnerUiPrefs(), ...patch };
    try {
      localStorage.setItem(RUNNER_UI_KEY, JSON.stringify(next));
    } catch {}
    return next;
  }

  function needsSplitByContent(q, st) {
    if (!q) return false;
    // Default to clean single-column Focus mode unless user opens inline PDF/Reference reader
    if (st?.readerTab === 'pdf' || st?.readerTab === 'ref') return true;
    return false;
  }

  function getRun() {
    return activeRun;
  }

  function currentQuestion() {
    if (!activeRun) return null;
    const qid = activeRun.questionIds[activeRun.index];
    return activeRun.questionsById[qid] || null;
  }

  // ---------------------------------------------------------------------------
  // WISEFLOW FLOWMULTI NUMBER PARSER & ±2% / 2-DECIMAL GRADER
  // ---------------------------------------------------------------------------
  function parseWiseflowNumber(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return { ok: false, empty: true };
    if (/^\(\s*[\d.,\s]+\s*\)$/.test(str)) {
      return { ok: false, parensError: true };
    }
    // Strip currency/unit symbols & spaces
    let clean = str.replace(/[£$€%\s]/g, '').replace(/^kr/i, '').replace(/kr$/i, '');
    if (clean.includes(',') && clean.includes('.')) {
      clean = clean.replace(/,/g, '');
    } else if (clean.includes(',')) {
      // Distinguish thousand separator `40,700` or `1,520,000` from decimal comma `7,20` / `-4857,25`
      // Per 2026 BI WISEflow Title Page: decimal operator MUST be a dot (`.`), NEVER a comma (`,`)!
      if (/^[+-]?\d{1,3}(,\d{3})+$/.test(clean)) {
        clean = clean.replace(/,/g, '');
      } else {
        return { ok: false, commaError: true };
      }
    }
    clean = clean.replace(/^\+/, '');
    if (!/^-?\d+(\.\d+)?$/.test(clean)) {
      return { ok: false, invalidFormat: true };
    }
    const val = Number(clean);
    if (!Number.isFinite(val)) return { ok: false, invalidFormat: true };
    return { ok: true, value: val };
  }

  function formatWfNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n);
    if (Number.isInteger(v)) return v.toLocaleString('en-US');
    const has3Dec = Math.abs(Math.round(v * 100) - v * 100) > 1e-4;
    return v.toLocaleString('en-US', {
      minimumFractionDigits: has3Dec ? 3 : 2,
      maximumFractionDigits: 3,
    });
  }

  function gradeSingleWiseflowField(f, rawVal) {
    const pts = Number(f.points ?? 1);
    if (f.type === 'choice') {
      const picked = rawVal !== undefined && rawVal !== null && rawVal !== '' ? Number(rawVal) : null;
      const passed = picked !== null && picked === Number(f.answerIndex);
      return {
        id: f.id,
        type: 'choice',
        passed,
        earned: passed ? pts : 0,
        points: pts,
        picked,
        expectedLabel: (f.options || [])[f.answerIndex] ?? '',
      };
    }

    const parsed = parseWiseflowNumber(rawVal);
    const primaryExp = Number(f.expected);
    const relTol = Number(f.relTol ?? 0.02);
    const absTol = Number(f.absTol ?? 0.02);
    const primaryBand = Math.max(relTol * Math.abs(primaryExp), absTol);

    if (!parsed.ok) {
      return {
        id: f.id,
        type: 'number',
        passed: false,
        earned: 0,
        points: pts,
        expected: primaryExp,
        band: primaryBand,
        empty: !!parsed.empty,
        parensError: !!parsed.parensError,
        commaError: !!parsed.commaError,
        invalidFormat: !!parsed.invalidFormat,
      };
    }

    const targets = [primaryExp, ...(Array.isArray(f.altExpected) ? f.altExpected.map(Number) : [])];
    for (const t of targets) {
      const band = Math.max(relTol * Math.abs(t), absTol);
      const diff = Math.abs(parsed.value - t);
      if (diff <= band + 1e-9) {
        const exact = diff <= 0.015;
        const pctDiff = t !== 0 ? (diff / Math.abs(t)) * 100 : 0;
        return {
          id: f.id,
          type: 'number',
          passed: true,
          earned: pts,
          points: pts,
          userValue: parsed.value,
          expected: primaryExp,
          matchedTarget: t,
          band: primaryBand,
          exact,
          pctDiff,
        };
      }
    }

    return {
      id: f.id,
      type: 'number',
      passed: false,
      earned: 0,
      points: pts,
      userValue: parsed.value,
      expected: primaryExp,
      band: primaryBand,
    };
  }

  function evaluateWiseflowSheet(q, st) {
    const fields = Array.isArray(q.wiseflowFields) ? q.wiseflowFields : [];
    const details = {};
    let earned = 0;
    let total = 0;
    for (const f of fields) {
      const res = gradeSingleWiseflowField(f, st.wiseflow?.[f.id]);
      details[f.id] = res;
      earned += res.earned;
      total += res.points;
    }
    const accuracy = total > 0 ? earned / total : 0;
    return { earned, total, accuracy, details };
  }

  function hasAnyAnswerEntered(q, st) {
    if (q.kind === 'mcq') return st.choice !== null && st.choice !== undefined;
    if (Array.isArray(q.wiseflowFields) && q.wiseflowFields.length) {
      return Object.values(st.wiseflow || {}).some((v) => String(v ?? '').trim() !== '');
    }
    return Boolean((st.draft || '').trim() || (st.numericInput || '').trim());
  }

  // ---------------------------------------------------------------------------
  // ITEM & RUN STATE
  // ---------------------------------------------------------------------------
  function itemState(qid) {
    if (!activeRun.items[qid]) {
      const q = activeRun.questionsById[qid];
      const rec = window.StudyApp.getProgressRecord(qid) || {};
      const prof = activeRun.profile || 'learning';
      const pSpec = q?.pacing?.[prof] || q?.pacing?.learning || { target: 3, min: 2, max: 5 };
      activeRun.items[qid] = {
        elapsedMs: 0,
        runningSince: null,
        targetSec: Math.max(15, Math.round((Number(pSpec.target) || 3) * 60)),
        minSec: Math.round((Number(pSpec.min) || 1.5) * 60),
        maxSec: Math.round((Number(pSpec.max) || 5) * 60),
        stuckSec: Math.round((Number(q?.pacing?.stuckMinutes) || 2) * 60),
        handicapPerHintSec: Number(q?.pacing?.hintHandicapSeconds ?? 30),
        hintsUsed: 0,
        choice: activeRun.freshExamSit ? null : rec.savedChoice !== undefined ? rec.savedChoice : null,
        draft: activeRun.freshExamSit ? '' : rec.savedDraft || '',
        wiseflow: activeRun.freshExamSit ? {} : rec.savedWiseflow ? { ...rec.savedWiseflow } : {},
        wfGrade: null,
        numericInput: '',
        checkedRubrics: activeRun.freshExamSit
          ? []
          : Array.isArray(rec.checkedRubricIndices)
          ? [...rec.checkedRubricIndices]
          : [],
        flagged: false,
        revealed: false,
        solutionPeeked: false,
        earlyPeekConfirmed: false,
        loggedAttempt: null,
        pauseActive: null,
        focusSwitches: [],
        awayElapsedMs: 0,
        manualPauseCount: 0,
        layoutOverride: null,
        readerTab: 'task',
        selectedPdfIdx: 0,
        excerptViews: {},
        pdfViews: {},
        invertPdfFrame: false,
        inlineRefFile: '',
        inlineRefHeading: '',
        inlineRefData: null,
      };
    }
    return activeRun.items[qid];
  }

  function itemActiveSec(st, now = Date.now()) {
    const ms = st.elapsedMs + (st.runningSince != null ? Math.max(0, now - st.runningSince) : 0);
    return ms / 1000;
  }

  function totalExamActiveSec(now = Date.now()) {
    if (!activeRun) return 0;
    return Object.values(activeRun.items).reduce((s, st) => s + itemActiveSec(st, now), 0);
  }

  const AUTOPAUSE_KEY = 'study-os-autopause-v3';
  let autoPauseMode = (() => {
    try {
      const v = localStorage.getItem(AUTOPAUSE_KEY);
      return v === 'tab' || v === 'off' || v === 'window' ? v : 'off';
    } catch {
      return 'off';
    }
  })();
  let blurTimer = null;
  let intentionalFsExit = false;

  function renderAutoPauseHeaderUi() {
    const apBtn = document.getElementById('run-autopause-btn');
    if (apBtn) {
      const lbl = autoPauseMode === 'window' ? 'Auto: Win' : autoPauseMode === 'tab' ? 'Auto: Tab' : 'Auto: Off';
      apBtn.textContent = lbl;
      apBtn.classList.toggle('active', autoPauseMode !== 'off');
      apBtn.title =
        autoPauseMode === 'window'
          ? 'Auto-Pause ON (Window + Tab): pauses & logs whenever another app or tab takes display focus. Click to switch to Tab-only.'
          : autoPauseMode === 'tab'
          ? 'Auto-Pause ON (Tab-only): pauses when this tab/Space is hidden (allows side-by-side IDE/Obsidian). Click to turn Off.'
          : 'Auto-Pause OFF: click to re-enable automatic focus-loss pause & logging.';
    }
    const fsBtn = document.getElementById('run-fullscreen-btn');
    if (fsBtn) {
      const inFs = Boolean(document.fullscreenElement);
      fsBtn.textContent = inFs ? 'Exit Full' : 'Full';
      fsBtn.classList.toggle('active', inFs);
    }
  }

  function cycleAutoPauseMode() {
    autoPauseMode = autoPauseMode === 'window' ? 'tab' : autoPauseMode === 'tab' ? 'off' : 'window';
    try {
      localStorage.setItem(AUTOPAUSE_KEY, autoPauseMode);
    } catch {}
    if (autoPauseMode === 'off') {
      clearFocusAutoPause(true);
    }
    renderAutoPauseHeaderUi();
    const msg =
      autoPauseMode === 'window'
        ? 'Auto-Pause: Window + Tab (pauses & logs when any other window/tab takes focus)'
        : autoPauseMode === 'tab'
        ? 'Auto-Pause: Tab/Space Only (side-by-side apps stay unpaused)'
        : 'Auto-Pause: Off (manual pause P still active)';
    toast(msg);
  }

  function pauseCurrentTimer() {
    const q = currentQuestion();
    if (!q) return;
    const st = itemState(q.id);
    if (st.runningSince != null) {
      st.elapsedMs += Math.max(0, Date.now() - st.runningSince);
      st.runningSince = null;
    }
  }

  function resumeCurrentTimer() {
    const q = currentQuestion();
    if (!q) return;
    if (workClock?.getState?.().mode === 'break') return;
    const st = itemState(q.id);
    if (st.pauseActive) return;
    if (st.revealed && !(activeRun.examStyle === 'blind' && !activeRun.paperSubmitted)) return;
    if (st.runningSince == null) {
      st.runningSince = Date.now();
    }
  }

  function closePauseRecord(st, minLogSec = 1.5) {
    if (!st?.pauseActive) return 0;
    const now = Date.now();
    const durMs = Math.max(0, now - st.pauseActive.startedAtMs);
    const durSec = Math.round(durMs / 100) / 10;
    const reason = st.pauseActive.reason;
    const leftAt = st.pauseActive.startedAtIso;
    st.pauseActive = null;

    if (durSec >= minLogSec) {
      st.focusSwitches.push({
        reason,
        leftAt,
        returnedAt: new Date(now).toISOString(),
        sec: durSec,
      });
      if (reason === 'manual_pause') {
        st.manualPauseCount = (st.manualPauseCount || 0) + 1;
      } else {
        st.awayElapsedMs = (st.awayElapsedMs || 0) + durMs;
        if (activeRun) {
          activeRun.sessionFocusSwitches = (activeRun.sessionFocusSwitches || 0) + 1;
          activeRun.sessionAwayMs = (activeRun.sessionAwayMs || 0) + durMs;
        }
      }
    }
    return durSec;
  }

  function toggleManualPause() {
    if (!activeRun || document.getElementById('view-runner')?.hidden) return;
    if (workClock?.getState?.().mode === 'break') return;
    const q = currentQuestion();
    if (!q) return;
    const st = itemState(q.id);
    const isBlindUnfinished = activeRun.examStyle === 'blind' && !activeRun.paperSubmitted;
    if (st.revealed && !isBlindUnfinished) return;

    if (st.pauseActive) {
      const durSec = closePauseRecord(st, 0.5);
      workClock?.setPaused?.(false);
      resumeCurrentTimer();
      tickLiveClocks();
      toast(durSec >= 1 ? `Resumed (${clockSec(durSec)} pause logged)` : 'Timer resumed');
    } else {
      pauseCurrentTimer();
      st.pauseActive = {
        reason: 'manual_pause',
        startedAtMs: Date.now(),
        startedAtIso: new Date().toISOString(),
      };
      workClock?.setPaused?.(true, 'manual');
      tickLiveClocks();
      toast('Paused — click timer or press P to resume');
    }
  }

  function triggerFocusAutoPause(reason = 'window_blur') {
    if (autoPauseMode === 'off') return;
    if (workClock?.getState?.().mode === 'break') return;

    // Hold universal 75m clock whenever display focus leaves Study-OS
    if (workClock?.getState?.().mode === 'working') {
      workClock.setPaused(true, reason === 'tab_hidden' ? 'tab hidden' : 'window unfocused');
    }

    if (!activeRun || document.getElementById('view-runner')?.hidden) return;
    if (!document.getElementById('checkin-modal')?.hidden) return;
    const q = currentQuestion();
    if (!q) return;
    const st = itemState(q.id);
    const isBlindUnfinished = activeRun.examStyle === 'blind' && !activeRun.paperSubmitted;
    if (st.revealed && !isBlindUnfinished) return;
    if (st.pauseActive) return; // Already paused (manual or auto)

    pauseCurrentTimer();
    st.pauseActive = {
      reason,
      startedAtMs: Date.now(),
      startedAtIso: new Date().toISOString(),
    };
    tickLiveClocks();
  }

  function clearFocusAutoPause(silent = false) {
    clearTimeout(blurTimer);
    if (!activeRun || document.getElementById('view-runner')?.hidden) {
      workClock?.setPaused?.(false);
      return;
    }
    const q = currentQuestion();
    if (!q) {
      workClock?.setPaused?.(false);
      return;
    }
    const st = itemState(q.id);
    if (st.pauseActive?.reason === 'manual_pause') {
      return; // Respect explicit manual pause until user resumes
    }
    workClock?.setPaused?.(false);
    if (st.pauseActive) {
      const durSec = closePauseRecord(st, 1.5);
      resumeCurrentTimer();
      tickLiveClocks();
      if (!silent && durSec >= 3) {
        toast(`Auto-resumed · Paused ${clockSec(durSec)} while unfocused (logged)`);
      }
    } else {
      resumeCurrentTimer();
      tickLiveClocks();
    }
  }

  function onBreakStateChange(inBreak, endedSession = false) {
    if (!activeRun) return;
    if (inBreak) {
      const q = currentQuestion();
      if (q) closePauseRecord(itemState(q.id), 1.5);
      pauseCurrentTimer();
      tickLiveClocks();
    } else if (!endedSession && !document.getElementById('view-runner')?.hidden) {
      activeRun.consecutiveMisses = 0;
      resumeCurrentTimer();
      renderRunner();
    }
  }

  function startRun(config) {
    /*
      config: {
        courseMeta, bank, questionIds,
        mode: 'practice' | 'exam',
        examStyle: 'guided' | 'blind',
        examTitle: optional string,
        durationMinutes: optional total paper countdown minutes,
        freshExamSit: optional bool (start with clean blank boxes in blind exam sit),
        profile: 'learning' | 'exam',
        calendarBlock: optional
      }
    */
    const questionsById = Object.fromEntries((config.bank.questions || []).map((q) => [q.id, q]));
    const validIds = config.questionIds.filter((id) => questionsById[id]);
    if (!validIds.length) {
      toast('No questions matched that selection.');
      return;
    }

    if (activeRun) pauseCurrentTimer();
    clearInterval(tickInterval);

    const isExam = config.mode === 'exam';
    const examStyle = config.examStyle || (isExam ? 'blind' : 'guided');
    const sumParMin = validIds.reduce(
      (s, id) => s + Number(questionsById[id]?.pacing?.exam?.target || questionsById[id]?.pacing?.learning?.target || 3),
      0
    );
    const examBudgetSec = isExam
      ? Math.round((Number(config.durationMinutes) || Math.max(15, Math.round(sumParMin))) * 60)
      : null;

    activeRun = {
      sessionId: `ses-${Date.now()}`,
      startedAtIso: new Date().toISOString(),
      startedAtMs: Date.now(),
      courseMeta: config.courseMeta,
      bank: config.bank,
      questionsById,
      questionIds: validIds,
      index: 0,
      mode: isExam ? 'exam' : 'practice',
      examStyle,
      examTitle: config.examTitle || '',
      examBudgetSec,
      freshExamSit: Boolean(config.freshExamSit ?? (isExam && examStyle === 'blind')),
      paperSubmitted: false,
      paperScoreSummary: null,
      profile: config.profile || (isExam ? 'exam' : 'learning'),
      calendarBlock: config.calendarBlock || null,
      consecutiveMisses: 0,
      sessionFocusSwitches: 0,
      sessionAwayMs: 0,
      items: {},
      completedAttempts: {},
    };

    // Auto-start universal non-pausable 75m working interval when entering any run
    workClock?.ensureWorking?.();

    document.getElementById('global-header').hidden = true;
    document.getElementById('runner-header').hidden = false;
    window.StudyApp.showRawView('runner');

    enterQuestion(0);
    tickInterval = setInterval(tickLiveClocks, 250);
  }

  function enterQuestion(newIndex) {
    if (!activeRun) return;
    pauseCurrentTimer();
    activeRun.index = Math.max(0, Math.min(activeRun.questionIds.length - 1, newIndex));
    const q = currentQuestion();
    const st = itemState(q.id);
    const shouldRunClock = activeRun.examStyle === 'blind' ? !activeRun.paperSubmitted : !st.revealed;
    if (shouldRunClock && workClock?.getState?.().mode !== 'break') {
      st.runningSince = Date.now();
    }
    renderRunner();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function makeObsidianDeepLink(q) {
    const obs = activeRun.courseMeta?.obsidian || {};
    const vault = encodeURIComponent(obs.vault || 'Obsidian Vault');
    const rawFile = (q.obsidianLink?.file || obs.mainReference || '').replace(/\.md$/i, '');
    const heading = q.obsidianLink?.heading || '';
    const target = encodeURIComponent(heading ? `${rawFile}#${heading}` : rawFile);
    return `obsidian://open?vault=${vault}&file=${target}`;
  }

  function resolveSourceEntry(srcMeta, pageNum = 1, labelOverride = '') {
    if (!srcMeta) return null;
    if (srcMeta.id && srcMeta.mime) {
      const page = Math.max(1, Number(pageNum) || 1);
      const isPdf = srcMeta.mime === 'application/pdf';
      return {
        key: `member:${srcMeta.id}#p${page}`,
        memberAsset: srcMeta,
        title: srcMeta.title,
        label: labelOverride || `${srcMeta.title}${isPdf ? ` · p. ${page}` : ''}`,
        page,
        isPdf,
        pathStr: srcMeta.title,
      };
    }
    const cPath = srcMeta.canvasPath || '';
    const vPath = srcMeta.vaultPath || '';
    if (!cPath && !vPath) return null;
    const targetPath = cPath || vPath;
    if (!/\.(pdf|png|jpg|jpeg)$/i.test(targetPath)) return null;
    const baseApi = cPath
      ? `/api/canvas-file?path=${encodeURIComponent(cPath)}`
      : `/api/vault-asset?path=${encodeURIComponent(vPath)}`;
    const page = Math.max(1, Number(pageNum) || 1);
    const isPdf = /\.pdf$/i.test(targetPath);
    return {
      key: `${cPath ? 'c:' + cPath : 'v:' + vPath}#p${page}`,
      title: srcMeta.title || targetPath.split('/').pop(),
      label: labelOverride || `${srcMeta.title || 'Source PDF'}${isPdf ? ` · p. ${page}` : ''}`,
      rawUrl: baseApi,
      embedUrl: isPdf ? `${baseApi}#page=${page}&view=FitH` : baseApi,
      openAppUrl: `${baseApi}&open=1`,
      page,
      isPdf,
      pathStr: targetPath,
    };
  }

  function getQuestionSourcePdfs(q, sourcesMap, isBlindUnfinished, includeSolutionPdfs = false) {
    const out = [];
    const seen = new Set();
    const looksLikeSolutionDoc = (txt) => /solution|guideline|evaluation|examiner\s*guide|eba11805l\.pdf/i.test(String(txt || ''));

    const addFromAsset = (a, isSol = false) => {
      if (!a || typeof a !== 'object' || !a.sourceId) return;
      const meta = sourcesMap?.[a.sourceId];
      const entry = resolveSourceEntry(meta, a.page || 1, a.caption || '');
      if (!entry) return;
      if (isBlindUnfinished && (entry.memberAsset || isSol || looksLikeSolutionDoc(entry.title) || looksLikeSolutionDoc(entry.pathStr))) {
        return;
      }
      if (!seen.has(entry.key)) {
        seen.add(entry.key);
        out.push(entry);
      }
    };

    for (const a of q.contextAssets || []) addFromAsset(a, false);
    for (const a of q.promptAssets || []) addFromAsset(a, false);
    if (q.sourceId && sourcesMap?.[q.sourceId]) {
      addFromAsset({ sourceId: q.sourceId, page: 1, caption: sourcesMap[q.sourceId].title || '' }, false);
    }
    if (includeSolutionPdfs && !isBlindUnfinished) {
      for (const a of q.solutionAssets || []) addFromAsset(a, true);
      if (q.solutionSourceId && sourcesMap?.[q.solutionSourceId]) {
        addFromAsset({ sourceId: q.solutionSourceId, page: 1, caption: `Solution · ${sourcesMap[q.solutionSourceId].title || ''}` }, true);
      }
    }
    if (!out.length && q.collectionId && sourcesMap?.[q.collectionId]) {
      const fallback = resolveSourceEntry(sourcesMap[q.collectionId], 1, '');
      if (fallback && !(isBlindUnfinished && (fallback.memberAsset || looksLikeSolutionDoc(fallback.title) || looksLikeSolutionDoc(fallback.pathStr)))) {
        out.push(fallback);
      }
    }
    return out;
  }

  async function ensureInlineRefLoaded(q, st, customFile = '', customHeading = null) {
    const obs = activeRun?.courseMeta?.obsidian || {};
    const targetFile = customFile || st.inlineRefFile || q.obsidianLink?.file || obs.mainReference || '';
    const targetHeading = customHeading !== null ? customHeading : st.inlineRefHeading || q.obsidianLink?.heading || '';
    if (!targetFile) {
      st.inlineRefData = { available: false, error: 'No Obsidian reference configured for this course.' };
      return;
    }
    if (
      st.inlineRefData &&
      st.inlineRefFile === targetFile &&
      st.inlineRefHeading === targetHeading &&
      st.inlineRefData.available
    ) {
      return;
    }
    st.inlineRefFile = targetFile;
    st.inlineRefHeading = targetHeading;
    try {
      if (window.StudyApp?.fetchReferenceSection) {
        st.inlineRefData = await window.StudyApp.fetchReferenceSection(targetFile, targetHeading);
      } else {
        const url = `/api/obsidian/section?file=${encodeURIComponent(targetFile)}&heading=${encodeURIComponent(targetHeading)}`;
        const res = await fetch(url);
        st.inlineRefData = await res.json();
      }
    } catch {
      st.inlineRefData = { available: false, error: 'Could not load Obsidian section.' };
    }
  }

  function renderAssets(assets, courseId, sourcesMap, isBlindUnfinished = false) {
    if (!Array.isArray(assets) || !assets.length) return '';
    return assets
      .map((a, idx) => {
        const rel = typeof a === 'string' ? a : a.src;
        const cap = typeof a === 'string' ? 'Course source excerpt' : a.caption;
        const memberCourse = window.StudyMembers?.course(courseId);
        const privateAsset = memberCourse?.assets[rel];
        if (memberCourse && !privateAsset) return '';
        const srcUrl = window.StudyApp?.isStaticMode?.()
          ? `./static-data/course-assets/${encodeURIComponent(courseId)}/${rel}`
          : `/api/course-asset/${encodeURIComponent(courseId)}/${rel}`;
        const srcMeta = a?.sourceId && sourcesMap?.[a.sourceId];
        const entry = resolveSourceEntry(srcMeta, a?.page || 1, cap || '');
        const hideRawPdf =
          isBlindUnfinished && entry && (entry.memberAsset || /solution|guideline|evaluation|examiner\s*guide|eba11805l\.pdf/i.test(`${entry.title} ${entry.pathStr}`));
        const pdfActions =
          entry && !hideRawPdf
            ? `<span class="row-actions" style="gap:6px">
                 <button type="button" class="mini-tool-btn" data-open-inline-pdf="${esc(entry.key)}" title="Read full source PDF side-by-side inside Study-OS">In-App PDF${entry.isPdf ? ` (p.${entry.page})` : ''}</button>
                 ${entry.memberAsset ? memberDownload(entry.memberAsset) : `<button type="button" class="mini-tool-btn" data-open-native-pdf="${esc(entry.openAppUrl)}">PDF App</button>`}
               </span>`
            : '';
        return `<figure class="pdf-figure" data-fig-idx="${idx}" data-pdf-excerpt="${esc(rel)}">
          <figcaption><span>${esc(cap || srcMeta?.title || 'Source excerpt')}</span>${pdfActions}</figcaption>
          ${window.StudyPdf.toolbar()}
          <div class="pdf-zoom-scroll pdf-figure-scroll" tabindex="0" aria-label="Scrollable question excerpt">
            <div class="pdf-zoom-page">
              <img ${privateAsset ? memberPreviewAttrs(privateAsset) : `src="${esc(srcUrl)}"`} alt="${esc(cap || 'Question excerpt')}" loading="eager">
            </div>
          </div>
        </figure>`;
      })
      .join('');
  }

  function memberDownload(file) {
    return `<button type="button" class="mini-tool-btn" data-member-download="${esc(file.id)}"
      data-member-mime="${esc(file.mime)}" data-filename="${esc(file.title)}">Download original</button>`;
  }

  function memberPreviewAttrs(file, page) {
    return `data-member-preview="${esc(file.id)}" data-member-mime="${esc(file.mime)}"
      ${page ? `data-pdf-page="${esc(page)}"` : ''}`;
  }

  function renderWiseflowWorksheet(q, st) {
    const fields = Array.isArray(q.wiseflowFields) ? q.wiseflowFields : [];
    if (!fields.length) return '';

    const groups = [];
    const groupMap = new Map();
    for (const f of fields) {
      const gName = f.group || f.section || 'Response Fields';
      if (!groupMap.has(gName)) {
        const arr = [];
        groupMap.set(gName, arr);
        groups.push([gName, arr]);
      }
      groupMap.get(gName).push(f);
    }

    const totalPts = fields.reduce((s, f) => s + Number(f.points ?? 1), 0);
    const grade = st.revealed && st.wfGrade ? st.wfGrade : null;

    const scoreBarHtml = grade
      ? `<div class="wf-score-bar">
           <span class="badge ${grade.accuracy >= 0.7 ? 'live' : 'bad'}">
             Score: ${Number.isInteger(grade.earned) ? grade.earned : grade.earned.toFixed(1)} / ${totalPts} pts (${Math.round(grade.accuracy * 100)}%)
           </span>
         </div>`
      : '';

    const groupsHtml = groups
      .map(([gName, gFields]) => {
        const rowsHtml = gFields
          .map((f) => {
            const rawVal = st.wiseflow?.[f.id] ?? '';
            const g = grade?.details?.[f.id];
            const rowCls = ['wf-row', g ? (g.passed ? 'wf-pass' : 'wf-fail') : ''].filter(Boolean).join(' ');
            const ptsLbl = `${f.points ?? 1} pt${Number(f.points ?? 1) === 1 ? '' : 's'}`;

            let controlHtml = '';
            if (f.type === 'choice') {
              controlHtml =
                `<div class="wf-choice-pills">` +
                (f.options || [])
                  .map((opt, idx) => {
                    const isPicked = rawVal !== '' && rawVal !== null && rawVal !== undefined && Number(rawVal) === idx;
                    let cls = 'wf-choice-btn';
                    if (g) {
                      if (idx === Number(f.answerIndex)) cls += ' correct';
                      else if (isPicked) cls += ' wrong';
                    } else if (isPicked) {
                      cls += ' selected';
                    }
                    return `<button type="button" class="${cls}" data-wf-choice-id="${esc(f.id)}" data-wf-choice-idx="${idx}" ${
                      st.revealed ? 'disabled' : ''
                    }>${esc(opt)}</button>`;
                  })
                  .join('') +
                `</div>`;
            } else {
              controlHtml = `
                <div class="wf-num-wrap">
                  <input
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                     data-wf-num-id="${esc(f.id)}"
                     value="${esc(rawVal)}"
                     placeholder="0"
                     ${st.revealed ? 'readonly' : ''}
                   >
                   ${f.unit ? `<span class="wf-unit">${esc(f.unit)}</span>` : ''}
                 </div>
               `;
             }

             let fbHtml = '';
             if (g) {
               if (g.type === 'choice') {
                 fbHtml = g.passed
                   ? `<div class="wf-feedback good">Correct (${esc(g.expectedLabel)}) · +${g.points} pts</div>`
                   : `<div class="wf-feedback bad">Expected: ${esc(g.expectedLabel)} · 0 / ${g.points} pts</div>`;
               } else if (g.passed) {
                 const tolNote = g.exact
                   ? 'Exact match'
                   : `Accepted · Expected: ${formatWfNum(g.expected)}`;
                 fbHtml = `<div class="wf-feedback good">${esc(tolNote)} · +${g.points} pts</div>`;
               } else if (g.parensError) {
                 fbHtml = `<div class="wf-feedback bad">Use a leading minus sign (e.g. -50), never parentheses, in BI WISEflow. Expected: ${formatWfNum(
                   g.expected
                 )}</div>`;
               } else if (g.commaError) {
                 fbHtml = `<div class="wf-feedback bad">Use a dot (e.g. 7.25), never a comma, for decimals in BI WISEflow! Expected: ${formatWfNum(
                   g.expected
                 )}</div>`;
               } else {
                const enteredTxt = g.empty ? 'blank' : g.invalidFormat ? 'invalid' : formatWfNum(g.userValue);
                fbHtml = `<div class="wf-feedback bad">Entered: ${esc(enteredTxt)} · Expected: ${formatWfNum(
                  g.expected
                )}</div>`;
              }
            }

            return `<div class="${rowCls}">
              <div class="wf-label-col">
                <strong>${esc(f.label)}</strong>
                <small class="muted">${esc(ptsLbl)}</small>
              </div>
              <div class="wf-input-col">${controlHtml}</div>
              ${fbHtml}
            </div>`;
          })
          .join('');

        return `<div class="wf-group">
          <div class="wf-group-title">${esc(gName)}</div>
          ${rowsHtml}
        </div>`;
      })
      .join('');

    return `
      <section class="wf-sheet" aria-label="Answer worksheet">
        ${scoreBarHtml}
        ${groupsHtml}
      </section>
    `;
  }

  function computeRunSummary() {
    const attempts = Object.values(activeRun.completedAttempts);
    const total = activeRun.questionIds.length;
    const reviewed = attempts.length;
    const answeredCount = activeRun.questionIds.filter((qid) => {
      const q = activeRun.questionsById[qid];
      const st = activeRun.items[qid];
      return st && (st.revealed || hasAnyAnswerEntered(q, st));
    }).length;
    const beatCount = attempts.filter((a) => a.beatAi).length;
    const avgAcc = reviewed ? attempts.reduce((s, a) => s + a.qualityAccuracy, 0) / reviewed : 0;
    const avgPr = reviewed ? attempts.reduce((s, a) => s + Math.min(1.35, a.paceRatio), 0) / reviewed : 0;
    const activeSec = Object.values(activeRun.items).reduce((s, it) => s + itemActiveSec(it), 0);
    const wallSec = Math.max(1, (Date.now() - activeRun.startedAtMs) / 1000);
    const focusDensity = Math.min(1, activeSec / wallSec);
    const liveUpi = reviewed
      ? Math.round(100 * (0.45 * avgAcc + 0.35 * avgPr + 0.2 * Math.max(0.7, focusDensity)))
      : null;
    return { total, reviewed, answeredCount, beatCount, avgAcc, avgPr, activeSec, wallSec, liveUpi };
  }

  function renderRunnerDashboard() {
    const m = computeRunSummary();
    const el = document.getElementById('runner-dashboard');
    const isBlindUnfinished = activeRun.examStyle === 'blind' && !activeRun.paperSubmitted;

    if (isBlindUnfinished) {
      const flaggedCnt = Object.values(activeRun.items).filter((it) => it.flagged).length;
      el.innerHTML = `
        <div class="row-between" style="margin:0 0 8px">
          <div>
            <span class="badge gold">${esc(activeRun.examTitle || 'Blind Exam Simulation')}</span>
            <strong style="margin-left:8px">${m.answeredCount} / ${m.total} answered</strong>
            ${flaggedCnt ? `<span class="badge warn" style="margin-left:6px">${flaggedCnt} flagged</span>` : ''}
          </div>
          <div class="row-actions">
            <span class="muted" style="font-size:12.5px">Hints &amp; solutions locked until submission</span>
            <button type="button" class="primary-btn" id="btn-dash-submit-exam" style="padding:5px 12px;font-size:12.5px">Submit Paper</button>
          </div>
        </div>
        <div class="course-bar"><div class="course-bar-fill" style="width:${Math.round((m.answeredCount / Math.max(1, m.total)) * 100)}%"></div></div>
      `;
      document.getElementById('btn-dash-submit-exam')?.addEventListener('click', () => promptSubmitFullExam());
      return;
    }

    const ps = activeRun.paperScoreSummary;
    const blockLabel = ps
      ? `<span class="badge live">${ps.totalPts
          ? `Auto-graded: ${ps.earnedPts.toFixed(1)} / ${ps.totalPts} pts (${Math.round(ps.pct)}%)`
          : 'Paper submitted · use the worked solutions and marking checklists'}</span>`
      : activeRun.calendarBlock
      ? `<span class="badge live">${esc(activeRun.calendarBlock.summary)}</span>`
      : `<span class="badge">${activeRun.profile === 'exam' ? 'Exam Par' : 'Learning Par'}</span>`;

    const breakNudgeHtml =
      activeRun.mode === 'practice' && activeRun.consecutiveMisses >= 2
        ? `<div class="row-between" style="margin:8px 0 0;font-size:12.5px">
             <span style="color:var(--gold)">2 misses in a row — consider a short 1:5 off-screen reset before the next attempt.</span>
             <button type="button" class="ghost-btn" id="btn-dash-break" style="padding:3px 9px;font-size:12px">Take Break (B)</button>
           </div>`
        : '';

    el.innerHTML = `
      <div class="row-between" style="margin:0 0 8px">
        <div>
          ${blockLabel}
          <strong style="margin-left:8px">${m.reviewed} / ${m.total} verified</strong>
        </div>
        <div class="row-actions">
          <span class="badge gold" title="Accuracy-gated Beat-AI count">Beat AI: ${m.beatCount}/${m.reviewed || 0}</span>
          <span class="badge" title="Live Run Universal Productivity Index">UPI: <b>${m.liveUpi ?? '—'}</b></span>
          <span class="badge">Accuracy: <b>${m.reviewed ? Math.round(m.avgAcc * 100) + '%' : '—'}</b></span>
        </div>
      </div>
      <div class="course-bar"><div class="course-bar-fill" style="width:${Math.round((m.reviewed / Math.max(1, m.total)) * 100)}%"></div></div>
      ${breakNudgeHtml}
    `;
    document.getElementById('btn-dash-break')?.addEventListener('click', () => workClock?.triggerBreak?.(false));
  }

  function renderRunner() {
    if (!activeRun) return;
    const q = currentQuestion();
    const st = itemState(q.id);
    const rec = window.StudyApp.getProgressRecord(q.id) || {};
    const status = rec.status || 'not_started';
    const sourcesMap = activeRun.bank.sources || {};
    const isBlindUnfinished = activeRun.examStyle === 'blind' && !activeRun.paperSubmitted;
    const hasWf = Array.isArray(q.wiseflowFields) && q.wiseflowFields.length > 0;
    const sourcePdfs = getQuestionSourcePdfs(q, sourcesMap, isBlindUnfinished, st.revealed);
    const uiPrefs = getRunnerUiPrefs();
    const splitRatio = uiPrefs.splitRatio || 'balanced';
    const instantMcq = Boolean(uiPrefs.instantMcq) && !isBlindUnfinished;

    // Guard invalid reader tab (e.g. if switched to question without PDFs or blind exam locks reference)
    if (st.readerTab === 'pdf' && !sourcePdfs.length) st.readerTab = 'task';
    if (st.readerTab === 'ref' && isBlindUnfinished) st.readerTab = 'task';

    const autoNeedsSplit = needsSplitByContent(q, st);
    const preferredSplit = uiPrefs.preferredLayout === 'split';
    const isSplit = autoNeedsSplit
      ? true
      : st.layoutOverride === 'split'
      ? true
      : st.layoutOverride === 'foveal'
      ? false
      : preferredSplit;

    document.body.classList.toggle('runner-split-wide', isSplit);
    document.body.classList.toggle('runner-split-pdf', isSplit && st.readerTab === 'pdf');
    document.body.classList.toggle('runner-foveal-compact', !isSplit);

    // Preserve left-pane scroll position when re-rendering the same question
    const prevLeftEl = document.querySelector('.runner-pane-left-scroll');
    const prevLeftScroll = activeRun.lastRenderedQid === q.id && prevLeftEl ? prevLeftEl.scrollTop : 0;
    activeRun.lastRenderedQid = q.id;

    // Top sticky header controls
    document.getElementById('run-header-title').textContent = `${activeRun.courseMeta.shortTitle} · ${q.title}`;
    const ptsBadge = q.points ? ` · ${q.points} pts` : '';
    document.getElementById('run-header-sub').textContent = `Question ${activeRun.index + 1} of ${activeRun.questionIds.length} · ${
      hasWf ? 'Worksheet' : q.kind.toUpperCase()
    }${ptsBadge}`;
    document.getElementById('run-obsidian-app-link').href = makeObsidianDeepLink(q);

    const layoutBtn = document.getElementById('run-layout-btn');
    if (layoutBtn) {
      layoutBtn.textContent = isSplit ? 'Split' : 'Focus';
      layoutBtn.classList.toggle('active', isSplit);
      layoutBtn.title = isSplit
        ? 'Side-by-Side Split View — click or press V for Foveal Single-Column Focus (minimal eye movement)'
        : 'Foveal Focus Column (minimal eye movement) — click or press V for Side-by-Side Split View';
    }
    renderAutoPauseHeaderUi();

    const examCountdownEl = document.getElementById('run-exam-countdown');
    const submitExamBtn = document.getElementById('run-submit-exam-btn');
    const breakBtn = document.getElementById('run-break-btn');
    const runObsLink = document.getElementById('run-obsidian-app-link');

    if (examCountdownEl) examCountdownEl.hidden = !activeRun.examBudgetSec || activeRun.paperSubmitted;
    if (submitExamBtn) submitExamBtn.hidden = !isBlindUnfinished;
    if (breakBtn) breakBtn.hidden = activeRun.mode !== 'practice';
    if (runObsLink) runObsLink.hidden = isBlindUnfinished || window.StudyApp?.isStaticMode();

    renderRunnerDashboard();

    const handicapSec = st.hintsUsed * st.handicapPerHintSec;
    const pbText = rec.pbEffectiveSec ? ` · Best ${clockSec(rec.pbEffectiveSec)}` : '';

    // Full Ghost Race Box (for Split Pane) vs Slim 1-Line Pace Strip (for Foveal Focus Column)
    const ghostHtml = isSplit
      ? `
      <section class="ghost-race-box" aria-label="AI Pacing Timer" style="margin-top:0">
        <div class="row-between" style="margin:0">
          <div>
            <strong>${activeRun.profile === 'exam' ? 'AI Exam Par' : 'AI Learning Par'}: <span id="ghost-target-lbl">${clockSec(st.targetSec)}</span></strong>
            <small class="muted"> (${minLabel(st.minSec / 60)}–${minLabel(st.maxSec / 60)}${pbText})</small>
          </div>
          <span id="ghost-delta-badge" class="badge">Ready</span>
        </div>
        <div class="ghost-bars">
          <div class="bar-row">
            <span>You ${handicapSec ? `(+${handicapSec}s)` : ''}</span>
            <div class="bar-track"><div id="bar-you" class="bar-fill-you" style="width:0%"></div></div>
            <span id="lbl-you-time">0:00</span>
          </div>
          <div class="bar-row">
            <span class="muted">AI Par</span>
            <div class="bar-track"><div class="bar-fill-ai" style="width:100%"></div></div>
            <span class="muted">${clockSec(st.targetSec)}</span>
          </div>
        </div>
      </section>
    `
      : `
      <div class="slim-pace-strip" aria-label="AI Pacing Timer">
        <div class="slim-pace-row">
          <span class="muted">${activeRun.profile === 'exam' ? 'Exam Par' : 'Par'} <strong id="ghost-target-lbl">${clockSec(
            st.targetSec
          )}</strong> · You <strong id="lbl-you-time">0:00</strong>${handicapSec ? ` (+${handicapSec}s)` : ''}${pbText}</span>
          <span id="ghost-delta-badge" class="badge">Ready</span>
        </div>
        <div class="slim-pace-track"><div id="bar-you" class="bar-fill-you" style="width:0%"></div></div>
      </div>
    `;

    // Question Body / Left Reader Content
    const contextHtml =
      (q.contextMarkdown ? `<div class="markdown-body">${renderMarkdownWithMath(q.contextMarkdown)}</div>` : '') +
      renderAssets(q.contextAssets, q.courseId, sourcesMap, isBlindUnfinished);

    const promptAssetsHtml = renderAssets(q.promptAssets, q.courseId, sourcesMap, isBlindUnfinished);
    const svgHtml = q.svgDiagram ? `<div class="diagram-wrap" style="margin:14px 0">${q.svgDiagram}</div>` : '';
    const promptMdHtml = q.promptMarkdown
      ? `<div class="markdown-body" style="font-size:16px">${renderMarkdownWithMath(q.promptMarkdown)}</div>`
      : '';

    let readerBodyHtml = '';
    let inlinePdf = null;
    if (st.readerTab === 'pdf' && sourcePdfs.length) {
      const pdfIdx = Math.max(0, Math.min(sourcePdfs.length - 1, Number(st.selectedPdfIdx) || 0));
      const curPdf = sourcePdfs[pdfIdx];
      const memberFile = curPdf.memberAsset;
      if (curPdf.isPdf) inlinePdf = curPdf;
      const selectorHtml =
        sourcePdfs.length > 1
          ? `<select id="sel-inline-pdf" style="font-size:12.5px;padding:4px 8px;max-width:340px">` +
            sourcePdfs
              .map((p, idx) => `<option value="${idx}" ${idx === pdfIdx ? 'selected' : ''}>${esc(p.label)}</option>`)
              .join('') +
            `</select>`
          : `<strong>${esc(curPdf.label)}</strong>`;
      readerBodyHtml = `
        <div class="inline-pdf-wrap">
          <div class="inline-pdf-toolbar">
            <div>${selectorHtml}</div>
            <div class="row-actions" style="gap:6px">
              <button type="button" class="mini-tool-btn ${st.invertPdfFrame ? 'active' : ''}" id="btn-invert-pdf-frame" title="Invert embedded PDF colors for night reading">Invert PDF</button>
              ${memberFile ? memberDownload(memberFile) : `
                <button type="button" class="mini-tool-btn" data-open-native-pdf="${esc(curPdf.openAppUrl)}">Open in PDF App</button>
                <a class="mini-tool-btn" href="${esc(curPdf.embedUrl)}" target="_blank" rel="noopener">New Tab ↗</a>`}
            </div>
          </div>
          ${
            curPdf.isPdf ? `
              <div id="source-pdf-reader">${window.StudyPdf.viewer(curPdf.page, st.invertPdfFrame)}</div>`
            : memberFile && !memberFile.mime.startsWith('image/')
              ? '<p class="muted">Download this file to open it on your device.</p>'
              : `<figure class="pdf-figure" data-pdf-excerpt="${esc(curPdf.key)}">${window.StudyPdf.toolbar()}
                  <div class="pdf-zoom-scroll pdf-figure-scroll" tabindex="0" aria-label="Scrollable source image">
                    <div class="pdf-zoom-page"><img ${memberFile ? memberPreviewAttrs(memberFile) : `src="${esc(curPdf.rawUrl)}"`} alt="${esc(curPdf.title)}"></div>
                  </div></figure>`
          }
        </div>
      `;
    } else if (st.readerTab === 'ref' && !isBlindUnfinished) {
      const refData = st.inlineRefData;
      const obs = activeRun.courseMeta?.obsidian || {};
      const noteChoices = [];
      if (obs.mainReference) noteChoices.push({ label: 'Main Reference', file: obs.mainReference });
      if (obs.workedExamples) noteChoices.push({ label: 'Worked Examples', file: obs.workedExamples });
      if (obs.practiceNote) noteChoices.push({ label: 'Practice Note', file: obs.practiceNote });
      if (st.inlineRefFile && !noteChoices.some((n) => n.file === st.inlineRefFile)) {
        noteChoices.unshift({ label: st.inlineRefFile.split('/').pop(), file: st.inlineRefFile });
      }
      const noteSelHtml = noteChoices
        .map((n) => `<option value="${esc(n.file)}" ${n.file === st.inlineRefFile ? 'selected' : ''}>${esc(n.label)}</option>`)
        .join('');
      const tocSelHtml =
        `<option value="">— Top / Overview —</option>` +
        (refData?.toc || [])
          .map((h) => {
            const pad = '· '.repeat(Math.max(0, h.level - 1));
            return `<option value="${esc(h.title)}" ${refData?.selectedHeading === h.title ? 'selected' : ''}>${pad}${esc(h.title)}</option>`;
          })
          .join('');
      readerBodyHtml = `
        <div class="inline-pdf-toolbar" style="margin-bottom:12px">
          <select id="sel-inline-ref-note" style="font-size:12.5px;padding:4px 8px">${noteSelHtml}</select>
          <select id="sel-inline-ref-toc" style="font-size:12.5px;padding:4px 8px;flex:1;min-width:180px">${tocSelHtml}</select>
          ${refData?.obsidianUri ? `<a class="mini-tool-btn" href="${esc(refData.obsidianUri)}" style="text-decoration:none">Obsidian ↗</a>` : ''}
        </div>
        <div class="markdown-body">
          ${
            !refData
              ? '<p class="muted">Loading Obsidian Vault reference…</p>'
              : refData.available
              ? renderMarkdownWithMath(refData.markdown || '')
              : `<p class="muted">${esc(refData.error || 'Reference unavailable.')}</p>`
          }
        </div>
      `;
    } else {
      readerBodyHtml = `
        <h2 style="margin-top:0">${esc(q.title)}</h2>
        ${contextHtml}
        ${promptAssetsHtml}
        ${svgHtml}
        ${promptMdHtml}
      `;
    }

    const firstPdfPageLbl = sourcePdfs[0]?.isPdf ? ` (p.${sourcePdfs[0].page})` : '';
    const readerTabBarHtml = `
      <div class="reader-tabbar">
        <div class="reader-tabs" role="tablist" aria-label="Task & Source Reader">
          <button type="button" class="reader-tab-btn ${st.readerTab === 'task' ? 'active' : ''}" data-reader-tab="task">Task</button>
          ${
            sourcePdfs.length
              ? `<button type="button" class="reader-tab-btn ${st.readerTab === 'pdf' ? 'active' : ''}" data-reader-tab="pdf">Source PDF${firstPdfPageLbl}</button>`
              : ''
          }
          ${
            !isBlindUnfinished
              ? `<button type="button" class="reader-tab-btn ${st.readerTab === 'ref' ? 'active' : ''}" data-reader-tab="ref">Reference</button>`
              : ''
          }
        </div>
        <div class="reader-tools">
          ${
            isSplit
              ? `
                <button type="button" class="mini-tool-btn ${splitRatio === 'wide-left' ? 'active' : ''}" data-split-ratio="wide-left" title="Wider Task / PDF Pane (60/40)">Wide Task</button>
                <button type="button" class="mini-tool-btn ${splitRatio === 'balanced' ? 'active' : ''}" data-split-ratio="balanced" title="Balanced 50/50 Split">50/50</button>
                <button type="button" class="mini-tool-btn ${splitRatio === 'wide-right' ? 'active' : ''}" data-split-ratio="wide-right" title="Wider Answer Sheet (40/60)">Wide Ans</button>
              `
              : ''
          }
        </div>
      </div>
    `;

    // Answer Workspace by Kind / WISEflow Fields
    let workspaceHtml = '';
    if (q.kind === 'mcq' && Array.isArray(q.options) && q.options.length) {
      const useCompactMcqGrid =
        !isSplit &&
        q.options.length >= 2 &&
        q.options.length <= 4 &&
        q.options.every((opt) => {
          const s = String(opt ?? '');
          return s.length <= 46 && !s.includes('$$') && !s.includes('\n');
        });
      workspaceHtml =
        `<div class="mcq-options ${useCompactMcqGrid ? 'mcq-grid-2x2' : ''}">` +
        q.options
          .map((opt, idx) => {
            const letter = 'ABCDEF'[idx] || String(idx + 1);
            let cls = 'mcq-option';
            if (st.revealed) {
              if (idx === q.answerIndex) cls += ' correct';
              else if (st.choice === idx) cls += ' wrong';
            } else if (st.choice === idx) {
              cls += ' selected';
            }
            return `<div class="${cls}" data-mcq-idx="${idx}" role="button" tabindex="0">
              <span class="mcq-key">${letter}</span>
              <div class="markdown-body" style="flex:1">${renderMarkdownWithMath(opt)}</div>
            </div>`;
          })
          .join('') +
        `</div>`;
    } else if (hasWf) {
      const wfSheetHtml = renderWiseflowWorksheet(q, st);
      workspaceHtml = `
        ${wfSheetHtml}
        <details style="margin:10px 0">
          <summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--muted)">
            Working Notes (optional, auto-saved)
          </summary>
          <div style="margin-top:8px">
            <textarea id="inp-written-draft" style="min-height:90px" placeholder="Intermediate workings, T-accounts, or notes…">${esc(
              st.draft
            )}</textarea>
            <div class="row-between" style="margin:4px 0 0;font-size:12px">
              <span class="muted">Auto-saved to OneDrive</span>
              <span id="lbl-word-count" class="muted">0 words</span>
            </div>
          </div>
        </details>
      `;
    } else {
      const placeholder =
        q.kind === 'coding'
          ? '# Write your Python solution or key logic here before revealing the model solution...'
          : q.kind === 'calculation'
          ? 'Write your setup equation, intermediate steps, and final numerical result here (or solve on paper and record key numbers)...'
          : 'Write your structured response here before revealing the official guidance...';
      const monoStyle = q.kind === 'coding' ? 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;' : '';
      const numCheckHtml = q.numericCheck
        ? `<div class="row-actions" style="margin-bottom:10px">
            <label style="font-size:13px;font-weight:600">Numeric Answer (${esc(q.numericCheck.unit || 'value')}):
              <input type="text" id="inp-numeric-ans" value="${esc(st.numericInput)}" placeholder="Enter number" style="width:140px;margin-left:6px">
            </label>
          </div>`
        : '';
      workspaceHtml = `
        <div style="margin:10px 0">
          ${numCheckHtml}
          <textarea id="inp-written-draft" style="${monoStyle};min-height:${isSplit ? '210px' : '135px'}" placeholder="${esc(placeholder)}">${esc(st.draft)}</textarea>
          <div class="row-between" style="margin:4px 0 0;font-size:12px">
            <span class="muted">Auto-saved to OneDrive</span>
            <span id="lbl-word-count" class="muted">0 words</span>
          </div>
        </div>
      `;
    }

    // Hints area (locked in Exam mode)
    const hintsArr = Array.isArray(q.hints) ? q.hints : [];
    let hintsHtml = '';
    if (st.hintsUsed > 0 && hintsArr.length && !isBlindUnfinished) {
      hintsHtml = hintsArr
        .slice(0, st.hintsUsed)
        .map(
          (h, idx) => `<div class="hint-box">
            <strong>Hint ${idx + 1} <small class="muted">(+${st.handicapPerHintSec}s par)</small></strong>
            <div class="markdown-body">${renderMarkdownWithMath(h)}</div>
          </div>`
        )
        .join('');
    }

    // Solution, Self-Verification Rubric & Optional 1-Tap Difficulty Adaptation
    const hasMoreQuestions = activeRun.index + 1 < activeRun.questionIds.length;
    const nextShortLbl = hasMoreQuestions ? 'Next →' : 'Finish';
    const nextFullLbl = hasMoreQuestions ? 'Next Question → (N)' : 'Finish Run (N)';
    let solutionHtml = '';
    if (st.revealed && !isBlindUnfinished) {
      const solAssets = renderAssets(q.solutionAssets, q.courseId, sourcesMap);
      const pitfallHtml = q.pitfall
        ? `<p style="margin-top:10px;color:var(--warn)"><strong>Exam Pitfall:</strong> ${esc(q.pitfall)}</p>`
        : '';

      const isSelfVerified = q.kind !== 'mcq' && !hasWf;
      const topQuickActionsHtml = isSelfVerified
        ? `
          <div class="row-actions" style="gap:6px">
            <button type="button" class="primary-btn btn-got-it-next" style="padding:6px 12px;font-size:12.5px" title="Confirm 100% right, log verified score &amp; jump straight to next question (Shortcut: G)">
              ✓ Got It &amp; ${nextShortLbl} (G)
            </button>
            <button type="button" class="ghost-btn btn-missed-next" style="padding:6px 10px;font-size:12.5px" title="Mark Revisit (0%) &amp; jump to next question (Shortcut: X)">
              Revisit &amp; ${nextShortLbl} (X)
            </button>
          </div>
        `
        : `
          <div class="row-actions" style="gap:6px">
            <button type="button" class="primary-btn btn-next-q-inline" style="padding:6px 12px;font-size:12.5px">
              ${nextFullLbl}
            </button>
          </div>
        `;

      let verificationHtml = '';
      if (isSelfVerified) {
        const checks =
          Array.isArray(q.rubricChecks) && q.rubricChecks.length
            ? q.rubricChecks
            : [
                'Set up the correct formula / framework independently',
                'Completed intermediate steps without conceptual errors',
                'Reached the accurate final result & interpretation',
              ];
        verificationHtml = `
          <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
            <strong>Self-Verify Your Attempt (${st.loggedAttempt ? 'Logged' : 'Press G if 100% right, or tick partial checks'}):</strong>
            <ul class="rubric-list">
              ${checks
                .map(
                  (c, idx) => `<li class="rubric-item" data-rubric-idx="${idx}">
                    <input type="checkbox" ${st.checkedRubrics.includes(idx) ? 'checked' : ''} style="margin-top:4px">
                    <span class="markdown-body">${renderMarkdownWithMath(c)}</span>
                  </li>`
                )
                .join('')}
            </ul>
            <div class="row-actions" style="gap:8px;flex-wrap:wrap">
              <button type="button" class="primary-btn btn-got-it-next" title="Check all 100%, log verified score &amp; jump to next question (Shortcut: G)">
                ✓ Got It Right (100%) &amp; ${nextShortLbl} (G)
              </button>
              <button type="button" class="ghost-btn" id="btn-verify-and-next" title="Log currently ticked rubric checks &amp; jump to next question (Shortcut: N / Enter)">
                Log Checked &amp; ${nextShortLbl} (N)
              </button>
              <button type="button" class="ghost-btn btn-missed-next" title="Mark Revisit (0%) &amp; jump to next question (Shortcut: X)">
                Revisit &amp; ${nextShortLbl} (X)
              </button>
              <button type="button" class="ghost-btn" id="btn-submit-rubric" style="font-size:12.5px">
                ${st.loggedAttempt ? 'Update Score Only' : 'Log Score Only'}
              </button>
            </div>
          </div>
        `;
      } else {
        verificationHtml = `
          <div class="row-actions" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
            <button type="button" class="primary-btn btn-next-q-inline">${nextFullLbl}</button>
          </div>
        `;
      }

      const attemptBanner = st.loggedAttempt
        ? `<div class="badge ${st.loggedAttempt.beatAi ? 'live' : 'warn'}" style="margin-bottom:10px;font-size:12.5px;padding:5px 11px">
            ${
              st.loggedAttempt.beatAi
                ? `Beat AI Par · ${clockSec(st.loggedAttempt.effectiveSec)} vs ${clockSec(
                    st.loggedAttempt.aiParSec
                  )} · Accuracy ${Math.round(st.loggedAttempt.qualityAccuracy * 100)}% · UPI ${st.loggedAttempt.itemUpi}`
                : `Logged · ${clockSec(st.loggedAttempt.effectiveSec)} vs ${clockSec(
                    st.loggedAttempt.aiParSec
                  )} Par · Accuracy ${Math.round(st.loggedAttempt.qualityAccuracy * 100)}% · UPI ${st.loggedAttempt.itemUpi}`
            }
          </div>`
        : '';

      let difficultyRateHtml = '';
      if (st.loggedAttempt) {
        const curGrade = Number(
          rec.lastUserGrade || rec.fsrs?.lastGrade || st.loggedAttempt.fsrsGrade || st.loggedAttempt.suggestedFsrsGrade || 3
        );
        const schedDays = rec.fsrs?.scheduledDays;
        const similarCand =
          activeRun.mode === 'practice' && curGrade <= 2
            ? (activeRun.bank.questions || []).find(
                (cand) =>
                  cand.available !== false &&
                  cand.id !== q.id &&
                  !activeRun.questionIds.includes(cand.id) &&
                  String(cand.topicId) === String(q.topicId) &&
                  cand.kind !== 'mcq' &&
                  (window.StudyApp.getProgressRecord(cand.id)?.status || 'not_started') !== 'done'
              ) ||
              (activeRun.bank.questions || []).find(
                (cand) =>
                  cand.available !== false &&
                  cand.id !== q.id &&
                  !activeRun.questionIds.includes(cand.id) &&
                  String(cand.topicId) === String(q.topicId) &&
                  (window.StudyApp.getProgressRecord(cand.id)?.status || 'not_started') !== 'done'
              )
            : null;

        difficultyRateHtml = `
          <div class="difficulty-rate-bar">
            <small class="muted">
              ${rec.lastUserGrade ? 'Difficulty override' : 'Auto-rated from pace & accuracy'}${schedDays ? ` · Next review in ${schedDays}d` : ''}
            </small>
            <div class="row-actions" style="gap:5px">
              <button type="button" class="st-btn ${curGrade === 1 ? 'active-revisit' : ''}" data-rate-grade="1" title="Mark Revisit & schedule 1d">Again</button>
              <button type="button" class="st-btn ${curGrade === 2 ? 'active-in_progress' : ''}" data-rate-grade="2" title="Bump personal difficulty to Hard & shorten interval">Hard</button>
              <button type="button" class="st-btn ${curGrade === 3 ? 'active-done' : ''}" data-rate-grade="3" title="Standard mastery interval">Good</button>
              <button type="button" class="st-btn ${curGrade === 4 ? 'active-done' : ''}" data-rate-grade="4" title="Lower personal difficulty & extend interval">Easy</button>
              ${
                similarCand
                  ? `<button type="button" class="mini-tool-btn" data-queue-similar="${esc(similarCand.id)}" title="Queue ${esc(
                      similarCand.title
                    )} next in this run">+ Queue Similar</button>`
                  : ''
              }
            </div>
          </div>
        `;
      }

      solutionHtml = `
        <section class="solution-panel" id="solution-box">
          ${attemptBanner}
          <div class="row-between" style="margin:0 0 10px;gap:8px">
            <h3 style="margin:0">Worked Solution</h3>
            ${topQuickActionsHtml}
          </div>
          ${solAssets}
          <div class="markdown-body">${renderMarkdownWithMath(q.solutionMarkdown || '')}</div>
          ${pitfallHtml}
          ${verificationHtml}
          ${difficultyRateHtml}
        </section>
      `;
    }

    const dlpfcInfo = window.StudyApp.effectiveDlpfc
      ? window.StudyApp.effectiveDlpfc(q, rec)
      : { tier: Number(q.dlpfcBase || q.difficulty || 2), chunked: false };
    const diffBadgeHtml = `<span class="diff-badge diff-${dlpfcInfo.tier}" data-layout-tier="${dlpfcInfo.tier}"${dlpfcInfo.chunked
      ? ' title="Previously mastered problem with fewer new steps"' : ''}>${window.StudyLayout.label(dlpfcInfo.tier)}</span>`;

    // Compact Low-Clutter Status Bar
    const questionTopic = activeRun.bank.topics?.find((topic) => String(topic.id) === String(q.topicId));
    const questionCollection = activeRun.bank.collections?.find((collection) => collection.id === q.collectionId);
    const statusBarHtml = `
      <div class="row-between" style="margin:0 0 8px">
        <div class="row-actions" style="gap:6px">
          ${questionCollection ? `<span class="badge">${esc(examLabel(questionCollection.title))}</span>` : ''}
          <span class="badge">${esc(questionTopic?.title || 'Topic ' + q.topicId)}</span>
          ${diffBadgeHtml}
          ${!isBlindUnfinished && (q.obsidianLink?.file || activeRun.courseMeta.obsidian?.mainReference)
            ? '<button type="button" class="ghost-btn" id="btn-question-notes">Study notes</button>' : ''}
          <button type="button" class="ghost-btn" id="btn-copy-for-ai">Copy for AI</button>
          ${q.points ? `<span class="badge gold">${q.points} pts</span>` : ''}
        </div>
        <div class="status-group" role="group" aria-label="Task completion state">
          ${
            isBlindUnfinished
              ? `<button type="button" class="st-btn ${st.flagged ? 'active-revisit' : ''}" id="btn-flag-exam" title="Flag question to review before submitting paper (F)">
                   ${st.flagged ? 'Flagged' : 'Flag (F)'}
                 </button>`
              : `
                <select id="sel-card-status" class="st-select st-select-${esc(status)}" aria-label="Task status" title="Change task status">
                  <option value="not_started" ${status === 'not_started' ? 'selected' : ''}>Uncomplete</option>
                  <option value="in_progress" ${status === 'in_progress' ? 'selected' : ''}>In Progress</option>
                  <option value="done" ${status === 'done' ? 'selected' : ''}>Done</option>
                  <option value="revisit" ${status === 'revisit' ? 'selected' : ''}>Revisit</option>
                </select>
                <button type="button" class="st-btn ${status === 'revisit' ? 'active-revisit' : ''}" data-set-status="revisit" title="Flag for Revisit (F)">Flag</button>
                <button type="button" class="st-btn" id="btn-retry-fresh" title="Clear current attempt &amp; restart timer">Retry</button>
              `
          }
        </div>
      </div>
    `;

    // Primary Action Button
    const canHint = activeRun.mode !== 'exam' && st.hintsUsed < hintsArr.length && !st.revealed;
    let primaryActionBtn = '';
    if (isBlindUnfinished) {
      primaryActionBtn = hasMoreQuestions
        ? `<button type="button" class="primary-btn" id="btn-next-q">Save &amp; Next → (N)</button>`
        : `<button type="button" class="primary-btn" id="btn-submit-paper-bottom">Submit Paper</button>`;
    } else if (q.kind === 'mcq') {
      primaryActionBtn = !st.revealed
        ? `<button type="button" class="primary-btn" id="btn-check-mcq" ${st.choice === null ? 'disabled' : ''}>Check Answer (Enter)</button>`
        : `<button type="button" class="primary-btn" id="btn-next-q">${nextFullLbl}</button>`;
    } else if (hasWf) {
      primaryActionBtn = !st.revealed
        ? `<button type="button" class="primary-btn" id="btn-check-wf">Check Answers (Enter)</button>`
        : `<button type="button" class="primary-btn" id="btn-next-q">${nextFullLbl}</button>`;
    } else {
      primaryActionBtn = !st.revealed
        ? `<button type="button" class="primary-btn" id="btn-reveal-sol" title="Shortcut: S or Cmd/Ctrl+Enter">Reveal Solution (S)</button>`
        : `<button type="button" class="primary-btn btn-got-it-next" title="Confirm 100% right &amp; jump to next question (Shortcut: G)">✓ Got It &amp; ${nextShortLbl} (G)</button>`;
    }

    const instantMcqToggleHtml =
      !isBlindUnfinished && q.kind === 'mcq'
        ? `<button type="button" class="mini-tool-btn ${instantMcq ? 'active' : ''}" id="btn-toggle-instant-mcq" title="When ON, clicking an option or pressing A–D checks MCQs in 1 tap (minimal cursor &amp; eye movement)">1-Tap Check${
            instantMcq ? ': ON' : ''
          }</button>`
        : '';

    const secondaryNextBtn =
      !isBlindUnfinished && st.revealed && q.kind !== 'mcq' && !hasWf
        ? `<button type="button" class="ghost-btn" id="btn-next-q" title="Advance to next question (Shortcut: N or Enter)">${nextShortLbl} (N)</button>`
        : '';

    const fovealActionBarHtml = `
      <div class="foveal-action-bar">
        <div class="row-actions" style="gap:7px">
          ${primaryActionBtn}
          ${secondaryNextBtn}
          ${canHint ? `<button type="button" class="ghost-btn" id="btn-hint">Hint ${st.hintsUsed + 1}/${hintsArr.length} (H)</button>` : ''}
          ${
            !isBlindUnfinished && !st.revealed && (q.kind === 'mcq' || hasWf)
              ? `<button type="button" class="ghost-btn" id="btn-reveal-sol">Solution (S)</button>`
              : ''
          }
          ${instantMcqToggleHtml}
        </div>
        <div class="row-actions" style="gap:6px">
          <button type="button" class="ghost-btn" id="btn-prev-q" ${activeRun.index === 0 ? 'disabled' : ''}>← Prev</button>
          ${
            !isSplit && sourcePdfs.length
              ? `<button type="button" class="ghost-btn" id="btn-bottom-pdf" title="Open embedded Source PDF side-by-side">PDF</button>`
              : ''
          }
          ${!isSplit && !isBlindUnfinished ? `<button type="button" class="ghost-btn" id="btn-inline-ref" title="Open Vault Reference (O)">Ref</button>` : ''}
          <button type="button" class="ghost-btn" id="btn-end-run">${isBlindUnfinished ? 'Submit…' : 'End Run'}</button>
        </div>
      </div>
    `;

    const kbdBarHtml =
      st.revealed && !isBlindUnfinished
        ? `
      <div class="kbd-hint-bar">
        ${q.kind !== 'mcq' && !hasWf ? '<span><kbd>G</kbd> Got It (100%) &amp; Next</span><span><kbd>X</kbd> Revisit &amp; Next</span>' : ''}
        <span><kbd>N</kbd>/<kbd>Enter</kbd> Next Question</span>
        <span><kbd>V</kbd> Focus/Split</span>
        <span><kbd>←</kbd><kbd>→</kbd> Nav</span>
      </div>
    `
        : `
      <div class="kbd-hint-bar">
        ${q.kind === 'mcq' ? '<span><kbd>1–6</kbd>/<kbd>A–F</kbd> Select</span>' : '<span><kbd>⌘/Ctrl+↵</kbd> Reveal/Check</span>'}
        <span><kbd>S</kbd> Solution</span>
        <span><kbd>Enter</kbd>/<kbd>N</kbd> Check/Next</span>
        <span><kbd>P</kbd> Pause</span>
        <span><kbd>V</kbd> Focus/Split</span>
        ${!isBlindUnfinished ? '<span><kbd>H</kbd> Hint</span><span><kbd>O</kbd> Ref</span>' : ''}
        <span><kbd>←</kbd><kbd>→</kbd> Nav</span>
      </div>
    `;

    const card = document.getElementById('runner-question-card');
    card.classList.toggle('split-card', isSplit);
    card.classList.toggle('foveal-card', !isSplit);

    window.StudyPdf.dispose();
    if (isSplit) {
      const initialWidth = splitRatio === 'wide-left' ? 62 : splitRatio === 'wide-right' ? 41 : splitRatio === 'custom'
        ? Math.max(32, Math.min(68, Number(uiPrefs.splitWidth) || 52)) : 52;
      card.innerHTML = `
        <div class="runner-split-grid" style="--task-share:${initialWidth}fr;--answer-share:${100 - initialWidth}fr">
          <div class="runner-pane-left">
            ${readerTabBarHtml}
            <div class="runner-pane-left-scroll">
              ${readerBodyHtml}
            </div>
          </div>
          <div class="runner-divider" role="separator" aria-label="Resize task and answer panes" aria-orientation="vertical"
              aria-valuemin="32" aria-valuemax="68" aria-valuenow="${initialWidth}" tabindex="0"></div>
          <div class="runner-pane-right">
            ${statusBarHtml}
            ${ghostHtml}
            <div id="stall-nudge-banner" class="hint-box stall-banner" hidden></div>
            ${workspaceHtml}
            ${fovealActionBarHtml}
            ${hintsHtml}
            ${solutionHtml}
            ${kbdBarHtml}
          </div>
        </div>
      `;
    } else {
      card.innerHTML = `
        ${statusBarHtml}
        ${ghostHtml}
        <div class="foveal-prompt-block">
          ${readerBodyHtml}
        </div>
        <div id="stall-nudge-banner" class="hint-box stall-banner" hidden></div>
        ${workspaceHtml}
        ${fovealActionBarHtml}
        ${hintsHtml}
        ${solutionHtml}
        ${kbdBarHtml}
      `;
    }

    const newLeftEl = document.querySelector('.runner-pane-left-scroll');
    if (newLeftEl && prevLeftScroll > 0) {
      newLeftEl.scrollTop = prevLeftScroll;
    }

    // Render Jump Grid (WISEflow section navigator)
    const jumpPanel = document.getElementById('runner-jump-panel');
    if (jumpPanel && activeRun.mode === 'exam') jumpPanel.open = true;
    const jumpGrid = document.getElementById('runner-jump-grid');
    jumpGrid.innerHTML = activeRun.questionIds
      .map((qid, i) => {
        const it = activeRun.items[qid];
        const qi = activeRun.questionsById[qid];
        let stateCls = '';
        if (isBlindUnfinished) {
          if (it && hasAnyAnswerEntered(qi, it)) stateCls = 'answered';
          if (it?.flagged) stateCls += ' flagged';
        } else {
          const r = window.StudyApp.getProgressRecord(qid) || {};
          const rs = r.status || 'not_started';
          if (rs === 'done') stateCls = 'done';
          else if (rs === 'revisit') stateCls = 'revisit';
        }
        const cls = ['jump-btn', i === activeRun.index ? 'current' : '', stateCls].filter(Boolean).join(' ');
        return `<button type="button" class="${cls}" data-jump-idx="${i}">${i + 1}${it?.flagged && isBlindUnfinished ? '⚑' : ''}</button>`;
      })
      .join('');

    bindQuestionCardEvents(q, st, sourcePdfs);
    const promptSourceKeys = new Set([...(q.contextAssets || []), ...(q.promptAssets || [])]
      .map((figure) => resolveSourceEntry(sourcesMap[figure?.sourceId], figure?.page)?.key));
    window.StudyQuestionCopy.bind(card, {
      question: q, state: st, course: activeRun.courseMeta.title, topic: questionTopic?.title,
      revealed: st.revealed && !isBlindUnfinished,
      sources: sourcePdfs.filter((source) => source.isPdf && promptSourceKeys.has(source.key)),
    });
    if (inlinePdf) {
      const view = st.pdfViews[inlinePdf.key] ||= { page: inlinePdf.page, zoom: 100, trim: false };
      window.StudyPdf.mount(card.querySelector('#source-pdf-reader'), inlinePdf, view);
    }
    tickLiveClocks();
  }

  function bindQuestionCardEvents(q, st, sourcePdfs = []) {
    const isBlindUnfinished = activeRun.examStyle === 'blind' && !activeRun.paperSubmitted;
    const card = document.getElementById('runner-question-card');
    window.StudyMembers?.fillPreviews(card);
    window.StudyMembers?.bindDownloads(card);
    document.getElementById('btn-question-notes')?.addEventListener('click', () => {
      openReferenceDrawer(activeRun.courseMeta, q.obsidianLink?.file || '', q.obsidianLink?.heading || '');
    });

    // Reader Tabs (Task & Excerpts | Source PDF | Vault Reference)
    document.querySelectorAll('[data-reader-tab]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const nextTab = btn.dataset.readerTab;
        st.readerTab = nextTab;
        if (nextTab === 'ref') {
          renderRunner();
          await ensureInlineRefLoaded(q, st);
        }
        renderRunner();
      });
    });

    // Quick figure "📄 In-App PDF" button -> jumps directly to that PDF & page in Left Pane!
    document.querySelectorAll('[data-open-inline-pdf]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const key = btn.dataset.openInlinePdf;
        const foundIdx = sourcePdfs.findIndex((p) => p.key === key);
        if (foundIdx >= 0) st.selectedPdfIdx = foundIdx;
        st.readerTab = 'pdf';
        renderRunner();
      });
    });

    // "🖥 Open in PDF App" button -> launches native macOS Preview / PDFcraft / PDFgear without leaving Study-OS!
    document.querySelectorAll('[data-open-native-pdf]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          const res = await fetch(btn.dataset.openNativePdf);
          if (res.ok) toast('Opened PDF in your system PDF viewer!');
          else toast('Could not open original PDF file.');
        } catch {
          toast('Could not open original PDF file.');
        }
      });
    });

    document.getElementById('sel-inline-pdf')?.addEventListener('change', (ev) => {
      st.selectedPdfIdx = Number(ev.target.value) || 0;
      renderRunner();
    });

    document.getElementById('btn-invert-pdf-frame')?.addEventListener('click', (event) => {
      st.invertPdfFrame = !st.invertPdfFrame;
      event.currentTarget.classList.toggle('active', st.invertPdfFrame);
      document.querySelector('.pdf-document-scroll')?.classList.toggle('pdf-ink-inverted', st.invertPdfFrame);
    });

    document.getElementById('btn-bottom-pdf')?.addEventListener('click', () => {
      st.readerTab = st.readerTab === 'pdf' ? 'task' : 'pdf';
      if (st.readerTab === 'pdf') st.layoutOverride = null; // Auto-expand into side-by-side split for PDF reading
      renderRunner();
    });

    document.getElementById('btn-toggle-instant-mcq')?.addEventListener('click', () => {
      const nextInstant = !Boolean(getRunnerUiPrefs().instantMcq);
      saveRunnerUiPrefs({ instantMcq: nextInstant });
      toast(nextInstant ? '1-Tap MCQ Check ON (click or press A–D to check immediately)' : '1-Tap MCQ Check OFF');
      renderRunner();
    });

    // Inline Obsidian Vault Reference note & TOC selectors inside Left Pane
    document.getElementById('sel-inline-ref-note')?.addEventListener('change', async (ev) => {
      st.inlineRefData = null;
      await ensureInlineRefLoaded(q, st, ev.target.value, '');
      renderRunner();
    });
    document.getElementById('sel-inline-ref-toc')?.addEventListener('change', async (ev) => {
      st.inlineRefData = null;
      await ensureInlineRefLoaded(q, st, st.inlineRefFile, ev.target.value);
      renderRunner();
    });

    window.StudyPdf.bindExcerpts(card, st.excerptViews);
    const divider = card.querySelector('.runner-divider');
    if (divider) {
      const grid = divider.parentElement;
      function resize(width) {
        const percent = Math.round(Math.max(32, Math.min(68, width)));
        grid.style.setProperty('--task-share', percent + 'fr');
        grid.style.setProperty('--answer-share', (100 - percent) + 'fr');
        divider.setAttribute('aria-valuenow', percent);
        return percent;
      }
      function applyWidth() {
        saveRunnerUiPrefs({ splitRatio: 'custom', splitWidth: Number(divider.getAttribute('aria-valuenow')) });
        for (const button of card.querySelectorAll('[data-split-ratio]')) button.classList.remove('active');
      }
      divider.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
      });
      divider.addEventListener('pointermove', (event) => {
        if (!divider.hasPointerCapture(event.pointerId)) return;
        const rect = grid.getBoundingClientRect();
        resize(100 * (event.clientX - rect.left) / rect.width);
      });
      divider.addEventListener('lostpointercapture', applyWidth);
      divider.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        resize(Number(divider.getAttribute('aria-valuenow')) + (event.key === 'ArrowLeft' ? -3 : 3));
        applyWidth();
      });
    }

    document.querySelectorAll('[data-split-ratio]').forEach((btn) => {
      btn.addEventListener('click', () => {
        st.layoutOverride = 'split';
        saveRunnerUiPrefs({ splitRatio: btn.dataset.splitRatio });
        renderRunner();
      });
    });

    // Optional 1-tap perceived difficulty override & + Queue Similar
    document.querySelectorAll('[data-rate-grade]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const grade = Number(btn.dataset.rateGrade);
        await window.StudyApp.setQuestionDifficulty(q.id, grade);
        const names = { 1: 'Again (Revisit · 1d)', 2: 'Hard', 3: 'Good', 4: 'Easy' };
        toast(`Rated ${names[grade] || grade}`);
        renderRunner();
      });
    });

    document.querySelectorAll('[data-queue-similar]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const simId = btn.dataset.queueSimilar;
        if (simId && !activeRun.questionIds.includes(simId)) {
          activeRun.questionIds.splice(activeRun.index + 1, 0, simId);
          const simQ = activeRun.questionsById[simId];
          toast(`Queued next: ${simQ?.title || simId}`);
          renderRunner();
        }
      });
    });

    // MCQ selection (supports 1-Tap Check when enabled, or double-click quick check)
    const runMcqCheckNow = async () => {
      if (st.choice === null || st.revealed || isBlindUnfinished) return;
      pauseCurrentTimer();
      st.revealed = true;
      const correct = st.choice === q.answerIndex ? 1.0 : 0.0;
      await submitVerifiedAttempt(q, st, correct);
      renderRunner();
    };

    document.querySelectorAll('[data-mcq-idx]').forEach((el) => {
      el.addEventListener('click', async () => {
        if (st.revealed) return;
        st.choice = Number(el.dataset.mcqIdx);
        window.StudyApp.saveDraft(q.id, { choice: st.choice, activeElapsedSec: itemActiveSec(st), profile: activeRun.profile });
        if (!isBlindUnfinished && Boolean(getRunnerUiPrefs().instantMcq)) {
          await runMcqCheckNow();
          return;
        }
        renderRunner();
      });
      el.addEventListener('dblclick', async () => {
        if (!isBlindUnfinished && !st.revealed) {
          st.choice = Number(el.dataset.mcqIdx);
          await runMcqCheckNow();
        }
      });
    });

    // WISEflow choice pills (Right / Wrong or sub-choices)
    document.querySelectorAll('[data-wf-choice-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (st.revealed) return;
        const fid = btn.dataset.wfChoiceId;
        st.wiseflow[fid] = Number(btn.dataset.wfChoiceIdx);
        window.StudyApp.debouncedSaveDraft(q.id, {
          wiseflowAnswers: st.wiseflow,
          activeElapsedSec: itemActiveSec(st),
          profile: activeRun.profile,
        });
        renderRunner();
      });
    });

    // WISEflow numeric inputs
    document.querySelectorAll('[data-wf-num-id]').forEach((inp) => {
      inp.addEventListener('input', () => {
        if (st.revealed) return;
        st.wiseflow[inp.dataset.wfNumId] = inp.value;
        window.StudyApp.debouncedSaveDraft(q.id, {
          wiseflowAnswers: st.wiseflow,
          activeElapsedSec: itemActiveSec(st),
          profile: activeRun.profile,
        });
      });
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !isBlindUnfinished && !st.revealed) {
          ev.preventDefault();
          document.getElementById('btn-check-wf')?.click();
        }
      });
    });

    // Written / Coding draft
    const draftEl = document.getElementById('inp-written-draft');
    if (draftEl) {
      const updateWords = () => {
        const words = draftEl.value.trim() ? draftEl.value.trim().split(/\s+/).length : 0;
        const lbl = document.getElementById('lbl-word-count');
        if (lbl) lbl.textContent = `${words} word${words === 1 ? '' : 's'}`;
      };
      updateWords();
      draftEl.addEventListener('input', () => {
        st.draft = draftEl.value;
        updateWords();
        window.StudyApp.debouncedSaveDraft(q.id, {
          draft: st.draft,
          activeElapsedSec: itemActiveSec(st),
          profile: activeRun.profile,
        });
      });
    }

    const numEl = document.getElementById('inp-numeric-ans');
    if (numEl) {
      numEl.addEventListener('input', () => {
        st.numericInput = numEl.value;
      });
    }

    // Hints
    document.getElementById('btn-hint')?.addEventListener('click', () => {
      st.hintsUsed = Math.min((q.hints || []).length, st.hintsUsed + 1);
      renderRunner();
    });

    // Check MCQ (Guided / Practice mode)
    document.getElementById('btn-check-mcq')?.addEventListener('click', runMcqCheckNow);

    // Check WISEflow Multi-Box Sheet (Guided / Practice mode)
    document.getElementById('btn-check-wf')?.addEventListener('click', async () => {
      pauseCurrentTimer();
      st.revealed = true;
      st.wfGrade = evaluateWiseflowSheet(q, st);
      await submitVerifiedAttempt(q, st, st.wfGrade.accuracy);
      renderRunner();
      document.getElementById('solution-box')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // Reveal Solution (Written / Calc / Coding / MCQ or WF peek)
    document.getElementById('btn-reveal-sol')?.addEventListener('click', async (ev) => {
      const recNow = window.StudyApp.getProgressRecord(q.id) || {};
      const statusNow = recNow.status || 'not_started';
      const curDlpfc = window.StudyApp.effectiveDlpfc?.(q, recNow)?.tier || Number(q.dlpfcBase || 2);
      const minStruggleSec = Math.min(120, Math.round(st.targetSec * 0.22));
      if (
        activeRun.mode === 'practice' &&
        curDlpfc >= 3 &&
        statusNow === 'not_started' &&
        itemActiveSec(st) < minStruggleSec &&
        !hasAnyAnswerEntered(q, st) &&
        !st.earlyPeekConfirmed
      ) {
        st.earlyPeekConfirmed = true;
        if (ev.currentTarget) ev.currentTarget.textContent = 'Confirm Reveal (S)';
        toast('Attempt a blank-slate setup first for 2x error-driven plasticity — press S again to reveal anyway.');
        return;
      }
      closePauseRecord(st, 1.5);
      workClock?.setPaused?.(false);
      pauseCurrentTimer();
      st.revealed = true;
      if (q.kind === 'mcq') {
        st.solutionPeeked = true;
        const acc = st.choice !== null && st.choice === q.answerIndex ? 1.0 : 0.0;
        await submitVerifiedAttempt(q, st, acc);
      } else if (Array.isArray(q.wiseflowFields) && q.wiseflowFields.length) {
        st.solutionPeeked = true;
        st.wfGrade = evaluateWiseflowSheet(q, st);
        await submitVerifiedAttempt(q, st, st.wfGrade.accuracy);
      } else if (q.numericCheck && st.numericInput.trim() !== '') {
        const parsed = parseWiseflowNumber(st.numericInput);
        const exp = Number(q.numericCheck.expected);
        const tol = Math.max(0.02 * Math.abs(exp), Number(q.numericCheck.tolerance || 0.02));
        if (parsed.ok && Math.abs(parsed.value - exp) <= tol) {
          const totalChecks = (q.rubricChecks || []).length || 3;
          st.checkedRubrics = Array.from({ length: totalChecks }, (_, i) => i);
          toast('Numeric answer accepted. Verify your steps below.');
        }
      }
      renderRunner();
      if (document.activeElement && (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT')) {
        document.activeElement.blur();
      }
      document.getElementById('solution-box')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    const advanceToNextOrEnd = () => {
      if (activeRun.index + 1 < activeRun.questionIds.length) enterQuestion(activeRun.index + 1);
      else openEndRunModal();
    };

    const confirmGotItAndNext = async () => {
      const hasWfLocal = Array.isArray(q.wiseflowFields) && q.wiseflowFields.length > 0;
      if (q.kind !== 'mcq' && !hasWfLocal) {
        const total = document.querySelectorAll('[data-rubric-idx]').length || (q.rubricChecks || []).length || 3;
        st.checkedRubrics = Array.from({ length: total }, (_, i) => i);
        await submitVerifiedAttempt(q, st, 1.0);
        toast('✓ Verified 100% — advancing');
      }
      advanceToNextOrEnd();
    };

    const markMissedAndNext = async () => {
      const hasWfLocal = Array.isArray(q.wiseflowFields) && q.wiseflowFields.length > 0;
      if (q.kind !== 'mcq' && !hasWfLocal) {
        st.checkedRubrics = [];
        await submitVerifiedAttempt(q, st, 0.0);
      }
      await window.StudyApp.setQuestionDifficulty(q.id, 1);
      toast('Marked Revisit (1d) — advancing');
      advanceToNextOrEnd();
    };

    const logCheckedAndNext = async () => {
      const hasWfLocal = Array.isArray(q.wiseflowFields) && q.wiseflowFields.length > 0;
      if (st.revealed && !isBlindUnfinished && q.kind !== 'mcq' && !hasWfLocal && !st.loggedAttempt) {
        const total = Math.max(1, document.querySelectorAll('[data-rubric-idx]').length);
        const acc = st.checkedRubrics.length > 0 ? st.checkedRubrics.length / total : 1.0;
        if (st.checkedRubrics.length === 0) {
          st.checkedRubrics = Array.from({ length: total }, (_, i) => i);
        }
        await submitVerifiedAttempt(q, st, acc);
      }
      advanceToNextOrEnd();
    };

    // Rubric checkboxes & Submit
    document.querySelectorAll('[data-rubric-idx]').forEach((li) => {
      li.addEventListener('click', (ev) => {
        const idx = Number(li.dataset.rubricIdx);
        if (ev.target.tagName !== 'INPUT') {
          const cb = li.querySelector('input');
          cb.checked = !cb.checked;
        }
        const checked = li.querySelector('input').checked;
        if (checked && !st.checkedRubrics.includes(idx)) st.checkedRubrics.push(idx);
        if (!checked) st.checkedRubrics = st.checkedRubrics.filter((x) => x !== idx);
      });
    });

    document.querySelectorAll('.btn-got-it-next').forEach((btn) => {
      btn.addEventListener('click', confirmGotItAndNext);
    });

    document.querySelectorAll('.btn-missed-next').forEach((btn) => {
      btn.addEventListener('click', markMissedAndNext);
    });

    document.getElementById('btn-verify-and-next')?.addEventListener('click', async () => {
      const total = Math.max(1, document.querySelectorAll('[data-rubric-idx]').length);
      const acc = st.checkedRubrics.length / total;
      await submitVerifiedAttempt(q, st, acc);
      advanceToNextOrEnd();
    });

    document.getElementById('btn-submit-rubric')?.addEventListener('click', async () => {
      const total = Math.max(1, document.querySelectorAll('[data-rubric-idx]').length);
      const acc = st.checkedRubrics.length / total;
      await submitVerifiedAttempt(q, st, acc);
      renderRunner();
    });

    // Blind Exam Flag button
    document.getElementById('btn-flag-exam')?.addEventListener('click', () => {
      st.flagged = !st.flagged;
      renderRunner();
    });

    // Status overrides (compact select + Flag button)
    document.getElementById('sel-card-status')?.addEventListener('change', async (ev) => {
      const newSt = ev.target.value;
      await window.StudyApp.setQuestionStatus([q.id], newSt, false);
      toast(`Marked ${newSt.replace('_', ' ')}`);
      renderRunner();
    });

    document.querySelectorAll('[data-set-status]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const curSt = window.StudyApp.getProgressRecord(q.id)?.status || 'not_started';
        const newSt = btn.dataset.setStatus === 'revisit' && curSt === 'revisit' ? 'not_started' : btn.dataset.setStatus;
        await window.StudyApp.setQuestionStatus([q.id], newSt, false);
        toast(`Marked ${newSt.replace('_', ' ')}`);
        renderRunner();
      });
    });

    document.getElementById('btn-retry-fresh')?.addEventListener('click', async () => {
      pauseCurrentTimer();
      delete activeRun.items[q.id];
      delete activeRun.completedAttempts[q.id];
      await window.StudyApp.setQuestionStatus([q.id], 'in_progress', true);
      enterQuestion(activeRun.index);
      toast('Attempt reset — fresh timer started.');
    });

    // Prev / Next / Submit Paper / End / Reference
    document.getElementById('btn-prev-q')?.addEventListener('click', () => enterQuestion(activeRun.index - 1));
    document.getElementById('btn-next-q')?.addEventListener('click', logCheckedAndNext);
    document.querySelectorAll('.btn-next-q-inline').forEach((btn) => {
      btn.addEventListener('click', advanceToNextOrEnd);
    });
    document.getElementById('btn-submit-paper-bottom')?.addEventListener('click', () => promptSubmitFullExam());
    document.getElementById('btn-end-run')?.addEventListener('click', () => {
      if (isBlindUnfinished) promptSubmitFullExam();
      else openEndRunModal();
    });
    document.getElementById('btn-inline-ref')?.addEventListener('click', () => {
      openReferenceDrawer(activeRun.courseMeta, q.obsidianLink?.file || '', q.obsidianLink?.heading || '');
    });

    document.querySelectorAll('[data-jump-idx]').forEach((b) => {
      b.addEventListener('click', () => enterQuestion(Number(b.dataset.jumpIdx)));
    });
  }

  // ---------------------------------------------------------------------------
  // FULL BLIND WISEFLOW EXAM PAPER SUBMISSION & AUTO-GRADING
  // ---------------------------------------------------------------------------
  async function promptSubmitFullExam() {
    if (!activeRun || activeRun.paperSubmitted) return;
    pauseCurrentTimer();
    const m = computeRunSummary();
    const unanswered = m.total - m.answeredCount;
    const msg =
      unanswered > 0
        ? `You have ${unanswered} unanswered question(s) out of ${m.total}. Submit and grade the entire exam paper now?`
        : `Submit all ${m.total} questions and open the solutions?`;
    if (!confirm(msg)) {
      resumeCurrentTimer();
      return;
    }

    toast('Grading full exam paper…');
    let earnedPts = 0;
    let totalPts = 0;
    let manualCount = 0;

    for (const qid of activeRun.questionIds) {
      const q = activeRun.questionsById[qid];
      const st = itemState(qid);
      st.revealed = true;
      const qPts = Number(q.points || (q.kind === 'mcq' ? 2 : 10));

      if (q.kind === 'mcq') {
        const acc = st.choice !== null && st.choice === q.answerIndex ? 1.0 : 0.0;
        earnedPts += acc * qPts;
        totalPts += qPts;
        await submitVerifiedAttempt(q, st, acc);
      } else if (Array.isArray(q.wiseflowFields) && q.wiseflowFields.length) {
        st.wfGrade = evaluateWiseflowSheet(q, st);
        earnedPts += st.wfGrade.accuracy * qPts;
        totalPts += qPts;
        await submitVerifiedAttempt(q, st, st.wfGrade.accuracy);
      } else {
        manualCount += 1;
      }
    }

    activeRun.paperSubmitted = true;
    activeRun.paperScoreSummary = {
      earnedPts,
      totalPts,
      pct: totalPts > 0 ? (earnedPts / totalPts) * 100 : 0,
      manualCount,
    };

    renderRunner();
    toast(
      manualCount > 0
        ? `Check your working against the marking checklists for ${manualCount} written problem(s).`
        : `Exam graded: ${earnedPts.toFixed(1)} / ${totalPts} pts (${Math.round(activeRun.paperScoreSummary.pct)}%)! Review any question or click Finish Run.`
    );
  }

  async function submitVerifiedAttempt(q, st, qualityAccuracy) {
    closePauseRecord(st, 1.5);
    const dlpfcTier = window.StudyApp.effectiveDlpfc?.(q)?.tier || Number(q.dlpfcBase || 2);
    const res = await window.StudyApp.logAttempt({
      sessionId: activeRun.sessionId,
      courseId: q.courseId,
      questionId: q.id,
      topicId: q.topicId,
      kind: q.kind,
      dlpfcTier,
      profile: activeRun.profile,
      activeSec: Math.max(1, itemActiveSec(st)),
      aiParSec: st.targetSec,
      hintsUsed: st.hintsUsed,
      assisted: Boolean(st.solutionPeeked),
      hintHandicapSec: st.handicapPerHintSec,
      qualityAccuracy,
      focusSwitchCount: st.focusSwitches.length,
      awayElapsedSec: Math.round((st.awayElapsedMs || 0) / 100) / 10,
      manualPauseCount: st.manualPauseCount || 0,
      focusSwitches: st.focusSwitches,
      choice: st.choice,
      draft: st.draft,
      wiseflowAnswers: st.wiseflow,
      checkedRubricIndices: st.checkedRubrics,
    });
    activeRun.consecutiveMisses = qualityAccuracy < 0.6 ? (activeRun.consecutiveMisses || 0) + 1 : 0;
    if (res?.attempt) {
      st.loggedAttempt = res.attempt;
      activeRun.completedAttempts[q.id] = res.attempt;
    }
  }

  function tickLiveClocks() {
    if (!activeRun || document.getElementById('view-runner').hidden) return;
    const q = currentQuestion();
    if (!q) return;
    const st = itemState(q.id);
    const activeSec = itemActiveSec(st);
    const effSec = activeSec + st.hintsUsed * st.handicapPerHintSec;
    const delta = effSec - st.targetSec;

    const pill = document.getElementById('run-live-pill');
    if (pill) {
      if (st.pauseActive) {
        const tag = st.pauseActive.reason === 'manual_pause' ? 'Paused' : 'Auto-Paused';
        pill.textContent = `${tag} · ${clockSec(activeSec)}`;
        pill.classList.add('flow-pill-warn');
      } else {
        pill.textContent = `Q ${clockSec(activeSec)}`;
        pill.classList.remove('flow-pill-warn');
      }
    }

    // Anti-Stall nudge (Guided Practice mode)
    const stallBanner = document.getElementById('stall-nudge-banner');
    if (activeRun.mode === 'practice' && !st.revealed) {
      if (stallBanner) {
        const stallCapSec = q.kind === 'mcq' ? Math.max(180, st.stuckSec || 180) : Math.min(480, Math.max(300, st.stuckSec || 480));
        if (activeSec >= stallCapSec && st.hintsUsed === 0) {
          stallBanner.textContent =
            'Stall cap reached — press H for 1 hint step (or O for Reference), then write the setup yourself.';
          stallBanner.hidden = false;
        } else {
          stallBanner.hidden = true;
        }
      }
    } else if (stallBanner) {
      stallBanner.hidden = true;
    }

    // Total Exam Paper Countdown
    const examCd = document.getElementById('run-exam-countdown');
    if (examCd && activeRun.examBudgetSec && !activeRun.paperSubmitted) {
      const remSec = Math.max(0, activeRun.examBudgetSec - totalExamActiveSec());
      examCd.textContent = `${clockSec(remSec)} left`;
      examCd.classList.toggle('urgent', remSec <= 600);
    }

    const lblYou = document.getElementById('lbl-you-time');
    if (lblYou) lblYou.textContent = clockSec(effSec);

    const barYou = document.getElementById('bar-you');
    const badge = document.getElementById('ghost-delta-badge');
    if (barYou && badge) {
      const pct = Math.min(100, (effSec / Math.max(1, st.targetSec)) * 100);
      barYou.style.width = `${pct.toFixed(1)}%`;
      barYou.classList.remove('near', 'over');
      badge.className = 'badge';

      if (delta <= 0) {
        if (pct >= 82) {
          barYou.classList.add('near');
          badge.classList.add('warn');
          badge.textContent = `${clockSec(Math.abs(delta))} under Par`;
        } else {
          badge.classList.add('live');
          badge.textContent = `-${clockSec(Math.abs(delta))} vs Par`;
        }
      } else {
        barYou.classList.add('over');
        badge.classList.add('bad');
        badge.textContent = `+${clockSec(delta)} over Par`;
      }
    }
  }

  function openEndRunModal() {
    if (!activeRun) return;
    pauseCurrentTimer();
    const m = computeRunSummary();
    const ps = activeRun.paperScoreSummary;
    const scr = workClock?.getScreenStats?.() || {};
    const hdr = document.getElementById('checkin-summary-header');
    const examLine = ps?.totalPts
      ? `<p style="margin:4px 0 8px"><strong>Auto-graded score: ${ps.earnedPts.toFixed(1)} / ${ps.totalPts} pts (${Math.round(
          ps.pct
        )}%)</strong></p>`
      : '';
    hdr.innerHTML = `
      <span class="eyebrow">${esc(activeRun.courseMeta.shortTitle)} · Run Summary</span>
      <h2>${m.reviewed} / ${m.total} Verified · Run UPI ${m.liveUpi ?? '—'}</h2>
      ${examLine}
      <div class="metrics-grid" style="margin:12px 0 4px">
        <div class="metric-tile"><small>Beat AI Par</small><b>${m.beatCount} / ${m.reviewed || 0}</b></div>
        <div class="metric-tile"><small>Accuracy</small><b>${m.reviewed ? Math.round(m.avgAcc * 100) + '%' : '—'}</b></div>
        <div class="metric-tile"><small>Run Focus</small><b>${clockSec(m.activeSec)}</b><small>${activeRun.sessionFocusSwitches || 0} focus sw.</small></div>
        <div class="metric-tile"><small>Screen Today</small><b>${esc(scr.screenLabel || '0m')}</b><small>${esc(scr.offScreenLabel || '0m')} off-screen</small></div>
      </div>
    `;
    document.getElementById('checkin-modal').hidden = false;
  }

  async function finalizeSession(includeCheckIn) {
    if (!activeRun) return;
    const m = computeRunSummary();
    let checkIn = null;
    if (includeCheckIn) {
      const getVal = (field) => {
        const b = document.querySelector(`.rating-pills[data-field="${field}"] button.selected`);
        return b ? Number(b.dataset.val) : 3;
      };
      const tags = [...document.querySelectorAll('#checkin-tags .tag-chip.selected')].map((b) => b.dataset.tag);
      const note = document.getElementById('checkin-note')?.value.trim() || '';
      checkIn = {
        focus: getVal('focus'),
        energy: getVal('energy'),
        startInertia: getVal('startInertia'),
        tags,
        note,
      };
    }

    const wasExam = activeRun.mode === 'exam';
    const highDlpfcSec = Object.entries(activeRun.items).reduce((sum, [qid, it]) => {
      const qo = activeRun.questionsById[qid];
      const t = window.StudyApp.effectiveDlpfc?.(qo)?.tier || Number(qo?.dlpfcBase || 2);
      return sum + (t >= 3 ? itemActiveSec(it) : 0);
    }, 0);
    await window.StudyApp.logSession({
      sessionId: activeRun.sessionId,
      startedAt: activeRun.startedAtIso,
      courseId: activeRun.courseMeta.courseId,
      topicIds: [...new Set(activeRun.questionIds.map((id) => activeRun.questionsById[id]?.topicId).filter(Boolean))],
      profile: activeRun.profile,
      calendarEventId: activeRun.calendarBlock?.eventId || '',
      calendarSummary: activeRun.calendarBlock?.summary || activeRun.examTitle || '',
      reviewedCount: m.reviewed,
      beatAiCount: m.beatCount,
      activeSec: m.activeSec,
      wallSec: m.wallSec,
      focusSwitchCount: activeRun.sessionFocusSwitches || 0,
      awaySec: Math.round((activeRun.sessionAwayMs || 0) / 100) / 10,
      highDlpfcSec: Math.round(highDlpfcSec * 10) / 10,
      avgAccuracy: m.avgAcc,
      avgPaceRatio: m.avgPr,
      checkIn,
    });

    document.getElementById('checkin-modal').hidden = true;
    if (document.getElementById('checkin-note')) document.getElementById('checkin-note').value = '';
    clearInterval(tickInterval);
    activeRun = null;
    document.body.classList.remove('runner-split-wide', 'runner-split-pdf', 'runner-foveal-compact');
    document.getElementById('runner-header').hidden = true;
    document.getElementById('global-header').hidden = false;
    toast('Session logged & Dashboard updated.');
    await window.StudyApp.refreshBootstrap();
    window.StudyApp.navigate(wasExam ? 'exams' : 'home');
  }

  function exitRunnerKeepPaused() {
    pauseCurrentTimer();
    window.StudyPdf.dispose();
    document.body.classList.remove('runner-split-wide', 'runner-split-pdf', 'runner-foveal-compact');
    document.getElementById('runner-header').hidden = true;
    document.getElementById('global-header').hidden = false;
    window.StudyApp.navigate('home');
  }

  function resumePausedRun() {
    if (!activeRun) return;
    workClock?.ensureWorking?.();
    document.getElementById('global-header').hidden = true;
    document.getElementById('runner-header').hidden = false;
    window.StudyApp.showRawView('runner');
    resumeCurrentTimer();
    renderRunner();
  }

  function toggleSplitWorkspace() {
    if (!activeRun) return;
    const q = currentQuestion();
    if (!q) return;
    const st = itemState(q.id);
    const curSplit = document.body.classList.contains('runner-split-wide');
    const nextSplit = !curSplit;
    if (!nextSplit && (st.readerTab === 'pdf' || st.readerTab === 'ref')) {
      st.readerTab = 'task';
    }
    st.layoutOverride = nextSplit ? 'split' : 'foveal';
    saveRunnerUiPrefs({ preferredLayout: nextSplit ? 'split' : 'focus' });
    toast(nextSplit ? 'Side-by-Side Split View' : 'Focus Column (default)');
    renderRunner();
  }

  function bindRunnerGlobals() {
    const runnerHeader = document.getElementById('runner-header');
    new ResizeObserver(() => {
      if (!runnerHeader.hidden) {
        document.body.style.setProperty('--runner-sticky-top', runnerHeader.offsetHeight + 8 + 'px');
      }
    }).observe(runnerHeader);
    document.getElementById('run-exit-btn')?.addEventListener('click', exitRunnerKeepPaused);
    document.getElementById('run-layout-btn')?.addEventListener('click', toggleSplitWorkspace);
    document.getElementById('run-submit-exam-btn')?.addEventListener('click', () => promptSubmitFullExam());
    document.getElementById('run-live-pill')?.addEventListener('click', toggleManualPause);
    document.getElementById('run-autopause-btn')?.addEventListener('click', cycleAutoPauseMode);
    document.getElementById('run-fullscreen-btn')?.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) {
          intentionalFsExit = true;
          await document.exitFullscreen();
        } else {
          await document.documentElement.requestFullscreen();
        }
      } catch {
        toast('Fullscreen is blocked by browser settings.');
      }
      renderAutoPauseHeaderUi();
    });

    // Automatic Display / Window / Tab Focus-Loss Pause & Resume
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearTimeout(blurTimer);
        triggerFocusAutoPause('tab_hidden');
      } else if (autoPauseMode === 'tab' || document.hasFocus()) {
        clearFocusAutoPause();
      }
    });

    window.addEventListener('blur', () => {
      if (autoPauseMode !== 'window') return;
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        // Clicking an embedded in-app Source PDF iframe keeps focus inside Study-OS!
        if (document.activeElement && document.activeElement.tagName === 'IFRAME' && !document.hidden) {
          return;
        }
        if (document.hidden || !document.hasFocus()) {
          triggerFocusAutoPause(document.hidden ? 'tab_hidden' : 'window_blur');
        }
      }, 450);
    });

    window.addEventListener('focus', () => {
      clearTimeout(blurTimer);
      if (!document.hidden) {
        clearFocusAutoPause();
      }
    });

    document.addEventListener('fullscreenchange', () => {
      renderAutoPauseHeaderUi();
      if (!document.fullscreenElement) {
        if (!intentionalFsExit && autoPauseMode !== 'off' && !document.hasFocus()) {
          triggerFocusAutoPause('fullscreen_exit');
        }
        intentionalFsExit = false;
      } else {
        clearFocusAutoPause(true);
      }
    });
    renderAutoPauseHeaderUi();

    // Check-in modal pills & buttons
    document.querySelectorAll('.rating-pills').forEach((grp) => {
      grp.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          grp.querySelectorAll('button').forEach((x) => x.classList.remove('selected'));
          btn.classList.add('selected');
        });
      });
    });
    document.querySelectorAll('#checkin-tags .tag-chip').forEach((chip) => {
      chip.addEventListener('click', () => chip.classList.toggle('selected'));
    });
    document.getElementById('checkin-save-btn')?.addEventListener('click', () => finalizeSession(true));
    document.getElementById('checkin-skip-btn')?.addEventListener('click', () => finalizeSession(false));

    // Keyboard shortcuts inside Runner
    document.addEventListener('keydown', (e) => {
      const breakModal = document.getElementById('break-modal');
      if (breakModal && !breakModal.hidden) {
        if (e.key === 'Escape') {
          workClock?.startNextInterval?.();
          e.preventDefault();
        }
        return;
      }
      if (!activeRun || document.getElementById('view-runner').hidden || !document.getElementById('checkin-modal').hidden) return;
      if (e.target?.closest?.('.pdf-zoom-scroll, .pdf-page-tools, .pdf-zoom-tools')) return;
      if (!document.getElementById('img-lightbox')?.hidden) return;

      // Cmd/Ctrl + Enter works even while typing inside the answer textarea:
      // 1st press -> Reveal Solution / Check Answer; 2nd press -> Got It Right & Next Question!
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === 'Enter') {
        const primary =
          document.getElementById('btn-check-mcq') ||
          document.getElementById('btn-check-wf') ||
          document.getElementById('btn-reveal-sol') ||
          document.querySelector('.btn-got-it-next') ||
          document.getElementById('btn-next-q');
        if (primary && !primary.disabled) {
          primary.click();
          e.preventDefault();
        }
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;

      const key = e.key.toLowerCase();
      const letterIdx = 'abcdef'.indexOf(key);
      const mcqIdx = letterIdx >= 0 ? letterIdx : /^[1-6]$/.test(key) ? Number(key) - 1 : -1;
      const mcqOpt = mcqIdx >= 0 ? document.querySelector(`[data-mcq-idx="${mcqIdx}"]`) : null;
      if (mcqOpt) {
        mcqOpt.click();
        e.preventDefault();
      } else if (key === 'g') {
        const gotBtn = document.querySelector('.btn-got-it-next') || document.getElementById('btn-next-q');
        if (gotBtn && !gotBtn.disabled) {
          gotBtn.click();
          e.preventDefault();
        }
      } else if (key === 'x') {
        const missBtn = document.querySelector('.btn-missed-next');
        if (missBtn && !missBtn.disabled) {
          missBtn.click();
          e.preventDefault();
        }
      } else if (key === 'n') {
        const nextBtn =
          document.getElementById('btn-next-q') ||
          document.querySelector('.btn-next-q-inline') ||
          document.getElementById('btn-verify-and-next');
        if (nextBtn && !nextBtn.disabled) {
          nextBtn.click();
          e.preventDefault();
        }
      } else if (key === 'enter') {
        const btn =
          document.getElementById('btn-check-mcq') ||
          document.getElementById('btn-check-wf') ||
          document.getElementById('btn-next-q') ||
          document.querySelector('.btn-next-q-inline') ||
          document.querySelector('.btn-got-it-next');
        if (btn && !btn.disabled) {
          btn.click();
          e.preventDefault();
        }
      } else if (key === 'h') {
        document.getElementById('btn-hint')?.click();
      } else if (key === 's') {
        document.getElementById('btn-reveal-sol')?.click();
      } else if (key === 'o') {
        const q = currentQuestion();
        const isBlind = activeRun.examStyle === 'blind' && !activeRun.paperSubmitted;
        if (!isBlind && q) {
          if (document.body.classList.contains('runner-split-wide')) {
            const st = itemState(q.id);
            st.readerTab = st.readerTab === 'ref' ? 'task' : 'ref';
            if (st.readerTab === 'ref') {
              renderRunner();
              ensureInlineRefLoaded(q, st).then(() => renderRunner());
            } else {
              renderRunner();
            }
          } else {
            openReferenceDrawer(activeRun.courseMeta, q.obsidianLink?.file || '', q.obsidianLink?.heading || '');
          }
        }
      } else if (key === 'b' && activeRun.mode === 'practice') {
        workClock?.triggerBreak?.(false);
        e.preventDefault();
      } else if (key === 'p') {
        toggleManualPause();
        e.preventDefault();
      } else if (key === 'f') {
        const flagBtn = document.getElementById('btn-flag-exam') || document.querySelector('[data-set-status="revisit"]');
        flagBtn?.click();
      } else if (key === 'v') {
        toggleSplitWorkspace();
        e.preventDefault();
      } else if (key === 'arrowright') {
        if (activeRun.index + 1 < activeRun.questionIds.length) enterQuestion(activeRun.index + 1);
      } else if (key === 'arrowleft') {
        if (activeRun.index > 0) enterQuestion(activeRun.index - 1);
      }
    });
  }

  return {
    getRun,
    startRun,
    resumePausedRun,
    bindRunnerGlobals,
    onBreakStateChange,
  };
})();
