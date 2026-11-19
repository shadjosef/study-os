const roomCode = /^[A-F0-9]{8}$/;
const lobbyDuration = 60 * 60_000;
const duelDuration = 5 * 60_000;
const groupDuration = 25 * 60_000;

function makeDuel() {
  const values = crypto.getRandomValues(new Uint32Array(12));
  const number = (index, minimum, range) => minimum + values[index] % range;
  const x = number(0, 2, 13), a = number(1, 2, 8), b = number(2, 3, 14);
  const c = number(3, 2, 7), t = number(4, 2, 6);
  const price = number(5, 4, 20) * 20, percent = number(6, 2, 18);
  const p = number(7, 5, 15), q = number(8, 5, 15), r = number(9, 5, 15);
  const start = number(10, 3, 12) * 20, step = number(11, 2, 10);
  return [
    { prompt: `Solve for x: ${a}x + ${b} = ${a * x + b}.`, answer: x },
    { prompt: `If f(x) = ${c}x² + ${a}x, what is f′(${t})?`, answer: 2 * c * t + a },
    { prompt: `A product costs ${price} kr. What is the new price after a ${percent}% increase? Enter the price in kr.`, answer: price * (100 + percent) / 100 },
    { prompt: `Three observations are ${p}, ${q} and ${r}. What is their sum of squared deviations from the mean, multiplied by 3?`, answer: 3 * (p * p + q * q + r * r) - (p + q + r) ** 2 },
    { prompt: `An arithmetic sequence starts at ${start} and increases by ${step} each term. What is the sum of its first 5 terms?`, answer: 5 * start + 10 * step },
    { prompt: `A box holds ${a} red and ${x} blue tokens. You add ${t} blue tokens. How many ordered draws of one red and then one blue token are possible?`, answer: a * (x + t) },
  ];
}

const activeRoom = `
  SELECT room.code FROM room_members m JOIN study_rooms room ON room.code = m.code
  WHERE m.profile = ? AND room.closed_at = 0
    AND ((room.starts_at = 0 AND room.created_at > ?) OR room.ends_at > ?)
`;

export async function runningStudyRoom(db, profile, now) {
  return Boolean(await db.prepare(`
    SELECT 1 FROM room_members m JOIN study_rooms room ON room.code = m.code
    WHERE m.profile = ? AND room.starts_at > 0 AND room.ends_at > ? AND room.closed_at = 0
  `).bind(profile, now).first());
}

async function membersOf(db, code) {
  const { results } = await db.prepare(`
    SELECT m.profile, m.ready, m.finished, m.completed, p.nickname,
      COUNT(a.question) AS submitted, COALESCE(SUM(a.correct), 0) AS score,
      COALESCE(r.rating, 1200) AS rating, COALESCE(r.matches, 0) AS matches
    FROM room_members m JOIN profiles p ON p.id = m.profile
    LEFT JOIN room_answers a ON a.code = m.code AND a.profile = m.profile
    LEFT JOIN duel_ratings r ON r.profile = m.profile
    WHERE m.code = ? GROUP BY m.profile ORDER BY m.profile
  `).bind(code).all();
  return results;
}

async function scoreDuel(db, code, players) {
  if (players.length !== 2 || players.some((player) => !player.submitted)) return;
  const [first, second] = players;
  await db.prepare('INSERT OR IGNORE INTO duel_ratings(profile) VALUES (?), (?)').bind(first.profile, second.profile).run();
  const outcome = first.score === second.score ? 0.5 : Number(first.score > second.score);
  const expected = 1 / (1 + 10 ** ((second.rating - first.rating) / 400));
  const change = Math.round(32 * (outcome - expected));
  await db.prepare(`
    INSERT OR IGNORE INTO duel_results(code, first_player, second_player, first_change)
    SELECT ?, ?, ?, ?
    WHERE (SELECT matches FROM duel_ratings WHERE profile = ?) = ?
      AND (SELECT matches FROM duel_ratings WHERE profile = ?) = ?
  `).bind(code, first.profile, second.profile, change, first.profile, first.matches, second.profile, second.matches).run();
}

