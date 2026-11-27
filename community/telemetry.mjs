/**
 * First-party, cookie-free web usage & funnel telemetry for Study-OS (EU D1).
 *
 * Privacy guarantees:
 * - Zero cookies, zero localStorage tracking IDs, zero stored IP addresses or emails.
 * - Same-day uniqueness uses SHA-256(osloDay | dailySalt | ip | uaBucket).slice(0, 24).
 * - `dailySalt` rotates every Europe/Oslo day and previous days' salts are deleted,
 *   making hashes cryptographically unlinkable across days and irreversible to any IP.
 * - Aggregated rows older than 90 Oslo days are automatically pruned.
 * - Strictly disabled for localhost / Desktop Edition (enforced client-side + Worker CORS).
 */

const ALLOWED_EVENTS = new Set([
  'page_view',
  'tab_view',
  'course_open',
  'notes_open',
  'run_start',
  'run_exit',
  'question_attempt',
  'run_complete',
  'solution_reveal',
  'box_check',
  'hint_open',
  'feature_use',
  'link_land',
  'active_sec',
  'client_error',
  'auth_open',
  'signup',
  'desktop_download',
  'copy_question',
]);

const BOT_UA_RE = /bot\b|crawler|spider|slurp|bingpreview|facebookexternalhit|whatsapp|telegrambot|discordbot|headlesschrome|lighthouse|pagespeed|curl\/|wget\/|python-requests|go-http-client|uptime|pingdom|datadog/i;
const COUNTRY_RE = /^[A-Z]{2}$/;
const osloDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const encoder = new TextEncoder();
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

let cachedSaltDay = '';
let cachedSaltVal = '';

export function formatOsloDay(ms = Date.now()) {
  try {
    return osloDateFmt.format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function osloDayOffset(daysAgo, now = Date.now()) {
  return formatOsloDay(now - daysAgo * 86_400_000);
}

export function normalizePathDim(raw) {
  if (typeof raw !== 'string') return '/';
  let s = raw.trim().split('?')[0].split('#')[0];
  if (!s) return '/';
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/{2,}/g, '/').replace(/[^A-Za-z0-9/_.-]/g, '').slice(0, 80);
  if (s === '/index.html') return '/';
  return s || '/';
}

export function normalizeDim(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/[^a-z0-9/:._-]/g, '').slice(0, 64);
}

export function normalizeReferrerHost(raw, selfHost = 'studyos.no') {
  if (typeof raw !== 'string') return 'direct';
  const trimmed = raw.trim();
  if (!trimmed) return 'direct';
  try {
    const u = trimmed.includes('://') ? new URL(trimmed) : new URL('https://' + trimmed);
    const host = (u.hostname || '').toLowerCase().replace(/^www\./, '');
    if (!host || host === selfHost || host.endsWith('.' + selfHost) || host === 'localhost' || host === '127.0.0.1') {
      return 'direct';
    }
    return host.replace(/[^a-z0-9.-]/g, '').slice(0, 64) || 'direct';
  } catch {
    return 'direct';
  }
}

export function detectDeviceClass(ua, widthHint) {
  const s = String(ua || '');
  if (/ipad|tablet|playbook|silk/i.test(s) || (/android/i.test(s) && !/mobile/i.test(s))) return 'tablet';
  if (/mobi|iphone|ipod|android|phone/i.test(s)) return 'mobile';
  const w = Number(widthHint);
  if (Number.isFinite(w) && w > 0) {
    if (w < 640) return 'mobile';
    if (w < 1024) return 'tablet';
  }
  return 'desktop';
}

function uaFamilyBucket(ua) {
  const s = String(ua || '');
  const browser = /edg\//i.test(s) ? 'edge'
    : /vivaldi/i.test(s) ? 'vivaldi'
    : /opr\/|opera/i.test(s) ? 'opera'
    : /firefox|fxios/i.test(s) ? 'firefox'
    : /chrome|crios/i.test(s) ? 'chrome'
    : /safari/i.test(s) ? 'safari'
    : 'other';
  const os = /iphone|ipad|ipod/i.test(s) ? 'ios'
    : /android/i.test(s) ? 'android'
    : /mac os x|macintosh/i.test(s) ? 'mac'
    : /windows/i.test(s) ? 'win'
    : /linux/i.test(s) ? 'linux'
    : 'other';
  return `${browser}:${os}`;
}

