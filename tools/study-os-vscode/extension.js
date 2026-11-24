'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

let statusBarItem = null;
let timerInterval = null;
let activeTimer = null;

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
  const title = String(payload.title || qid);
  const topic = String(payload.topic || '');
  const parSec = Math.max(60, Number(payload.parSec) || 900);
  const prompt = String(payload.promptMarkdown || '').replace(/\r\n/g, '\n').trim();

  // Extract optional starter python block
  let starterCode = '';
  const starterMatch = prompt.match(/```python\s*\n([\s\S]*?)```/i);
  if (starterMatch) {
    starterCode = starterMatch[1].trim();
  }

  // Detect whether pandas / plotting imports are helpful
  const needsPandas = /\b(pandas|pd\.|dataframe|read_csv|groupby|crosstab|resample|\.csv)\b/i.test(prompt);
  const needsPlot = /\b(matplotlib|plt\.|seaborn|sns\.|subplot|plot|chart|heatmap|facetgrid|scatter|histogram|pie)\b/i.test(prompt);
  const autoImports = [];
  if (needsPandas) autoImports.push('import pandas as pd');
  if (needsPlot) {
    autoImports.push('import matplotlib.pyplot as plt');
    if (/\b(seaborn|sns|heatmap|facetgrid)\b/i.test(prompt)) autoImports.push('import seaborn as sns');
  }

  // Split bulleted / lettered exam subparts into individual Markdown + Code cells
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
      if (line.trim() === '' && subparts.length > 0) {
        activeSub.body.push(line);
      } else if (/^\s+/.test(line) || /^[-*]\s+/.test(line)) {
        activeSub.body.push(line);
      } else if (line.startsWith('```') || activeSub.inFence) {
        if (line.startsWith('```')) activeSub.inFence = !activeSub.inFence;
        activeSub.body.push(line);
      } else {
        activeSub.body.push(line);
      }
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
    if (starterCode) {
      firstCodeParts.push(starterCode);
    } else {
      firstCodeParts.push(`# Write your solution for ${qid} below\n`);
    }
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
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
      language_info: {
        name: 'python',
        mimetype: 'text/x-python',
        file_extension: '.py',
      },
      studyOs: {
        qid,
        title,
        parSec,
        createdAt: new Date().toISOString(),
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function renderStatusBar() {
  if (!statusBarItem) return;
  if (!activeTimer) {
    statusBarItem.hide();
    return;
  }
  const now = Date.now();
  const elapsedSec = activeTimer.paused
    ? activeTimer.accumSec
    : activeTimer.accumSec + (now - activeTimer.startedAtMs) / 1000;
  const parSec = activeTimer.parSec;
  const remSec = parSec - elapsedSec;

  const shortId = activeTimer.shortLabel || activeTimer.qid;
  if (activeTimer.paused) {
    statusBarItem.text = `$(debug-pause) ${shortId} · ${formatClock(elapsedSec)} / ${formatClock(parSec)} (Paused)`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (remSec <= 0) {
    statusBarItem.text = `$(flame) ${shortId} · ${formatClock(elapsedSec)} / ${formatClock(parSec)} (+${formatClock(-remSec)} over par)`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (remSec <= Math.min(180, parSec * 0.2)) {
    statusBarItem.text = `$(watch) ${shortId} · ${formatClock(elapsedSec)} / ${formatClock(parSec)} (${formatClock(remSec)} left)`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusBarItem.text = `$(watch) ${shortId} · ${formatClock(elapsedSec)} / ${formatClock(parSec)} (${formatClock(remSec)} left)`;
    statusBarItem.backgroundColor = undefined;
  }
  statusBarItem.tooltip = `Study-OS AI-Par Timer\n${activeTimer.title}\nClick to ${activeTimer.paused ? 'resume' : 'pause'}`;
  statusBarItem.show();
}

function startStatusTimer(payload) {
  const parSec = Math.max(60, Number(payload.parSec) || 900);
  const startElapsed = Math.max(0, Number(payload.elapsedSec) || 0);
  const rawQid = String(payload.qid || 'Task');
  const shortLabel = rawQid.includes(':') ? rawQid.split(':')[1] : rawQid;
  activeTimer = {
    qid: rawQid,
    shortLabel,
    title: String(payload.title || rawQid),
    parSec,
    accumSec: startElapsed,
    startedAtMs: Date.now(),
    paused: false,
  };
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(renderStatusBar, 1000);
  renderStatusBar();
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

  // Jump directly into the first Python code cell (prefer first task cell after imports if present)
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

  startStatusTimer(payload);
}

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  statusBarItem.command = 'studyOs.toggleTimer';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('studyOs.toggleTimer', () => {
      if (!activeTimer) return;
      if (activeTimer.paused) {
        activeTimer.startedAtMs = Date.now();
        activeTimer.paused = false;
      } else {
        activeTimer.accumSec += (Date.now() - activeTimer.startedAtMs) / 1000;
        activeTimer.paused = true;
      }
      renderStatusBar();
    }),
    vscode.commands.registerCommand('studyOs.stopTimer', () => {
      activeTimer = null;
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      renderStatusBar();
    }),
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        try {
          const params = new URLSearchParams(uri.query || '');
          const dataParam = params.get('data');
          let payload = null;
          if (dataParam) {
            payload = decodeBase64UrlJson(dataParam);
          } else {
            payload = {
              qid: params.get('qid') || 'exercise',
              title: params.get('title') || 'Study-OS Exercise',
              parSec: Number(params.get('par')) || 900,
              elapsedSec: Number(params.get('elapsed')) || 0,
              topic: params.get('topic') || '',
              promptMarkdown: params.get('prompt') || '',
              reset: params.get('reset') === '1',
            };
          }
          if (!payload || !payload.qid) return;
          await openExerciseFromPayload(payload);
        } catch (err) {
          vscode.window.showErrorMessage(`Study-OS Companion could not open exercise: ${err?.message || err}`);
        }
      },
    })
  );
}

function deactivate() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

module.exports = { activate, deactivate };