async function roomState(db, code, me, now, canUseCommunity, reply) {
  const room = await db.prepare(`
    SELECT r.* FROM study_rooms r JOIN room_members m ON m.code = r.code WHERE r.code = ? AND m.profile = ?
  `).bind(code, me.id).first();
  if (!room || (!room.starts_at && room.created_at <= now - lobbyDuration)) {
    return reply({ error: 'This room has closed.' }, 404);
  }
  if (!room.starts_at && !canUseCommunity) return reply({ error: 'Open the lobby on a break.' }, 423);
  await db.prepare(`
    UPDATE study_rooms SET closed_at = ?
    WHERE code = ? AND starts_at > 0 AND closed_at = 0
    AND (ends_at <= ? OR NOT EXISTS (SELECT 1 FROM room_members WHERE code = ? AND finished = 0))
  `).bind(now, code, now, code).run();
  const current = await db.prepare('SELECT starts_at, ends_at, closed_at, deck FROM study_rooms WHERE code = ?').bind(code).first();
  const players = await membersOf(db, code);
  const ended = Boolean(current.closed_at);
  let result;
  if (room.mode === 'duel' && ended) {
    await scoreDuel(db, code, players);
    result = await db.prepare('SELECT first_player, first_change FROM duel_results WHERE code = ?').bind(code).first();
  }
  const deck = current.deck ? JSON.parse(current.deck) : [];
  const mine = !deck.length ? [] : (await db.prepare(`
    SELECT question, correct FROM room_answers WHERE code = ? AND profile = ? ORDER BY question
  `).bind(code, me.id).all()).results;
  return reply({
    code, mode: room.mode, host: room.owner === me.id, now,
    phase: ended ? 'finished' : current.starts_at ? 'running' : 'lobby', endsAt: current.ends_at,
    players: players.map((player) => ({
      name: player.nickname, current: player.profile === me.id, ready: Boolean(player.ready), finished: Boolean(player.finished),
      progress: room.mode === 'duel' ? player.submitted : player.completed,
      ...(ended && room.mode === 'duel' ? { score: player.score,
        ratingChange: result ? result.first_change * (result.first_player === player.profile ? 1 : -1) : null } : {}),
    })),
    questions: deck.map(({ prompt, answer }) => ended ? { prompt, answer } : { prompt }),
    answers: mine.map(({ question, correct }) => ended ? { question, correct: Boolean(correct) } : { question }),
  });
}

