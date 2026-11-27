'use strict';

/**
 * Study-OS Interactive Spotlight Guided Tour
 * Zero-dependency flagship onboarding tour that smoothly glides a spotlight
 * cutout across real views (Home, Timer, Exams, Notes, Metrics, Community
 * Leaderboard, and Settings/Adamlite), gently zooming each target element.
 */
window.StudySpotlightTour = (() => {
  const STORAGE_KEY = 'study-os-spotlight-tour-v1';
  const { esc } = window.StudyUI || { esc: (s) => String(s ?? '') };

  let active = false;
  let stepIndex = 0;
  let stepToken = 0;
  let overlayEl = null;
  let ringEl = null;
  let cardEl = null;
  let activeTargetEl = null;
  let restoreView = 'home';
  let rafRepos = 0;

  const STEPS = [
    {
      id: 'home',
      nav: 'home',
      badge: 'Command Center',
      selector: '#up-next-hero',
      fallbackSelector: '#view-home',
      title: 'Start studying in 1 click',
      body: 'Your command center picks your highest-priority block automatically — or jump into any course below for active-recall exercises and past exams.',
      placement: 'bottom',
    },
    {
      id: 'timer',
      nav: 'home',
      badge: 'Focus Engine',
      selector: '#global-work-action-btn',
      fallbackSelector: '#global-work-pill',
      title: '50m / 75m focus waves & 1:5 breaks',
      body: 'Start a focus wave to track deep work honestly. Finishing a block earns a real off-screen break — keeping peak study hours calm and distraction-free.',
      placement: 'bottom',
    },
    {
      id: 'exams',
      nav: 'exams',
      badge: 'Exam Simulator',
      selector: '#exams-root .exams-hero, #exams-root .panel, #exams-root',
      fallbackSelector: '[data-nav="exams"]',
      title: 'Timed WISEflow past exams',
      body: 'Sit authentic timed exam papers in Blind Exam Mode or Guided Practice, complete with auto-graded multi-box accounting worksheets.',
      placement: 'bottom',
    },
    {
      id: 'notes',
      nav: 'references',
      badge: 'Notes & PDFs',
      selector: '#references-root .obs-doc-sheet, #references-root .obs-shell, #references-root',
      fallbackSelector: '[data-nav="references"]',
      title: 'Formula sheets & inline PDFs',
      body: 'Read structured KaTeX notes side-by-side while solving, pinch-zoom figures, or attach your own textbook & Canvas PDFs privately in your browser.',
      placement: 'bottom',
    },
    {
      id: 'metrics',
      nav: 'analytics',
      badge: 'Readiness & Pace',
      selector: '#mc-exam-forecast-card, #analytics-root .mc-hero, #analytics-root',
      fallbackSelector: '[data-nav="analytics"]',
      title: 'Track UPI, memory & exam grade pace',
      body: 'See your FSRS forgetting curve, 12-week heatmap, and whether your current pace is on track for an A, B, or C before exam day.',
      placement: 'bottom',
    },
    {
      id: 'community',
      nav: 'community',
      badge: 'Live Community',
      selector: '#community-leaderboard-mount, #community-social, #community-root',
      fallbackSelector: '[data-nav="community"]',
      title: 'Live leaderboard, study pods & sharing',
      body: 'Unlocked right when you sign in for 10 minutes so you can explore rankings, Study Together pods, and classmate playlist sharing. Normally opens during breaks or 18:00–22:30 Oslo.',
      placement: 'bottom',
      waitMs: 360,
    },
    {
      id: 'tools',
      nav: 'home',
      badge: 'AI & Sync',
      selector: '#hdr-settings-btn',
      fallbackSelector: '#hdr-al-btn',
      title: 'Adamlite AI, Canvas Sync & replay anytime',
      body: 'Tap Adamlite for instant step-by-step hints, connect BI Canvas & TimeEdit in Settings, or replay this interactive tour anytime from Settings → Interactive Walkthrough.',
      placement: 'bottom',
    },
  ];

  function hasSeen() {
    try { return localStorage.getItem(STORAGE_KEY) === 'done'; } catch { return false; }
  }

  function markSeen() {
    try { localStorage.setItem(STORAGE_KEY, 'done'); } catch {}
  }

  function isVisibleRect(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }

  function findTarget(step) {
    const selectors = [step.selector, step.fallbackSelector].filter(Boolean);
    for (const sel of selectors) {
      const list = document.querySelectorAll(sel);
      for (const el of list) {
        if (isVisibleRect(el)) return el;
      }
    }
    return null;
  }

  function clearTargetHighlight() {
    if (activeTargetEl && activeTargetEl.isConnected) {
      activeTargetEl.classList.remove('tour-spotlight-target');
    }
    activeTargetEl = null;
  }

  function ensureOverlay() {
    if (overlayEl && overlayEl.isConnected) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'study-tour-overlay';
    overlayEl.className = 'study-tour-overlay';
    overlayEl.setAttribute('aria-hidden', 'false');

    ringEl = document.createElement('div');
    ringEl.id = 'study-tour-ring';
    ringEl.className = 'study-tour-ring';
    ringEl.setAttribute('aria-hidden', 'true');

    cardEl = document.createElement('section');
    cardEl.id = 'study-tour-popover';
    cardEl.className = 'study-tour-popover';
    cardEl.setAttribute('role', 'dialog');
    cardEl.setAttribute('aria-modal', 'true');
    cardEl.setAttribute('aria-labelledby', 'study-tour-title');
    cardEl.tabIndex = -1;

    overlayEl.appendChild(ringEl);
    overlayEl.appendChild(cardEl);
    document.body.appendChild(overlayEl);

    overlayEl.addEventListener('click', (ev) => {
      if (ev.target === overlayEl) finish(true);
    });
  }

  function positionSpotlightAndCard(target, step) {
    if (!overlayEl || !ringEl || !cardEl) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = vw < 640 ? 6 : 10;

    let rect = null;
    if (target && isVisibleRect(target)) {
      const raw = target.getBoundingClientRect();
      // Cap tall sections (like full leaderboard/metrics) to a sleek top spotlight slice
      const maxH = Math.min(Math.max(120, vh * 0.44), 380);
      const clampedTop = Math.max(8, Math.min(raw.top, vh - 80));
      const clampedLeft = Math.max(8, Math.min(raw.left, vw - 40));
      const clampedW = Math.max(36, Math.min(raw.width, vw - clampedLeft - 8));
      const clampedH = Math.max(32, Math.min(raw.height, maxH, vh - clampedTop - 8));
      rect = {
        top: Math.max(4, clampedTop - pad),
        left: Math.max(4, clampedLeft - pad),
        width: Math.min(vw - 8, clampedW + pad * 2),
        height: Math.min(vh - 8, clampedH + pad * 2),
      };
      rect.bottom = rect.top + rect.height;
      rect.right = rect.left + rect.width;
    }

    if (rect) {
      ringEl.classList.remove('is-centered');
      ringEl.style.top = `${Math.round(rect.top)}px`;
      ringEl.style.left = `${Math.round(rect.left)}px`;
      ringEl.style.width = `${Math.round(rect.width)}px`;
      ringEl.style.height = `${Math.round(rect.height)}px`;
    } else {
      ringEl.classList.add('is-centered');
      ringEl.style.top = `${Math.round(vh * 0.5)}px`;
      ringEl.style.left = `${Math.round(vw * 0.5)}px`;
      ringEl.style.width = '0px';
      ringEl.style.height = '0px';
    }

    // Measure and place popover card cleanly without ever clipping off-screen
    cardEl.style.maxWidth = `${Math.min(372, vw - 24)}px`;
    const cardRect = cardEl.getBoundingClientRect();
    const cw = cardRect.width || Math.min(360, vw - 24);
    const ch = cardRect.height || 210;
    const gap = 14;

    let top = Math.round((vh - ch) / 2);
    let left = Math.round((vw - cw) / 2);

    if (rect) {
      const spaceBelow = vh - rect.bottom - gap;
      const spaceAbove = rect.top - gap;
      if (step.placement !== 'top' && spaceBelow >= ch + 12) {
        top = Math.round(rect.bottom + gap);
      } else if (spaceAbove >= ch + 12) {
        top = Math.round(rect.top - ch - gap);
      } else {
        // Prefer bottom edge dock on short viewports so the spotlight stays visible
        top = Math.max(12, Math.min(vh - ch - 14, Math.round(rect.bottom + gap)));
      }
      const centerX = rect.left + rect.width / 2 - cw / 2;
      left = Math.max(12, Math.min(vw - cw - 12, Math.round(centerX)));
    }

    cardEl.style.top = `${Math.max(10, Math.min(vh - ch - 10, top))}px`;
    cardEl.style.left = `${Math.max(10, Math.min(vw - cw - 10, left))}px`;
  }

  function renderCard(step, idx) {
    const total = STEPS.length;
    const isLast = idx === total - 1;
    const dotsHtml = STEPS.map((s, i) =>
      `<span class="tour-dot${i === idx ? ' is-active' : i < idx ? ' is-done' : ''}" aria-hidden="true"></span>`
    ).join('');

    cardEl.innerHTML = `
      <div class="tour-card-top">
        <div class="tour-card-meta">
          <span class="badge live">${esc(step.badge)}</span>
          <span class="tour-step-count">${idx + 1} / ${total}</span>
        </div>
        <button type="button" class="mini-tool-btn tour-close-x" id="study-tour-close" aria-label="Skip tour">×</button>
      </div>
      <h2 id="study-tour-title" class="tour-card-title">${esc(step.title)}</h2>
      <p class="tour-card-body">${esc(step.body)}</p>
      <div class="tour-card-foot">
        <div class="tour-dots" aria-hidden="true">${dotsHtml}</div>
        <div class="tour-card-actions">
          ${idx > 0
            ? '<button type="button" class="ghost-btn tour-btn" id="study-tour-prev">← Back</button>'
            : '<button type="button" class="ghost-btn tour-btn" id="study-tour-skip">Skip</button>'}
          <button type="button" class="primary-btn tour-btn" id="study-tour-next">${isLast ? 'Start Studying →' : 'Next →'}</button>
        </div>
      </div>
    `;

    cardEl.querySelector('#study-tour-close')?.addEventListener('click', () => finish(true));
    cardEl.querySelector('#study-tour-skip')?.addEventListener('click', () => finish(true));
    cardEl.querySelector('#study-tour-prev')?.addEventListener('click', () => goToStep(stepIndex - 1));
    cardEl.querySelector('#study-tour-next')?.addEventListener('click', () => {
      if (isLast) finish(false);
      else goToStep(stepIndex + 1);
    });
  }

  function scheduleReposition() {
    if (!active) return;
    cancelAnimationFrame(rafRepos);
    rafRepos = requestAnimationFrame(() => {
      if (!active) return;
      const step = STEPS[stepIndex];
      if (!step) return;
      const target = activeTargetEl && isVisibleRect(activeTargetEl) ? activeTargetEl : findTarget(step);
      positionSpotlightAndCard(target, step);
    });
  }

  function onKeyDown(ev) {
    if (!active) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === 'ArrowRight' || (ev.key === 'Enter' && document.activeElement?.closest('#study-tour-popover') && document.activeElement.id !== 'study-tour-prev' && document.activeElement.id !== 'study-tour-skip' && document.activeElement.id !== 'study-tour-close')) {
      ev.preventDefault();
      if (stepIndex >= STEPS.length - 1) finish(false);
      else goToStep(stepIndex + 1);
    } else if (ev.key === 'ArrowLeft' && stepIndex > 0) {
      ev.preventDefault();
      goToStep(stepIndex - 1);
    }
  }

  async function goToStep(idx) {
    if (!active) return;
    const clamped = Math.max(0, Math.min(STEPS.length - 1, idx));
    stepIndex = clamped;
    const myToken = ++stepToken;
    const step = STEPS[clamped];

    clearTargetHighlight();

    // Navigate smoothly into the step's view if needed
    if (step.nav && typeof window.StudyApp?.navigate === 'function') {
      try {
        await window.StudyApp.navigate(step.nav);
      } catch {}
    }
    if (!active || myToken !== stepToken) return;

    // Wait briefly for async views (like Community live leaderboard) to mount
    const waitMs = Number(step.waitMs || 120);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    if (!active || myToken !== stepToken) return;

    let target = findTarget(step);
    if (!target && step.nav === 'community') {
      // One extra beat in case Community dashboard fetch is still settling
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (!active || myToken !== stepToken) return;
      target = findTarget(step);
    }

    if (target) {
      const rect = target.getBoundingClientRect();
      const needsScroll = rect.top < 72 || rect.top > window.innerHeight * 0.55;
      if (needsScroll && !target.closest('#global-header')) {
        try {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise((resolve) => setTimeout(resolve, 260));
        } catch {}
      }
      if (!active || myToken !== stepToken) return;
      activeTargetEl = target;
      target.classList.add('tour-spotlight-target');
    }

    renderCard(step, clamped);
    cardEl.classList.remove('is-pop');
    void cardEl.offsetWidth;
    cardEl.classList.add('is-pop');
    positionSpotlightAndCard(target, step);

    // One follow-up reposition after layout & images/charts settle
    setTimeout(() => {
      if (active && myToken === stepToken) scheduleReposition();
    }, 220);

    window.requestAnimationFrame(() => {
      cardEl?.querySelector('#study-tour-next')?.focus?.({ preventScroll: true });
    });
  }

  function finish(skipped = false) {
    if (!active) return;
    active = false;
    stepToken++;
    markSeen();
    clearTargetHighlight();
    window.removeEventListener('resize', scheduleReposition);
    window.removeEventListener('scroll', scheduleReposition, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (overlayEl) {
      overlayEl.classList.remove('is-visible');
      const elToRemove = overlayEl;
      overlayEl = null;
      ringEl = null;
      cardEl = null;
      setTimeout(() => elToRemove.remove(), 200);
    }
    // Return smoothly to where the student started (unless they finished on Community and want to explore!)
    if (restoreView && restoreView !== 'runner' && typeof window.StudyApp?.navigate === 'function') {
      const cur = window.StudyApp.getCurrentView?.() || '';
      if (cur !== restoreView) {
        window.StudyApp.navigate(restoreView).catch(() => {});
      }
    }
    if (!skipped) {
      window.StudyUI?.toast?.('Tour complete — ready to study!');
    }
  }

  function start({ force = false } = {}) {
    if (active) return false;
    if (!force && hasSeen()) return false;
    // Never interrupt an active runner/exam session or open modal dialog
    const runnerEl = document.getElementById('view-runner');
    if (runnerEl && !runnerEl.hidden) return false;
    if (!force && document.querySelector('dialog[open]')) return false;

    window.StudyUI?.closeSettings?.();
    restoreView = window.StudyApp?.getCurrentView?.() || 'home';
    active = true;
    stepIndex = 0;

    ensureOverlay();
    window.addEventListener('resize', scheduleReposition);
    window.addEventListener('scroll', scheduleReposition, true);
    document.addEventListener('keydown', onKeyDown, true);

    window.requestAnimationFrame(() => {
      overlayEl?.classList.add('is-visible');
    });
    goToStep(0);
    return true;
  }

  function maybeStartAfterSignup() {
    if (hasSeen() || active) return;
    setTimeout(() => {
      const runnerEl = document.getElementById('view-runner');
      if (runnerEl && !runnerEl.hidden) return;
      if (document.querySelector('dialog[open]')) return;
      start({ force: false });
    }, 650);
  }

  return {
    start,
    finish,
    maybeStartAfterSignup,
    isActive: () => active,
    hasSeen,
  };
})();
