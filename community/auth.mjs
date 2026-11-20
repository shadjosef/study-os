// WebAuthn Passkeys (Face ID / Touch ID), Multi-Device Sessions, and 5-Minute Link Codes
// Zero-dependency ES2020 module using standard Web Crypto API on Cloudflare Workers.

import { turnstileSiteKey } from './human.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const LINK_CODE_TTL_MS = 5 * 60 * 1000;
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const MAX_PASSKEYS_PER_PROFILE = 10;
const MAX_SESSIONS_PER_PROFILE = 25;
let googleJwksCache = { keys: [], fetchedAt: 0 };

function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '';
  const [local, domain] = email.trim().split('@');
  if (!local || !domain) return '';
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`.slice(0, 64);
}

function cleanSuggestedName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(/[^\p{L}\p{N} ._-]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

async function fetchGoogleJwks(force = false) {
  const now = Date.now();
  if (!force && googleJwksCache.keys.length && now - googleJwksCache.fetchedAt < 3_600_000) {
    return googleJwksCache.keys;
  }
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error('Could not reach Google sign-in keys.');
  const body = await res.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  googleJwksCache = { keys, fetchedAt: now };
  return keys;
}

export async function verifyGoogleIdToken(idToken, expectedClientId, now = Date.now()) {
  if (!expectedClientId) throw new Error('Google Sign-In is not configured yet.');
  if (typeof idToken !== 'string' || idToken.length < 40 || idToken.length > 8192) {
    throw new Error('Invalid Google token.');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed Google token.');
  const [headerB64, payloadB64, sigB64] = parts;
  const headerRaw = fromBase64Url(headerB64);
  const payloadRaw = fromBase64Url(payloadB64);
  const sigBytes = fromBase64Url(sigB64);
  if (!headerRaw || !payloadRaw || !sigBytes) throw new Error('Could not decode Google token.');

  let header;
  let payload;
  try {
    header = JSON.parse(decoder.decode(headerRaw));
    payload = JSON.parse(decoder.decode(payloadRaw));
  } catch {
    throw new Error('Malformed Google token JSON.');
  }
  if (header?.alg !== 'RS256' || typeof header?.kid !== 'string') {
    throw new Error('Unsupported Google token algorithm.');
  }
  if (payload?.iss !== 'https://accounts.google.com' && payload?.iss !== 'accounts.google.com') {
    throw new Error('Invalid Google token issuer.');
  }
  if (payload?.aud !== expectedClientId) {
    throw new Error('Google token audience mismatch.');
  }
  if (payload?.email_verified !== true) {
    throw new Error('Use a verified Google account.');
  }
  if (typeof payload?.sub !== 'string' || payload.sub.length < 6 || payload.sub.length > 128) {
    throw new Error('Missing Google account identifier.');
  }
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) * 1000 <= now - 30_000) {
    throw new Error('Google sign-in expired. Try again.');
  }
  if (payload.nbf && Number(payload.nbf) * 1000 > now + 60_000) {
    throw new Error('Google token not yet valid.');
  }

  let keys = await fetchGoogleJwks(false);
  let jwk = keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) {
    keys = await fetchGoogleJwks(true);
    jwk = keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  }
  if (!jwk) throw new Error('Google signing key not found.');

  const pubKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    pubKey,
    sigBytes,
    encoder.encode(`${headerB64}.${payloadB64}`)
  );
  if (!ok) throw new Error('Google token signature verification failed.');

  return {
    sub: payload.sub,
    email: cleanContactEmail(payload.email || ''),
    emailHint: maskEmail(payload.email || ''),
    suggestedName: cleanSuggestedName(payload.given_name || payload.name || ''),
  };
}

const ALLOWED_SECONDARY_LANGS = new Set([
  '', 'nb', 'nn', 'sv', 'da', 'ar', 'ur', 'pl', 'de', 'fr', 'es',
  'zh', 'hi', 'uk', 'lt', 'so', 'vi', 'pt', 'it', 'ru', 'tr', 'fa', 'ko', 'ja',
]);
const SIMPLE_EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

export function cleanSecondaryLanguage(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return ALLOWED_SECONDARY_LANGS.has(s) ? s : '';
}

export function cleanContactEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  return SIMPLE_EMAIL_RE.test(s) && s.length <= 254 ? s : '';
}

export function maskEmailHint(raw) {
  const s = String(raw || '').trim();
  const at = s.indexOf('@');
  if (at <= 0) return '';
  return `${s[0]}***${s.slice(at)}`;
}

export function toBase64Url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(str)) return null;
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function derToP1363(der) {
  if (!(der instanceof Uint8Array) || der.length < 8 || der[0] !== 0x30) return null;
  let offset = 1;
  let seqLen = der[offset++];
  if (seqLen & 0x80) {
    const lenBytes = seqLen & 0x7f;
    if (lenBytes === 0 || lenBytes > 2 || offset + lenBytes > der.length) return null;
    seqLen = 0;
    for (let i = 0; i < lenBytes; i++) seqLen = (seqLen << 8) | der[offset++];
  }
  if (offset + seqLen !== der.length) return null;

  function readInt() {
    if (offset + 2 > der.length || der[offset++] !== 0x02) return null;
    const len = der[offset++];
    if (len === 0 || (len & 0x80) || offset + len > der.length) return null;
    let slice = der.subarray(offset, offset + len);
    offset += len;
    if (slice.length === 33 && slice[0] === 0x00) slice = slice.subarray(1);
    if (slice.length > 32) return null;
    return slice;
  }

  const r = readInt();
  const s = readInt();
  if (!r || !s || offset !== der.length) return null;

  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

function bytesEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function cleanLabel(raw, fallback = 'Browser session') {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 48) : fallback;
}

async function importPasskeySpki(spkiBytes, algorithm) {
  if (algorithm === -7) {
    return crypto.subtle.importKey('spki', spkiBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  if (algorithm === -257) {
    return crypto.subtle.importKey('spki', spkiBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
  throw new Error('Unsupported passkey algorithm.');
}

async function createDeviceSession(db, profileId, label, now, digest, hex) {
  const token = 'soc1_' + hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await digest(token);
  await db.prepare(
    'INSERT INTO profile_sessions(token_hash, profile_id, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(tokenHash, profileId, cleanLabel(label), now, now).run();
  // Trim oldest sessions beyond cap
  await db.prepare(`
    DELETE FROM profile_sessions WHERE profile_id = ? AND token_hash NOT IN (
      SELECT token_hash FROM profile_sessions WHERE profile_id = ? ORDER BY last_used_at DESC LIMIT ?
    )
  `).bind(profileId, profileId, MAX_SESSIONS_PER_PROFILE).run();
  return token;
}

function parseClientData(b64) {
  const raw = fromBase64Url(b64);
  if (!raw || raw.length > 2048) return null;
  try {
    const json = JSON.parse(decoder.decode(raw));
    return { raw, json };
  } catch {
    return null;
  }
}

export async function handlePublicAuth({
  request, path, db, env, now, data, reply, digest, hex, verifyJoinProof, consumeInviteUse, equalProof, nicknamePattern,
}) {
  if (path === '/auth/config' && request.method === 'GET') {
    const googleClientId = typeof env.GOOGLE_CLIENT_ID === 'string' ? env.GOOGLE_CLIENT_ID.trim() : '';
    const siteKey = turnstileSiteKey(env);
    return reply({ googleClientId, turnstileSiteKey: siteKey, openSignup: Boolean(siteKey),
      googleOpenSignup: Boolean(googleClientId), recoveryEnabled: true });
  }
  if (request.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
  const webOrigin = request.headers.get('Origin');
  const rpId = new URL(webOrigin).hostname;

  if (path === '/auth/recovery') {
    const key = typeof data.key === 'string' && data.key.length <= 100
      ? data.key.trim().toUpperCase().replace(/[\s-]/g, '')
      : '';
    if (!/^[A-HJ-NP-Z2-9]{32}$/.test(key)) {
      return reply({ error: 'Enter the 32-character recovery key you saved.' }, 400);
    }
    const row = await db.prepare(`
      SELECT p.id, p.nickname FROM recovery_keys r JOIN profiles p ON p.id = r.profile_id
      WHERE r.key_hash = ?
    `).bind(await digest('recovery:' + key)).first();
    if (!row) return reply({ error: 'That recovery key is invalid.' }, 401);
    const token = await createDeviceSession(db, row.id, cleanLabel(data.label, 'Recovered device'), now, digest, hex);
    return reply({ token, profileId: row.id, nickname: row.nickname });
  }

  if (path === '/auth/google') {
    const clientId = typeof env.GOOGLE_CLIENT_ID === 'string' ? env.GOOGLE_CLIENT_ID.trim() : '';
    let verified;
    try {
      verified = await verifyGoogleIdToken(data.idToken, clientId, now);
    } catch (err) {
      return reply({ error: err.message || 'Google sign-in failed.' }, 401);
    }
    const existing = await db.prepare(`
      SELECT l.profile_id, p.nickname
      FROM oauth_links l JOIN profiles p ON p.id = l.profile_id
      WHERE l.provider = 'google' AND l.provider_sub = ?
    `).bind(verified.sub).first();

    if (existing) {
      const token = await createDeviceSession(
        db,
        existing.profile_id,
        cleanLabel(data.label, 'Google sign-in'),
        now,
        digest,
        hex
      );
      return reply({ token, profileId: existing.profile_id, nickname: existing.nickname });
    }

    await db.prepare('DELETE FROM oauth_pending WHERE expires_at < ?').bind(now).run();
    const ticket = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    await db.prepare(`
      INSERT INTO oauth_pending(ticket, provider, provider_sub, email_hint, verified_email, suggested_name, expires_at)
      VALUES (?, 'google', ?, ?, ?, ?, ?)
    `).bind(ticket, verified.sub, verified.emailHint, verified.email || '', verified.suggestedName, now + OAUTH_PENDING_TTL_MS).run();

    return reply({
      needsJoin: true,
      ticket,
      suggestedName: verified.suggestedName,
      emailHint: verified.emailHint,
    });
  }

  if (path === '/auth/google/complete') {
    const ticket = typeof data.ticket === 'string' ? data.ticket.trim() : '';
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(ticket)) {
      return reply({ error: 'Google sign-up session expired. Click Continue with Google again.' }, 401);
    }
    const pending = await db.prepare(
      "SELECT ticket, provider_sub, email_hint, verified_email FROM oauth_pending WHERE ticket = ? AND provider = 'google' AND expires_at >= ?"
    ).bind(ticket, now).first();
    if (!pending) {
      return reply({ error: 'Google sign-up session expired. Click Continue with Google again.' }, 401);
    }

    const check = await verifyJoinProof(db, env, data.proof, now, equalProof, true);
    if (!check.ok) return reply({ error: check.error }, 403);

    const nickname = typeof data.nickname === 'string' ? data.nickname.trim().normalize('NFC') : '';
    if (!nicknamePattern.test(nickname)) {
      return reply({ error: 'Choose a nickname of 2–24 letters, numbers or spaces.' }, 400);
    }
    const secondaryLanguage = cleanSecondaryLanguage(data.secondaryLanguage);
    const newsletterOptIn = Boolean(data.newsletterOptIn) ? 1 : 0;
    const contactEmail = newsletterOptIn ? cleanContactEmail(data.contactEmail || pending.verified_email || '') : '';
    const newsletterOptInAt = newsletterOptIn ? now : 0;
    const tosAcceptedAt = data.tosAccepted === false ? 0 : now;

    const consumed = await db.prepare('DELETE FROM oauth_pending WHERE ticket = ?').bind(ticket).run();
    if (!consumed.meta.changes) {
      return reply({ error: 'Google sign-up session already used.' }, 409);
    }

    const id = crypto.randomUUID();
    const primaryToken = 'soc1_' + hex(crypto.getRandomValues(new Uint8Array(32)));
    const inserted = await db.prepare(`
      INSERT OR IGNORE INTO profiles(id, token_hash, nickname, secondary_language, newsletter_opt_in, newsletter_opt_in_at, contact_email, tos_accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, await digest(primaryToken), nickname, secondaryLanguage, newsletterOptIn, newsletterOptInAt, contactEmail, tosAcceptedAt).run();
    if (!inserted.meta.changes) {
      // Put ticket back so user can pick another nickname without re-auth
      await db.prepare(`
        INSERT OR IGNORE INTO oauth_pending(ticket, provider, provider_sub, email_hint, verified_email, suggested_name, expires_at)
        VALUES (?, 'google', ?, ?, ?, ?, ?)
      `).bind(ticket, pending.provider_sub, pending.email_hint, pending.verified_email || '', nickname, now + OAUTH_PENDING_TTL_MS).run();
      return reply({ error: 'That nickname is taken.' }, 409);
    }

    if (check.inviteId && !await consumeInviteUse(db, check.inviteId, now)) {
      await db.prepare('DELETE FROM profiles WHERE id = ?').bind(id).run();
      return reply({ error: 'That invite code is no longer available.' }, 403);
    }

    const linked = await db.prepare(`
      INSERT OR IGNORE INTO oauth_links(provider, provider_sub, profile_id, email_hint, created_at)
      VALUES ('google', ?, ?, ?, ?)
    `).bind(pending.provider_sub, id, pending.email_hint, now).run();
    if (!linked.meta.changes) {
      await db.prepare('DELETE FROM profiles WHERE id = ?').bind(id).run();
      return reply({ error: 'This Google account is already linked to another profile.' }, 409);
    }

    const sessionToken = await createDeviceSession(
      db,
      id,
      cleanLabel(data.label, 'Google sign-in'),
      now,
      digest,
      hex
    );
    return reply({ token: sessionToken, profileId: id, nickname }, 201);
  }

  if (path === '/auth/passkey/login/options') {
    await db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').bind(now).run();
    const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    await db.prepare(
      'INSERT INTO auth_challenges(challenge, profile_id, kind, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(challenge, '', 'login', now + CHALLENGE_TTL_MS).run();
    return reply({
      challenge,
      rpId,
      timeout: 60000,
      userVerification: 'preferred',
    });
  }

  if (path === '/auth/passkey/login/verify') {
    const credId = typeof data.credentialId === 'string' ? data.credentialId.trim() : '';
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(credId)) {
      return reply({ error: 'Invalid passkey credential.' }, 400);
    }
    const clientData = parseClientData(data.clientDataJSON);
    const authData = fromBase64Url(data.authenticatorData);
    const sigBytes = fromBase64Url(data.signature);
    if (!clientData || !authData || authData.length < 37 || !sigBytes) {
      return reply({ error: 'Invalid passkey assertion.' }, 400);
    }
    const { type, origin, challenge } = clientData.json || {};
    if (type !== 'webauthn.get' || origin !== webOrigin || typeof challenge !== 'string') {
      return reply({ error: 'Passkey origin or type mismatch.' }, 400);
    }

    // Consume single-use login challenge atomically
    const chDel = await db.prepare(
      "DELETE FROM auth_challenges WHERE challenge = ? AND kind = 'login' AND expires_at >= ?"
    ).bind(challenge, now).run();
    if (!chDel.meta.changes) {
      return reply({ error: 'Sign-in request expired. Try again.' }, 401);
    }

    // Verify RP ID hash & User Present bit
    const expectedRpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(rpId)));
    if (!bytesEqual(authData.subarray(0, 32), expectedRpHash)) {
      return reply({ error: 'Passkey domain mismatch.' }, 401);
    }
    if ((authData[32] & 0x01) === 0) {
      return reply({ error: 'User presence check failed.' }, 401);
    }

    const row = await db.prepare(`
      SELECT k.credential_id, k.profile_id, k.public_key_spki, k.algorithm, k.sign_count, p.nickname
      FROM passkeys k JOIN profiles p ON p.id = k.profile_id
      WHERE k.credential_id = ?
    `).bind(credId).first();
    if (!row) {
      return reply({ error: 'No Study-OS profile found for this passkey.' }, 401);
    }

    const spki = fromBase64Url(row.public_key_spki);
    if (!spki) return reply({ error: 'Stored passkey is corrupt.' }, 500);

    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData.raw));
    const signedPayload = new Uint8Array(authData.length + clientDataHash.length);
    signedPayload.set(authData, 0);
    signedPayload.set(clientDataHash, authData.length);

    let verified = false;
    try {
      const cryptoKey = await importPasskeySpki(spki, Number(row.algorithm));
      if (Number(row.algorithm) === -7) {
        const rawSig = derToP1363(sigBytes);
        if (rawSig) {
          verified = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            cryptoKey,
            rawSig,
            signedPayload
          );
        }
      } else if (Number(row.algorithm) === -257) {
        verified = await crypto.subtle.verify(
          { name: 'RSASSA-PKCS1-v1_5' },
          cryptoKey,
          sigBytes,
          signedPayload
        );
      }
    } catch {
      verified = false;
    }

    if (!verified) {
      return reply({ error: 'Passkey verification failed.' }, 401);
    }

    const view = new DataView(authData.buffer, authData.byteOffset + 33, 4);
    const incomingCount = view.getUint32(0, false);
    const storedCount = Number(row.sign_count || 0);
    if (storedCount > 0 && incomingCount > 0 && incomingCount <= storedCount) {
      return reply({ error: 'Passkey counter check failed.' }, 401);
    }

    await db.prepare(
      'UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?'
    ).bind(Math.max(storedCount, incomingCount), now, credId).run();

    const token = await createDeviceSession(
      db,
      row.profile_id,
      cleanLabel(data.label, 'Passkey device'),
      now,
      digest,
      hex
    );
    return reply({ token, profileId: row.profile_id, nickname: row.nickname });
  }

  if (path === '/auth/link-redeem' || path === '/auth/extension-link') {
    const rawCode = typeof data.code === 'string' ? data.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (!/^[A-Z2-9]{6}$/.test(rawCode)) {
      return reply({ error: 'Enter a valid 6-character device code (e.g. K7M-9P2).' }, 400);
    }
    const codeHash = await digest('link:' + rawCode);
    const found = await db.prepare(`
      SELECT l.code_hash, l.profile_id, p.nickname
      FROM device_link_codes l JOIN profiles p ON p.id = l.profile_id
      WHERE l.code_hash = ? AND l.expires_at >= ?
    `).bind(codeHash, now).first();
    if (!found) {
      return reply({ error: 'That device code is invalid or expired.' }, 401);
    }
    const consumed = await db.prepare('DELETE FROM device_link_codes WHERE code_hash = ?').bind(codeHash).run();
    if (!consumed.meta.changes) {
      return reply({ error: 'That device code was already used.' }, 401);
    }
    const token = await createDeviceSession(
      db,
      found.profile_id,
      cleanLabel(data.label, 'Linked device'),
      now,
      digest,
      hex
    );
    return reply({ token, profileId: found.profile_id, nickname: found.nickname });
  }

  return reply({ error: 'Unknown auth route.' }, 404);
}

