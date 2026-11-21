/* Competitive Study & WISEflow Exam Runner:
 * - Ghost Timer vs AI Learning/Exam Par & Accuracy-Gated Scoring
 * - WISEflow FLOWmulti Multi-Box Auto-Grader (2 decimals + ±2% rounding margin, minus-sign check)
 * - Strict Blind WISEflow Exam Paper Mode (Total Countdown + Flagging + Full Paper Submit)
 * - 5-Second Frictionless Post-Run Telemetry Check-In
 */
'use strict';

window.StudyRunner = (() => {
  const { esc, examLabel, clockSec, minLabel, renderMarkdownWithMath, toast, openReferenceDrawer, workClock, devMode } = window.StudyUI;

  let activeRun = null;
  let parkedRun = null;
  let tickInterval = null;
  let pendingSaves = 0;

  const RUNNER_UI_KEY = 'study-os-runner-ui-v3';
  const dockReferenceLayout = matchMedia('(min-width: 1020px)');
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
    // Keep the task visible alongside inline PDFs, source context gates, and references.
    if (st?.readerTab === 'pdf' || st?.readerTab === 'context') return true;
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
      const resumeDraft = !activeRun.freshExamSit && rec.status !== 'done'
        && (rec.status === 'in_progress' || (!rec.lastAttemptAt && !rec.attemptCount && !rec.pbEffectiveSec));
      const prof = activeRun.profile || 'learning';
      const pSpec = q?.pacing?.[prof] || q?.pacing?.learning || { target: 3, min: 2, max: 5 };
      const calPar = window.StudyApp.calibratedParSec
        ? window.StudyApp.calibratedParSec(q, prof)
        : Math.max(15, Math.round((Number(pSpec.target) || 3) * 60));
      activeRun.items[qid] = {
        elapsedMs: 0,
        runningSince: null,
        targetSec: calPar,
        minSec: Math.max(15, Math.round(calPar * 0.65)),
        maxSec: Math.round(calPar * 1.55),
        stuckSec: Math.max(45, Math.min(Math.round((Number(q?.pacing?.stuckMinutes) || 2) * 60), Math.round(calPar * 1.2))),
        handicapPerHintSec: Number(q?.pacing?.hintHandicapSeconds ?? 30),
        hintsUsed: 0,
        choice: resumeDraft ? rec.savedChoice ?? null : null,
        draft: resumeDraft ? rec.savedDraft || '' : '',
        wiseflow: resumeDraft ? { ...rec.savedWiseflow } : {},
        wfGrade: null,
        numericInput: '',
        checkedRubrics: resumeDraft && Array.isArray(rec.checkedRubricIndices)
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
    document.querySelectorAll('#settings-autopause-seg [data-autopause-val]').forEach((btn) => {
      const active = btn.dataset.autopauseVal === autoPauseMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const inFs = Boolean(document.fullscreenElement);
    const fsToggle = document.getElementById('settings-fullscreen-toggle');
    if (fsToggle) fsToggle.checked = inFs;
  }

  function setAutoPauseMode(nextMode) {
    if (!['off', 'tab', 'window'].includes(nextMode)) return;
    autoPauseMode = nextMode;
    try {
      localStorage.setItem(AUTOPAUSE_KEY, autoPauseMode);
    } catch {}
    if (autoPauseMode === 'off') {
      clearFocusAutoPause(true);
    }
    renderAutoPauseHeaderUi();
    const msg =
      autoPauseMode === 'window'
        ? 'Auto-Pause: Window + Tab (pauses when another window or tab takes focus)'
        : autoPauseMode === 'tab'
        ? 'Auto-Pause: Tab Only (side-by-side apps stay unpaused)'
        : 'Auto-Pause: Off (manual pause P still active)';
    toast(msg);
  }

  async function toggleFullscreen() {
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
  }

  function pauseCurrentTimer(now = Date.now()) {
    const q = currentQuestion();
    if (!q) return;
    const st = itemState(q.id);
    if (st.runningSince != null) {
      st.elapsedMs += Math.max(0, now - st.runningSince);
      st.runningSince = null;
    }
  }

  function resumeCurrentTimer() {
    if (devMode.isActive()) return;
    const q = currentQuestion();
    if (!q) return;
    if (workClock?.getState?.().mode === 'break') return;
    const st = itemState(q.id);
    if (st.pauseActive) return;
    if (activeRun.examStyle === 'blind' ? activeRun.paperSubmitted : st.revealed) return;
    if (st.runningSince == null) {
      st.runningSince = Date.now();
    }
  }

  function closePauseRecord(st, minLogSec = 1.5) {
    if (!st?.pauseActive) return 0;
    const now = Date.now();
    const durMs = Math.max(0, now - st.pauseActive.startedAtMs - (st.pauseActive.excludedMs || 0));
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
    if (devMode.isActive()) return;
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
    if (devMode.isActive() || autoPauseMode === 'off') return;
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
    if (devMode.isActive()) return;
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
    resumeCurrentTimer();
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
        out.push({ ...entry, sourceId: a.sourceId, questionId: q.id, questionTitle: q.title, isSolution: isSol });
      }
    };

    for (const a of q.contextAssets || []) addFromAsset(a, false);
    for (const a of q.promptAssets || []) addFromAsset(a, false);
    if (q.extraReference && !isBlindUnfinished) {
      const ref = q.extraReference;
      const entry = resolveSourceEntry({ title: ref.title, canvasPath: ref.path }, ref.page);
      if (entry && !seen.has(entry.key)) {
        seen.add(entry.key);
        out.push(entry);
      }
    }
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
    if (Array.isArray(q.sourceRefs)) {
      for (const ref of q.sourceRefs) {
        if (!ref) continue;
        const isSolution = Boolean(ref.isSolution || ref.role === 'solution');
        if ((isBlindUnfinished || !includeSolutionPdfs) && isSolution) continue;
        const page = Math.max(1, Number(ref.page) || 1);
        const local = window.StudyLocalSources?.match(q.courseId, ref);
        const title = ref.title || local?.title;
        const entry = local ? {
          key: `local:${local.key}#p${page}`, localSourceKey: local.key, localFile: local,
          title, page, isPdf: true, pathStr: local.filename,
          label: ref.caption || `${title || local.filename} · p. ${page}`,
        } : !isBlindUnfinished
          ? resolveSourceEntry(window.StudyMembers?.sourceDocument?.(q.courseId, ref), page, ref.caption)
          : null;
        if (!entry || seen.has(entry.key)) continue;
        seen.add(entry.key);
        out.push({
          ...entry,
          sourceId: ref.sourceId,
          questionId: q.id,
          questionTitle: q.title,
          role: ref.role || 'prompt',
          isSolution,
        });
      }
    }
    return out;
  }

  const autoCanvasFetchInFlight = new Set();
  const autoCanvasFetchFailed = new Map();

  function renderInlineLocalPdfFigures(entries) {
    if (!Array.isArray(entries) || !entries.length) return { html: '', mountItems: [] };
    const mountItems = [];
    const html = entries
      .map((entry, idx) => {
        const inlineKey = `inline:${entry.key}`;
        mountItems.push({ key: inlineKey, source: entry, page: entry.page || 1 });
        return `<figure class="pdf-figure pdf-figure-inline-local" data-fig-idx="${idx}" data-inline-pdf-key="${esc(inlineKey)}">
          <figcaption>
            <span>${esc(entry.label)}</span>
            <span class="row-actions" style="gap:6px">
              ${window.StudyPdf.toolbar(true)}
              <button type="button" class="mini-tool-btn" data-open-inline-pdf="${esc(entry.key)}" title="Open full multi-page PDF reader">Full PDF (p.${esc(entry.page || 1)})</button>
            </span>
          </figcaption>
          <p class="muted pdf-status" data-pdf-status role="status" style="margin:6px 10px">Loading question excerpt…</p>
          <div class="pdf-zoom-scroll pdf-figure-scroll" tabindex="0" aria-label="Scrollable question excerpt">
            <div class="pdf-zoom-page"><canvas aria-hidden="true"></canvas><div class="textLayer"></div></div>
          </div>
        </figure>`;
      })
      .join('');
    return { html, mountItems };
  }

  function maybeAutoFetchCanvasSources(q, lockedRefs) {
    if (!document.documentElement.dataset.studyOsSyncExt) return;
    if (!window.StudyApp?.fetchCanvasPdfViaExtension || !window.StudyLocalSources) return;
    if (!Array.isArray(lockedRefs) || !lockedRefs.length) return;

    const seen = new Set();
    for (const ref of lockedRefs) {
      if (!ref || ref.kind === 'book' || !ref.canvasCourseId || !ref.canvasFileId) continue;
      if (window.StudyLocalSources.match(q.courseId, ref)) continue;
      const fetchKey = `${ref.canvasCourseId}:${ref.canvasFileId}`;
      if (seen.has(fetchKey) || autoCanvasFetchInFlight.has(fetchKey) || autoCanvasFetchFailed.has(fetchKey)) continue;
      seen.add(fetchKey);
      autoCanvasFetchInFlight.add(fetchKey);

      (async () => {
        try {
          let origin = 'https://canvas.bi.no';
          try { if (ref.canvasUrl) origin = new URL(ref.canvasUrl).origin; } catch {}
          const file = await window.StudyApp.fetchCanvasPdfViaExtension(ref.canvasCourseId, ref.canvasFileId, origin);
          await window.StudyLocalSources.save(q.courseId, ref.sourceId, file, {
            kind: 'canvas',
            title: ref.title || file.name,
          });
          autoCanvasFetchFailed.delete(fetchKey);
        } catch (err) {
          autoCanvasFetchFailed.set(fetchKey, err?.message || 'Sign in to BI Canvas in Chrome to load this PDF inline.');
        } finally {
          autoCanvasFetchInFlight.delete(fetchKey);
          if (activeRun && currentQuestion()?.id === q.id) {
            renderRunner();
          }
        }
      })();
    }
  }

  function getQuestionLockedSources(q, isBlindUnfinished, includeSolutionPdfs, unlockedPdfs = []) {
    const refs = Array.isArray(q?.sourceRefs) ? q.sourceRefs : [];
    if (!refs.length) return [];
    const unlockedIds = new Set(unlockedPdfs.map((p) => `${p.sourceId || ''}:${p.page || 1}`));
    const out = [];
    const seen = new Set();
    for (const ref of refs) {
      if (!ref) continue;
      if (isBlindUnfinished && ref.isSolution) continue;
      if (!includeSolutionPdfs && ref.role === 'solution') continue;
      if (unlockedIds.has(`${ref.sourceId}:${ref.page || 1}`)) continue;
      if (window.StudyLocalSources?.match(q.courseId, ref)) continue;
      const dedupeKey = `${ref.sourceId}:${ref.page || 1}:${ref.role || ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(ref);
    }
    return out;
  }

  function renderSourceContextGate(q, lockedRefs, compact = false) {
    if (!Array.isArray(lockedRefs) || !lockedRefs.length) return '';
    const syncSt = window.StudyApp?.getBiSyncStatus?.() || { hasEverSynced: false };
    const isSynced = Boolean(syncSt.hasEverSynced);
    const books = lockedRefs.filter((r) => r.kind === 'book');
    const canvasRefs = lockedRefs.filter((r) => r.kind !== 'book');

    const bookCard = books.length ? (() => {
      const b = books[0];
      const pages = [...new Set(books.map((x) => `p. ${x.page || 1}`))].join(', ');
      if (compact) {
        return `<div class="source-gate-card source-gate-compact source-gate-book" data-local-dropzone data-course-id="${esc(q.courseId)}" data-source-id="${esc(b.sourceId)}" data-source-kind="book" data-source-title="${esc(b.title)}" data-source-page="${esc(b.page || 1)}">
          <div class="source-gate-copy">
            <strong>Textbook context · ${esc(b.title)} (${esc(pages)})</strong>
            <small class="muted">Attach your copy once to read these pages in this browser.</small>
          </div>
          <div class="row-actions">
            <label class="primary-btn source-gate-upload-btn" style="padding:6px 12px;font-size:12.5px">
              Drop / Choose PDF Book
              <input type="file" accept=".pdf,application/pdf" hidden data-local-pdf-input data-course-id="${esc(q.courseId)}" data-source-id="${esc(b.sourceId)}" data-source-kind="book" data-source-title="${esc(b.title)}" data-source-page="${esc(b.page || 1)}">
            </label>
            ${window.StudyMembers?.enabled && !window.StudyMembers.isUnlocked()
              ? '<button type="button" class="ghost-btn source-gate-upload-btn" data-open-member-unlock>Use archive key</button>'
              : ''}
          </div>
        </div>`;
      }
      return `<div class="source-gate-card source-gate-book" data-local-dropzone data-course-id="${esc(q.courseId)}" data-source-id="${esc(b.sourceId)}" data-source-kind="book" data-source-title="${esc(b.title)}" data-source-page="${esc(b.page || 1)}">
        <span class="prov-badge prov-book">Bring Your Own Book · ${esc(pages)}</span>
        <h3 style="margin:8px 0 6px">Drop your own PDF copy of ${esc(b.title)}</h3>
        <p class="muted" style="margin:0 0 12px;font-size:13.5px">Study-OS never distributes copyrighted publisher textbooks. Drop your own PDF copy once to unlock instant inline reading &amp; automatic page jumps (${esc(pages)}) across every textbook exercise in this course. Your PDF stays <strong>100% private in this browser</strong> (IndexedDB) and is never uploaded.</p>
        <label class="source-dropzone-box">
          <strong>Drop your textbook PDF here or click to choose file</strong>
          <small class="muted">PDF only · jumps automatically to ${esc(pages)} · never leaves your device</small>
          <input type="file" accept=".pdf,application/pdf" hidden data-local-pdf-input data-course-id="${esc(q.courseId)}" data-source-id="${esc(b.sourceId)}" data-source-kind="book" data-source-title="${esc(b.title)}" data-source-page="${esc(b.page || 1)}">
        </label>
      </div>`;
    })() : '';

    const canvasCard = canvasRefs.length ? (() => {
      const c = canvasRefs[0];
      const hasExtBridge = Boolean(document.documentElement.dataset.studyOsSyncExt);
      const canDirectFetch = hasExtBridge && Boolean(c.canvasCourseId && c.canvasFileId);
      const fetchKey = c.canvasCourseId && c.canvasFileId ? `${c.canvasCourseId}:${c.canvasFileId}` : '';
      const isFetching = Boolean(fetchKey && autoCanvasFetchInFlight.has(fetchKey));
      const fetchErr = fetchKey ? autoCanvasFetchFailed.get(fetchKey) || '' : '';
      const pagesSummary = [...new Set(canvasRefs.map((x) => `p. ${x.page || 1}`))].join(', ');
      const fileChips = canvasRefs.slice(0, 4).map((r) =>
        `<span class="badge">${esc(r.filename || r.title)}${r.page ? ` · p. ${r.page}` : ''}</span>`
      ).join('');
      if (compact) {
        if (isFetching) {
          return `<div class="source-gate-card source-gate-compact source-gate-canvas is-loading">
            <div class="source-gate-copy">
              <strong>Loading ${esc(c.filename || c.title)} (${esc(pagesSummary)})…</strong>
              <small class="muted">Pulling privately from your signed-in BI Canvas session in Chrome — will pop up inline automatically.</small>
            </div>
          </div>`;
        }
        return `<div class="source-gate-card source-gate-compact source-gate-canvas" data-local-dropzone data-course-id="${esc(q.courseId)}" data-source-id="${esc(c.sourceId)}" data-source-kind="canvas" data-source-title="${esc(c.title)}" data-source-page="${esc(c.page || 1)}">
          <div class="source-gate-copy">
            <strong>${
              fetchErr
                ? 'Sign in to BI Canvas to auto-load inline'
                : canDirectFetch
                ? 'Load BI Canvas PDF inline'
                : isSynced
                ? 'BI Canvas synced · Reload Study-OS Sync v1.5 for auto-inline PDFs'
                : 'Sync with BI Canvas to unlock readable course material'
            }</strong>
            <small class="muted">${esc(c.filename || c.title)} (${esc(pagesSummary)}) · ${
              fetchErr
                ? esc(fetchErr)
                : canDirectFetch
                ? 'Loads straight from your signed-in Chrome BI Canvas session — stays private in your browser.'
                : isSynced
                ? 'Reload the updated Study-OS Sync extension in Chrome to pop up BI PDFs automatically here, or open on BI Canvas / drop the PDF.'
                : 'Course PDFs &amp; slides stay on BI Canvas to respect copyright.'
            }</small>
          </div>
          <div class="row-actions">
            ${canDirectFetch
              ? `<button type="button" class="primary-btn" style="padding:6px 12px;font-size:12.5px" data-fetch-canvas-pdf data-course-id="${esc(q.courseId)}" data-source-id="${esc(c.sourceId)}" data-canvas-course="${esc(c.canvasCourseId)}" data-canvas-file="${esc(c.canvasFileId)}" data-canvas-url="${esc(c.canvasUrl || '')}" data-source-title="${esc(c.title)}" data-source-page="${esc(c.page || 1)}">${fetchErr ? 'Retry inline' : 'Load PDF inline'}</button>`
              : isSynced && c.canvasUrl
              ? `<a class="primary-btn" style="padding:6px 12px;font-size:12.5px;text-decoration:none" href="${esc(c.canvasUrl)}" target="_blank" rel="noopener">Open on BI Canvas ↗</a>`
              : `<button type="button" class="primary-btn" style="padding:6px 12px;font-size:12.5px" data-open-bi-sync>Sync BI Canvas</button>`}
            ${canDirectFetch && c.canvasUrl ? `<a class="ghost-btn" style="padding:6px 10px;font-size:12.5px;text-decoration:none" href="${esc(c.canvasUrl)}" target="_blank" rel="noopener">BI Canvas ↗</a>` : ''}
            <label class="ghost-btn source-gate-upload-btn" style="padding:6px 10px;font-size:12.5px">
              Drop PDF
              <input type="file" accept=".pdf,application/pdf" hidden data-local-pdf-input data-course-id="${esc(q.courseId)}" data-source-id="${esc(c.sourceId)}" data-source-kind="canvas" data-source-title="${esc(c.title)}" data-source-page="${esc(c.page || 1)}">
            </label>
          </div>
        </div>`;
      }
      return `<div class="source-gate-card source-gate-canvas" data-local-dropzone data-course-id="${esc(q.courseId)}" data-source-id="${esc(c.sourceId)}" data-source-kind="canvas" data-source-title="${esc(c.title)}" data-source-page="${esc(c.page || 1)}">
        <span class="prov-badge ${isSynced || canDirectFetch ? 'prov-exam' : 'prov-lecture'}">${canDirectFetch ? 'Study-OS Sync Ready' : isSynced ? 'BI Canvas Connected' : 'Copyright-Safe Course Context'}</span>
        <h3 style="margin:8px 0 6px">${canDirectFetch ? 'Load your BI Canvas PDF right here' : isSynced ? 'Open or attach your BI Canvas source PDF' : 'Sync with your BI Canvas to unlock readable course material'}</h3>
        <div class="row-actions" style="gap:6px;margin:0 0 10px;flex-wrap:wrap">${fileChips}</div>
        <p class="muted" style="margin:0 0 12px;font-size:13.5px">${canDirectFetch
          ? 'Your Study-OS Sync Chrome extension can fetch this PDF directly from your signed-in BI Canvas session and render it side-by-side here at the exact page (saved only in your browser — never uploaded).'
          : isSynced
          ? 'Your BI Canvas account is connected. Open the official course file directly on BI Canvas below, or drop your downloaded PDF here to view it side-by-side inside Study-OS at the exact page.'
          : 'To keep BI course slides, exams, and handouts copyright-safe, Study-OS does not host raw university PDFs publicly. Connect your BI Canvas account to verify enrollment and jump straight to the official files — or drop your own downloaded PDF copy below for private inline viewing.'}</p>
        <div class="row-actions" style="gap:8px;margin-bottom:12px;flex-wrap:wrap">
          ${canDirectFetch
            ? canvasRefs.slice(0, 3).map((r) => r.canvasCourseId && r.canvasFileId
                ? `<button type="button" class="primary-btn" data-fetch-canvas-pdf data-course-id="${esc(q.courseId)}" data-source-id="${esc(r.sourceId)}" data-canvas-course="${esc(r.canvasCourseId)}" data-canvas-file="${esc(r.canvasFileId)}" data-canvas-url="${esc(r.canvasUrl || '')}" data-source-title="${esc(r.title)}" data-source-page="${esc(r.page || 1)}">Load ${esc(r.filename || r.title)} inline (p. ${esc(r.page || 1)})</button>`
                : '').join('')
            : ''}
          ${isSynced
            ? canvasRefs.slice(0, 3).map((r) => r.canvasUrl
                ? `<a class="${canDirectFetch ? 'ghost-btn' : 'primary-btn'}" style="text-decoration:none" href="${esc(r.canvasUrl)}" target="_blank" rel="noopener">Open ${esc(r.filename || r.title)} on BI Canvas ↗</a>`
                : '').join('')
            : `<button type="button" class="${canDirectFetch ? 'ghost-btn' : 'primary-btn'}" data-open-bi-sync>Sync with BI Canvas →</button>`}
        </div>
        <label class="source-dropzone-box">
          <strong>Or drop your downloaded PDF copy here for side-by-side reading</strong>
          <small class="muted">Saved only inside this browser · opens directly to p. ${esc(c.page || 1)}</small>
          <input type="file" accept=".pdf,application/pdf" hidden data-local-pdf-input data-course-id="${esc(q.courseId)}" data-source-id="${esc(c.sourceId)}" data-source-kind="canvas" data-source-title="${esc(c.title)}" data-source-page="${esc(c.page || 1)}">
        </label>
      </div>`;
    })() : '';

    const ownerFoot = !compact && window.StudyMembers?.enabled && !window.StudyMembers.isUnlocked()
      ? `<p class="muted" style="font-size:12px;margin:10px 0 0">Owner of the private encrypted PDF archive? <button type="button" class="inline-link-btn" data-open-member-unlock>Enter archive key</button></p>`
      : '';

    return `${bookCard}${canvasCard}${ownerFoot}`;
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
    st.inlineRefLoading = true;
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
    } finally {
      st.inlineRefLoading = false;
    }
  }

  function buildInlineRefHtml(st) {
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
    const toolbar = `
      <div class="inline-pdf-toolbar runner-ref-toolbar">
        <select id="sel-inline-ref-note" aria-label="Reference note" style="font-size:12px;padding:4px 7px;min-width:110px;max-width:155px">${noteSelHtml}</select>
        <select id="sel-inline-ref-toc" aria-label="Reference section" style="font-size:12px;padding:4px 7px;flex:1;min-width:120px">${tocSelHtml}</select>
        ${refData?.obsidianUri ? `<a class="mini-tool-btn" href="${esc(refData.obsidianUri)}" style="text-decoration:none">Obsidian ↗</a>` : ''}
      </div>
    `;
    const body = `
      <div class="markdown-body">
        ${
          !refData
            ? '<p class="muted">Loading course reference…</p>'
            : refData.available
            ? renderMarkdownWithMath(refData.markdown || '')
            : `<p class="muted">${esc(refData.error || 'Reference unavailable.')}</p>`
        }
      </div>
    `;
    return `
      <div class="reader-tabbar runner-ref-header">
        <div class="runner-ref-title-wrap">
          <span class="runner-ref-dot" aria-hidden="true"></span>
          <strong style="font-size:13px">Reference</strong>
        </div>
        <div class="reader-tools">
          <button type="button" class="mini-tool-btn" data-toggle-ref-pane aria-label="Close Reference" title="Close Reference (O)">×</button>
        </div>
      </div>
      <div class="runner-pane-ref-controls">${toolbar}</div>
      <div class="runner-pane-ref-scroll">${body}</div>
    `;
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
    const avgPr = reviewed ? attempts.reduce((s, a) => s + Math.min(a.autoGraded === false ? 1.0 : 1.35, a.paceRatio), 0) / reviewed : 0;
    const activeSec = Object.values(activeRun.items).reduce((s, it) => s + itemActiveSec(it), 0);
    const wallSec = Math.max(1, (Date.now() - activeRun.startedAtMs) / 1000);
    const focusDensity = Math.min(1, activeSec / wallSec);
    const liveUpi = reviewed
      ? (window.StudyApp.computeWeightedUpi
          ? window.StudyApp.computeWeightedUpi(attempts, Math.max(0.7, focusDensity))
          : Math.round(100 * (0.45 * avgAcc + 0.35 * avgPr + 0.2 * Math.max(0.7, focusDensity))))
      : null;
    return { total, reviewed, answeredCount, beatCount, avgAcc, avgPr, activeSec, wallSec, liveUpi };
  }

  function renderRunnerNotice(isBlindUnfinished) {
    const notice = document.getElementById('runner-notice');
    const score = activeRun.paperScoreSummary;
    const suggestBreak = activeRun.mode === 'practice' && activeRun.consecutiveMisses >= 2;

    if (isBlindUnfinished) {
      const { answeredCount, total } = computeRunSummary();
      const flagged = Object.values(activeRun.items).filter((item) => item.flagged).length;
      notice.textContent = `${answeredCount} / ${total} answered${flagged ? ` · ${flagged} flagged` : ''}`;
    } else if (score) {
      notice.textContent = score.totalPts
        ? `Auto-graded score: ${score.earnedPts.toFixed(1)} / ${score.totalPts} pts (${Math.round(score.pct)}%)`
        : 'Paper submitted';
    } else if (suggestBreak) {
      notice.innerHTML = '<span>Two misses in a row</span><button type="button" class="mini-tool-btn" id="btn-run-break-nudge">Take a break</button>';
      document.getElementById('btn-run-break-nudge').onclick = () => workClock?.triggerBreak?.(false);
    } else {
      notice.textContent = '';
    }
    notice.hidden = !notice.textContent;
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
    const lockedSourceRefs = getQuestionLockedSources(q, isBlindUnfinished, st.revealed, sourcePdfs);
    const uiPrefs = getRunnerUiPrefs();
    const splitRatio = ['balanced', 'custom'].includes(uiPrefs.splitRatio) ? uiPrefs.splitRatio : 'wide-left';
    const instantMcq = Boolean(uiPrefs.instantMcq) && !isBlindUnfinished;

    // Guard invalid reader tab (e.g. if switched to question without PDFs or blind exam locks reference)
    if (st.readerTab === 'pdf' && !sourcePdfs.length) st.readerTab = lockedSourceRefs.length ? 'context' : 'task';
    if (st.readerTab === 'context' && !lockedSourceRefs.length) st.readerTab = sourcePdfs.length ? 'pdf' : 'task';
    if (st.readerTab === 'ref') st.readerTab = 'task';

    const autoNeedsSplit = needsSplitByContent(q, st);
    const preferredSplit = uiPrefs.preferredLayout !== 'focus';
    const isSplit = autoNeedsSplit
      ? true
      : st.layoutOverride === 'split'
      ? true
      : st.layoutOverride === 'foveal'
      ? false
      : preferredSplit;

    const canOpenReference = !isBlindUnfinished && Boolean(q.obsidianLink?.file ||
      activeRun.courseMeta.obsidian?.mainReference || activeRun.courseMeta.obsidian?.workedExamples ||
      activeRun.courseMeta.obsidian?.practiceNote);
    const isTriPane = isSplit && canOpenReference && dockReferenceLayout.matches && Boolean(uiPrefs.dockRefPane);
    const refButton = document.getElementById('run-ref-btn');
    refButton.hidden = !canOpenReference;
    refButton.setAttribute('aria-expanded', String(isTriPane));
    const alButton = document.getElementById('run-al-btn');
    alButton.hidden = isBlindUnfinished;
    alButton.setAttribute('aria-expanded', String(Boolean(window.StudyAiTutor?.isOpen?.())));

    document.body.classList.toggle('runner-split-wide', isSplit);
    document.body.classList.toggle('runner-split-pdf', isSplit && st.readerTab === 'pdf');
    document.body.classList.toggle('runner-split-ref', isTriPane);
    document.body.classList.toggle('runner-foveal-compact', !isSplit);

    // Preserve left-pane and reference-pane scroll positions when re-rendering the same question
    const prevLeftEl = document.querySelector('.runner-pane-left-scroll');
    const prevLeftScroll = activeRun.lastRenderedQid === q.id && prevLeftEl ? prevLeftEl.scrollTop : 0;
    const prevRefEl = document.querySelector('.runner-pane-ref-scroll');
    const prevRefScroll = activeRun.lastRenderedQid === q.id && prevRefEl ? prevRefEl.scrollTop : 0;
    activeRun.lastRenderedQid = q.id;

    // Top sticky header controls
    document.getElementById('run-header-title').textContent = `${activeRun.courseMeta.shortTitle} · ${q.title}`;
    const ptsBadge = q.points ? ` · ${q.points} pts` : '';
    document.getElementById('run-header-index').textContent = `Question ${activeRun.index + 1} of ${activeRun.questionIds.length}`;
    document.getElementById('run-header-kind').textContent = ` · ${
      hasWf ? 'Worksheet' : q.kind.toUpperCase()
    }${ptsBadge}`;
    document.getElementById('run-obsidian-app-link').href = makeObsidianDeepLink(q);

    const layoutBtn = document.getElementById('run-layout-btn');
    if (layoutBtn) {
      layoutBtn.textContent = isSplit ? 'Split' : 'Focus';
      layoutBtn.classList.toggle('active', isSplit);
      layoutBtn.title = isSplit
        ? 'Switch to Focus view (V)'
        : 'Switch to Split view (V)';
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

    renderRunnerNotice(isBlindUnfinished);

    const parType = activeRun.profile === 'exam' ? 'exam' : 'learning';
    const parRange = `${minLabel(st.minSec / 60)}–${minLabel(st.maxSec / 60)}`;
    const personalBest = rec.pbEffectiveSec ? ` · Best ${clockSec(rec.pbEffectiveSec)}` : '';
    document.getElementById('run-pace-target').title = `Adamlite · ${parType} target · Typical range ${parRange}${personalBest}`;
    document.getElementById('run-pace-par').textContent = clockSec(st.targetSec);

    // Question Body / Left Reader Content
    const contextHtml =
      (q.contextMarkdown ? `<div class="markdown-body">${renderMarkdownWithMath(q.contextMarkdown)}</div>` : '') +
      renderAssets(q.contextAssets, q.courseId, sourcesMap, isBlindUnfinished);

    const croppedArchivePdfs = sourcePdfs.filter(source => source.memberAsset && !source.isSolution &&
      window.StudyPdf.hasSavedExcerpt(source) &&
      (q.promptAssets || []).some(asset => asset.sourceId === source.sourceId && (asset.page || 1) === source.page));
    const promptAssets = (q.promptAssets || []).filter(asset => !croppedArchivePdfs.some(source =>
      asset.sourceId === source.sourceId && (asset.page || 1) === source.page));
    const promptAssetsHtml = renderAssets(promptAssets, q.courseId, sourcesMap, isBlindUnfinished);
    const svgHtml = q.svgDiagram ? `<div class="diagram-wrap" style="margin:14px 0">${q.svgDiagram}</div>` : '';
    const promptMdHtml = q.promptMarkdown
      ? `<div class="markdown-body" style="font-size:16px">${renderMarkdownWithMath(q.promptMarkdown)}</div>`
      : '';

    let readerBodyHtml = '';
    let inlinePdf = null;
    const inlineLocalMountItems = [];
    if (st.readerTab === 'pdf' && sourcePdfs.length) {
      const pdfIdx = Math.max(0, Math.min(sourcePdfs.length - 1, Number(st.selectedPdfIdx) || 0));
      const curPdf = sourcePdfs[pdfIdx];
      const memberFile = curPdf.memberAsset;
      if (curPdf.isPdf) inlinePdf = curPdf;
      const documents = new Map();
      sourcePdfs.forEach((source, index) => {
        const key = source.key.replace(/#p\d+$/, '');
        if (!documents.has(key) || index === pdfIdx) documents.set(key, index);
      });
      const selectorHtml = documents.size > 1
        ? `<select id="sel-inline-pdf" aria-label="Source document">${[...documents.values()].map((index) =>
             `<option value="${index}" ${index === pdfIdx ? 'selected' : ''}>${esc(sourcePdfs[index].title)}</option>`
           ).join('')}</select>`
        : `<strong title="${esc(curPdf.title)}">${esc(curPdf.title)}</strong>`;
      const fileActions = `<button type="button" class="mini-tool-btn ${st.invertPdfFrame ? 'active' : ''}" id="btn-invert-pdf-frame" aria-pressed="${Boolean(st.invertPdfFrame)}">Invert PDF</button>
        ${memberFile ? memberDownload(memberFile) : curPdf.localSourceKey ? `
          <button type="button" class="mini-tool-btn" data-remove-local-pdf="${esc(curPdf.localSourceKey)}">Remove local PDF</button>` : `
          <button type="button" class="mini-tool-btn" data-open-native-pdf="${esc(curPdf.openAppUrl)}">Open in PDF App</button>
          <a class="mini-tool-btn" href="${esc(curPdf.embedUrl)}" target="_blank" rel="noopener">Open in new tab ↗</a>`}`;
      readerBodyHtml = `
        <div class="inline-pdf-wrap">
          ${
            curPdf.isPdf ? `
              <div id="source-pdf-reader">${window.StudyPdf.viewer(curPdf.page, st.invertPdfFrame, selectorHtml, fileActions)}</div>`
            : `<div class="inline-pdf-toolbar">${selectorHtml}<div class="row-actions">${fileActions}</div></div>
              ${memberFile && !memberFile.mime.startsWith('image/')
                ? '<p class="muted">Download this file to open it on your device.</p>'
                : `<figure class="pdf-figure" data-pdf-excerpt="${esc(curPdf.key)}">${window.StudyPdf.toolbar()}
                  <div class="pdf-zoom-scroll pdf-figure-scroll" tabindex="0" aria-label="Scrollable source image">
                    <div class="pdf-zoom-page"><img ${memberFile ? memberPreviewAttrs(memberFile) : `src="${esc(curPdf.rawUrl)}"`} alt="${esc(curPdf.title)}"></div>
                  </div></figure>`}`
          }
        </div>
      `;
    } else if (st.readerTab === 'context' && lockedSourceRefs.length) {
      readerBodyHtml = `
        <div class="source-context-pane">
          ${renderSourceContextGate(q, lockedSourceRefs, false)}
        </div>
      `;
    } else {
      const isExamSheet = Boolean(hasWf || q.origin === 'mock_exam' || q.origin === 'original_exam');
      const cleanTitle = String(q.title || '').replace(/\s*\(\d+\s*pts?\)\s*$/i, '');
      const headerHtml = isExamSheet && q.points
        ? `<div class="exam-paper-header">
             <h2>${esc(cleanTitle)}</h2>
             <span class="exam-paper-pts">(${Number(q.points)} points in total)</span>
           </div>`
        : `<h2 style="margin-top:0">${esc(q.title)}</h2>`;
      const inlineGateRefs = lockedSourceRefs.filter((r) => r.role !== 'solution');
      const taskGateHtml = inlineGateRefs.length ? renderSourceContextGate(q, inlineGateRefs, true) : '';
      const promptPdfs = sourcePdfs.filter(source => croppedArchivePdfs.includes(source) ||
        (!promptAssetsHtml && source.role && !source.isSolution));
      // The H10 handout only lists the assigned exercises, which are already shown below.
      const hasTextbookPages = q.id === 'acct-2527:H10' && promptPdfs.some(source => source.sourceId === 'textbook-12e');
      const inlineLocalPrompt = renderInlineLocalPdfFigures(hasTextbookPages
        ? promptPdfs.filter(source => source.sourceId !== '203552')
        : promptPdfs);
      if (inlineLocalPrompt.mountItems.length) inlineLocalMountItems.push(...inlineLocalPrompt.mountItems);
      readerBodyHtml = `
        <div class="${isExamSheet ? 'exam-paper-sheet' : ''}">
          ${headerHtml}
          ${contextHtml}
          ${promptAssetsHtml}
          ${inlineLocalPrompt.html}
          ${svgHtml}
          ${promptMdHtml}
          ${taskGateHtml}
        </div>
      `;
    }

    const firstLockedLbl = lockedSourceRefs[0]?.kind === 'book'
      ? `Book PDF (p.${lockedSourceRefs[0].page || 1})`
      : 'Source Context';
    const readerTabBarHtml = `
      <div class="reader-tabbar">
        <div class="reader-tabs" role="tablist" aria-label="Task & Source Reader">
          <button type="button" class="reader-tab-btn ${st.readerTab === 'task' ? 'active' : ''}" data-reader-tab="task">Task</button>
          ${
            sourcePdfs.length
              ? `<button type="button" class="reader-tab-btn ${st.readerTab === 'pdf' ? 'active' : ''}" data-reader-tab="pdf">Source ${sourcePdfs[0].isPdf ? 'PDF' : 'file'}</button>`
              : lockedSourceRefs.length
              ? `<button type="button" class="reader-tab-btn ${st.readerTab === 'context' ? 'active' : ''}" data-reader-tab="context">${esc(firstLockedLbl)}</button>`
              : ''
          }
        </div>
        <div class="reader-tools">
          ${
            isSplit && !isTriPane
              ? `
                <button type="button" class="mini-tool-btn ${splitRatio === 'wide-left' ? 'active' : ''}" data-split-ratio="wide-left" title="Wider task pane">Wide Task</button>
                <button type="button" class="mini-tool-btn ${splitRatio === 'balanced' ? 'active' : ''}" data-split-ratio="balanced" title="Balanced 50/50 Split">50/50</button>
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
    const nextFullLbl = `${hasMoreQuestions ? 'Next Question →' : 'Finish Run'}<span data-study-help> (N)</span>`;
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

      const solLockedRefs = lockedSourceRefs.filter((r) => r.role === 'solution' || r.isSolution);
      const solGateHtml = solLockedRefs.length ? renderSourceContextGate(q, solLockedRefs, true) : '';
      const localSolPdfs = !solAssets
        ? sourcePdfs.filter((p) => p.role && p.isSolution)
        : [];
      const inlineLocalSol = renderInlineLocalPdfFigures(localSolPdfs);
      if (inlineLocalSol.mountItems.length) inlineLocalMountItems.push(...inlineLocalSol.mountItems);
      solutionHtml = `
        <section class="solution-panel" id="solution-box">
          <div class="row-between" style="margin:0 0 10px;gap:8px">
            <h3 style="margin:0">Worked Solution</h3>
            ${topQuickActionsHtml}
          </div>
          ${solAssets}
          ${inlineLocalSol.html}
          ${solGateHtml}
          <div class="markdown-body">${renderMarkdownWithMath(q.solutionMarkdown || '')}</div>
          ${pitfallHtml}
          ${verificationHtml}
          ${difficultyRateHtml}
        </section>
      `;
    }

    const questionTopic = activeRun.bank.topics?.find((topic) => String(topic.id) === String(q.topicId));
    const questionCollection = activeRun.bank.collections?.find((collection) => collection.id === q.collectionId);
    const instantMcqToggleHtml =
      !isBlindUnfinished && q.kind === 'mcq'
        ? `<button type="button" class="runner-menu-item ${instantMcq ? 'active' : ''}" id="btn-toggle-instant-mcq" title="Check MCQs in 1 tap">
             <span>1-Tap MCQ Check</span>
             <small>${instantMcq ? 'ON' : 'Off'}</small>
           </button>`
        : '';

    const toolsMenuHtml = isBlindUnfinished
      ? `<details class="runner-tools-menu">
           <summary class="st-btn runner-more-btn" title="Question tools" aria-label="More question tools">•••</summary>
           <div class="runner-tools-popover">
             <button type="button" class="runner-menu-item" id="btn-copy-for-ai"><span>Copy for Al</span></button>
           </div>
         </details>`
      : `<details class="runner-tools-menu">
           <summary class="st-btn runner-more-btn" title="Question tools" aria-label="More question tools">•••</summary>
           <div class="runner-tools-popover">
             <button type="button" class="runner-menu-item" id="btn-copy-for-ai"><span>Copy for Al</span></button>
             <button type="button" class="runner-menu-item" id="btn-open-tutor"><span>Desktop MCP Tutor</span></button>
             ${instantMcqToggleHtml}
             <div class="runner-menu-divider"></div>
             <label class="runner-menu-select-row">
               <span>Status</span>
               <select id="sel-card-status" class="st-select st-select-${esc(status)}" aria-label="Task status">
                 <option value="not_started" ${status === 'not_started' ? 'selected' : ''}>Uncomplete</option>
                 <option value="in_progress" ${status === 'in_progress' ? 'selected' : ''}>In Progress</option>
                 <option value="done" ${status === 'done' ? 'selected' : ''}>Done</option>
                 <option value="revisit" ${status === 'revisit' ? 'selected' : ''}>Revisit</option>
               </select>
             </label>
             <button type="button" class="runner-menu-item" id="btn-retry-fresh"><span>Retry fresh</span></button>
           </div>
         </details>`;

    const customTask = window.StudyProvenance?.describe(q, activeRun.bank).synthetic
      ? `<span class="runner-custom-task" role="img" aria-label="Custom practice task" title="Custom practice task">
           <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <path d="m9 4 3 3m-8 4 1-3 6.2-6.2a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4L8 11l-4 1Zm-1 2h10"/>
           </svg>
         </span>`
      : '';
    const statusBarHtml = `
      <div class="runner-card-meta-bar">
        <div class="runner-meta-crumb" ${questionCollection ? `title="${esc(examLabel(questionCollection.title))}"` : ''}>
          ${customTask}
          <span class="runner-topic-label">${esc(questionTopic?.title || 'Topic ' + q.topicId)}</span>
        </div>
        <div class="runner-meta-actions" role="group" aria-label="Question actions">
          ${
            isBlindUnfinished
              ? `<button type="button" class="st-btn runner-pill-tool ${st.flagged ? 'active-revisit' : ''}" id="btn-flag-exam" title="Flag question for review (F)">
                   ${st.flagged ? 'Flagged' : 'Flag'}
                 </button>`
              : `<button type="button" class="st-btn runner-pill-tool ${status === 'revisit' ? 'active-revisit' : ''}" data-set-status="revisit" title="Flag for Revisit (F)">${status === 'revisit' ? 'Flagged' : 'Flag'}</button>`
          }
          ${toolsMenuHtml}
        </div>
      </div>
    `;

    // Primary Action Button
    const canHint = activeRun.mode !== 'exam' && st.hintsUsed < hintsArr.length && !st.revealed;
    let primaryActionBtn = '';
    if (isBlindUnfinished) {
      primaryActionBtn = hasMoreQuestions
        ? `<button type="button" class="primary-btn" id="btn-next-q">Save &amp; Next →<span data-study-help> (N)</span></button>`
        : `<button type="button" class="primary-btn" id="btn-submit-paper-bottom">Submit Paper</button>`;
    } else if (q.kind === 'mcq') {
      primaryActionBtn = !st.revealed
        ? `<button type="button" class="primary-btn" id="btn-check-mcq" ${st.choice === null ? 'disabled' : ''}>Check Answer</button>`
        : `<button type="button" class="primary-btn" id="btn-next-q">${nextFullLbl}</button>`;
    } else if (hasWf) {
      primaryActionBtn = !st.revealed
        ? `<button type="button" class="primary-btn" id="btn-check-wf">Check Answers</button>`
        : `<button type="button" class="primary-btn" id="btn-next-q">${nextFullLbl}</button>`;
    } else {
      primaryActionBtn = !st.revealed
        ? `<button type="button" class="primary-btn" id="btn-reveal-sol" title="Shortcut: S or Cmd/Ctrl+Enter">Reveal Solution</button>`
        : `<button type="button" class="primary-btn btn-got-it-next" title="Confirm 100% right &amp; jump to next question (Shortcut: G)">✓ Got It &amp; ${nextShortLbl}</button>`;
    }

    const secondaryNextBtn =
      !isBlindUnfinished && st.revealed && q.kind !== 'mcq' && !hasWf
        ? `<button type="button" class="ghost-btn" id="btn-next-q" title="Advance to next question (Shortcut: N or Enter)">${nextShortLbl}</button>`
        : '';

    const fovealActionBarHtml = `
      <div class="foveal-action-bar">
        <div class="row-actions" style="gap:7px">
          ${primaryActionBtn}
          ${secondaryNextBtn}
          ${canHint ? `<button type="button" class="ghost-btn" id="btn-hint" title="Show hint (H)" data-study-help>Hint ${st.hintsUsed + 1}/${hintsArr.length}</button>` : ''}
          ${
            !isBlindUnfinished && !st.revealed && (q.kind === 'mcq' || hasWf)
              ? `<button type="button" class="ghost-btn" id="btn-reveal-sol" title="Reveal worked solution (S)" data-study-help>Solution</button>`
              : ''
          }
        </div>
        <div class="row-actions" style="gap:6px">
          <button type="button" class="ghost-btn" id="btn-prev-q" ${activeRun.index === 0 ? 'disabled' : ''}>← Prev</button>
          ${
            !isSplit && sourcePdfs.length
              ? `<button type="button" class="ghost-btn" id="btn-bottom-pdf" title="Open embedded Source PDF side-by-side">PDF</button>`
              : !isSplit && lockedSourceRefs.length
              ? `<button type="button" class="ghost-btn" id="btn-bottom-context" title="Open Source Context (Sync BI Canvas or Drop PDF)">Source</button>`
              : ''
          }
          <button type="button" class="ghost-btn" id="btn-end-run">${isBlindUnfinished ? 'Submit…' : 'End Run'}</button>
        </div>
      </div>
    `;

    const kbdBarHtml =
      st.revealed && !isBlindUnfinished
        ? `
      <div class="kbd-hint-bar" data-study-help>
        ${q.kind !== 'mcq' && !hasWf ? '<span><kbd>G</kbd> Got It (100%) &amp; Next</span><span><kbd>X</kbd> Revisit &amp; Next</span>' : ''}
        <span><kbd>N</kbd>/<kbd>Enter</kbd> Next Question</span>
        <span><kbd>V</kbd> Focus/Split</span>
        <span><kbd>←</kbd><kbd>→</kbd> Nav</span>
      </div>
    `
        : `
      <div class="kbd-hint-bar" data-study-help>
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
    if (isSplit && isTriPane) {
      const savedTri = Array.isArray(uiPrefs.triWidths) && uiPrefs.triWidths.length === 3
        ? uiPrefs.triWidths.map(Number)
        : [38, 30, 32];
      const wTask = Math.max(22, Math.min(54, savedTri[0] || 38));
      const wRef = Math.max(20, Math.min(48, savedTri[1] || 30));
      const wAns = Math.max(22, 100 - wTask - wRef);
      const dockedRefHtml = buildInlineRefHtml(st);
      card.innerHTML = `
        <div class="runner-split-grid is-tri-pane" style="--task-share:${wTask}fr;--ref-share:${wRef}fr;--answer-share:${wAns}fr">
          <aside class="runner-pane-ref" aria-label="Course reference">
            ${dockedRefHtml}
          </aside>
          <div class="runner-divider" data-divider-slot="left" role="separator" aria-label="Resize reference pane" aria-orientation="vertical"
              aria-valuemin="20" aria-valuemax="${78 - wAns}" aria-valuenow="${wRef}" tabindex="0"></div>
          <div class="runner-pane-left">
            ${readerTabBarHtml}
            <div class="runner-pane-left-scroll">
              ${readerBodyHtml}
            </div>
          </div>
          <div class="runner-divider" data-divider-slot="right" role="separator" aria-label="Resize task and answer panes" aria-orientation="vertical"
              aria-valuemin="22" aria-valuemax="${78 - wRef}" aria-valuenow="${wTask}" tabindex="0"></div>
          <div class="runner-pane-right">
            ${statusBarHtml}
            <div id="stall-nudge-banner" class="hint-box stall-banner" data-study-help hidden></div>
            ${workspaceHtml}
            ${fovealActionBarHtml}
            ${hintsHtml}
            ${solutionHtml}
            ${kbdBarHtml}
          </div>
        </div>
      `;
    } else if (isSplit) {
      const initialWidth = splitRatio === 'custom'
        ? Math.max(32, Math.min(68, Number(uiPrefs.splitWidth) || 62))
        : splitRatio === 'balanced' ? 50 : 62;
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
            <div id="stall-nudge-banner" class="hint-box stall-banner" data-study-help hidden></div>
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
        <div class="foveal-prompt-block">
          ${readerBodyHtml}
        </div>
        <div id="stall-nudge-banner" class="hint-box stall-banner" data-study-help hidden></div>
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
    const newRefEl = document.querySelector('.runner-pane-ref-scroll');
    if (newRefEl && prevRefScroll > 0) {
      newRefEl.scrollTop = prevRefScroll;
    }
    if (isTriPane && !st.inlineRefData && !st.inlineRefLoading) {
      ensureInlineRefLoaded(q, st).then(() => {
        if (activeRun && currentQuestion()?.id === q.id) renderRunner();
      });
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
    if (q.extraReference) {
      promptSourceKeys.add(resolveSourceEntry({ canvasPath: q.extraReference.path }, q.extraReference.page)?.key);
    }
    window.StudyQuestionCopy.bind(card, {
      question: q, state: st, course: activeRun.courseMeta.title, topic: questionTopic?.title,
      courseId: activeRun.courseMeta.courseId, blind: isBlindUnfinished,
      noteFile: q.obsidianLink?.file || activeRun.courseMeta.obsidian?.mainReference,
      revealed: st.revealed && !isBlindUnfinished,
      sources: sourcePdfs.filter((source) => source.isPdf && (
        promptSourceKeys.has(source.key) || (source.role && !source.isSolution)
      )),
    });
    card.querySelector('#btn-open-tutor')?.addEventListener('click', window.StudyTutor.open);
    if (inlinePdf) {
      const view = st.pdfViews[inlinePdf.key.replace(/#p\d+$/, '')] ||= { page: inlinePdf.page, zoom: 100, trim: true };
      window.StudyPdf.mount(card.querySelector('#source-pdf-reader'), inlinePdf, view);
    } else if (inlineLocalMountItems.length) {
      window.StudyPdf.mountInlineFigures(card, inlineLocalMountItems, st.pdfViews);
    } else {
      window.StudyPdf.disposeInline?.();
    }
    if (!isBlindUnfinished && lockedSourceRefs.length) {
      maybeAutoFetchCanvasSources(q, lockedSourceRefs);
    }
    tickLiveClocks();
  }

  function bindQuestionCardEvents(q, st, sourcePdfs = []) {
    const isBlindUnfinished = activeRun.examStyle === 'blind' && !activeRun.paperSubmitted;
    const card = document.getElementById('runner-question-card');
    window.StudyMembers?.fillPreviews(card);
    window.StudyMembers?.bindDownloads(card);
    card.querySelectorAll('[data-reader-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        st.readerTab = btn.dataset.readerTab;
        renderRunner();
      });
    });

    // Quick figure "📄 In-App PDF" button -> jumps directly to that PDF & page in Left Pane!
    document.querySelectorAll('[data-open-inline-pdf]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const key = btn.dataset.openInlinePdf;
        const foundIdx = sourcePdfs.findIndex((p) => p.key === key);
        if (foundIdx >= 0) {
          st.selectedPdfIdx = foundIdx;
          const view = st.pdfViews[key.replace(/#p\d+$/, '')];
          if (view) view.page = sourcePdfs[foundIdx].page;
        }
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
      event.currentTarget.setAttribute('aria-pressed', String(st.invertPdfFrame));
      document.querySelector('.pdf-document-scroll')?.classList.toggle('pdf-ink-inverted', st.invertPdfFrame);
    });

    document.getElementById('btn-bottom-pdf')?.addEventListener('click', () => {
      st.readerTab = st.readerTab === 'pdf' ? 'task' : 'pdf';
      if (st.readerTab === 'pdf') st.layoutOverride = null; // Auto-expand into side-by-side split for PDF reading
      renderRunner();
    });

    document.getElementById('btn-bottom-context')?.addEventListener('click', () => {
      st.readerTab = st.readerTab === 'context' ? 'task' : 'context';
      if (st.readerTab === 'context') st.layoutOverride = null;
      renderRunner();
    });

    // Local BYOC PDF drop / upload handlers (100% browser-private IndexedDB)
    const handleLocalPdfAttach = async (file, el) => {
      if (!file || !window.StudyLocalSources) return;
      const cid = el.dataset.courseId || q.courseId;
      const sid = el.dataset.sourceId || '';
      const kind = el.dataset.sourceKind || 'canvas';
      const title = el.dataset.sourceTitle || file.name;
      const targetPage = Math.max(1, Number(el.dataset.sourcePage) || 1);
      try {
        await window.StudyLocalSources.save(cid, sid, file, { kind, title });
        // Stay on Task tab so the exact prompt pages pop up right above the question automatically
        if (st.readerTab === 'context') st.readerTab = 'task';
        st.selectedPdfIdx = 0;
        st.layoutOverride = null;
        toast(`Saved "${file.name}" privately in this browser · p. ${targetPage} ready inline`);
        renderRunner();
      } catch (err) {
        toast(err.message || 'Could not save PDF locally.');
      }
    };

    card.querySelectorAll('[data-local-pdf-input]').forEach((inp) => {
      inp.addEventListener('change', async () => {
        const file = inp.files?.[0];
        if (file) await handleLocalPdfAttach(file, inp);
        inp.value = '';
      });
    });

    card.querySelectorAll('[data-local-dropzone]').forEach((zone) => {
      zone.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        zone.classList.add('is-dragover');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'));
      zone.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        zone.classList.remove('is-dragover');
        const file = ev.dataTransfer?.files?.[0];
        if (file) await handleLocalPdfAttach(file, zone);
      });
    });

    card.querySelectorAll('[data-remove-local-pdf]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.removeLocalPdf;
        if (!key || !window.StudyLocalSources) return;
        await window.StudyLocalSources.remove(key);
        st.readerTab = 'task';
        toast('Removed local PDF copy from this browser.');
        renderRunner();
      });
    });

    card.querySelectorAll('[data-open-bi-sync]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.StudyApp?.openBiSyncHub?.();
      });
    });

    card.querySelectorAll('[data-open-member-unlock]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('btn-member-library')?.click();
      });
    });

    card.querySelectorAll('[data-fetch-canvas-pdf]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const origText = btn.textContent;
        const fetchKey = `${btn.dataset.canvasCourse}:${btn.dataset.canvasFile}`;
        autoCanvasFetchFailed.delete(fetchKey);
        btn.disabled = true;
        btn.textContent = 'Loading PDF…';
        try {
          let origin = 'https://canvas.bi.no';
          try { if (btn.dataset.canvasUrl) origin = new URL(btn.dataset.canvasUrl).origin; } catch {}
          const file = await window.StudyApp.fetchCanvasPdfViaExtension(
            btn.dataset.canvasCourse,
            btn.dataset.canvasFile,
            origin
          );
          await handleLocalPdfAttach(file, btn);
        } catch (err) {
          autoCanvasFetchFailed.set(fetchKey, err?.message || 'Could not load PDF from BI Canvas.');
          toast(err?.message || 'Could not load PDF from BI Canvas.');
          btn.disabled = false;
          btn.textContent = origText;
        }
      });
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
    card.querySelector('[data-toggle-ref-pane]')?.addEventListener('click', toggleRunnerReference);

    const triGrid = card.querySelector('.runner-split-grid.is-tri-pane');
    if (triGrid) {
      const leftDiv = triGrid.querySelector('[data-divider-slot="left"]');
      const rightDiv = triGrid.querySelector('[data-divider-slot="right"]');
      const readShares = () => {
        const t = parseFloat(triGrid.style.getPropertyValue('--task-share')) || 38;
        const r = parseFloat(triGrid.style.getPropertyValue('--ref-share')) || 30;
        const a = parseFloat(triGrid.style.getPropertyValue('--answer-share')) || 32;
        return [t, r, a];
      };
      const applyTri = (t, r, a) => {
        const rt = Math.round(t);
        const rr = Math.round(r);
        const ra = Math.max(20, 100 - rt - rr);
        triGrid.style.setProperty('--task-share', rt + 'fr');
        triGrid.style.setProperty('--ref-share', rr + 'fr');
        triGrid.style.setProperty('--answer-share', ra + 'fr');
        leftDiv?.setAttribute('aria-valuenow', rr);
        leftDiv?.setAttribute('aria-valuemax', 78 - ra);
        rightDiv?.setAttribute('aria-valuenow', rt);
        rightDiv?.setAttribute('aria-valuemax', 78 - rr);
        return [rt, rr, ra];
      };
      const bindTriDiv = (div, slot) => {
        if (!div) return;
        div.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          div.setPointerCapture(ev.pointerId);
        });
        div.addEventListener('pointermove', (ev) => {
          if (!div.hasPointerCapture(ev.pointerId)) return;
          const rect = triGrid.getBoundingClientRect();
          const pct = (100 * (ev.clientX - rect.left)) / rect.width;
          const [, r, a] = readShares();
          if (slot === 'left') {
            const nextR = Math.max(20, Math.min(78 - a, pct));
            applyTri(100 - a - nextR, nextR, a);
          } else {
            const nextT = Math.max(22, Math.min(78 - r, pct - r));
            applyTri(nextT, r, 100 - r - nextT);
          }
        });
        div.addEventListener('lostpointercapture', () => {
          saveRunnerUiPrefs({ triWidths: readShares().map(Math.round) });
        });
        div.addEventListener('keydown', (ev) => {
          if (!['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
          ev.preventDefault();
          ev.stopPropagation();
          const delta = ev.key === 'ArrowLeft' ? -3 : 3;
          const [t, r, a] = readShares();
          if (slot === 'left') {
            const nextR = Math.max(20, Math.min(78 - a, r + delta));
            applyTri(100 - a - nextR, nextR, a);
          } else {
            const nextT = Math.max(22, Math.min(78 - r, t + delta));
            applyTri(nextT, r, 100 - r - nextT);
          }
          saveRunnerUiPrefs({ triWidths: readShares().map(Math.round) });
        });
      };
      bindTriDiv(leftDiv, 'left');
      bindTriDiv(rightDiv, 'right');
    } else {
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
        if (ev.currentTarget) ev.currentTarget.textContent = 'Confirm Reveal';
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
    const run = activeRun;
    closePauseRecord(st, 1.5);
    const dlpfcTier = window.StudyApp.effectiveDlpfc?.(q)?.tier || Number(q.dlpfcBase || 2);
    const autoGraded = Boolean(q.kind === 'mcq' || (Array.isArray(q.wiseflowFields) && q.wiseflowFields.length) || q.numericCheck);
    pendingSaves += 1;
    const res = await window.StudyApp.logAttempt({
      sessionId: run.sessionId,
      courseId: q.courseId,
      questionId: q.id,
      topicId: q.topicId,
      kind: q.kind,
      autoGraded,
      dlpfcTier,
      profile: run.profile,
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
    }).finally(() => { pendingSaves -= 1; });
    run.consecutiveMisses = qualityAccuracy < 0.6 ? (run.consecutiveMisses || 0) + 1 : 0;
    if (res?.attempt) {
      st.loggedAttempt = res.attempt;
      run.completedAttempts[q.id] = res.attempt;
    }
  }

  function updateRunnerPace(st, activeSec, finished) {
    const pace = document.getElementById('runner-pace');
    const button = document.getElementById('run-live-pill');
    const you = document.getElementById('run-pace-you');
    const status = document.getElementById('run-pace-status');
    const hintTime = st.hintsUsed * st.handicapPerHintSec;
    const elapsed = st.loggedAttempt?.effectiveSec ?? activeSec + hintTime;
    const elapsedLabel = clockSec(Math.floor(elapsed));
    const remaining = st.targetSec - elapsed;
    const devPaused = devMode.isActive();
    const paused = st.runningSince === null && !finished;
    let tone = 'running';
    let message = `${clockSec(Math.ceil(remaining))} left`;
    if (st.loggedAttempt?.beatAi) {
      tone = 'beat';
      message = 'Target beaten';
    } else if (remaining <= 0) {
      tone = 'overtime';
      const overtime = Math.floor(-remaining);
      message = overtime ? `${clockSec(overtime)} over` : 'Target reached';
    } else if (finished) {
      tone = 'review';
      message = 'Review';
    } else if (remaining <= Math.min(30, st.targetSec * 0.08)) {
      tone = 'urgent';
    } else if (remaining <= Math.min(120, st.targetSec * 0.2)) {
      tone = 'near';
    }

    if (paused) message = `${devPaused ? 'Dev paused' : 'Paused'} · ${message}`;
    const action = st.pauseActive ? 'Resume question timer' : 'Pause question timer';
    const buttonLabel = finished ? 'Your final time' : devPaused ? 'Timer paused for Dev Mode' : action;
    const hintLabel = hintTime ? ` · Includes ${clockSec(hintTime)} for hints` : '';
    const buttonTitle = (finished || devPaused ? buttonLabel : `${buttonLabel} (P)`) + hintLabel;
    button.disabled = finished || devPaused;
    if (button.getAttribute('aria-label') !== buttonLabel) button.setAttribute('aria-label', buttonLabel);
    if (button.title !== buttonTitle) button.title = buttonTitle;
    if (you.textContent !== elapsedLabel) you.textContent = elapsedLabel;
    if (status.textContent !== message) status.textContent = message;
    if (pace.dataset.tone !== tone) pace.dataset.tone = tone;
    pace.toggleAttribute('data-paused', paused);
    const progress = Math.min(1, elapsed / st.targetSec);
    pace.style.setProperty('--pace-position', `${(progress * 100).toFixed(2)}%`);
  }

  function tickLiveClocks() {
    if (!activeRun || document.getElementById('view-runner').hidden) return;
    const q = currentQuestion();
    if (!q) return;
    const st = itemState(q.id);
    const activeSec = itemActiveSec(st);
    const isBlindUnfinished = activeRun.examStyle === 'blind' && !activeRun.paperSubmitted;
    updateRunnerPace(st, activeSec, st.revealed && !isBlindUnfinished);

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
  }

  const CHECKIN_MIN_ACTIVE_SEC = 45 * 60; // Only ask for session feedback on long 45m+ study blocks or full submitted exams

  function openEndRunModal() {
    if (!activeRun) return;
    pauseCurrentTimer();
    const m = computeRunSummary();
    const isSubmittedExam = activeRun.mode === 'exam' && Boolean(activeRun.paperSubmitted);
    const shouldPromptFeedback = isSubmittedExam || m.activeSec >= CHECKIN_MIN_ACTIVE_SEC;
    if (!shouldPromptFeedback) {
      finalizeSession(false);
      return;
    }
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
        <div class="metric-tile"><small>Beat Al</small><b>${m.beatCount} / ${m.reviewed || 0}</b></div>
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
    const sandbox = devMode.isActive();
    pendingSaves += 1;
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
    }).finally(() => { pendingSaves -= 1; });

    document.getElementById('checkin-modal').hidden = true;
    if (document.getElementById('checkin-note')) document.getElementById('checkin-note').value = '';
    clearInterval(tickInterval);
    activeRun = null;
    document.body.classList.remove('runner-split-wide', 'runner-split-pdf', 'runner-split-ref', 'runner-foveal-compact');
    document.getElementById('runner-header').hidden = true;
    document.getElementById('global-header').hidden = false;
    const obsLink = document.getElementById('run-obsidian-app-link');
    if (obsLink) obsLink.hidden = true;
    const summaryToast = m.reviewed
      ? `Saved · ${m.reviewed}/${m.total} verified${m.avgAcc != null ? ` · ${Math.round(m.avgAcc * 100)}%` : ''} (${clockSec(m.activeSec)})`
      : 'Session saved.';
    toast(sandbox ? 'Dev run ended.' : includeCheckIn ? 'Check-in & session logged.' : summaryToast);
    await window.StudyApp.refreshBootstrap();
    window.StudyApp.navigate(wasExam ? 'exams' : 'home');
  }

  function exitRunnerKeepPaused() {
    pauseCurrentTimer();
    window.StudyPdf.dispose();
    document.body.classList.remove('runner-split-wide', 'runner-split-pdf', 'runner-split-ref', 'runner-foveal-compact');
    document.getElementById('runner-header').hidden = true;
    document.getElementById('global-header').hidden = false;
    const obsLink = document.getElementById('run-obsidian-app-link');
    if (obsLink) obsLink.hidden = true;
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

  function onDevModeChange(enabled) {
    const runnerOpen = !document.getElementById('view-runner').hidden;
    const now = Date.now();
    clearTimeout(blurTimer);
    clearInterval(tickInterval);
    tickInterval = null;
    if (enabled && activeRun) {
      const wasRunning = activeRun.items[currentQuestion().id]?.runningSince != null;
      pauseCurrentTimer(now);
      parkedRun = { run: activeRun, pausedAt: now, runnerOpen, wasRunning };
      // Practice in a copy so hints, answers and test scores stay out of the real run.
      activeRun = {
        ...activeRun,
        questionIds: [...activeRun.questionIds],
        items: structuredClone(activeRun.items),
        completedAttempts: { ...activeRun.completedAttempts },
      };
    } else if (!enabled) {
      const parked = parkedRun;
      parkedRun = null;
      activeRun = parked?.run ?? null;
      if (activeRun) {
        const pausedMs = Math.max(0, now - parked.pausedAt);
        activeRun.startedAtMs += pausedMs;
        for (const item of Object.values(activeRun.items)) {
          if (item.pauseActive) item.pauseActive.excludedMs = (item.pauseActive.excludedMs || 0) + pausedMs;
        }
      }
      if (runnerOpen && !parked?.runnerOpen) exitRunnerKeepPaused();
      else if (runnerOpen && parked?.wasRunning) resumeCurrentTimer();
    }
    if (activeRun) {
      if (!document.getElementById('view-runner').hidden) renderRunner();
      tickInterval = setInterval(tickLiveClocks, 250);
    }
  }

  function toggleSplitWorkspace() {
    if (!activeRun) return;
    const q = currentQuestion();
    if (!q) return;
    const st = itemState(q.id);
    const curSplit = document.body.classList.contains('runner-split-wide');
    const nextSplit = !curSplit;
    if (!nextSplit && st.readerTab === 'pdf') {
      st.readerTab = 'task';
    }
    st.layoutOverride = nextSplit ? 'split' : 'foveal';
    saveRunnerUiPrefs({ preferredLayout: nextSplit ? 'split' : 'focus' });
    toast(nextSplit ? 'Split view' : 'Focus view');
    renderRunner();
  }

  function toggleRunnerReference() {
    const q = currentQuestion();
    const refButton = document.getElementById('run-ref-btn');
    if (!q || refButton.hidden) return;
    const docked = refButton.getAttribute('aria-expanded') === 'true';
    if (!dockReferenceLayout.matches) {
      if (!document.getElementById('ref-drawer').hidden) {
        window.StudyUI.closeReferenceDrawer();
        return;
      }
      openReferenceDrawer(activeRun.courseMeta, q.obsidianLink?.file || '', q.obsidianLink?.heading || '');
      refButton.setAttribute('aria-expanded', 'true');
      return;
    }
    saveRunnerUiPrefs({ dockRefPane: !docked });
    if (!docked) itemState(q.id).layoutOverride = 'split';
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
    document.getElementById('run-ref-btn').addEventListener('click', toggleRunnerReference);
    document.getElementById('run-al-btn').addEventListener('click', () => window.StudyAiTutor?.toggle?.());
    dockReferenceLayout.addEventListener('change', () => {
      if (!runnerHeader.hidden) renderRunner();
    });
    document.getElementById('run-submit-exam-btn')?.addEventListener('click', () => promptSubmitFullExam());
    document.getElementById('run-live-pill')?.addEventListener('click', toggleManualPause);
    document.addEventListener('click', (ev) => {
      document.querySelectorAll('.runner-tools-menu[open]').forEach((menu) => {
        if (!menu.contains(ev.target) || ev.target.closest('.runner-menu-item')) {
          menu.open = false;
        }
      });
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
      if (document.querySelector('dialog[open]')) return;
      if (!activeRun || document.getElementById('view-runner').hidden || !document.getElementById('checkin-modal').hidden) return;
      if (e.target?.closest?.('.pdf-zoom-scroll, .pdf-reader-bar, .pdf-zoom-tools, #ai-tutor-pane')) return;
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
      } else if (key === 't') {
        const isBlind = activeRun.examStyle === 'blind' && !activeRun.paperSubmitted;
        if (!isBlind) {
          e.preventDefault();
          window.StudyAiTutor?.toggle?.();
        }
      } else if (key === 's') {
        document.getElementById('btn-reveal-sol')?.click();
      } else if (key === 'o') {
        toggleRunnerReference();
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
    onDevModeChange,
    isSaving: () => pendingSaves > 0,
    setAutoPauseMode,
    getAutoPauseMode: () => autoPauseMode,
    toggleFullscreen,
    refreshCurrent: () => { if (activeRun) renderRunner(); },
  };
})();
