import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker, { equalProof, normalizeOrigin } from '../../community/worker.mjs';
import { isAllowedTimetableUrl, isPrivateOrIpHost } from '../../community/timeedit.mjs';
import { handleMaterials } from '../../community/materials.mjs';
import { handleAi } from '../../community/ai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMUNITY_DIR = path.resolve(__dirname, '../../community');

const ALLOWED_ORIGIN = 'https://studyos.no';
const ALT_ORIGIN = 'https://shadjosef.github.io';
const WORKER_URL = 'https://study-os-community.example.workers.dev';
const VALID_TOKEN = 'soc1_' + 'a'.repeat(64);
const VALID_PROFILE_ID = '11111111-2222-4333-8444-555555555555';

async function sha256Hex(str) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeMockDb(handlers = {}) {
  const queries = [];
  return {
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
          if (handlers.first) return handlers.first(sql, bound);
          return null;
        },
        async all() {
          queries.push({ op: 'all', sql, bound });
          if (handlers.all) return handlers.all(sql, bound);
          return { results: [] };
        },
        async run() {
          queries.push({ op: 'run', sql, bound });
          if (handlers.run) return handlers.run(sql, bound);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    WEB_ORIGIN: ALLOWED_ORIGIN,
    WEB_ADDITIONAL_ORIGIN: ALT_ORIGIN,
    DB: makeMockDb(),
    ...overrides,
  };
}

function assertBaseSecurityHeaders(res) {
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
}

async function makeAuthedEnv({ isAdmin = false, extraDb = {}, envOverrides = {}, profileOverrides = {} } = {}) {
  const tokenHash = await sha256Hex(VALID_TOKEN);
  const profileRow = {
    id: VALID_PROFILE_ID,
    primary_token_hash: tokenHash,
    nickname: 'Ada',
    avatar: 'preset:owl',
    bio: 'Studying finance',
    nickname_changed_at: 0,
    secondary_language: 'nb',
    school: 'BI Oslo',
    major: 'Finance',
    canvas_origin: 'https://canvas.bi.no',
    newsletter_opt_in: 1,
    newsletter_opt_in_at: 1_700_000_000_000,
    contact_email: 'ada.secret@example.edu',
    tos_accepted_at: 1_700_000_000_000,
    study_minutes: 120,
    break_minutes: 15,
    break_count: 2,
    last_break_at: 1_700_000_000_000,
    completed: 10,
    attempts: 12,
    accuracy: 83,
    break_ends_at: Date.now() + 600_000,
    expires_at: Date.now() + 600_000,
    session_created_at: 1_700_000_000_000,
    session_last_used_at: Date.now(),
    ...profileOverrides,
  };
  const db = makeMockDb({
    async first(sql, bound) {
      if (sql.includes('FROM profiles LEFT JOIN presence') && bound[0] === tokenHash) {
        return profileRow;
      }
      if (extraDb.first) return extraDb.first(sql, bound);
      return null;
    },
    all: extraDb.all,
    run: extraDb.run,
  });
  return makeEnv({
    DB: db,
    ...(isAdmin ? { ADMIN_TOKEN_HASH: tokenHash } : {}),
    ...envOverrides,
  });
}

