/* Study-OS Study Playbook — Evidence-Based Study Protocol & Upcoming Reading List.
 * Edit the PLAYBOOK_SECTIONS array below anytime to publish new habits, links, or guides.
 */
'use strict';

window.StudyPlaybook = (() => {
  const { esc } = window.StudyUI;

  const PLAYBOOK_SECTIONS = [
    {
      badge: 'Core System',
      badgeClass: 'live',
      title: 'High · Med · Low DLPFC Energy Routing',
      summary: 'Match task cognitive load to your circadian prefrontal capacity instead of forcing hard derivations when your brain is cooked.',
      points: [
        '<b>High DLPFC (Peak window · Wake +30m to +7h, cap ~4.5h/day):</b> Unseen proofs, multi-step financial statements, coding, and analytical cases while executive control is freshest.',
        '<b>Med DLPFC (Mid-day · Wake +7h to +11h):</b> Standard single-method calculations, applied scenarios, and speed drills on techniques you already know.',
        '<b>Low DLPFC (Evening wind-down):</b> Conceptual recall MCQs, definition checks, and spaced-repetition reviews.',
      ],
    },
    {
      badge: 'Core System',
      badgeClass: 'live',
      title: '50m / 75m Working Blocks & 1:5 Off-Screen Breaks',
      summary: 'Deep learning happens in uninterrupted blocks followed by real off-screen recovery — not tab-switching every 5 minutes.',
      points: [
        'Run continuous <b>50m</b> (default) or <b>75m</b> AI-Par blocks so you stay inside flow instead of jumping between tiny sets.',
        'Take a genuine <b>1:5 off-screen break</b> (walk, water, look outside — no doomscrolling) so prefrontal fatigue actually clears.',
        'Study-OS Community opens during timed breaks and after 20:00 Oslo time so social features never steal peak study focus.',
      ],
    },
    {
      badge: 'Upcoming',
      badgeClass: 'gold',
      title: 'Habit Anchors: Same Time, Same Place',
      summary: 'Curated habit playbook coming soon — building automaticity so starting your first block costs zero willpower.',
      points: [
        'Anchor your first High-DLPFC block to the exact same wake-up time and desk setup every study day.',
        'Use Schedule Studio (TimeEdit + sleep & work hours) to export a repeatable weekly rhythm straight to Google or Apple Calendar.',
        '<i>More notes, research links, and curated study guides will be added here soon.</i>',
      ],
    },
    {
      badge: 'Upcoming',
      badgeClass: 'gold',
      title: 'Active Recall, AI Par & Honest Scoring',
      summary: 'How to use realistic AI Par timers and the Socratic ✨ AI Tutor without fooling yourself into passive rereading.',
      points: [
        'Attempt every problem cold first before opening a hint or solution — struggle is the signal that builds durable memory.',
        '<b>UPI rewards High DLPFC (1.22×) and Exam Par (1.08×)</b> while keeping self-graded written weight conservative so your metrics stay honest.',
        'Use the built-in <b>✨ AI</b> tutor for one small nudge or to check your working — not to skip thinking.',
      ],
    },
  ];

  function ensureDialog() {
    let dlg = document.getElementById('study-playbook-dialog');
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'study-playbook-dialog';
    dlg.className = 'member-dialog playbook-sheet';
    dlg.tabIndex = -1;
    dlg.setAttribute('aria-labelledby', 'playbook-sheet-title');
    dlg.addEventListener('click', (ev) => {
      if (ev.target === dlg) dlg.close();
    });
    document.body.appendChild(dlg);
    return dlg;
  }

  function open() {
    const dlg = ensureDialog();
    dlg.innerHTML = `
      <div class="playbook-head">
        <div>
          <span class="eyebrow">Study-OS Method · Living Guide</span>
          <h2 id="playbook-sheet-title" style="margin:2px 0 4px">Study Playbook</h2>
          <p class="muted" style="margin:0;font-size:13px">Core principles behind Study-OS — plus upcoming habits &amp; reading lists.</p>
        </div>
        <button type="button" class="ios-done-btn" id="playbook-done">Done</button>
      </div>
      <div class="playbook-body">
        ${PLAYBOOK_SECTIONS.map((s) => `
          <article class="playbook-card">
            <div class="row-between" style="margin:0 0 6px;gap:8px">
              <h3 style="margin:0;font-size:15.5px">${esc(s.title)}</h3>
              <span class="badge ${esc(s.badgeClass)}">${esc(s.badge)}</span>
            </div>
            <p class="muted" style="margin:0 0 8px;font-size:13px;line-height:1.45">${esc(s.summary)}</p>
            <ul class="playbook-list">
              ${s.points.map((pt) => `<li>${pt}</li>`).join('')}
            </ul>
          </article>
        `).join('')}
        <div class="playbook-upcoming-note">
          <strong>More coming soon</strong>
          <p class="muted" style="margin:4px 0 0;font-size:12.5px">We’re expanding this library with deeper guides on study habits, consistent daily start times, working blocks, sleep &amp; memory consolidation, and exam week protocols.</p>
        </div>
      </div>
    `;
    dlg.querySelector('#playbook-done')?.addEventListener('click', () => dlg.close());
    if (!dlg.open) {
      dlg.showModal();
      dlg.focus({ preventScroll: true });
    }
  }

  return { open, sections: PLAYBOOK_SECTIONS };
})();
