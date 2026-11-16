/* Study-OS Bridge — Native Obsidian Desktop Plugin */
'use strict';

const { Plugin, ItemView, MarkdownView, Notice } = require('obsidian');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VIEW_TYPE_STUDY_OS = 'study-os-companion-view';
const SERVER_URL = 'http://127.0.0.1:8765';

const FILE_TO_COURSE = [
  { pattern: /EXC3420|Economics/i, courseId: 'econ-2522', label: 'Economics I' },
  { pattern: /EXC3430|Accounting/i, courseId: 'acct-2527', label: 'Accounting & Finance' },
  { pattern: /math-reference|Mathematics/i, courseId: 'math-2588', label: 'Mathematics' },
  { pattern: /EXC3460|Organizational/i, courseId: 'ob-2537', label: 'Organizational Behavior' },
  { pattern: /EBA3400|Programming/i, courseId: 'prog-3021', label: 'Programming' },
];

function resolveStudyOsRoot(app) {
  const basePath = app.vault.adapter.getBasePath?.();
  if (!basePath) return null;
  return path.resolve(basePath, '..', 'Study-OS');
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function ensureServerAndOpen(studyOsRoot, targetQuery = '') {
  const targetUrl = `${SERVER_URL}/${targetQuery ? '?' + targetQuery.replace(/^\?/, '') : ''}`;
  let alive = false;
  try {
    const res = await fetch(`${SERVER_URL}/api/ping`);
    alive = res.ok;
  } catch {
    alive = false;
  }

  if (!alive && studyOsRoot) {
    const serverScript = path.join(studyOsRoot, 'app', 'server.py');
    if (fs.existsSync(serverScript)) {
      const pyCandidates =
        process.platform === 'win32'
          ? ['python', 'py']
          : ['/opt/anaconda3/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3'];
      let pyCmd = pyCandidates[pyCandidates.length - 1];
      for (const c of pyCandidates) {
        if (!c.includes('/') || fs.existsSync(c)) {
          pyCmd = c;
          break;
        }
      }
      try {
        const child = spawn(pyCmd, [serverScript], {
          cwd: studyOsRoot,
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        new Notice('Starting local Study-OS server…');
        await new Promise((r) => setTimeout(r, 650));
      } catch (e) {
        new Notice('Run OPEN_STUDY_OS launcher in Study-OS folder first.');
      }
    }
  }
  window.open(targetUrl);
}

function mapHeadingToCourseTopic(courseId, rawToken) {
  if (!rawToken) return '';
  const tok = String(rawToken).toUpperCase();
  if (tok === 'DEB') return courseId === 'acct-2527' ? 'DEB' : '';
  if (tok === 'APPENDIX') return courseId === 'prog-3021' ? '6' : '';
  const num = parseInt(tok, 10);
  if (!Number.isFinite(num)) return '';

  if (courseId === 'prog-3021') {
    if (num >= 1 && num <= 4) return '1';
    if (num >= 5 && num <= 6) return '2';
    if (num >= 7 && num <= 8) return '3';
    if (num >= 9 && num <= 10) return '4';
    if (num >= 11 && num <= 13) return '5';
    if (num >= 14 && num <= 16) return '6';
    return '';
  }
  if (courseId === 'econ-2522') return num >= 1 && num <= 9 ? String(num) : '';
  if (courseId === 'ob-2537') return num >= 1 && num <= 14 ? String(num) : '';
  if (courseId === 'math-2588') return num >= 1 && num <= 18 ? String(num) : '';
  if (courseId === 'acct-2527') return [1, 2, 3, 5, 7, 8, 10].includes(num) ? String(num) : '';
  return String(num);
}

function detectActiveContext(app) {
  const file = app.workspace.getActiveFile();
  if (!file) return null;
  const match = FILE_TO_COURSE.find((m) => m.pattern.test(file.path));
  if (!match) return null;

  let topic = '';
  const mdView = app.workspace.getActiveViewOfType(MarkdownView);
  if (mdView && mdView.editor) {
    const lineNo = mdView.editor.getCursor().line;
    for (let i = lineNo; i >= 0; i--) {
      const line = mdView.editor.getLine(i) || '';
      const h = line.match(/^#{1,3}\s+(?:(?:Topic|Lesson|Chapter)\s*)?(DEB|Appendix|\d+)\b/i);
      if (h) {
        topic = mapHeadingToCourseTopic(match.courseId, h[1]);
        break;
      }
    }
  }
  return { ...match, filePath: file.path, topic };
}

class StudyOsCompanionView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_STUDY_OS;
  }

  getDisplayText() {
    return 'Study-OS Companion';
  }

  getIcon() {
    return 'zap';
  }

  async onOpen() {
    this.render();
    this.registerEvent(this.app.workspace.on('file-open', () => this.render()));
  }

  render() {
    const root = this.containerEl.children[1];
    root.empty();
    const wrap = root.createDiv({ cls: 'study-os-pane' });

    const studyRoot = resolveStudyOsRoot(this.app);
    const snap = studyRoot ? readJsonSafe(path.join(studyRoot, 'data', 'logs', 'ai_context_snapshot.json')) : null;
    const cal = studyRoot ? readJsonSafe(path.join(studyRoot, 'data', 'state', 'calendar_cache.json')) : null;
    const catalogObj = studyRoot ? readJsonSafe(path.join(studyRoot, 'data', 'catalog.json')) : null;
    const activeCtx = detectActiveContext(this.app);

    // 1. Active Note Contextual Practice Button
    if (activeCtx) {
      const ctxCard = wrap.createDiv({ cls: 'study-os-card study-os-hero' });
      ctxCard.createEl('h4', {
        text: `📖 Active: ${activeCtx.label}${activeCtx.topic ? ` (Topic ${activeCtx.topic})` : ''}`,
      });
      const btn = ctxCard.createEl('button', {
        cls: 'study-os-btn study-os-btn-primary',
        text: `⚡ Practice ${activeCtx.topic ? 'Topic ' + activeCtx.topic : activeCtx.label} Now`,
      });
      btn.onclick = () => {
        const q = `course=${encodeURIComponent(activeCtx.courseId)}${activeCtx.topic ? '&topic=' + encodeURIComponent(activeCtx.topic) : ''}&autostart=1`;
        ensureServerAndOpen(studyRoot, q);
      };
    }

    // 2. KPI Strip
    const ov = snap?.overall || {};
    const kpis = wrap.createDiv({ cls: 'study-os-kpis' });
    const addKpi = (lbl, val) => {
      const d = kpis.createDiv({ cls: 'study-os-kpi' });
      d.createEl('small', { text: lbl });
      d.createEl('b', { text: String(val) });
    };
    addKpi('UPI', ov.upi ?? '—');
    addKpi('Beat AI', ov.beatAiRate != null ? `${Math.round(ov.beatAiRate * 100)}%` : '—');
    addKpi('Streak', `${snap?.streakDays || 0}d`);

    // 3. Up Next Google Calendar Block
    const nowIso = new Date().toISOString();
    const nextBlk = (cal?.blocks || []).find(
      (b) => b.endIso >= nowIso && (b.blockKind === 'study_block' || b.blockKind === 'recall_sprint')
    );
    if (nextBlk) {
      const calCard = wrap.createDiv({ cls: 'study-os-card' });
      calCard.createEl('small', { text: `📅 ${nextBlk.date} · ${nextBlk.startLabel}–${nextBlk.endLabel}` });
      calCard.createEl('h4', { text: nextBlk.summary });
      const b = calCard.createEl('button', {
        cls: 'study-os-btn study-os-btn-primary',
        text: `▶ Start ${nextBlk.focusMinutes || 50}m Calendar Run`,
      });
      b.onclick = () => ensureServerAndOpen(studyRoot, `autostart_event=${encodeURIComponent(nextBlk.eventId)}`);
    }

    // 4. Courses List
    const courses = catalogObj?.courses || [];
    if (courses.length) {
      const cCard = wrap.createDiv({ cls: 'study-os-card' });
      cCard.createEl('h4', { text: 'Course Mastery' });
      for (const c of courses) {
        const cp = snap?.courseProgress?.[c.courseId] || { done: 0, total: c.questionCount, revisit: 0 };
        const pct = Math.round(((cp.done || 0) / Math.max(1, cp.total || 1)) * 100);
        const row = cCard.createDiv({ cls: 'study-os-course-row' });
        row.createEl('strong', { text: `${c.code} · ${c.shortTitle}` });
        const bar = row.createDiv({ cls: 'study-os-bar' });
        bar.createDiv().style.width = `${pct}%`;
        row.createEl('small', {
          text: `${cp.done || 0}/${cp.total || c.questionCount} done · ${cp.revisit || 0} revisit`,
        });
      }
    }

    // 5. Open Full Hub & Refresh buttons
    const actions = wrap.createDiv();
    const openBtn = actions.createEl('button', { cls: 'study-os-btn', text: '🌐 Open Full Study-OS Hub' });
    openBtn.onclick = () => ensureServerAndOpen(studyRoot, '');
    const refBtn = actions.createEl('button', { cls: 'study-os-btn', text: '↻ Refresh Telemetry' });
    refBtn.onclick = () => this.render();
  }
}

module.exports = class StudyOsBridgePlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_STUDY_OS, (leaf) => new StudyOsCompanionView(leaf, this));

    this.addRibbonIcon('zap', 'Open Study-OS Companion', () => this.activateView());

    this.addCommand({
      id: 'open-study-os-companion',
      name: 'Open Companion Sidebar',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'practice-active-note-in-study-os',
      name: 'Practice Active Note / Chapter Now',
      callback: () => {
        const studyRoot = resolveStudyOsRoot(this.app);
        const ctx = detectActiveContext(this.app);
        if (ctx) {
          const q = `course=${encodeURIComponent(ctx.courseId)}${ctx.topic ? '&topic=' + encodeURIComponent(ctx.topic) : ''}&autostart=1`;
          ensureServerAndOpen(studyRoot, q);
        } else {
          ensureServerAndOpen(studyRoot, '');
        }
      },
    });

    this.addCommand({
      id: 'open-study-os-dashboard-note',
      name: 'Open Live Dashboard Note (01_Study_OS_Dashboard.md)',
      callback: async () => {
        const f = this.app.vault.getAbstractFileByPath('01_Study_OS_Dashboard.md');
        if (f) await this.app.workspace.getLeaf(false).openFile(f);
        else new Notice('Dashboard note will be created on first Study-OS launch.');
      },
    });
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_STUDY_OS)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_STUDY_OS, active: true });
    }
    workspace.revealLeaf(leaf);
  }
};
