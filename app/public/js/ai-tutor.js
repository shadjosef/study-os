/* Built-in Socratic AI Tutor for Study-OS
 * Docked side-pane chat interface (Claude / ChatGPT / Gemini style) that adapts
 * the workspace layout side-by-side so you can read the question and chat live.
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

  const threadsByQuestion = new Map(); // key -> [{ role, text, meta? }]
  let activeKey = 'general';
  let customCourseContext = null;
  let isOpen = false;
  let busy = false;
  let serverStatus = null;
  let configOpen = false;
  let draftByKey = new Map();

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
      if (Number.isFinite(n) && n >= 310 && n <= 560) return Math.round(n);
    } catch {}
    return null;
  }
  function applyPaneWidth(px) {
    if (Number.isFinite(px) && px >= 310 && px <= 560) {
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
      'You are the Study-OS Socratic Tutor for university students (Finance, Economics, Mathematics, Data Science).',
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
    for (const turn of history.slice(-8)) {
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

  function threadFor(key) {
    if (!threadsByQuestion.has(key)) threadsByQuestion.set(key, []);
    return threadsByQuestion.get(key);
  }

  function syncBodyClasses() {
    const side = getDockSide();
    document.body.classList.toggle('ai-pane-open', isOpen);
    document.body.classList.toggle('ai-pane-left', isOpen && side === 'left');
    document.body.classList.toggle('ai-pane-right', isOpen && side !== 'left');
    const pill = document.getElementById('btn-ai-tutor-pill');
    if (pill) {
      pill.classList.toggle('active', isOpen);
      pill.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
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
    pane.setAttribute('aria-label', 'AI Tutor');
    pane.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        if (configOpen) {
          configOpen = false;
          renderPane();
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
      return serverStatus.modelLabel || 'Study-OS AI';
    }
    if (window.StudyCommunity?.isSignedIn?.()) return 'Gemini 4 Hydrogen';
    return 'Connect AI';
  }

  function quotaSuffix() {
    if (getByokKey()) return 'Your free key';
    if (serverStatus?.available && Number.isFinite(serverStatus.remaining)) {
      return `${serverStatus.remaining}/${serverStatus.limit} left today`;
    }
    return '';
  }

  function shortContextTag(snap) {
    if (snap.mode !== 'practice') return '';
    const raw = String(snap.title || snap.questionId || '').trim();
    if (!raw) return String(snap.course || '').trim();
    return raw.length > 34 ? `${raw.slice(0, 33)}…` : raw;
  }

  function bindResizeHandle(pane) {
    const handle = pane.querySelector('#ai-pane-resize');
    if (!handle) return;
    handle.addEventListener('pointerdown', (startEv) => {
      if (window.innerWidth < 960) return;
      startEv.preventDefault();
      handle.setPointerCapture?.(startEv.pointerId);
      document.body.classList.add('ai-pane-resizing');
      const side = getDockSide();
      const onMove = (ev) => {
        const nextW = side === 'left' ? ev.clientX : window.innerWidth - ev.clientX;
        const clamped = Math.max(310, Math.min(540, nextW));
        applyPaneWidth(clamped);
      };
      const onUp = () => {
        document.body.classList.remove('ai-pane-resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function autoSizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, Math.max(24, el.scrollHeight))}px`;
  }

  function renderPane(opts = {}) {
    const pane = ensurePane();
    const prevInput = pane.querySelector('#ai-tutor-input');
    if (prevInput) draftByKey.set(activeKey, prevInput.value);

    const snap = currentExerciseSnapshot(false);
    const hasQuestion = snap.mode === 'practice';
    const nextKey = hasQuestion ? `${snap.courseId}:${snap.questionId}` : 'general';
    activeKey = nextKey;

    const messages = threadFor(activeKey);
    const byok = getByokKey();
    const signedIn = Boolean(window.StudyCommunity?.isSignedIn?.());
    const canAsk = Boolean(byok || signedIn);
    const side = getDockSide();
    const ctxTag = shortContextTag(snap);
    const ctxFull = hasQuestion
      ? `${snap.course || 'Practice'} · ${snap.title || 'Current question'}`
      : '';
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
           <div class="ai-empty-mark" aria-hidden="true">
             <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
               <path d="M12 3l1.9 5.3L19 10l-5.1 1.7L12 17l-1.9-5.3L5 10l5.1-1.7L12 3z"></path>
               <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"></path>
             </svg>
           </div>
           <h3>${snap.mode === 'blind' ? 'Paused for blind exam' : 'How can I help?'}</h3>
           <p class="muted">${
             snap.mode === 'blind'
               ? 'AI Tutor turns off automatically during blind timed exams.'
               : hasQuestion
                 ? 'Ask about any step, formula, or mistake — I can see this question and your current working.'
                 : 'Ask any study question, or open a practice problem for live context.'
           }</p>
         </div>`;

    const configPopoverHtml = configOpen ? `
      <div class="ai-settings-popover" role="dialog" aria-label="AI model and key settings">
        <div class="ai-pop-head">
          <strong>AI Engine &amp; Gemini Key</strong>
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Get free key ↗</a>
        </div>
        ${quotaSuffix() ? `<p class="ai-pop-quota">${esc(quotaSuffix())}</p>` : ''}
        <p class="ai-pop-desc">
          Optionally use your own free Google AI Studio key (<b>Gemini 4 Hydrogen</b>, <b>3.8 Flash</b>, <b>3.5 Flash-Lite</b>). Stored only in this browser.
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
          <span class="ai-pane-title">Tutor</span>
          ${ctxTag ? `<span class="ai-pane-ctx-chip" title="${esc(ctxFull)}">${esc(ctxTag)}</span>` : ''}
        </div>
        <div class="ai-pane-head-actions">
          ${messages.length ? `
            <button type="button" class="ai-head-icon-btn" id="ai-tutor-clear" title="New chat" aria-label="New chat">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
            </button>` : ''}
          <button type="button" class="ai-head-icon-btn ai-dock-flip-btn" id="ai-dock-flip" title="${side === 'left' ? 'Dock to right side' : 'Dock to left side'}" aria-label="${side === 'left' ? 'Dock to right side' : 'Dock to left side'}">
            ${dockIconSvg}
          </button>
          <button type="button" class="ai-head-icon-btn" id="ai-tutor-close" title="Close (Esc)" aria-label="Close AI Tutor">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </header>

      <div class="ai-thread" id="ai-tutor-thread">
        ${messagesHtml}
        ${busy ? '<div class="ai-turn ai-turn-assistant"><div class="ai-typing" aria-label="Thinking"><span></span><span></span><span></span></div></div>' : ''}
      </div>

      <div class="ai-composer-zone">
        ${configPopoverHtml}

        ${!canAsk && snap.mode !== 'blind' ? `
          <div class="ai-signin-bar">
            <span>Sign in for free AI tutoring or add your own Gemini key.</span>
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
            placeholder="${snap.mode === 'blind' ? 'Unavailable during blind exam…' : 'Message Tutor…'}"
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
    if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;

    pane.querySelector('#ai-tutor-close')?.addEventListener('click', () => close());
    pane.querySelector('#ai-dock-flip')?.addEventListener('click', () => {
      setDockSide(getDockSide() === 'left' ? 'right' : 'left');
      renderPane();
    });
    pane.querySelector('#ai-tutor-clear')?.addEventListener('click', () => {
      threadsByQuestion.set(activeKey, []);
      draftByKey.set(activeKey, '');
      renderPane({ focusInput: true });
    });
    pane.querySelector('#ai-engine-toggle')?.addEventListener('click', () => {
      configOpen = !configOpen;
      renderPane();
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
      }
    });

    pane.querySelector('#ai-byok-save')?.addEventListener('click', () => {
      const val = pane.querySelector('#ai-byok-input')?.value.trim() || '';
      const mod = pane.querySelector('#ai-byok-model')?.value || 'auto';
      setByokKey(val);
      setByokModel(mod);
      configOpen = false;
      toast(val ? 'Personal Gemini key saved on this device.' : 'Switched back to Study-OS AI.');
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
      if (opts.focusInput && !inputEl.disabled && window.innerWidth >= 960) {
        inputEl.focus({ preventScroll: true });
      }
    }
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
      toast('AI Tutor is disabled during blind exams.');
      return;
    }

    const byok = getByokKey();
    const signedIn = Boolean(window.StudyCommunity?.isSignedIn?.());
    if (!byok && !signedIn) {
      toast('Sign in or add your free Gemini API key first.');
      return;
    }

    const thread = threadFor(activeKey);
    const priorHistory = thread.slice(-8).map((m) => ({ role: m.role, text: m.text }));
    const visibleUser = displayBubble || userMessage || defaultActionPrompt(action);
    thread.push({ role: 'user', text: visibleUser });
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
    } catch (err) {
      thread.push({
        role: 'assistant',
        text: `Could not get a reply: ${err?.message || 'Try again in a moment.'}`,
        meta: 'Error',
      });
    } finally {
      busy = false;
      renderPane({ focusInput: true });
    }
  }

  async function refreshStatus() {
    if (!window.StudyCommunity?.isSignedIn?.() || !window.StudyCommunity?.aiRequest) return;
    try {
      serverStatus = await window.StudyCommunity.aiRequest('/status');
      if (isOpen) renderPane();
    } catch {}
  }

  function showPane() {
    const pane = ensurePane();
    const backdrop = document.getElementById('ai-tutor-backdrop');
    isOpen = true;
    pane.hidden = false;
    if (backdrop) backdrop.hidden = false;
    syncBodyClasses();
    renderPane({ focusInput: true });
    refreshStatus();
  }

  function close() {
    const pane = document.getElementById('ai-tutor-pane');
    const backdrop = document.getElementById('ai-tutor-backdrop');
    isOpen = false;
    configOpen = false;
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
    renderPane();
  }

  return {
    open,
    close,
    toggle,
    openForCourse,
    syncContext,
    refreshStatus,
    isOpen: () => isOpen,
  };
})();
