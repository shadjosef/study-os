import { makeDuel, ALLOWED_SUBJECTS, SUBJECT_LABELS, duelDuration, runningStudyRoom } from './rooms.mjs';

const PENDING_TTL_MS = 2 * 60 * 60_000;   // 2 hours to accept (covers a full 75m study wave + break!)
const ACCEPTED_TTL_MS = 15 * 60_000;      // 15 minutes for challenger to click Proceed once accepted
const RECENT_STARTED_MS = 90_000;         // 90s window for recipient poller to pick up live room launch
const RECENT_FEEDBACK_MS = 25_000;        // 25s window to show declined/cancelled notice
const ID_RE = /^[0-9a-f-]{36}$/;

function formatInviteRow(row, meId, now) {
  const isIncoming = row.target === meId;
  const subj = ALLOWED_SUBJECTS.has(row.subject) ? row.subject : 'mixed';
  const oppOnline = Number(row.opp_expires_at || 0) > now;
  return {
    id: row.id,
    direction: isIncoming ? 'incoming' : 'outgoing',
    status: row.status,
    subject: subj,
    subjectLabel: SUBJECT_LABELS[subj] || SUBJECT_LABELS.mixed,
    note: row.note || '',
    roomCode: row.room_code || '',
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    expiresAt: Number(row.expires_at || 0),
    opponent: {
      id: isIncoming ? row.challenger : row.target,
      nickname: row.opp_nickname || 'Student',
      avatar: row.opp_avatar || '',
      school: row.opp_school || '',
      major: row.opp_major || '',
      rating: Number(row.opp_rating || 1200),
      mode: oppOnline ? (row.opp_mode || 'working') : 'offline',
      breakEndsAt: oppOnline && row.opp_mode === 'break' ? Number(row.opp_break_ends_at || 0) : 0,
    },
  };
}

