/* Adamlite — Fast, VS Code Codex-Style AI Study Sidebar for Study-OS
 * - 1:1 clean Codex-style docked sidebar with blue drag-resize border & responsive narrow collapsing
 * - Top tab with cropped Adam Warlock emblem + "Adamlite" (zero empty-state clutter)
 * - Persistent local chat history (up to 40 chats) shown inline under "Chats" + "View all (N)"
 * - Blazing-fast streaming SSE + user-selectable Thinking Speed (default: Minimal / fastest)
 * - Lean study context: Question + Your Working + Relevant Markdown Reference Section only
 * - Multimodal file/image attachments (+ button & Cmd+V screenshot paste) + Speech-to-Text mic
 */
'use strict';

window.StudyAiTutor = (() => {
  const { esc, toast, renderMarkdownWithMath } = window.StudyUI;
  const BYOK_KEY = 'study-os-ai-byok-key-v1';
  const BYOK_MODEL_KEY = 'study-os-ai-byok-model-v1';
  const THINKING_KEY = 'study-os-ai-thinking-v1';
  const SIDE_KEY = 'study-os-ai-side-v1';
  const WIDTH_KEY = 'study-os-ai-width-v1';
  const CHATS_KEY = 'study-os-adamlite-chats-v1';
  const MAX_STORED_CHATS = 40;
  const MAX_MSGS_PER_CHAT = 60;
  const AVATAR_SRC = './pwa/adamlite-avatar.jpg';

  const MODELS = [
    { id: 'auto', label: 'Auto', short: 'Hydrogen', tag: 'Fast' },
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', short: 'Hydrogen', tag: 'New' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', short: '3.8 Flash', tag: '' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', short: 'Flash-Lite', tag: '' },
  ];

  const BYOK_AUTO_CHAIN = [
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ];

  const THINKING_MODES = [
    { id: 'minimal', label: 'Minimal', hint: 'Fastest · instant replies' },
    { id: 'low', label: 'Low', hint: 'Quick reasoning' },
    { id: 'medium', label: 'Medium', hint: 'Balanced depth' },
    { id: 'high', label: 'High', hint: 'Deep proofs & derivations' },
  ];

  const AI_PANE_MIN_W = 152;
  const AI_PANE_MAX_W = 640;
  const AI_COLLAPSE_THRESHOLD = 92;
  const AI_DOCK_MIN_VP = 760;

  let conversations = loadStoredChats();
  let activeConvoId = '';
  let activeKey = 'general';
  let customCourseContext = null;
  let isOpen = false;
  let busy = false;
  let serverStatus = null;
  let popoverMode = ''; // '' | 'speed' | 'settings'
  let hoveredModelId = '';
  let showAllChats = false;
  let contextEnabled = true;
  let pendingAttachments = []; // [{ id, kind: 'image'|'text', name, mimeType, base64, previewUrl, text }]
  let draftByKey = new Map();
  let paneResizeObs = null;
  let speechRec = null;
  let speechActive = false;

  // ---------------------------------------------------------------------------
  // STORAGE & PREFERENCES
  // ---------------------------------------------------------------------------
  function loadStoredChats() {
    try {
      const raw = JSON.parse(localStorage.getItem(CHATS_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages))
        .slice(0, MAX_STORED_CHATS)
        .map((c) => ({
          id: c.id,
          key: String(c.key || 'general'),
          title: String(c.title || 'New chat').slice(0, 90),
          course: String(c.course || '').slice(0, 48),
          ctxLabel: String(c.ctxLabel || '').slice(0, 72),
          updatedAt: Number(c.updatedAt) || Date.now(),
          messages: c.messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
            .slice(-MAX_MSGS_PER_CHAT)
            .map((m) => ({
              role: m.role,
              text: m.text,
              meta: String(m.meta || ''),
              attachments: Array.isArray(m.attachments) ? m.attachments.slice(0, 3) : [],
            })),
        }));
    } catch {
      return [];
    }
  }

  function persistChats() {
    try {
      const nonEmpty = conversations
        .filter((c) => c.messages && c.messages.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_STORED_CHATS)
        .map((c) => ({
          ...c,
          messages: c.messages.slice(-MAX_MSGS_PER_CHAT).map((m) => ({
            role: m.role,
            text: m.text,
            meta: m.meta || '',
            attachments: (m.attachments || []).map((a) => ({ kind: a.kind, name: a.name })),
          })),
        }));
      localStorage.setItem(CHATS_KEY, JSON.stringify(nonEmpty));
    } catch {}
  }

  function makeConvoId() {
    return `adm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function findConvoById(id) {
    return conversations.find((c) => c.id === id) || null;
  }

  function getSavedChats() {
    return conversations
      .filter((c) => c.messages && c.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function ensureActiveConvo(key, snap) {
    const cur = findConvoById(activeConvoId);
    if (cur) return cur;
    const fresh = {
      id: makeConvoId(),
      key,
      title: snap?.mode === 'practice' && snap.title ? String(snap.title).slice(0, 80) : 'New chat',
      course: snap?.mode === 'practice' ? String(snap.course || '') : '',
      ctxLabel: shortContextTag(snap || { mode: 'waiting' }),
      updatedAt: Date.now(),
      messages: [],
    };
    conversations.unshift(fresh);
    activeConvoId = fresh.id;
    return fresh;
  }

  function startNewChat(snap) {
    const hasQuestion = snap?.mode === 'practice';
    const key = hasQuestion ? `${snap.courseId}:${snap.questionId}` : 'general';
    activeKey = key;
    conversations = conversations.filter((c) => c.messages.length > 0);
    activeConvoId = '';
    draftByKey.set(key, '');
    pendingAttachments = [];
    popoverMode = '';
    showAllChats = false;
  }

  function deleteChat(id) {
    conversations = conversations.filter((c) => c.id !== id);
    if (activeConvoId === id) activeConvoId = '';
    persistChats();
  }

  function shortAge(ts) {
    const diffSec = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
    if (diffSec < 60) return 'now';
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h`;
    if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d`;
    return `${Math.max(1, Math.round(diffSec / (86400 * 7)))}w`;
  }

  function getByokKey() {
    try { return (localStorage.getItem(BYOK_KEY) || '').trim(); } catch { return ''; }
  }
  function setByokKey(val) {
    try {
      const clean = String(val || '').trim();
      if (clean) localStorage.setItem(BYOK_KEY, clean);
      else localStorage.removeItem(BYOK_KEY);
    } catch {}
  }
  function getPreferredModel() {
    try {
      const v = localStorage.getItem(BYOK_MODEL_KEY) || 'gemini-4-hydrogen';
      return MODELS.some((m) => m.id === v) ? v : 'gemini-4-hydrogen';
    } catch { return 'gemini-4-hydrogen'; }
  }
  function setPreferredModel(val) {
    try { localStorage.setItem(BYOK_MODEL_KEY, val); } catch {}
  }
  function getThinkingSpeed() {
    try {
      const v = localStorage.getItem(THINKING_KEY) || 'minimal';
      return THINKING_MODES.some((t) => t.id === v) ? v : 'minimal';
    } catch { return 'minimal'; }
  }
  function setThinkingSpeed(val) {
    const clean = THINKING_MODES.some((t) => t.id === val) ? val : 'minimal';
    try { localStorage.setItem(THINKING_KEY, clean); } catch {}
  }
  function closeConflictingDrawers(side = getDockSide()) {
    if (side === 'left' || window.innerWidth < AI_DOCK_MIN_VP) {
      window.StudyApp?.closeSiteExplorer?.();
      if (window.StudyUI?.isReferenceDrawerOpen?.()) window.StudyUI.closeReferenceDrawer();
    }
  }
  function getDockSide() {
    try { return localStorage.getItem(SIDE_KEY) === 'left' ? 'left' : 'right'; } catch { return 'right'; }
  }
  function setDockSide(side) {
    const clean = side === 'left' ? 'left' : 'right';
    try { localStorage.setItem(SIDE_KEY, clean); } catch {}
    if (isOpen) closeConflictingDrawers(clean);
    syncBodyClasses();
  }
  function getSavedWidth() {
    try {
      const n = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(n) && n >= AI_PANE_MIN_W && n <= AI_PANE_MAX_W) return Math.round(n);
    } catch {}
    return null;
  }
  function applyPaneWidth(px) {
    if (Number.isFinite(px) && px >= AI_PANE_MIN_W && px <= AI_PANE_MAX_W) {
      document.documentElement.style.setProperty('--ai-pane-w', `${Math.round(px)}px`);
      try { localStorage.setItem(WIDTH_KEY, String(Math.round(px))); } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // SAFE MARKDOWN + CONTEXT BUILDER (Question + Working + Markdown Note Section)
  // ---------------------------------------------------------------------------
  function sanitizeRenderedHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('script, iframe, object, embed, style, link, meta, form, input, button, textarea').forEach((n) => n.remove());
    tpl.content.querySelectorAll('svg').forEach((svg) => { if (!svg.closest('.katex')) svg.remove(); });
    tpl.content.querySelectorAll('*').forEach((el) => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const val = String(attr.value || '').trim().toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc') el.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'src') && (val.startsWith('javascript:') || val.startsWith('data:'))) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return tpl.innerHTML;
  }

  function renderSafeMd(text) {
    return sanitizeRenderedHtml(renderMarkdownWithMath(text || ''));
  }

  function shortContextTag(snap) {
    if (snap?.mode !== 'practice') return '';
    const raw = String(snap.title || snap.questionId || '').trim();
    if (!raw) return String(snap.course || '').trim();
    return raw.length > 34 ? `${raw.slice(0, 33)}…` : raw;
  }

  function currentExerciseSnapshot(includeSolution = false) {
    if (window.StudyQuestionCopy?.tutorPayload) {
      const p = window.StudyQuestionCopy.tutorPayload({ includeSolution });
      if (p.mode !== 'waiting') return p;
    } else if (window.StudyQuestionCopy?.tutorContext) {
      const p = window.StudyQuestionCopy.tutorContext();
      if (p.mode !== 'waiting') return p;
    }
    if (customCourseContext) return customCourseContext;
    return { mode: 'waiting' };
  }

  async function currentExerciseSnapshotAsync(includeSolution = false) {
    if (window.StudyQuestionCopy?.tutorPayloadAsync) {
      const p = await window.StudyQuestionCopy.tutorPayloadAsync({ includeSolution });
      if (p.mode !== 'waiting') return p;
    }
    return currentExerciseSnapshot(includeSolution);
  }

  function captureVisiblePromptImages(maxCount = 2) {
    if (!contextEnabled || maxCount <= 0) return [];
    const runnerView = document.getElementById('view-runner');
    const card = document.getElementById('runner-question-card');
    if (!runnerView || runnerView.hidden || !card || !card.isConnected) return [];

    const out = [];
    const seen = new Set();
    const candidates = card.querySelectorAll('.pdf-figure canvas, .pdf-figure img, #source-pdf-reader canvas');

    for (const el of candidates) {
      if (out.length >= maxCount) break;
      if (seen.has(el)) continue;
      seen.add(el);
      // Strictly never capture solution figures or hidden/collapsed elements
      if (el.closest('#solution-box, .solution-box, [data-solution-figure], [data-is-solution="1"], [hidden]')) continue;
      const closedDetails = el.closest('details:not([open])');
      if (closedDetails) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 50) continue;

      let srcW = 0;
      let srcH = 0;
      if (el.tagName === 'CANVAS') {
        srcW = el.width || 0;
        srcH = el.height || 0;
      } else if (el.tagName === 'IMG') {
        if (!el.complete || !el.naturalWidth || !el.naturalHeight) continue;
        srcW = el.naturalWidth;
        srcH = el.naturalHeight;
      }
      if (srcW < 100 || srcH < 60) continue;

      try {
        const scale = Math.min(1, 1024 / Math.max(srcW, srcH));
        const w = Math.max(1, Math.round(srcW * scale));
        const h = Math.max(1, Math.round(srcH * scale));
        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        const ctx = off.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(el, 0, 0, w, h);
        const dataUrl = off.toDataURL('image/jpeg', 0.78);
        const base64 = dataUrl.split(',')[1] || '';
        if (!base64 || base64.length > 900_000) continue;
        const cap = el.closest('figure')?.querySelector('figcaption')?.textContent?.trim()?.slice(0, 60) || `Question figure ${out.length + 1}`;
        out.push({ kind: 'image', name: cap, mimeType: 'image/jpeg', base64, auto: true });
      } catch {
        // Ignore cross-origin tainted canvases/images cleanly
      }
    }
    return out;
  }

  async function buildLeanStudyContext(snap) {
    if (!contextEnabled || snap?.mode !== 'practice') return '';
    const parts = [];
    if (snap.context) parts.push(String(snap.context).trim().slice(0, 5800));

    // Attach ONLY the matching Markdown reference section for this topic (fast, capped at 1.5s)
    if (snap.noteFile && snap.noteHeading && window.StudyApp?.fetchReferenceSection) {
      try {
        const sec = await Promise.race([
          window.StudyApp.fetchReferenceSection(snap.noteFile, snap.noteHeading),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        if (sec?.available && sec.selectedHeading && sec.markdown) {
          const cleanSec = String(sec.markdown).trim().slice(0, 2600);
          if (cleanSec) {
            parts.push(`## Course Reference Note (${sec.selectedHeading})\n${cleanSec}`);
          }
        }
      } catch {}
    }
    return parts.join('\n\n').slice(0, 8800);
  }

  // ---------------------------------------------------------------------------
  // FILE / IMAGE ATTACHMENTS + SPEECH-TO-TEXT
  // ---------------------------------------------------------------------------
  function resizeImageFileToBase64(file, maxDim = 1024) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
          const base64 = dataUrl.split(',')[1] || '';
          resolve({ mimeType: 'image/jpeg', base64, previewUrl: dataUrl });
        } catch (err) {
          reject(err);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read image.'));
      };
      img.src = url;
    });
  }

  async function addFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    for (const file of files) {
      if (pendingAttachments.length >= 3) {
        toast('Up to 3 attachments per message.');
        break;
      }
      const name = String(file.name || 'file').slice(0, 72);
      if (file.type?.startsWith('image/')) {
        try {
          const { mimeType, base64, previewUrl } = await resizeImageFileToBase64(file);
          pendingAttachments.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            kind: 'image',
            name,
            mimeType,
            base64,
            previewUrl,
          });
        } catch {
          toast(`Could not read ${name}.`);
        }
      } else if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
        try {
          let extracted = '';
          if (window.StudyPdf?.extractTextFromFile) {
            extracted = await window.StudyPdf.extractTextFromFile(file);
          }
          if (!extracted) {
            const txt = await file.text().catch(() => '');
            extracted = txt.replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
          }
          if (!extracted) {
            toast(`Attached ${name} — tip: screenshot complex PDF pages for best accuracy.`);
            continue;
          }
          pendingAttachments.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            kind: 'text',
            name,
            text: extracted.slice(0, 5500),
          });
        } catch {
          toast(`Could not extract text from ${name}.`);
        }
      } else {
        try {
          const text = (await file.text()).trim();
          if (!text) continue;
          pendingAttachments.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            kind: 'text',
            name,
            text: text.slice(0, 5500),
          });
        } catch {
          toast(`Could not read ${name}.`);
        }
      }
    }
    renderPane({ focusInput: true });
  }

  function supportsSpeech() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  function stopSpeech(silent = true) {
    speechActive = false;
    if (speechRec) {
      try { speechRec.onend = null; speechRec.stop(); } catch {}
      speechRec = null;
    }
    const micBtn = document.getElementById('ai-mic-btn');
    if (micBtn) {
      micBtn.classList.remove('is-recording');
      micBtn.setAttribute('aria-pressed', 'false');
    }
    if (!silent) toast('Dictation stopped.');
  }

  function toggleSpeech() {
    if (!supportsSpeech()) {
      toast('Speech-to-text is not supported in this browser (try Chrome, Edge, or Safari).');
      return;
    }
    if (speechActive) {
      stopSpeech(true);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    const profLang = window.StudyCommunity?.getCurrentProfile?.()?.secondaryLanguage || '';
    rec.lang = profLang === 'nb' || profLang === 'nn' ? 'nb-NO' : (navigator.language || 'en-US');
    rec.interimResults = true;
    rec.continuous = true;

    const inputEl = document.getElementById('ai-tutor-input');
    const baseText = inputEl ? inputEl.value : (draftByKey.get(activeKey) || '');
    let finalTranscript = '';

    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finalTranscript += res[0].transcript;
        else interim += res[0].transcript;
      }
      const sep = baseText && !/\s$/.test(baseText) ? ' ' : '';
      const combined = `${baseText}${sep}${finalTranscript}${interim}`.trimStart();
      draftByKey.set(activeKey, combined);
      const inp = document.getElementById('ai-tutor-input');
      if (inp) {
        inp.value = combined;
        autoSizeTextarea(inp);
        const sendBtn = document.getElementById('ai-send-btn');
        if (sendBtn) sendBtn.disabled = busy || (!combined.trim() && !pendingAttachments.length);
      }
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed') toast('Microphone permission denied.');
      stopSpeech(true);
    };
    rec.onend = () => {
      stopSpeech(true);
    };

    try {
      rec.start();
      speechRec = rec;
      speechActive = true;
      const micBtn = document.getElementById('ai-mic-btn');
      if (micBtn) {
        micBtn.classList.add('is-recording');
        micBtn.setAttribute('aria-pressed', 'true');
      }
    } catch {
      stopSpeech(true);
    }
  }

  // ---------------------------------------------------------------------------
  // DIRECT BYOK STREAMING GEMINI CLIENT (Thinking Speed + Multimodal)
  // ---------------------------------------------------------------------------
  function buildSystemInstruction(action, thinking, contextBlock = '', hasAutoImage = false) {
    const lines = [
      'You are Adamlite, Study-OS\'s fast, concise university study tutor (Economics, Accounting & Finance, Mathematics, OB, Data Science).',
      '- Be direct, clear, and concise. Use $...$ for inline math and $$...$$ for display equations.',
      '- Never output raw HTML or scripts. Match the student\'s language (Norwegian or English).',
      '- Ground formulas and definitions in the provided Reference Note snippet when relevant.',
      '- When ACTIVE STUDY CONTEXT or an attached question figure/PDF image is provided, use it directly right away — NEVER say you cannot see the problem.',
    ];
    if (thinking === 'minimal') lines.push('- Speed mode is MINIMAL: get straight to the answer/step cleanly without filler.');
    if (action === 'hint') lines.push('Give ONE focused next-step hint without spoiling the final answer.');
    if (action === 'solution') lines.push('Walk through the complete step-by-step solution cleanly.');
    if (contextBlock) lines.push(`\nACTIVE STUDY CONTEXT:\n${contextBlock}`);
    if (hasAutoImage) lines.push('\nNote: Image(s) of the visible question prompt / PDF table on screen are attached to the latest user message. Read exact numbers and tables directly from them.');
    return lines.join('\n');
  }

  async function streamDirectGemini(apiKey, preferredModel, thinking, action, contextBlock, history, userPrompt, attachments, onDelta) {
    const models = preferredModel === 'auto'
      ? BYOK_AUTO_CHAIN
      : [
          BYOK_AUTO_CHAIN.find((m) => m.id === preferredModel) || BYOK_AUTO_CHAIN[0],
          ...BYOK_AUTO_CHAIN.filter((m) => m.id !== preferredModel),
        ];

    const hasAutoImage = attachments.some((a) => a.kind === 'image');
    const systemInstruction = buildSystemInstruction(action, thinking, contextBlock, hasAutoImage);
    const contents = [];
    for (const turn of history.slice(-8)) {
      const role = turn.role === 'assistant' ? 'model' : 'user';
      contents.push({ role, parts: [{ text: turn.text }] });
    }
    const textAtts = attachments.filter((a) => a.kind === 'text').map((a) => `ATTACHED FILE (${a.name}):\n${a.text}`).join('\n\n');
    const finalText = textAtts ? `${textAtts}\n\n${userPrompt}` : userPrompt;
    const userParts = [{ text: finalText }];
    for (const att of attachments) {
      if (att.kind === 'image') userParts.push({ inlineData: { mimeType: att.mimeType, data: att.base64 } });
    }
    contents.push({ role: 'user', parts: userParts });

    const budgets = { minimal: 0, low: 512, medium: 2048, high: 8192 };
    const maxTok = thinking === 'minimal' ? 1024 : thinking === 'low' ? 1400 : thinking === 'medium' ? 2048 : 3072;

    let lastErr = 'Gemini API request failed.';
    for (const model of models) {
      const isLegacy = /^gemini-2\./i.test(model.id);
      const tcChain = isLegacy
        ? [{ thinkingBudget: budgets[thinking] ?? 0 }, { thinkingLevel: thinking }, null]
        : thinking === 'minimal'
        ? [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, { thinkingBudget: 0 }, null]
        : [{ thinkingLevel: thinking }, { thinkingBudget: budgets[thinking] ?? 512 }, null];
      for (const tc of tcChain) {
        try {
          const generationConfig = { temperature: 0.3, maxOutputTokens: maxTok };
          if (tc) generationConfig.thinkingConfig = tc;
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemInstruction }] },
                contents,
                generationConfig,
              }),
            }
          );
          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            lastErr = errBody?.error?.message || `Gemini HTTP ${res.status}`;
            if (res.status === 400 && tc !== null) continue; // try next thinkingConfig shape
            if (res.status === 404 || res.status === 429 || res.status === 503) break; // next model
            throw new Error(lastErr);
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let full = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === '[DONE]') continue;
              try {
                const payload = JSON.parse(raw);
                const parts = payload?.candidates?.[0]?.content?.parts || [];
                const delta = parts.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
                if (delta) {
                  full += delta;
                  if (typeof onDelta === 'function') onDelta(delta, full);
                }
              } catch {}
            }
          }
          if (full.trim()) {
            return { reply: full.trim(), provider: 'byok', modelLabel: `${model.label} · Key` };
          }
          lastErr = 'Empty response from Gemini.';
          break;
        } catch (err) {
          lastErr = err?.message || 'Could not reach Google Gemini API.';
          break;
        }
      }
    }
    throw new Error(lastErr);
  }

  // ---------------------------------------------------------------------------
  // PANE CHROME & RESIZE (Blue VS Code Resize Bar + Narrow Collapse)
  // ---------------------------------------------------------------------------
  function syncBodyClasses() {
    const side = getDockSide();
    document.body.classList.toggle('ai-pane-open', isOpen);
    document.body.classList.toggle('ai-pane-left', isOpen && side === 'left');
    document.body.classList.toggle('ai-pane-right', isOpen && side !== 'left');
    document.getElementById('run-al-btn')?.setAttribute('aria-expanded', String(isOpen));
    document.getElementById('hdr-al-btn')?.setAttribute('aria-expanded', String(isOpen));
  }

  function updatePaneNarrowClass(pane) {
    if (!pane) return;
    const w = pane.getBoundingClientRect().width || getSavedWidth() || 340;
    pane.classList.toggle('is-narrow', w < 318);
    pane.classList.toggle('is-ultra-narrow', w < 248);
    pane.classList.toggle('is-micro-narrow', w < 198);
  }

  function ensurePane() {
    let backdrop = document.getElementById('ai-tutor-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'ai-tutor-backdrop';
      backdrop.className = 'ai-tutor-backdrop';
      backdrop.hidden = true;
      backdrop.addEventListener('click', () => close());
      document.body.appendChild(backdrop);
    }

    let pane = document.getElementById('ai-tutor-pane');
    if (pane) return pane;

    const savedW = getSavedWidth();
    if (savedW) document.documentElement.style.setProperty('--ai-pane-w', `${savedW}px`);

    pane = document.createElement('aside');
    pane.id = 'ai-tutor-pane';
    pane.className = 'ai-tutor-pane ai-codex-pane';
    pane.hidden = true;
    pane.setAttribute('role', 'complementary');
    pane.setAttribute('aria-label', 'Adamlite');
    pane.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        if (popoverMode) {
          popoverMode = '';
          renderPane({ focusInput: true });
        } else {
          close();
        }
      }
    });
    document.addEventListener('pointerdown', (ev) => {
      if (!isOpen || !popoverMode) return;
      if (ev.target.closest('#ai-speed-popover, #ai-settings-popover, #ai-speed-trigger, #ai-tutor-settings, #ai-pane-resize')) return;
      popoverMode = '';
      renderPane();
    });
    document.body.appendChild(pane);

    if ('ResizeObserver' in window) {
      paneResizeObs = new ResizeObserver(() => updatePaneNarrowClass(pane));
      paneResizeObs.observe(pane);
    }
    return pane;
  }

  function bindResizeHandle(pane) {
    const handle = pane.querySelector('#ai-pane-resize');
    if (!handle) return;
    handle.addEventListener('pointerdown', (startEv) => {
      if (window.innerWidth < AI_DOCK_MIN_VP) return;
      startEv.preventDefault();
      if (popoverMode) {
        popoverMode = '';
        pane.querySelector('#ai-speed-popover, #ai-settings-popover')?.remove();
        pane.querySelector('#ai-speed-trigger')?.classList.remove('is-active');
        pane.querySelector('#ai-tutor-settings')?.classList.remove('is-active');
      }
      handle.setPointerCapture?.(startEv.pointerId);
      const restoreW = Math.max(AI_PANE_MIN_W, Math.round(pane.getBoundingClientRect().width || getSavedWidth() || 340));
      let willCollapse = false;
      document.body.classList.add('ai-pane-resizing');
      pane.classList.add('is-resizing');
      const side = getDockSide();
      const railW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--runner-rail-width')) || 0;
      const onMove = (ev) => {
        const rawW = side === 'left' ? ev.clientX - railW : window.innerWidth - ev.clientX;
        const maxW = Math.min(AI_PANE_MAX_W, Math.round(window.innerWidth * 0.65));
        if (rawW < AI_COLLAPSE_THRESHOLD) {
          willCollapse = true;
          pane.classList.add('is-collapsing');
          // Visually collapse flush to the edge while keeping pointer capture alive so
          // dragging back out before releasing smoothly reopens the pane (VS Code style)
          document.documentElement.style.setProperty('--ai-pane-w', '0px');
          return;
        }
        willCollapse = false;
        pane.classList.remove('is-collapsing');
        const clamped = Math.max(AI_PANE_MIN_W, Math.min(maxW, rawW));
        applyPaneWidth(clamped);
        updatePaneNarrowClass(pane);
      };
      const cleanup = () => {
        document.body.classList.remove('ai-pane-resizing');
        pane.classList.remove('is-resizing', 'is-collapsing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (willCollapse) {
          applyPaneWidth(restoreW);
          close();
        }
      };
      const onUp = () => cleanup();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  function autoSizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(150, Math.max(24, el.scrollHeight))}px`;
  }

  function shouldAutoFocusComposer() {
    return window.matchMedia?.('(pointer: fine)').matches !== false && window.innerWidth >= 760;
  }

  function modelShortLabel() {
    const pref = getPreferredModel();
    const m = MODELS.find((x) => x.id === pref);
    if (pref !== 'auto' && m) return m.short;
    if (serverStatus?.modelLabel) {
      return serverStatus.modelLabel.replace(/^Gemini\s+/i, '').replace(/^Cloudflare AI\s*·\s*/i, '');
    }
    return '4 Hydrogen';
  }

  function thinkingShortLabel() {
    const t = THINKING_MODES.find((x) => x.id === getThinkingSpeed());
    return t ? t.label : 'Minimal';
  }

  // ---------------------------------------------------------------------------
  // RENDER — 1:1 VS CODE CODEX CHAT SIDEBAR
  // ---------------------------------------------------------------------------
  function popoverHtml(byok) {
    if (!popoverMode) return '';
    const speed = getThinkingSpeed();
    const speedLbl = thinkingShortLabel();
    const model = getPreferredModel();
    const focusModelId = hoveredModelId || model;
    const quotaCompact = byok
      ? 'Personal key'
      : serverStatus?.available && Number.isFinite(serverStatus.remaining)
      ? `${serverStatus.remaining}/${serverStatus.limit} left`
      : '';

    if (popoverMode === 'speed') {
      return `
        <div class="ai-codex-popover ai-menu-pop" id="ai-speed-popover" role="menu" aria-label="Model and thinking effort">
          <div class="ai-menu-head">Model</div>
          <div class="ai-menu-list" id="ai-model-list">
            ${MODELS.map((m) => {
              const isSelected = model === m.id;
              const isFocused = focusModelId === m.id;
              return `
                <button type="button" class="ai-menu-row ${isSelected ? 'is-selected' : ''} ${isFocused ? 'is-focused' : ''}" data-pick-model="${esc(m.id)}" role="menuitemradio" aria-checked="${isSelected ? 'true' : 'false'}">
                  <span class="ai-menu-row-main">
                    <span class="ai-menu-row-name">${esc(m.label)}</span>
                    <span class="ai-menu-row-effort">${esc(speedLbl)}</span>
                    ${m.tag ? `<span class="ai-menu-pill">${esc(m.tag)}</span>` : ''}
                  </span>
                </button>`;
            }).join('')}
          </div>
          <div class="ai-menu-sep"></div>
          <button type="button" class="ai-menu-row ai-menu-foot-row" id="ai-menu-open-usage">
            <span class="ai-menu-row-main">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2.5 11.2a6 6 0 1 1 11 0"/><path d="M8 8.5l2.6-2.8"/><circle cx="8" cy="9.2" r="1"/>
              </svg>
              <span class="ai-menu-row-name">View Usage</span>
            </span>
            <span class="ai-menu-foot-right">
              ${quotaCompact ? `<span class="ai-menu-row-effort">${esc(quotaCompact)}</span>` : ''}
            </span>
          </button>

          <div class="ai-effort-flyout" id="ai-effort-flyout" role="menu" aria-label="Thinking effort">
            <div class="ai-effort-head">
              <span>Thinking effort</span>
              <span class="ai-effort-info" title="Minimal = fastest instant replies · High = deepest step-by-step proofs">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.5M8 5.2h.01"/>
                </svg>
              </span>
            </div>
            <div class="ai-effort-list">
              ${THINKING_MODES.map((t) => `
                <button type="button" class="ai-effort-row ${speed === t.id ? 'is-selected' : ''}" data-pick-speed="${esc(t.id)}" title="${esc(t.hint)}" role="menuitemradio" aria-checked="${speed === t.id ? 'true' : 'false'}">
                  <span>${esc(t.label)}</span>
                  ${speed === t.id ? '<svg class="ai-opt-check" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 8.4 6.5 11.7 12.8 4.8"/></svg>' : ''}
                </button>`).join('')}
            </div>
          </div>
        </div>`;
    }

    // popoverMode === 'settings' — Clean Codex / Antigravity surface matching Model menu
    return `
      <div class="ai-codex-popover ai-menu-pop ai-codex-settings-pop" id="ai-settings-popover">
        <div class="ai-set-head">
          <span class="ai-set-title">Settings</span>
          ${quotaCompact ? `<span class="ai-menu-pill">${esc(quotaCompact)}</span>` : ''}
        </div>
        <label class="ai-set-toggle-row" for="ai-ctx-checkbox">
          <span class="ai-set-toggle-copy">
            <strong>Study context</strong>
            <small>Question, working &amp; note section</small>
          </span>
          <span class="ai-codex-switch">
            <input type="checkbox" id="ai-ctx-checkbox" ${contextEnabled ? 'checked' : ''}>
            <span class="ai-codex-switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <div class="ai-menu-sep"></div>
        <div class="ai-set-key-block">
          <div class="ai-set-field-label">Gemini API key (optional)</div>
          <div class="ai-set-key-row">
            <input type="password" id="ai-byok-input" value="${esc(byok)}" placeholder="AIza…" autocomplete="off" spellcheck="false" aria-label="Google Gemini API key">
            <button type="button" class="ai-set-save-btn" id="ai-byok-save">Save</button>
            ${byok ? '<button type="button" class="ai-set-rm-btn" id="ai-byok-clear" title="Remove personal key" aria-label="Remove personal key">×</button>' : ''}
          </div>
        </div>
        <div class="ai-menu-sep"></div>
        <button type="button" class="ai-menu-row ai-menu-foot-row" id="ai-open-mcp-btn">
          <span class="ai-menu-row-main">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="12" height="9" rx="1.6"/><path d="M5.5 14h5M5 6.5 6.8 8 5 9.5M8.2 9.5h2.5"/>
            </svg>
            <span class="ai-menu-row-name">Desktop MCP</span>
          </span>
          <svg class="ai-menu-chev" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 3.5 10.5 8 6 12.5"/>
          </svg>
        </button>
      </div>`;
  }

  function renderPane(opts = {}) {
    const pane = ensurePane();
    const prevInput = pane.querySelector('#ai-tutor-input');
    const hadFocus = Boolean(prevInput && document.activeElement === prevInput);
    const prevSelStart = hadFocus ? prevInput.selectionStart : null;
    const prevSelEnd = hadFocus ? prevInput.selectionEnd : null;

    const snap = currentExerciseSnapshot(false);
    const hasQuestion = snap.mode === 'practice';
    const nextKey = hasQuestion ? `${snap.courseId}:${snap.questionId}` : 'general';
    if (nextKey !== activeKey && !activeConvoId) activeKey = nextKey;

    const activeConvo = findConvoById(activeConvoId);
    const messages = activeConvo ? activeConvo.messages : [];
    const inChat = messages.length > 0;
    const savedChats = getSavedChats();

    const byok = getByokKey();
    const signedIn = Boolean(window.StudyCommunity?.isSignedIn?.());
    const canAsk = Boolean(byok || signedIn);
    const draft = draftByKey.get(activeKey) || '';
    const side = getDockSide();

    // Recent chats list (Codex-style: top 3 + "View all (N)" on empty/home view)
    const visibleChats = showAllChats ? savedChats : savedChats.slice(0, 3);
    const chatsListHtml = !inChat && savedChats.length
      ? `
        <div class="ai-codex-chats">
          ${visibleChats.map((c) => `
            <div class="ai-codex-chat-row">
              <button type="button" class="ai-codex-chat-btn" data-open-chat-id="${esc(c.id)}" title="${esc(c.title)}">
                <span class="ai-codex-chat-title">${esc(c.title || 'Untitled chat')}</span>
                <span class="ai-codex-chat-age">${esc(shortAge(c.updatedAt))}</span>
              </button>
              <button type="button" class="ai-codex-chat-del" data-del-chat-id="${esc(c.id)}" title="Delete chat" aria-label="Delete chat">×</button>
            </div>`).join('')}
          ${savedChats.length > 3 ? `
            <button type="button" class="ai-codex-view-all" id="ai-toggle-all-chats">
              ${showAllChats ? 'Show less' : `View all (${savedChats.length})`}
            </button>` : ''}
        </div>`
      : '';

    const threadHtml = inChat
      ? `<div class="ai-thread" id="ai-tutor-thread">
          ${messages.map((m, idx) => {
            if (m.role === 'user') {
              const attTags = (m.attachments || []).length
                ? `<div class="ai-msg-atts">${m.attachments.map((a) => `<span class="ai-msg-att-pill">${a.kind === 'image' ? '🖼' : '📄'} ${esc(a.name)}</span>`).join('')}</div>`
                : '';
              return `<div class="ai-turn ai-turn-user"><div class="ai-user-bubble">${attTags}${esc(m.text)}</div></div>`;
            }
            return `
              <div class="ai-turn ai-turn-assistant" data-msg-idx="${idx}">
                <div class="ai-assistant-prose markdown-body">${m.text ? renderSafeMd(m.text) : '<span class="ai-typing"><span></span><span></span><span></span></span>'}</div>
                ${m.text ? `
                  <div class="ai-turn-actions">
                    <button type="button" class="ai-icon-micro" data-copy-msg="${idx}" title="Copy response" aria-label="Copy response">
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <rect x="5" y="5" width="8.5" height="8.5" rx="1.8"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/>
                      </svg>
                      <span>Copy</span>
                    </button>
                    ${m.meta ? `<span class="ai-turn-model">${esc(m.meta)}</span>` : ''}
                  </div>` : ''}
              </div>`;
          }).join('')}
        </div>`
      : `
        <div class="ai-codex-home">
          ${chatsListHtml}
          <div class="ai-codex-watermark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="38" height="38" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.5 24.5h11a5.5 5.5 0 0 0 .8-10.94A7 7 0 0 0 9.1 11.4 4.8 4.8 0 0 0 10.5 24.5Z"/>
              <path d="m12.5 16.2 2.4 2.1-2.4 2.1M16.8 20.4h3"/>
            </svg>
          </div>
        </div>`;

    const attachChipsHtml = pendingAttachments.length
      ? `<div class="ai-attach-strip">
          ${pendingAttachments.map((a) => `
            <span class="ai-attach-chip">
              ${a.kind === 'image' && a.previewUrl ? `<img class="ai-attach-thumb" src="${a.previewUrl}" alt="">` : '<span class="ai-attach-ico">📄</span>'}
              <span class="ai-attach-name">${esc(a.name)}</span>
              <button type="button" class="ai-attach-rm" data-rm-att="${esc(a.id)}" aria-label="Remove attachment">×</button>
            </span>`).join('')}
        </div>`
      : '';

    const signInHint = !canAsk
      ? `<div class="ai-signin-bar">
          <span>Sign in to use Adamlite</span>
          <div class="ai-signin-bar-btns">
            <button type="button" class="ai-text-link" id="ai-tutor-signin">Sign in</button>
            <button type="button" class="ai-text-link" id="ai-tutor-open-key">API key</button>
          </div>
        </div>`
      : '';

    pane.innerHTML = `
      <div class="ai-pane-resize-handle ai-codex-resize" id="ai-pane-resize" title="Drag to resize Adamlite" aria-hidden="true"></div>
      <div class="ai-mobile-grabber" aria-hidden="true"></div>

      <!-- Top Tab Bar (Codex 1:1) -->
      <header class="ai-codex-tabbar">
        <div class="ai-codex-tab">
          <img class="adamlite-tab-img" src="${AVATAR_SRC}" alt="" width="16" height="16">
          <span>Adamlite</span>
        </div>
        <div class="ai-codex-tab-actions">
          <button type="button" class="ai-codex-icon-btn ai-dock-flip-btn" id="ai-dock-flip" title="Dock to ${side === 'right' ? 'left' : 'right'} side" aria-label="Dock side">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10"/>
            </svg>
          </button>
          <button type="button" class="ai-codex-icon-btn" id="ai-tutor-close" title="Close Adamlite (Esc)" aria-label="Close Adamlite">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
        </div>
      </header>

      <!-- Sub-header Strip (Chats + 3 outline icons: History, Settings, New Chat) -->
      <div class="ai-codex-subbar">
        ${inChat
          ? `<button type="button" class="ai-codex-back-btn" id="ai-back-chats" title="Back to Chats">← Chats</button>`
          : `<span class="ai-codex-sub-title">Chats</span>`}
        <div class="ai-codex-sub-actions">
          <button type="button" class="ai-codex-icon-btn ${showAllChats && !inChat ? 'is-active' : ''}" id="ai-tutor-history" title="Previous chats (${savedChats.length})" aria-label="Previous chats">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2.4 8a5.6 5.6 0 1 0 1.4-3.7L2.3 5.8"/><path d="M2.2 2.8v3.1h3.1"/><path d="M8 5v3.2l2.1 1.3"/>
            </svg>
          </button>
          <button type="button" class="ai-codex-icon-btn ${popoverMode === 'settings' ? 'is-active' : ''}" id="ai-tutor-settings" title="Adamlite settings" aria-label="Adamlite settings">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="8" cy="8" r="2.2"/><path d="M13 9.9a1.1 1.1 0 0 0 .2 1.2l.04.04a1.33 1.33 0 1 1-1.88 1.88l-.04-.04a1.1 1.1 0 0 0-1.2-.2 1.1 1.1 0 0 0-.67 1v.12a1.33 1.33 0 1 1-2.66 0v-.06a1.1 1.1 0 0 0-.72-1 1.1 1.1 0 0 0-1.2.2l-.04.04a1.33 1.33 0 1 1-1.88-1.88l.04-.04a1.1 1.1 0 0 0 .2-1.2 1.1 1.1 0 0 0-1-.67h-.06a1.33 1.33 0 1 1 0-2.66h.06a1.1 1.1 0 0 0 1-.72 1.1 1.1 0 0 0-.2-1.2l-.04-.04a1.33 1.33 0 1 1 1.88-1.88l.04.04a1.1 1.1 0 0 0 1.2.2h.05a1.1 1.1 0 0 0 .67-1v-.06a1.33 1.33 0 1 1 2.66 0v.06a1.1 1.1 0 0 0 .67 1 1.1 1.1 0 0 0 1.2-.2l.04-.04a1.33 1.33 0 1 1 1.88 1.88l-.04.04a1.1 1.1 0 0 0-.2 1.2v.05a1.1 1.1 0 0 0 1 .67h.06a1.33 1.33 0 1 1 0 2.66h-.06a1.1 1.1 0 0 0-1 .67Z"/>
            </svg>
          </button>
          <button type="button" class="ai-codex-icon-btn" id="ai-tutor-new" title="New chat" aria-label="New chat">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12.5 9.2v3.3a1.2 1.2 0 0 1-1.2 1.2H3.5a1.2 1.2 0 0 1-1.2-1.2V4.7a1.2 1.2 0 0 1 1.2-1.2h3.3"/>
              <path d="M11.6 2.4a1.3 1.3 0 0 1 1.85 1.85L7.6 10.1l-2.4.6.6-2.4 5.8-5.9Z"/>
            </svg>
          </button>
        </div>
      </div>

      ${threadHtml}

      <!-- Codex-Style Floating Composer Card -->
      <div class="ai-composer-zone ai-codex-composer-zone">
        ${popoverHtml(byok)}
        ${signInHint}
        <form class="ai-composer-card ai-codex-composer" id="ai-tutor-form">
          ${attachChipsHtml}
          <input type="file" id="ai-file-input" multiple accept="image/*,.txt,.md,.csv,.py,.json,.pdf" hidden>
          <textarea
            id="ai-tutor-input"
            rows="1"
            maxlength="2000"
            placeholder="${snap.mode === 'blind' ? 'Disabled during blind exam' : 'Ask Adamlite…'}"
            ${busy || !canAsk || snap.mode === 'blind' ? 'disabled' : ''}
          >${esc(draft)}</textarea>
          <div class="ai-composer-bar ai-codex-bar">
            <div class="ai-codex-bar-left">
              <button type="button" class="ai-codex-tool-btn" id="ai-attach-btn" title="Attach image, PDF or text file (or paste screenshot)" aria-label="Attach files" ${busy || !canAsk || snap.mode === 'blind' ? 'disabled' : ''}>
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>
              </button>
              <button type="button" class="ai-codex-tool-btn ai-ctx-shield ${contextEnabled && hasQuestion ? 'is-ctx-on' : ''}" id="ai-ctx-toggle" title="${hasQuestion ? (contextEnabled ? `Exercise + Markdown notes attached (${esc(shortContextTag(snap))}) — click to toggle` : 'Context off — click to attach exercise + notes') : 'No active question — general study chat'}" aria-label="Toggle exercise context" aria-pressed="${contextEnabled ? 'true' : 'false'}">
                <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M8 2.1 13 4v3.8c0 3.1-2.1 5.3-5 6.2-2.9-.9-5-3.1-5-6.2V4l5-1.9Z"/>
                  <path d="M8 5.8v2.6M8 10.6h.01"/>
                </svg>
              </button>
            </div>
            <div class="ai-codex-bar-right">
              <button type="button" class="ai-codex-speed-btn ${popoverMode === 'speed' ? 'is-active' : ''}" id="ai-speed-trigger" title="${esc(modelShortLabel())} · ${esc(thinkingShortLabel())} thinking (click to change speed or model)" aria-expanded="${popoverMode === 'speed' ? 'true' : 'false'}">
                <svg class="ai-brain-svg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
                  <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
                </svg>
                <span class="ai-speed-text">
                  <strong class="ai-model-name">${esc(modelShortLabel())}</strong>
                  <span class="ai-speed-tag">${esc(thinkingShortLabel())}</span>
                </span>
              </button>
              <button type="button" class="ai-codex-tool-btn ai-mic-btn ${speechActive ? 'is-recording' : ''}" id="ai-mic-btn" title="${supportsSpeech() ? 'Dictate with speech-to-text' : 'Speech-to-text unavailable in this browser'}" aria-label="Speech to text" aria-pressed="${speechActive ? 'true' : 'false'}" ${!canAsk || snap.mode === 'blind' ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/>
                </svg>
              </button>
              <button type="submit" class="ai-send-circle ai-codex-send" id="ai-send-btn" title="Send (Enter)" aria-label="Send message" ${busy || !canAsk || snap.mode === 'blind' || (!draft.trim() && !pendingAttachments.length) ? 'disabled' : ''}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M8 12.5V3.5M4 7.5 8 3.5l4 4"/>
                </svg>
              </button>
            </div>
          </div>
        </form>
      </div>
    `;

    updatePaneNarrowClass(pane);
    bindResizeHandle(pane);
    bindPaneEvents(pane, snap, messages, canAsk, hadFocus, prevSelStart, prevSelEnd, opts);

    const threadEl = pane.querySelector('#ai-tutor-thread');
    if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
  }

  function bindPaneEvents(pane, snap, messages, canAsk, hadFocus, prevSelStart, prevSelEnd, opts) {
    pane.querySelector('#ai-tutor-close')?.addEventListener('click', () => close());
    pane.querySelector('#ai-dock-flip')?.addEventListener('click', () => {
      setDockSide(getDockSide() === 'right' ? 'left' : 'right');
      renderPane({ focusInput: true });
    });
    pane.querySelector('#ai-back-chats')?.addEventListener('click', () => {
      activeConvoId = '';
      popoverMode = '';
      renderPane({ focusInput: true });
    });
    pane.querySelector('#ai-tutor-new')?.addEventListener('click', () => {
      startNewChat(snap);
      renderPane({ focusInput: true });
    });
    pane.querySelector('#ai-tutor-history')?.addEventListener('click', () => {
      if (activeConvoId) {
        activeConvoId = '';
        showAllChats = true;
      } else {
        showAllChats = !showAllChats;
      }
      popoverMode = '';
      renderPane();
    });
    pane.querySelector('#ai-toggle-all-chats')?.addEventListener('click', () => {
      showAllChats = !showAllChats;
      renderPane();
    });
    pane.querySelector('#ai-tutor-settings')?.addEventListener('click', () => {
      popoverMode = popoverMode === 'settings' ? '' : 'settings';
      renderPane({ focusInput: !popoverMode });
    });
    pane.querySelector('#ai-speed-trigger')?.addEventListener('click', () => {
      popoverMode = popoverMode === 'speed' ? '' : 'speed';
      hoveredModelId = getPreferredModel();
      renderPane({ focusInput: !popoverMode });
    });
    pane.querySelector('#ai-menu-open-usage')?.addEventListener('click', () => {
      popoverMode = 'settings';
      renderPane();
    });
    pane.querySelector('#ai-ctx-toggle')?.addEventListener('click', () => {
      contextEnabled = !contextEnabled;
      toast(contextEnabled ? 'Exercise + Markdown notes context ON' : 'Context OFF (general chat)');
      renderPane({ focusInput: true });
    });
    pane.querySelector('#ai-ctx-checkbox')?.addEventListener('change', (ev) => {
      contextEnabled = Boolean(ev.target.checked);
      renderPane();
    });

    // Thinking speed & model selectors (Antigravity inside-sidebar cascading card)
    const speedPop = pane.querySelector('#ai-speed-popover');
    const effortFly = pane.querySelector('#ai-effort-flyout');
    const usageRow = pane.querySelector('#ai-menu-open-usage');
    const positionEffortUnderRow = (rowEl) => {
      if (!speedPop || !effortFly || !rowEl) return;
      effortFly.classList.remove('is-hidden');
      const desiredTop = rowEl.offsetTop + rowEl.offsetHeight + 4;
      const maxTop = Math.max(32, speedPop.offsetHeight - effortFly.offsetHeight - 10);
      effortFly.style.top = `${Math.min(desiredTop, maxTop)}px`;
    };
    if (speedPop && effortFly) {
      const initialRow = speedPop.querySelector('.ai-menu-row.is-focused') || speedPop.querySelector('[data-pick-model]');
      if (initialRow) requestAnimationFrame(() => positionEffortUnderRow(initialRow));
      usageRow?.addEventListener('mouseenter', () => {
        effortFly.classList.add('is-hidden');
      });
    }

    pane.querySelectorAll('[data-pick-speed]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (hoveredModelId && MODELS.some((m) => m.id === hoveredModelId)) {
          setPreferredModel(hoveredModelId);
        }
        setThinkingSpeed(btn.dataset.pickSpeed);
        popoverMode = '';
        toast(`Adamlite: ${modelShortLabel()} · ${thinkingShortLabel()}`);
        renderPane({ focusInput: true });
      });
    });
    pane.querySelectorAll('[data-pick-model]').forEach((btn) => {
      btn.addEventListener('mouseenter', () => {
        hoveredModelId = btn.dataset.pickModel || '';
        pane.querySelectorAll('[data-pick-model]').forEach((row) => {
          row.classList.toggle('is-focused', row === btn);
        });
        positionEffortUnderRow(btn);
      });
      btn.addEventListener('click', () => {
        setPreferredModel(btn.dataset.pickModel);
        hoveredModelId = btn.dataset.pickModel;
        popoverMode = '';
        renderPane({ focusInput: true });
      });
    });

    // Chat history row open / delete
    pane.querySelectorAll('[data-open-chat-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const picked = findConvoById(btn.dataset.openChatId);
        if (!picked) return;
        activeConvoId = picked.id;
        activeKey = picked.key || 'general';
        popoverMode = '';
        renderPane({ focusInput: true });
      });
    });
    pane.querySelectorAll('[data-del-chat-id]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteChat(btn.dataset.delChatId);
        renderPane();
      });
    });

    // File attachments + mic
    const fileInput = pane.querySelector('#ai-file-input');
    pane.querySelector('#ai-attach-btn')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      if (fileInput.files?.length) addFiles(fileInput.files);
      fileInput.value = '';
    });
    pane.querySelectorAll('[data-rm-att]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingAttachments = pendingAttachments.filter((a) => a.id !== btn.dataset.rmAtt);
        renderPane({ focusInput: true });
      });
    });
    pane.querySelector('#ai-mic-btn')?.addEventListener('click', toggleSpeech);

    // Sign in & BYOK settings
    pane.querySelector('#ai-tutor-open-key')?.addEventListener('click', () => {
      popoverMode = 'settings';
      renderPane();
      pane.querySelector('#ai-byok-input')?.focus();
    });
    pane.querySelector('#ai-open-mcp-btn')?.addEventListener('click', () => {
      popoverMode = '';
      renderPane();
      window.StudyTutor?.open?.();
    });
    pane.querySelector('#ai-tutor-signin')?.addEventListener('click', async () => {
      await window.StudyCommunity?.requireProfile?.({ allowDemo: true, forcePrompt: true });
      if (window.StudyCommunity?.isSignedIn?.()) {
        refreshStatus();
        renderPane({ focusInput: true });
        requestAnimationFrame(() => focusComposerIfReady());
      }
    });
    pane.querySelector('#ai-byok-save')?.addEventListener('click', () => {
      const val = pane.querySelector('#ai-byok-input')?.value.trim() || '';
      setByokKey(val);
      popoverMode = '';
      toast(val ? 'Personal Gemini key saved.' : 'Using built-in Adamlite.');
      renderPane({ focusInput: true });
    });
    pane.querySelector('#ai-byok-clear')?.addEventListener('click', () => {
      setByokKey('');
      popoverMode = '';
      toast('Removed personal Gemini key.');
      renderPane({ focusInput: true });
    });

    // Copy assistant response
    pane.querySelectorAll('[data-copy-msg]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const msg = messages[Number(btn.dataset.copyMsg)];
        if (!msg?.text) return;
        try {
          await navigator.clipboard.writeText(msg.text);
          const sp = btn.querySelector('span');
          if (sp) { sp.textContent = 'Copied'; setTimeout(() => { sp.textContent = 'Copy'; }, 1400); }
        } catch { toast('Could not copy response.'); }
      });
    });

    // Composer textarea + paste image + submit
    const inputEl = pane.querySelector('#ai-tutor-input');
    const sendBtn = pane.querySelector('#ai-send-btn');
    const formEl = pane.querySelector('#ai-tutor-form');
    if (inputEl) {
      autoSizeTextarea(inputEl);
      inputEl.addEventListener('input', () => {
        draftByKey.set(activeKey, inputEl.value);
        autoSizeTextarea(inputEl);
        if (sendBtn) sendBtn.disabled = busy || !canAsk || snap.mode === 'blind' || (!inputEl.value.trim() && !pendingAttachments.length);
      });
      inputEl.addEventListener('paste', (ev) => {
        const items = [...(ev.clipboardData?.items || [])];
        const imgFiles = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
        if (imgFiles.length) {
          ev.preventDefault();
          addFiles(imgFiles);
        }
      });
      inputEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          if (inputEl.value.trim() || pendingAttachments.length) formEl?.requestSubmit();
        }
      });
      if (!inputEl.disabled && !popoverMode && (hadFocus || (opts.focusInput && shouldAutoFocusComposer()))) {
        inputEl.focus({ preventScroll: true });
        const end = inputEl.value.length;
        const start = Number.isInteger(prevSelStart) ? Math.min(prevSelStart, end) : end;
        const finish = Number.isInteger(prevSelEnd) ? Math.min(prevSelEnd, end) : end;
        try { inputEl.setSelectionRange(start, finish); } catch {}
      }
    }
    formEl?.addEventListener('click', (ev) => {
      if (!inputEl || inputEl.disabled) return;
      if (ev.target.closest('button, a, select, input, textarea')) return;
      inputEl.focus({ preventScroll: true });
    });
    formEl?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = inputEl?.value.trim() || '';
      if ((!text && !pendingAttachments.length) || busy) return;
      stopSpeech(true);
      draftByKey.set(activeKey, '');
      inputEl.value = '';
      autoSizeTextarea(inputEl);
      sendTurn('chat', text, text);
    });
  }

  // ---------------------------------------------------------------------------
  // FAST STREAMING SEND TURN
  // ---------------------------------------------------------------------------
  async function sendTurn(action, userMessage, displayBubble) {
    if (busy) return;
    const includeSolution = action === 'solution';
    const snap = currentExerciseSnapshot(includeSolution);
    if (snap.mode === 'blind') {
      toast('Adamlite is disabled during blind exams.');
      return;
    }

    const byok = getByokKey();
    const signedIn = Boolean(window.StudyCommunity?.isSignedIn?.());
    if (!byok && !signedIn) {
      toast('Sign in or add your free Gemini API key first.');
      return;
    }

    const attachmentsToSend = [...pendingAttachments];
    pendingAttachments = [];
    popoverMode = '';

    const convo = ensureActiveConvo(activeKey, snap);
    const thread = convo.messages;
    const priorHistory = thread.slice(-8).map((m) => ({ role: m.role, text: m.text }));
    const visibleUser = displayBubble || userMessage || (attachmentsToSend.length ? `Attached ${attachmentsToSend.map((a) => a.name).join(', ')}` : 'Help me with this question.');

    if (thread.length === 0) {
      convo.title = visibleUser.slice(0, 84);
      convo.course = snap.mode === 'practice' ? String(snap.course || '') : convo.course;
      convo.ctxLabel = shortContextTag(snap) || convo.ctxLabel;
    }

    thread.push({
      role: 'user',
      text: visibleUser,
      attachments: attachmentsToSend.map((a) => ({ kind: a.kind, name: a.name })),
    });
    const assistantMsg = { role: 'assistant', text: '', meta: '' };
    thread.push(assistantMsg);
    const assistantIdx = thread.length - 1;
    convo.updatedAt = Date.now();
    persistChats();

    busy = true;
    renderPane();

    // Live incremental DOM painter for streaming chunks (zero full pane rebuild!)
    let paintQueued = false;
    const paintStreamingBubble = () => {
      paintQueued = false;
      const pane = document.getElementById('ai-tutor-pane');
      const prose = pane?.querySelector(`[data-msg-idx="${assistantIdx}"] .ai-assistant-prose`);
      const threadEl = pane?.querySelector('#ai-tutor-thread');
      if (prose) prose.innerHTML = renderSafeMd(assistantMsg.text);
      if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
    };
    const onDelta = (delta) => {
      assistantMsg.text += delta;
      if (!paintQueued) {
        paintQueued = true;
        requestAnimationFrame(paintStreamingBubble);
      }
    };

    try {
      const thinking = getThinkingSpeed();
      const model = getPreferredModel();
      const richSnap = await currentExerciseSnapshotAsync(includeSolution);
      const contextText = await buildLeanStudyContext(richSnap);
      const wireAttachments = attachmentsToSend.map((a) =>
        a.kind === 'image'
          ? { kind: 'image', name: a.name, mimeType: a.mimeType, base64: a.base64 }
          : { kind: 'text', name: a.name, text: a.text }
      );
      // Automatically attach visible prompt PDF/figure image(s) (e.g. tables, exam scans, graphs)
      // when Study Context is enabled so Adamlite sees exact numbers without manual screenshots!
      if (contextEnabled && richSnap.mode === 'practice' && wireAttachments.length < 3) {
        const autoImgs = captureVisiblePromptImages(Math.min(2, 3 - wireAttachments.length));
        for (const img of autoImgs) {
          wireAttachments.push({ kind: 'image', name: img.name, mimeType: img.mimeType, base64: img.base64 });
        }
      }

      let res;
      if (byok) {
        res = await streamDirectGemini(byok, model, thinking, action, contextText, priorHistory, userMessage || visibleUser, wireAttachments, onDelta);
      } else if (typeof window.StudyCommunity?.aiStream === 'function') {
        res = await window.StudyCommunity.aiStream('/tutor', {
          action,
          message: userMessage || visibleUser,
          context: contextText,
          history: priorHistory,
          thinking,
          model,
          attachments: wireAttachments,
        }, onDelta);
      } else {
        res = await window.StudyCommunity.aiRequest('/tutor', {
          action,
          message: userMessage || visibleUser,
          context: contextText,
          history: priorHistory,
          thinking,
          model,
          attachments: wireAttachments,
        });
        if (res?.reply) assistantMsg.text = res.reply;
      }

      if (res?.reply && !assistantMsg.text) assistantMsg.text = res.reply;
      if (Number.isFinite(res?.remaining)) {
        serverStatus = {
          available: true,
          provider: res.provider,
          modelLabel: res.modelLabel,
          used: res.used,
          limit: res.limit,
          remaining: res.remaining,
        };
      }
      const speedTag = thinking !== 'minimal' ? ` · ${thinkingShortLabel()}` : '';
      assistantMsg.meta = `${res?.modelLabel || 'Adamlite'}${speedTag}`;
      convo.updatedAt = Date.now();
      persistChats();
    } catch (err) {
      assistantMsg.text = `**Error:** ${err?.message || 'Could not reach Adamlite right now.'}`;
      assistantMsg.meta = 'Error';
    } finally {
      busy = false;
      renderPane({ focusInput: true });
    }
  }

  async function refreshStatus() {
    if (!window.StudyCommunity?.enabled || !window.StudyCommunity?.isSignedIn?.()) return;
    try {
      serverStatus = await window.StudyCommunity.aiRequest('/status');
      if (isOpen && !busy) renderPane();
    } catch {}
  }

  function focusComposerIfReady() {
    const pane = document.getElementById('ai-tutor-pane');
    const input = pane?.querySelector('#ai-tutor-input');
    if (pane && !pane.hidden && input && !input.disabled && !popoverMode && shouldAutoFocusComposer()) {
      input.focus({ preventScroll: true });
      const end = input.value.length;
      try { input.setSelectionRange(end, end); } catch {}
    }
  }

  function open(opts = {}) {
    if (opts && opts.courseContext) {
      customCourseContext = opts.courseContext;
    } else if (opts && opts.courseContext === null) {
      customCourseContext = null;
    }
    const snap = currentExerciseSnapshot(false);
    if (snap.mode === 'blind') {
      toast('Adamlite is disabled during blind exams.');
      return;
    }
    const pane = ensurePane();
    const backdrop = document.getElementById('ai-tutor-backdrop');
    closeConflictingDrawers(getDockSide());
    isOpen = true;
    pane.hidden = false;
    if (backdrop) backdrop.hidden = false;
    syncBodyClasses();
    renderPane({ focusInput: true });
    requestAnimationFrame(() => focusComposerIfReady());
    if (!serverStatus) refreshStatus();
  }

  function close() {
    stopSpeech(true);
    const pane = document.getElementById('ai-tutor-pane');
    const backdrop = document.getElementById('ai-tutor-backdrop');
    isOpen = false;
    popoverMode = '';
    if (pane) pane.hidden = true;
    if (backdrop) backdrop.hidden = true;
    syncBodyClasses();
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  function syncContext() {
    const snap = currentExerciseSnapshot(false);
    if (snap.mode === 'blind' && isOpen) {
      close();
      return;
    }
    if (isOpen && !busy) renderPane();
  }

  function setCourseContext(ctx) {
    customCourseContext = ctx || null;
    if (isOpen && !busy) renderPane();
  }

  return {
    open,
    close,
    toggle,
    isOpen: () => isOpen,
    getDockSide,
    syncContext,
    setCourseContext,
  };
})();