// ---------------------------------------------------------------------------
// 1. Static Security Audit across ALL community/*.mjs
// ---------------------------------------------------------------------------
test('static audit: zero unparameterized D1 SQL or dynamic code execution in community/*.mjs', async () => {
  const entries = (await fs.readdir(COMMUNITY_DIR)).filter((f) => f.endsWith('.mjs')).sort();
  assert.ok(entries.length >= 12, `Expected >= 12 worker modules, found ${entries.length}`);

  for (const file of entries) {
    const src = await fs.readFile(path.join(COMMUNITY_DIR, file), 'utf8');

    // No eval / new Function
    assert.equal(/\beval\s*\(/.test(src), false, `${file}: forbidden eval()`);
    assert.equal(/\bnew\s+Function\s*\(/.test(src), false, `${file}: forbidden new Function()`);

    // Inspect every .prepare(...) call
    const prepareRegex = /\.prepare\s*\(/g;
    let match;
    while ((match = prepareRegex.exec(src)) !== null) {
      const start = match.index + match[0].length;
      let depth = 1;
      let i = start;
      let quote = null;
      let escaped = false;
      for (; i < src.length && depth > 0; i++) {
        const ch = src[i];
        if (escaped) { escaped = false; continue; }
        if (quote) {
          if (ch === '\\') { escaped = true; continue; }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      const arg = src.slice(start, i - 1).trim();
      assert.equal(arg.includes('${'), false, `${file}: template interpolation inside .prepare(): ${arg.slice(0, 120)}`);
      assert.equal(/(?:['"`]\s*\+|\+\s*['"`])/.test(arg), false, `${file}: string concatenation inside .prepare(): ${arg.slice(0, 120)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. CORS Origin Allowlist Strictness & Preflight Rejection
// ---------------------------------------------------------------------------
test('CORS rejects untrusted, spoofed, HTTP, null, and missing web origins without reflecting ACAO', async () => {
  const env = makeEnv();
  const evilOrigins = [
    'https://evil.example',
    'https://studyos.no.evil.example',
    'https://evil-studyos.no',
    'http://studyos.no',
    'https://studyos.no/',
    'https://studyos.no:8443',
    'null',
    'javascript:alert(1)',
    'file://',
  ];

  for (const origin of evilOrigins) {
    const res = await worker.fetch(new Request(`${WORKER_URL}/auth/config`, {
      method: 'GET',
      headers: { Origin: origin },
    }), env);
    assert.equal(res.status, 403, `Expected 403 for origin ${origin}`);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null, `Must not reflect ACAO for ${origin}`);
    assertBaseSecurityHeaders(res);
  }

  // Missing origin without extension header on web route
  const noOriginRes = await worker.fetch(new Request(`${WORKER_URL}/auth/config`, { method: 'GET' }), env);
  assert.equal(noOriginRes.status, 403);
  assert.equal(noOriginRes.headers.get('Access-Control-Allow-Origin'), null);
  assertBaseSecurityHeaders(noOriginRes);

  // OPTIONS preflight from untrusted origin must return 403 with no ACAO
  const evilPreflight = await worker.fetch(new Request(`${WORKER_URL}/sync`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://attacker.example' },
  }), env);
  assert.equal(evilPreflight.status, 403);
  assert.equal(evilPreflight.headers.get('Access-Control-Allow-Origin'), null);
  assertBaseSecurityHeaders(evilPreflight);
});

test('CORS accepts configured web origins on GET and OPTIONS with strict security headers', async () => {
  const env = makeEnv();

  for (const origin of [ALLOWED_ORIGIN, ALT_ORIGIN]) {
    const preflight = await worker.fetch(new Request(`${WORKER_URL}/sync`, {
      method: 'OPTIONS',
      headers: { Origin: origin },
    }), env);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(preflight.headers.get('Vary'), 'Origin');
    assertBaseSecurityHeaders(preflight);

    const cfg = await worker.fetch(new Request(`${WORKER_URL}/auth/config`, {
      method: 'GET',
      headers: { Origin: origin },
    }), env);
    assert.equal(cfg.status, 200);
    assert.equal(cfg.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(cfg.headers.get('Cache-Control'), 'no-store');
    assertBaseSecurityHeaders(cfg);
  }
});

test('CORS allows exact Desktop Edition loopback origins on cloud auth/sync while blocking web telemetry /t and non-8765 ports', async () => {
  const env = makeEnv();

  for (const deskOrigin of ['http://127.0.0.1:8765', 'http://localhost:8765']) {
    const cfg = await worker.fetch(new Request(`${WORKER_URL}/auth/config`, {
      method: 'GET',
      headers: { Origin: deskOrigin },
    }), env);
    assert.equal(cfg.status, 200);
    assert.equal(cfg.headers.get('Access-Control-Allow-Origin'), deskOrigin);
    assertBaseSecurityHeaders(cfg);

    const telem = await worker.fetch(new Request(`${WORKER_URL}/t`, {
      method: 'POST',
      headers: { Origin: deskOrigin, 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0 Chrome/126' },
      body: JSON.stringify({ events: [{ event: 'page_view', dim: '/' }] }),
    }), env);
    assert.equal(telem.status, 403, 'Desktop loopback must never pollute /t web telemetry');
  }

  for (const badPort of ['http://127.0.0.1:9999', 'http://localhost:3000', 'http://evil.example:8765']) {
    const res = await worker.fetch(new Request(`${WORKER_URL}/auth/config`, {
      method: 'GET',
      headers: { Origin: badPort },
    }), env);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('CORS extension rules enforce strict path scope, extension ID pinning, and no header spoofing', async () => {
  const validExtOrigin = 'chrome-extension://' + 'a'.repeat(32);
  const otherExtOrigin = 'chrome-extension://' + 'b'.repeat(32);
  const env = makeEnv();

  // Extension origin forbidden on non-extension sensitive routes
  for (const forbiddenPath of ['/admin/overview', '/sync', '/delete-profile', '/ai/tutor', '/materials']) {
    const res = await worker.fetch(new Request(`${WORKER_URL}${forbiddenPath}`, {
      method: 'GET',
      headers: { Origin: validExtOrigin },
    }), env);
    assert.equal(res.status, 403, `Extension origin must be rejected on ${forbiddenPath}`);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }

  // Spoofed X-Study-OS-Client header alongside untrusted web Origin must be rejected
  const spoof = await worker.fetch(new Request(`${WORKER_URL}/courses/sync`, {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      'X-Study-OS-Client': 'extension',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ courses: [] }),
  }), env);
  assert.equal(spoof.status, 403);
  assert.equal(spoof.headers.get('Access-Control-Allow-Origin'), null);

  // Pinned CHROME_EXTENSION_IDS allows pinned ID and rejects unpinned ID
  const pinnedEnv = makeEnv({ CHROME_EXTENSION_IDS: 'a'.repeat(32) });
  const allowedExt = await worker.fetch(new Request(`${WORKER_URL}/profile`, {
    method: 'GET',
    headers: { Origin: validExtOrigin },
  }), pinnedEnv);
  assert.equal(allowedExt.status, 401); // Passed CORS, rejected by auth
  assert.equal(allowedExt.headers.get('Access-Control-Allow-Origin'), validExtOrigin);

  const blockedExt = await worker.fetch(new Request(`${WORKER_URL}/profile`, {
    method: 'GET',
    headers: { Origin: otherExtOrigin },
  }), pinnedEnv);
  assert.equal(blockedExt.status, 403);
  assert.equal(blockedExt.headers.get('Access-Control-Allow-Origin'), null);

  // Extension background fetch without Origin header on /auth/extension-link must not crash (no 500)
  const extLink = await worker.fetch(new Request(`${WORKER_URL}/auth/extension-link`, {
    method: 'POST',
    headers: {
      'X-Study-OS-Client': 'extension',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code: 'INVALID' }),
  }), env);
  assert.equal(extLink.status, 400);
  assert.equal(extLink.headers.get('Access-Control-Allow-Origin'), null);
  assertBaseSecurityHeaders(extLink);
});

test('normalizeOrigin handles edge cases cleanly', () => {
  assert.equal(normalizeOrigin('https://studyos.no/'), 'https://studyos.no');
  assert.equal(normalizeOrigin('http://localhost:8765'), 'http://localhost:8765');
  assert.equal(normalizeOrigin('http://127.0.0.1:8765'), 'http://127.0.0.1:8765');
  assert.equal(normalizeOrigin('http://studyos.no'), '');
  assert.equal(normalizeOrigin('https://user:pass@studyos.no'), '');
  assert.equal(normalizeOrigin('null'), '');
  assert.equal(normalizeOrigin('*'), '');
});

// ---------------------------------------------------------------------------
// 3. Method Enforcement, Body Validation, Oversized Payloads & Safe 500s
// ---------------------------------------------------------------------------
test('rejects unsupported HTTP methods with 405 and malformed/oversized JSON payloads with 400/413', async () => {
  const env = makeEnv();

  const delRes = await worker.fetch(new Request(`${WORKER_URL}/profile`, {
    method: 'DELETE',
    headers: { Origin: ALLOWED_ORIGIN },
  }), env);
  assert.equal(delRes.status, 405);
  assertBaseSecurityHeaders(delRes);

  // Malformed JSON
  const badJson = await worker.fetch(new Request(`${WORKER_URL}/join`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: '{not-valid-json',
  }), env);
  assert.equal(badJson.status, 400);
  assertBaseSecurityHeaders(badJson);

  // Non-object JSON array
  const arrJson = await worker.fetch(new Request(`${WORKER_URL}/join`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(['a', 'b']),
  }), env);
  assert.equal(arrJson.status, 400);

  // Oversized body (> 65,536 bytes on /join) rejected with 413
  const bigBody = JSON.stringify({ pad: 'x'.repeat(70_000) });
  const bigRes = await worker.fetch(new Request(`${WORKER_URL}/join`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: bigBody,
  }), env);
  assert.equal(bigRes.status, 413);
  assertBaseSecurityHeaders(bigRes);

  // Oversized body via Content-Length fast-fail
  const declaredBig = await worker.fetch(new Request(`${WORKER_URL}/join`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
      'Content-Length': '9999999',
    },
    body: '{}',
  }), env);
  assert.equal(declaredBig.status, 413);
});

test('unhandled internal DB errors never leak stack traces or SQL messages', async () => {
  const env = makeEnv({
    DB: makeMockDb({
      async first() { throw new Error('SQLITE_INTERNAL_SECRET_SCHEMA_DETAIL at line 42'); },
      async all() { throw new Error('SQLITE_INTERNAL_SECRET_SCHEMA_DETAIL at line 42'); },
    }),
  });

  const res = await worker.fetch(new Request(`${WORKER_URL}/leaderboard/public`, {
    method: 'GET',
    headers: { Origin: ALLOWED_ORIGIN },
  }), env);
  assert.equal(res.status, 500);
  assertBaseSecurityHeaders(res);
  const body = await res.json();
  assert.equal(body.error, 'Internal server error.');
  assert.equal(JSON.stringify(body).includes('SQLITE_INTERNAL'), false);
});

// ---------------------------------------------------------------------------
// 4. SSRF Protections (TimeEdit / TP Timetable URL Validation)
// ---------------------------------------------------------------------------
test('SSRF: isPrivateOrIpHost and isAllowedTimetableUrl reject private IPs, metadata, spoofing, and bad schemes', () => {
  // Valid URLs
  assert.ok(isAllowedTimetableUrl('https://cloud.timeedit.net/bi/web/public/ri12345.ics'));
  assert.ok(isAllowedTimetableUrl('webcal://cloud.timeedit.net/bi/web/public/ri12345.ics'));
  assert.ok(isAllowedTimetableUrl('https://tp.educloud.no/bi/timeplan/ical.php?type=course'));
  assert.ok(isAllowedTimetableUrl('https://tp.uio.no/uio/timeplan/ical'));

  // Private/loopback/metadata/IP literals
  for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.1.1', '::1', '[::1]', 'localhost', 'foo.localhost', '2130706433', '0x7f000001']) {
    assert.equal(isPrivateOrIpHost(host), true, `Expected ${host} to be flagged private/IP`);
  }

  // SSRF URL payloads
  const blockedUrls = [
    'https://127.0.0.1/cal.ics',
    'https://169.254.169.254/latest/meta-data/cal.ics',
    'https://[::1]/cal.ics',
    'https://localhost/cal.ics',
    'http://cloud.timeedit.net/bi/cal.ics',
    'https://cloud.timeedit.net.evil.com/bi/cal.ics',
    'https://evil.com/cloud.timeedit.net/cal.ics',
    'https://user:pass@cloud.timeedit.net/bi/cal.ics',
    'https://cloud.timeedit.net:8443/bi/cal.ics',
    'https://cloud.timeedit.net/bi/cal.ics#frag',
    'https://cloud.timeedit.net/bi/%2e%2e/admin/cal.ics',
    'https://cloud.timeedit.net/bi/cal%00.ics',
    'https://cloud.timeedit.net/admin/login',
    'file:///etc/passwd.ics',
    'webcal:https://evil.com/cal.ics',
    'https://cloud.timeedit.net/bi/cal.ics\r\nX-Injected: 1',
  ];

  for (const bad of blockedUrls) {
    assert.equal(isAllowedTimetableUrl(bad), null, `Expected SSRF URL to be rejected: ${bad}`);
  }
});

test('SSRF: POST /schedule/timeedit rejects non-allowlisted / metadata URLs without fetching', async () => {
  const env = await makeAuthedEnv();
  const res = await worker.fetch(new Request(`${WORKER_URL}/schedule/timeedit`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: 'https://169.254.169.254/latest/meta-data/iam.ics' }),
  }), env);
  assert.equal(res.status, 400);
  assertBaseSecurityHeaders(res);
});

// ---------------------------------------------------------------------------
// 5. Auth Guard, Admin Guard, Data Hygiene, Constant-Time Proof & Rate Limit
// ---------------------------------------------------------------------------
test('protected endpoints reject missing, malformed, and unknown Bearer tokens with 401 + no-store', async () => {
  const env = makeEnv();
  const protectedRoutes = [
    ['GET', '/profile'],
    ['GET', '/sync'],
    ['GET', '/dashboard'],
    ['GET', '/admin/overview'],
    ['GET', '/materials'],
    ['GET', '/ai/status'],
    ['GET', '/duels/active'],
    ['POST', '/delete-profile'],
    ['POST', '/schedule/timeedit'],
  ];

  for (const [method, route] of protectedRoutes) {
    for (const authHeader of ['', 'Bearer invalid', `Bearer ${VALID_TOKEN}`]) {
      const headers = { Origin: ALLOWED_ORIGIN };
      if (authHeader) headers.Authorization = authHeader;
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      const res = await worker.fetch(new Request(`${WORKER_URL}${route}`, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify({}) : undefined,
      }), env);
      assert.equal(res.status, 401, `Expected 401 for ${method} ${route} (${authHeader || 'no auth'})`);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
      assertBaseSecurityHeaders(res);
    }
  }
});

test('non-admin member is rejected with 403 on all /admin/* endpoints', async () => {
  const env = await makeAuthedEnv({ isAdmin: false });
  const adminRoutes = [
    ['GET', '/admin/overview'],
    ['POST', '/admin/settings'],
    ['POST', '/admin/invites'],
    ['POST', '/admin/members'],
    ['POST', '/admin/feedback'],
    ['GET', '/admin/courses'],
  ];

  for (const [method, route] of adminRoutes) {
    const res = await worker.fetch(new Request(`${WORKER_URL}${route}`, {
      method,
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${VALID_TOKEN}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: method === 'POST' ? JSON.stringify({}) : undefined,
    }), env);
    assert.equal(res.status, 403, `Expected 403 for non-admin on ${method} ${route}`);
    assertBaseSecurityHeaders(res);
  }
});

test('GET /dashboard strips internal primary_token_hash and raw contact_email from response', async () => {
  const env = await makeAuthedEnv();
  const res = await worker.fetch(new Request(`${WORKER_URL}/dashboard`, {
    method: 'GET',
    headers: {
      Origin: ALLOWED_ORIGIN,
      Authorization: `Bearer ${VALID_TOKEN}`,
    },
  }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assertBaseSecurityHeaders(res);
  const body = await res.json();
  assert.equal(body.me.primary_token_hash, undefined);
  assert.equal(body.me.contact_email, undefined);
  assert.equal(body.me.session_last_used_at, undefined);
  assert.equal(body.me.session_created_at, undefined);
  assert.equal(body.me.contactEmailHint, 'a***@example.edu');
  assert.equal(body.me.nickname, 'Ada');
  assert.equal(body.me.completed, 10);
});

test('GET /dashboard unlocks during the 10-min post-login welcome window even outside break/evening', async () => {
  const nowMs = Date.now();
  const env = await makeAuthedEnv({
    profileOverrides: {
      break_ends_at: 0,
      expires_at: 0,
      tos_accepted_at: nowMs - 60_000,
    },
  });
  const res = await worker.fetch(new Request(`${WORKER_URL}/dashboard`, {
    method: 'GET',
    headers: {
      Origin: ALLOWED_ORIGIN,
      Authorization: `Bearer ${VALID_TOKEN}`,
    },
  }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.me.welcomeCommunityUntil > nowMs, 'Expected active welcomeCommunityUntil timestamp');
});

test('equalProof validates exact 64-hex digests only', () => {
  const a = 'a'.repeat(64);
  const b = 'a'.repeat(63) + 'b';
  assert.equal(equalProof(a, a), true);
  assert.equal(equalProof(a, b), false);
  assert.equal(equalProof(a, 'a'.repeat(63)), false);
  assert.equal(equalProof('Z'.repeat(64), 'Z'.repeat(64)), false);
  assert.equal(equalProof('', ''), false);
});

test('rate limiter throttles passkey login, redeem-code, google auth, and join with 429', async () => {
  const seenKeys = [];
  const env = makeEnv({
    AUTH_RATE_LIMIT: {
      async limit({ key }) {
        seenKeys.push(key);
        return { success: false };
      },
    },
  });

  for (const route of ['/join', '/auth/google', '/auth/passkey/login/options', '/auth/passkey/login/verify', '/auth/redeem-code']) {
    const res = await worker.fetch(new Request(`${WORKER_URL}${route}`, {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'CF-Connecting-IP': '203.0.113.10',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }), env);
    assert.equal(res.status, 429, `Expected 429 rate limit on ${route}`);
    assertBaseSecurityHeaders(res);
  }
  assert.ok(seenKeys.some((k) => k.startsWith('passkey_opts:')));
  assert.ok(seenKeys.some((k) => k.startsWith('passkey_verify:')));
  assert.ok(seenKeys.some((k) => k.startsWith('redeem:')));
});

test('WebAuthn passkey login rejects crossOrigin assertions and origin mismatches', async () => {
  const env = makeEnv();
  const toB64Url = (str) => Buffer.from(str).toString('base64url');
  const crossOriginClientData = toB64Url(JSON.stringify({
    type: 'webauthn.get',
    origin: ALLOWED_ORIGIN,
    challenge: 'test-challenge-1234',
    crossOrigin: true,
  }));
  const dummyAuthData = Buffer.alloc(37).toString('base64url');
  const dummySig = Buffer.alloc(64).toString('base64url');

  const res = await worker.fetch(new Request(`${WORKER_URL}/auth/passkey/login/verify`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credentialId: 'validCredentialId1234',
      clientDataJSON: crossOriginClientData,
      authenticatorData: dummyAuthData,
      signature: dummySig,
    }),
  }), env);
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// 6. Prototype Pollution, Share URL Restriction, Material Quota & AI Errors
// ---------------------------------------------------------------------------
test('POST /sync strips prototype pollution keys cleanly', async () => {
  let savedPayload = null;
  const env = await makeAuthedEnv({
    extraDb: {
      async run(sql, bound) {
        if (sql.includes('INSERT INTO study_backups')) savedPayload = JSON.parse(bound[1]);
        return { meta: { changes: 1 } };
      },
    },
  });

  const rawBody = JSON.stringify({
    records: { 'course:q1': { done: true } },
    customSchedule: {
      enabled: true,
      prefs: JSON.parse('{"__proto__":{"polluted":true},"timeeditUrl":"https://secret.ics","wakeTime":"07:30"}'),
      blocks: [],
      completedEvents: JSON.parse('{"__proto__":"2026-11-20T10:00:00Z","ev1":"2026-11-20T10:00:00Z"}'),
      dismissedEvents: JSON.parse('{"constructor":"2026-11-20T10:00:00Z","ev2":"2026-11-20T10:00:00Z"}'),
    },
  });

  const res = await worker.fetch(new Request(`${WORKER_URL}/sync`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: rawBody,
  }), env);
  assert.equal(res.status, 200);
  assert.equal(({}).polluted, undefined);
  assert.ok(savedPayload);
  assert.equal(Object.prototype.hasOwnProperty.call(savedPayload.customSchedule.prefs, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(savedPayload.customSchedule.prefs, 'timeeditUrl'), false);
  assert.equal(savedPayload.customSchedule.prefs.wakeTime, '07:30');
  assert.equal(Object.prototype.hasOwnProperty.call(savedPayload.customSchedule.completedEvents, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(savedPayload.customSchedule.dismissedEvents, 'constructor'), false);
});

test('POST /shares rejects phishing external origins while accepting allowlisted Study-OS links', async () => {
  const recipientId = '22222222-3333-4444-8555-666666666666';
  const env = await makeAuthedEnv({
    extraDb: {
      async first(sql) {
        if (sql.includes('SELECT id, nickname FROM profiles WHERE id = ?')) {
          return { id: recipientId, nickname: 'Bob' };
        }
        return null;
      },
    },
  });

  const phishRes = await worker.fetch(new Request(`${WORKER_URL}/shares`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: recipientId,
      title: 'Exam notes',
      url: 'https://evil-phish.example/?play=fake123',
    }),
  }), env);
  assert.equal(phishRes.status, 400);

  const okRes = await worker.fetch(new Request(`${WORKER_URL}/shares`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: recipientId,
      title: 'Exam notes',
      url: `${ALLOWED_ORIGIN}/?play=acct123`,
    }),
  }), env);
  assert.equal(okRes.status, 201);
});

