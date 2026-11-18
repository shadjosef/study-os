'use strict';

window.StudySets = (() => {
  const { esc } = window.StudyUI;
  const storageKey = 'study-os-custom-sets';

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

  function parseCards(input) {
    const cards = input.trim().split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => line.split('\t').map((cell) => cell.trim()));
    if (!cards.length || cards.length > 30 || cards.some((card) =>
      card.length !== 2 || card.some((cell) => !cell || cell.length > 250))) {
      throw new Error('Use 1–30 lines with a question and answer separated by one tab. Each field can have up to 250 characters.');
    }
    return cards;
  }

  function render() {
    const root = document.getElementById('study-sets-root');
    const sets = list();
    root.innerHTML = `
      <p>Build a set for any subject. This practice stays on this device and earns no leaderboard or Elo points.</p>
      <form id="study-set-import">
        <label class="field-label">Subject or title <input name="title" maxlength="80" required></label>
        <label class="field-label">Paste questions and answers separated by a tab
          <textarea name="cards" rows="4" maxlength="16000"></textarea>
        </label>
        <label class="field-label">Or choose a two-column TSV file <input type="file" name="file" accept=".tsv,.txt,text/plain"></label>
        <button type="submit" class="primary-btn">Save study set</button>
      </form>
      <p id="study-set-status" role="status"></p>
      <div class="study-set-list">${sets.map((set) => `
        <details>
          <summary>${esc(set.title)} (${set.cards.length})</summary>
          <ol>${set.cards.map(([question, answer]) => `
            <li><details><summary>${esc(question)}</summary><p>${esc(answer)}</p></details></li>
          `).join('')}</ol>
          <button type="button" class="ghost-btn" data-remove-study-set="${esc(set.id)}">Remove from this device</button>
        </details>`).join('')}</div>`;
    root.querySelector('#study-set-import').onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const status = root.querySelector('#study-set-status');
      try {
        const title = data.get('title').trim();
        if (!title || title.length > 80) throw new Error('Enter a title of up to 80 characters.');
        const file = data.get('file');
        if (file.size > 65_536) throw new Error('Choose a TSV file smaller than 64 KB.');
        const cards = parseCards(file.size ? await file.text() : data.get('cards'));
        save({ id: crypto.randomUUID(), title, cards });
        render();
        root.querySelector('#study-set-status').textContent = 'Study set saved.';
      } catch (error) {
        status.textContent = error.message;
      }
    };
    for (const button of root.querySelectorAll('[data-remove-study-set]')) {
      button.onclick = () => {
        localStorage.setItem(storageKey, JSON.stringify(sets.filter((set) => set.id !== button.dataset.removeStudySet)));
        render();
      };
    }
  }

  document.getElementById('my-study-sets').addEventListener('toggle', (event) => {
    if (event.currentTarget.open) render();
  });

  return { list, save, render };
})();
