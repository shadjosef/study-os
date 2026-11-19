'use strict';

window.StudyLayout = (() => {
  const { esc, workClock } = window.StudyUI;
  const key = 'study-os-layout-v2';
  const standard = { title: 'DLPFC Focus (Default)', dlpfc: true, budget: true, performance: true, screen: true };
  const simple = { title: 'Simple Labels (Easy/Med/Hard)', dlpfc: false, budget: false, performance: true, screen: true };
  const fields = ['dlpfc', 'budget', 'performance', 'screen'];
  const dialog = document.getElementById('layout-dialog');
  const form = document.getElementById('layout-form');
  const picker = document.getElementById('layout-preset');
  const codeInput = document.getElementById('layout-code');
  const status = document.getElementById('layout-status');
  let saved = [];
  let active = standard;
  let returnToBreak = false;

  function clean(preset) {
    const title = typeof preset?.title === 'string' ? preset.title.trim() : '';
    if (!title || title.length > 48 || fields.some((field) => typeof preset[field] !== 'boolean')) {
      throw new Error('Enter a valid layout preset.');
    }
    return { title, ...Object.fromEntries(fields.map((field) => [field, preset[field]])) };
  }

  try {
    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    saved = (stored.saved || []).map(clean);
    if (stored.active) active = clean(stored.active);
  } catch {}

  function applyFlags() {
    for (const field of fields) document.documentElement.toggleAttribute('data-show-' + field, active[field]);
    for (const element of document.querySelectorAll('[data-layout-tier]')) {
      element.textContent = label(Number(element.dataset.layoutTier));
    }
    for (const element of document.querySelectorAll('[data-layout-tier-group]')) {
      element.textContent = label(2) + ' and ' + label(3);
    }
  }

  function onBreak() {
    return workClock.canUseBreakTools();
  }

  function presets() {
    return [standard, simple, ...saved];
  }

  function edit(preset) {
    form.elements.title.value = preset.title;
    for (const field of fields) form.elements[field].checked = preset[field];
  }

  function fromForm() {
    return clean({ title: form.elements.title.value,
      ...Object.fromEntries(fields.map((field) => [field, form.elements[field].checked])) });
  }

  function refreshPicker() {
    const options = presets();
    picker.innerHTML = options.map((preset, index) => `<option value="${index}">${esc(preset.title)}</option>`).join('');
    picker.value = String(Math.max(0, options.findIndex((preset) => preset.title === active.title)));
  }

  function open(fromBreak = true) {
    if (!onBreak()) return;
    returnToBreak = Boolean(fromBreak);
    refreshPicker();
    edit(active);
    codeInput.value = '';
    status.textContent = '';
    const breakDialog = document.getElementById('break-modal');
    if (breakDialog?.open) breakDialog.close();
    dialog.showModal();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  function clockTick() {
    if (dialog.open && !onBreak()) close();
  }

  function label(tier) {
    return (active.dlpfc ? ['Low DLPFC', 'Med DLPFC', 'High DLPFC'] : ['Easy', 'Medium', 'Hard'])[tier - 1] || (active.dlpfc ? 'Med DLPFC' : 'Medium');
  }

  function isDlpfc() {
    return Boolean(active.dlpfc);
  }

  picker.onchange = () => edit(presets()[Number(picker.value)]);
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!onBreak()) return close();
    try {
      const preset = fromForm();
      const builtIn = [standard, simple].find((option) => option.title === preset.title);
      if (builtIn && fields.some((field) => preset[field] !== builtIn[field])) {
        throw new Error('Give your customized preset a new name.');
      }
      const updated = builtIn ? saved : [preset, ...saved.filter((option) => option.title !== preset.title)].slice(0, 20);
      localStorage.setItem(key, JSON.stringify({ active: preset, saved: updated }));
      active = preset;
      saved = updated;
      applyFlags();
      refreshPicker();
      window.StudyApp?.renderHome?.();
      status.textContent = 'Preset saved and applied.';
    } catch (error) {
      status.textContent = error.message;
    }
  };
  document.getElementById('layout-load').onclick = () => {
    try {
      const parsed = JSON.parse(codeInput.value);
      if (parsed?.format !== key) throw new Error();
      edit(clean(parsed));
      status.textContent = 'Review the preset, then save and apply it.';
    } catch {
      status.textContent = 'Paste a valid Study-OS layout code.';
    }
  };
  document.getElementById('layout-copy').onclick = async () => {
    try {
      codeInput.value = JSON.stringify({ format: key, ...fromForm() });
      await navigator.clipboard.writeText(codeInput.value);
      status.textContent = 'Preset code copied.';
    } catch {
      status.textContent = 'Choose a preset, then copy the code from the field.';
    }
  };
  document.getElementById('layout-close').onclick = close;
  dialog.addEventListener('close', () => {
    const breakDialog = document.getElementById('break-modal');
    if (returnToBreak && onBreak() && !breakDialog.open) breakDialog.showModal();
    returnToBreak = false;
    window.StudyUI?.updateSettingsIndicators?.();
  });
  applyFlags();
  return { open, clockTick, label, isDlpfc, getActiveTitle: () => active.title };
})();
