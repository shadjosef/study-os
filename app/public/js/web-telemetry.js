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

  function track(event, dim = '') {
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
    queue.push({ event: ev, dim: d });
    if (queue.length >= 10 || ev === 'signup' || ev === 'desktop_download') {
      flush();
    } else {
      scheduleFlush(5500);
    }
  }

  // Record initial page view cleanly after first paint.
  setTimeout(() => {
    track('page_view', cleanPath());
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
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);

  return { enabled: true, track, flush };
})();
