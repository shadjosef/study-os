const CANVAS_ORIGIN = 'https://canvas.bi.no';
const TIMEEDIT_ORIGIN = 'https://cloud.timeedit.net';
const ED_ORIGINS = new Set(['https://edstem.org', 'https://eu.edstem.org', 'https://us.edstem.org', 'https://au.edstem.org']);
const CLOUD_API = 'https://shadjosef-study-os.shadjosef-study-os.workers.dev';
const DESKTOP = 'http://127.0.0.1:8765';
const TARGET_URL_PATTERNS = [
  'https://canvas.bi.no/*',
  'https://cloud.timeedit.net/*',
  'https://edstem.org/*',
  'https://eu.edstem.org/*',
  'https://us.edstem.org/*',
  'https://au.edstem.org/*',
];
const AUTO_SYNC_COOLDOWN_MS = {
  canvas: 12 * 60 * 60 * 1000,   // 12 hours
  ed: 12 * 60 * 60 * 1000,       // 12 hours
  timeedit: 72 * 60 * 60 * 1000, // 3 days
};
let syncJob = null;
const autoSyncTimers = new Map();
const autoSyncInFlight = new Set();

// Runs inside the user's already signed-in BI Canvas tab using browser same-origin cookies.
// Never extracts, copies, or transmits raw Canvas session tokens.
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
        throw new Error('Sign in to BI Canvas in that tab, then click Sync again.');
      }
      if (!response.ok) throw new Error('Canvas could not load courses or assignments.');
      const items = JSON.parse((await response.text()).replace(/^\s*while\s*\(1\)\s*;\s*/, ''));
      if (!Array.isArray(items) || rows.length + items.length > maximum) {
        throw new Error('Canvas returned an invalid list or too many items.');
      }
      rows.push(...items);
      const next = response.headers.get('Link')?.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?(?=\s*[,;]|\s*$)/i)?.[1];
      page = next ? new URL(next, page) : null;
    }
    return rows;
  }

  function id(value) {
    const result = String(value);
    if (!/^[1-9]\d{0,19}$/.test(result)) throw new Error('Canvas returned an invalid ID.');
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
        ? 'Could not load BI Canvas. Make sure you are signed in.'
        : error.message,
    };
  }
}