export async function handleAuthedAuth({ request, path, db, env, me, tokenHash, now, data, reply, digest }) {
  const webOrigin = request.headers.get('Origin');
  const rpId = new URL(webOrigin).hostname;

  if (path === '/auth/recovery/create' && request.method === 'POST') {
    const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => LINK_ALPHABET[byte & 31]).join('');
    await db.prepare(`
      INSERT INTO recovery_keys(profile_id, key_hash, created_at) VALUES (?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at
    `).bind(me.id, await digest('recovery:' + raw), now).run();
    return reply({ key: raw.match(/.{4}/g).join('-') }, 201);
  }

  if (path === '/auth/devices' && request.method === 'GET') {
    const [keysRes, sessRes, googleRow] = await Promise.all([
      db.prepare(`
        SELECT credential_id AS id, label, algorithm, created_at AS createdAt, last_used_at AS lastUsedAt
        FROM passkeys WHERE profile_id = ? ORDER BY created_at DESC LIMIT 20
      `).bind(me.id).all(),
      db.prepare(`
        SELECT token_hash, label, created_at AS createdAt, last_used_at AS lastUsedAt
        FROM profile_sessions WHERE profile_id = ? ORDER BY last_used_at DESC LIMIT 25
      `).bind(me.id).all(),
      db.prepare(`
        SELECT email_hint AS emailHint, created_at AS createdAt
        FROM oauth_links WHERE provider = 'google' AND profile_id = ? LIMIT 1
      `).bind(me.id).first(),
    ]);
    const sessions = (sessRes.results || []).map((row) => ({
      id: row.token_hash.slice(0, 16),
      label: row.label || 'Browser session',
      createdAt: Number(row.createdAt || 0),
      lastUsedAt: Number(row.lastUsedAt || 0),
      current: row.token_hash === tokenHash,
    }));
    const googleClientId = typeof env.GOOGLE_CLIENT_ID === 'string' ? env.GOOGLE_CLIENT_ID.trim() : '';
    return reply({
      passkeys: keysRes.results || [],
      sessions,
      googleEnabled: Boolean(googleClientId),
      google: googleRow ? { linked: true, emailHint: googleRow.emailHint || '', createdAt: Number(googleRow.createdAt || 0) } : { linked: false },
    });
  }

  if (path === '/auth/google/link' && request.method === 'POST') {
    const clientId = typeof env.GOOGLE_CLIENT_ID === 'string' ? env.GOOGLE_CLIENT_ID.trim() : '';
    let verified;
    try {
      verified = await verifyGoogleIdToken(data.idToken, clientId, now);
    } catch (err) {
      return reply({ error: err.message || 'Could not verify Google account.' }, 401);
    }
    const existing = await db.prepare(
      "SELECT profile_id FROM oauth_links WHERE provider = 'google' AND provider_sub = ?"
    ).bind(verified.sub).first();
    if (existing && existing.profile_id !== me.id) {
      return reply({ error: 'This Google account is already linked to another Study-OS profile.' }, 409);
    }
    await db.prepare("DELETE FROM oauth_links WHERE provider = 'google' AND profile_id = ?").bind(me.id).run();
    await db.prepare(`
      INSERT INTO oauth_links(provider, provider_sub, profile_id, email_hint, created_at)
      VALUES ('google', ?, ?, ?, ?)
    `).bind(verified.sub, me.id, verified.emailHint, now).run();
    return reply({ ok: true, emailHint: verified.emailHint });
  }

  if (path === '/auth/google/unlink' && request.method === 'POST') {
    await db.prepare("DELETE FROM oauth_links WHERE provider = 'google' AND profile_id = ?").bind(me.id).run();
    return reply({ ok: true });
  }

  if (path === '/auth/passkey/register/options' && request.method === 'POST') {
    await db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').bind(now).run();
    const existing = await db.prepare('SELECT credential_id FROM passkeys WHERE profile_id = ?')
      .bind(me.id).all();
    if ((existing.results || []).length >= MAX_PASSKEYS_PER_PROFILE) {
      return reply({ error: 'Remove an existing passkey before adding another.' }, 409);
    }
    const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    await db.prepare(
      'INSERT INTO auth_challenges(challenge, profile_id, kind, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(challenge, me.id, 'register', now + CHALLENGE_TTL_MS).run();

    return reply({
      challenge,
      rp: { name: 'Study-OS', id: rpId },
      user: {
        id: toBase64Url(encoder.encode(me.id)),
        name: me.nickname,
        displayName: me.nickname,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      excludeCredentials: (existing.results || []).map((r) => ({ id: r.credential_id, type: 'public-key' })),
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'preferred',
      },
      attestation: 'none',
      timeout: 60000,
    });
  }

  if (path === '/auth/passkey/register/verify' && request.method === 'POST') {
    const credId = typeof data.credentialId === 'string' ? data.credentialId.trim() : '';
    const alg = Number(data.algorithm);
    const spkiB64 = typeof data.publicKeySpki === 'string' ? data.publicKeySpki.trim() : '';
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(credId) || (alg !== -7 && alg !== -257)) {
      return reply({ error: 'Unsupported passkey format.' }, 400);
    }
    const clientData = parseClientData(data.clientDataJSON);
    const authData = fromBase64Url(data.authenticatorData);
    const spkiBytes = fromBase64Url(spkiB64);
    if (!clientData || !authData || authData.length < 37 || !spkiBytes) {
      return reply({ error: 'Incomplete passkey registration data.' }, 400);
    }
    const { type, origin, challenge } = clientData.json || {};
    if (type !== 'webauthn.create' || origin !== webOrigin || typeof challenge !== 'string') {
      return reply({ error: 'Passkey origin or type mismatch.' }, 400);
    }

    const chDel = await db.prepare(
      "DELETE FROM auth_challenges WHERE challenge = ? AND profile_id = ? AND kind = 'register' AND expires_at >= ?"
    ).bind(challenge, me.id, now).run();
    if (!chDel.meta.changes) {
      return reply({ error: 'Passkey setup expired. Try again.' }, 401);
    }

    const expectedRpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(rpId)));
    if (!bytesEqual(authData.subarray(0, 32), expectedRpHash) || (authData[32] & 0x01) === 0) {
      return reply({ error: 'Passkey domain or presence check failed.' }, 400);
    }

    try {
      await importPasskeySpki(spkiBytes, alg);
    } catch {
      return reply({ error: 'Invalid passkey public key.' }, 400);
    }

    const view = new DataView(authData.buffer, authData.byteOffset + 33, 4);
    const signCount = view.getUint32(0, false);
    const label = cleanLabel(data.label, 'Passkey');
    const inserted = await db.prepare(`
      INSERT OR IGNORE INTO passkeys(credential_id, profile_id, public_key_spki, algorithm, sign_count, label, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(credId, me.id, spkiB64, alg, signCount, label, now, now).run();
    if (!inserted.meta.changes) {
      return reply({ error: 'This passkey is already registered.' }, 409);
    }
    return reply({ ok: true, id: credId, label }, 201);
  }

  if (path === '/auth/passkey/delete' && request.method === 'POST') {
    const credId = typeof data.id === 'string' ? data.id.trim() : '';
    if (!credId) return reply({ error: 'Choose a passkey.' }, 400);
    await db.prepare('DELETE FROM passkeys WHERE credential_id = ? AND profile_id = ?')
      .bind(credId, me.id).run();
    return reply({ ok: true });
  }

  if (path === '/auth/link-code' && request.method === 'POST') {
    await db.prepare('DELETE FROM device_link_codes WHERE expires_at < ?').bind(now).run();
    const recent = await db.prepare(
      'SELECT COUNT(*) AS n FROM device_link_codes WHERE profile_id = ? AND created_at >= ?'
    ).bind(me.id, now - 3_600_000).first();
    if (Number(recent?.n || 0) >= 8) {
      return reply({ error: 'Too many device codes created recently. Wait a few minutes.' }, 429);
    }
    const rand = crypto.getRandomValues(new Uint8Array(6));
    let raw = '';
    for (let i = 0; i < 6; i++) raw += LINK_ALPHABET[rand[i] % LINK_ALPHABET.length];
    const codeHash = await digest('link:' + raw);
    const expiresAt = now + LINK_CODE_TTL_MS;
    await db.prepare(
      'INSERT INTO device_link_codes(code_hash, profile_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).bind(codeHash, me.id, expiresAt, now).run();
    return reply({ code: `${raw.slice(0, 3)}-${raw.slice(3)}`, expiresAt }, 201);
  }

  if (path === '/auth/session/revoke' && request.method === 'POST') {
    const idPrefix = typeof data.id === 'string' ? data.id.trim() : '';
    if (!/^[0-9a-f]{16}$/.test(idPrefix)) return reply({ error: 'Invalid session.' }, 400);
    await db.prepare(
      'DELETE FROM profile_sessions WHERE profile_id = ? AND substr(token_hash, 1, 16) = ?'
    ).bind(me.id, idPrefix).run();
    return reply({ ok: true });
  }

  if (path === '/auth/logout' && request.method === 'POST') {
    await db.prepare('DELETE FROM profile_sessions WHERE token_hash = ? AND profile_id = ?')
      .bind(tokenHash, me.id).run();
    return reply({ ok: true });
  }

  return reply({ error: 'Unknown auth route.' }, 404);
}
