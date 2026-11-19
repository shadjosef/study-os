/* Built-in Socratic AI Tutor for Study-OS
 * Dual-mode architecture:
 *  1) Default (zero setup): calls Study-OS Cloudflare Worker (/ai/tutor) powered by
 *     Cloudflare Workers AI (free) or shared Gemini key, with per-student daily quota.
 *  2) Personal Free Gemini Key (BYOK): optional key saved ONLY in this browser's
 *     localStorage, calling Google Gemini Developer API directly from the browser
 *     using the student's own free AI Studio quota (Gemini 4 Hydrogen / 3.8 Flash / 3.5 Flash-Lite).
 */
'use strict';

window.StudyAiTutor = (() => {
  const { esc, toast, renderMarkdownWithMath } = window.StudyUI;
  const BYOK_KEY = 'study-os-ai-byok-key-v1';
  const BYOK_MODEL_KEY = 'study-os-ai-byok-model-v1';

  const BYOK_MODELS = [
    { id: 'auto', label: 'Auto (Hydrogen → 3.8 Flash → 3.5 Lite)' },
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  ];

  const BYOK_AUTO_CHAIN = [
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  ];

  const QUICK_ACTIONS = [
    { action: 'hint', icon: '💡', label: 'Small hint' },
    { action: 'check', icon: '🔍', label: 'Check my work' },
    { action: 'concept', icon: '📐', label: 'Key formula' },
    { action: 'solution', icon: '✅', label: 'Walk through solution' },
  ];

  const threadsByQuestion = new Map(); // questionId -> [{ role, text, meta? }]
  let activeKey = 'general';
  let customCourseContext = null;
  let busy = false;
  let serverStatus = null;
  let configOpen = false;

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
          return { reply: replyText, provider: 'byok', modelLabel: `${model.label} (Your Key)` };
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

  function ensureDialog() {
    let dialog = document.getElementById('ai-tutor-sheet');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'ai-tutor-sheet';
    dialog.className = 'member-dialog ai-tutor-sheet';
    dialog.tabIndex = -1;
    dialog.setAttribute('aria-labelledby', 'ai-tutor-sheet-title');
    dialog.addEventListener('click', (ev) => {
      if (ev.target === dialog) dialog.close();
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function engineBadgeText() {
    const byok = getByokKey();
    if (byok) {
      const m = BYOK_MODELS.find((x) => x.id === getByokModel());
      return `Your Key · ${m && m.id !== 'auto' ? m.label : 'Gemini Auto'}`;
    }
    if (serverStatus?.available) {
      const rem = Number.isFinite(serverStatus.remaining) ? ` · ${serverStatus.remaining}/${serverStatus.limit} left` : '';
      return `${serverStatus.modelLabel || 'Study-OS AI'}${rem}`;
    }
    if (window.StudyCommunity?.isSignedIn?.()) return 'Study-OS Free AI';
    return 'Sign in or add your free Gemini key';
  }

  function renderSheet() {
    const dialog = ensureDialog();
    const snap = currentExerciseSnapshot(false);
    const hasQuestion = snap.mode === 'practice';
    activeKey = hasQuestion ? `${snap.courseId}:${snap.questionId}` : 'general';
    const messages = threadFor(activeKey);
    const byok = getByokKey();
    const signedIn = Boolean(window.StudyCommunity?.isSignedIn?.());
    const canAsk = Boolean(byok || signedIn);

    const subtitle = hasQuestion
      ? `${snap.course || 'Practice'} · ${snap.title || 'Current question'}`
      : snap.mode === 'blind'
        ? 'Disabled during blind timed exams'
        : 'Open any practice question for context-aware tutoring';

    const messagesHtml = messages.length
      ? messages.map((m) => `
          <div class="ai-msg ai-msg-${m.role === 'user' ? 'user' : 'assistant'}">
            <div class="ai-msg-bubble">
              ${m.role === 'user' ? `<p>${esc(m.text)}</p>` : renderSafeMd(m.text)}
            </div>
            ${m.meta ? `<span class="ai-msg-meta">${esc(m.meta)}</span>` : ''}
          </div>
        `).join('')
      : `<div class="ai-empty-state">
           <div class="ai-empty-orb" aria-hidden="true">✨</div>
           <strong>Socratic Study Tutor</strong>
           <p class="muted">${
             snap.mode === 'blind'
               ? 'AI Tutor pauses during blind exam sits so your timed exam stays authentic.'
               : hasQuestion
                 ? 'Pick a quick chip above or ask about any step — I see this question and your current working automatically.'
                 : 'Start any practice question, or ask a general concept question below.'
           }</p>
         </div>`;

    const configHtml = configOpen ? `
      <div class="ai-byok-card">
        <div class="row-between" style="margin:0 0 6px">
          <strong style="font-size:13.5px">Personal Free Gemini Key (Optional)</strong>
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="font-size:12px;font-weight:600">Get free key ↗</a>
        </div>
        <p class="muted" style="margin:0 0 10px;font-size:12px;line-height:1.45">
          Spend your own free Google AI Studio quota (<b>Gemini 4 Hydrogen</b>, <b>3.8 Flash</b>, <b>3.5 Flash-Lite</b>) with no shared daily cap. Saved <b>only on this device</b> — never sent to Study-OS servers.
        </p>
        <div class="ai-byok-fields">
          <input type="password" id="ai-byok-input" value="${esc(byok)}" placeholder="AIzaSy…" autocomplete="off" spellcheck="false" aria-label="Personal Gemini API key">
          <select id="ai-byok-model" aria-label="Preferred Gemini model">
            ${BYOK_MODELS.map((m) => `<option value="${esc(m.id)}" ${getByokModel() === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </div>
        <div class="row-actions" style="margin-top:8px">
          <button type="button" class="primary-btn" id="ai-byok-save" style="padding:6px 14px;font-size:12.5px">Save key</button>
          ${byok ? '<button type="button" class="ghost-btn" id="ai-byok-clear" style="padding:6px 12px;font-size:12.5px">Remove key</button>' : ''}
          <button type="button" class="ghost-btn" id="ai-byok-close" style="padding:6px 12px;font-size:12.5px">Hide</button>
        </div>
      </div>
    ` : '';

    dialog.innerHTML = `
      <div class="ai-tutor-head">
        <div class="ai-tutor-head-copy">
          <div class="ai-tutor-title-row">
            <h2 id="ai-tutor-sheet-title">✨ AI Tutor</h2>
            <button type="button" class="ai-engine-pill" id="ai-engine-toggle" title="Configure personal Gemini API key (Hydrogen / 3.8 Flash)">
              <span>${esc(engineBadgeText())}</span>
              <span aria-hidden="true">⚙</span>
            </button>
          </div>
          <small class="muted ai-tutor-sub">${esc(subtitle)}</small>
        </div>
        <div class="ai-tutor-head-btns">
          ${messages.length ? '<button type="button" class="ghost-btn ai-head-sm" id="ai-tutor-clear" title="Clear conversation">Clear</button>' : ''}
          <button type="button" class="ios-done-btn" id="ai-tutor-done">Done</button>
        </div>
      </div>

      ${configHtml}

      ${snap.mode !== 'blind' ? `
        <div class="ai-quick-chips" role="group" aria-label="Quick tutor actions">
          ${QUICK_ACTIONS.map((a) => `
            <button type="button" class="ai-chip-btn" data-ai-action="${a.action}" ${busy || !canAsk ? 'disabled' : ''}>
              <span>${a.icon}</span><span>${esc(a.label)}</span>
            </button>
          `).join('')}
        </div>
      ` : ''}

      <div class="ai-thread" id="ai-tutor-thread">
        ${messagesHtml}
        ${busy ? '<div class="ai-msg ai-msg-assistant"><div class="ai-msg-bubble ai-typing"><span></span><span></span><span></span></div></div>' : ''}
      </div>

      ${!canAsk && snap.mode !== 'blind' ? `
        <div class="ai-signin-callout">
          <span>Sign in for free built-in AI tutoring, or plug in your own free Google AI Studio key.</span>
          <div class="row-actions">
            ${window.StudyCommunity?.enabled ? '<button type="button" class="primary-btn" id="ai-tutor-signin" style="padding:6px 14px;font-size:12.5px">Sign in</button>' : ''}
            <button type="button" class="ghost-btn" id="ai-tutor-open-byok" style="padding:6px 12px;font-size:12.5px">Use free Gemini key</button>
          </div>
        </div>
      ` : ''}

      <form class="ai-composer" id="ai-tutor-form">
        <textarea id="ai-tutor-input" rows="1" placeholder="${snap.mode === 'blind' ? 'Unavailable during blind exam…' : 'Ask about any step, formula, or mistake…'}" ${busy || !canAsk || snap.mode === 'blind' ? 'disabled' : ''}></textarea>
        <button type="submit" class="primary-btn ai-send-btn" ${busy || !canAsk || snap.mode === 'blind' ? 'disabled' : ''} aria-label="Send message">Send</button>
      </form>

      <div class="ai-tutor-foot">
        <button type="button" class="ai-foot-link" id="ai-open-mcp">Desktop MCP / External AI</button>
        <span class="muted">·</span>
        <button type="button" class="ai-foot-link" id="ai-open-byok-foot">${byok ? 'Manage my Gemini key' : 'Use my own Gemini key (Hydrogen)'}</button>
      </div>
    `;

    const threadEl = dialog.querySelector('#ai-tutor-thread');
    if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;

    dialog.querySelector('#ai-tutor-done')?.addEventListener('click', () => dialog.close());
    dialog.querySelector('#ai-tutor-clear')?.addEventListener('click', () => {
      threadsByQuestion.set(activeKey, []);
      renderSheet();
    });
    dialog.querySelector('#ai-engine-toggle')?.addEventListener('click', () => {
      configOpen = !configOpen;
      renderSheet();
    });
    dialog.querySelector('#ai-open-byok-foot')?.addEventListener('click', () => {
      configOpen = !configOpen;
      renderSheet();
    });
    dialog.querySelector('#ai-tutor-open-byok')?.addEventListener('click', () => {
      configOpen = true;
      renderSheet();
    });
    dialog.querySelector('#ai-open-mcp')?.addEventListener('click', () => {
      dialog.close();
      window.StudyTutor?.open?.();
    });
    dialog.querySelector('#ai-tutor-signin')?.addEventListener('click', async () => {
      dialog.close();
      await window.StudyCommunity?.requireProfile?.({ allowDemo: true, forcePrompt: true });
      if (window.StudyCommunity?.isSignedIn?.()) open();
    });

    dialog.querySelector('#ai-byok-save')?.addEventListener('click', () => {
      const val = dialog.querySelector('#ai-byok-input')?.value.trim() || '';
      const mod = dialog.querySelector('#ai-byok-model')?.value || 'auto';
      setByokKey(val);
      setByokModel(mod);
      configOpen = false;
      toast(val ? 'Personal Gemini key saved on this device.' : 'Switched back to Study-OS AI.');
      renderSheet();
    });
    dialog.querySelector('#ai-byok-clear')?.addEventListener('click', () => {
      setByokKey('');
      configOpen = false;
      toast('Removed personal Gemini key.');
      renderSheet();
    });
    dialog.querySelector('#ai-byok-close')?.addEventListener('click', () => {
      configOpen = false;
      renderSheet();
    });

    dialog.querySelectorAll('[data-ai-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.aiAction;
        const label = QUICK_ACTIONS.find((a) => a.action === act)?.label || act;
        sendTurn(act, '', label);
      });
    });

    const inputEl = dialog.querySelector('#ai-tutor-input');
    const formEl = dialog.querySelector('#ai-tutor-form');
    if (inputEl) {
      inputEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          formEl?.requestSubmit();
        }
      });
    }
    formEl?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = inputEl?.value.trim() || '';
      if (!text || busy) return;
      inputEl.value = '';
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
    busy = true;
    renderSheet();

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
      renderSheet();
    }
  }

  async function refreshStatus() {
    if (!window.StudyCommunity?.isSignedIn?.() || !window.StudyCommunity?.aiRequest) return;
    try {
      serverStatus = await window.StudyCommunity.aiRequest('/status');
      if (document.getElementById('ai-tutor-sheet')?.open) renderSheet();
    } catch {}
  }

  function open(initialAction = '') {
    customCourseContext = null;
    const dialog = ensureDialog();
    renderSheet();
    if (!dialog.open) {
      dialog.showModal();
      dialog.focus({ preventScroll: true });
    }
    refreshStatus();
    if (initialAction && !busy) {
      const label = QUICK_ACTIONS.find((a) => a.action === initialAction)?.label || '';
      sendTurn(initialAction, '', label);
    }
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
    const dialog = ensureDialog();
    renderSheet();
    if (!dialog.open) {
      dialog.showModal();
      dialog.focus({ preventScroll: true });
    }
    refreshStatus();
  }

  return { open, openForCourse, refreshStatus };
})();
