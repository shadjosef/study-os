const DEFAULT_CANVAS_ORIGIN = 'https://canvas.bi.no';
const TIMETABLE_ORIGINS = new Set([
  'https://cloud.timeedit.net',
  'https://tp.educloud.no',
  'https://tp.uio.no',
]);
const ED_ORIGINS = new Set(['https://edstem.org', 'https://eu.edstem.org', 'https://us.edstem.org', 'https://au.edstem.org']);
const CLOUD_API = 'https://shadjosef-study-os.shadjosef-study-os.workers.dev';
const DESKTOP = 'http://127.0.0.1:8765';

const KNOWN_CANVAS_SCHOOLS = {
  'canvas.bi.no': 'BI Oslo',
  'bi.instructure.com': 'BI Oslo',
  'uia.instructure.com': 'UiA',
  'canvas.uia.no': 'UiA',
  'mitt.uib.no': 'UiB',
  'uib.instructure.com': 'UiB',
  'uio.instructure.com': 'UiO',
  'canvas.uio.no': 'UiO',
  'ntnu.instructure.com': 'NTNU',
  'canvas.ntnu.no': 'NTNU',
  'oslomet.instructure.com': 'OsloMet',
  'canvas.oslomet.no': 'OsloMet',
  'nhh.instructure.com': 'NHH',
  'canvas.nhh.no': 'NHH',
  'uis.instructure.com': 'UiS',
  'canvas.uis.no': 'UiS',
  'uit.instructure.com': 'UiT',
  'canvas.uit.no': 'UiT',
  'usn.instructure.com': 'USN',
  'canvas.usn.no': 'USN',
  'nmbu.instructure.com': 'NMBU',
  'canvas.nmbu.no': 'NMBU',
  'hvl.instructure.com': 'HVL',
  'canvas.hvl.no': 'HVL',
  'kristiania.instructure.com': 'Kristiania',
  'canvas.kristiania.no': 'Kristiania',
};

const INSTRUCTURE_SKIP_SUBS = new Set(['login', 'sso', 'sso-login', 'cdn', 'canvas-cdn', 'community', 'www', 'status']);

function isCanvasOrigin(originStr) {
  if (typeof originStr !== 'string' || !originStr) return false;
  try {
    const u = new URL(originStr);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (KNOWN_CANVAS_SCHOOLS[host]) return true;
    const m = host.match(/^([a-z0-9-]+)\.instructure\.com$/);
    if (m && !INSTRUCTURE_SKIP_SUBS.has(m[1])) return true;
  } catch {}
  return false;
}

function schoolLabelForOrigin(originStr) {
  try {
    const host = new URL(originStr).hostname.toLowerCase();
    if (KNOWN_CANVAS_SCHOOLS[host]) return KNOWN_CANVAS_SCHOOLS[host];
    const m = host.match(/^([a-z0-9-]+)\.instructure\.com$/);
    if (m) {
      const sub = m[1];
      return sub.length <= 4 ? sub.toUpperCase() : sub.charAt(0).toUpperCase() + sub.slice(1);
    }
  } catch {}
  return 'Canvas';
}

