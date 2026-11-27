/**
 * Server-enforced Community Admin controls for Study-OS.
 *
 * Manages:
 * - Signups open/paused kill switch (`community_settings.signups_open`)
 * - Legacy Wrangler `JOIN_PROOF` fallback toggle (`community_settings.env_join_enabled`)
 * - Dynamic hashed invite codes / join strings (`invite_codes` with max uses, expiry, revoke/delete)
 * - Member management (list, rename, reset 30-day nickname cooldown, remove)
 */

import { turnstileSiteKey } from './human.mjs';
import { getAdminTelemetrySummary } from './telemetry.mjs';

const idPattern = /^[0-9a-f-]{36}$/;
const proofPattern = /^[0-9a-f]{64}$/;
const memberKeyPattern = /^sos1_[A-Za-z0-9_-]{43}$/;

export async function getAdminMemberKey(db, env) {
  const fromEnv = typeof env?.MEMBER_LIBRARY_KEY === 'string' ? env.MEMBER_LIBRARY_KEY.trim() : '';
  if (memberKeyPattern.test(fromEnv)) return fromEnv;
  const row = await db.prepare("SELECT value FROM community_settings WHERE key = 'admin_member_key'").first();
  const val = typeof row?.value === 'string' ? row.value.trim() : '';
  return memberKeyPattern.test(val) ? val : '';
}

function base64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function maskHint(code) {
  const s = String(code || '');
  if (s.length <= 10) return s.slice(0, 2) + '…' + s.slice(-2);
  return s.slice(0, 8) + '…' + s.slice(-3);
}

export async function getJoinSettings(db, env) {
  const { results } = await db.prepare(
    "SELECT key, value FROM community_settings WHERE key IN ('signups_open', 'env_join_enabled', 'admin_member_key', 'archive_pass_enabled', 'require_invite_for_google')"
  ).all();
  const map = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const envKey = typeof env?.MEMBER_LIBRARY_KEY === 'string' && memberKeyPattern.test(env.MEMBER_LIBRARY_KEY.trim());
  const dbKey = typeof map.admin_member_key === 'string' && memberKeyPattern.test(map.admin_member_key.trim());
  return {
    signupsOpen: map.signups_open !== '0',
    envJoinEnabled: map.env_join_enabled !== '0',
    archivePassEnabled: map.archive_pass_enabled !== '0',
    requireInviteForGoogle: map.require_invite_for_google === '1',
    hasEnvJoinProof: proofPattern.test(env.JOIN_PROOF || ''),
    hasAdminMemberKey: envKey || dbKey,
  };
}

export async function lookupInviteRow(db, proof, proofUpper = '') {
  const hashes = [proof, proofUpper].filter((h) => proofPattern.test(h || ''));
  if (!hashes.length) return null;
  if (hashes.length === 1 || hashes[0] === hashes[1]) {
    return db.prepare(
      'SELECT id, max_uses, uses, expires_at, revoked FROM invite_codes WHERE code_hash = ?'
    ).bind(hashes[0]).first();
  }
  return db.prepare(
    'SELECT id, max_uses, uses, expires_at, revoked FROM invite_codes WHERE code_hash = ? OR code_hash = ? LIMIT 1'
  ).bind(hashes[0], hashes[1]).first();
}

export async function verifyInviteCodeOnly(db, proof, proofUpper, now) {
  const row = await lookupInviteRow(db, proof, proofUpper);
  if (!row) return { ok: false, error: 'Enter a valid access code.' };
  if (row.revoked) return { ok: false, error: 'That access code has been revoked.' };
  if (row.expires_at > 0 && row.expires_at <= now) return { ok: false, error: 'That access code has expired.' };
  if (row.max_uses > 0 && row.uses >= row.max_uses) return { ok: false, error: 'That access code has reached its usage limit.' };
  return { ok: true, inviteId: row.id };
}

