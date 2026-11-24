'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_KEY = 'studyOs.timersByNotebook.v2';

let extContext = null;
let timerBarItem = null;
let finishBarItem = null;
let tickHandle = null;

// Active session tracked for the currently focused Jupyter notebook
let activeSession = null; // { key, qid, courseId, shortLabel, title, parSec, accumSec, startedAtMs, paused, pauseReason, lastActivityMs, nbUriStr, execDone, execTotal }

function formatClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function decodeBase64UrlJson(b64) {
  if (!b64) return null;
  let norm = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  while (norm.length % 4) norm += '=';
  const raw = Buffer.from(norm, 'base64').toString('utf8');
  return JSON.parse(raw);
}

function getSavedTimers() {
  if (!extContext) return {};
  return extContext.globalState.get(STATE_KEY, {}) || {};
}

function saveTimerElapsed(key, sec) {
  if (!extContext || !key) return;
  const all = { ...getSavedTimers() };
  all[key] = { sec: Math.max(0, Math.round(Number(sec) || 0)), updatedAt: Date.now() };
  // Keep latest 80 tracked notebooks
  const keys = Object.keys(all).sort((a, b) => (all[b]?.updatedAt || 0) - (all[a]?.updatedAt || 0));
  while (keys.length > 80) delete all[keys.pop()];
  extContext.globalState.update(STATE_KEY, all);
}

function currentElapsedSec(sess = activeSession, now = Date.now()) {
  if (!sess) return 0;
  return sess.paused
    ? sess.accumSec
    : sess.accumSec + Math.max(0, (now - sess.startedAtMs) / 1000);
}

function pauseActiveSession(reason = 'manual') {
  if (!activeSession || activeSession.paused) return;
  activeSession.accumSec = currentElapsedSec(activeSession);
  activeSession.paused = true;
  activeSession.pauseReason = reason;
  saveTimerElapsed(activeSession.key, activeSession.accumSec);
  renderStatusBars();
}

function resumeActiveSession() {
  if (!activeSession || !activeSession.paused) return;
  activeSession.startedAtMs = Date.now();
  activeSession.lastActivityMs = Date.now();
  activeSession.paused = false;
  activeSession.pauseReason = '';
  renderStatusBars();
}

function countExecutedCells(nbDoc) {
  if (!nbDoc) return { execDone: 0, execTotal: 0 };
  const cells = nbDoc.getCells();
  let total = 0;
  let done = 0;
  for (const c of cells) {
    if (c.kind !== vscode.NotebookCellKind.Code) continue;
    const text = (c.document?.getText?.() || '').trim();
    // Skip pure import cell from progress denominator when multiple code cells exist
    const isPureImport = /^import\s+pandas/m.test(text) && text.split('\n').length <= 4 && cells.length > 3;
    if (isPureImport) continue;
    total++;
    const hasRun = (Array.isArray(c.outputs) && c.outputs.length > 0) || Boolean(c.executionSummary?.executionOrder);
    if (hasRun) done++;
  }
  return { execDone: done, execTotal: total };
}

function readNotebookStudyMeta(nbDoc) {
  if (!nbDoc) return null;
  // 1. Check in-memory notebook metadata
  const rawMeta = nbDoc.metadata?.studyOs || nbDoc.metadata?.custom?.metadata?.studyOs;
  if (rawMeta && typeof rawMeta === 'object' && rawMeta.qid) {
    return rawMeta;
  }
  // 2. Fallback: read JSON metadata directly from disk (.ipynb) for VS Code versions that nest metadata differently
  try {
    const fsPath = nbDoc.uri?.fsPath;
    if (fsPath && fsPath.endsWith('.ipynb') && fs.existsSync(fsPath)) {
      const parsed = JSON.parse(fs.readFileSync(fsPath, 'utf8'));
      if (parsed?.metadata?.studyOs?.qid) return parsed.metadata.studyOs;
    }
  } catch {}
  return null;
}

