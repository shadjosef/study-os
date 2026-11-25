import { handleRooms, runningStudyRoom } from './rooms.mjs';
import { handleDuels } from './duels.mjs';
import {
  verifyJoinProof, consumeInviteUse, handleAdmin, getAdminMemberKey,
  getJoinSettings, verifyInviteCodeOnly, grantArchivePass, getActiveArchiveMemberKey,
} from './admin.mjs';
import { handlePublicAuth, handleAuthedAuth, cleanSecondaryLanguage, cleanContactEmail, maskEmailHint, cleanSchoolName, cleanMajorName, cleanProfileCanvasOrigin } from './auth.mjs';
import { handleSync } from './sync.mjs';
import { checkHuman } from './human.mjs';
import { readTimeEdit, pushTimeEditFeed, getTimeEditFeed } from './timeedit.mjs';
import { handleCourses } from './courses.mjs';
import { handleAi } from './ai.mjs';
import { handleFeedback } from './feedback.mjs';
import { handleMaterials } from './materials.mjs';

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
const maxIcsBytes = 2_100_000;
const chromeExtOriginPattern = /^chrome-extension:\/\/[a-p]{32}$/;
const extensionAllowedPaths = new Set([
  '/auth/extension-link',
  '/courses/sync',
  '/schedule/timeedit-push',
  '/schedule/timeedit-feed',
  '/profile',
]);
const publicAuthPaths = new Set([
  '/auth/config',
  '/auth/google',
  '/auth/google/complete',
  '/auth/passkey/login/options',
  '/auth/passkey/login/verify',
  '/auth/link-redeem',
  '/auth/extension-link',
  '/auth/recovery',
]);
const breakRequired = new Set(['/dashboard', '/message', '/chat', '/block', '/sets']);
const osloClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function isEveningOsloWindow(now = Date.now()) {
  const parts = osloClock.formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  const mins = h * 60 + m;
  return mins >= 18 * 60 && mins < 22 * 60 + 30;
}