export async function handleRooms({ request, url, db, me, now, data, canUseCommunity, reply }) {
  const [route, code, action, extra] = url.pathname.slice(1).split('/');
  if (route !== 'rooms' || extra !== undefined) return reply({ error: 'Invalid room action.' }, 404);
  if (code === 'ratings' && !action && request.method === 'GET') {
    if (!canUseCommunity) return reply({ error: 'Ratings open during break access.' }, 423);
    const { results } = await db.prepare(`
      SELECT p.nickname, r.rating, r.matches FROM duel_ratings r JOIN profiles p ON p.id = r.profile
      WHERE r.matches > 0 ORDER BY r.rating DESC, p.nickname LIMIT 50
    `).all();
    return reply({ ratings: results });
  }
  if (!code && request.method === 'GET') {
    const room = await db.prepare(activeRoom).bind(me.id, now - lobbyDuration, now).first();
    return reply({ code: room?.code || null });
  }
  if (!code && request.method === 'POST') {
    if (!canUseCommunity) return reply({ error: 'Join a room during break access.' }, 423);
    const candidate = typeof data.code === 'string' ? data.code.trim().toUpperCase() : '';
    if (candidate && !roomCode.test(candidate)) return reply({ error: 'Enter the eight-character room code.' }, 400);
    if (!candidate && !['group', 'duel'].includes(data.mode)) return reply({ error: 'Choose group or duel.' }, 400);
    const existing = await db.prepare(activeRoom).bind(me.id, now - lobbyDuration, now).first();
    if (existing) return existing.code === candidate ? reply(existing) : reply({ error: 'Finish or leave your current room first.' }, 409);
    if (!candidate) {
      const generated = crypto.randomUUID().slice(0, 8).toUpperCase();
      const result = await db.prepare(`
        INSERT OR IGNORE INTO study_rooms(code, owner, mode, created_at)
        SELECT ?, ?, ?, ? WHERE NOT EXISTS (${activeRoom})
      `).bind(generated, me.id, data.mode, now, me.id, now - lobbyDuration, now).run();
      return result.meta.changes ? reply({ code: generated }, 201) : reply({ error: 'Try creating the room again.' }, 409);
    }
    const result = await db.prepare(`
      INSERT OR IGNORE INTO room_members(code, profile)
      SELECT r.code, ? FROM study_rooms r WHERE r.code = ? AND r.starts_at = 0 AND r.created_at > ?
        AND (SELECT COUNT(*) FROM room_members WHERE code = r.code) < CASE WHEN r.mode = 'duel' THEN 2 ELSE 8 END
        AND NOT EXISTS (${activeRoom})
        AND NOT EXISTS (
          SELECT 1 FROM room_members other JOIN blocks b
            ON (b.owner = ? AND b.blocked = other.profile) OR (b.blocked = ? AND b.owner = other.profile)
          WHERE other.code = r.code
        )
    `).bind(me.id, candidate, now - lobbyDuration, me.id, now - lobbyDuration, now, me.id, me.id).run();
    return result.meta.changes ? reply({ code: candidate }, 201) : reply({ error: 'This room is unavailable.' }, 409);
  }
  if (!roomCode.test(code || '')) return reply({ error: 'Invalid room code.' }, 400);
  if (!action && request.method === 'GET') return roomState(db, code, me, now, canUseCommunity, reply);
  if (request.method !== 'POST') return reply({ error: 'Invalid room action.' }, 404);

  const room = await db.prepare(`
    SELECT r.*, m.finished FROM study_rooms r JOIN room_members m ON m.code = r.code WHERE r.code = ? AND m.profile = ?
  `).bind(code, me.id).first();
  if (!room) return reply({ error: 'You are not in this room.' }, 404);
  if (!room.starts_at) {
    if (!canUseCommunity || room.created_at <= now - lobbyDuration) return reply({ error: 'This lobby is unavailable.' }, 423);
    if (action === 'ready') {
      await db.prepare(`
        UPDATE room_members SET ready = ? WHERE code = ? AND profile = ?
          AND EXISTS (SELECT 1 FROM study_rooms WHERE code = ? AND starts_at = 0)
      `).bind(Number(data.ready === true), code, me.id, code).run();
      return reply({ ok: true });
    }
    if (action === 'leave') {
      if (room.owner === me.id) {
        await db.prepare('DELETE FROM study_rooms WHERE code = ? AND starts_at = 0').bind(code).run();
      } else {
        await db.prepare(`
          DELETE FROM room_members WHERE code = ? AND profile = ?
            AND EXISTS (SELECT 1 FROM study_rooms WHERE code = ? AND starts_at = 0)
        `).bind(code, me.id, code).run();
      }
      return reply({ ok: true });
    }
    if (action === 'start' && room.owner === me.id) {
      const duel = room.mode === 'duel';
      const result = await db.prepare(`
        UPDATE study_rooms SET starts_at = ?, ends_at = ?, deck = ?
        WHERE code = ? AND starts_at = 0 AND (SELECT COUNT(*) FROM room_members WHERE code = ?) >= 2
          AND NOT EXISTS (SELECT 1 FROM room_members WHERE code = ? AND ready = 0)
      `).bind(now, now + (duel ? duelDuration : groupDuration), duel ? JSON.stringify(makeDuel()) : null, code, code, code).run();
      return result.meta.changes ? reply({ ok: true }) : reply({ error: 'Everyone must be ready, with at least two members.' }, 409);
    }
    return reply({ error: 'This action requires a running room.' }, 409);
  }
  if (action === 'finish') {
    await db.prepare('UPDATE room_members SET finished = 1 WHERE code = ? AND profile = ?').bind(code, me.id).run();
    return roomState(db, code, me, now, canUseCommunity, reply);
  }
  if (room.closed_at || room.ends_at <= now || room.finished) return reply({ error: 'Your round is finished.' }, 409);
  if (action === 'progress' && room.mode === 'group') {
    if (!Number.isInteger(data.completed) || data.completed < 0 || data.completed > 500) return reply({ error: 'Invalid study total.' }, 400);
    await db.prepare('UPDATE room_members SET completed = MAX(completed, ?) WHERE code = ? AND profile = ? AND finished = 0')
      .bind(data.completed, code, me.id).run();
    return reply({ ok: true });
  }
  if (action === 'answer' && room.mode === 'duel') {
    const deck = JSON.parse(room.deck);
    const question = data.question;
    const answer = typeof data.answer === 'string' ? data.answer.trim().replace(',', '.') : '';
    if (!Number.isInteger(question) || !deck[question] || !/^-?\d{1,12}(?:\.\d{1,8})?$/.test(answer)) {
      return reply({ error: 'Enter a numeric answer.' }, 400);
    }
    const correct = Number(Math.abs(Number(answer) - deck[question].answer) < 1e-7);
    const result = await db.prepare(`
      INSERT OR IGNORE INTO room_answers(code, profile, question, correct)
      SELECT ?, ?, ?, ? FROM room_members m JOIN study_rooms r ON r.code = m.code
      WHERE m.code = ? AND m.profile = ? AND m.finished = 0 AND r.closed_at = 0 AND r.ends_at > ?
    `).bind(code, me.id, question, correct, code, me.id, now).run();
    return result.meta.changes ? reply({ ok: true }) : reply({ error: 'This answer was already submitted or time ran out.' }, 409);
  }
  return reply({ error: 'Invalid room action.' }, 404);
}
