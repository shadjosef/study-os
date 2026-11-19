import { handleRooms, runningStudyRoom } from './rooms.mjs';
import { verifyJoinProof, consumeInviteUse, handleAdmin } from './admin.mjs';
import { handlePublicAuth, handleAuthedAuth } from './auth.mjs';
import { handleSync } from './sync.mjs';

const encoder = new TextEncoder();
const hex = (bytes) => [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
const digest = async (value) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
const tokenPattern = /^soc1_[0-9a-f]{64}$/;
const proofPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[0-9a-f-]{36}$/;
const nicknamePattern = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,23}$/u;
const avatarDataPattern = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]{16,28000}$/;
const avatarPresets = new Set(['owl', 'fox', 'cat', 'penguin', 'rocket', 'book', 'coffee', 'spark', 'mountain', 'cactus']);
const nicknameCooldownMs = 30 * 86_400_000;
const maxInputBytes = 65_536;
const maxSyncBytes = 524_288;
const publicAuthPaths = new Set(['/auth/passkey/login/options', '/auth/passkey/login/verify', '/auth/link-redeem']);
const breakRequired = new Set(['/dashboard', '/message', '/chat', '/block', '/sets']);
const osloHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Oslo', hour: 'numeric', hourCycle: 'h23',
});

function isAdminMember(env, me, tokenHash) {
  const adminHash = typeof env.ADMIN_TOKEN_HASH === 'string' ? env.ADMIN_TOKEN_HASH.trim().toLowerCase() : '';
  if (adminHash && equalProof(adminHash, tokenHash)) return true;
  const adminIds = typeof env.ADMIN_PROFILE_IDS === 'string'
    ? env.ADMIN_PROFILE_IDS.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  return adminIds.includes(me.id);
}

function validateAvatar(value) {
  if (value === '') return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('preset:')) {
    const key = trimmed.slice(7);
    return avatarPresets.has(key) ? `preset:${key}` : null;
  }
  return avatarDataPattern.test(trimmed) ? trimmed : null;
}

function profileSummary(me, isAdmin, now) {
  const changedAt = Number(me.nickname_changed_at || 0);
  const nextAt = !isAdmin && changedAt > 0 && changedAt + nicknameCooldownMs > now
    ? changedAt + nicknameCooldownMs
    : 0;
  return {
    id: me.id,
    nickname: me.nickname,
    avatar: me.avatar || '',
    bio: me.bio || '',
    study_minutes: Number(me.study_minutes || 0),
    break_minutes: Number(me.break_minutes || 0),
    break_count: Number(me.break_count || 0),
    last_break_at: Number(me.last_break_at || 0),
    nicknameChangedAt: changedAt,
    nextNicknameChangeAt: nextAt,
    isAdmin,
  };
}

function equalProof(expected, supplied) {
  if (!proofPattern.test(expected || '') || !proofPattern.test(supplied || '')) return false;
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return different === 0;
}

async function readJson(request, limitBytes = maxInputBytes) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limitBytes) {
      await reader.cancel();
      throw new Error('Request too large');
    }
    chunks.push(value);
  }
  const input = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
  const data = JSON.parse(input);
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Invalid request');
  return data;
}

