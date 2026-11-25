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

  // ---------------------------------------------------------------------------
  // IDE / JUPYTER CODING HANDOFF + ALWAYS-ON-TOP FLOATING AI-PAR BAR (Doc PiP)
  // ---------------------------------------------------------------------------
  const CODING_IDE_KEY = 'study-os-coding-ide-v1';
  const IDE_CONFIGS = {
    antigravity: { label: 'Antigravity', scheme: 'antigravity' },
    vscode: { label: 'VS Code', scheme: 'vscode' },
    cursor: { label: 'Cursor', scheme: 'cursor' },
  };
  let floatingParWin = null;

  function getPreferredCodingIde() {
    try {
      const v = localStorage.getItem(CODING_IDE_KEY);
      if (v && IDE_CONFIGS[v]) return v;
    } catch {}
    return 'vscode';
  }
  function setPreferredCodingIde(ide) {
    if (!IDE_CONFIGS[ide]) return;
    try { localStorage.setItem(CODING_IDE_KEY, ide); } catch {}
  }

  function toBase64UrlUtf8(str) {
    const bytes = new TextEncoder().encode(String(str || ''));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function toNotebookLines(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n');
    if (!raw) return [];
    const lines = raw.split('\n');
    return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
  }

  function buildExamNotebookObject(q, st, topicLabel = '') {
    const qid = String(q?.id || 'exercise');
    const title = String(q?.title || qid);
    const parSec = Math.max(60, Number(st?.targetSec) || 900);
    const prompt = String(q?.promptMarkdown || '').replace(/\r\n/g, '\n').trim();

    let starterCode = '';
    const starterMatch = prompt.match(/```python\s*\n([\s\S]*?)```/i);
    if (starterMatch) starterCode = starterMatch[1].trim();

    const needsPandas = /\b(pandas|pd\.|dataframe|read_csv|groupby|crosstab|resample|\.csv)\b/i.test(prompt);
    const needsPlot = /\b(matplotlib|plt\.|seaborn|sns\.|subplot|plot|chart|heatmap|facetgrid|scatter|histogram|pie)\b/i.test(prompt);
    const autoImports = [];
    if (needsPandas) autoImports.push('import pandas as pd');
    if (needsPlot) {
      autoImports.push('import matplotlib.pyplot as plt');
      if (/\b(seaborn|sns|heatmap|facetgrid)\b/i.test(prompt)) autoImports.push('import seaborn as sns');
    }

    const subpartRe = /^(?:[-*]\s+)?(?:\*\*)?(?:\((\d+\.[a-z]|[a-z]|\d+)\)|([a-z])\.)(?:\*\*)?\s+(.*)$/i;
    const lines = prompt.split('\n');
    const introLines = [];
    const subparts = [];
    let activeSub = null;
    for (const line of lines) {
      if (/^\*\*Starter Code/i.test(line.trim())) {
        activeSub = null;
        continue;
      }
      const m = line.match(subpartRe);
      if (m) {
        const tag = m[1] ? `(${m[1]})` : `(${m[2]})`;
        activeSub = { label: tag, body: [m[3]] };
        subparts.push(activeSub);
      } else if (activeSub) {
        activeSub.body.push(line);
      } else {
        introLines.push(line);
      }
    }

    const cells = [];
    const headerParts = [
      `# ${title}`,
      `> **Study-OS AI Par:** \`${clockSec(parSec)}\`${topicLabel ? ` · **Topic:** ${topicLabel}` : ''} · \`${qid}\``,
    ];
    const introText = introLines.join('\n').trim();
    if (introText) headerParts.push('', introText);
    cells.push({ cell_type: 'markdown', metadata: {}, source: toNotebookLines(headerParts.join('\n')) });

    if (subparts.length >= 2) {
      if (autoImports.length) {
        cells.push({
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          outputs: [],
          source: toNotebookLines(autoImports.join('\n')),
        });
      }
      subparts.forEach((sp, idx) => {
        cells.push({
          cell_type: 'markdown',
          metadata: {},
          source: toNotebookLines(`**${sp.label}** ${sp.body.join('\n').trim()}`),
        });
        const codeInit = idx === 0 && starterCode ? starterCode : `# ${sp.label}\n`;
        cells.push({
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          outputs: [],
          source: toNotebookLines(codeInit),
        });
      });
    } else {
      const codeParts = [];
      if (autoImports.length && !starterCode.includes('import pandas')) codeParts.push(autoImports.join('\n'));
      codeParts.push(starterCode || `# Write your Python solution for ${qid} below\n`);
      cells.push({
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: toNotebookLines(codeParts.join('\n\n')),
      });
    }

    return {
      cells,
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python', mimetype: 'text/x-python', file_extension: '.py' },
        studyOs: { qid, title, parSec },
      },
      nbformat: 4,
      nbformat_minor: 5,
    };
  }

  function downloadExamNotebook(q, st, topicLabel = '') {
    const nb = buildExamNotebookObject(q, st, topicLabel);
    const shortId = String(q?.id || 'exercise').replace(/^[^:]+:/, '').replace(/[^a-zA-Z0-9._-]+/g, '_');
    const blob = new Blob([JSON.stringify(nb, null, 2)], { type: 'application/x-ipynb+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${shortId || 'study-os-task'}.ipynb`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast(`Downloaded ${shortId}.ipynb — open in Jupyter / VS Code!`);
  }

  function buildIdeCompanionUri(ide, q, st, topicLabel = '') {
    const cfg = IDE_CONFIGS[ide] || IDE_CONFIGS.vscode;
    const payload = {
      qid: String(q?.id || 'exercise'),
      courseId: String(q?.courseId || activeRun?.courseMeta?.courseId || ''),
      title: String(q?.title || q?.id || 'Exercise').slice(0, 140),
      parSec: Math.max(60, Math.round(Number(st?.targetSec) || 900)),
      elapsedSec: Math.max(0, Math.floor(itemActiveSec(st))),
      topic: String(topicLabel || '').slice(0, 90),
      promptMarkdown: String(q?.promptMarkdown || '').slice(0, 4500),
    };
    const encoded = toBase64UrlUtf8(JSON.stringify(payload));
    return `${cfg.scheme}://study-os.companion/open?data=${encoded}`;
  }

  function isIdeCodingFocusExempt() {
    if (!activeRun || document.getElementById('view-runner')?.hidden) return false;
    if (floatingParWin && !floatingParWin.closed) return true;
    const q = currentQuestion();
    if (!q || q.kind !== 'coding') return false;
    const st = itemState(q.id);
    return Boolean(st?.ideActive);
  }

  function closeFloatingParBar() {
    if (floatingParWin && !floatingParWin.closed) {
      try { floatingParWin.close(); } catch {}
    }
    floatingParWin = null;
  }

  function parsePromptSubparts(promptMarkdown) {
    const raw = String(promptMarkdown || '').replace(/\r\n/g, '\n').trim();
    if (!raw) return { intro: '', subparts: [], dataset: '', datasetCols: '' };
    const subpartRe = /^(?:[-*]\s+)?(?:\*\*)?(?:\((\d+\.[a-z]|[a-z]|\d+)\)|([a-z])\.)(?:\*\*)?\s+(.*)$/i;
    const lines = raw.split('\n');
    const introLines = [];
    const subparts = [];
    let activeSub = null;
    for (const line of lines) {
      const m = line.match(subpartRe);
      if (m) {
        const tag = m[1] ? m[1] : m[2];
        activeSub = { label: tag, display: `(${tag})`, body: [m[3]] };
        subparts.push(activeSub);
      } else if (activeSub) {
        activeSub.body.push(line);
      } else {
        introLines.push(line);
      }
    }
    const intro = introLines.join('\n').trim();
    let dataset = '';
    let datasetCols = '';
    const dsMatch = intro.match(/`?([a-z0-9_.-]+\.(?:csv|xlsx|json))`?(?:\s*\(([^)]+)\))?/i)
      || raw.match(/`?([a-z0-9_.-]+\.(?:csv|xlsx|json))`?/i);
    if (dsMatch) {
      dataset = dsMatch[1];
      datasetCols = dsMatch[2] || '';
    }
    return { intro, subparts, dataset, datasetCols };
  }

  function renderStructuredCodingPrompt(q, st) {
    const parsed = parsePromptSubparts(q.promptMarkdown);
    if (parsed.subparts.length < 2) {
      return q.promptMarkdown
        ? `<div class="markdown-body" style="font-size:15.5px">${renderMarkdownWithMath(q.promptMarkdown)}</div>`
        : '';
    }
    if (!Array.isArray(st.checkedSubparts)) st.checkedSubparts = [];
    const totalSub = parsed.subparts.length;
    const doneSub = st.checkedSubparts.length;
    const perPartMin = Math.max(1, Math.round((Number(st.targetSec) || 900) / 60 / totalSub));

    const dsBarHtml = parsed.dataset
      ? `<div class="coding-ds-banner">
           <span class="coding-ds-pill">📊 ${esc(parsed.dataset)}</span>
           ${parsed.datasetCols ? `<span class="coding-ds-cols">${esc(parsed.datasetCols)}</span>` : ''}
         </div>`
      : '';
    const cleanIntro = parsed.intro
      ? parsed.intro.replace(/Dataset\s+`?[a-z0-9_.-]+\.(?:csv|xlsx|json)`?(?:\s*\([^)]+\))?\s*:?/i, '').trim()
      : '';
    const introHtml = cleanIntro
      ? `<div class="markdown-body coding-intro-md">${renderMarkdownWithMath(cleanIntro)}</div>`
      : '';

    const cardsHtml = parsed.subparts.map((sp, idx) => {
      const checked = st.checkedSubparts.includes(idx);
      const isNext = !checked && idx === parsed.subparts.findIndex((_, i) => !st.checkedSubparts.includes(i));
      const bodyMd = sp.body.join('\n').trim();
      return `<div class="coding-subpart-card ${checked ? 'is-checked' : ''} ${isNext ? 'is-active' : ''}" data-subpart-idx="${idx}">
        <button type="button" class="coding-subpart-chk" data-toggle-subpart="${idx}" aria-pressed="${checked}" title="Mark ${esc(sp.display)} complete">
          ${checked ? '✓' : ''}
        </button>
        <div class="coding-subpart-main">
          <div class="coding-subpart-head">
            <span class="coding-subpart-tag">${esc(sp.label)}</span>
            <span class="coding-subpart-par">~${perPartMin}m par</span>
          </div>
          <div class="markdown-body coding-subpart-body">${renderMarkdownWithMath(bodyMd)}</div>
        </div>
      </div>`;
    }).join('');

    return `
      <div class="coding-structured-prompt">
        <div class="coding-prompt-meta-bar">
          ${dsBarHtml || '<span class="coding-ds-pill">🐍 Python / Jupyter Task</span>'}
          <span class="coding-subpart-counter" id="coding-subpart-counter"><strong>${doneSub}/${totalSub}</strong> subparts checked · ~${perPartMin}m each</span>
        </div>
        ${introHtml}
        <div class="coding-subpart-list">${cardsHtml}</div>
      </div>
    `;
  }

  function syncFloatingParBar(q, st, activeSec, finished) {
    if (!floatingParWin || floatingParWin.closed || !q || !st) return;
    const doc = floatingParWin.document;
    const titleEl = doc.getElementById('pip-title');
    const youEl = doc.getElementById('pip-you');
    const statusEl = doc.getElementById('pip-status');
    const parEl = doc.getElementById('pip-par');
    const fillEl = doc.getElementById('pip-fill');
    const pauseBtn = doc.getElementById('pip-pause');
    const doneBtn = doc.getElementById('pip-done');
    const solBtn = doc.getElementById('pip-sol');
    const revBtn = doc.getElementById('pip-revisit');
    const barEl = doc.getElementById('pip-bar');
    const subRowEl = doc.getElementById('pip-subparts');
    if (!titleEl || !fillEl) return;

    const hintTime = st.hintsUsed * st.handicapPerHintSec;
    const elapsed = st.loggedAttempt?.effectiveSec ?? activeSec + hintTime;
    const remaining = st.targetSec - elapsed;
    const paused = st.runningSince === null && !finished;
    let tone = 'running';
    let msg = `${clockSec(Math.ceil(remaining))} left`;
    if (st.loggedAttempt?.beatAi) {
      tone = 'beat';
      msg = 'Target beaten';
    } else if (remaining <= 0) {
      tone = 'overtime';
      const ov = Math.floor(-remaining);
      msg = ov ? `+${clockSec(ov)} over` : 'Par reached';
    } else if (finished) {
      tone = 'review';
      msg = 'Review';
    } else if (remaining <= Math.min(30, st.targetSec * 0.08)) {
      tone = 'urgent';
    } else if (remaining <= Math.min(180, st.targetSec * 0.2)) {
      tone = 'near';
    }
    if (paused) msg = `Paused · ${msg}`;

    const shortTitle = String(q.title || q.id || 'Exercise');
    if (titleEl.textContent !== shortTitle) titleEl.textContent = shortTitle;
    if (youEl) youEl.textContent = `You ${clockSec(Math.floor(elapsed))}`;
    if (statusEl) statusEl.textContent = msg;
    if (parEl) parEl.textContent = `Par ${clockSec(st.targetSec)}`;
    if (barEl) barEl.dataset.tone = tone;
    const pct = Math.min(100, Math.max(0, (elapsed / Math.max(1, st.targetSec)) * 100));
    fillEl.style.width = `${pct.toFixed(1)}%`;

    if (subRowEl) {
      const parsed = parsePromptSubparts(q.promptMarkdown);
      if (parsed.subparts.length >= 2) {
        if (!Array.isArray(st.checkedSubparts)) st.checkedSubparts = [];
        const sig = `${q.id}:${st.checkedSubparts.join(',')}`;
        if (subRowEl.dataset.sig !== sig) {
          subRowEl.dataset.sig = sig;
          const nextIdx = parsed.subparts.findIndex((_, i) => !st.checkedSubparts.includes(i));
          subRowEl.innerHTML = parsed.subparts.map((sp, i) => {
            const done = st.checkedSubparts.includes(i);
            const cur = i === nextIdx;
            return `<button type="button" class="pip-sub-chip ${done ? 'is-done' : cur ? 'is-cur' : ''}" data-pip-sub="${i}" title="Toggle ${esc(sp.display)}">${done ? '✓ ' : ''}${esc(sp.label)}</button>`;
          }).join('');
          subRowEl.querySelectorAll('[data-pip-sub]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const idx = Number(btn.dataset.pipSub);
              if (!Array.isArray(st.checkedSubparts)) st.checkedSubparts = [];
              if (st.checkedSubparts.includes(idx)) st.checkedSubparts = st.checkedSubparts.filter((x) => x !== idx);
              else st.checkedSubparts.push(idx);
              syncFloatingParBar(q, st, itemActiveSec(st), Boolean(st.revealed));
              const cardEl = document.querySelector(`.coding-subpart-card[data-subpart-idx="${idx}"]`);
              if (cardEl) renderRunner();
            });
          });
        }
        subRowEl.hidden = false;
      } else {
        subRowEl.hidden = true;
      }
    }

    if (pauseBtn) {
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      pauseBtn.disabled = finished;
    }
    if (solBtn) solBtn.hidden = Boolean(st.revealed);
    if (doneBtn) {
      doneBtn.textContent = st.revealed ? '✓ Got It & Next' : '✓ Finish';
    }
    if (revBtn) revBtn.hidden = !st.revealed;
  }

  async function openFloatingParBar() {
    if (!activeRun) return false;
    const q = currentQuestion();
    if (!q) return false;
    const st = itemState(q.id);
    if (floatingParWin && !floatingParWin.closed) {
      try { floatingParWin.focus(); } catch {}
      syncFloatingParBar(q, st, itemActiveSec(st), Boolean(st.revealed));
      return true;
    }
    if (!('documentPictureInPicture' in window) || typeof window.documentPictureInPicture?.requestWindow !== 'function') {
      toast('Always-on-top bar needs Chrome or Edge — your IDE Companion CodeLens & status bar timers still work!');
      return false;
    }
    try {
      const hasSubparts = parsePromptSubparts(q.promptMarkdown).subparts.length >= 2;
      const winW = 600;
      const winH = hasSubparts ? 114 : 92;
      const pip = await window.documentPictureInPicture.requestWindow({
        width: winW,
        height: winH,
        disallowReturnToOpener: true,
      });
      floatingParWin = pip;
      // Reposition cleanly to TOP-CENTER of the user's screen (instead of Chrome's default bottom-right corner)
      try {
        const targetX = Math.max(20, Math.round((window.screen.availLeft || 0) + ((window.screen.availWidth || 1440) - winW) / 2));
        const targetY = Math.max(8, Math.round((window.screen.availTop || 0) + 12));
        pip.moveTo(targetX, targetY);
      } catch {}
      const isDark = document.documentElement.dataset.theme === 'dark';
      pip.document.title = '⠿ Drag to move · Study-OS AI Par';
      pip.document.head.innerHTML = `
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
            background: ${isDark ? '#11161d' : '#ffffff'};
            color: ${isDark ? '#f1f5f9' : '#0f172a'};
            padding: 8px 12px;
            overflow: hidden;
            user-select: none;
          }
          #pip-bar { display: flex; flex-direction: column; gap: 6px; }
          .pip-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; font-variant-numeric: tabular-nums; }
          .pip-title { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 245px; }
          .pip-mid { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
          .pip-you { font-weight: 750; }
          .pip-status { font-weight: 700; padding: 1px 7px; border-radius: 999px; font-size: 11px; background: ${isDark ? '#13312d' : '#e6f5f2'}; color: ${isDark ? '#34d399' : '#0f766e'}; }
          #pip-bar[data-tone="near"] .pip-status { background: ${isDark ? '#3a2b0d' : '#fef3c7'}; color: ${isDark ? '#fbbf24' : '#b45309'}; }
          #pip-bar[data-tone="urgent"] .pip-status, #pip-bar[data-tone="overtime"] .pip-status { background: ${isDark ? '#3f1515' : '#fee2e2'}; color: ${isDark ? '#f87171' : '#dc2626'}; }
          .pip-par { color: ${isDark ? '#94a3b8' : '#64748b'}; font-size: 11.5px; }
          .pip-track { width: 100%; height: 5px; border-radius: 999px; background: ${isDark ? '#1e293b' : '#e2e8f0'}; overflow: hidden; }
          .pip-fill { height: 100%; width: 0%; background: #0f766e; transition: width 0.35s linear, background-color 0.25s ease; border-radius: 999px; }
          #pip-bar[data-tone="near"] .pip-fill { background: #f59e0b; }
          #pip-bar[data-tone="urgent"] .pip-fill, #pip-bar[data-tone="overtime"] .pip-fill { background: #ef4444; }
          .pip-subparts { display: flex; align-items: center; gap: 4px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
          .pip-subparts::-webkit-scrollbar { display: none; }
          .pip-sub-chip { font: 700 10.5px/1 -apple-system, BlinkMacSystemFont, sans-serif; padding: 3px 7px; border-radius: 999px; border: 1px solid ${isDark ? '#334155' : '#cbd5e1'}; background: ${isDark ? '#1e293b' : '#f8fafc'}; color: ${isDark ? '#cbd5e1' : '#475569'}; cursor: pointer; flex-shrink: 0; }
          .pip-sub-chip.is-cur { border-color: #0f766e; background: ${isDark ? '#13312d' : '#e6f5f2'}; color: ${isDark ? '#34d399' : '#0f766e'}; }
          .pip-sub-chip.is-done { border-color: #10b981; background: #10b981; color: #fff; }
          .pip-actions { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
          .pip-btn-grp { display: flex; align-items: center; gap: 5px; }
          button {
            font: 600 11.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            padding: 5px 9px;
            border-radius: 7px;
            border: 1px solid ${isDark ? '#2d3748' : '#d1d5db'};
            background: ${isDark ? '#1c2430' : '#f8fafc'};
            color: ${isDark ? '#e2e8f0' : '#0f172a'};
            cursor: pointer;
          }
          button:hover:not(:disabled) { border-color: #0f766e; }
          button:disabled { opacity: 0.45; cursor: default; }
          button.primary { background: #0f766e; border-color: #0f766e; color: #ffffff; }
          button.primary:hover:not(:disabled) { background: #0d625b; }
          .pip-brand { font-size: 10.5px; color: ${isDark ? '#64748b' : '#94a3b8'}; font-weight: 600; }
        </style>
      `;
      pip.document.body.innerHTML = `
        <div id="pip-bar" data-tone="running">
          <div class="pip-top">
            <span class="pip-title" id="pip-title"></span>
            <div class="pip-mid">
              <span class="pip-you" id="pip-you">You 0:00</span>
              <span class="pip-status" id="pip-status">0:00 left</span>
              <span class="pip-par" id="pip-par">Par 0:00</span>
            </div>
          </div>
          <div class="pip-track"><div class="pip-fill" id="pip-fill"></div></div>
          <div class="pip-subparts" id="pip-subparts" hidden></div>
          <div class="pip-actions">
            <span class="pip-brand">⠿ Drag title bar · StudyOS.no Live Sync</span>
            <div class="pip-btn-grp">
              <button type="button" id="pip-pause">Pause</button>
              <button type="button" id="pip-sol">Solution</button>
              <button type="button" id="pip-revisit" hidden>Revisit</button>
              <button type="button" class="primary" id="pip-done">✓ Finish</button>
            </div>
          </div>
        </div>
      `;
      pip.document.getElementById('pip-pause')?.addEventListener('click', () => {
        toggleManualPause();
        const cq = currentQuestion();
        if (cq) syncFloatingParBar(cq, itemState(cq.id), itemActiveSec(itemState(cq.id)), Boolean(itemState(cq.id).revealed));
      });
      pip.document.getElementById('pip-sol')?.addEventListener('click', () => {
        document.getElementById('btn-reveal-sol')?.click();
        try { window.focus(); } catch {}
      });
      pip.document.getElementById('pip-done')?.addEventListener('click', () => {
        const cq = currentQuestion();
        if (!cq) return;
        const cst = itemState(cq.id);
        if (!cst.revealed) {
          document.getElementById('btn-reveal-sol')?.click();
          try { window.focus(); } catch {}
        } else {
          document.querySelector('.btn-got-it-next')?.click();
        }
      });
      pip.document.getElementById('pip-revisit')?.addEventListener('click', () => {
        document.querySelector('.btn-missed-next')?.click();
      });
      pip.addEventListener('pagehide', () => {
        if (floatingParWin === pip) floatingParWin = null;
        const badge = document.getElementById('coding-ide-live-pill');
        if (badge && !isIdeCodingFocusExempt()) badge.hidden = true;
      });
      syncFloatingParBar(q, st, itemActiveSec(st), Boolean(st.revealed));
      return true;
    } catch {
      return false;
    }
  }

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
  function isInstantMcqEnabled(prefs = getRunnerUiPrefs()) {
    return prefs.instantMcq !== false;
  }
  function isMathParAutoRevealEnabled(prefs = getRunnerUiPrefs()) {
    return Boolean(prefs.mathParAutoReveal);
  }
  function setMathParAutoRevealEnabled(enabled) {
    saveRunnerUiPrefs({ mathParAutoReveal: Boolean(enabled) });
    const chk = document.getElementById('settings-math-par-answers');
    if (chk) chk.checked = Boolean(enabled);
    if (activeRun && !document.getElementById('view-runner')?.hidden) {
      const q = currentQuestion();
      if (q) {
        const st = itemState(q.id);
        refreshAnswerTrayInPlace(q, st);
      }
    }
    toast(enabled ? 'Math par auto-reveal ON (final answers only, zero penalty)' : 'Math par auto-reveal OFF');
  }

  // ---------------------------------------------------------------------------
  // FINAL-ANSWERS-ONLY EXTRACTOR (Zero-Penalty Answer Check · No Worked Steps)
  // ---------------------------------------------------------------------------
  function cleanConciseAnswer(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    // Unwrap display math $$...$$ into inline $...$ for compact answer chips
    s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => `$${inner.trim().replace(/\s*\n\s*/g, ' ')}$`);
    // Handle orphaned leading/trailing $$ or $ after splitting a display/inline math expression
    if (/\$\$$/.test(s) && !/^\$\$/.test(s)) s = `$${s.replace(/\$\$$/, '').trim()}$`;
    if (/^\$\$/.test(s) && !/\$\$$/.test(s)) s = `$${s.replace(/^\$\$/, '').trim()}$`;
    const singleDollars = (s.replace(/\\\$/g, '').match(/\$/g) || []).length;
    if (singleDollars % 2 === 1) {
      if (!s.startsWith('$')) s = `$${s}`;
      else s = `${s}$`;
    }
    // Strip trailing alternate form like \quad \left(= ...\right) so splitting on = never leaves dangling \right)
    s = s.replace(/\\quad\s*\\left\(\s*=\s*[\s\S]*?\\right\)/g, '');
    s = s.replace(/\\quad\s*\(\s*=\s*[^)]*\)/g, '');
    s = s.replace(/\\boxed\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, '$1');
    const leftCount = (s.match(/\\left\b/g) || []).length;
    const rightCount = (s.match(/\\right\b/g) || []).length;
    if (leftCount !== rightCount) {
      s = s.replace(/\\left(?=[(\[|{.])|\\right(?=[)\]|}.])/g, '');
    }
    s = s.replace(/\s+/g, ' ').replace(/[.,;:]\s*$/, '').trim();
    return s;
  }

  function extractResultFromSegment(segment) {
    const raw = String(segment || '').trim();
    if (!raw) return '';

    // Special case: polynomial division equation followed by "with remainder **$R$**"
    const remMatch = raw.match(/(?:\$\$|\$)[^$\n]*?=\s*([^$\n]+?)(?:\$\$|\$)[\s,]*with\s+remainder\s+(?:\*\*)?\$?([^$\n*]+?)\$?(?:\*\*)?/i);
    if (remMatch) {
      const rhs = cleanConciseAnswer(remMatch[1]).replace(/^\$|\$$/g, '').trim();
      const rem = cleanConciseAnswer(remMatch[2]).replace(/^\$|\$$/g, '').trim();
      if (rhs) return `$${rhs}$ (rem $${rem || '0'}$)`;
    }

    // Check explicit "Answer:" / "Final answer:" / "Conclusion:" / "⇒" / "∴" markers
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      const explicit = ln.match(/(?:^|\b)(?:final\s+answer|answer|result|solution|therefore|thus|hence|conclude)\s*[:\-–—]?\s*(.+)$/i);
      if (explicit && explicit[1].trim().length >= 1 && explicit[1].trim().length <= 180) {
        const val = cleanConciseAnswer(explicit[1]);
        if (val) return val;
      }
    }

    // Look for bolded final values (**$...$** or **...**) preferring the last one
    const boldMatches = [...raw.matchAll(/\*\*([^*\n]{1,140})\*\*/g)]
      .map((m) => m[1].trim())
      .filter((t) => !/^(?:step\s*\d+|method|part\s*[a-z0-9]+|note|check|verify|hint|given|formula|recall|answer|solution|a\)|b\)|c\)|d\)|e\)|f\)|i\)|ii\)|iii\)|iv\)|[a-z]\)|\(\w+\)):?$/i.test(t));
    if (boldMatches.length) {
      const lastBold = cleanConciseAnswer(boldMatches[boldMatches.length - 1]);
      if (lastBold && lastBold.length <= 160) return lastBold;
    }

    // Look at the last math expression or arrow-conclusion on the final non-empty line
    const tail = lines[lines.length - 1] || raw;
    const arrowParts = tail.split(/(?:⇒|⟹|→|\\Rightarrow|\\implies|∴)/);
    if (arrowParts.length > 1) {
      const rhs = cleanConciseAnswer(arrowParts[arrowParts.length - 1]);
      if (rhs && rhs.length <= 160) return rhs;
    }

    // Extract last inline/display math chunk and take its final RHS if it's a chained equality
    const mathChunks = [...raw.matchAll(/\$\$?([^$]+?)\$\$?/g)].map((m) => m[1].trim()).filter(Boolean);
    if (mathChunks.length) {
      let lastTex = mathChunks[mathChunks.length - 1]
        .replace(/\\quad\s*\\left\(\s*=\s*[\s\S]*?\\right\)/g, '')
        .replace(/\\quad\s*\(\s*=\s*[^)]*\)/g, '')
        .replace(/\\boxed\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, '$1')
        .trim();
      // Split on top-level `=` (not inside \left...\right or braces) when there are multiple `=` steps
      const eqParts = lastTex.split(/\s*=\s*/);
      if (eqParts.length >= 3) {
        const lhs = eqParts[0].trim();
        const finalRhs = eqParts[eqParts.length - 1].trim();
        if (lhs.length <= 14 && /^[a-zA-Z\\_{}^0-9(),']+$/i.test(lhs)) {
          lastTex = `${lhs} = ${finalRhs}`;
        } else {
          lastTex = finalRhs;
        }
      }
      // Balance stray \left / \right if any
      const leftCount = (lastTex.match(/\\left\b/g) || []).length;
      const rightCount = (lastTex.match(/\\right\b/g) || []).length;
      if (leftCount !== rightCount) {
        lastTex = lastTex.replace(/\\left(?=[(\[|{.])|\\right(?=[)\]|}.])/g, '');
      }
      if (lastTex && lastTex.length <= 240) return `$${lastTex}$`;
    }

    const compact = cleanConciseAnswer(tail);
    if (compact.length <= 240 || compact.includes('$')) return compact;
    return `${compact.slice(0, 237)}…`;
  }

  function extractFinalAnswers(q) {
    if (!q) return [];
    if (q.kind === 'mcq') return [];
    if (Array.isArray(q.wiseflowFields) && q.wiseflowFields.length > 0) return [];
    if (q._cachedFinalAnswers) return q._cachedFinalAnswers;

    const sol = String(q.solutionMarkdown || '').trim();
    const parts = [];

    if (sol) {
      // Mask $$...$$ blocks so line splitting never splits inside multi-line LaTeX
      const displayBlocks = [];
      const masked = sol.replace(/\$\$[\s\S]*?\$\$/g, (m) => {
        const idx = displayBlocks.length;
        displayBlocks.push(m);
        return `@@DISP_${idx}@@`;
      });
      const unmask = (txt) => txt.replace(/@@DISP_(\d+)@@/g, (_, idx) => displayBlocks[Number(idx)] || '');

      // Detect subparts like: "**a)** ...", "- **a)** ...", "a) ...", "(a) ...", "**i)** ...", "### a) ...", "1) ..."
      const lines = masked.split('\n');
      const partStartRe = /^(?:[-*•]\s*|#{1,4}\s*)?(?:\*\*)?(\(?[a-h]\)|\(?(?:i|ii|iii|iv|v|vi)\)|Part\s+[a-z0-9]+|[1-9]\))(?:\*\*)?[:.\s]+(.*)$/i;
      const grouped = [];
      let cur = null;

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        const m = trimmed.match(partStartRe);
        if (m) {
          if (cur) grouped.push(cur);
          const rawLbl = m[1].replace(/^\(/, '').replace(/\)$/, '');
          const lbl = /^part\s/i.test(rawLbl) ? rawLbl : `${rawLbl})`;
          cur = { label: lbl, lines: [m[2] || ''] };
        } else if (cur) {
          cur.lines.push(rawLine);
        }
      }
      if (cur) grouped.push(cur);

      if (grouped.length >= 2) {
        for (const g of grouped) {
          const val = extractResultFromSegment(unmask(g.lines.join('\n')));
          if (val) parts.push({ label: g.label, md: val });
        }
      }

      if (!parts.length) {
        const single = extractResultFromSegment(sol);
        if (single) parts.push({ label: 'Answer', md: single });
      }
    }

    if (!parts.length && q.numericAnswer && q.numericAnswer.value !== undefined && q.numericAnswer.value !== null) {
      const unit = q.numericAnswer.unit ? ` ${q.numericAnswer.unit}` : '';
      parts.push({ label: 'Answer', md: `**${q.numericAnswer.value}**${unit}` });
    }

    q._cachedFinalAnswers = parts;
    return parts;
  }

  function isMathParAutoActiveFor(q, isBlindUnfinished) {
    if (!activeRun || !q || isBlindUnfinished) return false;
    return activeRun.courseMeta?.courseId === 'math-2588'
      && activeRun.mode === 'practice'
      && isMathParAutoRevealEnabled();
  }

  function renderAnswerTrayInnerHtml(q, st, isBlindUnfinished) {
    const answers = extractFinalAnswers(q);
    if (!answers.length || isBlindUnfinished || st.revealed) return '';
    const autoOn = isMathParAutoActiveFor(q, isBlindUnfinished);
    const total = answers.length;
    const isShown = (idx) =>
      (st.peekedAnswers?.has(idx) || (autoOn && st.autoRevealedAnswers?.has(idx)))
      && !st.hiddenAnswers?.has(idx);
    const shownCount = answers.reduce((n, _, idx) => n + (isShown(idx) ? 1 : 0), 0);

    let paceNote = '';
    if (autoOn) {
      const activeSec = itemActiveSec(st);
      const targetSec = Math.max(30, Number(st.targetSec) || 180);
      let nextIdx = -1;
      for (let i = 0; i < total; i++) {
        if (!st.autoRevealedAnswers?.has(i)) { nextIdx = i; break; }
      }
      if (nextIdx >= 0) {
        const nextAt = Math.round(((nextIdx + 1) / total) * targetSec);
        const rem = Math.max(0, nextAt - activeSec);
        paceNote = `<span class="ans-tray-pace">Par auto-reveal · ${esc(answers[nextIdx].label)} in ${clockSec(rem)}</span>`;
      } else {
        paceNote = `<span class="ans-tray-pace is-done">Par auto-reveal · all ${total} unlocked</span>`;
      }
    }

    return `
      <div class="ans-tray-head">
        <div class="ans-tray-title">
          <strong>Final answers</strong>
          <small>No steps · zero penalty</small>
          ${paceNote}
        </div>
        <div class="ans-tray-actions">
          <button type="button" class="mini-tool-btn" data-ans-bulk="${shownCount < total ? 'all' : 'none'}">
            ${shownCount < total ? 'Reveal all' : 'Hide all'}
          </button>
        </div>
      </div>
      <div class="ans-chip-list">
        ${answers.map((part, idx) => {
          const visible = isShown(idx);
          const isAuto = Boolean(autoOn && st.autoRevealedAnswers?.has(idx) && !st.peekedAnswers?.has(idx));
          return `<button type="button" class="ans-chip ${visible ? 'is-revealed' : 'is-hidden'} ${isAuto ? 'is-auto' : ''}" data-ans-idx="${idx}" aria-pressed="${visible ? 'true' : 'false'}" title="${visible ? 'Click to hide' : 'Reveal final answer only (zero penalty)'}">
            <span class="ans-chip-lbl">${esc(part.label)}</span>
            ${visible
              ? `<span class="ans-chip-val">${renderMarkdownWithMath(part.md)}</span>`
              : `<span class="ans-chip-mask">Reveal answer</span>`}
          </button>`;
        }).join('')}
      </div>
    `;
  }

  function refreshAnswerTrayInPlace(q, st) {
    if (!activeRun || !q || !st) return;
    const isBlindUnfinished = activeRun.examStyle === 'blind' && !activeRun.paperSubmitted;
    const answers = extractFinalAnswers(q);
    const tray = document.getElementById('runner-answer-tray');
    const toggleBtn = document.getElementById('btn-toggle-answers');
    if (!tray) return;

    if (!answers.length || isBlindUnfinished || st.revealed) {
      tray.hidden = true;
      tray.innerHTML = '';
      if (toggleBtn) toggleBtn.hidden = true;
      return;
    }

    const autoOn = isMathParAutoActiveFor(q, isBlindUnfinished);
    const shownCount = answers.reduce((n, _, idx) => {
      const vis = (st.peekedAnswers?.has(idx) || (autoOn && st.autoRevealedAnswers?.has(idx))) && !st.hiddenAnswers?.has(idx);
      return n + (vis ? 1 : 0);
    }, 0);

    if (toggleBtn) {
      toggleBtn.hidden = false;
      toggleBtn.classList.toggle('active', Boolean(st.answerTrayOpen));
      toggleBtn.setAttribute('aria-expanded', st.answerTrayOpen ? 'true' : 'false');
      toggleBtn.textContent = shownCount > 0 ? `Answers (${shownCount}/${answers.length})` : 'Answers';
    }

    tray.hidden = !st.answerTrayOpen;
    if (st.answerTrayOpen) {
      tray.innerHTML = renderAnswerTrayInnerHtml(q, st, isBlindUnfinished);
    }
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

  // ---------------------------------------------------------------------------
  // PAPER / CLIPBOARD IMAGE ATTACHMENTS (IndexedDB vault — zero localStorage bloat)
  // ---------------------------------------------------------------------------
  const DRAFT_IMG_DB = 'study-os-draft-images-v1';
  const DRAFT_IMG_STORE = 'images';
  const MAX_DRAFT_IMAGES = 8;
  const draftImgDataCache = new Map(); // id -> dataUrl

  function openDraftImgDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DRAFT_IMG_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DRAFT_IMG_STORE)) {
          const store = db.createObjectStore(DRAFT_IMG_STORE, { keyPath: 'id' });
          store.createIndex('qid', 'qid', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open image store'));
    });
  }

  async function saveDraftImageRecord(rec) {
    draftImgDataCache.set(rec.id, rec.dataUrl);
    try {
      const db = await openDraftImgDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DRAFT_IMG_STORE, 'readwrite');
        tx.objectStore(DRAFT_IMG_STORE).put(rec);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {}
    return rec;
  }

  async function loadDraftImageDataUrl(id) {
    if (!id) return '';
    if (draftImgDataCache.has(id)) return draftImgDataCache.get(id);
    try {
      const db = await openDraftImgDb();
      const row = await new Promise((resolve, reject) => {
        const tx = db.transaction(DRAFT_IMG_STORE, 'readonly');
        const req = tx.objectStore(DRAFT_IMG_STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      db.close();
      if (row?.dataUrl) {
        draftImgDataCache.set(id, row.dataUrl);
        return row.dataUrl;
      }
    } catch {}
    return '';
  }

  async function deleteDraftImageRecord(id) {
    draftImgDataCache.delete(id);
    try {
      const db = await openDraftImgDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DRAFT_IMG_STORE, 'readwrite');
        tx.objectStore(DRAFT_IMG_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {}
  }

  async function compressImageBlobToRecord(blob, qid, fileName = '') {
    const dataUrlRaw = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.readAsDataURL(blob);
    });
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Unsupported image format'));
      el.src = dataUrlRaw;
    });
    const MAX_DIM = 1600;
    let w = img.naturalWidth || img.width || 1;
    let h = img.naturalHeight || img.height || 1;
    if (w > MAX_DIM || h > MAX_DIM) {
      const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const mime = 'image/jpeg';
    const dataUrl = canvas.toDataURL(mime, 0.84);
    const approxBytes = Math.round((dataUrl.length * 3) / 4);
    const id = `dimg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      id,
      qid: String(qid || ''),
      name: String(fileName || `paper-work-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.jpg`).slice(0, 80),
      mime,
      width: w,
      height: h,
      bytes: approxBytes,
      addedAt: new Date().toISOString(),
      dataUrl,
    };
  }

  function openDraftImageLightbox(dataUrl, caption = '') {
    if (!dataUrl) return;
    let dlg = document.getElementById('draft-img-lightbox');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'draft-img-lightbox';
      dlg.className = 'draft-img-lightbox';
      dlg.innerHTML = `
        <div class="draft-lb-head">
          <span id="draft-lb-cap" class="muted"></span>
          <button type="button" class="mini-tool-btn" id="draft-lb-close">Close (Esc)</button>
        </div>
        <div class="draft-lb-body"><img id="draft-lb-img" alt="Attached paper work"></div>
      `;
      document.body.appendChild(dlg);
      dlg.querySelector('#draft-lb-close')?.addEventListener('click', () => dlg.close());
      dlg.addEventListener('click', (ev) => {
        if (ev.target === dlg) dlg.close();
      });
    }
    const imgEl = dlg.querySelector('#draft-lb-img');
    const capEl = dlg.querySelector('#draft-lb-cap');
    if (imgEl) imgEl.src = dataUrl;
    if (capEl) capEl.textContent = caption || 'Attached paper working';
    if (!dlg.open) dlg.showModal();
  }

  // Expose clean reader API for future OCR / AI vision grading pipelines
  window.StudyDraftMedia = {
    getImageDataUrl: loadDraftImageDataUrl,
    async getImagesForQuestion(qid) {
      const rec = window.StudyApp?.getProgressRecord?.(qid) || {};
      const metas = Array.isArray(rec.savedDraftImages) ? rec.savedDraftImages : [];
      const out = [];
      for (const m of metas) {
        const dataUrl = await loadDraftImageDataUrl(m.id);
        if (dataUrl) out.push({ ...m, dataUrl });
      }
      return out;
    },
  };

  function hasAnyAnswerEntered(q, st) {
    if (q.kind === 'mcq') return st.choice !== null && st.choice !== undefined;
    if (Array.isArray(q.wiseflowFields) && q.wiseflowFields.length) {
      return Object.values(st.wiseflow || {}).some((v) => String(v ?? '').trim() !== '') || Boolean(st.draftImages?.length);
    }
    return Boolean((st.draft || '').trim() || (st.numericInput || '').trim() || (st.draftImages?.length));
  }

  // ---------------------------------------------------------------------------
  // ITEM & RUN STATE
  // ---------------------------------------------------------------------------
  function itemState(qid) {
    if (!activeRun.items[qid]) {
      const q = activeRun.questionsById[qid];
      const rec = window.StudyApp.getProgressRecord(qid) || {};
      const canRestoreWork = !activeRun.freshExamSit;
      const savedWork = canRestoreWork ? (window.StudyApp.getLatestSavedWork?.(qid) || {}) : {};
      const resumeStructured = canRestoreWork && (
        activeRun.mode === 'exam'
        || (rec.status !== 'done' && (rec.status === 'in_progress' || (!rec.lastAttemptAt && !rec.attemptCount && !rec.pbEffectiveSec)))
      );
      const prof = activeRun.profile || 'learning';
      const pSpec = q?.pacing?.[prof] || q?.pacing?.learning || { target: 3, min: 2, max: 5 };
      const calPar = window.StudyApp.calibratedParSec
        ? window.StudyApp.calibratedParSec(q, prof)
        : Math.max(15, Math.round((Number(pSpec.target) || 3) * 60));
      const restoredRubrics = Array.isArray(rec.checkedRubricIndices) && rec.checkedRubricIndices.length
        ? rec.checkedRubricIndices
        : (Array.isArray(savedWork.checkedRubrics) ? savedWork.checkedRubrics : []);
      activeRun.items[qid] = {
        elapsedMs: 0,
        runningSince: null,
        targetSec: calPar,
        minSec: Math.max(15, Math.round(calPar * 0.65)),
        maxSec: Math.round(calPar * 1.55),
        stuckSec: Math.max(45, Math.min(Math.round((Number(q?.pacing?.stuckMinutes) || 2) * 60), Math.round(calPar * 1.2))),
        handicapPerHintSec: Number(q?.pacing?.hintHandicapSeconds ?? 30),
        hintsUsed: 0,
        refUsed: false,
        refOpenCount: 0,
        refSec: 0,
        refLastTickMs: null,
        choice: resumeStructured ? (rec.savedChoice ?? savedWork.choice ?? null) : null,
        draft: canRestoreWork ? (rec.savedDraft || savedWork.draft || '') : '',
        draftImages: canRestoreWork && Array.isArray(rec.savedDraftImages) ? [...rec.savedDraftImages] : [],
        wiseflow: resumeStructured ? { ...(savedWork.wiseflow || {}), ...(rec.savedWiseflow || {}) } : {},
        wfGrade: null,
        numericInput: '',
        checkedRubrics: resumeStructured ? [...restoredRubrics] : [],
        flagged: false,
        revealed: false,
        solutionPeeked: false,
        earlyPeekConfirmed: false,
        answerTrayOpen: false,
        peekedAnswers: new Set(),
        autoRevealedAnswers: new Set(),
        hiddenAnswers: new Set(),
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
        inlineRefMode: 'needed',
        inlineRefShowBg: false,
        inlineRefTocOpen: false,
        inlineRefFilter: '',
        inlineRefRel: null,
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
    if (isIdeCodingFocusExempt()) return;
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
      window.StudyApp.flushPendingDrafts?.();
      const q = currentQuestion();
      if (q) closePauseRecord(itemState(q.id), 1.5);
      pauseCurrentTimer();
      if (activeRun.mode === 'exam' && !activeRun.examBreakStartedMs) {
        activeRun.examBreakStartedMs = Date.now();
        activeRun.examBreakCount = (activeRun.examBreakCount || 0) + 1;
      }
      tickLiveClocks();
    } else {
      if (activeRun.examBreakStartedMs) {
        activeRun.examBreakSec =
          (activeRun.examBreakSec || 0) + Math.max(0, Math.round((Date.now() - activeRun.examBreakStartedMs) / 1000));
        activeRun.examBreakStartedMs = null;
      }
      if (!endedSession && !document.getElementById('view-runner')?.hidden) {
        activeRun.consecutiveMisses = 0;
        resumeCurrentTimer();
        renderRunner();
      }
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

    if (activeRun) {
      window.StudyApp.flushPendingDrafts?.();
      pauseCurrentTimer();
    }
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
      index: Math.max(0, Math.min(validIds.length - 1, Number(config.startIndex) || 0)),
      mode: isExam ? 'exam' : 'practice',
      examStyle,
      examCollectionId: config.examCollectionId || '',
      examTitle: config.examTitle || '',
      examBudgetSec,
      freshExamSit: Boolean(config.freshExamSit ?? (isExam && examStyle === 'blind')),
      paperSubmitted: false,
      paperScoreSummary: null,
      examResultRecorded: false,
      examBreakCount: 0,
      examBreakSec: 0,
      examBreakStartedMs: null,
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
    window.StudyPdf?.warm?.();

    document.getElementById('global-header').hidden = true;
    document.getElementById('runner-header').hidden = false;
    syncRunnerStickyOffset();
    window.StudyApp.showRawView('runner');

    enterQuestion(activeRun.index);
    tickInterval = setInterval(tickLiveClocks, 250);
  }

  function enterQuestion(newIndex) {
    if (!activeRun) return;
    window.StudyApp.flushPendingDrafts?.();
    pauseCurrentTimer();
    activeRun.index = Math.max(0, Math.min(activeRun.questionIds.length - 1, newIndex));
    resumeCurrentTimer();
    renderRunner();
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (window.StudyUI.isReferenceDrawerOpen?.()) {
      const q = currentQuestion();
      if (q) {
        window.StudyUI.syncReferenceDrawerForQuestion?.(activeRun.courseMeta, q, activeRun.bank);
      } else {
        window.StudyUI.closeReferenceDrawer?.();
      }
    }
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
        out.push({ ...entry, courseId: q.courseId, sourceId: a.sourceId, questionId: q.id, questionTitle: q.title, isSolution: isSol });
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
      addFromAsset({ sourceId: q.sourceId, page: Number(q.sourcePage) || 1, caption: sourcesMap[q.sourceId].title || '' }, false);
    }
    if (includeSolutionPdfs && !isBlindUnfinished) {
      for (const a of q.solutionAssets || []) addFromAsset(a, true);
      if (q.solutionSourceId && sourcesMap?.[q.solutionSourceId]) {
        addFromAsset({ sourceId: q.solutionSourceId, page: Number(q.solutionPage) || 1, caption: `Solution · ${sourcesMap[q.solutionSourceId].title || ''}` }, true);
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
          courseId: q.courseId,
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
            <span class="pdf-inline-title" title="${esc(entry.label)}">${esc(entry.label)}</span>
            <span class="row-actions pdf-inline-controls">
              <span class="pdf-inline-pager" data-inline-pager hidden>
                <button type="button" class="mini-tool-btn" data-inline-prev aria-label="Previous page" disabled>‹</button>
                <span class="pdf-inline-page-lbl" data-inline-page-lbl>${esc(entry.page || 1)}</span>
                <button type="button" class="mini-tool-btn" data-inline-next aria-label="Next page" disabled>›</button>
              </span>
              <button type="button" class="mini-tool-btn" data-inline-crop-toggle hidden>Full page</button>
              <button type="button" class="mini-tool-btn" data-inline-invert title="Invert PDF colors (dark mode)" aria-label="Invert PDF colors">◐</button>
              ${window.StudyPdfCraft?.isAvailable?.() ? `<button type="button" class="mini-tool-btn pdf-edit-craft-btn" data-edit-inline-pdf="${esc(entry.key)}" title="Edit, highlight, annotate, sign, or OCR in PdfCraft (pure Rust WASM)">Edit</button>` : ''}
              <button type="button" class="mini-tool-btn" data-open-inline-pdf="${esc(entry.key)}" data-open-inline-page="${esc(entry.page || 1)}" title="Open full multi-page PDF reader (p.${esc(entry.page || 1)})" aria-label="Open full PDF">⤢</button>
            </span>
          </figcaption>
          <p class="muted pdf-status pdf-inline-loading" data-pdf-status role="status" hidden></p>
          <div class="pdf-zoom-scroll pdf-figure-scroll" tabindex="0" aria-label="PDF preview — click for fullscreen or pinch to zoom" title="Click for fullscreen · Pinch trackpad to zoom">
            <button type="button" class="pdf-zoom-reset-badge" data-pdf-zoom-reset hidden title="Reset zoom to 100%">100%</button>
            <div class="pdf-zoom-page"><canvas aria-hidden="true"></canvas><div class="textLayer"></div></div>
          </div>
        </figure>`;
      })
      .join('');
    return { html, mountItems };
  }

  function prefetchUpcomingRunPdfs(currentQ, isBlindUnfinished) {
    if (!activeRun || !window.StudyPdf?.prefetch) return;
    const sourcesMap = activeRun.bank.sources || {};
    const toPrefetch = [];
    const seenKeys = new Set();
    const pushUnique = (entries) => {
      for (const s of entries) {
        if (!s || !s.isPdf || seenKeys.has(s.key)) continue;
        seenKeys.add(s.key);
        toPrefetch.push(s);
        if (toPrefetch.length >= 3) break;
      }
    };
    // 1. Pre-render next 2 questions' prompt PDFs so pressing Next is 0ms instant
    for (let step = 1; step <= 2 && toPrefetch.length < 3; step++) {
      const nextId = activeRun.questionIds[activeRun.index + step];
      const nextQ = nextId ? activeRun.questionsById[nextId] : null;
      if (!nextQ) continue;
      const nextPdfs = getQuestionSourcePdfs(nextQ, sourcesMap, isBlindUnfinished, false);
      pushUnique(nextPdfs.filter((p) => p.isPdf && !p.isSolution));
    }
    // 2. Also warm current question's solution PDF if unlocked (so Reveal Solution is 0ms instant)
    if (!isBlindUnfinished && currentQ && toPrefetch.length < 3) {
      const withSol = getQuestionSourcePdfs(currentQ, sourcesMap, false, true);
      pushUnique(withSol.filter((p) => p.isPdf && p.isSolution));
    }
    if (toPrefetch.length) {
      const leftPane = document.querySelector('.runner-pane-left');
      window.StudyPdf.prefetch(toPrefetch, { inline: true, targetWidth: leftPane?.clientWidth || 720 });
    }
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
      const hasCanvasFileId = Boolean(c.canvasCourseId && c.canvasFileId);
      const canDirectFetch = hasExtBridge && hasCanvasFileId;
      const fetchKey = hasCanvasFileId ? `${c.canvasCourseId}:${c.canvasFileId}` : '';
      const isFetching = Boolean(fetchKey && autoCanvasFetchInFlight.has(fetchKey));
      const fetchErr = fetchKey ? autoCanvasFetchFailed.get(fetchKey) || '' : '';
      const pagesSummary = [...new Set(canvasRefs.map((x) => `p. ${x.page || 1}`))].join(', ');
      const fileChips = canvasRefs.slice(0, 4).map((r) =>
        `<span class="badge">${esc(r.filename || r.title)}${r.page ? ` · p. ${r.page}` : ''}</span>`
      ).join('');
      const canUnlockWithCode = Boolean(window.StudyMembers?.enabled && !window.StudyMembers.isUnlocked());
      if (compact) {
        if (isFetching) {
          return `<div class="source-gate-card source-gate-compact source-gate-canvas is-loading">
            <div class="source-gate-copy">
              <strong>Loading ${esc(c.filename || c.title)} (${esc(pagesSummary)})…</strong>
              <small class="muted">Pulling privately from your signed-in BI Canvas session in Chrome — will pop up inline automatically.</small>
            </div>
          </div>`;
        }
        const compactTitle = fetchErr
          ? 'Sign in to BI Canvas to auto-load inline'
          : canDirectFetch
          ? 'Load BI Canvas PDF inline'
          : isSynced && !hasCanvasFileId
          ? `Attach ${esc(c.filename || c.title)} for inline view`
          : isSynced
          ? 'BI Canvas synced · Open PDF or drop for inline view'
          : 'Sign in with access code or sync Canvas to view source PDF';
        const compactSub = fetchErr
          ? esc(fetchErr)
          : canDirectFetch
          ? 'Loads straight from your signed-in Chrome BI Canvas session — stays private in your browser.'
          : isSynced && !hasCanvasFileId
          ? 'This exam PDF is not stored under a direct Canvas file ID — drop your copy here, open Canvas Files, or unlock with an access code.'
          : isSynced
          ? 'Open directly on BI Canvas, drop your downloaded PDF here, or reload Study-OS Sync v1.6 in Chrome for auto-inline loading.'
          : 'Course PDFs &amp; slides stay copyright-safe. Unlock with your class access code, sync Canvas, or drop your own PDF copy.';
        return `<div class="source-gate-card source-gate-compact source-gate-canvas" data-local-dropzone data-course-id="${esc(q.courseId)}" data-source-id="${esc(c.sourceId)}" data-source-kind="canvas" data-source-title="${esc(c.title)}" data-source-page="${esc(c.page || 1)}">
          <div class="source-gate-copy">
            <strong>${compactTitle}</strong>
            <small class="muted">${esc(c.filename || c.title)} (${esc(pagesSummary)}) · ${compactSub}</small>
          </div>
          <div class="row-actions">
            ${canDirectFetch
              ? `<button type="button" class="primary-btn" style="padding:6px 12px;font-size:12.5px" data-fetch-canvas-pdf data-course-id="${esc(q.courseId)}" data-source-id="${esc(c.sourceId)}" data-canvas-course="${esc(c.canvasCourseId)}" data-canvas-file="${esc(c.canvasFileId)}" data-canvas-url="${esc(c.canvasUrl || '')}" data-source-title="${esc(c.title)}" data-source-page="${esc(c.page || 1)}">${fetchErr ? 'Retry inline' : 'Load PDF inline'}</button>`
              : canUnlockWithCode && !isSynced
              ? `<button type="button" class="primary-btn" style="padding:6px 12px;font-size:12.5px" data-open-member-unlock>Unlock with code</button>`
              : isSynced && c.canvasUrl
              ? `<a class="primary-btn" style="padding:6px 12px;font-size:12.5px;text-decoration:none" href="${esc(c.canvasUrl)}" target="_blank" rel="noopener">Open on BI Canvas ↗</a>`
              : `<button type="button" class="primary-btn" style="padding:6px 12px;font-size:12.5px" data-open-bi-sync>Sync BI Canvas</button>`}
            ${canUnlockWithCode && isSynced ? `<button type="button" class="ghost-btn" style="padding:6px 10px;font-size:12.5px" data-open-member-unlock>Access code</button>` : ''}
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

  async function ensureInlineRefLoaded(q, st, customFile = '', customHeading = null, opts = {}) {
    const obs = activeRun?.courseMeta?.obsidian || {};
    const targetFile = customFile || st.inlineRefFile || q.obsidianLink?.file || obs.mainReference || '';
    const requestedMode = opts.mode || (customHeading !== null ? 'section' : (st.inlineRefMode || 'needed'));
    const targetHeading = requestedMode === 'section'
      ? (customHeading !== null ? customHeading : (st.inlineRefHeading || q.obsidianLink?.heading || ''))
      : '';
    if (!targetFile) {
      st.inlineRefData = { available: false, error: 'No Obsidian reference configured for this course.' };
      return;
    }
    const cacheSig = `${targetFile}::${requestedMode}::${targetHeading}::${st.inlineRefShowBg ? 'bg' : 'core'}`;
    if (st.inlineRefData?.available && st.inlineRefCacheSig === cacheSig) {
      return;
    }
    st.inlineRefFile = targetFile;
    st.inlineRefMode = requestedMode;
    st.inlineRefHeading = targetHeading;
    st.inlineRefLoading = true;
    try {
      const fetchSec = async (f, h) => window.StudyApp?.fetchReferenceSection
        ? window.StudyApp.fetchReferenceSection(f, h)
        : (await fetch(`/api/obsidian/section?file=${encodeURIComponent(f)}&heading=${encodeURIComponent(h)}`)).json();

      // Load TOC metadata (instant from cache in static mode)
      let baseData = await fetchSec(targetFile, requestedMode === 'section' ? targetHeading : '');
      if (!baseData?.available) {
        st.inlineRefData = baseData || { available: false, error: 'Could not load Obsidian section.' };
        st.inlineRefCacheSig = cacheSig;
        return;
      }

      const toc = baseData.toc || [];
      const rel = window.StudyUI.findRelevantReferenceHeadings
        ? window.StudyUI.findRelevantReferenceHeadings(q, activeRun.courseMeta, toc, activeRun.bank)
        : { primaryHeading: '', primaryChapterLine: null, primaryChapterTitle: '', coreHeadings: [], backgroundHeadings: [], relatedHeadings: new Set(), relatedChapterLines: new Set(), backgroundSet: new Set() };
      st.inlineRefRel = rel;

      if (requestedMode === 'needed' && rel.coreHeadings.length > 0 && window.StudyApp?.fetchReferenceSections) {
        const list = st.inlineRefShowBg ? [...rel.coreHeadings, ...rel.backgroundHeadings] : rel.coreHeadings;
        const bundle = await window.StudyApp.fetchReferenceSections(targetFile, list);
        if (bundle?.available && bundle.sections?.length) {
          st.inlineRefData = {
            available: true,
            toc: bundle.toc || toc,
            mode: 'needed',
            sections: bundle.sections.map((s) => ({ ...s, isBackground: rel.backgroundSet.has(s.heading) })),
            selectedHeading: '',
            obsidianUri: bundle.obsidianUri || baseData.obsidianUri || '',
          };
          st.inlineRefCacheSig = cacheSig;
          return;
        }
      }

      // Single section / full chapter view (or fallback when no specific needed headings matched)
      if (requestedMode === 'needed' && rel.primaryHeading) {
        const targeted = await fetchSec(targetFile, rel.primaryHeading);
        if (targeted?.available) {
          baseData = targeted;
          st.inlineRefHeading = rel.primaryHeading;
        }
      }
      st.inlineRefMode = 'section';
      st.inlineRefData = { ...baseData, mode: 'section' };
      st.inlineRefCacheSig = `${targetFile}::section::${st.inlineRefHeading}::${st.inlineRefShowBg ? 'bg' : 'core'}`;
    } catch {
      st.inlineRefData = { available: false, error: 'Could not load Obsidian section.' };
    } finally {
      st.inlineRefLoading = false;
    }
  }

  function buildInlineRefHtml(st) {
    const q = currentQuestion();
    const refData = st.inlineRefData;
    const obs = activeRun.courseMeta?.obsidian || {};
    const noteChoices = [];
    if (obs.mainReference) noteChoices.push({ label: 'Main Reference', file: obs.mainReference });
    if (obs.workedExamples) noteChoices.push({ label: 'Worked Examples', file: obs.workedExamples });
    if (obs.practiceNote) noteChoices.push({ label: 'Practice Note', file: obs.practiceNote });
    if (st.inlineRefFile && !noteChoices.some((n) => n.file === st.inlineRefFile)) {
      noteChoices.unshift({ label: st.inlineRefFile.split('/').pop(), file: st.inlineRefFile });
    }
    const cleanTitle = window.StudyUI.cleanOutlineTitle || ((s) => s);
    const shortChip = window.StudyUI.shortSectionChipLabel || cleanTitle;
    const tocList = refData?.toc || [];
    const rel = st.inlineRefRel || (window.StudyUI.findRelevantReferenceHeadings
      ? window.StudyUI.findRelevantReferenceHeadings(q, activeRun.courseMeta, tocList, activeRun.bank)
      : { primaryHeading: '', primaryChapterLine: null, primaryChapterTitle: '', coreHeadings: [], backgroundHeadings: [], relatedHeadings: new Set(), relatedChapterLines: new Set(), backgroundSet: new Set() });

    const hasNeeded = rel.coreHeadings.length > 0;
    const inNeededMode = hasNeeded && refData?.mode === 'needed';
    const tocOpen = Boolean(st.inlineRefTocOpen);
    const activeNeededCount = rel.coreHeadings.length + (st.inlineRefShowBg ? rel.backgroundHeadings.length : 0);

    // Compact quick-jump chips in Needed mode (or active section breadcrumb when expanded past Needed)
    let jumpStripHtml = '';
    if (!tocOpen && inNeededMode && Array.isArray(refData?.sections) && refData.sections.length) {
      const chips = refData.sections
        .map((sec, idx) => `<button type="button" class="ref-jump-chip${sec.isBackground ? ' is-bg' : ''}" data-inline-stream-jump="${idx}" title="${esc(cleanTitle(sec.title || sec.heading))}">${esc(shortChip(sec.title || sec.heading))}</button>`)
        .join('');
      const bgPill = rel.backgroundHeadings.length
        ? `<button type="button" class="ref-jump-chip is-bg-toggle${st.inlineRefShowBg ? ' active' : ''}" id="btn-inline-ref-toggle-bg" title="Toggle assumed background sections">${st.inlineRefShowBg ? 'Hide assumed' : `+${rel.backgroundHeadings.length} assumed`}</button>`
        : '';
      jumpStripHtml = `<div class="ref-jump-strip">${chips}${bgPill}</div>`;
    } else if (!tocOpen && refData?.selectedHeading) {
      jumpStripHtml = `<div class="ref-jump-strip is-crumb-only"><span class="ref-current-crumb" title="${esc(cleanTitle(refData.selectedHeading))}">${esc(cleanTitle(refData.selectedHeading))}</span></div>`;
    }

    // Full-height searchable TOC overlay (replaces ugly native <select> and cramped 230px outline box)
    const noteSwitcherHtml = noteChoices.length > 1
      ? `<div class="ref-toc-note-pills" role="group" aria-label="Course notes">
           ${noteChoices.map((n) => `<button type="button" class="ref-note-pill${n.file === st.inlineRefFile ? ' active' : ''}" data-inline-ref-note="${esc(n.file)}">${esc(n.label)}</button>`).join('')}
         </div>`
      : '';
    const filterVal = st.inlineRefFilter || '';
    const fullNoteRow = !filterVal
      ? `<div class="obs-outline-leaf depth-0"><button type="button" class="obs-outline-link depth-0${refData?.mode === 'section' && !refData?.selectedHeading ? ' is-active' : ''}" data-outline-heading="" title="Read entire note"><span class="obs-outline-text">Full Note / All Chapters</span></button></div>`
      : '';
    const outlineTreeHtml = tocList.length && window.StudyUI.buildOutlineTreeHtml
      ? fullNoteRow + window.StudyUI.buildOutlineTreeHtml(tocList, {
          activeHeading: refData?.mode === 'section' ? (refData?.selectedHeading || '') : '',
          primaryHeading: rel.primaryHeading,
          primaryChapterLine: rel.primaryChapterLine,
          relatedHeadings: rel.relatedHeadings,
          relatedChapterLines: rel.relatedChapterLines,
          backgroundHeadings: rel.backgroundSet,
          filter: filterVal,
          collapsedByDefault: true,
        })
      : '<p class="muted" style="font-size:12px;padding:8px">No chapters available.</p>';

    const tocOverlayHtml = `
      <div class="ref-toc-overlay" id="inline-ref-toc-panel"${tocOpen ? '' : ' hidden'}>
        ${noteSwitcherHtml}
        <div class="ref-toc-search-row">
          <input type="search" id="inp-inline-ref-filter" class="ref-outline-filter" value="${esc(filterVal)}" placeholder="Search chapters &amp; subchapters…" aria-label="Search chapters and subchapters" autocomplete="off">
          <button type="button" class="mini-tool-btn" id="btn-inline-ref-toc-done">Done</button>
        </div>
        <div class="obs-outline-tree ref-toc-scroll" id="inline-ref-outline-tree">${outlineTreeHtml}</div>
      </div>
    `;

    let bodyInner = '';
    if (!refData) {
      bodyInner = '<p class="muted">Loading course reference…</p>';
    } else if (!refData.available) {
      bodyInner = `<p class="muted">${esc(refData.error || 'Reference unavailable.')}</p>`;
    } else if (refData.mode === 'needed' && Array.isArray(refData.sections) && window.StudyUI.renderContinuousNeededSectionsHtml) {
      bodyInner = window.StudyUI.renderContinuousNeededSectionsHtml(refData.sections, {
        backgroundHeadings: rel.backgroundHeadings,
        showBg: Boolean(st.inlineRefShowBg),
        isDrawer: false,
      });
    } else {
      bodyInner = renderMarkdownWithMath(refData.markdown || '');
    }

    return `
      <div class="reader-tabbar runner-ref-header">
        <div class="runner-ref-title-wrap">
          <span class="runner-ref-dot" aria-hidden="true"></span>
          ${
            hasNeeded
              ? `<div class="ref-mode-tabs" role="group" aria-label="Reference scope">
                   <button type="button" class="ref-mode-pill${inNeededMode && !tocOpen ? ' active' : ''}" id="btn-inline-ref-needed" title="Continuous stream of sections needed for this exercise">Needed (${activeNeededCount})</button>
                   <button type="button" class="ref-mode-pill${tocOpen ? ' active' : ''}" id="btn-inline-ref-browse" aria-expanded="${tocOpen ? 'true' : 'false'}" title="Search and browse all chapters">Search</button>
                 </div>`
              : `<strong style="font-size:12.5px">${esc(activeRun.courseMeta?.shortTitle || 'Notes')}</strong>
                 <button type="button" class="ref-mode-pill${tocOpen ? ' active' : ''}" id="btn-inline-ref-browse" aria-expanded="${tocOpen ? 'true' : 'false'}" title="Search and browse all chapters">Chapters</button>`
          }
        </div>
        <div class="reader-tools" style="gap:4px">
          ${refData?.obsidianUri ? `<a class="mini-tool-btn" href="${esc(refData.obsidianUri)}" style="text-decoration:none" title="Open in Obsidian">↗</a>` : ''}
          <button type="button" class="mini-tool-btn" data-toggle-ref-pane aria-label="Close Reference" title="Close Reference (O)">×</button>
        </div>
      </div>
      ${jumpStripHtml}
      ${tocOverlayHtml}
      <div class="runner-pane-ref-scroll"${tocOpen ? ' hidden' : ''}>
        <div class="markdown-body obs-prose">${bodyInner}</div>
      </div>
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

  function fallbackGradeFromPct(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const r = Math.round(p);
    if (p >= 85) return { letter: 'A', label: 'Excellent', cls: 'grade-a', points: 5, pct: r, toA: 0 };
    if (p >= 77) return { letter: 'B', label: 'Very Good', cls: 'grade-b', points: 4, pct: r, toA: Math.max(1, Math.ceil(85 - p)) };
    if (p >= 65) return { letter: 'C', label: 'Good', cls: 'grade-c', points: 3, pct: r, toA: Math.max(1, Math.ceil(85 - p)) };
    if (p >= 50) return { letter: 'D', label: 'Satisfactory', cls: 'grade-d', points: 2, pct: r, toA: Math.max(1, Math.ceil(85 - p)) };
    if (p >= 40) return { letter: 'E', label: 'Sufficient', cls: 'grade-e', points: 1, pct: r, toA: Math.max(1, Math.ceil(85 - p)) };
    return { letter: 'F', label: 'Fail', cls: 'grade-f', points: 0, pct: r, toA: Math.max(1, Math.ceil(85 - p)) };
  }

  const EXAM_HINT_PENALTY_PER_HINT = 0.15;   // -15% of a question's earned points per hint used during an exam
  const EXAM_REF_PENALTY_CLOSED_BOOK = 0.10; // -10% on closed-book exams if Reference was consulted before reveal
  const EXAM_HINT_PENALTY_MAX = 0.45;        // cap combined hint + reference credit reduction at -45% per question

  function isOpenBookExamCourse(courseMeta) {
    if (!courseMeta) return false;
    if (courseMeta.courseId === 'prog-3021') return true;
    return /home\s*exam|open[- ]?book/i.test(String(courseMeta.examInfo?.format || ''));
  }

  function markQuestionRefOpened(q, st, explicit = false) {
    if (!activeRun || activeRun.mode !== 'exam' || !q || !st) return;
    if (st.revealed) return; // Reviewing notes after revealing solution is never penalized
    const firstMark = !st.refUsed;
    st.refUsed = true;
    if (explicit) st.refOpenCount = (st.refOpenCount || 0) + 1;
    else st.refOpenCount = Math.max(1, st.refOpenCount || 0);
    if (firstMark) {
      const openBook = isOpenBookExamCourse(activeRun.courseMeta);
      toast(
        openBook
          ? 'Reference opened · Tracked on exam attempt (open-book exam, 0% penalty)'
          : `Reference opened · Tracked on exam grade (-${Math.round(EXAM_REF_PENALTY_CLOSED_BOOK * 100)}% credit on this Q)`
      );
    }
    if (activeRun.paperSubmitted || activeRun.examStyle === 'guided') {
      activeRun.paperScoreSummary = recomputeExamRunGrade({ includeUnverifiedAsZero: Boolean(activeRun.paperSubmitted) });
    }
    const isBlindUnfinished = activeRun.examStyle === 'blind' && !activeRun.paperSubmitted;
    renderRunnerNotice(isBlindUnfinished);
  }

  function countActiveRunAids() {
    if (!activeRun) return { hintsTotal: 0, hintedQCount: 0, refQCount: 0, refTotalSec: 0 };
    let hintsTotal = 0;
    let hintedQCount = 0;
    let refQCount = 0;
    let refTotalSec = 0;
    for (const qid of activeRun.questionIds) {
      const st = activeRun.items[qid];
      if (!st) continue;
      const h = Math.max(0, Number(st.hintsUsed || 0), Number(st.loggedAttempt?.hintsUsed || 0));
      if (h > 0) {
        hintsTotal += h;
        hintedQCount += 1;
      }
      const rUsed = Boolean(st.refUsed || st.loggedAttempt?.refUsed);
      const rSec = Math.max(0, Number(st.refSec || 0), Number(st.loggedAttempt?.refSec || 0));
      if (rUsed) refQCount += 1;
      refTotalSec += rSec;
    }
    return { hintsTotal, hintedQCount, refQCount, refTotalSec: Math.round(refTotalSec) };
  }

  function recomputeExamRunGrade({ includeUnverifiedAsZero = false } = {}) {
    if (!activeRun) return null;
    const openBookExam = isOpenBookExamCourse(activeRun.courseMeta);
    let earnedPts = 0;
    let rawEarnedPts = 0;
    let hintPenaltyPts = 0;
    let refPenaltyPts = 0;
    let totalPts = 0;
    let gradedPts = 0;
    let gradedCount = 0;
    let autoCount = 0;
    let rubricCount = 0;
    let manualRemaining = 0;
    let hintsTotal = 0;
    let hintedQCount = 0;
    let refQCount = 0;
    let refTotalSec = 0;

    for (const qid of activeRun.questionIds) {
      const q = activeRun.questionsById[qid];
      if (!q) continue;
      const st = itemState(qid);
      const qPts = Number(q.points || (q.kind === 'mcq' ? 2 : 10));
      totalPts += qPts;

      const qHints = Math.max(0, Number(st.hintsUsed || 0), Number(st.loggedAttempt?.hintsUsed || 0));
      if (qHints > 0) {
        hintsTotal += qHints;
        hintedQCount += 1;
      }
      const qRefUsed = Boolean(st.refUsed || st.loggedAttempt?.refUsed);
      const qRefSec = Math.max(0, Number(st.refSec || 0), Number(st.loggedAttempt?.refSec || 0));
      if (qRefUsed) refQCount += 1;
      refTotalSec += qRefSec;

      const hintFrac = qHints * EXAM_HINT_PENALTY_PER_HINT;
      const refFrac = !openBookExam && qRefUsed ? EXAM_REF_PENALTY_CLOSED_BOOK : 0;
      const totalAidFrac = Math.min(EXAM_HINT_PENALTY_MAX, hintFrac + refFrac);
      const aidFactor = 1 - totalAidFrac;

      const isMcq = q.kind === 'mcq';
      const isWf = Array.isArray(q.wiseflowFields) && q.wiseflowFields.length > 0;
      const isAuto = isMcq || isWf;
      if (isAuto) autoCount += 1;
      else rubricCount += 1;

      let acc = null;
      if (st.loggedAttempt && Number.isFinite(Number(st.loggedAttempt.qualityAccuracy))) {
        acc = Math.max(0, Math.min(1, Number(st.loggedAttempt.qualityAccuracy)));
      } else if (isMcq && (st.revealed || activeRun.paperSubmitted)) {
        acc = st.choice !== null && st.choice === q.answerIndex ? 1.0 : 0.0;
      } else if (isWf && (st.wfGrade || activeRun.paperSubmitted)) {
        const g = st.wfGrade || evaluateWiseflowSheet(q, st);
        acc = Math.max(0, Math.min(1, Number(g.accuracy || 0)));
      } else if (!isAuto && st.revealed && Array.isArray(st.checkedRubrics) && st.checkedRubrics.length > 0) {
        const totalChecks = Math.max(1, (q.rubricChecks || []).length || 3);
        acc = Math.min(1, st.checkedRubrics.length / totalChecks);
      }

      if (acc !== null) {
        const rawQ = acc * qPts;
        const adjQ = rawQ * aidFactor;
        const lostQ = rawQ - adjQ;
        const sumFrac = hintFrac + refFrac;
        const lostHint = sumFrac > 0 ? lostQ * (hintFrac / sumFrac) : 0;
        const lostRef = sumFrac > 0 ? lostQ * (refFrac / sumFrac) : 0;
        rawEarnedPts += rawQ;
        earnedPts += adjQ;
        hintPenaltyPts += lostHint;
        refPenaltyPts += lostRef;
        gradedPts += qPts;
        gradedCount += 1;
      } else if (!isAuto) {
        manualRemaining += 1;
      }
    }

    const totalCount = activeRun.questionIds.length;
    const denom = includeUnverifiedAsZero ? totalPts : (gradedPts || totalPts);
    const rawPct = denom > 0 ? Math.max(0, Math.min(100, (rawEarnedPts / denom) * 100)) : 0;
    const pct = denom > 0 ? Math.max(0, Math.min(100, (earnedPts / denom) * 100)) : 0;
    const grade = window.StudyApp?.gradeFromPct?.(pct) || fallbackGradeFromPct(pct);
    const rawGrade = window.StudyApp?.gradeFromPct?.(rawPct) || fallbackGradeFromPct(rawPct);
    const gradingKind = rubricCount === 0 ? 'auto' : autoCount === 0 ? 'rubric' : 'mixed';
    const liveBreakSec =
      Number(activeRun.examBreakSec || 0)
      + (activeRun.examBreakStartedMs ? Math.max(0, Math.round((Date.now() - activeRun.examBreakStartedMs) / 1000)) : 0);
    return {
      earnedPts,
      rawEarnedPts,
      hintPenaltyPts,
      refPenaltyPts,
      totalPts,
      gradedPts,
      gradedCount,
      totalCount,
      manualCount: manualRemaining,
      pct,
      rawPct,
      grade,
      rawGrade,
      gradingKind,
      hintsTotal,
      hintedQCount,
      refQCount,
      refTotalSec: Math.round(refTotalSec),
      openBookExam,
      cleanRun: hintsTotal === 0 && (openBookExam || refQCount === 0),
      breaksCount: Number(activeRun.examBreakCount || 0),
      breakSec: liveBreakSec,
      durationSec: Math.round(totalExamActiveSec()),
    };
  }

  function persistExamRunGradeIfReady(force = false) {
    if (!activeRun || activeRun.mode !== 'exam') return null;
    const colId = activeRun.examCollectionId;
    if (!colId || colId === 'randomized-mock') return null;
    const summary = recomputeExamRunGrade({ includeUnverifiedAsZero: Boolean(activeRun.paperSubmitted) });
    if (!summary || !summary.gradedCount) return null;
    const isCompleteSit = Boolean(
      (activeRun.paperSubmitted && summary.manualCount === 0)
      || summary.gradedCount >= summary.totalCount
    );
    const ready = force || isCompleteSit;
    if (!ready) return summary;
    window.StudyApp?.recordExamResult?.(activeRun.courseMeta.courseId, colId, {
      ...summary,
      sessionId: activeRun.sessionId,
      examStyle: activeRun.examStyle,
      complete: isCompleteSit,
      incrementAttempt: !activeRun.examResultRecorded,
    });
    activeRun.examResultRecorded = true;
    return summary;
  }

  function renderRunnerNotice(isBlindUnfinished) {
    const notice = document.getElementById('runner-notice');
    const score = activeRun.paperScoreSummary;
    const suggestBreak = activeRun.mode === 'practice' && activeRun.consecutiveMisses >= 2;
    const liveAids = activeRun.mode === 'exam' ? countActiveRunAids() : { hintsTotal: 0, hintedQCount: 0, refQCount: 0, refTotalSec: 0 };
    const openBookExam = isOpenBookExamCourse(activeRun.courseMeta);
    const breaksCount = Number(activeRun.examBreakCount || 0);

    if (isBlindUnfinished) {
      const { answeredCount, total } = computeRunSummary();
      const flagged = Object.values(activeRun.items).filter((item) => item.flagged).length;
      const bits = [
        `${answeredCount} / ${total} answered`,
        flagged ? `${flagged} flagged` : '',
        liveAids.hintsTotal > 0
          ? `💡 ${liveAids.hintsTotal} hint${liveAids.hintsTotal === 1 ? '' : 's'} tracked`
          : '',
        liveAids.refQCount > 0
          ? `📖 Ref: ${liveAids.refQCount} Q${liveAids.refQCount === 1 ? '' : 's'}${openBookExam ? '' : ' (-10%/Q)'}`
          : '',
        breaksCount > 0 ? `☕ ${breaksCount} break${breaksCount === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      notice.textContent = bits.join(' · ');
    } else if (score && score.totalPts > 0 && score.gradedCount > 0) {
      const g = score.grade || fallbackGradeFromPct(score.pct);
      const star = g.letter === 'A' ? '★ ' : '';
      const modeTag = score.gradingKind === 'auto' ? 'Auto-graded' : score.gradingKind === 'rubric' ? 'Rubric-graded' : 'Auto + Rubric';
      const pendingTag = score.manualCount > 0 ? ` · ${score.manualCount} written left` : g.toA > 0 ? ` · +${g.toA}% to A` : ' · Target A hit!';
      const hTotal = Math.max(Number(score.hintsTotal || 0), liveAids.hintsTotal);
      const hPen = Number(score.hintPenaltyPts || 0);
      const rCount = Math.max(Number(score.refQCount || 0), liveAids.refQCount);
      const rSec = Math.max(Number(score.refTotalSec || 0), liveAids.refTotalSec);
      const rPen = Number(score.refPenaltyPts || 0);
      const isCleanNow = hTotal === 0 && (openBookExam || rCount === 0);
      const aidChips = [];
      if (isCleanNow) {
        aidChips.push(`<span class="exam-hint-chip is-clean" title="${openBookExam ? '0 hints used' : '0 hints & 0 reference opens — true closed-book attempt'}">✓ Clean</span>`);
      }
      if (hTotal > 0) {
        const hQs = Math.max(1, Number(score.hintedQCount || liveAids.hintedQCount || 1));
        aidChips.push(`<span class="exam-hint-chip is-assisted" title="Raw score ${Math.round(score.rawPct ?? score.pct)}% · -${hPen.toFixed(1)} pts hint adjustment (${hTotal} hint${hTotal === 1 ? '' : 's'} across ${hQs} Q${hQs === 1 ? '' : 's'})">💡 ${hTotal} hint${hTotal === 1 ? '' : 's'}${hPen >= 0.05 ? ` (-${hPen.toFixed(1)} pts)` : ''}</span>`);
      }
      if (rCount > 0) {
        const refCls = openBookExam ? 'is-info' : 'is-assisted';
        const refTip = openBookExam
          ? `Reference consulted on ${rCount} Q${rCount === 1 ? '' : 's'} (${clockSec(rSec)}) — tracked on attempt, 0% penalty (open-book exam)`
          : `Reference consulted on ${rCount} Q${rCount === 1 ? '' : 's'} (${clockSec(rSec)}) · -${rPen.toFixed(1)} pts closed-book adjustment`;
        aidChips.push(`<span class="exam-hint-chip ${refCls}" title="${esc(refTip)}">📖 ${rCount} ref${!openBookExam && rPen >= 0.05 ? ` (-${rPen.toFixed(1)} pts)` : ''}</span>`);
      }
      const breakTag = breaksCount > 0 ? ` · ☕ ${breaksCount} break${breaksCount === 1 ? '' : 's'}` : '';
      notice.innerHTML = `<span class="exam-grade-medal is-inline ${g.cls}"><b>${star}${g.letter}</b><small>${Math.round(score.pct)}%</small></span>${aidChips.join('')}<span>${score.earnedPts.toFixed(1)} / ${score.totalPts} pts · ${modeTag}${pendingTag}${breakTag}</span>`;
    } else if (score) {
      notice.textContent = score.manualCount > 0
        ? `Paper submitted — tick your marking checklist steps (${score.manualCount} written problem${score.manualCount === 1 ? '' : 's'}) to calculate your BI grade.`
        : 'Paper submitted';
    } else if (activeRun.mode === 'exam' && (liveAids.hintsTotal > 0 || liveAids.refQCount > 0 || breaksCount > 0)) {
      const parts = [
        liveAids.hintsTotal > 0
          ? `<span class="exam-hint-chip is-assisted">💡 ${liveAids.hintsTotal} hint${liveAids.hintsTotal === 1 ? '' : 's'} tracked (-15% Q credit/hint)</span>`
          : '',
        liveAids.refQCount > 0
          ? `<span class="exam-hint-chip ${openBookExam ? 'is-info' : 'is-assisted'}">📖 Ref: ${liveAids.refQCount} Q${liveAids.refQCount === 1 ? '' : 's'}${openBookExam ? ' (open-book)' : ' (-10% Q credit)'}</span>`
          : '',
        breaksCount > 0 ? `<span>☕ ${breaksCount} break${breaksCount === 1 ? '' : 's'} taken</span>` : '',
      ].filter(Boolean);
      notice.innerHTML = parts.join('');
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
    const instantMcq = isInstantMcqEnabled(uiPrefs) && !isBlindUnfinished;

    // Guard invalid reader tab (e.g. if switched to question without PDFs or blind exam locks reference)
    if (st.readerTab === 'pdf' && !sourcePdfs.length) st.readerTab = lockedSourceRefs.length ? 'context' : 'task';
    if (st.readerTab === 'context' && !lockedSourceRefs.length) st.readerTab = sourcePdfs.length ? 'pdf' : 'task';
    if (st.readerTab === 'ref') st.readerTab = 'task';

    const isWideViewport = dockReferenceLayout.matches;
    const autoNeedsSplit = isWideViewport && needsSplitByContent(q, st);
    const preferredSplit = isWideViewport && uiPrefs.preferredLayout !== 'focus';
    const isSplit = autoNeedsSplit
      ? true
      : st.layoutOverride === 'split'
      ? true
      : st.layoutOverride === 'foveal'
      ? false
      : preferredSplit;

    const canOpenReference = Boolean(q.obsidianLink?.file ||
      activeRun.courseMeta.obsidian?.mainReference || activeRun.courseMeta.obsidian?.workedExamples ||
      activeRun.courseMeta.obsidian?.practiceNote);
    const isTriPane = isSplit && canOpenReference && dockReferenceLayout.matches && Boolean(uiPrefs.dockRefPane);
    const refButton = document.getElementById('run-ref-btn');
    refButton.hidden = !canOpenReference;
    refButton.setAttribute('aria-expanded', String(isTriPane));
    if (activeRun.mode === 'exam') {
      const ob = isOpenBookExamCourse(activeRun.courseMeta);
      refButton.title = ob
        ? 'Course Reference (O) · Tracked on exam attempt (open-book exam, 0% penalty)'
        : 'Course Reference (O) · Tracked on exam grade (-10% credit on this Q) & Metrics recall gaps';
    } else {
      refButton.title = 'Course Reference (O)';
    }
    const alButton = document.getElementById('run-al-btn');
    if (alButton) {
      alButton.hidden = isBlindUnfinished;
      alButton.setAttribute('aria-expanded', String(Boolean(window.StudyAiTutor?.isOpen?.())));
    }

    document.body.classList.toggle('runner-split-wide', isSplit);
    document.body.classList.toggle('runner-split-pdf', isSplit && st.readerTab === 'pdf');
    document.body.classList.toggle('runner-split-ref', isTriPane);
    document.body.classList.toggle('runner-foveal-compact', !isSplit);

    // Preserve left-pane, right-pane, and reference-pane scroll positions when re-rendering the same question
    const sameQuestion = activeRun.lastRenderedQid === q.id;
    const prevLeftEl = document.querySelector('.runner-pane-left-scroll');
    const prevLeftScroll = sameQuestion && prevLeftEl ? prevLeftEl.scrollTop : 0;
    const prevRightEl = document.querySelector('.runner-pane-right');
    const prevRightScroll = sameQuestion && prevRightEl ? prevRightEl.scrollTop : 0;
    const prevRefEl = document.querySelector('.runner-pane-ref-scroll');
    const prevRefScroll = sameQuestion && prevRefEl ? prevRefEl.scrollTop : 0;
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
    if (breakBtn) breakBtn.hidden = false;
    if (runObsLink) runObsLink.hidden = isBlindUnfinished || window.StudyApp?.isStaticMode();

    renderRunnerNotice(isBlindUnfinished);

    const parType = activeRun.profile === 'exam' ? 'exam' : 'learning';
    const parRange = `${minLabel(st.minSec / 60)}–${minLabel(st.maxSec / 60)}`;
    const personalBest = rec.pbEffectiveSec ? ` · Best ${clockSec(rec.pbEffectiveSec)}` : '';
    document.getElementById('run-pace-target').title = `Adamlite · ${parType} target · Typical range ${parRange}${personalBest}`;
    document.getElementById('run-pace-par').textContent = clockSec(st.targetSec);

    // Question Body / Left Reader Content
    const contextAssetsHtml = renderAssets(q.contextAssets, q.courseId, sourcesMap, isBlindUnfinished);
    const contextHtml =
      (q.contextMarkdown ? `<div class="markdown-body">${renderMarkdownWithMath(q.contextMarkdown)}</div>` : '') +
      contextAssetsHtml;

    const croppedArchivePdfs = sourcePdfs.filter(source => source.memberAsset && !source.isSolution &&
      window.StudyPdf.hasSavedExcerpt(source) &&
      (q.promptAssets || []).some(asset => asset.sourceId === source.sourceId && (asset.page || 1) === source.page));
    const promptAssets = (q.promptAssets || []).filter(asset => !croppedArchivePdfs.some(source =>
      asset.sourceId === source.sourceId && (asset.page || 1) === source.page));
    const promptAssetsHtml = renderAssets(promptAssets, q.courseId, sourcesMap, isBlindUnfinished);
    const svgHtml = q.svgDiagram ? `<div class="diagram-wrap" style="margin:14px 0">${q.svgDiagram}</div>` : '';
    const promptMdHtml = q.kind === 'coding' && q.promptMarkdown
      ? renderStructuredCodingPrompt(q, st)
      : q.promptMarkdown
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
      const renderedAssetPageKeys = new Set([
        ...(contextAssetsHtml ? (q.contextAssets || []).filter((a) => a && a.sourceId).map((a) => `${a.sourceId}:${a.page || 1}`) : []),
        ...(promptAssetsHtml ? (promptAssets || []).filter((a) => a && a.sourceId).map((a) => `${a.sourceId}:${a.page || 1}`) : []),
      ]);
      const promptPdfs = sourcePdfs.filter((source) => {
        if (source.sourceId && renderedAssetPageKeys.has(`${source.sourceId}:${source.page || 1}`)) return false;
        return croppedArchivePdfs.includes(source) || (!promptAssetsHtml && !contextAssetsHtml && source.isPdf && !source.isSolution);
      });
      // The H10 handout only lists the assigned exercises, which are already shown below.
      const hasTextbookPages = q.id === 'acct-2527:H10' && promptPdfs.some(source => source.sourceId === 'textbook-12e');
      const filteredPromptPdfs = (hasTextbookPages
        ? promptPdfs.filter(source => source.sourceId !== '203552')
        : promptPdfs).slice(0, 3);
      const inlineLocalPrompt = renderInlineLocalPdfFigures(filteredPromptPdfs);
      if (inlineLocalPrompt.mountItems.length) inlineLocalMountItems.push(...inlineLocalPrompt.mountItems);
      const rawPromptStr = String(q.promptMarkdown || '').trim();
      const hasFullTranscribedPrompt = rawPromptStr.length >= 140
        && !/\b(sheet above|pages? above|shown above|figure\s*\d|in the figure|in the graph|graph below|diagram below|table above|chart above)\b/i.test(rawPromptStr);
      const rawScanHtml = `${promptAssetsHtml}${inlineLocalPrompt.html}`;
      const scanPageCount = (promptAssets?.length || 0) + (filteredPromptPdfs?.length || 0);
      const collapsedScanHtml = rawScanHtml
        ? `<details class="orig-sheet-details">
             <summary>Original BI sheet ${scanPageCount > 1 ? `(${scanPageCount} pages)` : '(PDF / scan)'}</summary>
             <div class="orig-sheet-body">${rawScanHtml}</div>
           </details>`
        : '';
      readerBodyHtml = `
        <div class="${isExamSheet ? 'exam-paper-sheet' : ''}">
          ${headerHtml}
          ${contextHtml}
          ${hasFullTranscribedPrompt
            ? `${svgHtml}${promptMdHtml}${collapsedScanHtml}`
            : `${rawScanHtml}${svgHtml}${promptMdHtml}`}
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

    const renderDraftMediaBlock = (stObj, autoSaveTxt) => {
      const imgs = Array.isArray(stObj.draftImages) ? stObj.draftImages : [];
      const thumbsHtml = imgs.map((im) => {
        const cached = draftImgDataCache.get(im.id) || '';
        const kb = Math.max(1, Math.round((Number(im.bytes) || 0) / 1024));
        return `<div class="draft-img-thumb" data-dimg-id="${esc(im.id)}">
          <button type="button" class="draft-img-open" data-dimg-open="${esc(im.id)}" title="Click to zoom ${esc(im.name || 'image')}">
            <img data-dimg-src="${esc(im.id)}" src="${esc(cached)}" alt="${esc(im.name || 'Paper working')}">
            <span class="draft-img-meta">${kb} KB</span>
          </button>
          <button type="button" class="draft-img-del" data-dimg-del="${esc(im.id)}" aria-label="Remove image" title="Remove image">×</button>
        </div>`;
      }).join('');
      return `
        <div class="draft-images-strip" id="draft-images-strip" ${imgs.length ? '' : 'hidden'}>
          ${thumbsHtml}
        </div>
        <div class="row-between draft-foot-row">
          <span class="muted" data-study-help>${autoSaveTxt} · Paste (<kbd>⌘V</kbd>) or drop paper photos</span>
          <div class="draft-foot-right">
            <label class="mini-tool-btn draft-img-add-btn" title="Attach or paste photo of handwritten work">
              📷 Add image
              <input type="file" id="inp-draft-image-file" accept="image/*" multiple hidden>
            </label>
            <span id="lbl-word-count" class="muted">0 words</span>
          </div>
        </div>
      `;
    };

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
      const autoSaveLabel = document.documentElement.dataset.studyMode === 'web'
        ? 'Auto-saved in browser'
        : 'Auto-saved to OneDrive';
      const wfSheetHtml = renderWiseflowWorksheet(q, st);
      workspaceHtml = `
        ${wfSheetHtml}
        <details style="margin:10px 0">
          <summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--muted)">
            Working Notes (optional, auto-saved)
          </summary>
          <div style="margin-top:8px" class="draft-drop-zone" id="draft-drop-zone">
            <textarea id="inp-written-draft" style="min-height:90px" placeholder="Intermediate workings, T-accounts, or notes (paste ⌘V images of paper work)…">${esc(
              st.draft
            )}</textarea>
            ${renderDraftMediaBlock(st, autoSaveLabel)}
          </div>
        </details>
      `;
    } else if (q.kind === 'coding') {
      const autoSaveLabel = document.documentElement.dataset.studyMode === 'web'
        ? 'Auto-saved in browser'
        : 'Auto-saved to OneDrive';
      const activeIde = getPreferredCodingIde();
      const ideLabel = IDE_CONFIGS[activeIde]?.label || 'VS Code';
      const ideSynced = Boolean(st.ideActive || (floatingParWin && !floatingParWin.closed));
      const pipSupported = 'documentPictureInPicture' in window;
      const vsixHref = `${document.documentElement.dataset.studyRoot || './'}downloads/study-os-companion.vsix`;
      workspaceHtml = `
        <div class="coding-ide-card">
          <div class="coding-ide-head">
            <div>
              <strong>Code in ${esc(ideLabel)} (Jupyter)</strong>
              <span class="coding-ide-sub">Run real Python, pandas &amp; plots while Study-OS tracks AI Par live.</span>
            </div>
            <div class="coding-ide-seg" role="group" aria-label="Preferred IDE">
              <button type="button" class="coding-ide-opt ${activeIde === 'antigravity' ? 'active' : ''}" data-coding-ide="antigravity">Antigravity</button>
              <button type="button" class="coding-ide-opt ${activeIde === 'vscode' ? 'active' : ''}" data-coding-ide="vscode">VS Code</button>
              <button type="button" class="coding-ide-opt ${activeIde === 'cursor' ? 'active' : ''}" data-coding-ide="cursor">Cursor</button>
            </div>
          </div>

          <div class="coding-ide-actions">
            <button type="button" class="primary-btn" id="btn-coding-open-ide">
              ${ideSynced ? `Re-open in ${esc(ideLabel)}` : `Open in ${esc(ideLabel)}${pipSupported ? ' + Top Bar' : ''}`}
            </button>
            ${pipSupported ? `<button type="button" class="ghost-btn" id="btn-coding-float-bar" title="Pin a draggable AI-Par timer bar at the top of your screen">Top AI-Par Bar</button>` : ''}
            <button type="button" class="ghost-btn" id="btn-coding-open-ref" title="Open EBA 3400 Programming Reference & 7-Package Cheat Sheet (O)">📖 Reference Book</button>
            <button type="button" class="ghost-btn" id="btn-coding-download-ipynb" title="Download an exam-format Jupyter notebook (.ipynb) with Markdown prompt cells and Python code cells">Download .ipynb</button>
          </div>

          <div class="coding-ide-foot">
            <span class="badge live" id="coding-ide-live-pill" ${ideSynced ? '' : 'hidden'}>● IDE timer active — switching to ${esc(ideLabel)} won't pause</span>
            <details class="coding-ide-setup">
              <summary>1-time IDE Companion v0.3 setup (per-subpart CodeLens HUD + 1-click Sync)</summary>
              <div class="coding-ide-setup-body">
                <p>Install Study-OS Companion v0.3 once: clicking <em>Open in ${esc(ideLabel)}</em> builds the exam <code>.ipynb</code>, links BI CSVs, drops your cursor into Cell 1, renders a <strong>live per-subpart AI-Par CodeLens HUD right above each code cell</strong>, and adds <strong>✓ Sync to Study-OS</strong>.</p>
                <div class="row-actions" style="gap:8px;margin-top:6px">
                  <a class="ghost-btn" href="${esc(vsixHref)}" download="study-os-companion.vsix" style="text-decoration:none">Download .vsix (v0.3)</a>
                  <span class="muted" style="font-size:11.5px">In ${esc(ideLabel)}: <kbd>⌘⇧P</kbd> → <em>Extensions: Install from VSIX…</em></span>
                </div>
              </div>
            </details>
          </div>

          <details class="coding-scratchpad-details">
            <summary>Quick scratchpad / notes (optional)</summary>
            <div style="margin-top:8px" class="draft-drop-zone" id="draft-drop-zone">
              <textarea id="inp-written-draft" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;min-height:105px" placeholder="# Optional notes, pasted code, or screenshots (⌘V)...">${esc(st.draft)}</textarea>
              ${renderDraftMediaBlock(st, autoSaveLabel)}
            </div>
          </details>
        </div>
      `;
    } else {
      const autoSaveLabel = document.documentElement.dataset.studyMode === 'web'
        ? 'Auto-saved in browser'
        : 'Auto-saved to OneDrive';
      const placeholder =
        q.kind === 'calculation'
          ? 'Write your setup equation, intermediate steps, and final numerical result here (or solve on paper and record key numbers)...'
          : 'Write your structured response here before revealing the official guidance...';
      const numCheckHtml = q.numericCheck
        ? `<div class="row-actions" style="margin-bottom:10px">
            <label style="font-size:13px;font-weight:600">Numeric Answer (${esc(q.numericCheck.unit || 'value')}):
              <input type="text" id="inp-numeric-ans" value="${esc(st.numericInput)}" placeholder="Enter number" style="width:140px;margin-left:6px">
            </label>
          </div>`
        : '';
      workspaceHtml = `
        <div style="margin:10px 0" class="draft-drop-zone" id="draft-drop-zone">
          ${numCheckHtml}
          <textarea id="inp-written-draft" style="min-height:${isSplit ? '210px' : '135px'}" placeholder="${esc(placeholder)}">${esc(st.draft)}</textarea>
          ${renderDraftMediaBlock(st, autoSaveLabel)}
        </div>
      `;
    }

    // Hints area (allowed in Practice & Exam modes; tracked on exam grade & best attempt)
    const hintsArr = Array.isArray(q.hints) ? q.hints : [];
    let hintsHtml = '';
    if (st.hintsUsed > 0 && hintsArr.length) {
      const hintNote = activeRun.mode === 'exam'
        ? `Tracked on exam grade · -${Math.round(EXAM_HINT_PENALTY_PER_HINT * 100)}% credit on this Q`
        : `+${st.handicapPerHintSec}s par`;
      hintsHtml = hintsArr
        .slice(0, st.hintsUsed)
        .map(
          (h, idx) => `<div class="hint-box${activeRun.mode === 'exam' ? ' is-exam-hint' : ''}">
            <strong>Hint ${idx + 1} <small class="muted">(${hintNote})</small></strong>
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
        ? `<div class="markdown-body" style="margin-top:10px;color:var(--warn)">${renderMarkdownWithMath(`**Exam Pitfall:** ${q.pitfall}`)}</div>`
        : '';

      const isSelfVerified = q.kind !== 'mcq' && !hasWf;
      const topQuickActionsHtml = isSelfVerified
        ? `
          <div class="row-actions" style="gap:6px">
            <button type="button" class="primary-btn btn-got-it-next" style="padding:6px 12px;font-size:12.5px" title="Confirm 100% right, log verified score &amp; jump straight to next question (Shortcut: G)">
              ✓ Got It &amp; ${nextShortLbl}<span data-study-help> (G)</span>
            </button>
            <button type="button" class="ghost-btn btn-missed-next" style="padding:6px 10px;font-size:12.5px" title="Mark Revisit (0%) &amp; jump to next question (Shortcut: X)">
              Revisit &amp; ${nextShortLbl}<span data-study-help> (X)</span>
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
            <strong>Self-Verify Your Attempt${st.loggedAttempt ? ' (Logged)' : '<span data-study-help> (Press G if 100% right, or tick partial checks)</span>'}:</strong>
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
                ✓ Got It Right (100%) &amp; ${nextShortLbl}<span data-study-help> (G)</span>
              </button>
              <button type="button" class="ghost-btn" id="btn-verify-and-next" title="Log currently ticked rubric checks &amp; jump to next question (Shortcut: N / Enter)">
                Log Checked &amp; ${nextShortLbl}<span data-study-help> (N)</span>
              </button>
              <button type="button" class="ghost-btn btn-missed-next" title="Mark Revisit (0%) &amp; jump to next question (Shortcut: X)">
                Revisit &amp; ${nextShortLbl}<span data-study-help> (X)</span>
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
        ? sourcePdfs.filter((p) => p.isPdf && p.isSolution).slice(0, 3)
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
    const mathParAutoOn = isMathParAutoRevealEnabled(uiPrefs);
    const mathParToggleHtml =
      !isBlindUnfinished && activeRun.mode === 'practice' && activeRun.courseMeta?.courseId === 'math-2588'
        ? `<button type="button" class="runner-menu-item ${mathParAutoOn ? 'active' : ''}" id="btn-toggle-math-par-answers" title="Gradually reveal final answers (no steps) as par elapses">
             <span>Par Auto-Reveal Answers</span>
             <small>${mathParAutoOn ? 'ON' : 'Off'}</small>
           </button>`
        : '';

    const toolsMenuHtml = isBlindUnfinished
      ? `<div class="runner-tools-menu">
           <button type="button" class="st-btn runner-more-btn" id="btn-runner-tools" popovertarget="runner-tools-popover" title="Question tools" aria-label="More question tools">•••</button>
           <div class="runner-tools-popover" id="runner-tools-popover" popover="auto">
             <button type="button" class="runner-menu-item" id="btn-copy-for-ai"><span>Copy for Adamlite</span></button>
           </div>
         </div>`
      : `<div class="runner-tools-menu">
           <button type="button" class="st-btn runner-more-btn" id="btn-runner-tools" popovertarget="runner-tools-popover" title="Question tools" aria-label="More question tools">•••</button>
           <div class="runner-tools-popover" id="runner-tools-popover" popover="auto">
             <button type="button" class="runner-menu-item" id="btn-copy-for-ai"><span>Copy for Adamlite</span></button>
             <button type="button" class="runner-menu-item" id="btn-open-tutor"><span>Desktop MCP Tutor</span></button>
             ${instantMcqToggleHtml}
             ${mathParToggleHtml}
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
         </div>`;

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
          <div class="quick-fix-wrap">
            <button type="button" class="st-btn runner-pill-tool quick-fix-trigger" id="btn-quick-fix" popovertarget="quick-fix-popover" title="Report an issue with this exercise or page" aria-label="Report issue" aria-expanded="false" aria-controls="quick-fix-popover">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M10.4 2.4a3.2 3.2 0 0 0-3.7 4.7L2.6 11.2a1.3 1.3 0 1 0 1.8 1.8l4.1-4.1a3.2 3.2 0 0 0 4.7-3.7l-1.9 1.9-1.8-1.8 1.9-1.9Z"/>
              </svg>
            </button>
            <div class="quick-fix-popover" id="quick-fix-popover" popover="auto">
              <textarea id="quick-fix-text" rows="3" maxlength="1500" placeholder="What's broken or wrong here? Paste or attach a screenshot…"></textarea>
              <div class="quick-fix-thumb-row" id="quick-fix-thumb-row" hidden>
                <img id="quick-fix-thumb" alt="Screenshot preview">
                <span class="quick-fix-thumb-name" id="quick-fix-thumb-name"></span>
                <button type="button" class="quick-fix-thumb-rm" id="quick-fix-thumb-rm" aria-label="Remove screenshot">&times;</button>
              </div>
              <div class="quick-fix-actions">
                <button type="button" class="ghost-btn quick-fix-shot-btn" id="quick-fix-shot-btn">
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="2" y="3.5" width="12" height="9.5" rx="2"/>
                    <circle cx="8" cy="8.2" r="2.2"/>
                    <path d="M5.5 3.5 6.3 2h3.4l.8 1.5"/>
                  </svg>
                  <span>Screenshot</span>
                </button>
                <input type="file" id="quick-fix-file" accept="image/*" hidden>
                <button type="button" class="primary-btn quick-fix-send-btn" id="quick-fix-send-btn">Send</button>
              </div>
            </div>
          </div>
          ${toolsMenuHtml}
        </div>
      </div>
    `;

    // Primary Action Button
    const canHint = st.hintsUsed < hintsArr.length && !st.revealed;
    let primaryActionBtn = '';
    if (isBlindUnfinished) {
      primaryActionBtn = hasMoreQuestions
        ? `<button type="button" class="primary-btn" id="btn-next-q">Save &amp; Next →<span data-study-help> (N)</span></button>`
        : `<button type="button" class="primary-btn" id="btn-submit-paper-bottom">Submit Paper</button>`;
    } else if (q.kind === 'mcq') {
      primaryActionBtn = !st.revealed
        ? (instantMcq && st.choice === null
            ? ''
            : `<button type="button" class="primary-btn" id="btn-check-mcq" ${st.choice === null ? 'disabled' : ''}>Check Answer</button>`)
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

    const finalAnswers = !isBlindUnfinished && !st.revealed ? extractFinalAnswers(q) : [];
    const autoOnNow = isMathParAutoActiveFor(q, isBlindUnfinished);
    const shownAnswerCount = finalAnswers.reduce((n, _, idx) => {
      const vis = (st.peekedAnswers?.has(idx) || (autoOnNow && st.autoRevealedAnswers?.has(idx))) && !st.hiddenAnswers?.has(idx);
      return n + (vis ? 1 : 0);
    }, 0);
    const answerTrayHtml = finalAnswers.length
      ? `<section id="runner-answer-tray" class="ans-check-tray" aria-label="Final answers check" ${st.answerTrayOpen ? '' : 'hidden'}>${
          st.answerTrayOpen ? renderAnswerTrayInnerHtml(q, st, isBlindUnfinished) : ''
        }</section>`
      : `<section id="runner-answer-tray" class="ans-check-tray" hidden></section>`;

    const fovealActionBarHtml = `
      <div class="foveal-action-bar">
        <div class="row-actions" style="gap:7px">
          ${primaryActionBtn}
          ${secondaryNextBtn}
          ${canHint ? `<button type="button" class="ghost-btn${activeRun.mode === 'exam' ? ' is-exam-hint-btn' : ''}" id="btn-hint" title="${activeRun.mode === 'exam' ? 'Show hint (H) · Tracked on exam grade (-15% credit on this Q per hint, max -45%) & logged on best attempt' : 'Show hint (H)'}">Hint ${st.hintsUsed + 1}/${hintsArr.length}</button>` : ''}
          ${
            finalAnswers.length
              ? `<button type="button" class="ghost-btn ans-check-toggle-btn ${st.answerTrayOpen ? 'active' : ''}" id="btn-toggle-answers" aria-expanded="${st.answerTrayOpen ? 'true' : 'false'}" aria-controls="runner-answer-tray" title="Check final answers one by one (no steps, zero penalty)">Answers${shownAnswerCount ? ` (${shownAnswerCount}/${finalAnswers.length})` : ''}</button>`
              : ''
          }
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
              ? `<button type="button" class="ghost-btn" id="btn-bottom-pdf" title="Toggle Source PDF">${st.readerTab === 'pdf' ? 'Task' : 'PDF'}</button>`
              : !isSplit && lockedSourceRefs.length
              ? `<button type="button" class="ghost-btn" id="btn-bottom-context" title="Toggle Source Context (Sync Canvas or Drop PDF)">${st.readerTab === 'context' ? 'Task' : 'Source'}</button>`
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
        ${q.kind === 'mcq' ? (instantMcq ? '<span><kbd>1–6</kbd>/<kbd>A–F</kbd> Answer</span>' : '<span><kbd>1–6</kbd>/<kbd>A–F</kbd> Select</span>') : '<span><kbd>⌘/Ctrl+↵</kbd> Reveal/Check</span>'}
        <span><kbd>S</kbd> Solution</span>
        <span><kbd>Enter</kbd>/<kbd>N</kbd> Check/Next</span>
        <span><kbd>P</kbd> Pause</span>
        <span><kbd>B</kbd> Break</span>
        <span><kbd>V</kbd> Focus/Split</span>
        ${hintsArr.length ? '<span><kbd>H</kbd> Hint</span>' : ''}
        ${canOpenReference ? '<span><kbd>O</kbd> Ref</span>' : ''}
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
            ${answerTrayHtml}
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
            ${answerTrayHtml}
            ${hintsHtml}
            ${solutionHtml}
            ${kbdBarHtml}
          </div>
        </div>
      `;
    } else {
      const showFocusTabs = st.readerTab !== 'task' && (sourcePdfs.length > 0 || lockedSourceRefs.length > 0);
      card.innerHTML = `
        ${statusBarHtml}
        ${showFocusTabs ? readerTabBarHtml : ''}
        <div class="foveal-prompt-block">
          ${readerBodyHtml}
        </div>
        <div id="stall-nudge-banner" class="hint-box stall-banner" data-study-help hidden></div>
        ${workspaceHtml}
        ${fovealActionBarHtml}
        ${answerTrayHtml}
        ${hintsHtml}
        ${solutionHtml}
        ${kbdBarHtml}
      `;
    }

    const newLeftEl = document.querySelector('.runner-pane-left-scroll');
    if (newLeftEl && prevLeftScroll > 0) {
      newLeftEl.scrollTop = prevLeftScroll;
    }
    const newRightEl = document.querySelector('.runner-pane-right');
    if (newRightEl && prevRightScroll > 0) {
      newRightEl.scrollTop = prevRightScroll;
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

    // Render compact numbered question jump strip directly (hidden for single-question runs)
    const jumpPanel = document.getElementById('runner-jump-panel');
    const jumpGrid = document.getElementById('runner-jump-grid');
    if (jumpPanel) jumpPanel.hidden = activeRun.questionIds.length <= 1;
    jumpGrid.innerHTML = activeRun.questionIds.length <= 1
      ? ''
      : activeRun.questionIds
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
          return `<button type="button" class="${cls}" data-jump-idx="${i}" aria-label="Question ${i + 1}"${i === activeRun.index ? ' aria-current="step"' : ''}>${i + 1}${it?.flagged && isBlindUnfinished ? '⚑' : ''}</button>`;
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
    prefetchUpcomingRunPdfs(q, isBlindUnfinished);
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
        const inlinePage = Number(btn.dataset.openInlinePage || 0);
        const foundIdx = sourcePdfs.findIndex((p) => p.key === key);
        if (foundIdx >= 0) {
          st.selectedPdfIdx = foundIdx;
          const docViewKey = key.replace(/#p\d+$/, '');
          const view = (st.pdfViews[docViewKey] ||= { page: sourcePdfs[foundIdx].page, zoom: 100, trim: true });
          view.page = inlinePage > 0 ? inlinePage : sourcePdfs[foundIdx].page;
        }
        st.readerTab = 'pdf';
        renderRunner();
      });
    });

    document.querySelectorAll('[data-edit-inline-pdf]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const key = btn.dataset.editInlinePdf;
        const target = sourcePdfs.find((p) => p.key === key);
        if (target && window.StudyPdfCraft?.openSource) {
          window.StudyPdfCraft.openSource(target, {
            onSaved: () => { renderRunner(); },
          });
        }
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
      if (st.readerTab === 'pdf' && dockReferenceLayout.matches) st.layoutOverride = null; // Auto-expand side-by-side only on wide screens
      renderRunner();
    });

    document.getElementById('btn-bottom-context')?.addEventListener('click', () => {
      st.readerTab = st.readerTab === 'context' ? 'task' : 'context';
      if (st.readerTab === 'context' && dockReferenceLayout.matches) st.layoutOverride = null;
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
      const nextInstant = !isInstantMcqEnabled();
      saveRunnerUiPrefs({ instantMcq: nextInstant });
      toast(nextInstant ? '1-Tap MCQ Check ON (click or press A–D to check immediately)' : '1-Tap MCQ Check OFF');
      renderRunner();
    });

    // Compact Docked Reference Pane: Needed continuous stream, full-height searchable TOC, and background toggle
    const bindInlineOutlineClicks = () => {
      card.querySelectorAll('#inline-ref-outline-tree [data-outline-heading]').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          st.inlineRefTocOpen = false;
          st.inlineRefData = null;
          st.inlineRefCacheSig = '';
          await ensureInlineRefLoaded(q, st, st.inlineRefFile, btn.dataset.outlineHeading || '', { mode: 'section' });
          renderRunner();
        });
      });
    };
    bindInlineOutlineClicks();

    document.getElementById('btn-inline-ref-needed')?.addEventListener('click', async () => {
      st.inlineRefTocOpen = false;
      st.inlineRefMode = 'needed';
      st.inlineRefData = null;
      st.inlineRefCacheSig = '';
      await ensureInlineRefLoaded(q, st, st.inlineRefFile, null, { mode: 'needed' });
      renderRunner();
    });
    const setInlineTocOpen = (open) => {
      st.inlineRefTocOpen = Boolean(open);
      renderRunner();
      if (st.inlineRefTocOpen) {
        setTimeout(() => document.getElementById('inp-inline-ref-filter')?.focus(), 20);
      }
    };
    document.getElementById('btn-inline-ref-browse')?.addEventListener('click', () => setInlineTocOpen(!st.inlineRefTocOpen));
    document.getElementById('btn-inline-ref-toc-done')?.addEventListener('click', () => setInlineTocOpen(false));
    document.getElementById('inp-inline-ref-filter')?.addEventListener('input', (ev) => {
      st.inlineRefFilter = ev.target.value || '';
      const treeEl = document.getElementById('inline-ref-outline-tree');
      const tocList = st.inlineRefData?.toc || [];
      const rel = st.inlineRefRel || { primaryHeading: '', primaryChapterLine: null, relatedHeadings: new Set(), relatedChapterLines: new Set(), backgroundSet: new Set() };
      if (treeEl && window.StudyUI.buildOutlineTreeHtml) {
        const fullRow = !st.inlineRefFilter
          ? `<div class="obs-outline-leaf depth-0"><button type="button" class="obs-outline-link depth-0" data-outline-heading="" title="Read entire note"><span class="obs-outline-text">Full Note / All Chapters</span></button></div>`
          : '';
        treeEl.innerHTML = fullRow + window.StudyUI.buildOutlineTreeHtml(tocList, {
          activeHeading: st.inlineRefData?.mode === 'section' ? (st.inlineRefData?.selectedHeading || '') : '',
          primaryHeading: rel.primaryHeading,
          primaryChapterLine: rel.primaryChapterLine,
          relatedHeadings: rel.relatedHeadings,
          relatedChapterLines: rel.relatedChapterLines,
          backgroundHeadings: rel.backgroundSet,
          filter: st.inlineRefFilter,
          collapsedByDefault: true,
        });
        bindInlineOutlineClicks();
      }
    });
    document.getElementById('inp-inline-ref-filter')?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        setInlineTocOpen(false);
      }
    });
    card.querySelectorAll('[data-inline-ref-note]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        st.inlineRefData = null;
        st.inlineRefCacheSig = '';
        await ensureInlineRefLoaded(q, st, btn.dataset.inlineRefNote || '', null, { mode: 'needed' });
        renderRunner();
      });
    });
    card.querySelectorAll('[data-inline-stream-jump]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = card.querySelector(`.runner-pane-ref-scroll [data-ref-stream-idx="${btn.dataset.inlineStreamJump}"]`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    document.getElementById('btn-inline-ref-toggle-bg')?.addEventListener('click', async () => {
      st.inlineRefShowBg = !st.inlineRefShowBg;
      st.inlineRefData = null;
      st.inlineRefCacheSig = '';
      await ensureInlineRefLoaded(q, st, st.inlineRefFile, null, { mode: 'needed' });
      renderRunner();
    });
    card.querySelectorAll('[data-inline-expand-heading]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        st.inlineRefTocOpen = false;
        st.inlineRefData = null;
        st.inlineRefCacheSig = '';
        await ensureInlineRefLoaded(q, st, st.inlineRefFile, btn.dataset.inlineExpandHeading || '', { mode: 'section' });
        renderRunner();
      });
    });
    card.querySelector('[data-inline-show-bg]')?.addEventListener('click', async () => {
      st.inlineRefShowBg = true;
      st.inlineRefData = null;
      st.inlineRefCacheSig = '';
      await ensureInlineRefLoaded(q, st, st.inlineRefFile, null, { mode: 'needed' });
      renderRunner();
    });
    card.querySelector('[data-inline-open-toc]')?.addEventListener('click', () => setInlineTocOpen(true));
    card.querySelector('.runner-pane-ref-scroll')?.addEventListener('click', async (ev) => {
      const a = ev.target?.closest?.('a[data-ref-jump-file], a[data-ref-jump-heading]');
      if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      const jf = a.dataset.refJumpFile || '';
      const jh = a.dataset.refJumpHeading || '';
      const nextFile = jf ? (jf.endsWith('.md') ? jf : `${jf}.md`) : st.inlineRefFile;
      st.inlineRefData = null;
      st.inlineRefCacheSig = '';
      await ensureInlineRefLoaded(q, st, nextFile, jh, { mode: 'section' });
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
        if (!isBlindUnfinished && isInstantMcqEnabled()) {
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

    // WISEflow choice pills (Right / Wrong or sub-choices) — update in-place to preserve PDF/task scroll!
    document.querySelectorAll('[data-wf-choice-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (st.revealed) return;
        const fid = btn.dataset.wfChoiceId;
        const pickedIdx = Number(btn.dataset.wfChoiceIdx);
        st.wiseflow[fid] = pickedIdx;
        const pillGroup = btn.closest('.wf-choice-pills');
        if (pillGroup) {
          pillGroup.querySelectorAll('[data-wf-choice-id]').forEach((sib) => {
            sib.classList.toggle('selected', Number(sib.dataset.wfChoiceIdx) === pickedIdx);
          });
        }
        if (isBlindUnfinished) {
          const curJump = document.querySelector(`#runner-jump-grid [data-jump-idx="${activeRun.index}"]`);
          if (curJump) curJump.classList.add('answered');
        }
        window.StudyApp.debouncedSaveDraft(q.id, {
          wiseflowAnswers: st.wiseflow,
          activeElapsedSec: itemActiveSec(st),
          profile: activeRun.profile,
        });
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
        if (ev.isComposing) return;
        if (ev.key === 'Enter' && !isBlindUnfinished && !st.revealed) {
          ev.preventDefault();
          document.getElementById('btn-check-wf')?.click();
        }
      });
    });

    // Coding IDE / Jupyter Studio controls
    if (q.kind === 'coding') {
      const codingTopicName = (activeRun.bank.topics || []).find((t) => String(t.id) === String(q.topicId))?.title || '';
      document.querySelectorAll('[data-coding-ide]').forEach((btn) => {
        btn.addEventListener('click', () => {
          setPreferredCodingIde(btn.dataset.codingIde);
          renderRunner();
        });
      });
      document.getElementById('btn-coding-open-ref')?.addEventListener('click', () => {
        openReferenceDrawer(activeRun.courseMeta, q.obsidianLink?.file || '', q.obsidianLink?.heading || '', { question: q, bank: activeRun.bank });
      });
      document.querySelectorAll('[data-toggle-subpart]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.toggleSubpart);
          if (!Array.isArray(st.checkedSubparts)) st.checkedSubparts = [];
          if (st.checkedSubparts.includes(idx)) st.checkedSubparts = st.checkedSubparts.filter((x) => x !== idx);
          else st.checkedSubparts.push(idx);
          syncFloatingParBar(q, st, itemActiveSec(st), Boolean(st.revealed));
          renderRunner();
        });
      });
      document.getElementById('btn-coding-open-ide')?.addEventListener('click', async () => {
        const ide = getPreferredCodingIde();
        st.ideActive = true;
        const livePill = document.getElementById('coding-ide-live-pill');
        if (livePill) livePill.hidden = false;
        // Pop out always-on-top Floating AI-Par Bar inside the user click gesture
        await openFloatingParBar();
        // Fire deep-link into Antigravity / VS Code / Cursor companion extension
        const uri = buildIdeCompanionUri(ide, q, st, codingTopicName);
        const link = document.createElement('a');
        link.href = uri;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        toast(`Opening in ${IDE_CONFIGS[ide]?.label || 'IDE'} · AI-Par timer keeps running while you code!`);
      });
      document.getElementById('btn-coding-float-bar')?.addEventListener('click', async () => {
        st.ideActive = true;
        const livePill = document.getElementById('coding-ide-live-pill');
        if (livePill) livePill.hidden = false;
        await openFloatingParBar();
      });
      document.getElementById('btn-coding-download-ipynb')?.addEventListener('click', () => {
        st.ideActive = true;
        const livePill = document.getElementById('coding-ide-live-pill');
        if (livePill) livePill.hidden = false;
        downloadExamNotebook(q, st, codingTopicName);
      });
    }

    // Written / Coding draft + Clipboard Image Paste / Drop / Picker
    const draftEl = document.getElementById('inp-written-draft');
    const dropZone = document.getElementById('draft-drop-zone');
    const attachImageBlobs = async (blobs) => {
      const files = Array.from(blobs || []).filter((f) => f && /^image\//i.test(f.type || ''));
      if (!files.length) return;
      if (!Array.isArray(st.draftImages)) st.draftImages = [];
      let added = 0;
      let totalKb = 0;
      for (const file of files) {
        if (st.draftImages.length >= MAX_DRAFT_IMAGES) {
          toast(`Max ${MAX_DRAFT_IMAGES} images per question.`);
          break;
        }
        try {
          const rec = await compressImageBlobToRecord(file, q.id, file.name || '');
          await saveDraftImageRecord(rec);
          const { dataUrl: _drop, ...metaOnly } = rec;
          st.draftImages.push(metaOnly);
          added++;
          totalKb += Math.max(1, Math.round(rec.bytes / 1024));
        } catch (err) {
          toast(err?.message || 'Could not attach image.');
        }
      }
      if (added > 0) {
        window.StudyApp.debouncedSaveDraft(q.id, {
          draft: st.draft,
          draftImages: st.draftImages,
          activeElapsedSec: itemActiveSec(st),
          profile: activeRun.profile,
        });
        toast(`📎 Attached ${added} image${added === 1 ? '' : 's'} (${totalKb} KB) — saved locally`);
        renderRunner();
      }
    };
    activeRun._attachImageBlobs = draftEl ? attachImageBlobs : null;

    if (draftEl) {
      const updateWords = () => {
        const words = draftEl.value.trim() ? draftEl.value.trim().split(/\s+/).length : 0;
        const imgN = (st.draftImages || []).length;
        const lbl = document.getElementById('lbl-word-count');
        if (lbl) {
          lbl.textContent = `${words} word${words === 1 ? '' : 's'}${imgN ? ` · ${imgN} img${imgN === 1 ? '' : 's'}` : ''}`;
        }
      };
      updateWords();
      draftEl.addEventListener('input', () => {
        st.draft = draftEl.value;
        updateWords();
        window.StudyApp.debouncedSaveDraft(q.id, {
          draft: st.draft,
          draftImages: st.draftImages || [],
          activeElapsedSec: itemActiveSec(st),
          profile: activeRun.profile,
        });
      });
      draftEl.addEventListener('paste', (ev) => {
        const items = Array.from(ev.clipboardData?.items || []);
        const imgFiles = items
          .filter((it) => it.kind === 'file' && /^image\//i.test(it.type))
          .map((it) => it.getAsFile())
          .filter(Boolean);
        if (imgFiles.length) {
          ev.preventDefault();
          attachImageBlobs(imgFiles);
        }
      });
    }

    if (dropZone) {
      dropZone.addEventListener('dragover', (ev) => {
        if (Array.from(ev.dataTransfer?.types || []).includes('Files')) {
          ev.preventDefault();
          dropZone.classList.add('is-drag-over');
        }
      });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-drag-over'));
      dropZone.addEventListener('drop', (ev) => {
        dropZone.classList.remove('is-drag-over');
        const files = Array.from(ev.dataTransfer?.files || []).filter((f) => /^image\//i.test(f.type));
        if (files.length) {
          ev.preventDefault();
          attachImageBlobs(files);
        }
      });
    }

    document.getElementById('inp-draft-image-file')?.addEventListener('change', (ev) => {
      const files = ev.target?.files;
      if (files?.length) attachImageBlobs(files);
      ev.target.value = '';
    });

    // Hydrate cached/IndexedDB thumbnails + bind zoom & delete buttons
    document.querySelectorAll('[data-dimg-src]').forEach((imgEl) => {
      const id = imgEl.dataset.dimgSrc;
      if (!id || imgEl.getAttribute('src')) return;
      loadDraftImageDataUrl(id).then((url) => {
        if (url && imgEl.isConnected) imgEl.src = url;
      });
    });
    document.querySelectorAll('[data-dimg-open]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.dimgOpen;
        const meta = (st.draftImages || []).find((m) => m.id === id);
        const url = await loadDraftImageDataUrl(id);
        if (url) openDraftImageLightbox(url, meta ? `${meta.name} (${meta.width}×${meta.height})` : 'Paper working');
      });
    });
    document.querySelectorAll('[data-dimg-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.dimgDel;
        st.draftImages = (st.draftImages || []).filter((m) => m.id !== id);
        await deleteDraftImageRecord(id);
        window.StudyApp.debouncedSaveDraft(q.id, {
          draft: st.draft,
          draftImages: st.draftImages,
          activeElapsedSec: itemActiveSec(st),
          profile: activeRun.profile,
        });
        renderRunner();
      });
    });

    const numEl = document.getElementById('inp-numeric-ans');
    if (numEl) {
      numEl.addEventListener('input', () => {
        st.numericInput = numEl.value;
      });
    }

    // Hints
    document.getElementById('btn-hint')?.addEventListener('click', () => {
      st.hintsUsed = Math.min((q.hints || []).length, st.hintsUsed + 1);
      if (activeRun.mode === 'exam') {
        if (activeRun.paperSubmitted || activeRun.examStyle === 'guided') {
          activeRun.paperScoreSummary = recomputeExamRunGrade({ includeUnverifiedAsZero: Boolean(activeRun.paperSubmitted) });
        }
        toast(`Hint ${st.hintsUsed} shown · Tracked on exam grade (-${Math.min(45, st.hintsUsed * 15)}% credit on this Q)`);
      }
      renderRunner();
    });

    // Zero-Penalty Final Answers Check (one-by-one reveal, no worked steps)
    document.getElementById('btn-toggle-answers')?.addEventListener('click', () => {
      st.answerTrayOpen = !st.answerTrayOpen;
      refreshAnswerTrayInPlace(q, st);
    });
    document.getElementById('runner-answer-tray')?.addEventListener('click', (ev) => {
      const chip = ev.target?.closest?.('[data-ans-idx]');
      if (chip) {
        const idx = Number(chip.dataset.ansIdx);
        const autoOn = isMathParAutoActiveFor(q, isBlindUnfinished);
        const currentlyShown = (st.peekedAnswers.has(idx) || (autoOn && st.autoRevealedAnswers.has(idx)))
          && !st.hiddenAnswers.has(idx);
        if (currentlyShown) {
          st.peekedAnswers.delete(idx);
          st.hiddenAnswers.add(idx);
        } else {
          st.hiddenAnswers.delete(idx);
          st.peekedAnswers.add(idx);
        }
        refreshAnswerTrayInPlace(q, st);
        return;
      }
      const bulk = ev.target?.closest?.('[data-ans-bulk]');
      if (bulk) {
        const answers = extractFinalAnswers(q);
        if (bulk.dataset.ansBulk === 'all') {
          st.hiddenAnswers.clear();
          answers.forEach((_, idx) => st.peekedAnswers.add(idx));
        } else {
          st.peekedAnswers.clear();
          answers.forEach((_, idx) => st.hiddenAnswers.add(idx));
        }
        refreshAnswerTrayInPlace(q, st);
      }
    });
    document.getElementById('btn-toggle-math-par-answers')?.addEventListener('click', (ev) => {
      ev.currentTarget.closest('[popover]')?.hidePopover?.();
      setMathParAutoRevealEnabled(!isMathParAutoRevealEnabled());
      const btn = document.getElementById('btn-toggle-math-par-answers');
      const nowOn = isMathParAutoRevealEnabled();
      if (btn) {
        btn.classList.toggle('active', nowOn);
        const sm = btn.querySelector('small');
        if (sm) sm.textContent = nowOn ? 'ON' : 'Off';
      }
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
        if (activeRun.mode === 'exam' && (activeRun.paperSubmitted || activeRun.examStyle === 'guided')) {
          activeRun.paperScoreSummary = recomputeExamRunGrade({ includeUnverifiedAsZero: Boolean(activeRun.paperSubmitted) });
          renderRunnerNotice(false);
        }
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

    // Fallback positioning for browsers without native CSS Anchor Positioning (`position-area`)
    const supportsAnchorArea = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('position-area: block-end');
    const positionPopoverFallback = (pop, anchor) => {
      if (!pop || !anchor || supportsAnchorArea) return;
      const aRect = anchor.getBoundingClientRect();
      const pad = 8;
      pop.style.margin = '0';
      pop.style.right = 'auto';
      pop.style.bottom = 'auto';
      const pRect = pop.getBoundingClientRect();
      const w = pRect.width || 220;
      const h = pRect.height || 180;
      let left = aRect.left;
      if (left + w > window.innerWidth - pad) {
        left = aRect.right - w;
      }
      left = Math.max(pad, Math.min(window.innerWidth - w - pad, left));
      let top = aRect.bottom + 6;
      if (top + h > window.innerHeight - pad && aRect.top - h - 6 >= pad) {
        top = aRect.top - h - 6;
      }
      top = Math.max(pad, Math.min(window.innerHeight - h - pad, top));
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
    };

    const toolsPop = document.getElementById('runner-tools-popover');
    const toolsTrigger = document.getElementById('btn-runner-tools');
    if (toolsPop && toolsTrigger) {
      toolsPop.addEventListener('toggle', (ev) => {
        if (ev.newState === 'open') positionPopoverFallback(toolsPop, toolsTrigger);
      });
    }

    // Blind Exam Flag button
    document.getElementById('btn-flag-exam')?.addEventListener('click', () => {
      st.flagged = !st.flagged;
      renderRunner();
    });

    // Seamless in-exercise bug / fix report popover (message + screenshot -> Send)
    (() => {
      const trigger = document.getElementById('btn-quick-fix');
      const pop = document.getElementById('quick-fix-popover');
      const ta = document.getElementById('quick-fix-text');
      const shotBtn = document.getElementById('quick-fix-shot-btn');
      const fileInp = document.getElementById('quick-fix-file');
      const sendBtn = document.getElementById('quick-fix-send-btn');
      const thumbRow = document.getElementById('quick-fix-thumb-row');
      const thumbImg = document.getElementById('quick-fix-thumb');
      const thumbName = document.getElementById('quick-fix-thumb-name');
      const thumbRm = document.getElementById('quick-fix-thumb-rm');
      if (!trigger || !pop || !ta || !shotBtn || !fileInp || !sendBtn) return;

      let screenshotData = '';

      const compressImageFile = (file) => new Promise((resolve, reject) => {
        if (!file || !String(file.type || '').startsWith('image/')) {
          reject(new Error('Choose an image file.'));
          return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read image.'));
        reader.onload = () => {
          const img = new Image();
          img.onerror = () => reject(new Error('Invalid image file.'));
          img.onload = () => {
            const maxDim = 1280;
            const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
            const w = Math.max(1, Math.round((img.width || 1) * scale));
            const h = Math.max(1, Math.round((img.height || 1) * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) { reject(new Error('Canvas unavailable.')); return; }
            ctx.drawImage(img, 0, 0, w, h);
            let out = canvas.toDataURL('image/webp', 0.78);
            if (!out.startsWith('data:image/webp') || out.length > 360_000) {
              out = canvas.toDataURL('image/jpeg', 0.78);
            }
            if (out.length > 380_000) {
              out = canvas.toDataURL('image/jpeg', 0.6);
            }
            if (out.length > 410_000) {
              reject(new Error('Screenshot is too large — try cropping a smaller area.'));
              return;
            }
            resolve({ dataUrl: out, label: `${file.name || 'screenshot'} (${w}×${h})` });
          };
          img.src = String(reader.result || '');
        };
        reader.readAsDataURL(file);
      });

      const clearShot = () => {
        screenshotData = '';
        fileInp.value = '';
        if (thumbRow) thumbRow.hidden = true;
        if (thumbImg) thumbImg.removeAttribute('src');
        if (thumbName) thumbName.textContent = '';
      };

      const attachFile = async (file) => {
        try {
          const res = await compressImageFile(file);
          screenshotData = res.dataUrl;
          if (thumbImg) thumbImg.src = res.dataUrl;
          if (thumbName) thumbName.textContent = res.label;
          if (thumbRow) thumbRow.hidden = false;
        } catch (err) {
          toast(err?.message || 'Could not attach screenshot.');
        }
      };

      const closePop = () => {
        if (pop.matches?.(':popover-open')) {
          pop.hidePopover?.();
        }
        trigger.setAttribute('aria-expanded', 'false');
      };

      pop.addEventListener('toggle', (ev) => {
        const isOpen = ev.newState === 'open';
        trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen) {
          positionPopoverFallback(pop, trigger);
          setTimeout(() => ta.focus(), 10);
        }
      });

      shotBtn.addEventListener('click', () => fileInp.click());
      fileInp.addEventListener('change', () => {
        const f = fileInp.files?.[0];
        if (f) attachFile(f);
      });
      thumbRm?.addEventListener('click', clearShot);

      ta.addEventListener('paste', (ev) => {
        const items = ev.clipboardData?.items;
        if (!items) return;
        for (const it of items) {
          if (it.kind === 'file' && it.type.startsWith('image/')) {
            const f = it.getAsFile();
            if (f) {
              ev.preventDefault();
              attachFile(f);
              break;
            }
          }
        }
      });

      const doSend = async () => {
        const msg = ta.value.trim();
        if (msg.length < (screenshotData ? 2 : 4)) {
          toast('Write a quick note about the issue first.');
          ta.focus();
          return;
        }
        if (!window.StudyCommunity?.submitFeedback) {
          toast('Issue reports require the hosted Study-OS site.');
          return;
        }
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending…';
        try {
          const meta = {
            courseId: activeRun.courseMeta?.courseId || '',
            courseCode: activeRun.courseMeta?.code || '',
            questionId: q.id || '',
            questionTitle: String(q.title || '').slice(0, 120),
            kind: q.kind || '',
            topicId: String(q.topicId ?? ''),
            mode: activeRun.mode || '',
            url: location.pathname + location.hash,
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            theme: document.documentElement.dataset.theme || 'light',
          };
          await window.StudyCommunity.submitFeedback({
            category: 'bug',
            message: msg,
            page: `exercise:${meta.courseCode || meta.courseId || q.id || 'runner'}`,
            meta,
            screenshot: screenshotData,
          });
          ta.value = '';
          clearShot();
          closePop();
          toast('Report sent — thanks!');
        } catch (err) {
          toast(err?.message || 'Could not send report.');
        } finally {
          if (sendBtn.isConnected) {
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send';
          }
        }
      };

      sendBtn.addEventListener('click', doSend);
      ta.addEventListener('keydown', (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
          ev.preventDefault();
          ev.stopPropagation();
          doSend();
        }
      });
    })();

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
      openReferenceDrawer(activeRun.courseMeta, q.obsidianLink?.file || '', q.obsidianLink?.heading || '', { question: q, bank: activeRun.bank });
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
    for (const qid of activeRun.questionIds) {
      const q = activeRun.questionsById[qid];
      const st = itemState(qid);
      st.revealed = true;

      if (q.kind === 'mcq') {
        const acc = st.choice !== null && st.choice === q.answerIndex ? 1.0 : 0.0;
        await submitVerifiedAttempt(q, st, acc);
      } else if (Array.isArray(q.wiseflowFields) && q.wiseflowFields.length) {
        st.wfGrade = evaluateWiseflowSheet(q, st);
        await submitVerifiedAttempt(q, st, st.wfGrade.accuracy);
      } else if (q.numericCheck && st.numericInput.trim() !== '') {
        const parsed = parseWiseflowNumber(st.numericInput);
        const exp = Number(q.numericCheck.expected);
        const tol = Math.max(0.02 * Math.abs(exp), Number(q.numericCheck.tolerance || 0.02));
        if (parsed.ok && Math.abs(parsed.value - exp) <= tol) {
          const totalChecks = (q.rubricChecks || []).length || 3;
          st.checkedRubrics = Array.from({ length: totalChecks }, (_, i) => i);
          await submitVerifiedAttempt(q, st, 1.0);
        }
      }
    }

    activeRun.paperSubmitted = true;
    const summary = recomputeExamRunGrade({ includeUnverifiedAsZero: true });
    activeRun.paperScoreSummary = summary;
    persistExamRunGradeIfReady(false);

    renderRunner();
    const g = summary.grade || fallbackGradeFromPct(summary.pct);
    toast(
      summary.manualCount > 0
        ? `Check off your marking checklist on ${summary.manualCount} written problem(s) to finalize your BI Grade (currently ${g.letter} · ${Math.round(summary.pct)}%).`
        : `${g.letter === 'A' ? '★ ' : ''}BI Grade ${g.letter} · ${Math.round(summary.pct)}% (${summary.earnedPts.toFixed(1)} / ${summary.totalPts} pts)${g.toA > 0 ? ` · +${g.toA}% to A` : ' — Target A achieved!'}`
    );
  }

  async function submitVerifiedAttempt(q, st, qualityAccuracy) {
    const run = activeRun;
    window.StudyApp.flushPendingDrafts?.();
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
      freshExamSit: Boolean(run.freshExamSit),
      activeSec: Math.max(1, itemActiveSec(st)),
      aiParSec: st.targetSec,
      hintsUsed: st.hintsUsed,
      refUsed: Boolean(st.refUsed),
      refSec: Math.round(Number(st.refSec || 0)),
      refOpenCount: Number(st.refOpenCount || 0),
      openBookExam: isOpenBookExamCourse(run.courseMeta),
      assisted: Boolean(st.solutionPeeked),
      hintHandicapSec: st.handicapPerHintSec,
      qualityAccuracy,
      focusSwitchCount: st.focusSwitches.length,
      awayElapsedSec: Math.round((st.awayElapsedMs || 0) / 100) / 10,
      manualPauseCount: st.manualPauseCount || 0,
      focusSwitches: st.focusSwitches,
      choice: st.choice,
      draft: st.draft,
      draftImages: Array.isArray(st.draftImages) ? st.draftImages : [],
      attachedImageCount: Array.isArray(st.draftImages) ? st.draftImages.length : 0,
      attachedImageIds: Array.isArray(st.draftImages) ? st.draftImages.map((m) => m.id) : [],
      wiseflowAnswers: st.wiseflow,
      checkedRubricIndices: st.checkedRubrics,
    }).finally(() => { pendingSaves -= 1; });
    run.consecutiveMisses = qualityAccuracy < 0.6 ? (run.consecutiveMisses || 0) + 1 : 0;
    if (res?.attempt) {
      st.loggedAttempt = res.attempt;
      run.completedAttempts[q.id] = res.attempt;
    }
    if (run.mode === 'exam' && (run.paperSubmitted || run.examStyle === 'guided')) {
      run.paperScoreSummary = recomputeExamRunGrade({ includeUnverifiedAsZero: Boolean(run.paperSubmitted) });
      persistExamRunGradeIfReady(false);
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
    syncFloatingParBar(q, st, activeSec, st.revealed && !isBlindUnfinished);

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

    // Math Par Auto-Reveal (optional user setting: uncovers final answers one-by-one as par elapses, zero penalty)
    if (!st.revealed && isMathParAutoActiveFor(q, isBlindUnfinished)) {
      const answers = extractFinalAnswers(q);
      if (answers.length) {
        const targetSec = Math.max(30, Number(st.targetSec) || 180);
        let newlyUnlocked = false;
        for (let i = 0; i < answers.length; i++) {
          const threshold = Math.round(((i + 1) / answers.length) * targetSec);
          if (activeSec >= threshold && !st.autoRevealedAnswers.has(i)) {
            st.autoRevealedAnswers.add(i);
            st.hiddenAnswers.delete(i);
            newlyUnlocked = true;
          }
        }
        if (newlyUnlocked) {
          st.answerTrayOpen = true;
          refreshAnswerTrayInPlace(q, st);
        } else if (st.answerTrayOpen) {
          // Gently update countdown label in-place without replacing chip DOM
          const paceEl = document.querySelector('#runner-answer-tray .ans-tray-pace');
          if (paceEl && !paceEl.classList.contains('is-done')) {
            let nextIdx = -1;
            for (let i = 0; i < answers.length; i++) {
              if (!st.autoRevealedAnswers.has(i)) { nextIdx = i; break; }
            }
            if (nextIdx >= 0) {
              const nextAt = Math.round(((nextIdx + 1) / answers.length) * targetSec);
              paceEl.textContent = `Par auto-reveal · ${answers[nextIdx].label} in ${clockSec(Math.max(0, nextAt - activeSec))}`;
            }
          }
        }
      }
    }

    // Total Exam Paper Countdown + Live Exam Reference Tracking
    if (activeRun.mode === 'exam' && !st.revealed && st.runningSince != null && workClock?.getState?.().mode !== 'break') {
      const refOpenNow = document.body.classList.contains('runner-split-ref') || Boolean(window.StudyUI.isReferenceDrawerOpen?.());
      const nowMs = Date.now();
      if (refOpenNow) {
        if (st.refLastTickMs != null) {
          const dtSec = Math.min(2, Math.max(0, (nowMs - st.refLastTickMs) / 1000));
          st.refSec = (Number(st.refSec) || 0) + dtSec;
        }
        st.refLastTickMs = nowMs;
        // 3s grace window if user navigated onto a new question while Reference was already docked open
        if (!st.refUsed && st.refSec >= 3) {
          markQuestionRefOpened(q, st, false);
        }
      } else {
        st.refLastTickMs = null;
      }
    } else {
      st.refLastTickMs = null;
    }

    const examCd = document.getElementById('run-exam-countdown');
    if (examCd && activeRun.examBudgetSec && !activeRun.paperSubmitted) {
      const remSec = Math.max(0, activeRun.examBudgetSec - totalExamActiveSec());
      const isPausedExam = workClock?.getState?.().mode === 'break' || st.runningSince === null;
      examCd.textContent = `${isPausedExam ? '⏸ ' : ''}${clockSec(remSec)} left`;
      examCd.classList.toggle('urgent', remSec <= 600);
      examCd.classList.toggle('paused', isPausedExam);
    }
  }

  const CHECKIN_MIN_ACTIVE_SEC = 45 * 60; // Only ask for session feedback on long 45m+ study blocks or full submitted exams

  function openEndRunModal() {
    if (!activeRun) return;
    pauseCurrentTimer();
    const m = computeRunSummary();
    if (activeRun.mode === 'exam' && (activeRun.paperSubmitted || m.reviewed > 0)) {
      activeRun.paperScoreSummary = recomputeExamRunGrade({ includeUnverifiedAsZero: Boolean(activeRun.paperSubmitted) });
    }
    const isGradedExam = activeRun.mode === 'exam' && (Boolean(activeRun.paperSubmitted) || (m.reviewed > 0 && m.reviewed >= m.total));
    const shouldPromptFeedback = isGradedExam || m.activeSec >= CHECKIN_MIN_ACTIVE_SEC;
    if (!shouldPromptFeedback) {
      finalizeSession(false);
      return;
    }
    const ps = activeRun.paperScoreSummary;
    const scr = workClock?.getScreenStats?.() || {};
    const hdr = document.getElementById('checkin-summary-header');
    let examGradeHtml = '';
    if (activeRun.mode === 'exam' && ps && ps.totalPts > 0 && ps.gradedCount > 0) {
      const g = ps.grade || fallbackGradeFromPct(ps.pct);
      const star = g.letter === 'A' ? '★ ' : '';
      const modeTag = ps.gradingKind === 'auto' ? 'Auto-graded' : ps.gradingKind === 'rubric' ? 'Rubric-graded' : 'Auto + Rubric';
      const hTotal = Number(ps.hintsTotal || 0);
      const hQs = Number(ps.hintedQCount || 0);
      const hPen = Number(ps.hintPenaltyPts || 0);
      const rQs = Number(ps.refQCount || 0);
      const rSec = Number(ps.refTotalSec || 0);
      const rPen = Number(ps.refPenaltyPts || 0);
      const totalAidPen = hPen + rPen;
      const isClean = Boolean(ps.cleanRun);
      const aidChips = [];
      if (isClean) {
        aidChips.push(`<span class="exam-hint-chip is-clean">✓ Clean (${ps.openBookExam ? '0 hints' : 'closed-book'})</span>`);
      }
      if (hTotal > 0) {
        aidChips.push(`<span class="exam-hint-chip is-assisted">💡 ${hTotal} hint${hTotal === 1 ? '' : 's'} (${hQs} Q${hQs === 1 ? '' : 's'})</span>`);
      }
      if (rQs > 0) {
        aidChips.push(`<span class="exam-hint-chip ${ps.openBookExam ? 'is-info' : 'is-assisted'}">📖 Ref: ${rQs} Q${rQs === 1 ? '' : 's'}${rSec >= 10 ? ` · ${clockSec(rSec)}` : ''}</span>`);
      }
      const breakPart = ps.breaksCount > 0
        ? ` · ${ps.breaksCount} break${ps.breaksCount === 1 ? '' : 's'}${ps.breakSec >= 60 ? ` (${Math.round(ps.breakSec / 60)}m)` : ''}`
        : '';
      const rawPart = totalAidPen >= 0.05 ? ` (raw ${Math.round(ps.rawPct ?? ps.pct)}%, -${totalAidPen.toFixed(1)} aid adj)` : '';
      const targetMsg = g.letter === 'A'
        ? (isClean ? 'Clean Target A achieved! Locked onto your Exams board.' : 'Target A achieved (aided) — retake closed-book with 0 aids for a Clean A!')
        : `+${g.toA}% to hit BI Grade A (85%) — review your weak questions and beat this score.`;
      examGradeHtml = `
        <div class="exam-result-grade-banner ${g.cls}">
          <div class="exam-result-medal ${g.cls}"><span>${star}${g.letter}</span></div>
          <div class="exam-result-grade-copy">
            <div class="exam-result-grade-top">
              <strong>BI Grade ${g.letter} · ${Math.round(ps.pct)}%</strong>
              <span class="exam-result-kind">${esc(modeTag)}</span>
              ${aidChips.join('')}
            </div>
            <div class="exam-result-grade-sub">${ps.earnedPts.toFixed(1)} / ${ps.totalPts} pts${rawPart} (${ps.gradedCount}/${ps.totalCount} graded${breakPart}) · ${esc(targetMsg)}</div>
          </div>
        </div>
      `;
    }
    hdr.innerHTML = `
      <span class="eyebrow">${esc(activeRun.courseMeta.shortTitle)} · ${activeRun.mode === 'exam' ? 'Exam Grade Report' : 'Run Summary'}</span>
      <h2>${m.reviewed} / ${m.total} Verified · Run UPI ${m.liveUpi ?? '—'}</h2>
      ${examGradeHtml}
      <div class="metrics-grid" style="margin:12px 0 4px">
        <div class="metric-tile"><small>Beat Adamlite</small><b>${m.beatCount} / ${m.reviewed || 0}</b></div>
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
    if (wasExam) {
      const finalGrade = recomputeExamRunGrade({ includeUnverifiedAsZero: Boolean(activeRun.paperSubmitted) });
      if (finalGrade && (activeRun.paperSubmitted || finalGrade.gradedCount >= Math.max(1, Math.ceil(finalGrade.totalCount * 0.5)))) {
        persistExamRunGradeIfReady(true);
      }
    }
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
    closeFloatingParBar();
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

  function pauseIfRunning() {
    if (!activeRun) return;
    pauseCurrentTimer();
    window.StudyPdf.dispose();
  }

  function exitRunnerKeepPaused() {
    window.StudyApp.flushPendingDrafts?.();
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
    syncRunnerStickyOffset();
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
    if (!nextSplit && st.readerTab === 'pdf' && dockReferenceLayout.matches) {
      st.readerTab = 'task';
    }
    st.layoutOverride = nextSplit ? 'split' : 'foveal';
    if (dockReferenceLayout.matches) {
      saveRunnerUiPrefs({ preferredLayout: nextSplit ? 'split' : 'focus' });
    }
    toast(nextSplit ? 'Split view' : 'Focus view');
    renderRunner();
  }

  function toggleRunnerReference() {
    if (!document.body.classList.contains('in-runner')) {
      window.StudyApp?.toggleSiteReferenceSidebar?.();
      return;
    }
    const q = currentQuestion();
    const refButton = document.getElementById('run-ref-btn');
    if (!q || refButton.hidden) return;
    const docked = refButton.getAttribute('aria-expanded') === 'true';
    if (!dockReferenceLayout.matches) {
      if (window.StudyUI.isReferenceDrawerOpen?.()) {
        window.StudyUI.closeReferenceDrawer();
        return;
      }
      openReferenceDrawer(activeRun.courseMeta, q.obsidianLink?.file || '', q.obsidianLink?.heading || '', { question: q, bank: activeRun.bank });
      refButton.setAttribute('aria-expanded', 'true');
      markQuestionRefOpened(q, itemState(q.id), true);
      return;
    }
    const opening = !docked;
    saveRunnerUiPrefs({ dockRefPane: opening });
    if (opening) {
      const st = itemState(q.id);
      st.layoutOverride = 'split';
      markQuestionRefOpened(q, st, true);
    }
    renderRunner();
  }

  function syncRunnerStickyOffset() {
    const runnerHeader = document.getElementById('runner-header');
    if (!runnerHeader || runnerHeader.hidden) return;
    const h = runnerHeader.offsetHeight || 72;
    const topGap = window.innerWidth >= 721 ? 16 : 6;
    document.body.style.setProperty('--runner-sticky-top', `${h + topGap}px`);
  }

  function bindRunnerGlobals() {
    const runnerHeader = document.getElementById('runner-header');
    new ResizeObserver(() => {
      syncRunnerStickyOffset();
    }).observe(runnerHeader);
    window.addEventListener('resize', syncRunnerStickyOffset, { passive: true });
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
      const item = ev.target?.closest?.('.runner-menu-item');
      if (item) {
        item.closest('[popover]')?.hidePopover?.();
      }
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
      if (e.target?.closest?.('.pdf-zoom-scroll, .pdf-reader-bar, .pdf-zoom-tools, #ai-tutor-pane, #quick-fix-popover, #runner-tools-popover')) return;
      if (!document.getElementById('img-lightbox')?.hidden) return;

      // Cmd/Ctrl + Enter works even while typing inside the answer textarea:
      // 1st press -> Reveal Solution / Check Answer; 2nd press -> Got It Right & Next Question!
      if (e.isComposing) return;
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
      } else if (key === 'b') {
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

    // Global clipboard image paste anywhere inside an active runner question (except inside AI Tutor or other inputs)
    window.addEventListener('paste', (ev) => {
      if (!activeRun || !activeRun._attachImageBlobs || document.getElementById('view-runner')?.hidden) return;
      const target = ev.target;
      if (target?.id === 'inp-written-draft') return; // handled directly on the textarea
      if (target?.closest?.('#ai-tutor-pane, #ai-tutor-drawer, dialog')) return;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      const items = Array.from(ev.clipboardData?.items || []);
      const imgFiles = items
        .filter((it) => it.kind === 'file' && /^image\//i.test(it.type))
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (imgFiles.length) {
        ev.preventDefault();
        activeRun._attachImageBlobs(imgFiles);
      }
    });
  }

  return {
    getRun,
    getActiveCourseId: () => activeRun?.courseMeta?.courseId || '',
    isInExam: () => Boolean(activeRun && activeRun.mode === 'exam' && !document.getElementById('view-runner')?.hidden),
    isIdeCodingFocusExempt,
    startRun,
    pauseIfRunning,
    resumePausedRun,
    bindRunnerGlobals,
    onBreakStateChange,
    onDevModeChange,
    isSaving: () => pendingSaves > 0,
    setAutoPauseMode,
    getAutoPauseMode: () => autoPauseMode,
    isMathParAutoRevealEnabled,
    setMathParAutoRevealEnabled,
    toggleFullscreen,
    refreshCurrent: () => { if (activeRun) renderRunner(); },
  };
})();