function resolvePracticeDir() {
  const cfg = vscode.workspace.getConfiguration('studyOs');
  const configured = String(cfg.get('practiceFolder') || '').trim();
  if (configured) {
    const resolved = configured.startsWith('~')
      ? path.join(os.homedir(), configured.slice(1))
      : configured;
    return { practiceDir: resolved, dataSourceDirs: [resolved, path.dirname(resolved)] };
  }

  const wsFolders = vscode.workspace.workspaceFolders || [];
  if (wsFolders.length) {
    const root = wsFolders[0].uri.fsPath;
    const filesSub = path.join(root, 'Files');
    if (fs.existsSync(filesSub) && fs.statSync(filesSub).isDirectory()) {
      return {
        practiceDir: path.join(filesSub, 'StudyOS-Practice'),
        dataSourceDirs: [filesSub, root],
      };
    }
    return {
      practiceDir: path.join(root, 'StudyOS-Practice'),
      dataSourceDirs: [root, path.dirname(root)],
    };
  }

  const biDefault = path.join(
    os.homedir(),
    'Library',
    'CloudStorage',
    'OneDrive-BINorwegianBusinessSchool(BIEDU)',
    'Canvas-Archive',
    'Programming, Data Extraction and Visualisation--3021',
    'Files'
  );
  if (fs.existsSync(biDefault)) {
    return {
      practiceDir: path.join(biDefault, 'StudyOS-Practice'),
      dataSourceDirs: [biDefault],
    };
  }

  const fallback = path.join(os.homedir(), 'Study-OS-Practice');
  return { practiceDir: fallback, dataSourceDirs: [fallback] };
}

