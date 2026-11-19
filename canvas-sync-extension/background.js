const CANVAS_ORIGIN = 'https://canvas.bi.no';
const TIMEEDIT_ORIGIN = 'https://cloud.timeedit.net';
const ED_ORIGINS = new Set(['https://edstem.org', 'https://eu.edstem.org', 'https://us.edstem.org', 'https://au.edstem.org']);
const CLOUD_API = 'https://shadjosef-study-os.shadjosef-study-os.workers.dev';
const DESKTOP = 'http://127.0.0.1:8765';
let syncJob = null;

// Serialized into the open BI Canvas tab — reads courses, personal deadlines, and copyright-safe module titles.
async function collectCanvas() {
  const canvasOrigin = 'https://canvas.bi.no';
  const capturedAt = new Date().toISOString();
  if (location.origin !== canvasOrigin) return { error: 'Open your signed-in BI Canvas tab first.' };

  async function list(path, params, maximum) {
    let page = new URL(path, canvasOrigin);
    page.search = new URLSearchParams({ ...params, per_page: 100 });
    const seen = new Set();
    const rows = [];
    while (page) {
      if (page.origin !== canvasOrigin || page.pathname !== path || seen.has(page.href) || seen.size >= 55) {
        throw new Error('Canvas returned an unexpected next page. Try syncing again.');
      }
      seen.add(page.href);
      const response = await fetch(page, {
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403 ||
          (response.ok && !response.headers.get('Content-Type')?.includes('json'))) {
        throw new Error('Sign in to BI Canvas and open one of your courses, then try again.');
      }
      if (!response.ok) throw new Error('Canvas could not load the course list or assignments. Try again.');
      const items = JSON.parse((await response.text()).replace(/^\s*while\s*\(1\)\s*;\s*/, ''));
      if (!Array.isArray(items) || rows.length + items.length > maximum) {
        throw new Error('Canvas returned an invalid list or too many items for one sync.');
      }
      rows.push(...items);
      const next = response.headers.get('Link')?.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?(?=\s*[,;]|\s*$)/i)?.[1];
      page = next ? new URL(next, page) : null;
    }
    return rows;
  }

  function id(value) {
    const result = String(value);
    if (!/^[1-9]\d{0,19}$/.test(result)) throw new Error('Canvas returned an invalid course or assignment ID.');
    return result;
  }

  try {
    const all = await list('/api/v1/courses', { enrollment_type: 'student', enrollment_state: 'active' }, 80);
    const courses = all
      .filter((course) => typeof course.name === 'string' && course.name.trim())
      .map((course) => ({
        id: id(course.id),
        name: course.name.trim().slice(0, 300),
        code: [course.course_code, course.name]
          .map((text) => (typeof text === 'string' ? text.match(/\b([A-Z]{2,6})\s*[-_]?\s*(\d{3,6})(?!\d)\b/i)?.slice(1).join('').toUpperCase() : ''))
          .find(Boolean) || '',
        topics: [],
        assignments: [],
      }));

    let remaining = 4000;
    for (const course of courses) {
      try {
        const assignments = await list(`/api/v1/courses/${course.id}/assignments`, {}, remaining);
        course.assignments = assignments.map((assignment) => ({
          id: id(assignment.id),
          name: assignment.name?.trim().slice(0, 300),
          dueAt: assignment.due_at ?? null,
        }));
        remaining -= course.assignments.length;
      } catch {}

      try {
        const modules = await list(`/api/v1/courses/${course.id}/modules`, {}, 40);
        course.topics = modules
          .map((m) => (typeof m?.name === 'string' ? m.name.trim().slice(0, 100) : ''))
          .filter(Boolean)
          .slice(0, 35);
      } catch {}
    }
    return { snapshot: { version: 2, canvasOrigin, capturedAt, courses } };
  } catch (error) {
    return {
      error: error.name === 'TimeoutError' || error instanceof TypeError || error instanceof SyntaxError
        ? 'Canvas could not load your courses. Check the Canvas tab and try again.'
        : error.message,
    };
  }
}