// Runs inside the open BI TimeEdit tab — extracts the .ics timetable feed with the most VEVENTs.
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

  // 1. Prefer the exact current schedule URL converted from .html -> .ics (preserving query params!)
  if (/\.html$/i.test(location.pathname)) {
    const derived = new URL(location.href);
    derived.pathname = derived.pathname.replace(/\.html$/i, '.ics');
    derived.hash = '';
    candidates.add(derived.href);
  }

  // 2. Scan links, subscription inputs, textareas, and data attributes
  document.querySelectorAll('a[href*=".ics"], input[value*=".ics"], textarea, [data-url*=".ics"], [data-href*=".ics"]').forEach((el) => {
    const val = el.getAttribute('href') || el.getAttribute('data-url') || el.getAttribute('data-href') || el.value || el.textContent || '';
    const matches = val.match(/(?:https?|webcal):\/\/cloud\.timeedit\.net\/[^\s"'<>]+\.ics(?:\?[^\s"'<>]*)?/gi) || [];
    matches.forEach(addCandidate);
    if (el.tagName === 'A') addCandidate(el.getAttribute('href'));
  });

  // 3. Scan page HTML for any TimeEdit .ics subscription URLs (including query params)
  const htmlMatches = document.documentElement.innerHTML.match(/(?:https?|webcal):\/\/cloud\.timeedit\.net\/[^\s"'<>\\]+\.ics(?:\?[^\s"'<>\\]*)?/gi) || [];
  htmlMatches.slice(0, 12).forEach(addCandidate);

  // 4. Also check TimeEdit's subscribe/iCal path pattern (e.g. /ri...html -> /ri...ics)
  const riMatches = document.documentElement.innerHTML.match(/\/ri[A-Za-z0-9_-]{8,}\.ics/g) || [];
  riMatches.slice(0, 6).forEach((rel) => {
    try {
      const base = location.pathname.replace(/[^/]*$/, '');
      addCandidate(new URL(base + rel.replace(/^\//, ''), location.origin).href);
    } catch {}
  });

  let best = null;
  let sawEmptyCalendar = false;
  for (const href of candidates) {
    try {
      const res = await fetch(href, {
        credentials: 'same-origin',
        headers: { Accept: 'text/calendar, text/plain' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!/^\s*BEGIN:VCALENDAR/i.test(text)) continue;
      const count = (text.match(/BEGIN:VEVENT/gi) || []).length;
      if (count > 0 && (!best || count > best.count)) {
        best = { calendar: text, sourceUrl: href, count };
      } else if (count === 0) {
        sawEmptyCalendar = true;
      }
    } catch {}
  }

  if (best) return { calendar: best.calendar, sourceUrl: best.sourceUrl, count: best.count };

  if (sawEmptyCalendar) {
    return {
      error: 'TimeEdit returned 0 classes on this view. Select your courses on TimeEdit, click "Show schedule", then click Sync again.',
    };
  }
  return {
    error: 'Open your BI TimeEdit schedule view ("Show schedule"), then click Sync again.',
  };
}

// Runs inside the open Ed Discussion tab — detects region, reads ephemeral session JWT (used only in-memory
// to call Ed's regional /api/user, never saved or transmitted to Study-OS), and scrapes visible course links as fallback.
function collectEdTabContext() {
  const host = location.hostname.toLowerCase();
  const pathRegion = location.pathname.match(/^\/(eu|us|au)(?:\/|$)/i)?.[1]?.toLowerCase() || '';
  const hostRegion = host.match(/^(eu|us|au)\.edstem\.org$/)?.[1] || '';
  const region = hostRegion || pathRegion || 'eu';

  const tokens = new Set();
  const extractTokens = (storage) => {
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i) || '';
        const v = storage.getItem(k) || '';
        if (!v) continue;
        // Direct JWT or quoted JWT
        const stripped = v.trim().replace(/^"|"$/g, '');
        if (/^eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(stripped)) {
          tokens.add(stripped);
          continue;
        }
        // Ed stores authToken / token inside JSON objects in localStorage
        if (/(token|auth|session|ed)/i.test(k) && stripped.length < 4000) {
          const jwtHits = stripped.match(/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || [];
          jwtHits.forEach((t) => tokens.add(t));
          try {
            const parsed = JSON.parse(stripped);
            for (const cand of [parsed?.token, parsed?.authToken, parsed?.auth_token, parsed?.access_token]) {
              if (typeof cand === 'string' && cand.length >= 20 && cand.length <= 1024) tokens.add(cand);
            }
          } catch {}
        }
      }
    } catch {}
  };
  extractTokens(localStorage);
  extractTokens(sessionStorage);

  // Fallback: scrape visible course links from DOM (e.g. /eu/courses/12345)
  const domCourses = [];
  const seenIds = new Set();
  document.querySelectorAll('a[href*="/courses/"]').forEach((a) => {
    const m = (a.getAttribute('href') || '').match(/\/courses\/(\d+)/);
    if (!m || seenIds.has(m[1])) return;
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) return;
    seenIds.add(m[1]);
    const codeMatch = text.match(/\b([A-Z]{2,6})\s*[-_]?\s*(\d{3,6})(?!\d)\b/i);
    domCourses.push({
      id: m[1],
      name: text.slice(0, 160),
      code: codeMatch ? (codeMatch[1] + codeMatch[2]).toUpperCase() : '',
      host,
      topics: [],
    });
  });

  return { region, host, tokens: Array.from(tokens).slice(0, 4), domCourses };
}

async function fetchEdCoursesFromContext(ctx) {
  const capturedAt = new Date().toISOString();
  const regions = [...new Set([ctx?.region || 'eu', 'eu', 'us', 'au', ''])];
  const tokens = Array.isArray(ctx?.tokens) ? ctx.tokens : [];

  const parseEdPayload = (payload, host) => {
    const rawCourses = Array.isArray(payload?.courses) ? payload.courses : [];
    return rawCourses
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
  };

  for (const reg of regions) {
    const apiHost = reg ? `${reg}.edstem.org` : 'edstem.org';
    const url = `https://${apiHost}/api/user`;
    const attempts = tokens.length ? [...tokens.map((t) => ({ 'x-token': t })), {}] : [{}];
    for (const authHeaders of attempts) {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json', ...authHeaders },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) continue;
        const payload = await res.json().catch(() => null);
        const courses = parseEdPayload(payload, apiHost);
        if (courses.length) return { capturedAt, courses };
      } catch {}
    }
  }

  if (Array.isArray(ctx?.domCourses) && ctx.domCourses.length) {
    return { capturedAt, courses: ctx.domCourses };
  }
  return {
    error: 'Could not read Ed courses — open "My Courses" in your signed-in Ed Discussion tab, then click Sync again.',
  };
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

async function findOpenStudyTabs() {
  const tabs = await chrome.tabs.query({ url: TARGET_URL_PATTERNS }).catch(() => []);
  const found = { canvas: null, timeedit: null, ed: null };
  // Prefer active tab in current window, then most recently accessed / schedule-view TimeEdit tabs
  const sorted = [...tabs].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.lastAccessed && b.lastAccessed) return b.lastAccessed - a.lastAccessed;
    return 0;
  });
  for (const tab of sorted) {
    const site = detectSite(tab.url || '');
    if (!site || site === 'other') continue;
    if (!found[site]) {
      found[site] = tab;
    } else if (site === 'timeedit' && /\.html(\?|$)/i.test(tab.url || '') && !/\.html(\?|$)/i.test(found[site].url || '')) {
      found[site] = tab;
    }
  }
  return found;
}

async function syncSingleSite(tabId, site, sharePublic, cloudToken, desktopToken) {
  if (site === 'canvas') {
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: collectCanvas });
    if (!result || result.error) throw new Error(result?.error || 'BI Canvas tab closed during sync.');

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
      throw new Error('Pair your Study-OS account first (paste a 6-char code from studyos.no).');
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
      throw new Error('Link your studyos.no profile (6-char code) to sync TimeEdit.');
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
      throw new Error('Link your studyos.no profile (6-char code) to sync Ed Discussion.');
    }
    const [{ result: ctx } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: collectEdTabContext });
    const result = await fetchEdCoursesFromContext(ctx || {});
    if (!result || result.error) throw new Error(result?.error || 'Could not read Ed Discussion.');
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

  throw new Error('Unsupported tab.');
}

