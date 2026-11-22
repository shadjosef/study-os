'use strict';

window.StudySets = (() => {
  const { esc, toast, workClock } = window.StudyUI;
  const storageKey = 'study-os-custom-sets';
  const mcpPrompt = 'Use the Study-OS MCP tool draft_study_set to make 12 original question-and-answer cards for [topic] from my notes. Return the clickable Study-OS import link.';
  let draft = null;
  let notice = '';

  function makeId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'set-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function cleanQuestions(rawList) {
    if (!Array.isArray(rawList)) return [];
    const out = [];
    for (const q of rawList.slice(0, 30)) {
      if (!q || typeof q !== 'object') continue;
      const promptMarkdown = String(q.promptMarkdown || q.prompt || q.question || q.q || '').trim().slice(0, 1200);
      const solutionMarkdown = String(q.solutionMarkdown || q.solution || q.answer || q.a || '').trim().slice(0, 1800);
      if (!promptMarkdown || !solutionMarkdown) continue;
      const rawOptions = Array.isArray(q.options)
        ? q.options.slice(0, 5).map((o) => String(o || '').trim().slice(0, 260)).filter(Boolean)
        : [];
      let ansIdx = Number(q.answerIndex);
      if (!Number.isInteger(ansIdx) && typeof q.answer === 'string' && rawOptions.length >= 2) {
        const letter = q.answer.trim().toUpperCase();
        const map = { A: 0, B: 1, C: 2, D: 3, E: 4 };
        if (letter in map) ansIdx = map[letter];
      }
      const isMcq = (q.kind === 'mcq' || rawOptions.length >= 2)
        && rawOptions.length >= 2 && rawOptions.length <= 5
        && Number.isInteger(ansIdx) && ansIdx >= 0 && ansIdx < rawOptions.length;
      const diff = [1, 2, 3].includes(Number(q.difficulty)) ? Number(q.difficulty) : 2;
      out.push({
        title: String(q.title || `Question ${out.length + 1}`).trim().slice(0, 100),
        kind: isMcq ? 'mcq' : 'written',
        difficulty: diff,
        topic: String(q.topic || '').trim().slice(0, 80),
        promptMarkdown,
        ...(isMcq ? { options: rawOptions, answerIndex: ansIdx } : {}),
        hint: String(q.hint || '').trim().slice(0, 360),
        solutionMarkdown,
      });
    }
    return out;
  }

  function cardsToQuestions(cards) {
    return (Array.isArray(cards) ? cards : [])
      .filter((c) => Array.isArray(c) && c.length >= 2 && String(c[0] || '').trim() && String(c[1] || '').trim())
      .slice(0, 30)
      .map(([q, a], idx) => ({
        title: `Card ${idx + 1}`,
        kind: 'written',
        difficulty: 2,
        topic: 'Quick Recall',
        promptMarkdown: String(q).trim().slice(0, 900),
        hint: '',
        solutionMarkdown: String(a).trim().slice(0, 1200),
      }));
  }

  function normalizeSet(raw, defaults = {}) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid study set data.');
    // Unwrap server /sets?id=... payload where rich set lives inside raw.cards
    if (raw.cards && !Array.isArray(raw.cards) && typeof raw.cards === 'object' && raw.cards.format === 'study-os-rich-set-v1') {
      const inner = raw.cards;
      return normalizeSet({
        id: raw.id || inner.id,
        title: raw.title || inner.title,
        courseCode: inner.courseCode || raw.courseCode,
        courseTitle: inner.courseTitle || raw.courseTitle,
        school: inner.school || raw.school,
        modelLabel: inner.modelLabel || 'Shared Set',
        createdAt: raw.createdAt || inner.createdAt,
        questions: inner.questions,
      }, defaults);
    }

    const title = String(raw.title || defaults.title || 'Custom Study Set').trim().slice(0, 100);
    if (!title) throw new Error('Study set needs a title.');

    const questions = Array.isArray(raw.questions) && raw.questions.length
      ? cleanQuestions(raw.questions)
      : Array.isArray(raw.cards) && raw.cards.length
      ? cardsToQuestions(raw.cards)
      : [];

    if (!questions.length) throw new Error('No valid practice questions found in this study set.');

    const legacyCards = Array.isArray(raw.cards) && raw.cards.length && !Array.isArray(raw.questions)
      ? raw.cards.slice(0, 30).filter((c) => Array.isArray(c) && c.length === 2).map(([q, a]) => [String(q).trim(), String(a).trim()])
      : null;

    return {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 64) : makeId(),
      title,
      courseCode: String(raw.courseCode || defaults.courseCode || '').trim().slice(0, 32),
      courseTitle: String(raw.courseTitle || defaults.courseTitle || '').trim().slice(0, 140),
      school: String(raw.school || defaults.school || '').trim().slice(0, 48),
      modelLabel: String(raw.modelLabel || defaults.modelLabel || '').trim().slice(0, 48),
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
      questions,
      ...(legacyCards ? { cards: legacyCards } : {}),
    };
  }

  function list() {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        try { out.push(normalizeSet(item)); } catch {}
      }
      return out;
    } catch {
      return [];
    }
  }

  function persistList(sets, { sync = true } = {}) {
    localStorage.setItem(storageKey, JSON.stringify(sets.slice(0, 50)));
    if (sync) window.StudyApp?.queueCloudSync?.();
  }

  function save(rawSet, { sync = true } = {}) {
    const set = normalizeSet(rawSet);
    const others = list().filter((item) => item.id !== set.id);
    if (others.length >= 50) throw new Error('Remove an existing study set before saving another.');
    persistList([set, ...others], { sync });
    return set;
  }

  function remove(id) {
    const next = list().filter((set) => set.id !== id);
    persistList(next, { sync: true });
    render();
    window.StudyApp?.renderHome?.();
  }

  function exportForSync() {
    return list().slice(0, 25).map((s) => ({
      id: s.id,
      title: s.title,
      courseCode: s.courseCode || '',
      courseTitle: s.courseTitle || '',
      school: s.school || '',
      modelLabel: s.modelLabel || '',
      createdAt: s.createdAt || '',
      questions: s.questions,
    }));
  }

  function mergeFromCloud(remoteSets) {
    if (!Array.isArray(remoteSets) || !remoteSets.length) return 0;
    const local = list();
    const byId = new Map(local.map((s) => [s.id, s]));
    let added = 0;
    for (const raw of remoteSets) {
      try {
        const norm = normalizeSet(raw);
        if (!byId.has(norm.id)) {
          byId.set(norm.id, norm);
          added++;
        }
      } catch {}
    }
    if (added > 0) {
      const merged = [...byId.values()].sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
      persistList(merged, { sync: false });
      render();
    }
    return added;
  }

  function normCourseKey(str) {
    return String(str || '').toUpperCase().replace(/[^A-Z0-9ÆØÅ]/g, '');
  }

  function getSetsForCourse(courseCode = '', courseTitle = '') {
    const targetCode = normCourseKey(courseCode);
    const targetTitle = normCourseKey(courseTitle);
    if (!targetCode && !targetTitle) return [];
    return list().filter((set) => {
      const sc = normCourseKey(set.courseCode);
      const st = normCourseKey(set.courseTitle || set.title);
      if (targetCode && sc && (sc === targetCode || sc.includes(targetCode) || targetCode.includes(sc))) return true;
      if (targetTitle && targetTitle.length >= 5 && st && (st.includes(targetTitle) || targetTitle.includes(st))) return true;
      return false;
    });
  }

  function toRunnerConfig(rawSet) {
    const set = normalizeSet(rawSet);
    const topicNames = [...new Set(set.questions.map((q) => q.topic || set.courseCode || 'Practice'))];
    const topics = topicNames.map((name, idx) => ({ id: `t-${idx + 1}`, title: name }));
    const topicMap = new Map(topics.map((t) => [t.title, t.id]));

    const questions = set.questions.map((q, idx) => {
      const isMcq = q.kind === 'mcq' && Array.isArray(q.options) && q.options.length >= 2;
      const diff = [1, 2, 3].includes(Number(q.difficulty)) ? Number(q.difficulty) : 2;
      return {
        id: `custom:${set.id}:q${idx + 1}`,
        title: q.title || `Question ${idx + 1}`,
        kind: isMcq ? 'mcq' : 'written',
        difficulty: diff,
        dlpfcBase: diff,
        topicId: topicMap.get(q.topic || set.courseCode || 'Practice') || 't-1',
        collectionId: 'custom-set',
        promptMarkdown: q.promptMarkdown,
        ...(isMcq ? { options: q.options, answerIndex: q.answerIndex } : {}),
        hints: q.hint ? [q.hint] : [],
        solutionMarkdown: q.solutionMarkdown,
        pacing: {
          learning: { target: isMcq ? 2 : 5 },
          exam: { target: isMcq ? 1.5 : 4 },
        },
        available: true,
        synthetic: true,
      };
    });

    const courseMeta = {
      courseId: `custom-set:${set.id}`,
      code: set.courseCode || 'STUDY SET',
      title: set.title,
      shortTitle: set.courseCode ? `${set.courseCode}` : set.title.slice(0, 24),
      color: '#0f766e',
      obsidian: {},
      sources: {},
    };

    const bank = {
      courseId: courseMeta.courseId,
      questions,
      topics,
      collections: [{ id: 'custom-set', title: set.title }],
      sources: {},
    };

    return {
      courseMeta,
      bank,
      questionIds: questions.map((q) => q.id),
      mode: 'practice',
      profile: 'learning',
    };
  }

  function launchSet(rawSet) {
    if (!window.StudyRunner?.startRun) {
      toast('Study Runner is still loading — try again in a second.');
      return;
    }
    const config = toRunnerConfig(rawSet);
    window.StudyRunner.startRun(config);
  }

  function bytesToBase64Url(bytes) {
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      bin += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function encodeShareLink(rawSet) {
    const set = normalizeSet(rawSet);
    const payload = {
      format: 'study-os-rich-set-v1',
      id: set.id,
      title: set.title,
      courseCode: set.courseCode || '',
      courseTitle: set.courseTitle || '',
      school: set.school || '',
      modelLabel: set.modelLabel || 'Shared Link',
      questions: set.questions.slice(0, 20),
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
    if (typeof CompressionStream === 'undefined') {
      throw new Error('This browser cannot compress share links.');
    }
    const stream = new Blob([jsonBytes]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    const encoded = bytesToBase64Url(new Uint8Array(buf));
    return `${location.origin}${location.pathname}#study-set=${encoded}`;
  }

  async function decodeDraft(code) {
    if (!/^[A-Za-z0-9_-]{1,90000}$/.test(code)) {
      throw new Error('That study set link is invalid.');
    }
    const bytes = base64UrlToBytes(code);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131_072) {
        await reader.cancel();
        throw new Error('That study set is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    const parsed = JSON.parse(text + decoder.decode());
    if (parsed.format === 'study-os-rich-set-v1') {
      return normalizeSet(parsed, { modelLabel: parsed.modelLabel || 'Shared Link' });
    }
    if (parsed.format === 'study-os-set-v1' && typeof parsed.id === 'string' && typeof parsed.title === 'string' && Array.isArray(parsed.cards)) {
      return normalizeSet({ id: parsed.id, title: parsed.title, cards: parsed.cards, modelLabel: 'MCP / Shared Link' });
    }
    throw new Error('That study set link is invalid.');
  }

  async function activateDraft() {
    const prefix = '#study-set=';
    if (!location.hash.startsWith(prefix)) return false;
    const code = location.hash.slice(prefix.length);
    history.replaceState(null, '', location.pathname + location.search);
    try {
      draft = await decodeDraft(code);
      notice = '';
    } catch {
      draft = null;
      notice = 'This study set link could not be read. Ask your classmate or AI for a fresh Study-OS link.';
    }
    const panel = document.getElementById('my-study-sets');
    if (panel && 'open' in panel) panel.open = true;
    render();
    panel?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return true;
  }

  function buildByoAiPrompt({ courseCode = '', courseTitle = '', school = '', topics = [], sourceText = '', count = 8, style = 'mixed', language = 'auto' } = {}) {
    const langLine = language === 'nb'
      ? 'Write all questions, options, hints, and worked solutions in Norwegian Bokmål.'
      : language === 'en'
      ? 'Write all questions, options, hints, and worked solutions in English.'
      : 'Match the language of the course / notes below (Norwegian Bokmål if Norwegian, otherwise English).';
    const styleLine = style === 'mcq'
      ? 'Make every question kind="mcq" with 4 plausible options and integer answerIndex (0–3).'
      : style === 'written'
      ? 'Make every question kind="written" (active-recall, calculation, derivation, or case analysis).'
      : 'Mix ~60% kind="mcq" (4 plausible options, answerIndex 0–3) and ~40% kind="written".';

    return [
      `Create ${count} original, university exam-grade practice questions for Study-OS.`,
      courseCode || courseTitle ? `Course: ${[courseCode, courseTitle].filter(Boolean).join(' · ')}` : 'Course: [Your Course Name]',
      school ? `School: ${school}` : '',
      topics.length ? `Syllabus / Canvas modules:\n- ${topics.join('\n- ')}` : '',
      sourceText ? `My lecture notes / excerpt:\n${sourceText.slice(0, 6000)}` : '',
      '',
      'Rules:',
      `- ${styleLine}`,
      `- ${langLine}`,
      '- difficulty: 1 = Low (recall/concept), 2 = Med (applied/procedural), 3 = High (synthesis/case).',
      '- Use $...$ for inline math and $$...$$ for display math.',
      '- Return ONLY a single valid JSON object (no commentary before or after) matching this exact schema:',
      '```json',
      '{"title":"Short Set Title","questions":[{"title":"Short Question Title","kind":"mcq","difficulty":2,"topic":"Module / Topic","promptMarkdown":"Question text...","options":["Option A","Option B","Option C","Option D"],"answerIndex":0,"hint":"Focused hint without spoiling answer","solutionMarkdown":"Step-by-step worked solution"}]}',
      '```',
      '(For kind="written", omit "options" and "answerIndex".)',
    ].filter((line) => line !== '').join('\n');
  }

  function parseImportedJson(rawText, defaults = {}) {
    let cleaned = String(rawText || '').trim();
    if (!cleaned) throw new Error('Paste JSON from ChatGPT, Claude, or Gemini first.');
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) cleaned = fenced[1].trim();
    const objStart = cleaned.indexOf('{');
    const arrStart = cleaned.indexOf('[');
    if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
      const objEnd = cleaned.lastIndexOf('}');
      if (objEnd > objStart) cleaned = cleaned.slice(objStart, objEnd + 1);
    } else if (arrStart >= 0) {
      const arrEnd = cleaned.lastIndexOf(']');
      if (arrEnd > arrStart) cleaned = cleaned.slice(arrStart, arrEnd + 1);
    }
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      if (parsed.length && Array.isArray(parsed[0])) {
        return normalizeSet({ title: defaults.title || 'Imported Study Set', cards: parsed }, { ...defaults, modelLabel: 'Your Own AI' });
      }
      return normalizeSet({ title: defaults.title || 'Imported Study Set', questions: parsed }, { ...defaults, modelLabel: 'Your Own AI' });
    }
    return normalizeSet(parsed, { ...defaults, modelLabel: 'Your Own AI' });
  }

  function parseManualQuickCards(rawText, title, courseCode = '', school = '') {
    const lines = String(rawText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const cards = [];
    for (const line of lines) {
      const sep = line.includes('::') ? '::' : line.includes('\t') ? '\t' : null;
      if (!sep) continue;
      const idx = line.indexOf(sep);
      const q = line.slice(0, idx).trim();
      const a = line.slice(idx + sep.length).trim();
      if (q && a) cards.push([q, a]);
    }
    if (!cards.length) {
      throw new Error('Add at least one card formatted as: Question :: Answer (one per line).');
    }
    return normalizeSet({
      title: String(title || courseCode || 'Quick Cards').trim().slice(0, 90),
      courseCode,
      school,
      cards,
      modelLabel: 'Quick Cards',
    });
  }

  function openGenerator(prefill = {}) {
    let dlg = document.getElementById('study-set-studio-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'study-set-studio-dialog';
      dlg.className = 'member-dialog playbook-sheet ai-set-modal';
      dlg.tabIndex = -1;
      dlg.setAttribute('aria-labelledby', 'ai-set-modal-title');
      dlg.addEventListener('click', (ev) => {
        if (ev.target === dlg) dlg.close();
      });
      document.body.appendChild(dlg);
    }

    const schoolCfg = window.StudyApp?.getUserSchoolConfig?.() || {};
    const state = {
      tab: prefill.tab || 'gemini',
      courseCode: String(prefill.courseCode || '').trim(),
      courseTitle: String(prefill.courseTitle || '').trim(),
      school: String(prefill.school || schoolCfg.name || '').trim(),
      topicsText: Array.isArray(prefill.topics) ? prefill.topics.filter(Boolean).slice(0, 15).join(', ') : String(prefill.topics || ''),
      sourceText: String(prefill.sourceText || ''),
      count: Number(prefill.count) || 8,
      style: prefill.style || 'mixed',
      language: prefill.language || 'auto',
      pdfStatus: '',
      statusMsg: '',
      busy: false,
      createdSet: null,
      importJson: '',
      manualTitle: prefill.courseCode ? `${prefill.courseCode} Quick Cards` : '',
      manualText: '',
    };

    const getTopicsArr = () => state.topicsText.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);

    const paint = () => {
      const signedIn = Boolean(window.StudyCommunity?.isSignedIn?.());
      const canUseBuiltIn = Boolean(window.StudyCommunity?.enabled);
      const topics = getTopicsArr();
      const byoPrompt = buildByoAiPrompt({
        courseCode: state.courseCode,
        courseTitle: state.courseTitle,
        school: state.school,
        topics,
        sourceText: state.sourceText,
        count: state.count,
        style: state.style,
        language: state.language,
      });

      dlg.innerHTML = `
        <div class="playbook-head">
          <div>
            <span class="eyebrow">Custom Study Sets · Any School &amp; Course</span>
            <h2 id="ai-set-modal-title" style="margin:2px 0 4px">Study Set Studio</h2>
            <p class="muted" style="margin:0;font-size:13px">Build exam-grade MCQ &amp; written sets with <b>Gemini 4 Hydrogen</b>, an external LLM, or quick cards — and run them right inside Study-OS.</p>
          </div>
          <button type="button" class="ios-done-btn" id="ai-set-done">Done</button>
        </div>
        <div class="playbook-body">
          ${state.createdSet ? `
            <article class="playbook-card ai-set-success-card">
              <div class="row-between" style="gap:8px;margin-bottom:6px;flex-wrap:wrap">
                <span class="badge good">Ready to Practice · ${state.createdSet.questions.length} Qs</span>
                ${state.createdSet.modelLabel ? `<span class="badge">${esc(state.createdSet.modelLabel)}</span>` : ''}
              </div>
              <h3 style="margin:0 0 6px;font-size:17px">${esc(state.createdSet.title)}</h3>
              <p class="muted" style="margin:0 0 12px;font-size:13px">Saved to <b>My Study Sets</b>${signedIn ? ' and synced to your account' : ''}. Launch in the full Study-OS Runner with hints, worked solutions, KaTeX math &amp; pace timer.</p>
              <div class="row-actions" style="flex-wrap:wrap">
                <button type="button" class="primary-btn" id="ai-set-launch-now">Start Practicing Now →</button>
                <button type="button" class="ghost-btn" id="ai-set-copy-share">Copy Share Link</button>
                <button type="button" class="ghost-btn" id="ai-set-make-another">Create Another</button>
              </div>
            </article>
          ` : `
            <div class="ios-segmented ai-set-tabs" role="tablist" aria-label="Study set creation method">
              <button type="button" role="tab" class="${state.tab === 'gemini' ? 'active' : ''}" data-set-tab="gemini" aria-selected="${state.tab === 'gemini'}">Gemini 4 Hydrogen</button>
              <button type="button" role="tab" class="${state.tab === 'byo' ? 'active' : ''}" data-set-tab="byo" aria-selected="${state.tab === 'byo'}">External LLM</button>
              <button type="button" role="tab" class="${state.tab === 'manual' ? 'active' : ''}" data-set-tab="manual" aria-selected="${state.tab === 'manual'}">Quick Cards</button>
            </div>

            ${state.tab === 'gemini' ? `
              <article class="playbook-card">
                ${!signedIn && canUseBuiltIn ? `
                  <div class="ai-set-auth-note">
                    <div>
                      <strong>Free sign-in unlocks built-in Gemini 4 Hydrogen</strong>
                      <small class="muted" style="display:block">Or switch to <b>Your Own AI</b> to copy a prompt &amp; paste JSON with zero sign-in.</small>
                    </div>
                    <div class="row-actions" style="gap:6px;flex-shrink:0">
                      <button type="button" class="primary-btn" id="ai-set-signin" style="padding:6px 12px;font-size:12.5px">Sign in</button>
                      <button type="button" class="ghost-btn" id="ai-set-switch-byo" style="padding:6px 11px;font-size:12.5px">Use Your Own AI →</button>
                    </div>
                  </div>
                ` : ''}
                <div class="ai-set-grid-2">
                  <label class="field-label">Course code <small class="muted">(optional)</small>
                    <input type="text" id="ai-set-code" maxlength="32" value="${esc(state.courseCode)}" placeholder="e.g. BED100, TDT4109, ECON101">
                  </label>
                  <label class="field-label">Course or topic title
                    <input type="text" id="ai-set-title" maxlength="140" value="${esc(state.courseTitle)}" placeholder="e.g. Corporate Finance · NPV &amp; CAPM">
                  </label>
                </div>
                <label class="field-label">Syllabus / Canvas modules <small class="muted">(comma-separated, optional)</small>
                  <input type="text" id="ai-set-topics" maxlength="600" value="${esc(state.topicsText)}" placeholder="e.g. Cost Accounting, Break-Even, NPV, Capital Budgeting">
                </label>
                <div class="row-between" style="margin:6px 0 4px;gap:8px;flex-wrap:wrap">
                  <label class="field-label" for="ai-set-notes" style="margin:0">Lecture notes or syllabus text <small class="muted">(optional — makes questions hyper-accurate)</small></label>
                  <label class="ghost-btn" style="padding:4px 10px;font-size:12px;cursor:pointer">
                    Extract text from PDF
                    <input type="file" id="ai-set-pdf-input" accept=".pdf" hidden>
                  </label>
                </div>
                <textarea id="ai-set-notes" rows="4" maxlength="16000" placeholder="Paste lecture notes, syllabus bullets, or drop a PDF above (extracted privately in your browser)…">${esc(state.sourceText)}</textarea>
                ${state.pdfStatus ? `<small class="muted" style="display:block;margin-top:4px;color:var(--accent)">${esc(state.pdfStatus)}</small>` : ''}
                <div class="ai-set-grid-3" style="margin-top:10px">
                  <label class="field-label">Questions
                    <select id="ai-set-count">
                      <option value="6" ${state.count === 6 ? 'selected' : ''}>6 questions</option>
                      <option value="8" ${state.count === 8 ? 'selected' : ''}>8 questions</option>
                      <option value="12" ${state.count === 12 ? 'selected' : ''}>12 questions</option>
                    </select>
                  </label>
                  <label class="field-label">Format
                    <select id="ai-set-style">
                      <option value="mixed" ${state.style === 'mixed' ? 'selected' : ''}>Mixed MCQ + Written</option>
                      <option value="mcq" ${state.style === 'mcq' ? 'selected' : ''}>MCQ only</option>
                      <option value="written" ${state.style === 'written' ? 'selected' : ''}>Written / Calc</option>
                    </select>
                  </label>
                  <label class="field-label">Language
                    <select id="ai-set-lang">
                      <option value="auto" ${state.language === 'auto' ? 'selected' : ''}>Auto-match</option>
                      <option value="en" ${state.language === 'en' ? 'selected' : ''}>English</option>
                      <option value="nb" ${state.language === 'nb' ? 'selected' : ''}>Norsk (Bokmål)</option>
                    </select>
                  </label>
                </div>
                <div class="row-actions" style="margin-top:12px;align-items:center">
                  <button type="button" class="primary-btn" id="ai-set-generate-btn" ${state.busy || (!signedIn && canUseBuiltIn) ? 'disabled' : ''}>
                    ${state.busy ? 'Building with Gemini 4 Hydrogen…' : 'Build Study Set'}
                  </button>
                  <span class="muted" id="ai-set-status" role="status" style="font-size:12.5px">${esc(state.statusMsg)}</span>
                </div>
              </article>
            ` : ''}

            ${state.tab === 'byo' ? `
              <article class="playbook-card">
                <p class="muted" style="margin:0 0 10px;font-size:13px">Use <b>ChatGPT, Claude, Gemini</b>, or any local LLM with zero limits or sign-in. Fill your topic below, copy the ready-made prompt, and paste the JSON response back here.</p>
                <div class="ai-set-grid-2">
                  <label class="field-label">Course code <small class="muted">(optional)</small>
                    <input type="text" id="byo-code" maxlength="32" value="${esc(state.courseCode)}" placeholder="e.g. BED100, MAT1100">
                  </label>
                  <label class="field-label">Course or topic title
                    <input type="text" id="byo-title" maxlength="140" value="${esc(state.courseTitle)}" placeholder="e.g. Microeconomics · Elasticity">
                  </label>
                </div>
                <div class="ai-set-prompt-box">
                  <div class="row-between" style="margin-bottom:6px;gap:8px">
                    <strong style="font-size:12.5px">1. Copy prompt &amp; send to your AI</strong>
                    <button type="button" class="ghost-btn" id="byo-copy-prompt" style="padding:4px 10px;font-size:12px">Copy Prompt</button>
                  </div>
                  <pre id="byo-prompt-preview">${esc(byoPrompt)}</pre>
                </div>
                <label class="field-label" style="margin-top:10px">2. Paste the JSON output from your AI
                  <textarea id="byo-json-input" rows="5" placeholder='{"title":"...","questions":[...]}'>${esc(state.importJson)}</textarea>
                </label>
                <div class="row-actions" style="margin-top:10px;flex-wrap:wrap">
                  <button type="button" class="primary-btn" id="byo-import-launch">Import &amp; Practice →</button>
                  <button type="button" class="ghost-btn" id="byo-import-save">Save to My Sets</button>
                  <a class="ghost-btn" href="https://github.com/shadjosef/study-os/blob/main/docs/study-sets-mcp.md" target="_blank" rel="noopener">MCP Link Setup ↗</a>
                </div>
                <p class="muted" id="ai-set-status" role="status" style="margin:8px 0 0;font-size:12.5px">${esc(state.statusMsg)}</p>
              </article>
            ` : ''}

            ${state.tab === 'manual' ? `
              <article class="playbook-card">
                <p class="muted" style="margin:0 0 10px;font-size:13px">Write one card per line using <code>Question :: Answer</code>. Cards launch directly in the Study-OS Runner with active-recall timer &amp; FSRS tracking.</p>
                <div class="ai-set-grid-2">
                  <label class="field-label">Course code <small class="muted">(optional)</small>
                    <input type="text" id="man-code" maxlength="32" value="${esc(state.courseCode)}" placeholder="e.g. ORG101">
                  </label>
                  <label class="field-label">Set title
                    <input type="text" id="man-title" maxlength="90" value="${esc(state.manualTitle || state.courseTitle)}" placeholder="e.g. Week 4 Key Formulas">
                  </label>
                </div>
                <label class="field-label">Cards (<code>Question :: Answer</code> per line)
                  <textarea id="man-cards" rows="6" placeholder="What is WACC? :: Weighted Average Cost of Capital = (E/V)Re + (D/V)Rd(1-T)&#10;What happens to bond price when yield rises? :: Bond price falls inversely because future cash flows are discounted at a higher rate.">${esc(state.manualText)}</textarea>
                </label>
                <div class="row-actions" style="margin-top:10px">
                  <button type="button" class="primary-btn" id="man-save-launch">Save &amp; Practice →</button>
                  <button type="button" class="ghost-btn" id="man-save-only">Save to My Sets</button>
                </div>
                <p class="muted" id="ai-set-status" role="status" style="margin:8px 0 0;font-size:12.5px">${esc(state.statusMsg)}</p>
              </article>
            ` : ''}
          `}
        </div>
      `;

      dlg.querySelector('#ai-set-done')?.addEventListener('click', () => dlg.close());

      if (state.createdSet) {
        dlg.querySelector('#ai-set-launch-now')?.addEventListener('click', () => {
          const target = state.createdSet;
          dlg.close();
          launchSet(target);
        });
        dlg.querySelector('#ai-set-copy-share')?.addEventListener('click', async () => {
          try {
            const url = await encodeShareLink(state.createdSet);
            await navigator.clipboard.writeText(url);
            toast('Share link copied — paste in your class chat!');
          } catch (err) {
            toast(err?.message || 'Could not copy share link.');
          }
        });
        dlg.querySelector('#ai-set-make-another')?.addEventListener('click', () => {
          state.createdSet = null;
          state.statusMsg = '';
          paint();
        });
        return;
      }

      dlg.querySelectorAll('[data-set-tab]').forEach((btn) => {
        btn.onclick = () => {
          state.tab = btn.dataset.setTab;
          state.statusMsg = '';
          paint();
        };
      });

      dlg.querySelector('#ai-set-signin')?.addEventListener('click', async () => {
        dlg.close();
        const ok = await window.StudyCommunity?.requireProfile?.({ allowDemo: true, forcePrompt: true });
        if (ok) openGenerator({ ...prefill, courseCode: state.courseCode, courseTitle: state.courseTitle, topics: getTopicsArr(), sourceText: state.sourceText });
      });
      dlg.querySelector('#ai-set-switch-byo')?.addEventListener('click', () => {
        state.tab = 'byo';
        state.statusMsg = '';
        paint();
      });

      // Gemini tab bindings
      dlg.querySelector('#ai-set-code')?.addEventListener('input', (e) => { state.courseCode = e.target.value; });
      dlg.querySelector('#ai-set-title')?.addEventListener('input', (e) => { state.courseTitle = e.target.value; });
      dlg.querySelector('#ai-set-topics')?.addEventListener('input', (e) => { state.topicsText = e.target.value; });
      dlg.querySelector('#ai-set-notes')?.addEventListener('input', (e) => { state.sourceText = e.target.value; });
      dlg.querySelector('#ai-set-count')?.addEventListener('change', (e) => { state.count = Number(e.target.value) || 8; });
      dlg.querySelector('#ai-set-style')?.addEventListener('change', (e) => { state.style = e.target.value; });
      dlg.querySelector('#ai-set-lang')?.addEventListener('change', (e) => { state.language = e.target.value; });

      dlg.querySelector('#ai-set-pdf-input')?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        state.pdfStatus = `Extracting text locally from ${file.name}…`;
        paint();
        try {
          if (!window.StudyPdf?.extractFileText) throw new Error('PDF reader is still loading — try again.');
          const res = await window.StudyPdf.extractFileText(file, 14500, 24);
          if (!res.text) throw new Error('No selectable text found in this PDF (it may be a scanned image).');
          state.sourceText = state.sourceText
            ? `${state.sourceText.trim()}\n\n${res.text}`.slice(0, 16000)
            : res.text;
          if (!state.courseTitle) state.courseTitle = file.name.replace(/\.pdf$/i, '').slice(0, 90);
          state.pdfStatus = `Extracted ${res.pagesRead}/${res.totalPages} pages locally (${res.text.length.toLocaleString()} chars — PDF stayed on your device).`;
        } catch (err) {
          state.pdfStatus = err?.message || 'Could not extract text from PDF.';
        }
        paint();
      });

      dlg.querySelector('#ai-set-generate-btn')?.addEventListener('click', async () => {
        if (state.busy) return;
        const topicsArr = getTopicsArr();
        if (!state.courseCode.trim() && !state.courseTitle.trim() && !topicsArr.length && !state.sourceText.trim()) {
          state.statusMsg = 'Enter a course/topic name, Canvas modules, or paste some lecture notes first.';
          paint();
          return;
        }
        state.busy = true;
        state.statusMsg = 'Asking Gemini 4 Hydrogen to build your exam set…';
        paint();
        try {
          const res = await window.StudyCommunity.generateAiSet({
            courseCode: state.courseCode.trim(),
            courseTitle: state.courseTitle.trim(),
            school: state.school,
            topics: topicsArr,
            sourceText: state.sourceText.trim(),
            count: state.count,
            style: state.style,
            language: state.language,
          });
          const saved = save(res.set);
          state.createdSet = saved;
          state.statusMsg = '';
          render();
          window.StudyApp?.renderHome?.();
          toast(`Created "${saved.title}" (${saved.questions.length} Qs · ${res.modelLabel || 'Gemini 4 Hydrogen'})!`);
        } catch (err) {
          state.statusMsg = err?.message || 'Could not generate set right now. Try again or use "Your Own AI".';
        } finally {
          state.busy = false;
          paint();
        }
      });

      // BYO AI tab bindings
      const syncByoPreview = () => {
        const pre = dlg.querySelector('#byo-prompt-preview');
        if (pre) {
          pre.textContent = buildByoAiPrompt({
            courseCode: state.courseCode,
            courseTitle: state.courseTitle,
            school: state.school,
            topics: getTopicsArr(),
            sourceText: state.sourceText,
            count: state.count,
            style: state.style,
            language: state.language,
          });
        }
      };
      dlg.querySelector('#byo-code')?.addEventListener('input', (e) => { state.courseCode = e.target.value; syncByoPreview(); });
      dlg.querySelector('#byo-title')?.addEventListener('input', (e) => { state.courseTitle = e.target.value; syncByoPreview(); });
      dlg.querySelector('#byo-json-input')?.addEventListener('input', (e) => { state.importJson = e.target.value; });
      dlg.querySelector('#byo-copy-prompt')?.addEventListener('click', async () => {
        const text = dlg.querySelector('#byo-prompt-preview')?.textContent || byoPrompt;
        try {
          await navigator.clipboard.writeText(text);
          toast('Prompt copied — paste into ChatGPT, Claude, or Gemini!');
        } catch {
          toast('Select and copy the prompt above.');
        }
      });
      const doByoImport = (launchAfter) => {
        try {
          const parsed = parseImportedJson(state.importJson, {
            title: [state.courseCode, state.courseTitle].filter(Boolean).join(' · ') || 'Custom Study Set',
            courseCode: state.courseCode,
            courseTitle: state.courseTitle,
            school: state.school,
          });
          const saved = save(parsed);
          render();
          window.StudyApp?.renderHome?.();
          if (launchAfter) {
            dlg.close();
            launchSet(saved);
          } else {
            state.createdSet = saved;
            state.statusMsg = '';
            paint();
          }
          toast(`Imported "${saved.title}" (${saved.questions.length} Qs)!`);
        } catch (err) {
          state.statusMsg = err?.message || 'Could not parse JSON. Make sure you copied the full JSON object from your AI.';
          const stEl = dlg.querySelector('#ai-set-status');
          if (stEl) stEl.textContent = state.statusMsg;
        }
      };
      dlg.querySelector('#byo-import-launch')?.addEventListener('click', () => doByoImport(true));
      dlg.querySelector('#byo-import-save')?.addEventListener('click', () => doByoImport(false));

      // Manual tab bindings
      dlg.querySelector('#man-code')?.addEventListener('input', (e) => { state.courseCode = e.target.value; });
      dlg.querySelector('#man-title')?.addEventListener('input', (e) => { state.manualTitle = e.target.value; });
      dlg.querySelector('#man-cards')?.addEventListener('input', (e) => { state.manualText = e.target.value; });
      const doManualSave = (launchAfter) => {
        try {
          const parsed = parseManualQuickCards(state.manualText, state.manualTitle || state.courseTitle, state.courseCode, state.school);
          const saved = save(parsed);
          render();
          window.StudyApp?.renderHome?.();
          if (launchAfter) {
            dlg.close();
            launchSet(saved);
          } else {
            state.createdSet = saved;
            state.statusMsg = '';
            paint();
          }
          toast(`Saved "${saved.title}" (${saved.questions.length} cards)!`);
        } catch (err) {
          state.statusMsg = err?.message || 'Check your Question :: Answer formatting.';
          const stEl = dlg.querySelector('#ai-set-status');
          if (stEl) stEl.textContent = state.statusMsg;
        }
      };
      dlg.querySelector('#man-save-launch')?.addEventListener('click', () => doManualSave(true));
      dlg.querySelector('#man-save-only')?.addEventListener('click', () => doManualSave(false));
    };

    paint();
    if (!dlg.open) {
      dlg.showModal();
      dlg.focus({ preventScroll: true });
    }
  }

  function clockTick() {
    const shareBtns = document.querySelectorAll('[data-share-community-set]');
    if (!shareBtns.length) return;
    const open = workClock.canUseBreakTools();
    for (const btn of shareBtns) {
      btn.disabled = !open || btn.dataset.busy === '1';
      btn.title = open ? 'Share to Community Study Sets' : 'Community sharing opens during breaks or 18:00–22:30 Oslo';
    }
  }

  function setCountsLabel(set) {
    const qs = set.questions || [];
    const mcqs = qs.filter((q) => q.kind === 'mcq').length;
    const written = qs.length - mcqs;
    const parts = [`${qs.length} Q${qs.length === 1 ? '' : 's'}`];
    if (mcqs && written) parts.push(`${mcqs} MCQ · ${written} written`);
    else if (mcqs) parts.push('MCQ');
    else parts.push('Written');
    return parts.join(' · ');
  }

  function render() {
    const root = document.getElementById('study-sets-root');
    if (!root) return;
    const sets = list();
    const canShareCommunity = Boolean(window.StudyCommunity?.canShareSet?.());

    root.innerHTML = `
      <div class="row-between" style="gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <h2 style="margin:0;font-size:18px">My Study Sets</h2>
          ${sets.length ? `<span class="badge good">${sets.length} saved</span>` : '<span class="badge">Gemini 4 Hydrogen · BYO AI</span>'}
        </div>
        <div class="row-actions" style="flex-wrap:wrap;gap:6px">
          <button type="button" class="primary-btn" id="btn-open-set-studio">+ New Study Set</button>
          <button type="button" class="ghost-btn" id="btn-open-set-byo">Import JSON</button>
        </div>
      </div>

      ${draft ? `
        <section id="study-set-draft-controls" class="study-set-draft-card">
          <div class="row-between" style="gap:8px;flex-wrap:wrap;margin-bottom:6px">
            <div>
              <span class="badge live">Shared Study Set Received</span>
              <h3 style="margin:4px 0 2px;font-size:16px">${esc(draft.title)}</h3>
              <small class="muted">${esc(setCountsLabel(draft))}${draft.courseCode ? ` · ${esc(draft.courseCode)}` : ''}${draft.school ? ` · ${esc(draft.school)}` : ''}</small>
            </div>
            <button type="button" class="ghost-btn" id="study-set-draft-dismiss" style="padding:4px 10px;font-size:12px">Dismiss</button>
          </div>
          <div class="row-actions" style="flex-wrap:wrap;margin-top:8px">
            <button type="button" class="primary-btn" id="study-set-draft-practice">Practice Now →</button>
            <button type="button" class="ghost-btn" id="study-set-draft-save">Save to My Sets</button>
            ${canShareCommunity ? '<button type="button" class="ghost-btn" data-share-community-set="__draft__">Save &amp; Share to Community</button>' : ''}
          </div>
        </section>
      ` : ''}

      ${notice ? `<p id="study-set-status" class="muted" role="status" style="margin:0 0 8px;font-size:13px">${esc(notice)}</p>` : ''}

      ${sets.length ? `
        <div class="study-set-cards-grid">
          ${sets.map((set) => {
            const topics = [...new Set((set.questions || []).map((q) => q.topic).filter(Boolean))].slice(0, 3);
            return `
              <article class="study-set-card">
                <div>
                  <div class="row-between" style="gap:6px;margin-bottom:6px;flex-wrap:wrap">
                    <div class="study-set-card-meta">
                      ${set.courseCode ? `<span class="course-code-pill" style="--pill-color:#0f766e">${esc(set.courseCode)}</span>` : ''}
                      ${set.modelLabel ? `<span class="course-school-pill">${esc(set.modelLabel)}</span>` : ''}
                    </div>
                    <small class="muted" style="font-weight:600">${esc(setCountsLabel(set))}</small>
                  </div>
                  <h3 class="study-set-card-title">${esc(set.title)}</h3>
                  ${topics.length ? `<div class="community-course-topics" style="margin:6px 0 8px">${topics.map((t) => `<span class="topic-mini-chip">${esc(t)}</span>`).join('')}</div>` : ''}
                </div>
                <div class="row-actions" style="flex-wrap:wrap;gap:6px;margin-top:8px">
                  <button type="button" class="primary-btn" style="padding:6px 12px;font-size:13px" data-launch-study-set="${esc(set.id)}">Practice →</button>
                  <button type="button" class="ghost-btn" style="padding:6px 10px;font-size:12.5px" data-share-link-set="${esc(set.id)}" title="Copy a direct link to send to classmates">Share Link</button>
                  ${canShareCommunity ? `<button type="button" class="ghost-btn" style="padding:6px 10px;font-size:12.5px" data-share-community-set="${esc(set.id)}">Community</button>` : ''}
                  <button type="button" class="ghost-btn" style="padding:6px 10px;font-size:12.5px" data-remove-study-set="${esc(set.id)}" aria-label="Remove ${esc(set.title)}">Remove</button>
                </div>
              </article>
            `;
          }).join('')}
        </div>
      ` : `
        <p class="muted" style="margin:0;font-size:13.5px;line-height:1.45">
          Turn any university course, synced Canvas module, lecture notes, or PDF into an interactive Study-OS practice set with <b>Gemini 4 Hydrogen</b> or your own AI — then share a 1-click link with classmates.
        </p>
      `}
    `;

    root.querySelector('#btn-open-set-studio')?.addEventListener('click', () => openGenerator({ tab: 'gemini' }));
    root.querySelector('#btn-open-set-byo')?.addEventListener('click', () => openGenerator({ tab: 'byo' }));

    root.querySelector('#study-set-draft-dismiss')?.addEventListener('click', () => {
      draft = null;
      render();
    });
    root.querySelector('#study-set-draft-practice')?.addEventListener('click', () => {
      if (!draft) return;
      const saved = save(draft);
      draft = null;
      render();
      launchSet(saved);
    });
    root.querySelector('#study-set-draft-save')?.addEventListener('click', () => {
      if (!draft) return;
      const saved = save(draft);
      draft = null;
      notice = `Saved "${saved.title}" to My Study Sets.`;
      render();
      window.StudyApp?.renderHome?.();
      toast('Study set saved!');
    });

    root.querySelectorAll('[data-launch-study-set]').forEach((btn) => {
      btn.onclick = () => {
        const target = sets.find((s) => s.id === btn.dataset.launchStudySet);
        if (target) launchSet(target);
      };
    });

    root.querySelectorAll('[data-share-link-set]').forEach((btn) => {
      btn.onclick = async () => {
        const target = sets.find((s) => s.id === btn.dataset.shareLinkSet);
        if (!target) return;
        btn.disabled = true;
        try {
          const url = await encodeShareLink(target);
          await navigator.clipboard.writeText(url);
          toast('Share link copied — send it in your class chat!');
        } catch (err) {
          toast(err?.message || 'Could not copy share link.');
        } finally {
          btn.disabled = false;
        }
      };
    });

    root.querySelectorAll('[data-share-community-set]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.shareCommunitySet;
        const target = id === '__draft__' ? draft : sets.find((s) => s.id === id);
        if (!target) return;
        btn.dataset.busy = '1';
        btn.disabled = true;
        try {
          if (id === '__draft__') {
            save(target);
            draft = null;
          }
          await window.StudyCommunity.shareSet(target);
          toast('Shared to Community Study Sets!');
          render();
        } catch (err) {
          toast(err?.message || 'Could not share to Community right now.');
        } finally {
          delete btn.dataset.busy;
          clockTick();
        }
      };
    });

    root.querySelectorAll('[data-remove-study-set]').forEach((btn) => {
      btn.onclick = () => remove(btn.dataset.removeStudySet);
    });

    clockTick();
  }

  window.addEventListener('hashchange', async () => {
    if (!location.hash.startsWith('#study-set=')) return;
    if (!document.getElementById('view-runner').hidden) document.getElementById('run-exit-btn').click();
    await window.StudyApp.navigate('home');
    await activateDraft();
  });

  return {
    list,
    normalizeSet,
    save,
    remove,
    launchSet,
    openGenerator,
    encodeShareLink,
    getSetsForCourse,
    exportForSync,
    mergeFromCloud,
    render,
    activateDraft,
    clockTick,
    mcpPrompt,
  };
})();