const TARGET_URL_PATTERNS = [
  'https://canvas.bi.no/*',
  'https://*.instructure.com/*',
  'https://canvas.uia.no/*',
  'https://mitt.uib.no/*',
  'https://canvas.uio.no/*',
  'https://canvas.ntnu.no/*',
  'https://canvas.oslomet.no/*',
  'https://canvas.nhh.no/*',
  'https://canvas.uis.no/*',
  'https://canvas.uit.no/*',
  'https://canvas.usn.no/*',
  'https://canvas.nmbu.no/*',
  'https://canvas.hvl.no/*',
  'https://canvas.kristiania.no/*',
  'https://cloud.timeedit.net/*',
  'https://tp.educloud.no/*',
  'https://tp.uio.no/*',
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

// Runs inside the user's already signed-in Canvas LMS tab (BI, UiA, NHH, UiO, NTNU, UiB, or any *.instructure.com).
// Uses browser same-origin cookies — never extracts, copies, or transmits raw Canvas session tokens.
async function collectCanvas() {
  const canvasOrigin = location.origin;
  const host = location.hostname.toLowerCase();
  const capturedAt = new Date().toISOString();
  const validHost = location.protocol === 'https:' && (
    host === 'canvas.bi.no' ||
    host === 'mitt.uib.no' ||
    /^canvas\.[a-z0-9-]+\.no$/.test(host) ||
    /^[a-z0-9-]+\.instructure\.com$/.test(host)
  );
  if (!validHost) return { error: 'Open your signed-in Canvas LMS tab first.' };

  const CODE_3_6 = /(?:^|[^A-Za-z0-9ÆØÅæøå])([A-Za-zÆØÅæøå]{2,6})(?:\s*[-_]\s*|\s?)(\d{3,6})(?!\d)/;
  const CODE_2 = /(?:^|[^A-Za-z0-9ÆØÅæøå])([A-Za-zÆØÅæøå]{2,6})[-_]?(\d{2})(?![A-Za-z0-9ÆØÅæøå])/;
  const SKIP_2 = new Set(['WEEK', 'UKE', 'KAP', 'DEL', 'PART', 'MOD', 'SEM', 'DAG', 'DAY', 'TEMA', 'LEC', 'LAB', 'SET', 'CH', 'NO', 'NR', 'VG', 'H2', 'V2']);

  function extractCode(courseCode, courseName) {
    for (const text of [courseCode, courseName]) {
      if (typeof text !== 'string' || !text.trim()) continue;
      const m3 = text.match(CODE_3_6);
      if (m3) return (m3[1] + m3[2]).toUpperCase();
    }
    for (const text of [courseCode, courseName]) {
      if (typeof text !== 'string' || !text.trim()) continue;
      const m2 = text.match(CODE_2);
      if (m2 && !SKIP_2.has(m2[1].toUpperCase())) return (m2[1] + m2[2]).toUpperCase();
    }
    return '';
  }

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
        throw new Error('Sign in to Canvas in that tab, then click Sync again.');
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
    let all = await list('/api/v1/courses', { enrollment_type: 'student', enrollment_state: 'active' }, 80);
    if (!all.length) {
      all = await list('/api/v1/courses', { enrollment_state: 'active' }, 80);
    }
    const courses = all
      .filter((course) => typeof course.name === 'string' && course.name.trim() && course.workflow_state !== 'deleted')
      .map((course) => {
        const cid = id(course.id);
        return {
          id: cid,
          name: course.name.trim().slice(0, 300),
          code: extractCode(course.course_code, course.name),
          url: `${canvasOrigin}/courses/${cid}`,
          topics: [],
          assignments: [],
        };
      });

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

      if (!course.topics.length) {
        try {
          const fpRes = await fetch(`${canvasOrigin}/api/v1/courses/${course.id}/front_page`, {
            credentials: 'same-origin',
            redirect: 'manual',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(8_000),
          });
          if (fpRes.ok && fpRes.headers.get('Content-Type')?.includes('json')) {
            const fp = JSON.parse((await fpRes.text()).replace(/^\s*while\s*\(1\)\s*;\s*/, ''));
            if (typeof fp?.body === 'string' && fp.body.trim()) {
              const doc = new DOMParser().parseFromString(fp.body, 'text/html');
              const extracted = [];
              const seen = new Set();
              doc.querySelectorAll('h2, h3, li, p').forEach((el) => {
                if (extracted.length >= 25) return;
                const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
                const m = txt.match(/^(?:Lecture|Forelesning|Week|Uke|Module|Modul|Topic|Tema|Session|Øving)\s*\d+[^.!?\n]{0,75}/i);
                const candidate = m ? m[0].replace(/\bDownload\b.*$/i, '').trim() : (el.tagName === 'H2' || el.tagName === 'H3' ? txt : '');
                if (candidate && candidate.length >= 4 && candidate.length <= 95 && !seen.has(candidate.toLowerCase())) {
                  seen.add(candidate.toLowerCase());
                  extracted.push(candidate);
                }
              });
              if (extracted.length) course.topics = extracted.slice(0, 25);
            }
          }
        } catch {}
      }
    }
    return { snapshot: { version: 2, canvasOrigin, capturedAt, courses } };
  } catch (error) {
    return {
      error: error.name === 'TimeoutError' || error instanceof TypeError || error instanceof SyntaxError
        ? 'Could not load Canvas. Make sure you are signed in.'
        : error.message,
    };
  }
}