async function getDailySalt(db, dayOslo) {
  if (cachedSaltDay === dayOslo && cachedSaltVal) return cachedSaltVal;
  const key = `telemetry_salt_${dayOslo}`;
  const existing = await db.prepare('SELECT value FROM community_settings WHERE key = ?').bind(key).first();
  if (existing?.value) {
    cachedSaltDay = dayOslo;
    cachedSaltVal = String(existing.value);
    return cachedSaltVal;
  }
  const fresh = toHex(crypto.getRandomValues(new Uint8Array(24)));
  await db.prepare('INSERT OR IGNORE INTO community_settings(key, value) VALUES (?, ?)')
    .bind(key, fresh).run();
  const row = await db.prepare('SELECT value FROM community_settings WHERE key = ?').bind(key).first();
  const winner = String(row?.value || fresh);
  cachedSaltDay = dayOslo;
  cachedSaltVal = winner;

  // Opportunistic daily privacy rotation: delete expired salts and >90-day rows.
  const cutoffDay = osloDayOffset(90);
  await Promise.all([
    db.prepare("DELETE FROM community_settings WHERE key LIKE 'telemetry_salt_%' AND key < ?").bind(key).run().catch(() => {}),
    db.prepare('DELETE FROM web_daily_visitors WHERE day_oslo < ?').bind(cutoffDay).run().catch(() => {}),
    db.prepare('DELETE FROM web_daily_events WHERE day_oslo < ?').bind(cutoffDay).run().catch(() => {}),
  ]);
  return winner;
}

export async function computeDailyVisitorHash(db, dayOslo, ip, ua) {
  const salt = await getDailySalt(db, dayOslo);
  const material = `${dayOslo}|${salt}|${ip || 'unknown'}|${uaFamilyBucket(ua)}`;
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(material)));
  return toHex(buf).slice(0, 24);
}

export function resetTelemetrySaltCacheForTest() {
  cachedSaltDay = '';
  cachedSaltVal = '';
}

