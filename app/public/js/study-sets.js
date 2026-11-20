'use strict';

window.StudySets = (() => {
  const { esc, workClock } = window.StudyUI;
  const storageKey = 'study-os-custom-sets';
  const prompt = 'Use the Study-OS MCP tool draft_study_set to make 12 original question-and-answer cards for [topic] from my notes. Return the clickable Study-OS import link.';
  let draft = null;
  let notice = '';

  function list() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '[]');
    } catch {
      return [];
    }
  }

  function save(set) {
    const others = list().filter((item) => item.id !== set.id);
    if (others.length >= 50) throw new Error('Remove an existing study set before saving another.');
    localStorage.setItem(storageKey, JSON.stringify([set, ...others]));
  }

  async function decodeDraft(code) {
    if (!/^[A-Za-z0-9_-]{1,60000}$/.test(code)) {
      throw new Error('That study set link is invalid.');
    }
    const bytes = Uint8Array.from(atob(code.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        throw new Error('That study set is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    const set = JSON.parse(text + decoder.decode());
    if (set.format !== 'study-os-set-v1' || typeof set.id !== 'string' || !/^[0-9a-f-]{36}$/.test(set.id)
      || typeof set.title !== 'string' || !set.title.trim() || set.title.length > 80
      || !Array.isArray(set.cards) || set.cards.length < 1 || set.cards.length > 30
      || set.cards.some((card) => !Array.isArray(card) || card.length !== 2 ||
        card.some((field) => typeof field !== 'string' || !field.trim() || field.length > 250))) {
      throw new Error('That study set link is invalid.');
    }
    return { id: set.id, title: set.title, cards: set.cards };
  }

  async function activateDraft() {
    const prefix = '#study-set=';
    if (!location.hash.startsWith(prefix)) return false;
    const code = location.hash.slice(prefix.length);
    history.replaceState(null, '', location.pathname + location.search);
    try {
      draft = await decodeDraft(code);
    } catch {
      notice = 'This study set link could not be read. Ask your Al for a fresh Study-OS link.';
    }
    const panel = document.getElementById('my-study-sets');
    panel.open = true;
    render();
    panel.scrollIntoView({ block: 'start' });
    return true;
  }

  function cardsHtml(cards) {
    return `<ol>${cards.map(([question, answer]) =>
      `<li><details><summary>${esc(question)}</summary><p>${esc(answer)}</p></details></li>`).join('')}</ol>`;
  }

  function clockTick() {
    const pending = document.getElementById('study-set-draft-controls');
    if (!pending) return;
    const open = workClock.canUseBreakTools();
    for (const button of pending.querySelectorAll('[data-save-draft]')) {
      button.disabled = !open || pending.dataset.saving === '1';
    }
    pending.querySelector('#study-set-break-note').hidden = open;
  }

  function render() {
    const root = document.getElementById('study-sets-root');
    const sets = list();
    root.innerHTML = `
      ${draft ? `<section id="study-set-draft-controls">
        <h3>${esc(draft.title)} · ${draft.cards.length} cards</h3>
        <details><summary>Preview cards</summary>${cardsHtml(draft.cards)}</details>
        <p id="study-set-break-note">Save or share this set on your next break, or from 18:00 to 22:30 Oslo time.</p>
        <div class="row-actions">
          <button type="button" class="primary-btn" data-save-draft="private">Save to my sets</button>
          ${window.StudyCommunity.canShareSet() ? '<button type="button" class="ghost-btn" data-save-draft="community">Save and share with Community</button>' : ''}
        </div>
      </section>` : `<p>Ask your Al to make a set, then open the Study-OS link it gives you.</p>
      <div class="row-actions">
        <button type="button" class="ghost-btn" id="copy-study-set-prompt">Copy starter prompt</button>
        <a class="ghost-btn" href="https://github.com/shadjosef/study-os/blob/main/docs/study-sets-mcp.md" target="_blank" rel="noopener">Connect your Al</a>
      </div>`}
      <p id="study-set-status" role="status">${esc(notice)}</p>
      <div class="study-set-list">${sets.map((set) => `<details>
        <summary>${esc(set.title)} (${set.cards.length})</summary>
        ${cardsHtml(set.cards)}
        <button type="button" class="ghost-btn" data-remove-study-set="${esc(set.id)}">Remove from this device</button>
      </details>`).join('')}</div>`;
    root.querySelector('#copy-study-set-prompt')?.addEventListener('click', async () => {
      const status = root.querySelector('#study-set-status');
      try {
        await navigator.clipboard.writeText(prompt);
        status.textContent = 'Prompt copied. Replace [topic] and send it to your Al.';
      } catch {
        status.textContent = prompt;
      }
    });
    for (const button of root.querySelectorAll('[data-save-draft]')) {
      button.onclick = async () => {
        if (!draft || !workClock.canUseBreakTools()) return;
        const panel = root.querySelector('#study-set-draft-controls');
        panel.dataset.saving = '1';
        clockTick();
        try {
          save(draft);
          if (button.dataset.saveDraft === 'community') await window.StudyCommunity.shareSet(draft);
          notice = button.dataset.saveDraft === 'community' ? 'Study set saved and shared.' : 'Study set saved.';
          draft = null;
          render();
        } catch (error) {
          root.querySelector('#study-set-status').textContent = error.message;
        } finally {
          delete panel.dataset.saving;
          clockTick();
        }
      };
    }
    for (const button of root.querySelectorAll('[data-remove-study-set]')) {
      button.onclick = () => {
        localStorage.setItem(storageKey, JSON.stringify(list().filter((set) => set.id !== button.dataset.removeStudySet)));
        render();
      };
    }
    clockTick();
  }

  document.getElementById('my-study-sets').addEventListener('toggle', (event) => {
    if (event.currentTarget.open) render();
  });

  window.addEventListener('hashchange', async () => {
    if (!location.hash.startsWith('#study-set=')) return;
    if (!document.getElementById('view-runner').hidden) document.getElementById('run-exit-btn').click();
    await window.StudyApp.navigate('home');
    await activateDraft();
  });

  return { activateDraft, save, clockTick };
})();
