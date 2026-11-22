/* Adamlite — Built-in Socratic AI Tutor for Study-OS
 * Docked side-pane chat interface with persistent local conversation history
 * (switch back into any previous chat anytime) & live exercise context.
 *
 * Dual-mode engine:
 *  1) Default (zero setup): calls Study-OS Cloudflare Worker (/ai/tutor) powered by
 *     Gemini (Hydrogen / 3.8 Flash / 3.5 Flash-Lite) or Cloudflare Workers AI.
 *  2) Personal Free Gemini Key (BYOK): optional key saved ONLY in this browser's
 *     localStorage, calling Google Gemini Developer API directly from the browser.
 */
'use strict';

window.StudyAiTutor = (() => {
  const { esc, toast, renderMarkdownWithMath } = window.StudyUI;
  const BYOK_KEY = 'study-os-ai-byok-key-v1';
  const BYOK_MODEL_KEY = 'study-os-ai-byok-model-v1';
  const SIDE_KEY = 'study-os-ai-side-v1';
  const WIDTH_KEY = 'study-os-ai-width-v1';
  const CHATS_KEY = 'study-os-adamlite-chats-v1';
  const MAX_STORED_CHATS = 40;
  const MAX_MSGS_PER_CHAT = 60;
  const AVATAR_SRC = './pwa/adamlite-avatar.svg';

  const BYOK_MODELS = [
    { id: 'auto', label: 'Auto (Hydrogen → Flash → Lite)' },
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  ];

  const BYOK_AUTO_CHAIN = [
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  ];

  const AI_PANE_MIN_W = 200;
  const AI_PANE_MAX_W = 580;
  const AI_DOCK_MIN_VP = 760;

  let conversations = loadStoredChats(); // [{ id, key, title, course, ctxLabel, updatedAt, messages }]
  let activeConvoId = '';
  let activeKey = 'general';
  let customCourseContext = null;
  let isOpen = false;
  let busy = false;
  let serverStatus = null;
  let configOpen = false;
  let historyOpen = false;
  let draftByKey = new Map();

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
            .map((m) => ({ role: m.role, text: m.text, meta: String(m.meta || '') })),
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
        .map((c) => ({ ...c, messages: c.messages.slice(-MAX_MSGS_PER_CHAT) }));
      localStorage.setItem(CHATS_KEY, JSON.stringify(nonEmpty));
    } catch {}
  }

  function makeConvoId() {
    return `adm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function findConvoById(id) {
    return conversations.find((c) => c.id === id) || null;
  }

  function ensureActiveConvo(key, snap) {
    let cur = findConvoById(activeConvoId);
    if (cur) return cur;
    // Try resuming latest saved chat for this exact exercise key
    const matching = conversations
      .filter((c) => c.key === key && c.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (matching) {
      activeConvoId = matching.id;
      return matching;
    }
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
    const fresh = {
      id: makeConvoId(),
      key,
      title: hasQuestion && snap.title ? String(snap.title).slice(0, 80) : 'New chat',
      course: hasQuestion ? String(snap.course || '') : '',
      ctxLabel: shortContextTag(snap || { mode: 'waiting' }),
      updatedAt: Date.now(),
      messages: [],
    };
    // Remove any unused empty scratch chats before adding fresh one
    conversations = conversations.filter((c) => c.messages.length > 0);
    conversations.unshift(fresh);
    activeConvoId = fresh.id;
    draftByKey.set(key, '');
    historyOpen = false;
    return fresh;
  }

  function deleteChat(id) {
    conversations = conversations.filter((c) => c.id !== id);
    if (activeConvoId === id) activeConvoId = '';
    persistChats();
  }

  function relativeTime(ts) {
    const diffSec = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
    if (diffSec < 45) return 'Just now';
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
    if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d ago`;
    try {
      return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    } catch {
      return '';
    }
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
  function getByokModel() {
    try {
      const v = localStorage.getItem(BYOK_MODEL_KEY) || 'auto';
      return BYOK_MODELS.some((m) => m.id === v) ? v : 'auto';
    } catch { return 'auto'; }
  }
  function setByokModel(val) {
    try { localStorage.setItem(BYOK_MODEL_KEY, val); } catch {}
  }
  function getDockSide() {
    try { return localStorage.getItem(SIDE_KEY) === 'left' ? 'left' : 'right'; } catch { return 'right'; }
  }
  function setDockSide(side) {
    const clean = side === 'left' ? 'left' : 'right';
    try { localStorage.setItem(SIDE_KEY, clean); } catch {}
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

  function sanitizeRenderedHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const forbidden = tpl.content.querySelectorAll('script, iframe, object, embed, style, link, meta, form, input, button, textarea');
    forbidden.forEach((node) => node.remove());
    tpl.content.querySelectorAll('svg').forEach((svg) => {
      if (!svg.closest('.katex')) svg.remove();
    });
    tpl.content.querySelectorAll('*').forEach((el) => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const val = String(attr.value || '').trim().toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc') {
          el.removeAttribute(attr.name);
        } else if ((name === 'href' || name === 'src') && (val.startsWith('javascript:') || val.startsWith('data:'))) {
          el.removeAttribute(attr.name);
        }
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

  function buildSystemInstruction(action) {
    const formatting = [
      'You are Adamlite, Study-OS\'s Socratic study tutor for university students (Finance, Economics, Mathematics, Data Science).',
      'Formatting rules:',
      '- Write clear, concise Markdown. Use $...$ for inline math and $$...$$ for display equations.',
      '- Never output raw HTML or scripts. Keep answers scannable with short paragraphs or numbered steps.',
      '- Match the student\'s language if they write in Norwegian or another language; otherwise reply in crisp English.',
    ];
    const modeRule = {
      hint: 'MODE: SMALL HINT. Give ONE focused next-step hint to unstick the student. Do NOT reveal the final numerical or multiple-choice answer. Keep it to 3-6 lines.',
      check: 'MODE: CHECK WORKING. Inspect the student\'s current answers/working. If blank, suggest the exact first setup step. If incorrect, pinpoint the specific mistake without spoiling the final answer. If right, confirm cleanly.',
      concept: 'MODE: KEY CONCEPT & FORMULA. Explain the core intuition, formula(s), and variable meanings in exam-ready form without giving away the specific final answer.',
      solution: 'MODE: WORKED SOLUTION. Walk through the complete solution clearly step-by-step with LaTeX math, explain why each step follows, and note any common exam pitfall.',
      chat: 'MODE: FOLLOW-UP TUTORING. Answer directly and clearly. Stay Socratic unless the student explicitly asks for the full worked solution.',
    }[action] || '';
    return [...formatting, modeRule].join('\n');
  }

  function defaultActionPrompt(action) {
    return {
      hint: 'Give me one focused next-step hint for this question without spoiling the final answer.',
      check: 'Check my current answer and working on this question. Point out where I went right or where my mistake is.',
      concept: 'Explain the key concept and formula I should use to solve this type of question.',
      solution: 'Walk me through the complete step-by-step solution to this question.',
      chat: 'Help me understand this question.',
    }[action] || 'Help me with this question.';
  }

  async function callDirectGemini(apiKey, preferredModel, action, contextBlock, history, userPrompt) {
    const models = preferredModel === 'auto'
      ? BYOK_AUTO_CHAIN
      : [
          BYOK_MODELS.find((m) => m.id === preferredModel) || BYOK_AUTO_CHAIN[0],
          ...BYOK_AUTO_CHAIN.filter((m) => m.id !== preferredModel),
        ];

    const systemInstruction = buildSystemInstruction(action);
    const prefix = contextBlock ? `CURRENT EXERCISE CONTEXT:\n${contextBlock}\n\n---\n\n` : '';
    const contents = [];
    let attached = false;
    for (const turn of history.slice(-10)) {
      const role = turn.role === 'assistant' ? 'model' : 'user';
      const text = !attached && role === 'user' ? (attached = true, `${prefix}${turn.text}`) : turn.text;
      contents.push({ role, parts: [{ text }] });
    }
    contents.push({
      role: 'user',
      parts: [{ text: attached ? userPrompt : `${prefix}${userPrompt}` }],
    });

    let lastErr = 'Gemini API request failed.';
    for (const model of models) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents,
              generationConfig: { temperature: 0.35, maxOutputTokens: 2048 },
            }),
          }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          lastErr = body?.error?.message || `Gemini HTTP ${res.status}`;
          if (res.status === 404 || res.status === 429 || res.status === 503 || res.status === 400) continue;
          break;
        }
        const payload = await res.json();
        const parts = payload?.candidates?.[0]?.content?.parts || [];
        const replyText = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
        if (replyText) {
          return { reply: replyText, provider: 'byok', modelLabel: `${model.label} · Your Key` };
        }
        lastErr = 'Empty response from Gemini.';
      } catch (err) {
        lastErr = err?.message || 'Could not reach Google Gemini API.';
      }
    }
    throw new Error(lastErr);
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

  function syncBodyClasses() {
    const side = getDockSide();
    document.body.classList.toggle('ai-pane-open', isOpen);
    document.body.classList.toggle('ai-pane-left', isOpen && side === 'left');
    document.body.classList.toggle('ai-pane-right', isOpen && side !== 'left');
    document.getElementById('run-al-btn')?.setAttribute('aria-expanded', String(isOpen));
    document.getElementById('hdr-al-btn')?.setAttribute('aria-expanded', String(isOpen));
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
    pane.className = 'ai-tutor-pane';
    pane.hidden = true;
    pane.setAttribute('role', 'complementary');
    pane.setAttribute('aria-label', 'Adamlite');
    pane.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        if (configOpen) {
          configOpen = false;
          renderPane({ focusInput: true });
        } else if (historyOpen) {
          historyOpen = false;
          renderPane({ focusInput: true });
        } else {
          close();
        }
      }
    });
    document.body.appendChild(pane);
    return pane;
  }

  function compactModelLabel() {
    const byok = getByokKey();
    if (byok) {
      const m = BYOK_MODELS.find((x) => x.id === getByokModel());
      return m && m.id !== 'auto' ? `${m.label} (Key)` : 'Gemini Auto (Key)';
    }
    if (serverStatus?.available) {
      return serverStatus.modelLabel || 'Adamlite';
    }
    if (window.StudyCommunity?.isSignedIn?.()) return 'Gemini 4 Hydrogen';
    return 'Connect Adamlite';
  }

  function quotaSuffix() {
    if (getByokKey()) return 'Your free key';
    if (serverStatus?.available && Number.isFinite(serverStatus.remaining)) {
      return `${serverStatus.remaining}/${serverStatus.limit} left today`;
    }
    return '';
  }

  function shortContextTag(snap) {
    if (snap?.mode !== 'practice') return '';
    const raw = String(snap.title || snap.questionId || '').trim();
    if (!raw) return String(snap.course || '').trim();
    return raw.length > 34 ? `${raw.slice(0, 33)}…` : raw;
  }

  function bindResizeHandle(pane) {
    const handle = pane.querySelector('#ai-pane-resize');
    if (!handle) return;
    handle.addEventListener('pointerdown', (startEv) => {
      if (window.innerWidth < AI_DOCK_MIN_VP) return;
      startEv.preventDefault();
      handle.setPointerCapture?.(startEv.pointerId);
      document.body.classList.add('ai-pane-resizing');
      const side = getDockSide();
      const railW = window.innerWidth >= 900 ? 42 : 0;
      const onMove = (ev) => {
        const rawW = side === 'left' ? ev.clientX - railW : window.innerWidth - ev.clientX;
        const maxW = Math.min(AI_PANE_MAX_W, Math.round(window.innerWidth * 0.65));
        const clamped = Math.max(AI_PANE_MIN_W, Math.min(maxW, rawW));
        applyPaneWidth(clamped);
      };
      const onUp = () => {
        document.body.classList.remove('ai-pane-resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  function autoSizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, Math.max(24, el.scrollHeight))}px`;
  }

  function shouldAutoFocusComposer() {
    return window.innerWidth >= AI_DOCK_MIN_VP
      || Boolean(window.matchMedia?.('(pointer: fine)')?.matches);
  }

  function focusComposerIfReady() {
    if (!isOpen || configOpen || historyOpen || !shouldAutoFocusComposer()) return;
    const inputEl = document.getElementById('ai-tutor-input');
    if (!inputEl || inputEl.disabled) return;
    if (document.activeElement !== inputEl) {
      inputEl.focus({ preventScroll: true });
      const end = inputEl.value.length;
      try { inputEl.setSelectionRange(end, end); } catch {}
    }
  }

  function renderHistoryPanelHtml() {
    const saved = conversations
      .filter((c) => c.messages && c.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    if (!saved.length) {
      return `
        <div class="ai-history-panel">
          <div class="ai-history-head">
            <strong>Previous chats</strong>
            <button type="button" class="mini-tool-btn" id="ai-history-close">Back</button>
          </div>
          <p class="muted ai-history-empty">No saved conversations yet. Your chats with Adamlite are saved automatically in this browser.</p>
        </div>`;
    }

    return `
      <div class="ai-history-panel">
        <div class="ai-history-head">
          <strong>Previous chats (${saved.length})</strong>
          <div class="row-actions" style="gap:6px">
            <button type="button" class="mini-tool-btn" id="ai-history-new">+ New</button>
            <button type="button" class="mini-tool-btn" id="ai-history-close">Back</button>
          </div>
        </div>
        <div class="ai-history-list" role="list">
          ${saved.map((c) => {
            const isCur = c.id === activeConvoId;
            const turns = Math.ceil(c.messages.length / 2);
            const subtitle = [c.course || c.ctxLabel, `${turns} turn${turns === 1 ? '' : 's'}`, relativeTime(c.updatedAt)].filter(Boolean).join(' · ');
            return `
              <div class="ai-history-item ${isCur ? 'is-active' : ''}" role="listitem">
                <button type="button" class="ai-history-open" data-open-chat-id="${esc(c.id)}">
                  <span class="ai-history-title">${esc(c.title || 'Untitled chat')}</span>
                  <small class="muted">${esc(subtitle)}</small>
                </button>
                <button type="button" class="ai-history-del" data-del-chat-id="${esc(c.id)}" title="Delete chat" aria-label="Delete chat">×</button>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function renderPane(opts = {}) {
    const pane = ensurePane();
    const prevInput = pane.querySelector('#ai-tutor-input');
    const hadFocus = Boolean(prevInput && document.activeElement === prevInput);
    const prevSelStart = hadFocus ? prevInput.selectionStart : null;
    const prevSelEnd = hadFocus ? prevInput.selectionEnd : null;
    if (prevInput) draftByKey.set(activeKey, prevInput.value);

    const snap = currentExerciseSnapshot(false);
    const hasQuestion = snap.mode === 'practice';
    const nextKey = hasQuestion ? `${snap.courseId}:${snap.questionId}` : 'general';
    if (opts.followContext && nextKey !== activeKey) {
      activeKey = nextKey;
      // Only auto-switch convo when navigating questions if current chat is empty or tied to another question
      const cur = findConvoById(activeConvoId);
      if (!cur || cur.key !== nextKey) {
        activeConvoId = '';
      }
    } else if (!activeKey) {
      activeKey = nextKey;
    }

    const convo = ensureActiveConvo(activeKey, snap);
    const messages = convo.messages;
    const savedCount = conversations.filter((c) => c.messages.length > 0).length;
    const byok = getByokKey();
    const signedIn = Boolean(window.StudyCommunity?.isSignedIn?.());
    const canAsk = Boolean(byok || signedIn);
    const side = getDockSide();
    const ctxTag = shortContextTag(snap) || convo.ctxLabel || '';
    const ctxFull = hasQuestion
      ? `${snap.course || 'Practice'} · ${snap.title || 'Current question'}`
      : convo.title || 'General study chat';
    const draft = draftByKey.get(activeKey) || '';

    const messagesHtml = messages.length
      ? messages.map((m, idx) => {
          if (m.role === 'user') {
            return `
              <div class="ai-turn ai-turn-user">
                <div class="ai-user-bubble">${esc(m.text).replace(/\n/g, '<br>')}</div>
              </div>`;
          }
          return `
            <div class="ai-turn ai-turn-assistant">
              <div class="ai-assistant-byline">
                <img class="adamlite-avatar-xs" src="${AVATAR_SRC}" alt="" aria-hidden="true">
                <span>Adamlite</span>
              </div>
              <div class="ai-assistant-prose">${renderSafeMd(m.text)}</div>
              <div class="ai-turn-actions">
                <button type="button" class="ai-icon-micro" data-copy-msg="${idx}" title="Copy response" aria-label="Copy response">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  <span>Copy</span>
                </button>
                ${m.meta ? `<span class="ai-turn-model">${esc(m.meta)}</span>` : ''}
              </div>
            </div>`;
        }).join('')
      : `<div class="ai-empty-canvas">
           <div class="ai-empty-mark adamlite-hero-mark" aria-hidden="true">
             <img src="${AVATAR_SRC}" alt="Adamlite" class="adamlite-avatar-lg">
           </div>
           <h3>${snap.mode === 'blind' ? 'Adamlite paused for blind exam' : 'How can Adamlite help?'}</h3>
           <p class="muted">${
             snap.mode === 'blind'
               ? 'Adamlite turns off automatically during blind timed exams.'
               : hasQuestion
                 ? 'Ask about any step, formula, or mistake — I can see this question and your current working.'
                 : 'Ask any study question, or open a practice problem for live context.'
           }</p>
         </div>`;

    const configPopoverHtml = configOpen ? `
      <div class="ai-settings-popover" role="dialog" aria-label="Adamlite model and key settings">
        <div class="ai-pop-head">
          <strong>Adamlite Engine &amp; Gemini Key</strong>
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Get free key ↗</a>
        </div>
        ${quotaSuffix() ? `<p class="ai-pop-quota">${esc(quotaSuffix())}</p>` : ''}
        <p class="ai-pop-desc">
          Optionally use your own Gemini API key from Google (<b>Gemini 4 Hydrogen</b>, <b>3.8 Flash</b>, <b>3.5 Flash-Lite</b>). Stored only in this browser.
        </p>
        <div class="ai-byok-fields">
          <input type="password" id="ai-byok-input" value="${esc(byok)}" placeholder="AIzaSy…" autocomplete="off" spellcheck="false" aria-label="Personal Gemini API key">
          <select id="ai-byok-model" aria-label="Preferred Gemini model">
            ${BYOK_MODELS.map((m) => `<option value="${esc(m.id)}" ${getByokModel() === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </div>
        <div class="ai-pop-actions">
          <div class="ai-pop-actions-left">
            <button type="button" class="primary-btn ai-pop-btn" id="ai-byok-save">Save</button>
            ${byok ? '<button type="button" class="ghost-btn ai-pop-btn" id="ai-byok-clear">Remove</button>' : ''}
          </div>
          <button type="button" class="ai-text-link" id="ai-open-mcp">Desktop MCP ↗</button>
        </div>
      </div>
    ` : '';

    const dockIconSvg = side === 'left'
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="15" y1="4" x2="15" y2="20"></line></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="9" y1="4" x2="9" y2="20"></line></svg>';

    pane.innerHTML = `
      <div class="ai-pane-resize-handle" id="ai-pane-resize" title="Drag to resize"></div>
      <div class="ai-mobile-grabber" aria-hidden="true"><span></span></div>

      <header class="ai-pane-head">
        <div class="ai-pane-head-left">
          <img class="adamlite-avatar-sm" src="${AVATAR_SRC}" alt="" aria-hidden="true">
          <span class="ai-pane-title">Adamlite</span>
          ${ctxTag ? `<span class="ai-pane-ctx-chip" title="${esc(ctxFull)}">${esc(ctxTag)}</span>` : ''}
        </div>
        <div class="ai-pane-head-actions">
          <button type="button" class="ai-head-icon-btn ${historyOpen ? 'active' : ''}" id="ai-tutor-history" title="Previous chats (${savedCount})" aria-label="Previous chats" aria-pressed="${historyOpen}">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"></polyline></svg>
          </button>
          <button type="button" class="ai-head-icon-btn" id="ai-tutor-clear" title="New chat" aria-label="New chat">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
          </button>
          <button type="button" class="ai-head-icon-btn ai-dock-flip-btn" id="ai-dock-flip" title="${side === 'left' ? 'Dock to right side' : 'Dock to left side'}" aria-label="${side === 'left' ? 'Dock to right side' : 'Dock to left side'}">
            ${dockIconSvg}
          </button>
          <button type="button" class="ai-head-icon-btn" id="ai-tutor-close" title="Close (Esc)" aria-label="Close Adamlite">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </header>

      <div class="ai-thread" id="ai-tutor-thread">
        ${historyOpen ? renderHistoryPanelHtml() : `${messagesHtml}${busy ? '<div class="ai-turn ai-turn-assistant"><div class="ai-typing" aria-label="Thinking"><span></span><span></span><span></span></div></div>' : ''}`}
      </div>

      <div class="ai-composer-zone">
        ${configPopoverHtml}

        ${!canAsk && snap.mode !== 'blind' ? `
          <div class="ai-signin-bar">
            <span>Sign in for free Adamlite tutoring or add your own Gemini key.</span>
            <div class="ai-signin-bar-btns">
              ${window.StudyCommunity?.enabled ? '<button type="button" class="primary-btn ai-pop-btn" id="ai-tutor-signin">Sign in</button>' : ''}
              <button type="button" class="ghost-btn ai-pop-btn" id="ai-tutor-open-byok">Gemini key</button>
            </div>
          </div>
        ` : ''}

        <form class="ai-composer-card" id="ai-tutor-form">
          <textarea
            id="ai-tutor-input"
            rows="1"
            placeholder="${snap.mode === 'blind' ? 'Unavailable during blind exam…' : 'Ask Adamlite…'}"
            ${busy || !canAsk || snap.mode === 'blind' ? 'disabled' : ''}
          >${esc(draft)}</textarea>
          <div class="ai-composer-bar">
            <button type="button" class="ai-model-trigger ${configOpen ? 'active' : ''}" id="ai-engine-toggle" title="Choose model or personal Gemini API key">
              <span>${esc(compactModelLabel())}</span>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <button
              type="submit"
              class="ai-send-circle"
              id="ai-send-btn"
              ${busy || !canAsk || snap.mode === 'blind' || !draft.trim() ? 'disabled' : ''}
              aria-label="Send message"
              title="Send (Enter)"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
            </button>
          </div>
        </form>
      </div>
    `;

    bindResizeHandle(pane);

    const threadEl = pane.querySelector('#ai-tutor-thread');
    if (threadEl && !historyOpen) threadEl.scrollTop = threadEl.scrollHeight;

    pane.querySelector('#ai-tutor-close')?.addEventListener('click', () => close());
    pane.querySelector('#ai-dock-flip')?.addEventListener('click', () => {
      setDockSide(getDockSide() === 'left' ? 'right' : 'left');
      renderPane({ focusInput: true });
    });
    pane.querySelector('#ai-tutor-history')?.addEventListener('click', () => {
      historyOpen = !historyOpen;
      configOpen = false;
      renderPane({ focusInput: !historyOpen });
    });
    pane.querySelector('#ai-history-close')?.addEventListener('click', () => {
      historyOpen = false;
      renderPane({ focusInput: true });
    });
    pane.querySelector('#ai-history-new')?.addEventListener('click', () => {
      startNewChat(snap);
      renderPane({ focusInput: true });
    });
    pane.querySelectorAll('[data-open-chat-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const picked = findConvoById(btn.dataset.openChatId);
        if (!picked) return;
        activeConvoId = picked.id;
        activeKey = picked.key || 'general';
        historyOpen = false;
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
    pane.querySelector('#ai-tutor-clear')?.addEventListener('click', () => {
      startNewChat(snap);
      renderPane({ focusInput: true });
    });
    pane.querySelector('#ai-engine-toggle')?.addEventListener('click', () => {
      configOpen = !configOpen;
      renderPane({ focusInput: !configOpen });
    });
    pane.querySelector('#ai-tutor-open-byok')?.addEventListener('click', () => {
      configOpen = true;
      renderPane();
    });
    pane.querySelector('#ai-open-mcp')?.addEventListener('click', () => {
      configOpen = false;
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
      const mod = pane.querySelector('#ai-byok-model')?.value || 'auto';
      setByokKey(val);
      setByokModel(mod);
      configOpen = false;
      toast(val ? 'Personal Gemini key saved on this device.' : 'Switched back to Adamlite.');
      renderPane({ focusInput: true });
    });
    pane.querySelector('#ai-byok-clear')?.addEventListener('click', () => {
      setByokKey('');
      configOpen = false;
      toast('Removed personal Gemini key.');
      renderPane({ focusInput: true });
    });

    pane.querySelectorAll('[data-copy-msg]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.copyMsg);
        const msg = messages[idx];
        if (!msg?.text) return;
        try {
          await navigator.clipboard.writeText(msg.text);
          const span = btn.querySelector('span');
          if (span) {
            span.textContent = 'Copied';
            setTimeout(() => { span.textContent = 'Copy'; }, 1400);
          }
        } catch {
          toast('Could not copy response.');
        }
      });
    });

    const inputEl = pane.querySelector('#ai-tutor-input');
    const sendBtn = pane.querySelector('#ai-send-btn');
    const formEl = pane.querySelector('#ai-tutor-form');
    if (inputEl) {
      autoSizeTextarea(inputEl);
      inputEl.addEventListener('input', () => {
        draftByKey.set(activeKey, inputEl.value);
        autoSizeTextarea(inputEl);
        if (sendBtn) sendBtn.disabled = busy || !canAsk || snap.mode === 'blind' || !inputEl.value.trim();
      });
      inputEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          if (inputEl.value.trim()) formEl?.requestSubmit();
        }
      });
      if (!inputEl.disabled && !configOpen && !historyOpen && (hadFocus || (opts.focusInput && shouldAutoFocusComposer()))) {
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
      if (!text || busy) return;
      draftByKey.set(activeKey, '');
      inputEl.value = '';
      autoSizeTextarea(inputEl);
      sendTurn('chat', text, text);
    });
  }

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

    historyOpen = false;
    const convo = ensureActiveConvo(activeKey, snap);
    const thread = convo.messages;
    const priorHistory = thread.slice(-10).map((m) => ({ role: m.role, text: m.text }));
    const visibleUser = displayBubble || userMessage || defaultActionPrompt(action);
    if (thread.length === 0) {
      convo.title = (snap.mode === 'practice' && snap.title)
        ? `${snap.title}: ${visibleUser}`.slice(0, 84)
        : visibleUser.slice(0, 84);
      convo.course = snap.mode === 'practice' ? String(snap.course || '') : convo.course;
      convo.ctxLabel = shortContextTag(snap) || convo.ctxLabel;
    }
    thread.push({ role: 'user', text: visibleUser });
    convo.updatedAt = Date.now();
    persistChats();

    configOpen = false;
    busy = true;
    renderPane();

    try {
      const prompt = userMessage || defaultActionPrompt(action);
      const contextText = snap.mode === 'practice' ? (snap.context || '') : '';
      let res;
      if (byok) {
        res = await callDirectGemini(byok, getByokModel(), action, contextText, priorHistory, prompt);
      } else {
        res = await window.StudyCommunity.aiRequest('/tutor', {
          action,
          message: userMessage,
          context: contextText,
          history: priorHistory,
          course: snap.course || '',
          title: snap.title || '',
        });
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
      }
      thread.push({ role: 'assistant', text: res.reply, meta: res.modelLabel || '' });
      convo.updatedAt = Date.now();
      persistChats();
    } catch (err) {
      const message = err?.message
        ?.replaceAll('AI Tutor', 'Adamlite')
        .replaceAll('Al Tutor', 'Adamlite')
        .replaceAll('Copy for AI', 'Copy for Adamlite');
      thread.push({
        role: 'assistant',
        text: `Could not get a reply: ${message || 'Try again in a moment.'}`,
        meta: 'Error',
      });
      convo.updatedAt = Date.now();
      persistChats();
    } finally {
      busy = false;
      renderPane({ focusInput: true });
    }
  }

  async function refreshStatus() {
    if (!window.StudyCommunity?.isSignedIn?.() || !window.StudyCommunity?.aiRequest) return;
    try {
      serverStatus = await window.StudyCommunity.aiRequest('/status');
      if (!isOpen) return;
      const pane = document.getElementById('ai-tutor-pane');
      const labelSpan = pane?.querySelector('#ai-engine-toggle span');
      if (labelSpan) labelSpan.textContent = compactModelLabel();
      if (configOpen) {
        const quotaEl = pane?.querySelector('.ai-pop-quota');
        const text = quotaSuffix();
        if (quotaEl && text) {
          quotaEl.textContent = text;
        } else if (pane?.querySelector('#ai-byok-input') !== document.activeElement) {
          renderPane();
        }
      }
    } catch {}
  }

  function showPane() {
    const pane = ensurePane();
    const backdrop = document.getElementById('ai-tutor-backdrop');
    isOpen = true;
    pane.hidden = false;
    if (backdrop) backdrop.hidden = false;
    syncBodyClasses();
    renderPane({ focusInput: true, followContext: true });
    requestAnimationFrame(() => focusComposerIfReady());
    refreshStatus();
  }

  function close() {
    const pane = document.getElementById('ai-tutor-pane');
    const backdrop = document.getElementById('ai-tutor-backdrop');
    isOpen = false;
    configOpen = false;
    historyOpen = false;
    if (pane) pane.hidden = true;
    if (backdrop) backdrop.hidden = true;
    syncBodyClasses();
  }

  function open(initialAction = '') {
    customCourseContext = null;
    showPane();
    if (initialAction && !busy) {
      sendTurn(initialAction, '', defaultActionPrompt(initialAction));
    }
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  function openForCourse(course) {
    if (!course) return open();
    const topics = Array.isArray(course.topics) && course.topics.length
      ? `\n\nCourse modules / syllabus topics:\n${course.topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
      : '';
    customCourseContext = {
      mode: 'practice',
      courseId: course.id || course.code || 'community',
      questionId: 'course-overview',
      course: course.code || 'Community Course',
      title: course.title || 'Course study',
      context: `Course: ${course.code ? course.code + ' · ' : ''}${course.title || ''}${topics}\n\nThe student wants to study concepts, build practice drills, or review topics from this course.`,
    };
    showPane();
  }

  function syncContext() {
    if (!isOpen) return;
    const snap = currentExerciseSnapshot(false);
    if (snap.mode === 'practice') customCourseContext = null;
    syncBodyClasses();
    renderPane({ followContext: true });
  }

  return {
    open,
    close,
    toggle,
    openForCourse,
    syncContext,
    refreshStatus,
    listChats: () => conversations.filter((c) => c.messages.length > 0),
    isOpen: () => isOpen,
  };
})();