export async function handleTelemetry({ request, db, env, now, data, headers }) {
  const noContent = () => new Response(null, { status: 204, headers });
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405, headers });
  }
  const ua = request.headers.get('User-Agent') || '';
  if (!ua || BOT_UA_RE.test(ua)) return noContent();

  // Soft rate-limit to prevent abuse without ever blocking real study bursts.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (ip && env?.AUTH_RATE_LIMIT) {
    try {
      const { success } = await env.AUTH_RATE_LIMIT.limit({ key: `telemetry:${ip}` });
      if (!success) return noContent();
    } catch {}
  }

  const rawEvents = Array.isArray(data?.events)
    ? data.events.slice(0, 16)
    : (typeof data?.event === 'string' ? [{ event: data.event, dim: data.dim }] : []);
  if (!rawEvents.length) return noContent();

  const cleaned = [];
  for (const item of rawEvents) {
    if (!item || typeof item !== 'object') continue;
    const ev = typeof item.event === 'string' ? item.event.trim().toLowerCase() : '';
    if (!ALLOWED_EVENTS.has(ev)) continue;
    const dim = ev === 'page_view' ? normalizePathDim(item.dim || data?.path) : normalizeDim(item.dim || '');
    const rawVal = Number(item.val);
    const val = ev === 'active_sec'
      ? (Number.isFinite(rawVal) ? Math.max(1, Math.min(600, Math.round(rawVal))) : 15)
      : 1;
    cleaned.push({ event: ev, dim, val });
  }
  if (!cleaned.length) return noContent();

  const dayOslo = formatOsloDay(now);
  const authState = data?.auth === 'authed' ? 'authed' : 'anon';
  const rawCountry = String(request.cf?.country || '').toUpperCase();
  const country = COUNTRY_RE.test(rawCountry) ? rawCountry : 'XX';
  const device = detectDeviceClass(ua, data?.w);
  const firstPath = normalizePathDim(data?.path || cleaned.find((c) => c.event === 'page_view')?.dim || '/');
  const originHost = (() => {
    try { return new URL(request.headers.get('Origin') || 'https://studyos.no').hostname.replace(/^www\./, ''); }
    catch { return 'studyos.no'; }
  })();
  const referrerHost = normalizeReferrerHost(data?.ref || '', originHost);

  const hasRun = cleaned.some((c) => c.event === 'run_start') ? 1 : 0;
  const hasAttempt = cleaned.some((c) => c.event === 'question_attempt') ? 1 : 0;
  const hasAuthOpen = cleaned.some((c) => c.event === 'auth_open') ? 1 : 0;
  const hasSignup = cleaned.some((c) => c.event === 'signup') ? 1 : 0;
  const activeSecDelta = cleaned
    .filter((c) => c.event === 'active_sec')
    .reduce((sum, c) => sum + c.val, 0);
  const hasNotes = cleaned.some((c) =>
    c.event === 'notes_open'
    || (c.event === 'tab_view' && c.dim === 'references')
    || (c.event === 'active_sec' && c.dim.startsWith('notes'))
    || (c.event === 'feature_use' && c.dim === 'ref_drawer')
  ) ? 1 : 0;
  const nonActiveEvents = cleaned.filter((c) => c.event !== 'active_sec').length;

  try {
    const visitorHash = await computeDailyVisitorHash(db, dayOslo, ip, ua);
    await db.prepare(`
      INSERT INTO web_daily_visitors(
        day_oslo, visitor_hash, country, device, auth_state, first_path, referrer_host,
        first_seen_at, last_seen_at, events, has_run, has_attempt, has_auth_open, has_signup,
        active_sec, has_notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day_oslo, visitor_hash) DO UPDATE SET
        auth_state = CASE WHEN web_daily_visitors.auth_state = 'authed' OR excluded.auth_state = 'authed' THEN 'authed' ELSE 'anon' END,
        last_seen_at = excluded.last_seen_at,
        events = web_daily_visitors.events + excluded.events,
        has_run = MAX(web_daily_visitors.has_run, excluded.has_run),
        has_attempt = MAX(web_daily_visitors.has_attempt, excluded.has_attempt),
        has_auth_open = MAX(web_daily_visitors.has_auth_open, excluded.has_auth_open),
        has_signup = MAX(web_daily_visitors.has_signup, excluded.has_signup),
        active_sec = web_daily_visitors.active_sec + excluded.active_sec,
        has_notes = MAX(web_daily_visitors.has_notes, excluded.has_notes)
    `).bind(
      dayOslo, visitorHash, country, device, authState, firstPath, referrerHost,
      now, now, Math.max(nonActiveEvents, activeSecDelta > 0 ? 1 : 0),
      hasRun, hasAttempt, hasAuthOpen, hasSignup, activeSecDelta, hasNotes
    ).run();

    // Coalesce identical (event, dim) pairs inside the batch before upserting.
    const counts = new Map();
    for (const c of cleaned) {
      const k = `${c.event}\0${c.dim}`;
      counts.set(k, (counts.get(k) || 0) + c.val);
    }
    const writes = [];
    for (const [k, delta] of counts.entries()) {
      const [ev, dim] = k.split('\0');
      writes.push(
        db.prepare(`
          INSERT INTO web_daily_events(day_oslo, event, dim, auth_state, count, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(day_oslo, event, dim, auth_state) DO UPDATE SET
            count = web_daily_events.count + excluded.count,
            last_seen_at = excluded.last_seen_at
        `).bind(dayOslo, ev, dim, authState, delta, now).run()
      );
    }
    await Promise.all(writes);
  } catch {
    // Telemetry must never surface errors or break client UX (e.g., before migration runs).
  }
  return noContent();
}

