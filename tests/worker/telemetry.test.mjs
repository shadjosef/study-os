import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../../community/worker.mjs';
import {
  computeDailyVisitorHash,
  detectDeviceClass,
  formatOsloDay,
  getAdminTelemetrySummary,
  normalizeDim,
  normalizePathDim,
  normalizeReferrerHost,
  resetTelemetrySaltCacheForTest,
} from '../../community/telemetry.mjs';

const ALLOWED_ORIGIN = 'https://studyos.no';
const WORKER_URL = 'https://study-os-community.example.workers.dev';

function makeTelemetryMockDb() {
  const settings = new Map();
  const visitors = new Map();
  const events = new Map();
  const queries = [];

  return {
    settings,
    visitors,
    events,
    queries,
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...args) {
          bound = args;
          return stmt;
        },
        async first() {
          queries.push({ op: 'first', sql, bound });
          if (sql.includes('FROM community_settings WHERE key = ?')) {
            const val = settings.get(bound[0]);
            return val !== undefined ? { value: val } : null;
          }
          return null;
        },
        async all() {
          queries.push({ op: 'all', sql, bound });
          if (sql.includes('FROM web_daily_visitors') && sql.includes('GROUP BY day_oslo')) {
            const minDay = bound[0];
            const byDay = new Map();
            for (const row of visitors.values()) {
              if (row.day_oslo < minDay) continue;
              const cur = byDay.get(row.day_oslo) || {
                day: row.day_oslo, anon: 0, authed: 0, total: 0,
                startedRun: 0, attempted: 0, openedAuth: 0, signedUp: 0, totalEvents: 0,
              };
              if (row.auth_state === 'authed') cur.authed += 1;
              else cur.anon += 1;
              cur.total += 1;
              cur.startedRun += row.has_run;
              cur.attempted += row.has_attempt;
              cur.openedAuth += row.has_auth_open;
              cur.signedUp += row.has_signup;
              cur.totalEvents += row.events;
              byDay.set(row.day_oslo, cur);
            }
            return { results: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) };
          }
          if (sql.includes('FROM web_daily_events')) {
            const minDay = bound[0];
            const agg = new Map();
            for (const row of events.values()) {
              if (row.day_oslo < minDay) continue;
              const k = `${row.event}\0${row.dim}`;
              const cur = agg.get(k) || { event: row.event, dim: row.dim, anon: 0, authed: 0, total: 0 };
              if (row.auth_state === 'authed') cur.authed += row.count;
              else cur.anon += row.count;
              cur.total += row.count;
              agg.set(k, cur);
            }
            return { results: [...agg.values()].sort((a, b) => b.total - a.total) };
          }
          if (sql.includes('GROUP BY referrer_host')) {
            const minDay = bound[0];
            const map = new Map();
            for (const row of visitors.values()) {
              if (row.day_oslo < minDay) continue;
              map.set(row.referrer_host, (map.get(row.referrer_host) || 0) + 1);
            }
            return { results: [...map.entries()].map(([host, visitors]) => ({ host, visitors })) };
          }
          if (sql.includes('GROUP BY country')) {
            const minDay = bound[0];
            const map = new Map();
            for (const row of visitors.values()) {
              if (row.day_oslo < minDay) continue;
              map.set(row.country, (map.get(row.country) || 0) + 1);
            }
            return { results: [...map.entries()].map(([country, visitors]) => ({ country, visitors })) };
          }
          if (sql.includes('GROUP BY device')) {
            const minDay = bound[0];
            const map = new Map();
            for (const row of visitors.values()) {
              if (row.day_oslo < minDay) continue;
              map.set(row.device, (map.get(row.device) || 0) + 1);
            }
            return { results: [...map.entries()].map(([device, visitors]) => ({ device, visitors })) };
          }
          return { results: [] };
        },
        async run() {
          queries.push({ op: 'run', sql, bound });
          if (sql.includes('INSERT OR IGNORE INTO community_settings')) {
            if (!settings.has(bound[0])) settings.set(bound[0], bound[1]);
          } else if (sql.includes("DELETE FROM community_settings WHERE key LIKE 'telemetry_salt_%'")) {
            for (const k of [...settings.keys()]) {
              if (k.startsWith('telemetry_salt_') && k < bound[0]) settings.delete(k);
            }
          } else if (sql.includes('INSERT INTO web_daily_visitors')) {
            const [day_oslo, visitor_hash, country, device, auth_state, first_path, referrer_host, first_seen_at, last_seen_at, evCnt, has_run, has_attempt, has_auth_open, has_signup] = bound;
            const k = `${day_oslo}|${visitor_hash}`;
            const prev = visitors.get(k);
            if (!prev) {
              visitors.set(k, {
                day_oslo, visitor_hash, country, device, auth_state, first_path, referrer_host,
                first_seen_at, last_seen_at, events: evCnt, has_run, has_attempt, has_auth_open, has_signup,
              });
            } else {
              prev.auth_state = prev.auth_state === 'authed' || auth_state === 'authed' ? 'authed' : 'anon';
              prev.last_seen_at = last_seen_at;
              prev.events += evCnt;
              prev.has_run = Math.max(prev.has_run, has_run);
              prev.has_attempt = Math.max(prev.has_attempt, has_attempt);
              prev.has_auth_open = Math.max(prev.has_auth_open, has_auth_open);
              prev.has_signup = Math.max(prev.has_signup, has_signup);
            }
          } else if (sql.includes('INSERT INTO web_daily_events')) {
            const [day_oslo, event, dim, auth_state, delta, last_seen_at] = bound;
            const k = `${day_oslo}|${event}|${dim}|${auth_state}`;
            const prev = events.get(k);
            if (!prev) events.set(k, { day_oslo, event, dim, auth_state, count: delta, last_seen_at });
            else {
              prev.count += delta;
              prev.last_seen_at = last_seen_at;
            }
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
}

test('telemetry normalizers sanitize paths, dimensions, referrers, and devices cleanly', () => {
  assert.equal(normalizePathDim('/index.html?foo=1#bar'), '/');
  assert.equal(normalizePathDim('/bi-oslo.html?utm_source=ig'), '/bi-oslo.html');
  assert.equal(normalizePathDim('courses/acct-2527.html<script>'), '/courses/acct-2527.htmlscript');
  assert.equal(normalizeDim('Practice:ACCT-2527!@#'), 'practice:acct-2527');
  assert.equal(normalizeReferrerHost('https://www.google.com/search?q=bi+oslo'), 'google.com');
  assert.equal(normalizeReferrerHost('https://studyos.no/bi-oslo.html', 'studyos.no'), 'direct');
  assert.equal(normalizeReferrerHost('http://127.0.0.1:8765/'), 'direct');
  assert.equal(detectDeviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 390), 'mobile');
  assert.equal(detectDeviceClass('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 820), 'tablet');
  assert.equal(detectDeviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 1440), 'desktop');
});

test('daily visitor hashes are deterministic within a day, unlinkable across days, and never store raw IPs', async () => {
  resetTelemetrySaltCacheForTest();
  const db = makeTelemetryMockDb();
  const ip = '203.0.113.42';
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';
  const h1 = await computeDailyVisitorHash(db, '2026-11-26', ip, ua);
  const h2 = await computeDailyVisitorHash(db, '2026-11-26', ip, ua);
  assert.equal(h1, h2);
  assert.equal(h1.length, 24);
  assert.ok(!h1.includes(ip));

  const hNextDay = await computeDailyVisitorHash(db, '2026-11-27', ip, ua);
  assert.notEqual(h1, hNextDay);
  // Old day salt must be purged automatically on rotation!
  assert.equal(db.settings.has('telemetry_salt_2026-11-26'), false);
  assert.equal(db.settings.has('telemetry_salt_2026-11-27'), true);
});

test('POST /t rejects untrusted origins and oversized bodies, filters bots, and aggregates anonymous funnel cleanly', async () => {
  resetTelemetrySaltCacheForTest();
  const db = makeTelemetryMockDb();
  const env = { WEB_ORIGIN: ALLOWED_ORIGIN, DB: db };

  // 1. Untrusted origin rejected with 403
  const badOrigin = await worker.fetch(new Request(`${WORKER_URL}/t`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0 Chrome/126' },
    body: JSON.stringify({ events: [{ event: 'page_view', dim: '/' }] }),
  }), env);
  assert.equal(badOrigin.status, 403);

  // 2. Oversized body (> 4096 bytes) rejected with 413
  const tooBig = await worker.fetch(new Request(`${WORKER_URL}/t`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0 Chrome/126' },
    body: JSON.stringify({ events: [{ event: 'page_view', dim: 'x'.repeat(5000) }] }),
  }), env);
  assert.equal(tooBig.status, 413);

  // 3. Bot UA silently ignored (204, zero DB writes)
  const botRes = await worker.fetch(new Request(`${WORKER_URL}/t`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'text/plain', 'User-Agent': 'Googlebot/2.1', 'CF-Connecting-IP': '198.51.100.1' },
    body: JSON.stringify({ events: [{ event: 'page_view', dim: '/' }] }),
  }), env);
  assert.equal(botRes.status, 204);
  assert.equal(db.visitors.size, 0);

  // 4. Anonymous human visitor sends text/plain beacon (no preflight), starts run, attempts 2 Qs
  const humanUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
  const req1 = new Request(`${WORKER_URL}/t`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'text/plain;charset=UTF-8',
      'User-Agent': humanUa,
      'CF-Connecting-IP': '198.51.100.77',
    },
    body: JSON.stringify({
      auth: 'anon',
      path: '/bi-oslo.html',
      ref: 'https://www.google.com/search?q=bi+study+os',
      w: 1440,
      events: [
        { event: 'page_view', dim: '/bi-oslo.html' },
        { event: 'course_open', dim: 'acct-2527' },
        { event: 'run_start', dim: 'practice:acct-2527' },
        { event: 'question_attempt', dim: 'written' },
        { event: 'question_attempt', dim: 'written' },
        { event: 'not_allowed_event', dim: 'drop_me' },
      ],
    }),
  });
  Object.defineProperty(req1, 'cf', { value: { country: 'NO' } });
  const ok1 = await worker.fetch(req1, env);
  assert.equal(ok1.status, 204);
  assert.equal(db.visitors.size, 1);

  // Verify zero raw IP stored anywhere in DB
  for (const row of db.visitors.values()) {
    assert.ok(!JSON.stringify(row).includes('198.51.100.77'));
    assert.equal(row.country, 'NO');
    assert.equal(row.referrer_host, 'google.com');
    assert.equal(row.auth_state, 'anon');
    assert.equal(row.has_run, 1);
    assert.equal(row.has_attempt, 1);
  }

  // 5. Admin summary reports exact counts & 14-day Oslo series
  const summary = await getAdminTelemetrySummary(db, Date.now());
  assert.equal(summary.todayDay, formatOsloDay(Date.now()));
  assert.equal(summary.today.anon, 1);
  assert.equal(summary.today.authed, 0);
  assert.equal(summary.today.startedRun, 1);
  assert.equal(summary.today.attempted, 1);
  assert.equal(summary.events30d.questionsAttempted.anon, 2);
  assert.equal(summary.topPages[0].dim, '/bi-oslo.html');
  assert.equal(summary.topReferrers[0].host, 'google.com');
  assert.equal(summary.countries[0].country, 'NO');
  assert.equal(summary.daily14.length, 14);
});