export async function grantArchivePass(db, profileId, inviteId, now) {
  if (!profileId || !inviteId) return;
  await db.prepare(`
    INSERT INTO archive_passes(profile_id, invite_id, granted_at)
    VALUES (?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET invite_id = excluded.invite_id, granted_at = excluded.granted_at
  `).bind(profileId, inviteId, now).run().catch(() => {});
}

export async function getActiveArchiveMemberKey(db, env, profileId, isAdmin, now) {
  const mk = await getAdminMemberKey(db, env);
  if (!mk) return '';
  if (isAdmin) return mk;
  const settings = await getJoinSettings(db, env);
  if (!settings.archivePassEnabled) return '';
  const row = await db.prepare(`
    SELECT i.id FROM archive_passes ap
    JOIN invite_codes i ON i.id = ap.invite_id
    WHERE ap.profile_id = ? AND i.revoked = 0 AND (i.expires_at = 0 OR i.expires_at > ?)
    LIMIT 1
  `).bind(profileId, now).first().catch(() => null);
  return row ? mk : '';
}

export async function verifyJoinProof(db, env, proof, now, equalProof, verifiedGoogle = false, proofUpper = '') {
  const settings = await getJoinSettings(db, env);
  if (!settings.signupsOpen) {
    return { ok: false, error: 'Community signups are currently paused by the admin.' };
  }
  const hasSuppliedProof = proofPattern.test(proof || '') || proofPattern.test(proofUpper || '');
  const googleFree = verifiedGoogle && !settings.requireInviteForGoogle;
  // If an optional code was supplied alongside open Google/Turnstile signup, attach its inviteId if valid.
  if (googleFree || turnstileSiteKey(env)) {
    if (hasSuppliedProof) {
      const checked = await verifyInviteCodeOnly(db, proof, proofUpper, now);
      if (checked.ok) return checked;
    }
    return { ok: true, inviteId: null };
  }
  if (!hasSuppliedProof) {
    return { ok: false, error: 'Enter a valid access code.' };
  }
  const row = await lookupInviteRow(db, proof, proofUpper);
  if (row) {
    if (row.revoked) return { ok: false, error: 'That access code has been revoked.' };
    if (row.expires_at > 0 && row.expires_at <= now) return { ok: false, error: 'That access code has expired.' };
    if (row.max_uses > 0 && row.uses >= row.max_uses) return { ok: false, error: 'That access code has reached its usage limit.' };
    return { ok: true, inviteId: row.id };
  }
  if (settings.envJoinEnabled && (equalProof(env.JOIN_PROOF, proof) || (proofUpper && equalProof(env.JOIN_PROOF, proofUpper)))) {
    return { ok: true, inviteId: null };
  }
  return { ok: false, error: 'Enter a valid access code.' };
}

export async function consumeInviteUse(db, inviteId, now) {
  if (!inviteId) return true;
  const res = await db.prepare(`
    UPDATE invite_codes
    SET uses = uses + 1
    WHERE id = ? AND revoked = 0
      AND (max_uses = 0 OR uses < max_uses)
      AND (expires_at = 0 OR expires_at > ?)
  `).bind(inviteId, now).run();
  return Boolean(res.meta.changes);
}