// Serialized into the open BI TimeEdit tab — extracts the .ics timetable feed directly.
async function collectTimeEdit() {
  if (location.origin !== 'https://cloud.timeedit.net') {
    return { error: 'Open your BI TimeEdit timetable tab first.' };
  }
  const candidates = new Set();
  const addCandidate = (raw) => {
    if (typeof raw !== 'string') return;
    const clean = raw.trim().replace(/^webcal:/i, 'https:');
    if (!clean) return;
    try {
      const u = new URL(clean, location.href);
      if (u.origin === 'https://cloud.timeedit.net' && /\.ics(\?|$)/i.test(u.pathname + u.search)) {
        candidates.add(u.href);
      }
    } catch {}
  };

  document.querySelectorAll('a[href*=".ics"], input[value*=".ics"], textarea').forEach((el) => {
    const val = el.getAttribute('href') || el.value || el.textContent || '';
    const matches = val.match(/(?:https?|webcal):\/\/cloud\.timeedit\.net\/[^\s"'<>]+\.ics/gi) || [];
    matches.forEach(addCandidate);
    if (el.tagName === 'A') addCandidate(el.getAttribute('href'));
  });

  // Also scan raw page text/scripts for an embedded .ics subscription link
  const htmlMatches = document.documentElement.innerHTML.match(/(?:https?|webcal):\/\/cloud\.timeedit\.net\/[^\s"'<>\\]+\.ics/gi) || [];
  htmlMatches.slice(0, 8).forEach(addCandidate);

  // TimeEdit schedule views (*.html) serve their exact iCal feed at the same path with .ics!
  if (/\.html$/i.test(location.pathname)) {
    const derived = new URL(location.href);
    derived.pathname = derived.pathname.replace(/\.html$/i, '.ics');
    derived.hash = '';
    candidates.add(derived.href);
  }

  for (const href of candidates) {
    try {
      const res = await fetch(href, {
        credentials: 'same-origin',
        headers: { Accept: 'text/calendar, text/plain' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (/^\s*BEGIN:VCALENDAR/i.test(text)) {
        return { calendar: text, sourceUrl: href };
      }
    } catch {}
  }

  return {
    error: 'Open your actual BI TimeEdit schedule view (after selecting your courses / "Show schedule"), then click Sync again.',
  };
}

// Serialized into the open Ed Discussion tab — reads active course metadata (no private posts/files).
async function collectEd() {
  const host = location.hostname.toLowerCase();
  const capturedAt = new Date().toISOString();
  try {
    const res = await fetch('/api/user', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { error: 'Sign in to Ed Discussion in this tab, then click Sync again.' };
    }
    if (!res.ok) return { error: 'Could not read your Ed Discussion courses. Try refreshing the Ed tab.' };
    const payload = await res.json();
    const rawCourses = Array.isArray(payload?.courses) ? payload.courses : [];
    const courses = rawCourses
      .map((entry) => entry?.course || entry)
      .filter((c) => c && c.id && c.name && c.status !== 'archived')
      .slice(0, 60)
      .map((c) => {
        const codeMatch = [c.code, c.name]
          .map((t) => (typeof t === 'string' ? t.match(/\b([A-Z]{2,6})\s*[-_]?\s*(\d{3,6})(?!\d)\b/i)?.slice(1).join('').toUpperCase() : ''))
          .find(Boolean) || '';
        const categories = Array.isArray(c?.settings?.discussion?.categories)
          ? c.settings.discussion.categories.map((cat) => cat?.name).filter(Boolean).slice(0, 25)
          : [];
        return {
          id: String(c.id),
          name: String(c.name).trim().slice(0, 160),
          code: codeMatch,
          host,
          topics: categories,
        };
      });
    if (!courses.length) {
      return { error: 'No active Ed Discussion courses found on this account.' };
    }
    return { capturedAt, courses };
  } catch {
    return { error: 'Could not read Ed Discussion. Refresh the Ed tab and try again.' };
  }
}

async function cloudRequest(path, body, token) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Study-OS-Client': 'extension',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${CLOUD_API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'omit',
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Study-OS sync failed (HTTP ${response.status}).`);
    error.needsPair = response.status === 401;
    throw error;
  }
  return result;
}

async function desktopRequest(action, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${DESKTOP}/api/canvas/browser/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'omit',
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    return null;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'Desktop Study-OS connection expired.');
    error.needsDesktopPair = action === 'snapshot' && response.status === 403;
    throw error;
  }
  return result;
}

function detectSite(urlStr) {
  if (!urlStr) return 'other';
  try {
    const u = new URL(urlStr);
    if (u.origin === CANVAS_ORIGIN) return 'canvas';
    if (u.origin === TIMEEDIT_ORIGIN) return 'timeedit';
    if (ED_ORIGINS.has(u.origin)) return 'ed';
  } catch {}
  return 'other';
}

async function runSync(tabId, site, sharePublic) {
  const stored = await chrome.storage.local.get(['cloudToken', 'token']);
  const cloudToken = stored.cloudToken || '';
  const desktopToken = stored.token || '';

  if (site === 'canvas') {
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: collectCanvas });
    if (!result || result.error) throw new Error(result?.error || 'Canvas closed during sync. Try again.');

    let cloudSummary = null;
    if (cloudToken) {
      cloudSummary = await cloudRequest('/courses/sync', {
        source: 'canvas',
        sharePublic,
        capturedAt: result.snapshot.capturedAt,
        courses: result.snapshot.courses,
      }, cloudToken);
    }
    let desktopSummary = null;
    if (desktopToken) {
      desktopSummary = await desktopRequest('snapshot', result.snapshot, desktopToken).catch(() => null);
    }
    if (!cloudSummary && !desktopSummary) {
      throw new Error('Connect your Study-OS account first (paste a 6-char device code from studyos.no).');
    }
    return {
      site: 'canvas',
      courses: cloudSummary?.syncedCourses ?? desktopSummary?.courses ?? result.snapshot.courses.length,
      deadlines: cloudSummary?.deadlineCount ?? desktopSummary?.assignments ?? 0,
      createdCount: cloudSummary?.createdCount ?? 0,
      updatedCount: cloudSummary?.updatedCount ?? 0,
      sharedPublic: Boolean(cloudSummary?.sharedPublic),
      syncedDesktop: Boolean(desktopSummary),
    };
  }

  if (site === 'timeedit') {
    if (!cloudToken) {
      throw new Error('Link your studyos.no profile (6-char device code) to sync TimeEdit across devices.');
    }
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: collectTimeEdit });
    if (!result || result.error) throw new Error(result?.error || 'Could not read TimeEdit schedule.');
    const pushed = await cloudRequest('/schedule/timeedit-push', {
      calendar: result.calendar,
      sourceUrl: result.sourceUrl || '',
    }, cloudToken);
    return {
      site: 'timeedit',
      eventCount: pushed.eventCount || 0,
    };
  }

  if (site === 'ed') {
    if (!cloudToken) {
      throw new Error('Link your studyos.no profile (6-char device code) to sync Ed Discussion courses.');
    }
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: collectEd });
    if (!result || result.error) throw new Error(result?.error || 'Could not read Ed Discussion courses.');
    const pushed = await cloudRequest('/courses/sync', {
      source: 'ed',
      sharePublic,
      capturedAt: result.capturedAt,
      courses: result.courses,
    }, cloudToken);
    return {
      site: 'ed',
      courses: pushed.syncedCourses || result.courses.length,
      createdCount: pushed.createdCount || 0,
      updatedCount: pushed.updatedCount || 0,
      sharedPublic: Boolean(pushed.sharedPublic),
    };
  }

  return { state: 'openSite' };
}

async function handle(message) {
  if (message.action === 'status') {
    const stored = await chrome.storage.local.get(['cloudToken', 'cloudNickname', 'token', 'sharePublic']);
    const tab = Number.isInteger(message.tabId) ? await chrome.tabs.get(message.tabId).catch(() => null) : null;
    return {
      connectedCloud: Boolean(stored.cloudToken),
      nickname: stored.cloudNickname || '',
      connectedDesktop: Boolean(stored.token),
      sharePublic: stored.sharePublic !== false,
      site: detectSite(tab?.url || ''),
    };
  }

  if (message.action === 'setSharePublic') {
    await chrome.storage.local.set({ sharePublic: Boolean(message.sharePublic) });
    return { ok: true };
  }

  if (message.action === 'disconnect') {
    await chrome.storage.local.remove(['cloudToken', 'cloudNickname', 'token']);
    return { ok: true };
  }

  if (message.action === 'link') {
    const raw = String(message.code || '').trim();
    const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^[A-Z2-9]{6}$/.test(compact)) {
      const res = await cloudRequest('/auth/extension-link', {
        code: compact,
        label: 'Study-OS Sync Extension',
      });
      await chrome.storage.local.set({
        cloudToken: res.token,
        cloudNickname: res.nickname || 'Study-OS',
      });
      return { state: 'linked', mode: 'cloud', nickname: res.nickname || '' };
    }
    if (/^[A-Za-z0-9_-]{20,64}$/.test(raw)) {
      const linked = await desktopRequest('link', { code: raw });
      if (!linked || !/^[A-Za-z0-9_-]{43}$/.test(linked.token)) {
        throw new Error('Open desktop Study-OS (127.0.0.1:8765) or use a 6-char device code from studyos.no.');
      }
      await chrome.storage.local.set({ token: linked.token });
      return { state: 'linked', mode: 'desktop' };
    }
    throw new Error('Enter a 6-character Study-OS device code (e.g. K7M-9P2) or 24-char desktop code.');
  }

  if (message.action !== 'sync') return { error: 'Unknown action.' };
  const stored = await chrome.storage.local.get(['cloudToken', 'token', 'sharePublic']);
  if (!stored.cloudToken && !stored.token) return { state: 'pair' };

  const tab = Number.isInteger(message.tabId) ? await chrome.tabs.get(message.tabId).catch(() => null) : null;
  const site = detectSite(tab?.url || '');
  if (site === 'other') return { state: 'openSite' };

  const sharePublic = typeof message.sharePublic === 'boolean' ? message.sharePublic : stored.sharePublic !== false;
  if (!syncJob) syncJob = runSync(message.tabId, site, sharePublic).finally(() => { syncJob = null; });
  return { state: 'synced', summary: await syncJob };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== chrome.runtime.getURL('popup.html')) return false;
  handle(message).then(respond, async (error) => {
    if (error.needsPair) await chrome.storage.local.remove(['cloudToken', 'cloudNickname']);
    if (error.needsDesktopPair) await chrome.storage.local.remove('token');
    respond({ error: error.message, needsPair: Boolean(error.needsPair) });
  });
  return true;
});