function boundedInt(value, max) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export default {
  async fetch(request, env) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Origin',
    };
    if (request.headers.get('Origin') === env.WEB_ORIGIN) {
      headers['Access-Control-Allow-Origin'] = env.WEB_ORIGIN;
    }
    const reply = (data, status = 200) => Response.json(data, { status, headers });
    if (!headers['Access-Control-Allow-Origin']) return reply({ error: 'Origin not allowed.' }, 403);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        ...headers,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '3600',
      } });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;
    let data = {};
    if (request.method === 'POST') {
      try { data = await readJson(request, path === '/sync' ? maxSyncBytes : maxInputBytes); }
      catch { return reply({ error: 'Invalid request.' }, 400); }
    }

    if (publicAuthPaths.has(path)) {
      return handlePublicAuth({ request, path, db, env, now: Date.now(), data, reply, digest, hex });
    }

    if (path === '/join' && request.method === 'POST') {
      const nowJoin = Date.now();
      const check = await verifyJoinProof(db, env, data.proof, nowJoin, equalProof);
      if (!check.ok) return reply({ error: check.error }, 403);
      const nickname = typeof data.nickname === 'string' ? data.nickname.trim().normalize('NFC') : '';
      if (!nicknamePattern.test(nickname)) {
        return reply({ error: 'Choose a nickname of 2–24 letters, numbers or spaces.' }, 400);
      }
      const id = crypto.randomUUID();
      const token = 'soc1_' + hex(crypto.getRandomValues(new Uint8Array(32)));
      const result = await db.prepare('INSERT OR IGNORE INTO profiles(id, token_hash, nickname) VALUES (?, ?, ?)')
        .bind(id, await digest(token), nickname).run();
      if (!result.meta.changes) return reply({ error: 'That nickname is taken.' }, 409);
      if (check.inviteId && !await consumeInviteUse(db, check.inviteId, nowJoin)) {
        await db.prepare('DELETE FROM profiles WHERE id = ?').bind(id).run();
        return reply({ error: 'That invite code is no longer available.' }, 403);
      }
      return reply({ token }, 201);
    }

    const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (!tokenPattern.test(token)) return reply({ error: 'Enter your profile key.' }, 401);
    const tokenHash = await digest(token);
    const now = Date.now();
    let me = await db.prepare(`
      SELECT profiles.id, nickname, avatar, bio, nickname_changed_at,
        study_minutes, break_minutes, break_count, last_break_at,
        completed, attempts, accuracy, break_ends_at, expires_at
      FROM profiles LEFT JOIN presence ON presence.profile = profiles.id WHERE token_hash = ?
    `).bind(tokenHash).first();
    if (!me) {
      me = await db.prepare(`
        SELECT profiles.id, nickname, avatar, bio, nickname_changed_at,
          study_minutes, break_minutes, break_count, last_break_at,
          completed, attempts, accuracy, break_ends_at, expires_at,
          profile_sessions.last_used_at AS session_last_used_at
        FROM profile_sessions
        JOIN profiles ON profiles.id = profile_sessions.profile_id
        LEFT JOIN presence ON presence.profile = profiles.id
        WHERE profile_sessions.token_hash = ?
      `).bind(tokenHash).first();
      if (me && now - Number(me.session_last_used_at || 0) > 300_000) {
        await db.prepare('UPDATE profile_sessions SET last_used_at = ? WHERE token_hash = ?')
          .bind(now, tokenHash).run();
      }
    }
    if (!me) return reply({ error: 'That profile key is invalid.' }, 401);
    const isAdmin = isAdminMember(env, me, tokenHash);
    if (path.startsWith('/auth/')) {
      return handleAuthedAuth({ request, path, db, env, me, tokenHash, now, data, reply, digest });
    }
    if (path === '/sync') {
      return handleSync({ request, db, me, now, data, reply });
    }
    if (path.startsWith('/admin/')) {
      return handleAdmin({ request, url, db, env, me, isAdmin, now, data, reply, digest, nicknamePattern });
    }
    if (breakRequired.has(path) || path === '/rooms' || path.startsWith('/rooms/')) {
      const breakAccess = Number(osloHour.format(now)) >= 20 || (me.break_ends_at > now && me.expires_at > now);
      const canUseCommunity = breakAccess && !await runningStudyRoom(db, me.id, now);
      if (path === '/rooms' || path.startsWith('/rooms/')) {
        return handleRooms({ request, url, db, me, now, data, canUseCommunity, reply });
      }
      if (!canUseCommunity) {
        return reply({ error: 'Community opens on breaks or after 20:00 Oslo time, outside active study rooms.' }, 423);
      }
    }

    if (path === '/profile') {
      if (request.method === 'GET') {
        return reply(profileSummary(me, isAdmin, now));
      }
      if (request.method === 'POST') {
        let nextNickname = me.nickname;
        let nextChangedAt = Number(me.nickname_changed_at || 0);
        let nextAvatar = me.avatar || '';
        let nextBio = me.bio || '';

        if (Object.prototype.hasOwnProperty.call(data, 'nickname')) {
          const candidate = typeof data.nickname === 'string' ? data.nickname.trim().normalize('NFC') : '';
          if (!nicknamePattern.test(candidate)) {
            return reply({ error: 'Choose a nickname of 2–24 letters, numbers or spaces.' }, 400);
          }
          const changedWord = candidate.toLowerCase() !== String(me.nickname).toLowerCase();
          if (changedWord && !isAdmin && nextChangedAt > 0 && now - nextChangedAt < nicknameCooldownMs) {
            const unlockDate = new Date(nextChangedAt + nicknameCooldownMs).toLocaleDateString('en-GB', {
              day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Oslo',
            });
            return reply({ error: `You can change your nickname once every 30 days. Next change available on ${unlockDate}.` }, 429);
          }
          if (changedWord) {
            const conflict = await db.prepare('SELECT 1 FROM profiles WHERE nickname = ? AND id <> ?')
              .bind(candidate, me.id).first();
            if (conflict) return reply({ error: 'That nickname is taken.' }, 409);
            nextChangedAt = now;
          }
          nextNickname = candidate;
        }

        if (Object.prototype.hasOwnProperty.call(data, 'avatar')) {
          const checked = validateAvatar(data.avatar);
          if (checked === null) {
            return reply({ error: 'Choose a preset avatar or upload a small PNG, JPEG, or WebP image.' }, 400);
          }
          nextAvatar = checked;
        }

        if (Object.prototype.hasOwnProperty.call(data, 'bio')) {
          if (typeof data.bio !== 'string') return reply({ error: 'Invalid bio.' }, 400);
          const cleaned = data.bio.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
          if (cleaned.length > 140) return reply({ error: 'Keep your bio to 140 characters or fewer.' }, 400);
          nextBio = cleaned;
        }

        try {
          await db.prepare(
            'UPDATE profiles SET nickname = ?, avatar = ?, bio = ?, nickname_changed_at = ? WHERE id = ?'
          ).bind(nextNickname, nextAvatar, nextBio, nextChangedAt, me.id).run();
        } catch {
          return reply({ error: 'That nickname is taken.' }, 409);
        }

        const updated = { ...me, nickname: nextNickname, avatar: nextAvatar, bio: nextBio, nickname_changed_at: nextChangedAt };
        return reply({ ok: true, profile: profileSummary(updated, isAdmin, now) });
      }
    }

    if (path === '/presence' && request.method === 'POST') {
      if (!['working', 'paused', 'break', 'idle'].includes(data.mode) || !boundedInt(data.elapsed, 4500)
        || !boundedInt(data.remaining, 1800) || (data.mode === 'break' && !data.remaining)) {
        return reply({ error: 'Invalid timer state.' }, 400);
      }
      await db.prepare(`
        INSERT INTO presence(profile, mode, elapsed_seconds, updated_at, expires_at, break_ends_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile) DO UPDATE SET mode = excluded.mode, elapsed_seconds = excluded.elapsed_seconds,
          updated_at = excluded.updated_at, expires_at = excluded.expires_at, break_ends_at = excluded.break_ends_at
      `).bind(me.id, data.mode, data.elapsed, now, data.mode === 'idle' ? now : now + 115_000,
        data.mode === 'break' ? now + data.remaining * 1000 : 0).run();
      return reply({ ok: true });
    }

    if (path === '/dashboard' && request.method === 'GET') {
      const offset = Number(url.searchParams.get('offset') || 0);
      if (!boundedInt(offset, 1_000_000)) return reply({ error: 'Invalid leaderboard page.' }, 400);
      const ranks = await db.prepare(`
        SELECT profiles.id, nickname, avatar, bio, study_minutes, break_minutes, break_count, last_break_at,
          completed, attempts, accuracy, presence.mode,
          presence.elapsed_seconds, presence.updated_at, presence.break_ends_at
        FROM profiles LEFT JOIN presence ON presence.profile = profiles.id AND presence.expires_at > ?
          AND (presence.mode <> 'break' OR presence.break_ends_at > ?)
        ORDER BY completed DESC, study_minutes DESC, nickname LIMIT 51 OFFSET ?
      `).bind(now, now, offset).all();
      const contacts = await db.prepare(`
        SELECT id, nickname, avatar FROM profiles WHERE id <> ?
        AND NOT EXISTS (SELECT 1 FROM blocks WHERE (owner = ? AND blocked = profiles.id)
          OR (blocked = ? AND owner = profiles.id)) ORDER BY nickname LIMIT 200
      `).bind(me.id, me.id, me.id).all();
      const messages = await db.prepare(`
        SELECT m.id, m.sender, m.recipient, a.nickname AS senderName, a.avatar AS senderAvatar,
          b.nickname AS recipientName, b.avatar AS recipientAvatar,
          m.message, m.created_at AS createdAt
        FROM messages m JOIN profiles a ON a.id = m.sender JOIN profiles b ON b.id = m.recipient
        WHERE (m.sender = ? OR m.recipient = ?)
          AND NOT EXISTS (SELECT 1 FROM blocks WHERE owner = ? AND blocked IN (m.sender, m.recipient))
        ORDER BY m.created_at DESC LIMIT 100
      `).bind(me.id, me.id, me.id).all();
      const blocked = await db.prepare(`
        SELECT p.id, p.nickname FROM blocks b JOIN profiles p ON p.id = b.blocked WHERE b.owner = ?
      `).bind(me.id).all();
      const mePayload = { ...me, ...profileSummary(me, isAdmin, now) };
      return reply({ me: mePayload, ranks: ranks.results.slice(0, 50), hasMoreRanks: ranks.results.length > 50,
        contacts: contacts.results, messages: messages.results, blocked: blocked.results, now });
    }

    if (path === '/chat') {
      if (request.method === 'GET') {
        const { results } = await db.prepare(`
          SELECT p.nickname, p.avatar, c.message, c.created_at AS createdAt
          FROM chat_messages c JOIN profiles p ON p.id = c.sender
          WHERE c.created_at >= ? AND NOT EXISTS (
            SELECT 1 FROM blocks WHERE (owner = ? AND blocked = c.sender) OR (blocked = ? AND owner = c.sender)
          ) ORDER BY c.created_at DESC LIMIT 40
        `).bind(now - 7 * 86_400_000, me.id, me.id).all();
        return reply({ messages: results });
      }
      if (request.method === 'POST') {
        const message = typeof data.message === 'string' ? data.message.trim() : '';
        if (!message || message.length > 1500) return reply({ error: 'Write a message of up to 1,500 characters.' }, 400);
        const result = await db.prepare(`
          INSERT INTO chat_messages(id, sender, message, created_at)
          SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM chat_messages WHERE sender = ? AND created_at >= ?) < 5
        `).bind(crypto.randomUUID(), me.id, message, now, me.id, now - 60_000).run();
        if (!result.meta.changes) return reply({ error: 'Could not send right now.' }, 409);
        await db.prepare('DELETE FROM chat_messages WHERE created_at < ?').bind(now - 7 * 86_400_000).run();
        return reply({ ok: true }, 201);
      }
    }

    if (path === '/sets') {
      const id = url.searchParams.get('id');
      if (request.method === 'GET') {
        if (id) {
          if (!idPattern.test(id)) return reply({ error: 'Invalid set.' }, 400);
          const set = await db.prepare(`
            SELECT id, title, cards FROM study_sets WHERE id = ? AND NOT EXISTS (
              SELECT 1 FROM blocks WHERE (owner = ? AND blocked = study_sets.owner)
                OR (blocked = ? AND owner = study_sets.owner)
            )
          `).bind(id, me.id, me.id).first();
          return set ? reply({ ...set, cards: JSON.parse(set.cards) }) : reply({ error: 'That set is unavailable.' }, 404);
        }
        const { results } = await db.prepare(`
          SELECT s.id, s.title, s.card_count, s.owner, p.nickname, p.avatar FROM study_sets s JOIN profiles p ON p.id = s.owner
          WHERE NOT EXISTS (
            SELECT 1 FROM blocks WHERE (owner = ? AND blocked = s.owner) OR (blocked = ? AND owner = s.owner)
          )
          ORDER BY (s.owner = ?) DESC, s.created_at DESC LIMIT 50
        `).bind(me.id, me.id, me.id).all();
        return reply({ sets: results });
      }
      if (request.method === 'POST') {
        if (data.action === 'remove') {
          if (!idPattern.test(data.id || '')) return reply({ error: 'Invalid set.' }, 400);
          await db.prepare('DELETE FROM study_sets WHERE id = ? AND owner = ?').bind(data.id, me.id).run();
          return reply({ ok: true });
        }
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        const cards = Array.isArray(data.cards) ? data.cards : [];
        if (!title || title.length > 80 || cards.length < 1 || cards.length > 30 || cards.some((card) =>
          !Array.isArray(card) || card.length !== 2 || card.some((cell) => typeof cell !== 'string' || !cell.trim() || cell.length > 250))) {
          return reply({ error: 'Use a title and 1–30 question-and-answer pairs, with up to 250 characters per field.' }, 400);
        }
        const result = await db.prepare(`
          INSERT INTO study_sets(id, owner, title, cards, card_count, created_at)
          SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM study_sets WHERE owner = ?) < 10
        `).bind(crypto.randomUUID(), me.id, title, JSON.stringify(cards), cards.length, now, me.id).run();
        return result.meta.changes ? reply({ ok: true }, 201) : reply({ error: 'Remove an existing set before sharing another.' }, 409);
      }
    }

    if (path === '/stats' && request.method === 'POST') {
      const breakMinutes = data.breakMinutes === undefined ? 0 : data.breakMinutes;
      const breakCount = data.breakCount === undefined ? 0 : data.breakCount;
      const lastBreakAt = data.lastBreakAt === undefined ? 0 : data.lastBreakAt;
      if (!boundedInt(data.minutes, 600_000) || !boundedInt(data.completed, 100_000)
        || !boundedInt(data.attempts, 1_000_000) || !boundedInt(data.accuracy, 100)
        || !boundedInt(breakMinutes, 600_000) || !boundedInt(breakCount, 100_000)
        || !boundedInt(lastBreakAt, now + 300_000)) {
        return reply({ error: 'Invalid study totals.' }, 400);
      }
      await db.prepare(`
        UPDATE profiles SET study_minutes = ?, completed = ?, attempts = ?, accuracy = ? WHERE id = ? AND attempts <= ?
      `).bind(data.minutes, data.completed, data.attempts, data.accuracy, me.id, data.attempts).run();
      await db.prepare(`
        UPDATE profiles
        SET break_minutes = MAX(break_minutes, ?),
            break_count = MAX(break_count, ?),
            last_break_at = MAX(last_break_at, ?)
        WHERE id = ?
      `).bind(breakMinutes, breakCount, lastBreakAt, me.id).run();
      return reply({ ok: true });
    }

    if (path === '/message' && request.method === 'POST') {
      const message = typeof data.message === 'string' ? data.message.trim() : '';
      if (!idPattern.test(data.recipient || '') || data.recipient === me.id || !message || message.length > 1500) {
        return reply({ error: 'Choose a recipient and write a message of up to 1,500 characters.' }, 400);
      }
      const result = await db.prepare(`
        INSERT INTO messages(id, sender, recipient, message, created_at)
        SELECT ?, ?, id, ?, ? FROM profiles WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM blocks WHERE (owner = ? AND blocked = profiles.id)
            OR (owner = profiles.id AND blocked = ?))
          AND (SELECT COUNT(*) FROM messages WHERE sender = ? AND created_at >= ?) < 5
      `).bind(crypto.randomUUID(), me.id, message, now, data.recipient, me.id, me.id, me.id, now - 60_000).run();
      return result.meta.changes ? reply({ ok: true }, 201) : reply({ error: 'Could not send right now.' }, 409);
    }

    if (path === '/block' && request.method === 'POST') {
      if (!idPattern.test(data.profile || '') || data.profile === me.id) return reply({ error: 'Invalid profile.' }, 400);
      if (data.blocked === false) {
        await db.prepare('DELETE FROM blocks WHERE owner = ? AND blocked = ?').bind(me.id, data.profile).run();
      } else {
        await db.prepare('INSERT OR IGNORE INTO blocks(owner, blocked) SELECT ?, id FROM profiles WHERE id = ?')
          .bind(me.id, data.profile).run();
      }
      return reply({ ok: true });
    }

    if (path === '/delete-profile' && request.method === 'POST') {
      if (data.confirm !== true) return reply({ error: 'Confirm that you want to delete your profile.' }, 400);
      await db.prepare('DELETE FROM profiles WHERE id = ?').bind(me.id).run();
      return reply({ ok: true });
    }

    return reply({ error: 'Unknown action.' }, 404);
  },
};