export async function handleAdmin({ request, url, db, env, me, isAdmin, now, data, reply, digest, nicknamePattern }) {
  if (!isAdmin) return reply({ error: 'Admin access required.' }, 403);
  const path = url.pathname;

  if (path === '/admin/overview' && request.method === 'GET') {
    const settings = await getJoinSettings(db, env);
    const { results: invites } = await db.prepare(`
      SELECT id, label, hint, max_uses AS maxUses, uses, expires_at AS expiresAt,
        revoked, created_at AS createdAt
      FROM invite_codes
      ORDER BY created_at DESC LIMIT 100
    `).all();
    const { results: members } = await db.prepare(`
      SELECT p.id, p.nickname, p.avatar, p.bio, p.nickname_changed_at AS nicknameChangedAt,
        p.secondary_language AS secondaryLanguage, p.newsletter_opt_in AS newsletterOptIn,
        p.study_minutes AS studyMinutes, p.break_minutes AS breakMinutes,
        p.break_count AS breakCount, p.completed, p.attempts, p.accuracy,
        pr.mode AS liveMode, pr.elapsed_seconds AS liveElapsedSec, pr.updated_at AS presenceUpdatedAt,
        sb.updated_at AS backupUpdatedAt, sb.record_count AS backupRecords,
        sb.session_count AS backupSessions, LENGTH(sb.payload) AS backupBytes,
        COALESCE(au.aiPrompts, 0) AS aiPrompts
      FROM profiles p
      LEFT JOIN presence pr ON pr.profile = p.id
      LEFT JOIN study_backups sb ON sb.profile_id = p.id
      LEFT JOIN (
        SELECT profile_id, SUM(used_count) AS aiPrompts FROM ai_usage GROUP BY profile_id
      ) au ON au.profile_id = p.id
      ORDER BY p.completed DESC, p.study_minutes DESC, p.nickname LIMIT 250
    `).all().catch(async () => db.prepare(`
      SELECT id, nickname, avatar, bio, nickname_changed_at AS nicknameChangedAt,
        secondary_language AS secondaryLanguage, newsletter_opt_in AS newsletterOptIn,
        study_minutes AS studyMinutes, break_minutes AS breakMinutes,
        break_count AS breakCount, completed, attempts, accuracy
      FROM profiles
      ORDER BY completed DESC, study_minutes DESC, nickname LIMIT 250
    `).all());
    const newsletterCount = (members || []).filter((m) => Number(m.newsletterOptIn) === 1).length;
    const telemetry = await getAdminTelemetrySummary(db, now);
    return reply({ settings, invites, members, newsletterCount, telemetry, now });
  }

  if (path === '/admin/settings' && request.method === 'POST') {
    if (typeof data.signupsOpen === 'boolean') {
      await db.prepare(
        "INSERT INTO community_settings(key, value) VALUES ('signups_open', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(data.signupsOpen ? '1' : '0').run();
    }
    if (typeof data.envJoinEnabled === 'boolean') {
      await db.prepare(
        "INSERT INTO community_settings(key, value) VALUES ('env_join_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(data.envJoinEnabled ? '1' : '0').run();
    }
    if (typeof data.archivePassEnabled === 'boolean') {
      await db.prepare(
        "INSERT INTO community_settings(key, value) VALUES ('archive_pass_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(data.archivePassEnabled ? '1' : '0').run();
    }
    if (typeof data.requireInviteForGoogle === 'boolean') {
      await db.prepare(
        "INSERT INTO community_settings(key, value) VALUES ('require_invite_for_google', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(data.requireInviteForGoogle ? '1' : '0').run();
    }
    if (typeof data.memberKey === 'string') {
      const cleaned = data.memberKey.trim();
      if (!cleaned) {
        await db.prepare("DELETE FROM community_settings WHERE key = 'admin_member_key'").run();
      } else if (!memberKeyPattern.test(cleaned)) {
        return reply({ error: 'Archive key must be a valid 48-character sos1_… string.' }, 400);
      } else {
        await db.prepare(
          "INSERT INTO community_settings(key, value) VALUES ('admin_member_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind(cleaned).run();
      }
    }
    return reply({ ok: true, settings: await getJoinSettings(db, env) });
  }

  if (path === '/admin/invites' && request.method === 'POST') {
    const action = typeof data.action === 'string' ? data.action : 'create';
    if (action === 'create') {
      const label = typeof data.label === 'string'
        ? data.label.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 60)
        : '';
      const maxUses = Number(data.maxUses || 0);
      const expiresInDays = Number(data.expiresInDays || 0);
      if (!Number.isSafeInteger(maxUses) || maxUses < 0 || maxUses > 10_000) {
        return reply({ error: 'Max uses must be between 0 (unlimited) and 10,000.' }, 400);
      }
      if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 0 || expiresInDays > 365) {
        return reply({ error: 'Expiry days must be between 0 (never) and 365.' }, 400);
      }
      let code = '';
      if (typeof data.customCode === 'string' && data.customCode.trim()) {
        code = data.customCode.trim();
        if (!/^\S{4,120}$/.test(code)) {
          return reply({ error: 'Custom access code must be 4–120 characters with no spaces.' }, 400);
        }
        // Normalize short human-typeable codes (e.g. BI2026) to uppercase so typing is case-insensitive
        if (/^[A-Za-z0-9_-]{4,24}$/.test(code) && !code.startsWith('soci1_')) {
          code = code.toUpperCase();
        }
      } else {
        code = 'soci1_' + base64Url(crypto.getRandomValues(new Uint8Array(32)));
      }
      const codeHash = await digest(code);
      const id = crypto.randomUUID();
      const expiresAt = expiresInDays > 0 ? now + expiresInDays * 86_400_000 : 0;
      const hint = maskHint(code);
      const res = await db.prepare(`
        INSERT OR IGNORE INTO invite_codes(id, code_hash, label, hint, max_uses, uses, expires_at, revoked, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?)
      `).bind(id, codeHash, label || 'Invite code', hint, maxUses, expiresAt, now).run();
      if (!res.meta.changes) {
        return reply({ error: 'That join string already exists.' }, 409);
      }
      return reply({
        ok: true,
        code,
        invite: { id, label: label || 'Invite code', hint, maxUses, uses: 0, expiresAt, revoked: 0, createdAt: now },
      }, 201);
    }

    const inviteId = typeof data.id === 'string' ? data.id : '';
    if (!idPattern.test(inviteId)) return reply({ error: 'Invalid invite ID.' }, 400);
    if (action === 'revoke' || action === 'restore') {
      await db.prepare('UPDATE invite_codes SET revoked = ? WHERE id = ?')
        .bind(action === 'revoke' ? 1 : 0, inviteId).run();
      return reply({ ok: true });
    }
    if (action === 'delete') {
      await db.prepare('DELETE FROM invite_codes WHERE id = ?').bind(inviteId).run();
      return reply({ ok: true });
    }
    return reply({ error: 'Unknown invite action.' }, 400);
  }

  if (path === '/admin/members' && request.method === 'POST') {
    const action = typeof data.action === 'string' ? data.action : '';
    const memberId = typeof data.id === 'string' ? data.id : '';
    if (!idPattern.test(memberId)) return reply({ error: 'Invalid member ID.' }, 400);

    if (action === 'reset_cooldown') {
      await db.prepare('UPDATE profiles SET nickname_changed_at = 0 WHERE id = ?').bind(memberId).run();
      return reply({ ok: true });
    }
    if (action === 'rename') {
      const nextNick = typeof data.nickname === 'string' ? data.nickname.trim().normalize('NFC') : '';
      if (!nicknamePattern.test(nextNick)) {
        return reply({ error: 'Choose a nickname of 2–24 letters, numbers or spaces.' }, 400);
      }
      const conflict = await db.prepare('SELECT 1 FROM profiles WHERE nickname = ? AND id <> ?')
        .bind(nextNick, memberId).first();
      if (conflict) return reply({ error: 'That nickname is taken.' }, 409);
      try {
        await db.prepare('UPDATE profiles SET nickname = ? WHERE id = ?').bind(nextNick, memberId).run();
      } catch {
        return reply({ error: 'That nickname is taken.' }, 409);
      }
      return reply({ ok: true });
    }
    if (action === 'remove') {
      if (memberId === me.id) return reply({ error: 'You cannot remove your own admin profile here.' }, 400);
      await db.prepare('DELETE FROM profiles WHERE id = ?').bind(memberId).run();
      return reply({ ok: true });
    }
    return reply({ error: 'Unknown member action.' }, 400);
  }

  return reply({ error: 'Unknown admin action.' }, 404);
}