export async function handleDuels({ request, url, db, me, now, data, reply }) {
  const parts = url.pathname.slice(1).split('/');
  // /duels/opponents, /duels/active, /duels/invite, /duels/:id/respond, /duels/:id/proceed, /duels/:id/cancel
  const [, seg1, seg2, extra] = parts;
  if (extra !== undefined) return reply({ error: 'Invalid duel action.' }, 404);

  // Expire stale invites lazily
  await db.prepare(`
    UPDATE duel_invites SET status = 'expired', updated_at = ?
    WHERE status IN ('pending', 'accepted') AND expires_at <= ?
      AND (challenger = ? OR target = ?)
  `).bind(now, now, me.id, me.id).run();

  // 1. GET /duels/opponents — list classmates with live presence & rating
  if (seg1 === 'opponents' && !seg2 && request.method === 'GET') {
    const { results } = await db.prepare(`
      SELECT p.id, p.nickname, p.avatar, p.school, p.major,
        COALESCE(dr.rating, 1200) AS rating,
        COALESCE(dr.matches, 0) AS matches,
        pr.mode AS pres_mode, pr.expires_at AS pres_expires, pr.break_ends_at AS pres_break_ends
      FROM profiles p
      LEFT JOIN duel_ratings dr ON dr.profile = p.id
      LEFT JOIN presence pr ON pr.profile = p.id
      WHERE p.id != ?
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.owner = ? AND b.blocked = p.id) OR (b.blocked = ? AND b.owner = p.id)
        )
      ORDER BY
        CASE
          WHEN pr.expires_at > ? AND pr.mode = 'break' THEN 0
          WHEN pr.expires_at > ? AND pr.mode = 'working' THEN 1
          WHEN pr.expires_at > ? THEN 2
          ELSE 3
        END,
        p.completed DESC,
        p.nickname ASC
      LIMIT 60
    `).bind(me.id, me.id, me.id, now, now, now).all();

    return reply({
      now,
      opponents: results.map((r) => {
        const online = Number(r.pres_expires || 0) > now;
        const mode = online ? (r.pres_mode || 'working') : 'offline';
        return {
          id: r.id,
          nickname: r.nickname,
          avatar: r.avatar || '',
          school: r.school && r.school !== 'Prefer not to say' ? r.school : '',
          major: r.major && r.major !== 'Prefer not to say' ? r.major : '',
          rating: Number(r.rating || 1200),
          matches: Number(r.matches || 0),
          mode,
          breakEndsAt: mode === 'break' ? Number(r.pres_break_ends || 0) : 0,
        };
      }),
    });
  }

  // 2. GET /duels/active — lightweight poll for incoming & outgoing invites
  if (seg1 === 'active' && !seg2 && request.method === 'GET') {
    const { results: incomingRows } = await db.prepare(`
      SELECT d.*,
        p.nickname AS opp_nickname, p.avatar AS opp_avatar, p.school AS opp_school, p.major AS opp_major,
        COALESCE(dr.rating, 1200) AS opp_rating,
        pr.mode AS opp_mode, pr.expires_at AS opp_expires_at, pr.break_ends_at AS opp_break_ends_at
      FROM duel_invites d
      JOIN profiles p ON p.id = d.challenger
      LEFT JOIN duel_ratings dr ON dr.profile = d.challenger
      LEFT JOIN presence pr ON pr.profile = d.challenger
      WHERE d.target = ?
        AND (
          d.status IN ('pending', 'accepted')
          OR (d.status = 'started' AND d.updated_at > ?)
          OR (d.status = 'cancelled' AND d.updated_at > ?)
        )
      ORDER BY d.updated_at DESC
      LIMIT 12
    `).bind(me.id, now - RECENT_STARTED_MS, now - RECENT_FEEDBACK_MS).all();

    const { results: outgoingRows } = await db.prepare(`
      SELECT d.*,
        p.nickname AS opp_nickname, p.avatar AS opp_avatar, p.school AS opp_school, p.major AS opp_major,
        COALESCE(dr.rating, 1200) AS opp_rating,
        pr.mode AS opp_mode, pr.expires_at AS opp_expires_at, pr.break_ends_at AS opp_break_ends_at
      FROM duel_invites d
      JOIN profiles p ON p.id = d.target
      LEFT JOIN duel_ratings dr ON dr.profile = d.target
      LEFT JOIN presence pr ON pr.profile = d.target
      WHERE d.challenger = ?
        AND (
          d.status IN ('pending', 'accepted')
          OR (d.status = 'started' AND d.updated_at > ?)
          OR (d.status IN ('declined', 'cancelled') AND d.updated_at > ?)
        )
      ORDER BY d.updated_at DESC
      LIMIT 12
    `).bind(me.id, now - RECENT_STARTED_MS, now - RECENT_FEEDBACK_MS).all();

    return reply({
      now,
      incoming: incomingRows.map((r) => formatInviteRow(r, me.id, now)),
      outgoing: outgoingRows.map((r) => formatInviteRow(r, me.id, now)),
    });
  }

  // 3. POST /duels/invite — send a break-aware direct duel challenge
  if (seg1 === 'invite' && !seg2 && request.method === 'POST') {
    const targetId = typeof data.targetId === 'string' ? data.targetId.trim() : '';
    if (!ID_RE.test(targetId)) return reply({ error: 'Choose a classmate to challenge.' }, 400);
    if (targetId === me.id) return reply({ error: 'You cannot challenge yourself.' }, 400);

    const target = await db.prepare('SELECT id, nickname, avatar, school, major FROM profiles WHERE id = ?').bind(targetId).first();
    if (!target) return reply({ error: 'Classmate not found.' }, 404);

    const blocked = await db.prepare(`
      SELECT 1 FROM blocks WHERE (owner = ? AND blocked = ?) OR (owner = ? AND blocked = ?)
    `).bind(me.id, targetId, targetId, me.id).first();
    if (blocked) return reply({ error: 'Cannot send a duel invite to this user.' }, 403);

    // Prevent duplicate active invite to same opponent
    const existing = await db.prepare(`
      SELECT id, status FROM duel_invites
      WHERE challenger = ? AND target = ? AND status IN ('pending', 'accepted') AND expires_at > ?
      LIMIT 1
    `).bind(me.id, targetId, now).first();
    if (existing) {
      return reply({ error: `You already have an active duel request with ${target.nickname}.` }, 409);
    }

    // Cap concurrent outgoing invites to 5 so nobody spams the leaderboard
    const outCount = await db.prepare(`
      SELECT COUNT(*) AS n FROM duel_invites WHERE challenger = ? AND status IN ('pending', 'accepted') AND expires_at > ?
    `).bind(me.id, now).first();
    if (Number(outCount?.n || 0) >= 5) {
      return reply({ error: 'Cancel one of your pending duel invites before sending more.' }, 429);
    }

    const subject = ALLOWED_SUBJECTS.has(data.subject) ? data.subject : 'mixed';
    const note = typeof data.note === 'string'
      ? data.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 90)
      : '';
    const id = `duel_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

    await db.prepare(`
      INSERT INTO duel_invites(id, challenger, target, subject, note, status, room_code, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', '', ?, ?, ?)
    `).bind(id, me.id, targetId, subject, note, now, now, now + PENDING_TTL_MS).run();

    return reply({
      ok: true,
      invite: {
        id,
        direction: 'outgoing',
        status: 'pending',
        subject,
        subjectLabel: SUBJECT_LABELS[subject] || SUBJECT_LABELS.mixed,
        note,
        roomCode: '',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + PENDING_TTL_MS,
        opponent: {
          id: target.id,
          nickname: target.nickname,
          avatar: target.avatar || '',
          school: target.school || '',
          major: target.major || '',
        },
      },
    }, 201);
  }

  // Per-invite actions: /duels/:id/respond, /duels/:id/proceed, /duels/:id/cancel
  const inviteId = seg1 || '';
  if (!/^duel_[a-f0-9]{16}$/.test(inviteId) || request.method !== 'POST') {
    return reply({ error: 'Invalid duel invite action.' }, 404);
  }

  const inv = await db.prepare('SELECT * FROM duel_invites WHERE id = ?').bind(inviteId).first();
  if (!inv || (inv.challenger !== me.id && inv.target !== me.id)) {
    return reply({ error: 'Duel invite not found.' }, 404);
  }

  // 4. POST /duels/:id/respond — Target accepts or declines
  if (seg2 === 'respond') {
    if (inv.target !== me.id) return reply({ error: 'Only the invited player can respond.' }, 403);
    if (inv.status !== 'pending' || inv.expires_at <= now) {
      return reply({ error: 'This duel invite is no longer pending.' }, 409);
    }
    const action = data.action === 'accept' ? 'accept' : data.action === 'decline' ? 'decline' : '';
    if (!action) return reply({ error: 'Specify accept or decline.' }, 400);

    if (action === 'decline') {
      await db.prepare(`UPDATE duel_invites SET status = 'declined', updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(now, inviteId).run();
      return reply({ ok: true, status: 'declined' });
    }

    const res = await db.prepare(`
      UPDATE duel_invites SET status = 'accepted', updated_at = ?, expires_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(now, now + ACCEPTED_TTL_MS, inviteId).run();
    if (!res.meta.changes) return reply({ error: 'Invite was already updated.' }, 409);
    return reply({ ok: true, status: 'accepted' });
  }

  // 5. POST /duels/:id/proceed — Challenger launches live 1v1 duel room immediately for both players!
  if (seg2 === 'proceed') {
    if (inv.challenger !== me.id) return reply({ error: 'Only the challenger can proceed.' }, 403);
    if (inv.status === 'started' && inv.room_code) {
      return reply({ ok: true, code: inv.room_code });
    }
    if (inv.status !== 'accepted' || inv.expires_at <= now) {
      return reply({ error: 'Wait for your opponent to accept first (or invite expired).' }, 409);
    }

    // Ensure neither player is already in another running room
    if (await runningStudyRoom(db, me.id, now)) {
      return reply({ error: 'Finish your current active room before starting a duel.' }, 409);
    }
    if (await runningStudyRoom(db, inv.target, now)) {
      return reply({ error: 'Your opponent is currently in another live room.' }, 409);
    }

    const code = crypto.randomUUID().slice(0, 8).toUpperCase();
    const subject = ALLOWED_SUBJECTS.has(inv.subject) ? inv.subject : 'mixed';
    const deckJson = JSON.stringify({
      v: 2,
      subject,
      durationMin: 5,
      isPublic: false,
      courseId: '',
      courseLabel: '',
      questions: makeDuel(subject),
      rematchCode: '',
    });

    // Claim invite atomically first so double-clicks never spawn two rooms
    const claim = await db.prepare(`
      UPDATE duel_invites SET status = 'started', room_code = ?, updated_at = ?
      WHERE id = ? AND status = 'accepted'
    `).bind(code, now, inviteId).run();
    if (!claim.meta.changes) {
      const fresh = await db.prepare('SELECT status, room_code FROM duel_invites WHERE id = ?').bind(inviteId).first();
      if (fresh?.status === 'started' && fresh.room_code) return reply({ ok: true, code: fresh.room_code });
      return reply({ error: 'Invite could not be started.' }, 409);
    }

    // Create the live running 1v1 duel room (add_room_host trigger inserts challenger)
    await db.prepare(`
      INSERT INTO study_rooms(code, owner, mode, created_at, starts_at, ends_at, closed_at, deck)
      VALUES (?, ?, 'duel', ?, ?, ?, 0, ?)
    `).bind(code, me.id, now, now, now + duelDuration, deckJson).run();

    // Mark host ready and enroll target ready
    await db.prepare('UPDATE room_members SET ready = 1 WHERE code = ? AND profile = ?').bind(code, me.id).run();
    await db.prepare('INSERT OR IGNORE INTO room_members(code, profile, ready) VALUES (?, ?, 1)').bind(code, inv.target).run();

    return reply({ ok: true, code }, 201);
  }

  // 6. POST /duels/:id/cancel — Challenger cancels / chooses "Not now", or Target cancels acceptance
  if (seg2 === 'cancel') {
    if (!['pending', 'accepted'].includes(inv.status)) {
      return reply({ ok: true, status: inv.status });
    }
    await db.prepare(`UPDATE duel_invites SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'accepted')`)
      .bind(now, inviteId).run();
    return reply({ ok: true, status: 'cancelled' });
  }

  return reply({ error: 'Invalid duel action.' }, 404);
}
