'use strict';

window.StudyQuestionCopy = (() => {
  const COPY_HIDDEN_SOLUTION_KEY = 'study-os-copy-hidden-solution-v1';
  let current;

  function isCopyHiddenSolutionEnabled() {
    try {
      const raw = localStorage.getItem(COPY_HIDDEN_SOLUTION_KEY);
      return raw == null ? true : raw === '1';
    } catch {
      return true;
    }
  }

  function setCopyHiddenSolutionEnabled(enabled) {
    try {
      localStorage.setItem(COPY_HIDDEN_SOLUTION_KEY, enabled ? '1' : '0');
    } catch {}
    return Boolean(enabled);
  }

  function answer(value, options) {
    if (value == null || String(value).trim() === '') return '(blank)';
    return String(options?.[Number(value)] ?? value);
  }

  function compose({ question, course, topic, state, revealed, includeHiddenSolution = false, sources, transcript, lean = false }) {
    const showAnswerKey = Boolean(revealed || includeHiddenSolution);
    const promptTxt = question.promptMarkdown?.trim() || '';
    const blocks = [
      `# ${question.title}`,
      [course, topic, question.points ? `${question.points} points` : ''].filter(Boolean).join(' · '),
      '## Question',
      question.contextMarkdown?.trim(),
      promptTxt,
    ];
    // In fast/lean mode, skip redundant raw PDF text extraction only when promptMarkdown already has the full task
    const includePdfTranscript = !lean || promptTxt.length < 240;
    if (includePdfTranscript) {
      for (const [index, source] of sources.entries()) {
        if (transcript[index]) {
          blocks.push(`### ${source.label}\n${lean ? transcript[index].slice(0, 2200) : transcript[index]}`);
        } else if (!lean) {
          blocks.push(`Source: ${source.label} (no readable text could be extracted).`);
        }
      }
    }

    const options = question.kind === 'mcq' ? question.options : null;
    if (options?.length) {
      blocks.push(options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`).join('\n'));
    }

    const fields = question.wiseflowFields || [];
    let lastGroup;
    const response = [];
    for (const field of fields) {
      const group = field.group || field.section;
      if (group && group !== lastGroup) response.push(`${response.length ? '\n' : ''}### ${group}`);
      lastGroup = group;
      const choices = field.type === 'choice' ? field.options : null;
      const unit = field.unit ? ` (${field.unit})` : '';
      const selected = answer(state.wiseflow?.[field.id], choices);
      const correct = field.type === 'choice' ? answer(field.answerIndex, choices) : answer(field.expected);
      const allowed = choices?.length ? ` Options: ${choices.join(' / ')}.` : '';
      response.push(`- ${field.label}${unit}.${allowed} Your answer: ${selected}.${showAnswerKey ? ` Expected: ${correct}.` : ''}`);
    }
    if (options?.length) {
      response.push(`Your choice: ${answer(state.choice, options)}`);
      if (showAnswerKey) response.push(`Correct choice: ${answer(question.answerIndex, options)}`);
    }
    if (question.numericCheck) {
      const unit = question.numericCheck.unit ? ` (${question.numericCheck.unit})` : '';
      response.push(`Numeric answer${unit}: ${answer(state.numericInput)}`);
      if (showAnswerKey) response.push(`Expected numeric answer${unit}: ${answer(question.numericCheck.expected)}`);
    }
    if (state.draft?.trim()) {
      if (response.length) blocks.push('## Your answers', response.join('\n'));
      blocks.push('## Your working', state.draft.trim());
    } else {
      blocks.push('## Your answers', response.length ? response.join('\n') : '(blank)');
    }
    if (showAnswerKey && question.solutionMarkdown?.trim()) {
      const heading = revealed
        ? '## Worked solution'
        : '## Official solution (hidden in UI — use to grade or guide without spoiling unless asked)';
      blocks.push(heading, question.solutionMarkdown.trim());
    }

    return blocks.filter(Boolean).join('\n\n');
  }

  function copied(withHiddenSolution = false) {
    window.StudyUI.toast(
      withHiddenSolution
        ? 'Question, your answer & hidden solution copied.'
        : 'Question and answers copied for Adamlite.'
    );
  }

  function showPreview(text) {
    const dialog = document.getElementById('question-copy-preview');
    const field = dialog.querySelector('textarea');
    field.value = text;
    if (!dialog.open) dialog.showModal();
    field.select();
  }

  async function copyAsync(text, withHiddenSolution = false) {
    try {
      if (window.ClipboardItem && navigator.clipboard?.write) {
        // Supply the text as a promise while the browser still has the copy gesture.
        const data = Promise.resolve(text).then((value) => new Blob([value], { type: 'text/plain' }));
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': data })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      copied(withHiddenSolution);
    } catch {
      showPreview(await text);
    }
  }

  function bind(card, model) {
    const context = { card, model, transcript: model.sources.length ? null : [] };
    context.reading = Promise.all(
      model.sources.map((source) => window.StudyPdf.textForPage(source).catch(() => ''))
    ).then((transcript) => {
      context.transcript = transcript;
      if (current === context) window.StudyTutor.changed();
      return transcript;
    });
    current = context;
    const copyBtn = card.querySelector('#btn-copy-for-ai');
    if (copyBtn) copyBtn.onclick = () => {
      const payload = buildCopyPayload(context);
      window.StudyWebTelemetry?.track?.('copy_question', payload.withHiddenSolution ? 'btn_hidden_sol' : 'btn');
      if (!context.model?.revealed && !context.model?.blind) {
        window.StudyRunner?.markCurrentQuestionAiAssisted?.('copy');
      }
      copyAsync(payload.text, payload.withHiddenSolution);
    };
    window.StudyTutor.changed();
    window.StudyAiTutor?.syncContext?.();
  }

  function tutorContext() {
    if (!current?.card.isConnected || document.getElementById('view-runner').hidden) return { mode: 'waiting' };
    const { model, transcript } = current;
    if (model.blind) return { mode: 'blind' };
    return {
      mode: 'practice', courseId: model.courseId, questionId: model.question.id,
      course: model.course, title: model.question.title,
      noteFile: model.noteFile || '', noteHeading: model.question.obsidianLink?.heading || '',
      context: compose({ ...model, revealed: false, transcript: transcript || [] }).slice(0, 90_000),
    };
  }

  function tutorPayload({ includeSolution = false } = {}) {
    if (!current?.card.isConnected || document.getElementById('view-runner').hidden) return { mode: 'waiting' };
    const { model, transcript } = current;
    if (model.blind) return { mode: 'blind' };
    const state = { ...model.state, wiseflow: { ...model.state.wiseflow } };
    return {
      mode: 'practice', courseId: model.courseId, questionId: model.question.id,
      course: model.course, topic: model.topic || '', title: model.question.title,
      noteFile: model.noteFile || '',
      noteHeading: model.question.obsidianLink?.heading || model.topic || '',
      revealed: Boolean(model.revealed),
      context: compose({
        ...model,
        state,
        revealed: Boolean(includeSolution || model.revealed),
        transcript: transcript || [],
        lean: true,
      }).slice(0, 6_000),
    };
  }

  function hasAnswerKey(question) {
    if (!question) return false;
    return Boolean(
      question.solutionMarkdown?.trim()
      || (question.kind === 'mcq' && question.answerIndex != null)
      || (Array.isArray(question.wiseflowFields) && question.wiseflowFields.length)
      || question.numericCheck
    );
  }

  function snapshotStateFromCard(card, modelState) {
    const wf = { ...(modelState?.wiseflow || {}) };
    let draft = modelState?.draft || '';
    let numericInput = modelState?.numericInput || '';
    if (card?.isConnected) {
      card.querySelectorAll('input[data-wf-num-id]').forEach((inp) => {
        const fid = inp.dataset.wfNumId;
        if (fid) wf[fid] = inp.value;
      });
      const draftEl = card.querySelector('#inp-written-draft');
      if (draftEl) draft = draftEl.value;
      const numEl = card.querySelector('#inp-numeric-ans');
      if (numEl) numericInput = numEl.value;
    }
    return { ...modelState, wiseflow: wf, draft, numericInput };
  }

  function buildCopyPayload(context, { preferSync = false } = {}) {
    const model = context.model;
    // Preserve live answer values at the moment the learner asks to copy.
    const state = snapshotStateFromCard(context.card, model.state);
    const includeHiddenSolution = Boolean(!model.blind && !model.revealed && isCopyHiddenSolutionEnabled() && hasAnswerKey(model.question));
    const opts = { ...model, state, includeHiddenSolution };
    const hasPromptText = (model.question?.promptMarkdown?.trim().length || 0) >= 80;
    const text = context.transcript
      ? compose({ ...opts, transcript: context.transcript })
      : (preferSync && hasPromptText)
        ? compose({ ...opts, transcript: [] })
        : context.reading.then((transcript) => compose({ ...opts, transcript }));
    return { text, withHiddenSolution: includeHiddenSolution };
  }

  function textForCopy(context) {
    return buildCopyPayload(context).text;
  }

  // Progressive Select All inside text boxes:
  // 1st Cmd+A / Ctrl+A / Alt+A selects the text box; 2nd press while already selected expands to the whole page
  // (blurring the field so Cmd+C / Ctrl+C immediately copies the question + all your answers).
  // Outside a text box, Alt+A immediately selects the whole page too.
  let lastSelectEl = null;
  let lastSelectAt = 0;

  function isExpandableTextControl(el) {
    if (!el || el.disabled) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const t = String(el.type || 'text').toLowerCase();
      return t === 'text' || t === 'search' || t === 'url' || t === 'tel' || t === 'email' || t === 'number';
    }
    return false;
  }

  function isWholeControlSelected(el) {
    const val = String(el.value || '');
    if (!val.length) return false;
    try {
      if (el.selectionStart == null || el.selectionEnd == null) return false;
      return el.selectionStart === 0 && el.selectionEnd === val.length;
    } catch {
      return false;
    }
  }

  function selectWholeScope(fromEl) {
    const scope = fromEl?.closest?.('dialog[open]') || document.body;
    try { fromEl?.blur?.(); } catch {}
    const sel = window.getSelection();
    if (!sel || !scope) return;
    const range = document.createRange();
    range.selectNodeContents(scope);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function getVisibleTextBounds(container) {
    if (!container?.isConnected) return null;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let firstNode = null;
    let lastNode = null;
    let node;
    while ((node = walker.nextNode())) {
      const val = node.nodeValue || '';
      if (!val.trim()) continue;
      const el = node.parentElement;
      if (!el) continue;
      if (el.closest('[hidden], [popover]:not(:popover-open), script, style, template, noscript')) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (!el.getClientRects().length) continue;
      if (!firstNode) firstNode = node;
      lastNode = node;
    }
    if (!firstNode || !lastNode) return null;
    const range = document.createRange();
    const startOffset = Math.max(0, firstNode.nodeValue.search(/\S/));
    const endOffset = firstNode === lastNode
      ? lastNode.nodeValue.trimEnd().length
      : lastNode.nodeValue.trimEnd().length;
    range.setStart(firstNode, startOffset);
    range.setEnd(lastNode, Math.max(startOffset, endOffset));
    return range;
  }

  function selectionCoversQuestion(selection, card) {
    if (!selection?.rangeCount || selection.isCollapsed || !card?.isConnected) return false;
    const selected = selection.getRangeAt(0);
    // Fast path: full document.body or enclosing view-runner selected programmatically.
    if (selected.startContainer === document.body && selected.endContainer === document.body) {
      return true;
    }
    const visibleBounds = getVisibleTextBounds(card);
    if (visibleBounds) {
      return (
        selected.compareBoundaryPoints(Range.START_TO_START, visibleBounds) <= 0
        && selected.compareBoundaryPoints(Range.END_TO_END, visibleBounds) >= 0
      );
    }
    const fallback = document.createRange();
    fallback.selectNodeContents(card);
    return (
      selected.compareBoundaryPoints(Range.START_TO_START, fallback) <= 0
      && selected.compareBoundaryPoints(Range.END_TO_END, fallback) >= 0
    );
  }

  document.addEventListener('keydown', (event) => {
    if (event.repeat || event.isComposing || event.shiftKey) return;
    const isKeyA = event.code === 'KeyA' || String(event.key || '').toLowerCase() === 'a';
    if (!isKeyA) return;
    const isPrimarySelectAll = (event.metaKey || event.ctrlKey) && !event.altKey;
    const isAltSelectAll = event.altKey && !event.metaKey && !event.ctrlKey;
    if (!isPrimarySelectAll && !isAltSelectAll) return;

    const active = document.activeElement;
    if (!isExpandableTextControl(active)) {
      if (isAltSelectAll && !active?.matches?.('input, textarea, [contenteditable]:not([contenteditable=false])')) {
        event.preventDefault();
        selectWholeScope(active);
      }
      return;
    }

    const hasText = String(active.value || '').length > 0;
    const now = Date.now();
    const isNumberInput = active.tagName === 'INPUT' && String(active.type || '').toLowerCase() === 'number';
    const alreadySelected = hasText && !isNumberInput
      ? isWholeControlSelected(active)
      : (lastSelectEl === active && now - lastSelectAt <= 1500);

    if (alreadySelected) {
      event.preventDefault();
      lastSelectEl = null;
      lastSelectAt = 0;
      selectWholeScope(active);
      return;
    }

    if (!hasText || isNumberInput) {
      lastSelectEl = active;
      lastSelectAt = now;
    } else {
      lastSelectEl = null;
      lastSelectAt = 0;
    }

    if (isAltSelectAll) {
      event.preventDefault();
      try { active.select(); } catch {}
    }
    // For Cmd+A / Ctrl+A on first press, let the browser's native select-all highlight the text box cleanly.
  }, true);

  document.addEventListener('copy', (event) => {
    const card = current?.card;
    const view = card?.closest('#view-runner');
    if (!card?.isConnected || !view || view.hidden) return;
    const active = document.activeElement;
    if (active?.matches('input, textarea, [contenteditable]:not([contenteditable=false])')) return;
    const selection = window.getSelection();
    if (!selectionCoversQuestion(selection, card)) return;
    const { text, withHiddenSolution } = buildCopyPayload(current, { preferSync: true });
    window.StudyWebTelemetry?.track?.('copy_question', withHiddenSolution ? 'page_hidden_sol' : 'page');
    if (!current.model?.revealed && !current.model?.blind) {
      window.StudyRunner?.markCurrentQuestionAiAssisted?.('copy');
    }
    event.preventDefault();
    if (typeof text === 'string' && event.clipboardData) {
      event.clipboardData.setData('text/plain', text);
      copied(withHiddenSolution);
    } else {
      copyAsync(text, withHiddenSolution);
    }
  });

  async function tutorPayloadAsync({ includeSolution = false } = {}) {
    if (!current?.card.isConnected || document.getElementById('view-runner').hidden) return { mode: 'waiting' };
    if (!current.transcript && current.reading) {
      await Promise.race([
        current.reading.catch(() => []),
        new Promise((resolve) => setTimeout(resolve, 550)),
      ]);
    }
    return tutorPayload({ includeSolution });
  }

  return {
    bind,
    tutorContext,
    tutorPayload,
    tutorPayloadAsync,
    isCopyHiddenSolutionEnabled,
    setCopyHiddenSolutionEnabled,
  };
})();
