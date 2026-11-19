/* Markdown + KaTeX + Obsidian Reference Drawer utilities for Study-OS */
'use strict';

window.StudyUI = (() => {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const examLabel = (label) => String(label ?? '')
    .replace(/,\s*(?:WISEflow\s+)?±2%\s+auto-graded/gi, '')
    .replace(/\s+FLOWmulti\s*±2%/gi, '');

  function clockSec(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function minLabel(min) {
    const v = Number(min) || 0;
    return Number.isInteger(v) ? `${v}m` : `${v.toFixed(1)}m`;
  }

  function renderMarkdownWithMath(rawMd) {
    const text = String(rawMd || '').trim();
    if (!text) return '';

    // 1. Protect display $$...$$ and inline $...$ math tokens before Marked parses underscores/asterisks
    const mathTokens = [];
    const stash = (tex, displayMode) => {
      const idx = mathTokens.length;
      mathTokens.push({ tex, displayMode });
      return `@@MATH_TOKEN_${idx}@@`;
    };

    let safe = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stash(tex, true));
    safe = safe.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => stash(tex, true));
    safe = safe.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => stash(tex, false));
    safe = safe.replace(/(^|[^\\$])\$([^\n$]+?)\$/g, (m, pre, tex) => {
      if (/^\s|\s$/.test(tex) && !/[\\^_{}=+\-*/]/.test(tex)) return m;
      return `${pre}${stash(tex, false)}`;
    });

    // 2. Transform Obsidian callouts `> [!info]- Title` into clean labelled blockquotes
    safe = safe.replace(/^>\s*\[!([a-zA-Z]+)\][-+]?\s*(.*)$/gm, (_, kind, title) => {
      const label = title.trim() || kind.toUpperCase();
      return `> **${label}**\n>`;
    });

    let html = window.marked ? window.marked.parse(safe, { breaks: false, gfm: true }) : `<p>${esc(safe)}</p>`;

    // 3. Render stashed math via KaTeX
    html = html.replace(/@@MATH_TOKEN_(\d+)@@/g, (_, idxStr) => {
      const item = mathTokens[Number(idxStr)];
      if (!item) return '';
      if (window.katex) {
        try {
          return window.katex.renderToString(item.tex.trim(), {
            displayMode: item.displayMode,
            throwOnError: false,
            strict: false,
          });
        } catch (err) {
          return `<code>${esc(item.tex)}</code>`;
        }
      }
      return item.displayMode ? `<pre>${esc(item.tex)}</pre>` : `<code>${esc(item.tex)}</code>`;
    });

    if (!window.StudyApp?.isStaticMode() || !html.includes('obsidian://')) return html;
    const content = document.createElement('template');
    content.innerHTML = html;
    for (const link of content.content.querySelectorAll('a[href^="obsidian://"]')) {
      const url = new URL(link.getAttribute('href'));
      const [file, ...heading] = (url.searchParams.get('file') || '').split('#');
      const target = window.StudyApp.publicReferenceUrl(file, heading.join('#'));
      if (target) {
        link.href = target;
        link.target = '_blank';
        link.rel = 'noopener';
      } else {
        const label = document.createElement('span');
        label.className = 'muted';
        label.title = 'See the original course or local archive for this source.';
        label.replaceChildren(...link.childNodes);
        link.replaceWith(label);
      }
    }
    return content.innerHTML;
  }

  let toastTimer = null;
  function toast(msg, ms = 2800) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, ms);
  }

  // Theme & PDF Dark Mode
  const THEME_KEY = 'study-os-theme-v1';
  function getThemePrefs() {
    try {
      return JSON.parse(localStorage.getItem(THEME_KEY)) || {};
    } catch {
      return {};
    }
  }

  function applyTheme(prefs = getThemePrefs()) {
    const theme = prefs.theme || (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const pdfDark = prefs.pdfDark !== undefined ? !!prefs.pdfDark : true;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.pdfDark = pdfDark ? '1' : '0';

    const darkToggle = document.getElementById('settings-dark-toggle');
    if (darkToggle) darkToggle.checked = theme === 'dark';
    const themeSub = document.getElementById('settings-theme-sub');
    if (themeSub) themeSub.textContent = theme === 'dark' ? 'Dark appearance active' : 'Light appearance active';

    const pdfToggle = document.getElementById('settings-pdf-dark-toggle');
    if (pdfToggle) pdfToggle.checked = pdfDark;
    const pdfRow = document.getElementById('settings-pdf-dark-row');
    if (pdfRow) pdfRow.classList.toggle('ios-row-muted', theme !== 'dark');
    const pdfSub = document.getElementById('settings-pdf-dark-sub');
    if (pdfSub) {
      pdfSub.textContent = theme === 'dark'
        ? 'Turns white exam excerpts dark'
        : 'Applies automatically when Dark Mode is on';
    }
  }

  function setTheme(theme) {
    const p = getThemePrefs();
    p.theme = theme === 'dark' ? 'dark' : 'light';
    if (p.pdfDark === undefined) p.pdfDark = true;
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(p));
    } catch {}
    applyTheme(p);
  }

  function setPdfDark(enabled) {
    const p = getThemePrefs();
    p.theme = document.documentElement.dataset.theme || 'dark';
    p.pdfDark = Boolean(enabled);
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(p));
    } catch {}
    applyTheme(p);
  }

  function toggleTheme() {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }

  function togglePdfDark() {
    setPdfDark(document.documentElement.dataset.pdfDark !== '1');
  }

  // Slide-Over Obsidian Reference Drawer
  let drawerNotes = [];
  let currentNoteFile = '';

  async function openReferenceDrawer(courseMeta, targetFile = '', targetHeading = '') {
    const drawer = document.getElementById('ref-drawer');
    const backdrop = document.getElementById('ref-backdrop');
    const noteSel = document.getElementById('ref-drawer-note-select');
    const tocSel = document.getElementById('ref-drawer-toc-select');
    const bodyEl = document.getElementById('ref-drawer-body');
    const titleEl = document.getElementById('ref-drawer-title');
    const uriEl = document.getElementById('ref-drawer-obsidian-uri');

    const obs = courseMeta?.obsidian || {};
    drawerNotes = [];
    if (obs.mainReference) drawerNotes.push({ label: 'Main Semester Reference', file: obs.mainReference });
    if (obs.workedExamples) drawerNotes.push({ label: 'Worked Examples', file: obs.workedExamples });
    if (obs.practiceNote) drawerNotes.push({ label: 'Vault Practice Note', file: obs.practiceNote });
    if (targetFile && !drawerNotes.some((n) => n.file === targetFile)) {
      drawerNotes.unshift({ label: targetFile.split('/').pop(), file: targetFile });
    }

    if (!drawerNotes.length) {
      toast('No Obsidian reference note configured for this course.');
      return;
    }

    currentNoteFile = targetFile || drawerNotes[0].file;
    noteSel.innerHTML = drawerNotes
      .map((n) => `<option value="${esc(n.file)}" ${n.file === currentNoteFile ? 'selected' : ''}>${esc(n.label)}</option>`)
      .join('');

    drawer.hidden = false;
    backdrop.hidden = false;
    titleEl.textContent = `${courseMeta?.shortTitle || 'Course'} · Reference`;
    bodyEl.innerHTML = '<p class="muted">Loading course note…</p>';

    await loadDrawerSection(currentNoteFile, targetHeading);

    noteSel.onchange = () => {
      currentNoteFile = noteSel.value;
      loadDrawerSection(currentNoteFile, '');
    };
    tocSel.onchange = () => {
      loadDrawerSection(currentNoteFile, tocSel.value);
    };
  }

  async function loadDrawerSection(relFile, heading) {
    const bodyEl = document.getElementById('ref-drawer-body');
    const tocSel = document.getElementById('ref-drawer-toc-select');
    const uriEl = document.getElementById('ref-drawer-obsidian-uri');
    uriEl.hidden = true;
    try {
      const data = window.StudyApp?.fetchReferenceSection
        ? await window.StudyApp.fetchReferenceSection(relFile, heading || '')
        : await (await fetch(`/api/obsidian/section?file=${encodeURIComponent(relFile)}&heading=${encodeURIComponent(heading || '')}`)).json();
      if (data.obsidianUri) {
        uriEl.href = data.obsidianUri;
        uriEl.hidden = false;
      }
      if (!data.available) {
        bodyEl.innerHTML = `<p class="muted">${esc(data.error || 'Could not read reference note.')}</p>`;
        return;
      }
      tocSel.innerHTML =
        `<option value="">— Overview / Top of Note —</option>` +
        (data.toc || [])
          .map((h) => {
            const pad = '· '.repeat(Math.max(0, h.level - 1));
            const sel = data.selectedHeading === h.title ? 'selected' : '';
            return `<option value="${esc(h.title)}" ${sel}>${pad}${esc(h.title)}</option>`;
          })
          .join('');
      bodyEl.innerHTML = renderMarkdownWithMath(data.markdown);
      bodyEl.scrollTop = 0;
    } catch (err) {
      bodyEl.innerHTML = `<p class="muted">Reference section unavailable: use "Open in Obsidian" above if running locally.</p>`;
    }
  }

  function closeReferenceDrawer() {
    document.getElementById('ref-drawer').hidden = true;
    document.getElementById('ref-backdrop').hidden = true;
  }

  function openLightbox(src, alt = '') {
    const box = document.getElementById('img-lightbox');
    const img = document.getElementById('img-lightbox-target');
    if (!box || !img || !src) return;
    img.src = src;
    img.alt = alt || 'Zoomed figure';
    box.hidden = false;
  }

  function closeLightbox() {
    const box = document.getElementById('img-lightbox');
    if (box) box.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Universal Non-Pausable 75-Minute Working Session Clock + 1:5 Recovery Break
  // ---------------------------------------------------------------------------
  const WORK_CAP_SEC = 75 * 60; // Hard 75:00 working interval cap
  const WORK_WAVE_KEY = 'study-os-work-wave-v1';
  let workTickHandle = null;

  function localDayKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatDurationShort(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const totalMin = Math.floor(s / 60);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function loadWorkState() {
    const today = localDayKey();
    const fallback = {
      dayKey: today,
      mode: 'idle', // 'idle' | 'working' | 'break'
      waveStartedAtMs: null,
      wavePausedOffsetMs: 0,
      wavePausedSinceMs: null,
      wavePauseReason: '',
      breakStartedAtMs: null,
      breakEndsAtMs: null,
      breakTotalSec: 300,
      breakBankedSec: 0,
      lastWaveSec: 0,
      dayBankedSec: 0,
      dayWaves: 0,
      dayScreenSec: 0,
      dayOffScreenSec: 0,
      dayBreaks: 0,
      dayBreakSec: 0,
      totalBreaks: 0,
      totalBreakSec: 0,
      lastBreakAtMs: 0,
      backendActiveFloorSec: 0,
      backendAwayFloorSec: 0,
    };
    try {
      const raw = JSON.parse(localStorage.getItem(WORK_WAVE_KEY));
      if (!raw || typeof raw !== 'object') return fallback;
      const st = { ...fallback, ...raw };
      const now = Date.now();
      if (st.dayKey !== today) {
        st.dayKey = today;
        st.dayBankedSec = 0;
        st.dayWaves = 0;
        st.dayScreenSec = 0;
        st.dayOffScreenSec = 0;
        st.dayBreaks = 0;
        st.dayBreakSec = 0;
        st.backendActiveFloorSec = 0;
        st.backendAwayFloorSec = 0;
      }
      // Clear stale abandoned wave if browser was closed >2.5 hours ago
      if (st.mode === 'working' && st.waveStartedAtMs && now - st.waveStartedAtMs > (WORK_CAP_SEC + 5400) * 1000) {
        st.dayBankedSec += WORK_CAP_SEC;
        st.dayWaves += 1;
        st.mode = 'idle';
        st.waveStartedAtMs = null;
      }
      if (st.mode === 'break' && st.breakEndsAtMs && now - st.breakEndsAtMs > 3600 * 1000) {
        const cap = Math.max(0, Number(st.breakTotalSec) || 300);
        const already = Math.max(0, Number(st.breakBankedSec) || 0);
        const delta = Math.max(0, cap - already);
        st.totalBreakSec = (Number(st.totalBreakSec) || 0) + delta;
        st.mode = 'idle';
        st.breakStartedAtMs = null;
        st.breakEndsAtMs = null;
        st.breakBankedSec = 0;
      }
      // Never leave a working session stuck in a non-manual focus auto-pause
      if (st.mode === 'working' && st.wavePausedSinceMs && st.wavePauseReason !== 'manual') {
        st.wavePausedOffsetMs = (Number(st.wavePausedOffsetMs) || 0) + Math.max(0, now - st.wavePausedSinceMs);
        st.wavePausedSinceMs = null;
        st.wavePauseReason = '';
      }
      return st;
    } catch {
      return fallback;
    }
  }

  let workState = loadWorkState();
  let expiredBreakShown = null;
  let lastEveningAccess = false;
  let lastScreenTickMs = Date.now();
  let lastScreenSaveMs = 0;

  function saveWorkState() {
    try {
      localStorage.setItem(WORK_WAVE_KEY, JSON.stringify(workState));
      lastScreenSaveMs = Date.now();
    } catch {}
  }

  function settleActiveBreak(now = Date.now()) {
    if (workState.mode !== 'break' || !workState.breakStartedAtMs) return;
    const elapsed = Math.max(0, Math.floor((now - workState.breakStartedAtMs) / 1000));
    const cap = Math.max(60, Number(workState.breakTotalSec) || 300);
    const capped = Math.min(elapsed, cap);
    const already = Math.max(0, Number(workState.breakBankedSec) || 0);
    const delta = Math.max(0, capped - already);
    if (delta > 0) {
      workState.totalBreakSec = (Number(workState.totalBreakSec) || 0) + delta;
      workState.dayBreakSec = (Number(workState.dayBreakSec) || 0) + delta;
      workState.breakBankedSec = already + delta;
    }
  }

  function computeBreakStats(now = Date.now()) {
    let extraSec = 0;
    if (workState.mode === 'break' && workState.breakStartedAtMs) {
      const elapsed = Math.max(0, Math.floor((now - workState.breakStartedAtMs) / 1000));
      const cap = Math.max(60, Number(workState.breakTotalSec) || 300);
      extraSec = Math.max(0, Math.min(elapsed, cap) - (Number(workState.breakBankedSec) || 0));
    }
    const totalBreaks = Math.max(0, Number(workState.totalBreaks) || 0);
    const totalBreakSec = Math.max(0, (Number(workState.totalBreakSec) || 0) + extraSec);
    const dayBreaks = Math.max(0, Number(workState.dayBreaks) || 0);
    const dayBreakSec = Math.max(0, (Number(workState.dayBreakSec) || 0) + extraSec);
    return {
      totalBreaks,
      totalBreakMinutes: Math.round(totalBreakSec / 60),
      dayBreaks,
      dayBreakMinutes: Math.round(dayBreakSec / 60),
      avgBreakMinutes: totalBreaks ? Math.round((totalBreakSec / 60 / totalBreaks) * 10) / 10 : 0,
      lastBreakAtMs: Math.max(0, Number(workState.lastBreakAtMs) || 0),
    };
  }

  function computeScreenStats(now = Date.now()) {
    const activeFloor = Math.max(
      Number(workState.backendActiveFloorSec) || 0,
      (Number(workState.dayBankedSec) || 0) + currentWaveElapsedSec(now)
    );
    const awayFloor = Number(workState.backendAwayFloorSec) || 0;
    const screenSec = Math.round(Math.max(Number(workState.dayScreenSec) || 0, activeFloor));
    const offScreenSec = Math.round(Math.max(Number(workState.dayOffScreenSec) || 0, awayFloor));
    return {
      screenSec,
      offScreenSec,
      screenLabel: formatDurationShort(screenSec),
      offScreenLabel: formatDurationShort(offScreenSec),
    };
  }

  function currentWaveElapsedSec(now = Date.now()) {
    if (workState.mode !== 'working' || !workState.waveStartedAtMs) return 0;
    const pausedMs =
      (Number(workState.wavePausedOffsetMs) || 0) +
      (workState.wavePausedSinceMs ? Math.max(0, now - workState.wavePausedSinceMs) : 0);
    return Math.min(WORK_CAP_SEC, Math.max(0, Math.floor((now - workState.waveStartedAtMs - pausedMs) / 1000)));
  }

  function recommendedWaveBreakMin(elapsedSec = currentWaveElapsedSec()) {
    return Math.max(3, Math.min(15, Math.round(elapsedSec / 300)));
  }

  const osloHour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo', hour: 'numeric', hourCycle: 'h23',
  });

  function eveningBreakAccess(now = Date.now()) {
    return Number(osloHour.format(now)) >= 20;
  }

  function showBreakModalUi() {
    const dialog = document.getElementById('break-modal');
    if (!dialog.open) dialog.showModal();
  }

  const workClock = {
    MAX_SEC: WORK_CAP_SEC,
    canUseBreakTools(now = Date.now()) {
      return eveningBreakAccess(now) || (workState.mode === 'break' && workState.breakEndsAtMs > now);
    },
    getState() {
      return {
        ...workState,
        elapsedSec: currentWaveElapsedSec(),
        recommendedBreakMin: recommendedWaveBreakMin(),
      };
    },
    ensureWorking() {
      if (workState.mode === 'working' && workState.waveStartedAtMs) {
        if (workState.wavePausedSinceMs && workState.wavePauseReason !== 'manual') {
          this.setPaused(false);
        }
        renderWorkClockDom();
        return;
      }
      workState.dayKey = localDayKey();
      workState.mode = 'working';
      workState.waveStartedAtMs = Date.now();
      workState.wavePausedOffsetMs = 0;
      workState.wavePausedSinceMs = null;
      workState.wavePauseReason = '';
      workState.breakEndsAtMs = null;
      saveWorkState();
      document.getElementById('break-modal').close();
      soundMasker.syncWithWorkMode('working');
      renderWorkClockDom();
    },
    setPaused(paused, reason = 'auto') {
      if (workState.mode !== 'working' || !workState.waveStartedAtMs) return;
      const now = Date.now();
      if (paused) {
        if (!workState.wavePausedSinceMs) {
          workState.wavePausedSinceMs = now;
          workState.wavePauseReason = reason;
          saveWorkState();
          renderWorkClockDom();
        }
      } else if (workState.wavePausedSinceMs) {
        workState.wavePausedOffsetMs =
          (Number(workState.wavePausedOffsetMs) || 0) + Math.max(0, now - workState.wavePausedSinceMs);
        workState.wavePausedSinceMs = null;
        workState.wavePauseReason = '';
        saveWorkState();
        renderWorkClockDom();
      }
    },
    triggerBreak(isAutoCap = false) {
      const now = Date.now();
      if (workState.mode === 'break') settleActiveBreak(now);
      const elapsed = workState.mode === 'working' ? (isAutoCap ? WORK_CAP_SEC : currentWaveElapsedSec(now)) : 0;
      const breakMin = isAutoCap ? 15 : recommendedWaveBreakMin(elapsed);
      if (workState.mode === 'working') {
        workState.dayBankedSec = (workState.dayBankedSec || 0) + elapsed;
        workState.dayWaves = (workState.dayWaves || 0) + 1;
        workState.lastWaveSec = elapsed;
      }
      workState.mode = 'break';
      workState.waveStartedAtMs = null;
      workState.wavePausedOffsetMs = 0;
      workState.wavePausedSinceMs = null;
      workState.wavePauseReason = '';
      workState.breakStartedAtMs = now;
      workState.breakBankedSec = 0;
      workState.breakTotalSec = breakMin * 60;
      workState.breakEndsAtMs = now + breakMin * 60 * 1000;
      workState.totalBreaks = (Number(workState.totalBreaks) || 0) + 1;
      workState.dayBreaks = (Number(workState.dayBreaks) || 0) + 1;
      workState.lastBreakAtMs = now;
      saveWorkState();
      window.StudyRunner?.onBreakStateChange?.(true);
      window.StudyCommunity?.queueStatsSync?.();
      soundMasker.syncWithWorkMode('break');
      renderWorkClockDom();
      showBreakModalUi();
    },
    startNextInterval() {
      const now = Date.now();
      settleActiveBreak(now);
      workState.dayKey = localDayKey();
      workState.mode = 'working';
      workState.waveStartedAtMs = now;
      workState.wavePausedOffsetMs = 0;
      workState.wavePausedSinceMs = null;
      workState.wavePauseReason = '';
      workState.breakStartedAtMs = null;
      workState.breakEndsAtMs = null;
      workState.breakBankedSec = 0;
      saveWorkState();
      document.getElementById('break-modal').close();
      window.StudyRunner?.onBreakStateChange?.(false);
      window.StudyCommunity?.queueStatsSync?.();
      soundMasker.syncWithWorkMode('working');
      renderWorkClockDom();
    },
    endSession() {
      const now = Date.now();
      settleActiveBreak(now);
      if (workState.mode === 'working' && workState.waveStartedAtMs) {
        const elapsed = currentWaveElapsedSec(now);
        if (elapsed >= 60) {
          workState.dayBankedSec = (workState.dayBankedSec || 0) + elapsed;
          workState.dayWaves = (workState.dayWaves || 0) + 1;
        }
      }
      workState.mode = 'idle';
      workState.waveStartedAtMs = null;
      workState.wavePausedOffsetMs = 0;
      workState.wavePausedSinceMs = null;
      workState.wavePauseReason = '';
      workState.breakStartedAtMs = null;
      workState.breakEndsAtMs = null;
      workState.breakBankedSec = 0;
      saveWorkState();
      document.getElementById('break-modal').close();
      window.StudyRunner?.onBreakStateChange?.(false, true);
      window.StudyCommunity?.queueStatsSync?.();
      soundMasker.syncWithWorkMode('idle');
      renderWorkClockDom();
    },
    addBreakSeconds(sec = 60) {
      if (workState.mode !== 'break') return;
      const now = Date.now();
      const base = Math.max(now, workState.breakEndsAtMs || now);
      workState.breakEndsAtMs = base + sec * 1000;
      workState.breakTotalSec = (workState.breakTotalSec || 300) + sec;
      if (!workState.breakStartedAtMs) workState.breakStartedAtMs = now;
      saveWorkState();
      window.StudyCommunity?.queueStatsSync?.();
      renderWorkClockDom();
    },
    syncBackendToday(todayActiveMin = 0, todayAwayMin = 0) {
      workState.backendActiveFloorSec = Math.max(
        Number(workState.backendActiveFloorSec) || 0,
        Math.round(Math.max(0, Number(todayActiveMin) || 0) * 60)
      );
      workState.backendAwayFloorSec = Math.max(
        Number(workState.backendAwayFloorSec) || 0,
        Math.round(Math.max(0, Number(todayAwayMin) || 0) * 60)
      );
      const scr = computeScreenStats();
      workState.dayScreenSec = scr.screenSec;
      workState.dayOffScreenSec = scr.offScreenSec;
      saveWorkState();
      renderWorkClockDom();
    },
    getScreenStats() {
      return computeScreenStats();
    },
    getBreakStats() {
      return computeBreakStats();
    },
  };

  function renderWorkClockDom() {
    const now = Date.now();
    const todayKey = localDayKey();
    if (workState.dayKey !== todayKey) {
      workState.dayKey = todayKey;
      workState.dayBankedSec = 0;
      workState.dayWaves = 0;
      workState.dayScreenSec = 0;
      workState.dayOffScreenSec = 0;
      workState.dayBreaks = 0;
      workState.dayBreakSec = 0;
      workState.backendActiveFloorSec = 0;
      workState.backendAwayFloorSec = 0;
    }
    if (workState.mode === 'break') settleActiveBreak(now);

    const dtMs = Math.max(0, now - lastScreenTickMs);
    lastScreenTickMs = now;
    if (dtMs > 0 && dtMs <= 60000) {
      const docFocused =
        !document.hidden && (document.hasFocus() || document.activeElement?.tagName === 'IFRAME');
      const inBreak = workState.mode === 'break';
      const isWavePaused = Boolean(workState.wavePausedSinceMs);
      if ((workState.mode === 'working' && !isWavePaused) || (docFocused && !inBreak && !isWavePaused)) {
        workState.dayScreenSec = (Number(workState.dayScreenSec) || 0) + dtMs / 1000;
      } else if (inBreak || (workState.mode === 'working' && isWavePaused)) {
        workState.dayOffScreenSec = (Number(workState.dayOffScreenSec) || 0) + dtMs / 1000;
      }
      if (now - lastScreenSaveMs >= 10000) {
        saveWorkState();
      }
    }

    // Auto-enforce 75:00 hard cap on active working time across the entire app
    if (workState.mode === 'working' && workState.waveStartedAtMs && !workState.wavePausedSinceMs) {
      if (currentWaveElapsedSec(now) >= WORK_CAP_SEC) {
        workClock.triggerBreak(true);
        return;
      }
    }

    const gPill = document.getElementById('global-work-pill');
    const gBtn = document.getElementById('global-work-action-btn');
    const rPill = document.getElementById('run-work-pill');
    const rBtn = document.getElementById('run-break-btn');
    const cdEl = document.getElementById('break-countdown-lbl');

    const scr = computeScreenStats(now);
    const homeScrEl = document.getElementById('home-screen-today-val');
    if (homeScrEl) homeScrEl.textContent = scr.screenLabel;
    const homeOffEl = document.getElementById('home-offscreen-today-val');
    if (homeOffEl) homeOffEl.textContent = scr.offScreenLabel;
    const setScrEl = document.getElementById('settings-screen-val');
    if (setScrEl) setScrEl.textContent = scr.screenLabel;

    if (workState.mode === 'working') {
      const elSec = currentWaveElapsedSec(now);
      const bMin = recommendedWaveBreakMin(elSec);
      const isPaused = Boolean(workState.wavePausedSinceMs);
      const cls = isPaused
        ? 'live-clock-pill non-interactive flow-pill-warn'
        : 'live-clock-pill non-interactive' +
          (elSec >= 65 * 60 ? ' flow-pill-warn' : elSec >= 45 * 60 ? ' flow-pill-prime' : '');
      const txt = isPaused ? `Paused ${clockSec(elSec)}` : `${clockSec(elSec)} / 75m`;
      const tip = isPaused
        ? `Session paused (${workState.wavePauseReason || 'focus away'}) — resumes on focus · Screen today: ${scr.screenLabel} · Off-screen: ${scr.offScreenLabel}`
        : `75m working interval (15m break at 75:00) · Screen today: ${scr.screenLabel} · Off-screen: ${scr.offScreenLabel}`;
      if (gPill) {
        gPill.className = cls;
        gPill.textContent = txt;
        gPill.title = tip;
      }
      if (rPill) {
        rPill.className = cls;
        rPill.textContent = txt;
        rPill.title = tip;
      }
      if (gBtn) {
        gBtn.textContent = `Break (${bMin}m)`;
        gBtn.title = `Take scaled 1:5 off-screen break (${bMin}m)`;
      }
      if (rBtn) {
        rBtn.textContent = `Break (${bMin}m)`;
      }
    } else if (workState.mode === 'break') {
      const remSec = Math.max(0, Math.ceil(((workState.breakEndsAtMs || now) - now) / 1000));
      const txt = remSec > 0 ? `Break ${clockSec(remSec)}` : 'Break ended';
      const tip = `Off-screen recovery break · Screen today: ${scr.screenLabel} · Off-screen: ${scr.offScreenLabel}`;
      if (gPill) {
        gPill.className = 'live-clock-pill non-interactive flow-pill-warn';
        gPill.textContent = txt;
        gPill.title = tip;
      }
      if (rPill) {
        rPill.className = 'live-clock-pill non-interactive flow-pill-warn';
        rPill.textContent = txt;
        rPill.title = tip;
      }
      if (gBtn) gBtn.textContent = remSec > 0 ? 'In Break' : 'Break ended';
      if (rBtn) rBtn.textContent = remSec > 0 ? 'In Break' : 'Break ended';
      if (cdEl) cdEl.textContent = remSec ? clockSec(remSec) : '00:00';
    } else {
      const cls = 'live-clock-pill non-interactive idle-work-pill';
      const txt = '0:00 / 75m';
      const tip = `Accumulated screen time today: ${scr.screenLabel} · Off-screen (breaks/away): ${scr.offScreenLabel}. Auto-starts 75m interval when you begin any run.`;
      if (gPill) {
        gPill.className = cls;
        gPill.textContent = txt;
        gPill.title = tip;
      }
      if (rPill) {
        rPill.className = cls;
        rPill.textContent = txt;
        rPill.title = tip;
      }
      if (gBtn) {
        gBtn.textContent = 'Start 75m';
        gBtn.title = tip;
      }
      if (rBtn) {
        rBtn.textContent = 'Start 75m';
      }
    }
    const evening = eveningBreakAccess(now);
    const breakDialog = document.getElementById('break-modal');
    if (!evening && lastEveningAccess && workState.mode !== 'break') {
      breakDialog.close();
    }
    if (lastEveningAccess !== evening) breakDialog.setAttribute('closedby', evening ? 'closerequest' : 'none');
    lastEveningAccess = evening;
    const canUseBreakTools = workClock.canUseBreakTools(now);
    const breakEnded = workState.mode === 'break' && !canUseBreakTools;
    const isWorking = workState.mode === 'working';
    const endSession = canUseBreakTools && workState.mode !== 'idle';
    const community = document.getElementById('break-community-btn');
    document.getElementById('evening-break-tools-btn').hidden = !evening;
    document.getElementById('break-tool-list').hidden = !canUseBreakTools;
    document.getElementById('break-footer').hidden = !(endSession || evening);
    document.getElementById('break-close-btn').hidden = !evening;
    document.getElementById('break-add-1m').hidden = evening;
    document.getElementById('break-end-session-btn').hidden = !endSession;
    document.getElementById('break-resume-btn').textContent = isWorking ? 'Continue studying' : 'Start next 75 min';
    community.hidden = !canUseBreakTools || !window.StudyCommunity?.enabled || Boolean(window.StudyRooms?.running());
    community.textContent = document.getElementById('view-community').hidden ? 'Community' : 'Back to Community';
    cdEl.hidden = evening;
    document.getElementById('break-modal-title').textContent = evening ? 'Evening break tools'
      : breakEnded ? 'Break ended' : 'Study break';
    const workedMin = Math.round((workState.lastWaveSec || 0) / 60);
    document.getElementById('break-ratio-note').textContent = evening ? 'Available until midnight Oslo time.'
      : breakEnded ? 'Add a minute to reopen break tools, or start your next session.'
      : workedMin ? `After ${workedMin} ${workedMin === 1 ? 'minute' : 'minutes'} of study.`
      : 'Take a moment before your next session.';
    document.querySelector('main').inert = breakEnded;
    document.getElementById('global-header').inert = breakEnded;
    document.getElementById('runner-header').inert = breakEnded;
    if (breakEnded && expiredBreakShown !== workState.breakEndsAtMs) {
      expiredBreakShown = workState.breakEndsAtMs;
      closeSettings();
      showBreakModalUi();
      document.getElementById('break-add-1m').focus();
    }
    window.StudyCommunity?.clockTick?.();
    window.StudyLayout?.clockTick?.();
    window.StudySets?.clockTick?.();
    window.StudyRooms?.clockTick?.();
  }

  // ---------------------------------------------------------------------------
  // Low-Fatigue Procedural Background Sound Masking (Web Audio API)
  // ---------------------------------------------------------------------------
  const SOUND_PREFS_KEY = 'study-os-sound-v1';
  const SOUND_PRESETS = {
    brown: {
      id: 'brown',
      name: 'Deep Brown',
      short: 'Brown',
      rms: 0.185,
      desc: 'Deep -6 dB/oct rumble · masks room noise with minimal ear fatigue over 75m blocks.',
    },
    speech: {
      id: 'speech',
      name: 'Speech Blocker',
      short: 'Speech',
      rms: 0.112,
      desc: 'Vocal-band contour (180 Hz–3 kHz) · blocks nearby library chatter at lower volume.',
    },
    pink: {
      id: 'pink',
      name: 'Warm Pink',
      short: 'Pink',
      rms: 0.125,
      desc: 'Balanced -3 dB/oct spectrum with smoothed highs · even full-room acoustic cover.',
    },
    rain: {
      id: 'rain',
      name: 'Soft Rain',
      short: 'Rain',
      rms: 0.122,
      desc: 'Steady filtered rainfall with slow organic breeze modulation · prevents static fatigue.',
    },
    cabin: {
      id: 'cabin',
      name: 'Cabin Hum',
      short: 'Cabin',
      rms: 0.19,
      desc: 'Low-frequency airframe cocoon · masks footsteps, doors, HVAC & desk thuds.',
    },
    gamma40: {
      id: 'gamma40',
      name: 'Brown + 40Hz',
      short: '40Hz',
      rms: 0.175,
      desc: 'Deep brown noise bed + subtle stereo 40 Hz binaural offset (best with headphones).',
    },
  };

  function loadSoundPrefs() {
    const defaults = {
      preset: 'brown',
      volume: 38,
      tone: 52,
      muteOnBreak: true,
    };
    try {
      const raw = JSON.parse(localStorage.getItem(SOUND_PREFS_KEY));
      if (!raw || typeof raw !== 'object') return defaults;
      return {
        preset: SOUND_PRESETS[raw.preset] ? raw.preset : 'brown',
        volume: Math.max(0, Math.min(100, Number(raw.volume ?? 38))),
        tone: Math.max(0, Math.min(100, Number(raw.tone ?? 52))),
        muteOnBreak: raw.muteOnBreak !== undefined ? Boolean(raw.muteOnBreak) : true,
      };
    } catch {
      return defaults;
    }
  }

  function makeBiquadFilterFn(type, fc, Q, gainDb, sr) {
    const safeFc = Math.max(20, Math.min(sr * 0.44, fc));
    const w0 = (2 * Math.PI * safeFc) / sr;
    const cosw = Math.cos(w0);
    const sinw = Math.sin(w0);
    const alpha = sinw / (2 * Math.max(0.1, Q));
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

    if (type === 'lowpass') {
      b0 = (1 - cosw) * 0.5;
      b1 = 1 - cosw;
      b2 = (1 - cosw) * 0.5;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    } else if (type === 'highpass') {
      b0 = (1 + cosw) * 0.5;
      b1 = -(1 + cosw);
      b2 = (1 + cosw) * 0.5;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    } else if (type === 'bandpass') {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    } else if (type === 'peaking') {
      const A = Math.pow(10, (gainDb || 0) / 40);
      b0 = 1 + alpha * A;
      b1 = -2 * cosw;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosw;
      a2 = 1 - alpha / A;
    }

    const b0n = b0 / a0;
    const b1n = b1 / a0;
    const b2n = b2 / a0;
    const a1n = a1 / a0;
    const a2n = a2 / a0;
    let z1 = 0;
    let z2 = 0;
    return (x) => {
      const y = b0n * x + z1;
      z1 = b1n * x - a1n * y + z2;
      z2 = b2n * x - a2n * y;
      return y;
    };
  }

  function toneSliderToHz(toneVal) {
    const t = Math.max(0, Math.min(100, Number(toneVal) || 0)) / 100;
    return Math.round(360 * Math.pow(8200 / 360, t));
  }

  function toneDescriptor(toneVal) {
    const hz = toneSliderToHz(toneVal);
    const khz = hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${hz} Hz`;
    const feel = toneVal < 30 ? 'Deep' : toneVal < 68 ? 'Warm' : 'Open';
    return `${feel} · ${khz}`;
  }

  function volumeToLinearGain(volPct) {
    const v = Math.max(0, Math.min(100, Number(volPct) || 0)) / 100;
    return 0.58 * Math.pow(v, 1.75);
  }

  const soundMasker = (() => {
    let prefs = loadSoundPrefs();
    let audioCtx = null;
    let hpBus = null;
    let lpTone = null;
    let masterGain = null;
    let activeVoice = null;
    let isPlaying = false;
    let suspendedForBreak = false;
    const bufferCache = new Map();

    function savePrefs() {
      try {
        localStorage.setItem(SOUND_PREFS_KEY, JSON.stringify(prefs));
      } catch {}
    }

    function ensureContext() {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        audioCtx = new Ctx();
        hpBus = audioCtx.createBiquadFilter();
        hpBus.type = 'highpass';
        hpBus.frequency.value = 38;
        hpBus.Q.value = 0.707;

        lpTone = audioCtx.createBiquadFilter();
        lpTone.type = 'lowpass';
        lpTone.frequency.value = toneSliderToHz(prefs.tone);
        lpTone.Q.value = 0.65;

        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0;

        hpBus.connect(lpTone);
        lpTone.connect(masterGain);
        masterGain.connect(audioCtx.destination);
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      return audioCtx;
    }

    function synthesizeChannelRaw(kind, totalSamples, sr) {
      const out = new Float32Array(totalSamples);
      const warmup = 4096;
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      let brown = 0;
      let dropEnv = 0;
      const dropDecay = Math.exp(-1 / (0.014 * sr));

      const nextPink = (w) => {
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
        return p * 0.11;
      };

      let chain = [];
      if (kind === 'brown') {
        chain = [
          makeBiquadFilterFn('highpass', 42, 0.707, 0, sr),
          makeBiquadFilterFn('lowpass', 1150, 0.65, 0, sr),
        ];
      } else if (kind === 'speech') {
        chain = [
          makeBiquadFilterFn('highpass', 165, 0.707, 0, sr),
          makeBiquadFilterFn('peaking', 520, 0.85, 4.5, sr),
          makeBiquadFilterFn('peaking', 1380, 0.95, 5.0, sr),
          makeBiquadFilterFn('lowpass', 2950, 0.8, 0, sr),
          makeBiquadFilterFn('lowpass', 3600, 0.7, 0, sr),
        ];
      } else if (kind === 'pink') {
        chain = [
          makeBiquadFilterFn('highpass', 45, 0.707, 0, sr),
          makeBiquadFilterFn('lowpass', 3800, 0.65, 0, sr),
        ];
      } else if (kind === 'rain') {
        chain = [
          makeBiquadFilterFn('highpass', 85, 0.707, 0, sr),
          makeBiquadFilterFn('lowpass', 4300, 0.65, 0, sr),
        ];
      } else if (kind === 'cabin') {
        chain = [
          makeBiquadFilterFn('highpass', 36, 0.707, 0, sr),
          makeBiquadFilterFn('peaking', 68, 2.6, 4.2, sr),
          makeBiquadFilterFn('peaking', 136, 2.2, 2.8, sr),
          makeBiquadFilterFn('lowpass', 480, 0.75, 0, sr),
        ];
      }
      const dropBand = kind === 'rain' ? makeBiquadFilterFn('bandpass', 1750, 0.8, 0, sr) : null;

      for (let i = -warmup; i < totalSamples; i++) {
        const w = Math.random() * 2 - 1;
        let x = 0;
        if (kind === 'brown' || kind === 'cabin') {
          brown = (brown + 0.022 * w) / 1.022;
          x = brown * 3.2;
        } else if (kind === 'rain') {
          const p = nextPink(w);
          if (Math.random() < 0.0022) {
            dropEnv = Math.min(1, dropEnv + 0.28 + Math.random() * 0.35);
          } else {
            dropEnv *= dropDecay;
          }
          const pat = dropBand(w) * dropEnv * 0.55;
          x = p * 0.82 + pat;
        } else {
          x = nextPink(w);
        }

        for (let f = 0; f < chain.length; f++) {
          x = chain[f](x);
        }
        if (i >= 0) out[i] = x;
      }
      return out;
    }

    function getBufferForPreset(presetId) {
      const baseKind = presetId === 'gamma40' ? 'brown' : presetId;
      const cacheKey = `${baseKind}:${audioCtx.sampleRate}`;
      if (bufferCache.has(cacheKey)) return bufferCache.get(cacheKey);

      const sr = audioCtx.sampleRate;
      const loopSec = 18;
      const fadeSec = 2;
      const loopSamples = Math.floor(loopSec * sr);
      const fadeSamples = Math.floor(fadeSec * sr);
      const totalSamples = loopSamples + fadeSamples;

      const rawL = synthesizeChannelRaw(baseKind, totalSamples, sr);
      const rawR = synthesizeChannelRaw(baseKind, totalSamples, sr);

      const buf = audioCtx.createBuffer(2, loopSamples, sr);
      const chL = buf.getChannelData(0);
      const chR = buf.getChannelData(1);

      // Equal-power seamless loop crossfade + natural cushioned stereo width (74%)
      const sideScale = 0.74;
      let sumSq = 0;
      let sumL = 0;
      let sumR = 0;

      for (let i = 0; i < loopSamples; i++) {
        let l = rawL[i];
        let r = rawR[i];
        if (i < fadeSamples) {
          const theta = (i / fadeSamples) * Math.PI * 0.5;
          const c = Math.cos(theta);
          const s = Math.sin(theta);
          l = c * rawL[loopSamples + i] + s * rawL[i];
          r = c * rawR[loopSamples + i] + s * rawR[i];
        }
        const mid = 0.5 * (l + r);
        const side = 0.5 * (l - r) * sideScale;
        const outL = mid + side;
        const outR = mid - side;
        chL[i] = outL;
        chR[i] = outR;
        sumL += outL;
        sumR += outR;
      }

      const meanL = sumL / loopSamples;
      const meanR = sumR / loopSamples;
      for (let i = 0; i < loopSamples; i++) {
        chL[i] -= meanL;
        chR[i] -= meanR;
        sumSq += chL[i] * chL[i] + chR[i] * chR[i];
      }

      const curRms = Math.sqrt(sumSq / (2 * loopSamples)) || 1e-6;
      const targetRms = SOUND_PRESETS[presetId]?.rms || 0.15;
      const scale = targetRms / curRms;

      for (let i = 0; i < loopSamples; i++) {
        chL[i] = Math.tanh(chL[i] * scale * 1.1) / 1.1;
        chR[i] = Math.tanh(chR[i] * scale * 1.1) / 1.1;
      }

      bufferCache.set(cacheKey, buf);
      return buf;
    }

    function stopVoiceHandle(voice, fadeSec = 0.26) {
      if (!voice || !audioCtx) return;
      const now = audioCtx.currentTime;
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
      } catch {}
      setTimeout(() => {
        voice.nodes.forEach((n) => {
          try {
            if (typeof n.stop === 'function') n.stop();
          } catch {}
          try {
            n.disconnect();
          } catch {}
        });
      }, Math.ceil((fadeSec + 0.06) * 1000));
    }

    function mountPresetVoice(presetId) {
      if (!ensureContext()) return;
      const prev = activeVoice;
      const now = audioCtx.currentTime;

      const vGain = audioCtx.createGain();
      vGain.gain.setValueAtTime(0, now);
      vGain.gain.linearRampToValueAtTime(1, now + 0.28);
      vGain.connect(hpBus);

      const src = audioCtx.createBufferSource();
      src.buffer = getBufferForPreset(presetId);
      src.loop = true;
      const nodes = [src, vGain];

      if (presetId === 'rain') {
        // Ultra-slow organic breeze modulation so steady rain never feels static
        const breezeFilter = audioCtx.createBiquadFilter();
        breezeFilter.type = 'peaking';
        breezeFilter.frequency.value = 1100;
        breezeFilter.Q.value = 0.7;
        breezeFilter.gain.value = 0;

        const lfo = audioCtx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 0.072;
        const lfoDepth = audioCtx.createGain();
        lfoDepth.gain.value = 2.2;
        lfo.connect(lfoDepth);
        lfoDepth.connect(breezeFilter.gain);

        src.connect(breezeFilter);
        breezeFilter.connect(vGain);
        lfo.start(now);
        nodes.push(breezeFilter, lfo, lfoDepth);
      } else {
        src.connect(vGain);
      }

      if (presetId === 'gamma40') {
        // Subtle 40 Hz stereo gamma binaural offset (200 Hz L / 240 Hz R) tucked under brown noise
        const makeTone = (freq, panVal) => {
          const osc = audioCtx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = freq;
          const g = audioCtx.createGain();
          g.gain.value = 0.02;
          osc.connect(g);
          if (typeof audioCtx.createStereoPanner === 'function') {
            const pan = audioCtx.createStereoPanner();
            pan.pan.value = panVal;
            g.connect(pan);
            pan.connect(vGain);
            nodes.push(osc, g, pan);
          } else {
            g.connect(vGain);
            nodes.push(osc, g);
          }
          osc.start(now);
        };
        makeTone(200, -0.75);
        makeTone(240, 0.75);
      }

      src.start(now);
      activeVoice = { presetId, gain: vGain, nodes };
      if (prev) stopVoiceHandle(prev, 0.28);
    }

    function rampMasterGain(targetVal, rampSec = 0.28) {
      if (!audioCtx || !masterGain) return;
      const now = audioCtx.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(masterGain.gain.value, now);
      masterGain.gain.linearRampToValueAtTime(targetVal, now + rampSec);
    }

    function updateDom() {
      const presetMeta = SOUND_PRESETS[prefs.preset] || SOUND_PRESETS.brown;
      const toggleEl = document.getElementById('settings-sound-toggle');
      if (toggleEl) toggleEl.checked = Boolean(isPlaying && !suspendedForBreak);

      const statusEl = document.getElementById('sound-status-lbl');
      if (statusEl) {
        statusEl.textContent = !isPlaying
          ? `Off · ${presetMeta.name}`
          : suspendedForBreak
          ? `Auto-muted for 1:5 break · ${presetMeta.name}`
          : `Playing · ${presetMeta.name} · ${prefs.volume}%`;
      }
      const presetValEl = document.getElementById('settings-sound-preset-val');
      if (presetValEl) presetValEl.textContent = presetMeta.name;

      const descEl = document.getElementById('sound-preset-desc');
      if (descEl) descEl.textContent = presetMeta.desc;

      document.querySelectorAll('[data-sound-preset]').forEach((el) => {
        el.classList.toggle('active', el.dataset.soundPreset === prefs.preset);
      });

      const volSlider = document.getElementById('sound-vol-slider');
      const volLbl = document.getElementById('sound-vol-lbl');
      if (volSlider && Number(volSlider.value) !== prefs.volume) volSlider.value = String(prefs.volume);
      if (volLbl) volLbl.textContent = `${prefs.volume}%`;

      const toneSlider = document.getElementById('sound-tone-slider');
      const toneLbl = document.getElementById('sound-tone-lbl');
      if (toneSlider && Number(toneSlider.value) !== prefs.tone) toneSlider.value = String(prefs.tone);
      if (toneLbl) toneLbl.textContent = toneDescriptor(prefs.tone);

      const breakChk = document.getElementById('sound-break-mute');
      if (breakChk) breakChk.checked = Boolean(prefs.muteOnBreak);

      updateSettingsIndicators();
    }

    return {
      play(presetId = prefs.preset) {
        if (SOUND_PRESETS[presetId]) prefs.preset = presetId;
        savePrefs();
        if (!ensureContext()) {
          toast('Web Audio is not supported in this browser.');
          return;
        }
        suspendedForBreak = false;
        if (!isPlaying || !activeVoice || activeVoice.presetId !== prefs.preset) {
          mountPresetVoice(prefs.preset);
        }
        isPlaying = true;
        rampMasterGain(volumeToLinearGain(prefs.volume), 0.3);
        updateDom();
      },
      stop() {
        isPlaying = false;
        suspendedForBreak = false;
        rampMasterGain(0, 0.25);
        if (activeVoice) {
          stopVoiceHandle(activeVoice, 0.25);
          activeVoice = null;
        }
        updateDom();
      },
      toggle() {
        if (isPlaying && !suspendedForBreak) {
          this.stop();
          return false;
        }
        this.play(prefs.preset);
        return true;
      },
      isActive() {
        return Boolean(isPlaying && !suspendedForBreak);
      },
      setPreset(presetId) {
        if (!SOUND_PRESETS[presetId]) return;
        prefs.preset = presetId;
        savePrefs();
        this.play(presetId);
      },
      setVolume(volPct) {
        prefs.volume = Math.max(0, Math.min(100, Math.round(Number(volPct) || 0)));
        savePrefs();
        if (isPlaying && !suspendedForBreak) {
          rampMasterGain(volumeToLinearGain(prefs.volume), 0.08);
        }
        updateDom();
      },
      setTone(toneVal) {
        prefs.tone = Math.max(0, Math.min(100, Math.round(Number(toneVal) || 0)));
        savePrefs();
        if (audioCtx && lpTone) {
          lpTone.frequency.setTargetAtTime(toneSliderToHz(prefs.tone), audioCtx.currentTime, 0.04);
        }
        updateDom();
      },
      setMuteOnBreak(flag) {
        prefs.muteOnBreak = Boolean(flag);
        savePrefs();
        if (isPlaying) {
          if (prefs.muteOnBreak && workState.mode === 'break') {
            suspendedForBreak = true;
            rampMasterGain(0, 0.4);
          } else if (!prefs.muteOnBreak && suspendedForBreak) {
            suspendedForBreak = false;
            rampMasterGain(volumeToLinearGain(prefs.volume), 0.35);
          }
        }
        updateDom();
      },
      syncWithWorkMode(mode) {
        if (!isPlaying) return;
        if (mode === 'idle') {
          this.stop();
          return;
        }
        if (mode === 'break' && prefs.muteOnBreak) {
          suspendedForBreak = true;
          rampMasterGain(0, 0.55);
          updateDom();
        } else if (mode === 'working' && suspendedForBreak) {
          suspendedForBreak = false;
          if (!activeVoice) mountPresetVoice(prefs.preset);
          rampMasterGain(volumeToLinearGain(prefs.volume), 0.45);
          updateDom();
        }
      },
      getSummaryLabel() {
        const p = SOUND_PRESETS[prefs.preset] || SOUND_PRESETS.brown;
        return `${p.name} (${prefs.volume}%)`;
      },
      renderUi: updateDom,
    };
  })();

  // ---------------------------------------------------------------------------
  // iOS-Style Settings Sheet
  // ---------------------------------------------------------------------------
  let soundDrawerExpanded = false;

  function setSoundDrawerExpanded(expanded) {
    const panel = document.getElementById('settings-sound-panel');
    const btn = document.getElementById('settings-sound-expand-btn');
    if (!panel || !btn) return;
    panel.hidden = !expanded;
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.classList.toggle('is-expanded', Boolean(expanded));
  }

  function filterSettingsRows(rawQuery) {
    const body = document.getElementById('settings-body');
    if (!body) return;
    const q = String(rawQuery || '').trim().toLowerCase();
    const soundPanel = document.getElementById('settings-sound-panel');
    const items = body.querySelectorAll('[data-settings-item]');
    let visibleCount = 0;

    items.forEach((el) => {
      if (!q) {
        el.classList.remove('ios-search-hidden');
        if (!el.hidden) visibleCount += 1;
        return;
      }
      const hay = `${el.dataset.settingsItem || ''} ${el.textContent || ''}`.toLowerCase();
      const matched = hay.includes(q);
      el.classList.toggle('ios-search-hidden', !matched);
      if (el === soundPanel) {
        setSoundDrawerExpanded(matched);
      }
      if (matched && !el.hidden) visibleCount += 1;
    });

    if (!q) {
      setSoundDrawerExpanded(soundDrawerExpanded);
    }

    body.querySelectorAll('[data-settings-group]').forEach((group) => {
      const hasVisible = [...group.querySelectorAll('[data-settings-item]')].some(
        (el) => !el.hidden && !el.classList.contains('ios-search-hidden')
      );
      group.classList.toggle('ios-search-hidden', !hasVisible);
    });

    const empty = document.getElementById('settings-search-empty');
    if (empty) empty.hidden = !q || visibleCount > 0;
  }

  function updateSettingsIndicators() {
    const soundOn = soundMasker.isActive();
    const tutorOn = Boolean(window.StudyTutor?.isSharing?.());
    const anyLive = soundOn || tutorOn;
    document.querySelectorAll('.settings-active-dot').forEach((dot) => {
      dot.hidden = !anyLive;
    });
    const tutorVal = document.getElementById('settings-tutor-value');
    if (tutorVal) {
      tutorVal.textContent = tutorOn ? 'Live' : 'Off';
      tutorVal.classList.toggle('ios-val-live', tutorOn);
    }
    const layoutVal = document.getElementById('settings-layout-value');
    if (layoutVal && window.StudyLayout?.getActiveTitle) {
      layoutVal.textContent = window.StudyLayout.getActiveTitle();
    }
    const layoutSub = document.getElementById('settings-layout-sub');
    if (layoutSub) {
      layoutSub.textContent = workClock.canUseBreakTools()
        ? 'Customize visible metrics & difficulty labels'
        : 'Opens during breaks or after 20:00 Oslo';
    }
  }

  function openSettings() {
    const dialog = document.getElementById('settings-dialog');
    if (!dialog) return;
    const search = document.getElementById('settings-search');
    if (search) search.value = '';
    filterSettingsRows('');
    applyTheme();
    soundMasker.renderUi();
    updateSettingsIndicators();
    window.StudyApp?.syncSettingsRows?.();
    if (!dialog.open) {
      dialog.showModal();
      dialog.focus({ preventScroll: true });
    }
    const body = document.getElementById('settings-body');
    if (body) body.scrollTop = 0;
  }

  function closeSettings() {
    const dialog = document.getElementById('settings-dialog');
    if (dialog?.open) dialog.close();
  }

  function bindGlobalChrome() {
    applyTheme();
    document.getElementById('settings-dark-toggle')?.addEventListener('change', (ev) => {
      setTheme(ev.target.checked ? 'dark' : 'light');
    });
    document.getElementById('settings-pdf-dark-toggle')?.addEventListener('change', (ev) => {
      setPdfDark(ev.target.checked);
    });
    document.getElementById('ref-drawer-close')?.addEventListener('click', closeReferenceDrawer);
    document.getElementById('ref-backdrop')?.addEventListener('click', closeReferenceDrawer);
    document.getElementById('img-lightbox')?.addEventListener('click', closeLightbox);
    document.getElementById('img-lightbox-close')?.addEventListener('click', closeLightbox);

    // iOS Settings Sheet Triggers & Controls
    ['hdr-settings-btn', 'run-settings-btn'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', openSettings);
    });
    document.getElementById('settings-close-btn')?.addEventListener('click', closeSettings);
    const settingsDialog = document.getElementById('settings-dialog');
    settingsDialog?.addEventListener('click', (ev) => {
      if (ev.target === settingsDialog) closeSettings();
    });
    document.getElementById('settings-search')?.addEventListener('input', (ev) => {
      filterSettingsRows(ev.target.value);
    });
    document.getElementById('settings-sound-expand-btn')?.addEventListener('click', () => {
      soundDrawerExpanded = !soundDrawerExpanded;
      setSoundDrawerExpanded(soundDrawerExpanded);
    });
    document.getElementById('settings-layout-btn')?.addEventListener('click', () => {
      if (!workClock.canUseBreakTools()) {
        toast('Layout presets open during breaks or after 20:00 Oslo.');
        return;
      }
      closeSettings();
      window.StudyLayout.open(false);
    });
    document.getElementById('settings-fullscreen-toggle')?.addEventListener('change', () => {
      window.StudyRunner?.toggleFullscreen?.();
    });
    document.querySelectorAll('#settings-autopause-seg [data-autopause-val]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.StudyRunner?.setAutoPauseMode?.(btn.dataset.autopauseVal);
      });
    });

    // Background Sound Masking Controls (inside Settings)
    soundMasker.renderUi();
    document.getElementById('settings-sound-toggle')?.addEventListener('change', (ev) => {
      if (ev.target.checked) {
        soundMasker.play();
      } else {
        soundMasker.stop();
      }
    });
    document.querySelectorAll('[data-sound-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundMasker.setPreset(btn.dataset.soundPreset);
      });
    });
    document.getElementById('sound-vol-slider')?.addEventListener('input', (ev) => {
      soundMasker.setVolume(ev.target.value);
    });
    document.getElementById('sound-tone-slider')?.addEventListener('input', (ev) => {
      soundMasker.setTone(ev.target.value);
    });
    document.getElementById('sound-break-mute')?.addEventListener('change', (ev) => {
      soundMasker.setMuteOnBreak(ev.target.checked);
    });

    // Universal 75m Session + 1:5 Break controls
    const onWorkActionClick = () => {
      if (workState.mode === 'working') {
        workClock.triggerBreak(false);
      } else if (workState.mode === 'break') {
        showBreakModalUi();
      } else {
        workClock.ensureWorking();
        toast('75m working interval started (1:5 recovery break at cap).');
      }
    };
    document.getElementById('global-work-action-btn')?.addEventListener('click', onWorkActionClick);
    document.getElementById('run-break-btn')?.addEventListener('click', onWorkActionClick);
    document.getElementById('break-add-1m')?.addEventListener('click', () => {
      workClock.addBreakSeconds(60);
    });
    const breakDialog = document.getElementById('break-modal');
    breakDialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !eveningBreakAccess()) event.preventDefault();
    });
    breakDialog.addEventListener('cancel', (event) => {
      if (!eveningBreakAccess()) event.preventDefault();
    });
    document.getElementById('evening-break-tools-btn')?.addEventListener('click', showBreakModalUi);
    document.getElementById('break-close-btn')?.addEventListener('click', () => {
      breakDialog.close();
    });
    document.getElementById('break-layout-btn')?.addEventListener('click', () => window.StudyLayout.open(true));
    document.getElementById('break-sets-btn')?.addEventListener('click', () => {
      if (!workClock.canUseBreakTools()) return;
      breakDialog.close();
      if (!document.getElementById('view-runner').hidden) document.getElementById('run-exit-btn').click();
      window.StudyApp.navigate('home');
      const sets = document.getElementById('my-study-sets');
      sets.open = true;
      sets.scrollIntoView({ block: 'start' });
    });
    document.getElementById('break-community-btn')?.addEventListener('click', () => {
      if (!workClock.canUseBreakTools() || window.StudyRooms?.running()) return;
      breakDialog.close();
      if (!document.getElementById('view-community').hidden) return;
      if (!document.getElementById('view-runner').hidden) document.getElementById('run-exit-btn').click();
      window.StudyApp.navigate('community');
    });
    document.getElementById('break-resume-btn')?.addEventListener('click', () => {
      if (workState.mode === 'working') breakDialog.close();
      else workClock.startNextInterval();
    });
    document.getElementById('break-end-session-btn')?.addEventListener('click', () => {
      workClock.endSession();
      toast('Working session ended.');
    });

    // Sync across tabs & persist screen time on blur/hide
    window.addEventListener('storage', (ev) => {
      if (ev.key === WORK_WAVE_KEY) {
        workState = loadWorkState();
        renderWorkClockDom();
      }
    });
    document.addEventListener('visibilitychange', () => {
      renderWorkClockDom();
      saveWorkState();
    });
    window.addEventListener('pagehide', () => {
      renderWorkClockDom();
      saveWorkState();
    });

    renderWorkClockDom();
    if (workState.mode === 'break' && (workState.breakEndsAtMs || 0) > Date.now()) {
      showBreakModalUi();
    }
    clearInterval(workTickHandle);
    workTickHandle = setInterval(renderWorkClockDom, 1000);

    document.addEventListener('click', (e) => {
      const figImg = e.target?.closest?.('.pdf-figure:not([data-pdf-excerpt]) img');
      if (figImg && figImg.src) {
        openLightbox(figImg.src, figImg.alt);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!document.getElementById('img-lightbox')?.hidden) {
          closeLightbox();
          e.preventDefault();
        } else if (!document.getElementById('ref-drawer')?.hidden) {
          closeReferenceDrawer();
          e.preventDefault();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      if (e.key.toLowerCase() === 'm') {
        const on = soundMasker.toggle();
        toast(on ? `Sound: ${soundMasker.getSummaryLabel()}` : 'Sound off');
        e.preventDefault();
      } else if (e.key === ',' && !document.querySelector('dialog[open]')) {
        openSettings();
        e.preventDefault();
      }
    });
  }

  return {
    esc,
    examLabel,
    clockSec,
    minLabel,
    renderMarkdownWithMath,
    toast,
    applyTheme,
    toggleTheme,
    togglePdfDark,
    openSettings,
    closeSettings,
    updateSettingsIndicators,
    openReferenceDrawer,
    closeReferenceDrawer,
    bindGlobalChrome,
    workClock,
    soundMasker,
  };
})();
