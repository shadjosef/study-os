'use strict';

window.StudyWebTelemetry = (() => {
  const root = document.documentElement;
  const api = String(root?.dataset?.communityApi || '').trim().replace(/\/+$/, '');
  const host = String(window.location?.hostname || '').toLowerCase();
  const isLoopback = !host || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  const isLocalMode = root?.dataset?.studyMode === 'local';
  const enabled = Boolean(api && /^https:\/\//i.test(api) && !isLoopback && !isLocalMode);

  if (!enabled) {
    return { enabled: false, track() {}, flush() {} };
  }

  const endpoint = `${api}/t`;
  const queue = [];
  let flushTimer = null;
  let lastTab = '';
  let lastCourse = '';
  let flushedPage = false;
  let errorBudget = 3;

  function isSignedIn() {
    try {
      return Boolean(localStorage.getItem('study-os-community-profile'));
    } catch {
      return false;
    }
  }

  function cleanPath() {
    const p = String(window.location?.pathname || '/').split('?')[0].split('#')[0];
    return p === '/index.html' ? '/' : (p || '/');
  }

  function sendBatch(batch) {
    if (!batch.length) return;
    const payload = JSON.stringify({
      events: batch,
      auth: isSignedIn() ? 'authed' : 'anon',
      path: cleanPath(),
      ref: flushedPage ? '' : String(document.referrer || '').slice(0, 240),
      w: Math.round(window.innerWidth || 0),
    });
    flushedPage = true;
    try {
      if (navigator.sendBeacon) {
        // Use text/plain to avoid extra CORS preflight while Worker parses JSON strictly.
        const blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(endpoint, blob)) return;
      }
    } catch {}
    try {
      fetch(endpoint, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: payload,
      }).catch(() => {});
    } catch {}
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queue.length) return;
    const batch = queue.splice(0, 16);
    sendBatch(batch);
    if (queue.length) scheduleFlush(1500);
  }

  function scheduleFlush(delayMs = 5500) {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, delayMs);
  }

  function track(event, dim = '', val = 1) {
    if (typeof event !== 'string' || !event) return;
    const ev = event.trim().toLowerCase();
    const d = typeof dim === 'string' ? dim.trim().slice(0, 64) : '';
    if (ev === 'tab_view') {
      if (!d || d === lastTab) return;
      lastTab = d;
    } else if (ev === 'course_open') {
      if (!d || d === lastCourse) return;
      lastCourse = d;
    }
    const item = { event: ev, dim: d };
    if (ev === 'active_sec') {
      const n = Math.round(Number(val) || 0);
      if (n < 1) return;
      item.val = Math.min(600, n);
      // Coalesce active_sec for the same surface already sitting in queue
      const existing = queue.find((q) => q.event === 'active_sec' && q.dim === d);
      if (existing) {
        existing.val = Math.min(600, (existing.val || 0) + item.val);
        scheduleFlush(12000);
        return;
      }
    }
    queue.push(item);
    if (queue.length >= 10 || ev === 'signup' || ev === 'desktop_download' || ev === 'run_exit') {
      flush();
    } else {
      scheduleFlush(ev === 'active_sec' ? 12000 : 5500);
    }
  }

  // Detect active study surface accurately (Notes vs Runner vs Course Explorer vs PDF vs Exams vs Home)
  function currentSurface() {
    try {
      const pdfModal = document.getElementById('pdfcraft-overlay');
      if (pdfModal && !pdfModal.hidden) return 'pdf';
      const runnerView = document.getElementById('view-runner');
      if (runnerView && !runnerView.hidden) {
        const rc = window.StudyRunner?.getActiveCourseId?.() || '';
        return rc ? `runner:${rc}` : 'runner';
      }
      if (window.StudyUI?.isReferenceDrawerOpen?.()) return 'notes:drawer';
      const view = String(window.StudyApp?.getCurrentView?.() || 'home');
      const selC = window.StudyApp?.getSelectedCourseId?.() || '';
      if (view === 'references') return selC ? `notes:${selC}` : 'notes:hub';
      if (view === 'course') return selC ? `course:${selC}` : 'course';
      return view || 'home';
    } catch {
      return 'home';
    }
  }

  // Engaged active-time heartbeat (zero AFK inflation: requires visible tab + interaction within last 90s)
  let lastInputAt = Date.now();
  let lastTickAt = Date.now();
  let lastSurface = 'home';
  const markInput = () => {
    const now = Date.now();
    if (now - lastInputAt > 900) lastInputAt = now;
  };
  for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    window.addEventListener(evt, markInput, { passive: true, capture: true });
  }

  function recordActiveTick(forceFlush = false) {
    const now = Date.now();
    const dtSec = Math.round((now - lastTickAt) / 1000);
    lastTickAt = now;
    const surf = currentSurface();
    const activeSurface = lastSurface || surf;
    lastSurface = surf;
    if (document.visibilityState !== 'visible' && !forceFlush) return;
    if (dtSec >= 2 && dtSec <= 45 && (now - lastInputAt) <= 95_000) {
      track('active_sec', activeSurface, dtSec);
    }
    if (forceFlush) flush();
  }

  setInterval(() => recordActiveTick(false), 15_000);

  // Shared-link / WhatsApp landing attribution (strips PII, logs only structural landing type)
  function trackLandingAttribution() {
    try {
      const sp = new URLSearchParams(window.location.search || '');
      if (sp.has('playlist') || sp.has('shared')) {
        const c = sp.get('course') || '';
        track('link_land', c ? `shared_playlist:${c}` : 'shared_playlist');
      } else if (sp.get('course')) {
        const c = sp.get('course');
        const extra = sp.get('group') === '1' ? ':ch' : sp.get('preset') ? `:${sp.get('preset')}` : '';
        track('link_land', `course:${c}${extra}`);
      } else if (sp.get('ref') || sp.get('note')) {
        track('link_land', 'note_link');
      } else if (sp.get('view')) {
        track('link_land', `view:${sp.get('view')}`);
      } else if (sp.get('utm_source')) {
        track('link_land', `utm:${sp.get('utm_source')}`);
      }
    } catch {}
  }

  // Sanitized client runtime error beacon (zero PII/tokens — filename:line:errtype only, max 3/session)
  function shortErrorSig(src, line, msg) {
    const file = String(src || 'app').split('/').pop().split('?')[0].replace(/[^a-z0-9._-]/gi, '').slice(0, 24) || 'app';
    const ln = Number(line) > 0 ? Number(line) : 0;
    const kind = String(msg || 'err').split(':')[0].trim().replace(/[^a-z0-9_]/gi, '').slice(0, 24) || 'err';
    return `${file}:${ln}:${kind}`.toLowerCase();
  }
  window.addEventListener('error', (ev) => {
    if (errorBudget <= 0) return;
    errorBudget -= 1;
    track('client_error', shortErrorSig(ev.filename, ev.lineno, ev.error?.name || ev.message));
  });
  window.addEventListener('unhandledrejection', (ev) => {
    if (errorBudget <= 0) return;
    errorBudget -= 1;
    const reason = ev.reason;
    track('client_error', shortErrorSig('promise', 0, reason?.name || String(reason || 'reject')));
  });

  // Record initial page view + landing link attribution cleanly after first paint.
  setTimeout(() => {
    lastSurface = currentSurface();
    track('page_view', cleanPath());
    trackLandingAttribution();
    scheduleFlush(1800);
  }, 350);

  // Track Desktop Edition release download clicks anywhere on site.
  document.addEventListener('click', (ev) => {
    const link = ev.target?.closest?.('a[href*="Study-OS-Desktop-"]');
    if (!link) return;
    const href = String(link.getAttribute('href') || '');
    const platform = /windows/i.test(href) ? 'windows' : (/macos/i.test(href) ? 'macos' : 'other');
    track('desktop_download', platform);
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      recordActiveTick(true);
    } else {
      lastTickAt = Date.now();
      lastInputAt = Date.now();
    }
  });
  window.addEventListener('pagehide', () => recordActiveTick(true));

  return { enabled: true, track, flush };
})();