function isAdminMember(env, me, tokenHash) {
  const adminHash = typeof env.ADMIN_TOKEN_HASH === 'string' ? env.ADMIN_TOKEN_HASH.trim().toLowerCase() : '';
  if (adminHash && (equalProof(adminHash, tokenHash) || equalProof(adminHash, me.primary_token_hash))) return true;
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
    secondaryLanguage: me.secondary_language || '',
    school: me.school || '',
    major: me.major || '',
    canvasOrigin: me.canvas_origin || '',
    newsletterOptIn: Boolean(me.newsletter_opt_in),
    contactEmailHint: maskEmailHint(me.contact_email || ''),
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
    const url = new URL(request.url);
    const path = url.pathname;
    const webOrigin = request.headers.get('Origin');
    const isAllowedWeb = Boolean(webOrigin && (webOrigin === env.WEB_ORIGIN || webOrigin === env.WEB_ADDITIONAL_ORIGIN));
    const isAllowedExt = Boolean(
      extensionAllowedPaths.has(path) && (
        (webOrigin && chromeExtOriginPattern.test(webOrigin)) ||
        (!webOrigin && request.headers.get('X-Study-OS-Client') === 'extension')
      )
    );
    if (isAllowedWeb) {
      headers['Access-Control-Allow-Origin'] = webOrigin;
    } else if (isAllowedExt && webOrigin) {
      headers['Access-Control-Allow-Origin'] = webOrigin;
    }
    const reply = (data, status = 200) => Response.json(data, { status, headers });
    if (!isAllowedWeb && !isAllowedExt) return reply({ error: 'Origin not allowed.' }, 403);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        ...headers,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Study-OS-Client',
        'Access-Control-Max-Age': '3600',
      } });
    }

    const db = env.DB;
    let data = {};
    if (request.method === 'POST') {
      const limit = (path === '/schedule/timeedit-push' || path === '/ai/tutor')
        ? maxIcsBytes
        : (path === '/sync' || path === '/courses/sync' || path === '/materials/chunk' || path === '/feedback') ? maxSyncBytes : maxInputBytes;
      try { data = await readJson(request, limit); }
      catch { return reply({ error: 'Invalid request.' }, 400); }
    }
    const humanError = await checkHuman(request, env, path, data, reply);
    if (humanError) return humanError;
    if (path === '/courses' && request.method === 'GET') return handleCourses({ path, request, db, reply });

    if (path === '/leaderboard/public' && request.method === 'GET') {
      const offset = Number(url.searchParams.get('offset') || 0);
      if (!boundedInt(offset, 1000)) return reply({ error: 'Invalid leaderboard page.' }, 400);
      const nowPublic = Date.now();
      const [ranks, summary] = await Promise.all([
        db.prepare(`
          SELECT nickname, avatar, bio, school, major, study_minutes, break_minutes, break_count, last_break_at,
            completed, attempts, accuracy, presence.mode,
            presence.elapsed_seconds, presence.updated_at, presence.break_ends_at
          FROM profiles LEFT JOIN presence ON presence.profile = profiles.id AND presence.expires_at > ?
            AND (presence.mode <> 'break' OR presence.break_ends_at > ?)
          ORDER BY completed DESC, study_minutes DESC, nickname LIMIT 51 OFFSET ?
        `).bind(nowPublic, nowPublic, offset).all(),
        db.prepare(`
          SELECT COUNT(*) AS total,
            SUM(CASE WHEN presence.expires_at > ? AND presence.mode IN ('working', 'break')
              AND (presence.mode <> 'break' OR presence.break_ends_at > ?) THEN 1 ELSE 0 END) AS active
          FROM profiles LEFT JOIN presence ON presence.profile = profiles.id
        `).bind(nowPublic, nowPublic).first(),
      ]);
      return Response.json(
        {
          ranks: (ranks.results || []).slice(0, 50),
          hasMoreRanks: (ranks.results || []).length > 50,
          totalMembers: Number(summary?.total || 0),
          activeNow: Number(summary?.active || 0),
          now: nowPublic,
        },
        { status: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=15' } }
      );
    }

    if (publicAuthPaths.has(path)) {
      return handlePublicAuth({
        request, path, db, env, now: Date.now(), data, reply, digest, hex,
        verifyJoinProof, consumeInviteUse, grantArchivePass, getJoinSettings, equalProof, nicknamePattern,
      });
    }

    if (path === '/join' && request.method === 'POST') {
      const nowJoin = Date.now();
      const check = await verifyJoinProof(db, env, data.proof, nowJoin, equalProof, false, data.proofUpper || '');
      if (!check.ok) return reply({ error: check.error }, 403);
      const nickname = typeof data.nickname === 'string' ? data.nickname.trim().normalize('NFC') : '';
      if (!nicknamePattern.test(nickname)) {
        return reply({ error: 'Choose a nickname of 2–24 letters, numbers or spaces.' }, 400);
      }
      const secondaryLanguage = cleanSecondaryLanguage(data.secondaryLanguage);
      const school = cleanSchoolName(data.school || '');
      const major = cleanMajorName(data.major || '');
      const canvasOrigin = cleanProfileCanvasOrigin(data.canvasOrigin || '');
      const newsletterOptIn = Boolean(data.newsletterOptIn) ? 1 : 0;
      const contactEmail = newsletterOptIn ? cleanContactEmail(data.contactEmail || '') : '';
      const newsletterOptInAt = newsletterOptIn ? nowJoin : 0;
      const tosAcceptedAt = data.tosAccepted === false ? 0 : nowJoin;
      const id = crypto.randomUUID();
      const token = 'soc1_' + hex(crypto.getRandomValues(new Uint8Array(32)));
      const result = await db.prepare(`
        INSERT OR IGNORE INTO profiles(id, token_hash, nickname, secondary_language, school, major, canvas_origin, newsletter_opt_in, newsletter_opt_in_at, contact_email, tos_accepted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, await digest(token), nickname, secondaryLanguage, school, major, canvasOrigin, newsletterOptIn, newsletterOptInAt, contactEmail, tosAcceptedAt).run();
      if (!result.meta.changes) return reply({ error: 'That nickname is taken.' }, 409);
      if (check.inviteId && !await consumeInviteUse(db, check.inviteId, nowJoin)) {
        await db.prepare('DELETE FROM profiles WHERE id = ?').bind(id).run();
        return reply({ error: 'That access code is no longer available.' }, 403);
      }
      if (check.inviteId) {
        await grantArchivePass(db, id, check.inviteId, nowJoin);
      }
      return reply({ token }, 201);
    }

    const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (!tokenPattern.test(token)) return reply({ error: 'Enter your profile key.' }, 401);
    const tokenHash = await digest(token);
    const now = Date.now();
    let me = await db.prepare(`
      SELECT profiles.id, profiles.token_hash AS primary_token_hash, nickname, avatar, bio, nickname_changed_at,
        secondary_language, school, major, canvas_origin, newsletter_opt_in, newsletter_opt_in_at, contact_email, tos_accepted_at,
        study_minutes, break_minutes, break_count, last_break_at,
        completed, attempts, accuracy, break_ends_at, expires_at
      FROM profiles LEFT JOIN presence ON presence.profile = profiles.id WHERE token_hash = ?
    `).bind(tokenHash).first();
    if (!me) {
      me = await db.prepare(`
        SELECT profiles.id, profiles.token_hash AS primary_token_hash, nickname, avatar, bio, nickname_changed_at,
          secondary_language, school, major, canvas_origin, newsletter_opt_in, newsletter_opt_in_at, contact_email, tos_accepted_at,
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
    if (path === '/schedule/timeedit' && request.method === 'POST') return readTimeEdit(data, reply);
    if (path === '/schedule/timeedit-push' && request.method === 'POST') return pushTimeEditFeed(db, me.id, data, now, reply);
    if (path === '/schedule/timeedit-feed' && request.method === 'GET') return getTimeEditFeed(db, me.id, reply);
    const isAdmin = isAdminMember(env, me, tokenHash);
    if (path === '/courses/sync' || path === '/courses/propose' || path === '/admin/courses') {
      return handleCourses({ path, request, db, data, me, isAdmin, now, reply });
    }
    if (path === '/auth/redeem-code' && request.method === 'POST') {
      const check = await verifyInviteCodeOnly(db, data.proof, data.proofUpper || '', now);
      if (!check.ok) return reply({ error: check.error }, 403);
      const prevPass = await db.prepare('SELECT invite_id FROM archive_passes WHERE profile_id = ?')
        .bind(me.id).first().catch(() => null);
      if (!prevPass || prevPass.invite_id !== check.inviteId) {
        if (!await consumeInviteUse(db, check.inviteId, now)) {
          return reply({ error: 'That access code has reached its usage limit.' }, 403);
        }
      }
      await grantArchivePass(db, me.id, check.inviteId, now);
      const archiveMemberKey = await getActiveArchiveMemberKey(db, env, me.id, isAdmin, now);
      return reply({
        ok: true,
        archiveUnlocked: Boolean(archiveMemberKey),
        archiveMemberKey,
      });
    }
    if (path.startsWith('/auth/')) {
      return handleAuthedAuth({ request, path, db, env, me, tokenHash, now, data, reply, digest });
    }
    if (path === '/sync') {
      return handleSync({ request, db, me, now, data, reply });
    }
    if (path.startsWith('/ai/')) {
      const corsHeaders = headers['Access-Control-Allow-Origin']
        ? { 'Access-Control-Allow-Origin': headers['Access-Control-Allow-Origin'], Vary: 'Origin' }
        : { Vary: 'Origin' };
      return handleAi({ request, path, db, env, me, isAdmin, now, data, reply, corsHeaders });
    }
    if (path === '/feedback' || path === '/admin/feedback') {
      return handleFeedback({ request, path, db, me, isAdmin, now, data, reply });
    }
    if (path === '/materials' || path.startsWith('/materials/')) {
      const corsHeaders = headers['Access-Control-Allow-Origin']
        ? { 'Access-Control-Allow-Origin': headers['Access-Control-Allow-Origin'], Vary: 'Origin' }
        : { Vary: 'Origin' };
      return handleMaterials({ request, url, path, db, me, now, data, reply, corsHeaders });
    }
    if (path.startsWith('/admin/')) {
      return handleAdmin({ request, url, db, env, me, isAdmin, now, data, reply, digest, nicknamePattern });
    }
    if (path === '/duels' || path.startsWith('/duels/')) {
      return handleDuels({ request, url, db, me, now, data, reply });
    }
    if (path === '/shares') {
      if (request.method === 'GET') {
        const { results } = await db.prepare(`
          SELECT m.id, m.sender, m.recipient, a.nickname AS senderName, a.avatar AS senderAvatar,
            b.nickname AS recipientName, b.avatar AS recipientAvatar,
            m.message, m.created_at AS createdAt
          FROM messages m JOIN profiles a ON a.id = m.sender JOIN profiles b ON b.id = m.recipient
          WHERE (m.recipient = ? OR m.sender = ?)
            AND (m.message LIKE '%?play=%' OR m.message LIKE '%&play=%')
            AND NOT EXISTS (SELECT 1 FROM blocks WHERE (owner = ? AND blocked IN (m.sender, m.recipient))
              OR (blocked = ? AND owner IN (m.sender, m.recipient)))
          ORDER BY m.created_at DESC LIMIT 30
        `).bind(me.id, me.id, me.id, me.id).all();
        const incoming = (results || []).filter((r) => r.recipient === me.id);
        return reply({ now, incoming, recent: results || [] });
      }
      if (request.method === 'POST') {
        const recipient = typeof data.recipient === 'string' ? data.recipient.trim() : '';
        const shareUrl = typeof data.url === 'string' ? data.url.trim().slice(0, 900) : '';
        const title = typeof data.title === 'string' ? data.title.trim().replace(/\s+/g, ' ').slice(0, 100) : 'Shared Study Playlist';
        const note = typeof data.note === 'string' ? data.note.trim().replace(/\s+/g, ' ').slice(0, 180) : '';
        const hasValidUrl = /^(?:https:\/\/[^\s]+|\/\?)[^\s]*[?&](?:play|join_room)=/i.test(shareUrl);
        if (!idPattern.test(recipient) || recipient === me.id || !hasValidUrl) {
          return reply({ error: 'Choose a classmate and a valid Study-OS playlist link.' }, 400);
        }
        const target = await db.prepare('SELECT id, nickname FROM profiles WHERE id = ?').bind(recipient).first();
        if (!target) return reply({ error: 'Classmate not found.' }, 404);
        const prefix = /[?&]join_room=[A-F0-9]{8}\b/i.test(shareUrl) ? '📚 Study Together invite' : '📚 Shared playlist';
        const bodyText = `${prefix}: ${title}${note ? ` — “${note}”` : ''}\n${shareUrl}`.slice(0, 1500);
        const id = crypto.randomUUID();
        const result = await db.prepare(`
          INSERT INTO messages(id, sender, recipient, message, created_at)
          SELECT ?, ?, id, ?, ? FROM profiles WHERE id = ?
            AND NOT EXISTS (SELECT 1 FROM blocks WHERE (owner = ? AND blocked = profiles.id)
              OR (owner = profiles.id AND blocked = ?))
            AND (SELECT COUNT(*) FROM messages WHERE sender = ? AND created_at >= ?) < 10
        `).bind(id, me.id, bodyText, now, recipient, me.id, me.id, me.id, now - 60_000).run();
        return result.meta.changes
          ? reply({ ok: true, id, recipientName: target.nickname }, 201)
          : reply({ error: 'Could not send right now (rate limit or blocked).' }, 409);
      }
      return reply({ error: 'Invalid share action.' }, 405);
    }
    if (breakRequired.has(path) || path === '/rooms' || path.startsWith('/rooms/')) {
      const breakAccess = isEveningOsloWindow(now) || (me.break_ends_at > now && me.expires_at > now);
      const canUseCommunity = breakAccess && !await runningStudyRoom(db, me.id, now);
      if (path === '/rooms' || path.startsWith('/rooms/')) {
        return handleRooms({ request, url, db, me, now, data, canUseCommunity, reply });
      }
      if (!canUseCommunity) {
        return reply({ error: 'Community opens on breaks or from 18:00 to 22:30 Oslo time, outside active study rooms.' }, 423);
      }
    }

    if (path === '/profile') {
      if (request.method === 'GET') {
        const summary = profileSummary(me, isAdmin, now);
        if (isAdmin) {
          const mk = await getAdminMemberKey(db, env);
          if (mk) summary.memberKey = mk;
        }
        const archiveMk = await getActiveArchiveMemberKey(db, env, me.id, isAdmin, now);
        if (archiveMk) {
          summary.archiveMemberKey = archiveMk;
          summary.hasArchivePass = true;
        } else {
          summary.hasArchivePass = false;
        }
        return reply(summary);
      }
      if (request.method === 'POST') {
        let nextNickname = me.nickname;
        let nextChangedAt = Number(me.nickname_changed_at || 0);
        let nextAvatar = me.avatar || '';
        let nextBio = me.bio || '';
        let nextSecLang = me.secondary_language || '';
        let nextSchool = me.school || '';
        let nextMajor = me.major || '';
        let nextCanvasOrigin = me.canvas_origin || '';
        let nextNewsletter = Number(me.newsletter_opt_in || 0);
        let nextNewsletterAt = Number(me.newsletter_opt_in_at || 0);
        let nextEmail = me.contact_email || '';

        if (Object.prototype.hasOwnProperty.call(data, 'secondaryLanguage')) {
          nextSecLang = cleanSecondaryLanguage(data.secondaryLanguage);
        }
        if (Object.prototype.hasOwnProperty.call(data, 'school')) {
          nextSchool = cleanSchoolName(data.school || '');
        }
        if (Object.prototype.hasOwnProperty.call(data, 'major')) {
          nextMajor = cleanMajorName(data.major || '');
        }
        if (Object.prototype.hasOwnProperty.call(data, 'canvasOrigin')) {
          nextCanvasOrigin = cleanProfileCanvasOrigin(data.canvasOrigin || '');
        }
        if (Object.prototype.hasOwnProperty.call(data, 'newsletterOptIn')) {
          const want = Boolean(data.newsletterOptIn) ? 1 : 0;
          if (want && !nextNewsletter) nextNewsletterAt = now;
          nextNewsletter = want;
          if (!want) {
            nextNewsletterAt = 0;
            nextEmail = '';
          }
        }
        if (nextNewsletter && Object.prototype.hasOwnProperty.call(data, 'contactEmail')) {
          const rawEmail = String(data.contactEmail || '').trim();
          if (rawEmail) {
            const valid = cleanContactEmail(rawEmail);
            if (!valid) return reply({ error: 'Enter a valid email address for monthly Study-OS digests.' }, 400);
            nextEmail = valid;
          }
        }

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
          await db.prepare(`
            UPDATE profiles
            SET nickname = ?, avatar = ?, bio = ?, nickname_changed_at = ?,
                secondary_language = ?, school = ?, major = ?, canvas_origin = ?, newsletter_opt_in = ?, newsletter_opt_in_at = ?, contact_email = ?
            WHERE id = ?
          `).bind(nextNickname, nextAvatar, nextBio, nextChangedAt, nextSecLang, nextSchool, nextMajor, nextCanvasOrigin, nextNewsletter, nextNewsletterAt, nextEmail, me.id).run();
        } catch {
          return reply({ error: 'That nickname is taken.' }, 409);
        }

        const updated = {
          ...me,
          nickname: nextNickname,
          avatar: nextAvatar,
          bio: nextBio,
          nickname_changed_at: nextChangedAt,
          secondary_language: nextSecLang,
          school: nextSchool,
          major: nextMajor,
          canvas_origin: nextCanvasOrigin,
          newsletter_opt_in: nextNewsletter,
          newsletter_opt_in_at: nextNewsletterAt,
          contact_email: nextEmail,
        };
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
        SELECT profiles.id, nickname, avatar, bio, school, major, study_minutes, break_minutes, break_count, last_break_at,
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
      if (isAdmin) {
        const mk = await getAdminMemberKey(db, env);
        if (mk) mePayload.memberKey = mk;
      }
      const archiveMk = await getActiveArchiveMemberKey(db, env, me.id, isAdmin, now);
      if (archiveMk) {
        mePayload.archiveMemberKey = archiveMk;
        mePayload.hasArchivePass = true;
      } else {
        mePayload.hasArchivePass = false;
      }
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
        const rawCards = Array.isArray(data.cards) ? data.cards : [];
        const rawQuestions = Array.isArray(data.questions) ? data.questions : [];
        let storedPayload = null;
        let cardCount = 0;

        if (rawQuestions.length >= 1 && rawQuestions.length <= 25 && title && title.length <= 100) {
          const cleanQs = rawQuestions.map((q) => {
            if (!q || typeof q !== 'object') return null;
            const prompt = typeof q.promptMarkdown === 'string' ? q.promptMarkdown.trim().slice(0, 900) : '';
            const solution = typeof q.solutionMarkdown === 'string' ? q.solutionMarkdown.trim().slice(0, 1200) : '';
            if (!prompt || !solution) return null;
            const isMcq = q.kind === 'mcq' && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 5;
            const options = isMcq ? q.options.map((o) => String(o || '').trim().slice(0, 260)).filter(Boolean) : [];
            const validMcq = isMcq && options.length >= 2 && Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < options.length;
            return {
              title: typeof q.title === 'string' ? q.title.trim().slice(0, 100) : '',
              kind: validMcq ? 'mcq' : 'written',
              difficulty: [1, 2, 3].includes(Number(q.difficulty)) ? Number(q.difficulty) : 2,
              topic: typeof q.topic === 'string' ? q.topic.trim().slice(0, 80) : '',
              promptMarkdown: prompt,
              ...(validMcq ? { options, answerIndex: q.answerIndex } : {}),
              hint: typeof q.hint === 'string' ? q.hint.trim().slice(0, 320) : '',
              solutionMarkdown: solution,
            };
          }).filter(Boolean);
          if (cleanQs.length >= 1) {
            storedPayload = {
              format: 'study-os-rich-set-v1',
              courseCode: typeof data.courseCode === 'string' ? data.courseCode.trim().slice(0, 24) : '',
              school: me.school || '',
              questions: cleanQs,
            };
            cardCount = cleanQs.length;
          }
        } else if (title && title.length <= 80 && rawCards.length >= 1 && rawCards.length <= 30 && !rawCards.some((card) =>
          !Array.isArray(card) || card.length !== 2 || card.some((cell) => typeof cell !== 'string' || !cell.trim() || cell.length > 250))) {
          storedPayload = rawCards;
          cardCount = rawCards.length;
        }
        if (!storedPayload || JSON.stringify(storedPayload).length > 52_000) {
          return reply({ error: 'Use a title and 1–25 study questions (or 1–30 Q&A cards).' }, 400);
        }
        const result = await db.prepare(`
          INSERT INTO study_sets(id, owner, title, cards, card_count, created_at)
          SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM study_sets WHERE owner = ?) < 15
        `).bind(crypto.randomUUID(), me.id, title, JSON.stringify(storedPayload), cardCount, now, me.id).run();
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