export async function getAdminTelemetrySummary(db, now = Date.now()) {
  const todayDay = formatOsloDay(now);
  const start7d = osloDayOffset(6, now);
  const start14d = osloDayOffset(13, now);
  const start30d = osloDayOffset(29, now);
  try {
    const [dailyRows, eventRows, refRows, countryRows, deviceRows] = await Promise.all([
      db.prepare(`
        SELECT day_oslo AS day,
          SUM(CASE WHEN auth_state = 'anon' THEN 1 ELSE 0 END) AS anon,
          SUM(CASE WHEN auth_state = 'authed' THEN 1 ELSE 0 END) AS authed,
          COUNT(*) AS total,
          SUM(has_run) AS startedRun,
          SUM(has_attempt) AS attempted,
          SUM(has_auth_open) AS openedAuth,
          SUM(has_signup) AS signedUp,
          SUM(events) AS totalEvents,
          SUM(COALESCE(active_sec, 0)) AS activeSec,
          SUM(COALESCE(has_notes, 0)) AS readNotes
        FROM web_daily_visitors
        WHERE day_oslo >= ?
        GROUP BY day_oslo
        ORDER BY day_oslo ASC
      `).bind(start30d).all(),
      db.prepare(`
        SELECT event, dim,
          SUM(CASE WHEN auth_state = 'anon' THEN count ELSE 0 END) AS anon,
          SUM(CASE WHEN auth_state = 'authed' THEN count ELSE 0 END) AS authed,
          SUM(count) AS total
        FROM web_daily_events
        WHERE day_oslo >= ?
        GROUP BY event, dim
        ORDER BY total DESC
        LIMIT 260
      `).bind(start30d).all(),
      db.prepare(`
        SELECT referrer_host AS host, COUNT(*) AS visitors
        FROM web_daily_visitors
        WHERE day_oslo >= ?
        GROUP BY referrer_host
        ORDER BY visitors DESC
        LIMIT 10
      `).bind(start30d).all(),
      db.prepare(`
        SELECT country, COUNT(*) AS visitors
        FROM web_daily_visitors
        WHERE day_oslo >= ?
        GROUP BY country
        ORDER BY visitors DESC
        LIMIT 8
      `).bind(start30d).all(),
      db.prepare(`
        SELECT device,
          COUNT(*) AS visitors,
          SUM(has_run) AS startedRun,
          SUM(has_attempt) AS attempted,
          SUM(COALESCE(has_notes, 0)) AS readNotes,
          SUM(has_signup) AS signedUp,
          SUM(COALESCE(active_sec, 0)) AS activeSec
        FROM web_daily_visitors
        WHERE day_oslo >= ?
        GROUP BY device
      `).bind(start30d).all(),
    ]);

    const byDay = new Map((dailyRows.results || []).map((r) => [r.day, {
      day: r.day,
      anon: Number(r.anon || 0),
      authed: Number(r.authed || 0),
      total: Number(r.total || 0),
      startedRun: Number(r.startedRun || 0),
      attempted: Number(r.attempted || 0),
      openedAuth: Number(r.openedAuth || 0),
      signedUp: Number(r.signedUp || 0),
      totalEvents: Number(r.totalEvents || 0),
      activeSec: Number(r.activeSec || 0),
      readNotes: Number(r.readNotes || 0),
    }]));

    const sumWindow = (minDay) => {
      const out = { anon: 0, authed: 0, total: 0, startedRun: 0, attempted: 0, openedAuth: 0, signedUp: 0, totalEvents: 0, activeSec: 0, readNotes: 0 };
      for (const [d, row] of byDay.entries()) {
        if (d >= minDay) {
          out.anon += row.anon;
          out.authed += row.authed;
          out.total += row.total;
          out.startedRun += row.startedRun;
          out.attempted += row.attempted;
          out.openedAuth += row.openedAuth;
          out.signedUp += row.signedUp;
          out.totalEvents += row.totalEvents;
          out.activeSec += row.activeSec;
          out.readNotes += row.readNotes;
        }
      }
      return out;
    };

    const daily14 = [];
    for (let i = 13; i >= 0; i--) {
      const d = osloDayOffset(i, now);
      const hit = byDay.get(d);
      daily14.push(hit || { day: d, anon: 0, authed: 0, total: 0, startedRun: 0, attempted: 0, openedAuth: 0, signedUp: 0, totalEvents: 0, activeSec: 0, readNotes: 0 });
    }

    const evs = eventRows.results || [];
    const pickTop = (eventName, limit = 8) => evs
      .filter((r) => r.event === eventName && r.dim)
      .sort((a, b) => Number(b.total || 0) - Number(a.total || 0))
      .slice(0, limit)
      .map((r) => ({ dim: r.dim, anon: Number(r.anon || 0), authed: Number(r.authed || 0), total: Number(r.total || 0) }));

    const sumEvent = (eventName) => evs
      .filter((r) => r.event === eventName)
      .reduce((acc, r) => ({
        anon: acc.anon + Number(r.anon || 0),
        authed: acc.authed + Number(r.authed || 0),
        total: acc.total + Number(r.total || 0),
      }), { anon: 0, authed: 0, total: 0 });

    const devices = { desktop: 0, mobile: 0, tablet: 0 };
    const deviceFunnel = [];
    for (const r of (deviceRows.results || [])) {
      const k = r.device === 'mobile' || r.device === 'tablet' ? r.device : 'desktop';
      devices[k] += Number(r.visitors || 0);
      deviceFunnel.push({
        device: k,
        visitors: Number(r.visitors || 0),
        startedRun: Number(r.startedRun || 0),
        attempted: Number(r.attempted || 0),
        readNotes: Number(r.readNotes || 0),
        signedUp: Number(r.signedUp || 0),
        activeSec: Number(r.activeSec || 0),
      });
    }
    deviceFunnel.sort((a, b) => b.visitors - a.visitors);

    // Aggregate active seconds by top-level surface category (runner, notes, course, exams, home, community, schedule, metrics, pdf)
    const surfaceTotals = new Map();
    for (const r of evs) {
      if (r.event !== 'active_sec' || !r.dim) continue;
      const cat = String(r.dim).split(':')[0] || 'other';
      const cur = surfaceTotals.get(cat) || { surface: cat, anon: 0, authed: 0, total: 0 };
      cur.anon += Number(r.anon || 0);
      cur.authed += Number(r.authed || 0);
      cur.total += Number(r.total || 0);
      surfaceTotals.set(cat, cur);
    }
    const activeBySurface = [...surfaceTotals.values()].sort((a, b) => b.total - a.total);

    return {
      todayDay,
      today: byDay.get(todayDay) || { day: todayDay, anon: 0, authed: 0, total: 0, startedRun: 0, attempted: 0, openedAuth: 0, signedUp: 0, totalEvents: 0, activeSec: 0, readNotes: 0 },
      last7d: sumWindow(start7d),
      last30d: sumWindow(start30d),
      daily14,
      windowStart14: start14d,
      events30d: {
        pageViews: sumEvent('page_view'),
        runsStarted: sumEvent('run_start'),
        questionsAttempted: sumEvent('question_attempt'),
        runsCompleted: sumEvent('run_complete'),
        desktopDownloads: sumEvent('desktop_download'),
        activeSec: sumEvent('active_sec'),
        clientErrors: sumEvent('client_error'),
        boxChecks: sumEvent('box_check'),
        hintsOpened: sumEvent('hint_open'),
        copies: sumEvent('copy_question'),
      },
      activeBySurface,
      topActiveTargets: pickTop('active_sec', 10),
      runExits: pickTop('run_exit', 10),
      solutionReveals: pickTop('solution_reveal', 10),
      attemptOutcomes: pickTop('question_attempt', 12),
      boxCheckBreakdown: pickTop('box_check', 8),
      features: pickTop('feature_use', 16),
      linkLands: pickTop('link_land', 10),
      clientErrors: pickTop('client_error', 10),
      topPages: pickTop('page_view', 8),
      topTabs: pickTop('tab_view', 8),
      topCourses: pickTop('course_open', 8),
      topReferrers: (refRows.results || []).map((r) => ({ host: r.host || 'direct', visitors: Number(r.visitors || 0) })),
      countries: (countryRows.results || []).map((r) => ({ country: r.country || 'XX', visitors: Number(r.visitors || 0) })),
      devices,
      deviceFunnel,
    };
  } catch {
    return null;
  }
}