function ensureDatasetLinks(practiceDir, dataSourceDirs) {
  const linked = [];
  const dataExtRe = /\.(csv|xlsx|xls|json|tsv|txt|parquet)$/i;
  for (const srcDir of dataSourceDirs) {
    if (!srcDir || srcDir === practiceDir || !fs.existsSync(srcDir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(srcDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!dataExtRe.test(name)) continue;
      const cleanName = name.replace(/^\d+--/, '');
      const targetPath = path.join(srcDir, name);
      const linkPath = path.join(practiceDir, cleanName);
      if (fs.existsSync(linkPath)) continue;
      try {
        const rel = path.relative(practiceDir, targetPath);
        fs.symlinkSync(rel, linkPath);
        linked.push(cleanName);
      } catch {
        try {
          fs.copyFileSync(targetPath, linkPath);
          linked.push(cleanName);
        } catch {}
      }
    }
  }
  return linked;
}

function toNotebookLines(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  if (!raw) return [];
  const lines = raw.split('\n');
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
}

function buildExamNotebook(payload) {
  const qid = String(payload.qid || 'exercise');
  const courseId = String(payload.courseId || (qid.includes(':') ? qid.split(':')[0] : 'prog-3021'));
  const title = String(payload.title || qid);
  const topic = String(payload.topic || '');
  const parSec = Math.max(60, Number(payload.parSec) || 900);
  const prompt = String(payload.promptMarkdown || '').replace(/\r\n/g, '\n').trim();

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
  const headerMeta = [
    `# ${title}`,
    `> **Study-OS AI Par:** \`${formatClock(parSec)}\`${topic ? ` · **Topic:** ${topic}` : ''} · \`${qid}\``,
  ];
  const introBody = introLines.join('\n').trim();
  if (introBody) headerMeta.push('', introBody);

  cells.push({
    cell_type: 'markdown',
    metadata: {},
    source: toNotebookLines(headerMeta.join('\n')),
  });

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
      const mdText = `**${sp.label}** ${sp.body.join('\n').trim()}`;
      cells.push({
        cell_type: 'markdown',
        metadata: {},
        source: toNotebookLines(mdText),
      });
      const initialCode = idx === 0 && starterCode ? starterCode : `# ${sp.label}\n`;
      cells.push({
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: toNotebookLines(initialCode),
      });
    });
  } else {
    const firstCodeParts = [];
    if (autoImports.length && !starterCode.includes('import pandas')) {
      firstCodeParts.push(autoImports.join('\n'));
    }
    firstCodeParts.push(starterCode || `# Write your solution for ${qid} below\n`);
    cells.push({
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      outputs: [],
      source: toNotebookLines(firstCodeParts.join('\n\n')),
    });
  }

  return {
    cells,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', mimetype: 'text/x-python', file_extension: '.py' },
      studyOs: {
        qid,
        courseId,
        title,
        parSec,
        createdAt: new Date().toISOString(),
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function renderStatusBars() {
  if (!timerBarItem || !finishBarItem) return;

  if (!activeSession) {
    const activeNb = vscode.window.activeNotebookEditor?.notebook;
    if (activeNb && activeNb.uri?.fsPath?.endsWith('.ipynb')) {
      timerBarItem.text = '$(play) Study-OS Par';
      timerBarItem.command = 'studyOs.startNotebookTimer';
      timerBarItem.backgroundColor = undefined;
      timerBarItem.tooltip = 'Start a Study-OS AI-Par timer for this Jupyter notebook';
      timerBarItem.show();
    } else {
      timerBarItem.hide();
    }
    finishBarItem.hide();
    return;
  }

  timerBarItem.command = 'studyOs.toggleTimer';
  const now = Date.now();
  const elapsedSec = currentElapsedSec(activeSession, now);
  const parSec = activeSession.parSec;
  const remSec = parSec - elapsedSec;
  const cellsStr = activeSession.execTotal > 0 ? ` · ${activeSession.execDone}/${activeSession.execTotal} cells` : '';
  const shortId = activeSession.shortLabel || activeSession.qid;

  if (activeSession.paused) {
    const reason = activeSession.pauseReason === 'idle' ? 'Idle paused' : 'Paused';
    timerBarItem.text = `$(debug-pause) ${shortId} · ${formatClock(elapsedSec)} / ${formatClock(parSec)} (${reason})`;
    timerBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (remSec <= 0) {
    timerBarItem.text = `$(flame) ${shortId} · ${formatClock(elapsedSec)} / ${formatClock(parSec)} (+${formatClock(-remSec)} over${cellsStr})`;
    timerBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (remSec <= Math.min(180, parSec * 0.2)) {
    timerBarItem.text = `$(watch) ${shortId} · ${formatClock(elapsedSec)} / ${formatClock(parSec)} (${formatClock(remSec)} left${cellsStr})`;
    timerBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    timerBarItem.text = `$(watch) ${shortId} · ${formatClock(elapsedSec)} / ${formatClock(parSec)} (${formatClock(remSec)} left${cellsStr})`;
    timerBarItem.backgroundColor = undefined;
  }
  timerBarItem.tooltip = `Study-OS AI-Par Timer\n${activeSession.title}\nCells executed: ${activeSession.execDone}/${activeSession.execTotal}\nClick to ${activeSession.paused ? 'resume' : 'pause'}`;
  timerBarItem.show();

  if (activeSession.qid && activeSession.qid.includes(':')) {
    finishBarItem.text = '$(check) Sync to Study-OS';
    finishBarItem.tooltip = `Finish ${shortId} and log active time (${formatClock(elapsedSec)}) + completion to Study-OS`;
    finishBarItem.show();
  } else {
    finishBarItem.text = '$(check) Finish';
    finishBarItem.tooltip = 'Complete or reset this notebook timer';
    finishBarItem.show();
  }
}

function ensureTickInterval() {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    if (!activeSession) return;
    const now = Date.now();
    // Auto-pause after configured idle minutes
    const idleMin = Number(vscode.workspace.getConfiguration('studyOs').get('idlePauseMinutes') ?? 3);
    if (!activeSession.paused && idleMin > 0 && now - activeSession.lastActivityMs >= idleMin * 60_000) {
      pauseActiveSession('idle');
      return;
    }
    // Persist elapsed seconds every ~15s
    if (!activeSession.paused && Math.floor(now / 1000) % 15 === 0) {
      saveTimerElapsed(activeSession.key, currentElapsedSec(activeSession, now));
    }
    renderStatusBars();
  }, 1000);
}

function activateTimerForNotebook(nbDoc, meta, overrideElapsedSec = null) {
  const nbUriStr = nbDoc?.uri?.toString?.() || '';
  const rawQid = String(meta.qid || path.basename(nbDoc?.uri?.fsPath || 'notebook', '.ipynb'));
  const key = rawQid || nbUriStr;

  // Persist & pause previous session if switching notebooks
  if (activeSession && activeSession.key !== key) {
    pauseActiveSession('switched');
  }

  const saved = getSavedTimers()[key];
  const savedSec = Number(saved?.sec || 0);
  const startAccum = overrideElapsedSec != null
    ? Math.max(savedSec, Math.max(0, Number(overrideElapsedSec) || 0))
    : savedSec;
  const parSec = Math.max(60, Number(meta.parSec) || 900);
  const shortLabel = rawQid.includes(':') ? rawQid.split(':')[1] : rawQid.slice(0, 22);
  const { execDone, execTotal } = countExecutedCells(nbDoc);

  activeSession = {
    key,
    qid: rawQid,
    courseId: String(meta.courseId || (rawQid.includes(':') ? rawQid.split(':')[0] : '')),
    shortLabel,
    title: String(meta.title || shortLabel),
    parSec,
    accumSec: startAccum,
    startedAtMs: Date.now(),
    paused: false,
    pauseReason: '',
    lastActivityMs: Date.now(),
    nbUriStr,
    execDone,
    execTotal,
  };
  ensureTickInterval();
  renderStatusBars();
}

function syncWithActiveNotebookEditor(editor) {
  if (!editor || !editor.notebook) {
    if (activeSession && !activeSession.paused) {
      pauseActiveSession('unfocused');
    }
    renderStatusBars();
    return;
  }
  const nbDoc = editor.notebook;
  const meta = readNotebookStudyMeta(nbDoc);
  if (meta && meta.qid) {
    if (activeSession && activeSession.key === meta.qid) {
      const counts = countExecutedCells(nbDoc);
      activeSession.execDone = counts.execDone;
      activeSession.execTotal = counts.execTotal;
      activeSession.nbUriStr = nbDoc.uri.toString();
      if (activeSession.paused && activeSession.pauseReason !== 'manual') {
        resumeActiveSession();
      } else {
        renderStatusBars();
      }
      return;
    }
    activateTimerForNotebook(nbDoc, meta);
  } else {
    if (activeSession && activeSession.nbUriStr !== nbDoc.uri.toString()) {
      pauseActiveSession('switched');
    }
    renderStatusBars();
  }
}

async function openExerciseFromPayload(payload) {
  const { practiceDir, dataSourceDirs } = resolvePracticeDir();
  fs.mkdirSync(practiceDir, { recursive: true });
  ensureDatasetLinks(practiceDir, dataSourceDirs);

  const rawId = String(payload.qid || 'exercise').replace(/^[^:]+:/, '');
  const safeId = rawId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'exercise';
  const filePath = path.join(practiceDir, `${safeId}.ipynb`);

  const forceReset = Boolean(payload.reset);
  if (forceReset || !fs.existsSync(filePath)) {
    const nb = buildExamNotebook(payload);
    fs.writeFileSync(filePath, JSON.stringify(nb, null, 2), 'utf8');
  }

  const fileUri = vscode.Uri.file(filePath);
  const nbDoc = await vscode.workspace.openNotebookDocument(fileUri);
  const nbEditor = await vscode.window.showNotebookDocument(nbDoc, {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false,
  });

  // Drop cursor straight inside the first Python task code cell
  const cells = nbDoc.getCells();
  const codeIndices = cells
    .map((c, idx) => (c.kind === vscode.NotebookCellKind.Code ? idx : -1))
    .filter((idx) => idx >= 0);
  let targetIdx = codeIndices[0] ?? 0;
  if (codeIndices.length >= 2) {
    const firstText = cells[codeIndices[0]]?.document?.getText?.() || '';
    if (/^import\s+pandas/m.test(firstText) && firstText.split('\n').length <= 4) {
      targetIdx = codeIndices[1];
    }
  }

  const range = new vscode.NotebookRange(targetIdx, targetIdx + 1);
  nbEditor.selections = [range];
  nbEditor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);

  setTimeout(() => {
    vscode.commands.executeCommand('notebook.cell.edit').then(undefined, () => {});
  }, 180);

  activateTimerForNotebook(
    nbDoc,
    {
      qid: String(payload.qid || safeId),
      courseId: String(payload.courseId || (String(payload.qid || '').includes(':') ? String(payload.qid).split(':')[0] : 'prog-3021')),
      title: String(payload.title || safeId),
      parSec: Number(payload.parSec) || 900,
    },
    Number(payload.elapsedSec) || 0
  );
}

async function finishExerciseFlow() {
  if (!activeSession) {
    vscode.window.showInformationMessage('No active Study-OS notebook timer right now.');
    return;
  }
  const elapsedSec = Math.max(1, Math.round(currentElapsedSec(activeSession)));
  const parSec = activeSession.parSec;
  const paceSummary = elapsedSec <= parSec
    ? `${formatClock(elapsedSec)} vs ${formatClock(parSec)} par (Under par!)`
    : `${formatClock(elapsedSec)} vs ${formatClock(parSec)} par (+${formatClock(elapsedSec - parSec)} over)`;
  const isLinkedQuestion = Boolean(activeSession.qid && activeSession.qid.includes(':'));

  const items = isLinkedQuestion
    ? [
        { label: '$(check) Got It Right (100%) — Sync to Study-OS', description: paceSummary, action: 'sync', acc: 1.0 },
        { label: '$(pass) Mostly Right (75%) — Sync to Study-OS', description: paceSummary, action: 'sync', acc: 0.75 },
        { label: '$(history) Needs Revisit (0%) — Flag in Study-OS', description: paceSummary, action: 'sync', acc: 0.0 },
        { label: '$(book) Open Worked Solution in Study-OS', description: 'Pause timer & verify your output', action: 'review' },
        { label: activeSession.paused ? '$(play) Resume Timer' : '$(debug-pause) Pause Timer', description: '', action: 'toggle' },
        { label: '$(refresh) Reset Timer for This Notebook', description: 'Set elapsed back to 0:00', action: 'reset' },
      ]
    : [
        { label: activeSession.paused ? '$(play) Resume Timer' : '$(debug-pause) Pause Timer', description: paceSummary, action: 'toggle' },
        { label: '$(refresh) Reset Timer for This Notebook', description: 'Set elapsed back to 0:00', action: 'reset' },
        { label: '$(close) Stop & Hide Timer', description: '', action: 'stop' },
      ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Study-OS · ${activeSession.shortLabel} (${activeSession.execDone}/${activeSession.execTotal} cells run)`,
    placeHolder: 'Log completion back to Study-OS or manage timer',
  });
  if (!picked) return;

  if (picked.action === 'toggle') {
    vscode.commands.executeCommand('studyOs.toggleTimer');
    return;
  }
  if (picked.action === 'reset') {
    activeSession.accumSec = 0;
    activeSession.startedAtMs = Date.now();
    activeSession.paused = false;
    activeSession.pauseReason = '';
    saveTimerElapsed(activeSession.key, 0);
    renderStatusBars();
    return;
  }
  if (picked.action === 'stop') {
    vscode.commands.executeCommand('studyOs.stopTimer');
    return;
  }

  pauseActiveSession('completed');
  const baseUrl = String(vscode.workspace.getConfiguration('studyOs').get('webUrl') || 'https://studyos.no').replace(/\/+$/, '');
  const qs = new URLSearchParams({
    ide_complete: '1',
    qid: activeSession.qid,
    sec: String(elapsedSec),
    cells: `${activeSession.execDone}/${activeSession.execTotal}`,
    ts: String(Date.now()),
  });
  if (picked.action === 'review') {
    qs.set('review', '1');
  } else {
    qs.set('acc', String(picked.acc));
    saveTimerElapsed(activeSession.key, 0);
  }
  await vscode.env.openExternal(vscode.Uri.parse(`${baseUrl}/?${qs.toString()}`));
}

async function startTimerForGenericNotebook() {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || !editor.notebook) {
    vscode.window.showInformationMessage('Open a Jupyter notebook (.ipynb) first.');
    return;
  }
  const nbDoc = editor.notebook;
  const existingMeta = readNotebookStudyMeta(nbDoc);
  if (existingMeta?.qid) {
    activateTimerForNotebook(nbDoc, existingMeta);
    return;
  }
  const { execTotal } = countExecutedCells(nbDoc);
  const estMin = Math.max(10, Math.min(180, Math.round(Math.max(2, execTotal) * 7)));
  const picked = await vscode.window.showQuickPick(
    [
      { label: `${estMin} min (Auto-estimated for ${execTotal || 1} code cells)`, min: estMin },
      { label: '20 min · Short Exercise', min: 20 },
      { label: '45 min · Medium Task', min: 45 },
      { label: '60 min · Short Mock Exam', min: 60 },
      { label: '180 min · Full 3-Hour Exam', min: 180 },
    ],
    { title: 'Study-OS AI-Par Target for Notebook', placeHolder: 'Choose target par time' }
  );
  if (!picked) return;
  const name = path.basename(nbDoc.uri.fsPath || 'Notebook', '.ipynb').replace(/^\d+--/, '');
  activateTimerForNotebook(nbDoc, {
    qid: nbDoc.uri.toString(),
    title: name,
    parSec: picked.min * 60,
  });
}

function activate(context) {
  extContext = context;
  timerBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1001);
  timerBarItem.command = 'studyOs.toggleTimer';
  finishBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  finishBarItem.command = 'studyOs.finishExercise';
  context.subscriptions.push(timerBarItem, finishBarItem);

  const touchActivity = (nbUriStr = '') => {
    if (!activeSession) return;
    if (nbUriStr && activeSession.nbUriStr && nbUriStr !== activeSession.nbUriStr) return;
    activeSession.lastActivityMs = Date.now();
    if (activeSession.paused && activeSession.pauseReason === 'idle') {
      resumeActiveSession();
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveNotebookEditor((editor) => syncWithActiveNotebookEditor(editor)),
    vscode.workspace.onDidChangeNotebookDocument((ev) => {
      if (!activeSession || ev.notebook.uri.toString() !== activeSession.nbUriStr) return;
      const counts = countExecutedCells(ev.notebook);
      activeSession.execDone = counts.execDone;
      activeSession.execTotal = counts.execTotal;
      touchActivity(ev.notebook.uri.toString());
      renderStatusBars();
    }),
    vscode.workspace.onDidChangeTextDocument((ev) => {
      if (ev.document.uri.scheme === 'vscode-notebook-cell') {
        touchActivity();
      }
    }),
    vscode.commands.registerCommand('studyOs.toggleTimer', () => {
      if (!activeSession) return;
      if (activeSession.paused) resumeActiveSession();
      else pauseActiveSession('manual');
    }),
    vscode.commands.registerCommand('studyOs.finishExercise', () => finishExerciseFlow()),
    vscode.commands.registerCommand('studyOs.startNotebookTimer', () => startTimerForGenericNotebook()),
    vscode.commands.registerCommand('studyOs.stopTimer', () => {
      if (activeSession) saveTimerElapsed(activeSession.key, currentElapsedSec(activeSession));
      activeSession = null;
      renderStatusBars();
    }),
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        try {
          const params = new URLSearchParams(uri.query || '');
          const dataParam = params.get('data');
          const payload = dataParam
            ? decodeBase64UrlJson(dataParam)
            : {
                qid: params.get('qid') || 'exercise',
                courseId: params.get('courseId') || '',
                title: params.get('title') || 'Study-OS Exercise',
                parSec: Number(params.get('par')) || 900,
                elapsedSec: Number(params.get('elapsed')) || 0,
                topic: params.get('topic') || '',
                promptMarkdown: params.get('prompt') || '',
                reset: params.get('reset') === '1',
              };
          if (!payload || !payload.qid) return;
          await openExerciseFromPayload(payload);
        } catch (err) {
          vscode.window.showErrorMessage(`Study-OS Companion could not open exercise: ${err?.message || err}`);
        }
      },
    })
  );

  // Immediately inspect already-open notebook on activation
  if (vscode.window.activeNotebookEditor) {
    syncWithActiveNotebookEditor(vscode.window.activeNotebookEditor);
  }
}

function deactivate() {
  if (activeSession) {
    saveTimerElapsed(activeSession.key, currentElapsedSec(activeSession));
  }
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
}

module.exports = { activate, deactivate };