test('materials: enforces chunkCount quota integrity and emits hardened download headers with Unicode filename safety', async () => {
  const replies = [];
  const reply = (data, status = 200) => {
    replies.push({ data, status });
    return Response.json(data, { status });
  };
  const db = makeMockDb({
    async first(sql) {
      if (sql.includes('SELECT title, mime_type')) {
        return { title: 'EBA 1181 — Øving 1.pdf', mimeType: 'application/pdf', sizeBytes: 4 };
      }
      return { cnt: 0, totalBytes: 0 };
    },
    async all(sql) {
      if (sql.includes('FROM user_material_chunks')) {
        return { results: [{ data_b64: Buffer.from('%PDF').toString('base64') }] };
      }
      return { results: [] };
    },
  });

  // Chunk inflation bypass attempt: 100 bytes declaring 50 chunks must be rejected with 400
  const initRes = await handleMaterials({
    request: new Request(`${WORKER_URL}/materials/init`, { method: 'POST' }),
    url: new URL(`${WORKER_URL}/materials/init`),
    path: '/materials/init',
    db,
    me: { id: VALID_PROFILE_ID },
    now: Date.now(),
    data: { title: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 100, chunkCount: 50 },
    reply,
    corsHeaders: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, Vary: 'Origin' },
  });
  assert.equal(initRes.status, 400);

  // Download with Unicode em-dash in filename must NOT throw ByteString error and must send CSP + security headers
  const dlUrl = `${WORKER_URL}/materials/download?id=${VALID_PROFILE_ID}`;
  const dlRes = await handleMaterials({
    request: new Request(dlUrl, { method: 'GET' }),
    url: new URL(dlUrl),
    path: '/materials/download',
    db,
    me: { id: VALID_PROFILE_ID },
    now: Date.now(),
    data: {},
    reply,
    corsHeaders: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, Vary: 'Origin' },
  });
  assert.equal(dlRes.status, 200);
  assert.equal(dlRes.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(dlRes.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  assertBaseSecurityHeaders(dlRes);
  assert.match(dlRes.headers.get('Content-Disposition') || '', /^inline; filename="EBA 1181 _ _ving 1\.pdf"; filename\*=UTF-8''/);
});

test('AI endpoints never leak raw upstream error messages to clients', async () => {
  const reply = (data, status = 200) => Response.json(data, { status });
  const db = makeMockDb();
  const res = await handleAi({
    request: new Request(`${WORKER_URL}/ai/tutor`, { method: 'POST' }),
    path: '/ai/tutor',
    db,
    env: {
      AI: {
        async run() {
          throw new Error('INTERNAL_ACCOUNT_SECRET_ID=987654321 failed');
        },
      },
    },
    me: { id: VALID_PROFILE_ID, school: 'BI Oslo' },
    isAdmin: false,
    now: Date.now(),
    data: { action: 'hint', message: 'Help with NPV' },
    reply,
    corsHeaders: {},
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'Adamlite is temporarily busy. Please try again.');
  assert.equal(JSON.stringify(body).includes('INTERNAL_ACCOUNT_SECRET_ID'), false);
});