// Runs inside the open TimeEdit (cloud.timeedit.net) or Norwegian TP (tp.educloud.no / tp.uio.no) tab
// — extracts the .ics / iCal timetable feed with the most VEVENTs.
async function collectTimeEdit() {
  const allowedOrigins = new Set([
    'https://cloud.timeedit.net',
    'https://tp.educloud.no',
    'https://tp.uio.no',
  ]);
  if (!allowedOrigins.has(location.origin)) {
    return { error: 'Open your TimeEdit or TP timetable tab first.' };
  }
  const isTimeEdit = location.origin === 'https://cloud.timeedit.net';
  const candidates = new Set();
  const addCandidate = (raw) => {
    if (typeof raw !== 'string') return;
    const clean = raw.trim().replace(/^webcal:/i, 'https:');
    if (!clean) return;
    try {
      const u = new URL(clean, location.href);
      if (u.origin !== location.origin) return;
      if (/\.ics(\?|$)/i.test(u.pathname + u.search) || /\/ical(?:\.php)?(\?|$)/i.test(u.pathname + u.search)) {
        candidates.add(u.href);
      }
    } catch {}
  };

  // 1. TimeEdit: convert exact .html schedule URL -> .ics (preserving query params)
  if (isTimeEdit && /\.html$/i.test(location.pathname)) {
    const derived = new URL(location.href);
    derived.pathname = derived.pathname.replace(/\.html$/i, '.ics');
    derived.hash = '';
    candidates.add(derived.href);
  }

  // 2. Scan links, subscription inputs, textareas, and data attributes
  document.querySelectorAll('a[href*=".ics"], a[href*="ical"], input[value*=".ics"], input[value*="ical"], textarea, [data-url*=".ics"], [data-href*=".ics"], [data-url*="ical"], [data-href*="ical"]').forEach((el) => {
    const val = el.getAttribute('href') || el.getAttribute('data-url') || el.getAttribute('data-href') || el.value || el.textContent || '';
    const matches = val.match(/(?:https?|webcal):\/\/(?:cloud\.timeedit\.net|tp\.educloud\.no|tp\.uio\.no)\/[^\s"'<>]+(?:\.ics|ical(?:\.php)?)[^\s"'<>]*/gi) || [];
    matches.forEach(addCandidate);
    if (el.tagName === 'A') addCandidate(el.getAttribute('href'));
  });

  // 3. Scan page HTML for timetable .ics / ical subscription URLs
  const htmlMatches = document.documentElement.innerHTML.match(/(?:https?|webcal):\/\/(?:cloud\.timeedit\.net|tp\.educloud\.no|tp\.uio\.no)\/[^\s"'<>\\]+(?:\.ics|ical(?:\.php)?)[^\s"'<>\\]*/gi) || [];
  htmlMatches.slice(0, 14).forEach(addCandidate);

  // 4. Relative TimeEdit /ri...ics or TP ical.php?... references
  if (isTimeEdit) {
    const riMatches = document.documentElement.innerHTML.match(/\/ri[A-Za-z0-9_-]{8,}\.ics/g) || [];
    riMatches.slice(0, 6).forEach((rel) => {
      try {
        const base = location.pathname.replace(/[^/]*$/, '');
        addCandidate(new URL(base + rel.replace(/^\//, ''), location.origin).href);
      } catch {}
    });
  } else {
    const tpRel = document.documentElement.innerHTML.match(/(?:\/[a-z0-9_-]+)*\/ical\.php\?[^\s"'<>\\]+/gi) || [];
    tpRel.slice(0, 8).forEach((rel) => addCandidate(rel.replace(/&amp;/g, '&')));
  }

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
      error: isTimeEdit
        ? 'TimeEdit returned 0 classes on this view. Select your courses on TimeEdit, click "Show schedule", then click Sync again.'
        : 'TP returned 0 upcoming classes on this view. Open your personal timetable ("Min timeplan") and click Sync again.',
    };
  }
  return {
    error: isTimeEdit
      ? 'Open your TimeEdit schedule view ("Show schedule"), then click Sync again.'
      : 'Open your TP timetable (or click "Abonnér" / Subscribe to reveal the iCal link), then click Sync again.',
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
    const codeMatch = text.match(/(?:^|[^A-Za-z0-9ÆØÅæøå])([A-Za-zÆØÅæøå]{2,6})(?:\s*[-_]\s*|\s?)(\d{3,6})(?!\d)/);
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

function stripEdDocumentXml(docStr, fallbackText = '') {
  const raw = typeof docStr === 'string' && docStr.trim() ? docStr : String(fallbackText || '');
  if (!raw.trim()) return '';
  let text = raw
    .replace(/<(?:paragraph|heading|pre|blockquote)\b[^>]*>/gi, '')
    .replace(/<\/(?:paragraph|heading|pre|blockquote)>/gi, '\n\n')
    .replace(/<list-item\b[^>]*>/gi, '• ')
    .replace(/<\/list-item>/gi, '\n')
    .replace(/<break\s*\/?>|<br\s*\/?>/gi, '\n')
    .replace(/<image\b[^>]*>/gi, '[image] ')
    .replace(/<file\b[^>]*filename="([^"]+)"[^>]*\/?>/gi, '[$1] ')
    .replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(0, 620);
}

async function fetchEdThreadsForCourses(apiHost, authHeaders, courses) {
  const targets = courses.slice(0, 8);
  const all = [];
  await Promise.all(targets.map(async (course) => {
    try {
      const res = await fetch(`https://${apiHost}/api/courses/${course.id}/threads?limit=12&sort=new`, {
        credentials: 'include',
        headers: { Accept: 'application/json', ...authHeaders },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const payload = await res.json().catch(() => null);
      const rawThreads = Array.isArray(payload?.threads) ? payload.threads : [];
      const userMap = new Map();
      for (const u of (Array.isArray(payload?.users) ? payload.users : [])) {
        if (u?.id) userMap.set(String(u.id), u);
      }
      for (const t of rawThreads.slice(0, 12)) {
        if (!t || !t.id || t.is_private) continue;
        const u = t.user_id ? userMap.get(String(t.user_id)) : null;
        const authorName = t.is_anonymous ? 'Anonymous' : (u?.name || t.user?.name || '');
        const role = String(u?.course_role || t.user?.course_role || '').toLowerCase();
        const isStaff = ['admin', 'staff', 'tutor', 'instructor'].includes(role) || t.type === 'announcement';
        const snippet = stripEdDocumentXml(t.content || '', t.document || '');
        const rawType = String(t.type || '').toLowerCase();
        const type = rawType === 'announcement' ? 'announcement' : rawType === 'question' ? 'question' : 'post';
        all.push({
          id: String(t.id),
          courseId: String(course.id),
          courseCode: course.code || '',
          courseName: course.name || '',
          host: apiHost,
          number: Number(t.number) || 0,
          title: String(t.title || '').trim().slice(0, 180),
          snippet,
          category: String(t.category || '').trim().slice(0, 60),
          type,
          isPinned: Boolean(t.is_pinned),
          isAnswered: Boolean(t.is_answered || t.is_staff_answered),
          isStaff,
          author: String(authorName).trim().slice(0, 60),
          replyCount: Math.max(0, Number(t.reply_count) || 0),
          createdAt: t.created_at || new Date().toISOString(),
          updatedAt: t.updated_at || t.created_at || new Date().toISOString(),
        });
      }
    } catch {}
  }));
  all.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || '');
  });
  return all.slice(0, 60);
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
          .map((t) => (typeof t === 'string' ? t.match(/(?:^|[^A-Za-z0-9ÆØÅæøå])([A-Za-zÆØÅæøå]{2,6})(?:\s*[-_]\s*|\s?)(\d{3,6})(?!\d)/)?.slice(1).join('').toUpperCase() : ''))
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
        if (courses.length) {
          const threads = await fetchEdThreadsForCourses(apiHost, authHeaders, courses);
          return { capturedAt, courses, threads };
        }
      } catch {}
    }
  }

  if (Array.isArray(ctx?.domCourses) && ctx.domCourses.length) {
    return { capturedAt, courses: ctx.domCourses, threads: [] };
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
    if (isCanvasOrigin(u.origin)) return 'canvas';
    if (TIMETABLE_ORIGINS.has(u.origin)) return 'timeedit';
    if (ED_ORIGINS.has(u.origin)) return 'ed';
  } catch {}
  return 'other';
}

async function findOpenStudyTabs() {
  const tabs = await chrome.tabs.query({ url: TARGET_URL_PATTERNS }).catch(() => []);
  const found = { canvas: null, timeedit: null, ed: null };
  // Prefer active tab in current window, then most recently accessed / schedule-view timetable tabs
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
    if (!result || result.error) throw new Error(result?.error || 'Canvas tab closed during sync.');

    const canvasOrigin = isCanvasOrigin(result.snapshot?.canvasOrigin)
      ? result.snapshot.canvasOrigin
      : DEFAULT_CANVAS_ORIGIN;
    const school = schoolLabelForOrigin(canvasOrigin);

    let cloudSummary = null;
    if (cloudToken) {
      cloudSummary = await cloudRequest('/courses/sync', {
        source: 'canvas',
        sharePublic,
        canvasOrigin,
        school,
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
    await chrome.storage.local.set({ lastCanvasOrigin: canvasOrigin, lastCanvasSchool: school }).catch(() => {});
    return {
      site: 'canvas',
      school,
      canvasOrigin,
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
      throw new Error('Link your studyos.no profile (6-char code) to sync your timetable.');
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: collectTimeEdit });
    if (!result || result.error) throw new Error(result?.error || 'Could not read timetable.');
    const pushed = await cloudRequest('/schedule/timeedit-push', {
      calendar: result.calendar,
      sourceUrl: result.sourceUrl || '',
    }, cloudToken);
    if (tab?.url && /^https:\/\//i.test(tab.url)) {
      await chrome.storage.local.set({ lastTimeEditUrl: tab.url }).catch(() => {});
    }
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
      threads: Array.isArray(result.threads) ? result.threads : [],
    }, cloudToken);
    return {
      site: 'ed',
      courses: pushed.syncedCourses || result.courses.length,
      threads: pushed.threadCount ?? (result.threads?.length || 0),
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

// Fetches a Canvas PDF directly using the student's own signed-in Chrome session.
// Bytes return strictly to the student's local studyos.no tab (never uploaded to any server).
async function fetchCanvasFileDirect(courseId, fileId, originOverride = '') {
  if (!/^\d{1,12}$/.test(String(courseId)) || !/^\d{1,12}$/.test(String(fileId))) {
    throw new Error('Invalid Canvas file reference.');
  }
  const stored = await chrome.storage.local.get(['lastCanvasOrigin']).catch(() => ({}));
  const canvasOrigin = isCanvasOrigin(originOverride)
    ? new URL(originOverride).origin
    : isCanvasOrigin(stored.lastCanvasOrigin)
    ? new URL(stored.lastCanvasOrigin).origin
    : DEFAULT_CANVAS_ORIGIN;
  const hostLabel = new URL(canvasOrigin).hostname;
  const schoolName = schoolLabelForOrigin(canvasOrigin);

  let signedUrl = '';
  let apiFilename = '';
  try {
    const metaRes = await fetch(`${canvasOrigin}/api/v1/courses/${courseId}/files/${fileId}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (metaRes.status === 401 || metaRes.status === 403) {
      throw new Error(`Sign in to ${schoolName} Canvas (${hostLabel}) in Chrome first, then click Retry inline.`);
    }
    if (metaRes.ok) {
      const meta = await metaRes.json().catch(() => null);
      if (meta?.url) signedUrl = String(meta.url);
      if (meta?.display_name || meta?.filename) apiFilename = String(meta.display_name || meta.filename);
    }
  } catch (err) {
    if (/sign in to .* canvas/i.test(String(err?.message || ''))) throw err;
  }

  const targetUrl = signedUrl || `${canvasOrigin}/courses/${courseId}/files/${fileId}/download?download_frd=1`;
  const isSameOrigin = targetUrl.startsWith(canvasOrigin);
  const res = await fetch(targetUrl, {
    credentials: isSameOrigin ? 'include' : 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 401 || res.status === 403 || /login|saml|microsoftonline|feide/i.test(res.url || '')) {
    throw new Error(`Sign in to ${schoolName} Canvas (${hostLabel}) in Chrome first, then click Retry inline.`);
  }
  if (!res.ok) throw new Error(`${schoolName} Canvas returned HTTP ${res.status}. Open Canvas to refresh your login.`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 60 * 1024 * 1024) throw new Error('PDF exceeds 60 MB direct-fetch limit. Download and drop it locally instead.');
  const bytes = new Uint8Array(buf);
  const sig = String.fromCharCode(...bytes.subarray(0, 5));
  if (sig !== '%PDF-') {
    throw new Error(`${schoolName} Canvas returned a login or preview page instead of a PDF. Sign in to ${hostLabel} in Chrome first.`);
  }
  const disp = res.headers.get('Content-Disposition') || '';
  const nameMatch = disp.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filename = apiFilename || (nameMatch ? decodeURIComponent(nameMatch[1] || nameMatch[2] || '') : `canvas-${fileId}.pdf`);
  return { ok: true, filename, dataBase64: bytesToBase64(bytes) };
}

const LOCK_TTL_MS = 60 * 1000;
const BADGE_TTL_MS = 5000;

async function acquireSessionLock(key) {
  try {
    const now = Date.now();
    const { syncLocks = {} } = await chrome.storage.session.get('syncLocks');
    const existing = Number(syncLocks[key] || 0);
    if (existing && now - existing < LOCK_TTL_MS) return false;
    await chrome.storage.session.set({ syncLocks: { ...syncLocks, [key]: now } });
    return true;
  } catch {
    return true;
  }
}

async function releaseSessionLock(key) {
  try {
    const { syncLocks = {} } = await chrome.storage.session.get('syncLocks');
    if (key in syncLocks) {
      delete syncLocks[key];
      await chrome.storage.session.set({ syncLocks });
    }
  } catch {}
}

async function clearStaleBadgeIfNeeded() {
  try {
    const { badgeClearAt = 0 } = await chrome.storage.session.get('badgeClearAt');
    if (badgeClearAt && Date.now() >= badgeClearAt) {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.storage.session.remove('badgeClearAt');
    }
  } catch {}
}

async function flashSuccessBadge() {
  try {
    const clearAt = Date.now() + BADGE_TTL_MS;
    await chrome.storage.session.set({ badgeClearAt: clearAt });
    await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    await chrome.action.setBadgeText({ text: '✓' });
    chrome.alarms?.create?.('studyOsClearBadge', { delayInMinutes: 0.1 });
    setTimeout(() => {
      clearStaleBadgeIfNeeded().catch(() => {});
    }, BADGE_TTL_MS + 100);
  } catch {}
}

chrome.runtime.onStartup.addListener(() => { clearStaleBadgeIfNeeded(); });
chrome.runtime.onInstalled.addListener(() => { clearStaleBadgeIfNeeded(); });

async function maybeAutoSyncTab(tabId, urlStr) {
  await clearStaleBadgeIfNeeded();
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

  if (!(await acquireSessionLock(`auto:${site}`))) return;
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
    await releaseSessionLock(`auto:${site}`);
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
      'lastCanvasOrigin',
      'lastCanvasSchool',
      'lastTimeEditUrl',
      'focusTelemetryEnabled',
    ]);
    const openTabs = await findOpenStudyTabs();
    const activeCanvasOrigin = openTabs.canvas?.url ? new URL(openTabs.canvas.url).origin : '';
    const canvasOrigin = isCanvasOrigin(activeCanvasOrigin)
      ? activeCanvasOrigin
      : isCanvasOrigin(stored.lastCanvasOrigin)
      ? stored.lastCanvasOrigin
      : DEFAULT_CANVAS_ORIGIN;
    const canvasSchool = isCanvasOrigin(activeCanvasOrigin)
      ? schoolLabelForOrigin(activeCanvasOrigin)
      : (stored.lastCanvasSchool || '');
    const defaultTimetableUrl = canvasSchool === 'UiA'
      ? 'https://tp.educloud.no/uia/'
      : canvasSchool === 'BI Oslo'
      ? 'https://cloud.timeedit.net/bi/web/public/'
      : 'https://cloud.timeedit.net/';
    return {
      connectedCloud: Boolean(stored.cloudToken),
      nickname: stored.cloudNickname || '',
      connectedDesktop: Boolean(stored.token),
      sharePublic: stored.sharePublic !== false,
      autoSyncEnabled: stored.autoSyncEnabled !== false,
      lastSiteSyncAt: stored.lastSiteSyncAt || {},
      canvasOrigin,
      canvasSchool,
      timeeditUrl: openTabs.timeedit?.url || stored.lastTimeEditUrl || defaultTimetableUrl,
      focusTelemetryEnabled: Boolean(stored.focusTelemetryEnabled),
      openSites: {
        canvas: Boolean(openTabs.canvas),
        timeedit: Boolean(openTabs.timeedit),
        ed: Boolean(openTabs.ed),
      },
    };
  }

  if (message.action === 'setFocusTelemetry') {
    const enabled = Boolean(message.enabled);
    await chrome.storage.local.set({ focusTelemetryEnabled: enabled });
    if (enabled) {
      chrome.alarms.create('studyOsFocusSample', { periodInMinutes: 0.5 });
      sampleActiveTabCategory().catch(() => {});
    } else {
      chrome.alarms.clear('studyOsFocusSample');
    }
    return { ok: true, enabled };
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

// Tier 2 Opt-In On-Device Browser Focus Telemetry (strictly domain category totals — zero URLs/titles stored)
const STUDY_HOST_RE = /(?:^|\.)(?:studyos\.no|canvas\.|instructure\.com|wiseflow\.net|bi\.no|edstem\.org|timeedit\.net|tp\.educloud\.no|colab\.research\.google\.com|github\.com|docs\.python\.org|pandas\.pydata\.org|matplotlib\.org|seaborn\.pydata\.org|dr-eriksen\.no|core-econ\.org|localhost|127\.0\.0\.1)$/i;
const DISTRACT_HOST_RE = /(?:^|\.)(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|x\.com|twitter\.com|reddit\.com|twitch\.tv|netflix\.com|facebook\.com|snapchat\.com|9gag\.com|vg\.no|dagbladet\.no)$/i;

function osloDateKeyExt(now = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

async function sampleActiveTabCategory() {
  const { focusTelemetryEnabled, focusTelemetryDaily } = await chrome.storage.local.get([
    'focusTelemetryEnabled',
    'focusTelemetryDaily',
  ]);
  if (!focusTelemetryEnabled) return;
  const hasTabsPerm = await chrome.permissions.contains({ permissions: ['tabs'] }).catch(() => false);
  if (!hasTabsPerm) return;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const urlStr = tabs?.[0]?.url || '';
  if (!/^https?:/i.test(urlStr)) return;
  let host = '';
  try { host = new URL(urlStr).hostname.toLowerCase(); } catch { return; }
  const bucket = STUDY_HOST_RE.test(host) ? 'studySec' : DISTRACT_HOST_RE.test(host) ? 'distractSec' : 'otherSec';
  const day = osloDateKeyExt();
  const daily = (focusTelemetryDaily && typeof focusTelemetryDaily === 'object') ? { ...focusTelemetryDaily } : {};
  const row = daily[day] ? { ...daily[day] } : { studySec: 0, distractSec: 0, otherSec: 0 };
  row[bucket] = Math.min(86400, (Number(row[bucket]) || 0) + 30);
  daily[day] = row;
  const keys = Object.keys(daily).sort();
  while (keys.length > 30) delete daily[keys.shift()];
  await chrome.storage.local.set({ focusTelemetryDaily: daily });
}

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === 'studyOsFocusSample') {
    sampleActiveTabCategory().catch(() => {});
  } else if (alarm?.name === 'studyOsClearBadge') {
    clearStaleBadgeIfNeeded().catch(() => {});
  }
});

(async () => {
  try {
    const { focusTelemetryEnabled } = await chrome.storage.local.get(['focusTelemetryEnabled']);
    if (focusTelemetryEnabled) {
      chrome.alarms?.create?.('studyOsFocusSample', { periodInMinutes: 0.5 });
    }
    await clearStaleBadgeIfNeeded();
  } catch {}
})();

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.action === 'getFocusTelemetry' && isTrustedBridgeSender(sender)) {
    (async () => {
      try {
        const d = await chrome.storage.local.get(['focusTelemetryEnabled', 'focusTelemetryDaily']);
        respond({ ok: true, enabled: Boolean(d.focusTelemetryEnabled), daily: d.focusTelemetryDaily || {} });
      } catch {
        respond({ ok: false, daily: {} });
      }
    })();
    return true;
  }
  if (message?.action === 'fetchCanvasFile' && isTrustedBridgeSender(sender)) {
    (async () => {
      try {
        await clearStaleBadgeIfNeeded();
        const result = await fetchCanvasFileDirect(message.courseId, message.fileId, message.canvasOrigin || '');
        respond(result);
      } catch (error) {
        respond({ ok: false, error: error?.message || 'Could not load PDF from Canvas.' });
      }
    })();
    return true;
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) return false;
  (async () => {
    try {
      await clearStaleBadgeIfNeeded();
      const result = await handle(message);
      respond(result);
    } catch (error) {
      if (error?.needsPair) await chrome.storage.local.remove(['cloudToken', 'cloudNickname']).catch(() => {});
      if (error?.needsDesktopPair) await chrome.storage.local.remove('token').catch(() => {});
      respond({ error: error?.message || 'Sync failed.', needsPair: Boolean(error?.needsPair) });
    }
  })();
  return true;
});