async function recordSiteSync(site) {
  const { lastSiteSyncAt = {} } = await chrome.storage.local.get(['lastSiteSyncAt']);
  const next = { ...lastSiteSyncAt, [site]: Date.now() };
  await chrome.storage.local.set({ lastSiteSyncAt: next });
  return next;
}

async function notifyStudyOsTabs(results = []) {
  try {
    const tabs = await chrome.tabs.query({
      url: [
        'https://studyos.no/*',
        'https://shadjosef.github.io/*',
        'http://127.0.0.1/*',
        'http://localhost/*',
      ],
    });
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'syncComplete', results }).catch(() => {});
    }
  } catch {}
}

function bytesToBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

// Fetches a BI Canvas PDF directly using the student's own signed-in Chrome session.
// Bytes return strictly to the student's local studyos.no tab (never uploaded to any server).
async function fetchCanvasFileDirect(courseId, fileId) {
  if (!/^\d{1,12}$/.test(String(courseId)) || !/^\d{1,12}$/.test(String(fileId))) {
    throw new Error('Invalid BI Canvas file reference.');
  }
  let signedUrl = '';
  let apiFilename = '';
  try {
    const metaRes = await fetch(`${CANVAS_ORIGIN}/api/v1/courses/${courseId}/files/${fileId}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (metaRes.status === 401 || metaRes.status === 403) {
      throw new Error('Sign in to BI Canvas (canvas.bi.no) in Chrome first, then click Retry inline.');
    }
    if (metaRes.ok) {
      const meta = await metaRes.json().catch(() => null);
      if (meta?.url) signedUrl = String(meta.url);
      if (meta?.display_name || meta?.filename) apiFilename = String(meta.display_name || meta.filename);
    }
  } catch (err) {
    if (/sign in to bi canvas/i.test(String(err?.message || ''))) throw err;
  }

  const targetUrl = signedUrl || `${CANVAS_ORIGIN}/courses/${courseId}/files/${fileId}/download?download_frd=1`;
  const isSameOrigin = targetUrl.startsWith(CANVAS_ORIGIN);
  const res = await fetch(targetUrl, {
    credentials: isSameOrigin ? 'include' : 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 401 || res.status === 403 || /login|saml|microsoftonline/i.test(res.url || '')) {
    throw new Error('Sign in to BI Canvas (canvas.bi.no) in Chrome first, then click Retry inline.');
  }
  if (!res.ok) throw new Error(`BI Canvas returned HTTP ${res.status}. Open BI Canvas to refresh your login.`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 60 * 1024 * 1024) throw new Error('PDF exceeds 60 MB direct-fetch limit. Download and drop it locally instead.');
  const bytes = new Uint8Array(buf);
  const sig = String.fromCharCode(...bytes.subarray(0, 5));
  if (sig !== '%PDF-') {
    throw new Error('BI Canvas returned a login or preview page instead of a PDF. Sign in to canvas.bi.no in Chrome first.');
  }
  const disp = res.headers.get('Content-Disposition') || '';
  const nameMatch = disp.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filename = apiFilename || (nameMatch ? decodeURIComponent(nameMatch[1] || nameMatch[2] || '') : `canvas-${fileId}.pdf`);
  return { ok: true, filename, dataBase64: bytesToBase64(bytes) };
}

async function flashSuccessBadge() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    await chrome.action.setBadgeText({ text: '✓' });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' }).catch(() => {});
    }, 5000);
  } catch {}
}

async function maybeAutoSyncTab(tabId, urlStr) {
  const site = detectSite(urlStr);
  if (!site || site === 'other') return;
  // Skip login / auth redirect URLs on BI Canvas or Ed
  if (/\/(login|oauth|saml|sso|auth)\b/i.test(urlStr)) return;
  if (autoSyncInFlight.has(site) || syncJob) return;

  const stored = await chrome.storage.local.get([
    'cloudToken',
    'token',
    'sharePublic',
    'autoSyncEnabled',
    'lastSiteSyncAt',
  ]);
  if (stored.autoSyncEnabled === false) return;
  const cloudToken = stored.cloudToken || '';
  const desktopToken = stored.token || '';
  if (!cloudToken && !(site === 'canvas' && desktopToken)) return;

  const lastAt = Number(stored.lastSiteSyncAt?.[site] || 0);
  const cooldown = AUTO_SYNC_COOLDOWN_MS[site] || (12 * 60 * 60 * 1000);
  if (Date.now() - lastAt < cooldown) return;

  autoSyncInFlight.add(site);
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || detectSite(tab.url || '') !== site) return;
    const sharePublic = stored.sharePublic !== false;
    const summary = await syncSingleSite(tabId, site, sharePublic, cloudToken, desktopToken);
    await recordSiteSync(site);
    await flashSuccessBadge();
    await notifyStudyOsTabs([{ site, ok: true, summary }]);
  } catch (err) {
    if (err?.needsPair) {
      await chrome.storage.local.remove(['cloudToken', 'cloudNickname']).catch(() => {});
    }
    // Fail silently in background if user isn't logged in on that BI tab yet
  } finally {
    autoSyncInFlight.delete(site);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const urlStr = tab?.url || changeInfo.url || '';
  const site = detectSite(urlStr);
  if (!site || site === 'other') return;
  if (autoSyncTimers.has(site)) clearTimeout(autoSyncTimers.get(site));
  const timer = setTimeout(() => {
    autoSyncTimers.delete(site);
    maybeAutoSyncTab(tabId, urlStr);
  }, 2500);
  autoSyncTimers.set(site, timer);
});

async function runSyncAll(sharePublic) {
  const stored = await chrome.storage.local.get(['cloudToken', 'token']);
  const cloudToken = stored.cloudToken || '';
  const desktopToken = stored.token || '';
  if (!cloudToken && !desktopToken) return { state: 'pair' };

  const openTabs = await findOpenStudyTabs();
  const targets = ['canvas', 'timeedit', 'ed'].filter((k) => Boolean(openTabs[k]?.id));
  if (!targets.length) return { state: 'openSite' };

  const results = [];
  for (const site of targets) {
    try {
      const summary = await syncSingleSite(openTabs[site].id, site, sharePublic, cloudToken, desktopToken);
      await recordSiteSync(site);
      results.push({ site, ok: true, summary });
    } catch (err) {
      if (err.needsPair) throw err;
      results.push({ site, ok: false, error: err.message || 'Sync failed.' });
    }
  }
  if (results.some((r) => r.ok)) {
    await flashSuccessBadge();
    await notifyStudyOsTabs(results);
  }
  return { state: 'synced', results };
}

async function handle(message) {
  if (message.action === 'status') {
    const stored = await chrome.storage.local.get([
      'cloudToken',
      'cloudNickname',
      'token',
      'sharePublic',
      'autoSyncEnabled',
      'lastSiteSyncAt',
    ]);
    const openTabs = await findOpenStudyTabs();
    return {
      connectedCloud: Boolean(stored.cloudToken),
      nickname: stored.cloudNickname || '',
      connectedDesktop: Boolean(stored.token),
      sharePublic: stored.sharePublic !== false,
      autoSyncEnabled: stored.autoSyncEnabled !== false,
      lastSiteSyncAt: stored.lastSiteSyncAt || {},
      openSites: {
        canvas: Boolean(openTabs.canvas),
        timeedit: Boolean(openTabs.timeedit),
        ed: Boolean(openTabs.ed),
      },
    };
  }

  if (message.action === 'setSharePublic') {
    await chrome.storage.local.set({ sharePublic: Boolean(message.sharePublic) });
    return { ok: true };
  }

  if (message.action === 'setAutoSync') {
    await chrome.storage.local.set({ autoSyncEnabled: Boolean(message.autoSyncEnabled) });
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
    throw new Error('Enter a 6-character Study-OS pairing code (e.g. K7M-9P2).');
  }

  if (message.action === 'syncAll' || message.action === 'sync') {
    const stored = await chrome.storage.local.get(['cloudToken', 'token', 'sharePublic']);
    if (!stored.cloudToken && !stored.token) return { state: 'pair' };
    const sharePublic = typeof message.sharePublic === 'boolean' ? message.sharePublic : stored.sharePublic !== false;
    if (!syncJob) syncJob = runSyncAll(sharePublic).finally(() => { syncJob = null; });
    return await syncJob;
  }

  return { error: 'Unknown action.' };
}

const BRIDGE_ORIGINS = new Set([
  'https://studyos.no',
  'https://shadjosef.github.io',
]);

function isTrustedBridgeSender(sender) {
  try {
    const u = new URL(sender?.url || '');
    return BRIDGE_ORIGINS.has(u.origin) || u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.action === 'fetchCanvasFile' && isTrustedBridgeSender(sender)) {
    fetchCanvasFileDirect(message.courseId, message.fileId).then(respond, (error) => {
      respond({ ok: false, error: error?.message || 'Could not load PDF from BI Canvas.' });
    });
    return true;
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) return false;
  handle(message).then(respond, async (error) => {
    if (error.needsPair) await chrome.storage.local.remove(['cloudToken', 'cloudNickname']);
    if (error.needsDesktopPair) await chrome.storage.local.remove('token');
    respond({ error: error.message, needsPair: Boolean(error.needsPair) });
  });
  return true;
});
