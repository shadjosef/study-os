'use strict';

window.StudyQuestionCopy = (() => {
  let current;

  function answer(value, options) {
    if (value == null || String(value).trim() === '') return '(blank)';
    return String(options?.[Number(value)] ?? value);
  }

  function compose({ question, course, topic, state, revealed, sources, transcript, lean = false }) {
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
      response.push(`- ${field.label}${unit}.${allowed} Your answer: ${selected}.${revealed ? ` Expected: ${correct}.` : ''}`);
    }
    if (options?.length) {
      response.push(`Your choice: ${answer(state.choice, options)}`);
      if (revealed) response.push(`Correct choice: ${answer(question.answerIndex, options)}`);
    }
    if (question.numericCheck) {
      const unit = question.numericCheck.unit ? ` (${question.numericCheck.unit})` : '';
      response.push(`Numeric answer${unit}: ${answer(state.numericInput)}`);
      if (revealed) response.push(`Expected numeric answer${unit}: ${answer(question.numericCheck.expected)}`);
    }
    if (state.draft?.trim()) {
      if (response.length) blocks.push('## Your answers', response.join('\n'));
      blocks.push('## Your working', state.draft.trim());
    } else {
      blocks.push('## Your answers', response.length ? response.join('\n') : '(blank)');
    }
    if (revealed && question.solutionMarkdown?.trim()) {
      blocks.push('## Worked solution', question.solutionMarkdown.trim());
    }

    return blocks.filter(Boolean).join('\n\n');
  }

  function copied() {
    window.StudyUI.toast('Question and answers copied for Adamlite.');
  }

  function showPreview(text) {
    const dialog = document.getElementById('question-copy-preview');
    const field = dialog.querySelector('textarea');
    field.value = text;
    if (!dialog.open) dialog.showModal();
    field.select();
  }

  async function copyAsync(text) {
    try {
      if (window.ClipboardItem && navigator.clipboard?.write) {
        // Supply the text as a promise while the browser still has the copy gesture.
        const data = Promise.resolve(text).then((value) => new Blob([value], { type: 'text/plain' }));
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': data })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      copied();
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
    if (copyBtn) copyBtn.onclick = () => copyAsync(textForCopy(context));
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

  function textForCopy(context) {
    const model = context.model;
    // Preserve the answer values at the moment the learner asks to copy.
    const state = { ...model.state, wiseflow: { ...model.state.wiseflow } };
    return context.transcript
      ? compose({ ...model, state, transcript: context.transcript })
      : context.reading.then((transcript) => compose({ ...model, state, transcript }));
  }

  document.addEventListener('copy', (event) => {
    const card = current?.card;
    const view = card?.closest('#view-runner');
    if (!card?.isConnected || !view || view.hidden) return;
    const active = document.activeElement;
    if (active?.matches('input, textarea, [contenteditable]:not([contenteditable=false])')) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const wholeQuestion = document.createRange();
    wholeQuestion.selectNodeContents(card);
    const selected = selection.getRangeAt(0);
    if (selected.compareBoundaryPoints(Range.START_TO_START, wholeQuestion) > 0 ||
        selected.compareBoundaryPoints(Range.END_TO_END, wholeQuestion) < 0) return;
    const text = textForCopy(current);
    event.preventDefault();
    if (typeof text === 'string' && event.clipboardData) {
      event.clipboardData.setData('text/plain', text);
      copied();
    } else {
      copyAsync(text);
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

  return { bind, tutorContext, tutorPayload, tutorPayloadAsync };
})();
