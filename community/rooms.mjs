const roomCode = /^[A-F0-9]{8}$/;
const lobbyDuration = 60 * 60_000;
export const duelDuration = 5 * 60_000;
const rematchWindow = 15 * 60_000;
export const ALLOWED_SUBJECTS = new Set(['mixed', 'math', 'accounting', 'economics']);
const ALLOWED_GROUP_MINS = new Set([25, 50, 75, 120, 180]);

function cleanPlaylist(raw, fallbackCourseId = '', fallbackCourseLabel = '', updatedBy = '', now = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const courseId = typeof raw.courseId === 'string' ? raw.courseId.trim().slice(0, 40) : fallbackCourseId;
  const courseLabel = typeof raw.courseLabel === 'string' ? raw.courseLabel.trim().slice(0, 64) : fallbackCourseLabel;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 100) : '';
  const examCollectionId = typeof raw.examCollectionId === 'string' ? raw.examCollectionId.trim().slice(0, 64) : '';
  const mode = raw.mode === 'exam' ? 'exam' : 'practice';
  const examStyle = raw.examStyle === 'blind' ? 'blind' : 'guided';
  const rawIds = Array.isArray(raw.questionIds) ? raw.questionIds : [];
  const questionIds = [];
  const seen = new Set();
  for (const id of rawIds) {
    const clean = typeof id === 'string' ? id.trim().slice(0, 80) : '';
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    questionIds.push(clean);
    if (questionIds.length >= 60) break;
  }
  if (!courseId && !questionIds.length && !examCollectionId) return null;
  return {
    title: title || courseLabel || 'Shared Playlist',
    courseId,
    courseLabel,
    mode,
    examStyle,
    examCollectionId,
    questionIds,
    updatedBy: String(updatedBy || raw.updatedBy || '').trim().slice(0, 40),
    updatedAt: Number(now || raw.updatedAt || 0),
  };
}

function parseMemberActivity(raw) {
  if (typeof raw !== 'string' || !raw) return { activity: '', currentQid: '', currentLabel: '', doneIds: [] };
  if (raw.startsWith('{')) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        return {
          activity: typeof p.a === 'string' ? p.a.slice(0, 64) : '',
          currentQid: typeof p.q === 'string' ? p.q.slice(0, 80) : '',
          currentLabel: typeof p.l === 'string' ? p.l.slice(0, 48) : '',
          doneIds: Array.isArray(p.d) ? p.d.filter((x) => typeof x === 'string').slice(0, 60) : [],
        };
      }
    } catch {}
  }
  return { activity: raw.slice(0, 64), currentQid: '', currentLabel: '', doneIds: [] };
}

export const SUBJECT_LABELS = {
  mixed: 'BI Mixed Blitz',
  math: 'BI Maths (EBA 1181)',
  accounting: 'Accounting & Finance (EXC 3430)',
  economics: 'Economics (EXC 3420)',
};

function randVals(count) {
  return crypto.getRandomValues(new Uint32Array(count));
}

function makeMathDeck() {
  const v = randVals(14);
  const num = (i, min, range) => min + (v[i] % range);
  const x = num(0, 2, 13), a = num(1, 2, 8), b = num(2, 3, 14);
  const c = num(3, 2, 7), t = num(4, 2, 6);
  const price = num(5, 4, 20) * 20, pct = num(6, 2, 18);
  const pvRates = [5, 10, 20, 25];
  const rPct = pvRates[v[7] % pvRates.length];
  const pvBase = num(8, 2, 18) * 100;
  const fv1 = Math.round(pvBase * (100 + rPct) / 100);
  const start = num(9, 3, 12) * 20, step = num(10, 2, 10);
  const principal = num(11, 2, 10) * 1000;
  const gRate = [5, 10, 20][v[12] % 3];
  const fv2 = Math.round(principal * (100 + gRate) * (100 + gRate) / 10000);
  return [
    { tag: 'EBA 1181', prompt: `Solve for x: ${a}x + ${b} = ${a * x + b}.`, answer: x },
    { tag: 'EBA 1181', prompt: `If f(x) = ${c}x² + ${a}x, what is the derivative f′(${t})?`, answer: 2 * c * t + a },
    { tag: 'EBA 1181', prompt: `A product costs ${price} kr. What is the new price after a ${pct}% increase? (kr)`, answer: Math.round(price * (100 + pct)) / 100 },
    { tag: 'EBA 1181', prompt: `You receive ${fv1} kr in 1 year at a ${rPct}% discount rate. What is its Present Value today? (kr)`, answer: pvBase },
    { tag: 'EBA 1181', prompt: `An arithmetic sequence starts at ${start} and increases by ${step} each term. What is the sum of its first 5 terms?`, answer: 5 * start + 10 * step },
    { tag: 'EBA 1181', prompt: `${principal} kr grows at ${gRate}% compound interest per year for 2 years. What is the ending balance? (kr)`, answer: fv2 },
  ];
}

function makeAccountingDeck() {
  const v = randVals(16);
  const num = (i, min, range) => min + (v[i] % range);
  // 1. Balance sheet equation
  const assets = num(0, 12, 40) * 10_000;
  const liab = num(1, 4, Math.max(2, Math.floor(assets / 10_000) - 5)) * 10_000;
  // 2. Straight-line depreciation
  const life = [4, 5, 8, 10][v[2] % 4];
  const depPerYr = num(3, 5, 25) * 1_000;
  const residual = num(4, 2, 12) * 5_000;
  const costSL = residual + depPerYr * life;
  // 3. Reducing-balance depreciation
  const rbRate = [10, 20, 25][v[5] % 3];
  const nbv = num(6, 4, 24) * 10_000;
  const rbDep = Math.round(nbv * rbRate / 100);
  // 4. Break-even units
  const cm = num(7, 4, 15) * 10;
  const vc = num(8, 3, 12) * 10;
  const sp = vc + cm;
  const beUnits = num(9, 15, 65) * 10;
  const fixedCost = beUnits * cm;
  // 5. Net trade receivables
  const grossRec = num(10, 8, 25) * 10_000;
  const writeOff = num(11, 1, 5) * 5_000;
  const remRec = grossRec - writeOff;
  const allowPct = [2, 4, 5, 10][v[12] % 4];
  const netRec = Math.round(remRec * (100 - allowPct) / 100);
  // 6. Gross profit margin %
  const revUnit = num(13, 4, 16) * 50_000;
  const gpPct = [20, 25, 30, 35, 40, 45, 50][v[14] % 7];
  const cogs = Math.round(revUnit * (100 - gpPct) / 100);
  return [
    { tag: 'EXC 3430', prompt: `A firm has Total Assets of ${assets.toLocaleString('en-US')} and Total Liabilities of ${liab.toLocaleString('en-US')}. What is Owners' Equity?`, answer: assets - liab },
    { tag: 'EXC 3430', prompt: `A machine costs ${costSL.toLocaleString('en-US')}, has a residual value of ${residual.toLocaleString('en-US')}, and a ${life}-year life. What is annual straight-line depreciation?`, answer: depPerYr },
    { tag: 'EXC 3430', prompt: `A fleet has opening NBV of ${nbv.toLocaleString('en-US')} and depreciates at ${rbRate}% reducing-balance. What is this year's depreciation expense?`, answer: rbDep },
    { tag: 'EXC 3430', prompt: `Fixed costs are ${fixedCost.toLocaleString('en-US')}, selling price is ${sp} per unit, and variable cost is ${vc} per unit. What is break-even volume in units?`, answer: beUnits },
    { tag: 'EXC 3430', prompt: `Gross receivables are ${grossRec.toLocaleString('en-US')}. Write off ${writeOff.toLocaleString('en-US')} as bad debt, then set a ${allowPct}% closing allowance on the rest. What is Net Trade Receivables?`, answer: netRec },
    { tag: 'EXC 3430', prompt: `Sales revenue is ${revUnit.toLocaleString('en-US')} and Cost of Goods Sold is ${cogs.toLocaleString('en-US')}. What is Gross Profit Margin (%)?`, answer: gpPct },
  ];
}

function makeEconomicsDeck() {
  const v = randVals(16);
  const num = (i, min, range) => min + (v[i] % range);
  // 1. Real wage with CPI
  const cpis = [120, 125, 140, 150, 160];
  const cpi = cpis[v[0] % cpis.length];
  const realW = num(1, 20, 40) * 10;
  const nomW = Math.round(realW * cpi / 100);
  // 2. Profit-maximizing Q where P = A - bQ -> MR = A - 2bQ = MC
  const bSlope = num(2, 1, 5);
  const qStar = num(3, 5, 25);
  const mc = num(4, 4, 20) * 5;
  const aInt = mc + 2 * bSlope * qStar;
  // 3. Keynesian multiplier
  const mpcChoices = [
    { mpc: '0.5', mult: 2 },
    { mpc: '0.6', mult: 2.5 },
    { mpc: '0.75', mult: 4 },
    { mpc: '0.8', mult: 5 },
  ];
  const pickM = mpcChoices[v[5] % mpcChoices.length];
  const deltaG = num(6, 2, 18) * 20;
  const deltaY = Math.round(deltaG * pickM.mult);
  // 4. Unemployment rate %
  const lf = num(7, 4, 16) * 500;
  const uPct = [4, 5, 6, 8, 10, 12][v[8] % 6];
  const unemp = Math.round(lf * uPct / 100);
  // 5. Opportunity cost
  const maxX = num(9, 4, 12) * 10;
  const ratio = num(10, 2, 6);
  const maxY = maxX * ratio;
  // 6. Elasticity magnitude |%ΔQ / %ΔP|
  const dp = [5, 10, 20][v[11] % 3];
  const elast = [0.5, 1, 1.5, 2, 2.5, 3][v[12] % 6];
  const dq = Math.round(dp * elast);
  return [
    { tag: 'EXC 3420', prompt: `Nominal hourly wage is ${nomW} kr and the CPI price index is ${cpi} (base = 100). What is the real hourly wage? (kr)`, answer: realW },
    { tag: 'EXC 3420', prompt: `A monopolist faces P = ${aInt} − ${bSlope}Q (so MR = ${aInt} − ${2 * bSlope}Q) with constant MC = ${mc}. What is profit-maximizing output Q*?`, answer: qStar },
    { tag: 'EXC 3420', prompt: `With marginal propensity to consume MPC = ${pickM.mpc} (closed economy, no taxes), government spending rises by ${deltaG}m. What is the total rise in GDP ΔY? (m)`, answer: deltaY },
    { tag: 'EXC 3420', prompt: `A labour force has ${lf.toLocaleString('en-US')} people and ${unemp.toLocaleString('en-US')} are unemployed. What is the unemployment rate (%)?`, answer: uPct },
    { tag: 'EXC 3420', prompt: `A linear PPF can produce either ${maxX} units of Good X or ${maxY} units of Good Y. What is the opportunity cost of 1 unit of Good X (in units of Y)?`, answer: ratio },
    { tag: 'EXC 3420', prompt: `When price rises by ${dp}%, quantity demanded falls by ${dq}%. What is the price elasticity of demand (positive magnitude)?`, answer: elast },
  ];
}

export function makeDuel(subject = 'mixed') {
  const s = ALLOWED_SUBJECTS.has(subject) ? subject : 'mixed';
  if (s === 'math') return makeMathDeck();
  if (s === 'accounting') return makeAccountingDeck();
  if (s === 'economics') return makeEconomicsDeck();
  const acct = makeAccountingDeck();
  const econ = makeEconomicsDeck();
  const math = makeMathDeck();
  return [acct[0], econ[0], math[1], acct[3], econ[1], math[3]];
}

function parseRoomDeck(raw, mode = 'group') {
  const fallback = {
    v: 2,
    subject: 'mixed',
    durationMin: mode === 'duel' ? 5 : 50,
    isPublic: true,
    courseId: '',
    courseLabel: '',
    playlist: null,
    questions: [],
    rematchCode: '',
  };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { ...fallback, subject: 'math', durationMin: mode === 'duel' ? 5 : 25, isPublic: false, questions: parsed };
    }
    if (parsed && typeof parsed === 'object') {
      return {
        ...fallback,
        ...parsed,
        playlist: parsed.playlist && typeof parsed.playlist === 'object' ? parsed.playlist : null,
        questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      };
    }
  } catch {}
  return fallback;
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
    SELECT m.profile, m.ready, m.finished, m.completed, m.activity, p.nickname, p.avatar,
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
  const initialMeta = parseRoomDeck(room.deck, room.mode);
  const isStudyTogetherPod = room.mode === 'group' && (!initialMeta.isPublic || Boolean(initialMeta.playlist));
  if (!room.starts_at && !canUseCommunity && !isStudyTogetherPod) {
    return reply({ error: 'Open the lobby on a break or 18:00–22:30 Oslo time.' }, 423);
  }
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
  const meta = parseRoomDeck(current.deck, room.mode);
  const questions = meta.questions || [];
  const mine = !questions.length ? [] : (await db.prepare(`
    SELECT question, correct, submitted_value FROM room_answers WHERE code = ? AND profile = ? ORDER BY question
  `).bind(code, me.id).all()).results;
  return reply({
    code,
    mode: room.mode,
    host: room.owner === me.id,
    now,
    phase: ended ? 'finished' : current.starts_at ? 'running' : 'lobby',
    endsAt: current.ends_at,
    closedAt: current.closed_at || 0,
    subject: meta.subject || 'mixed',
    subjectLabel: SUBJECT_LABELS[meta.subject] || SUBJECT_LABELS.mixed,
    durationMin: meta.durationMin || (room.mode === 'duel' ? 5 : 50),
    isPublic: Boolean(meta.isPublic),
    courseId: meta.courseId || '',
    courseLabel: meta.courseLabel || '',
    playlist: meta.playlist || null,
    rematchCode: meta.rematchCode || '',
    players: players.map((player) => {
      const act = parseMemberActivity(player.activity || '');
      return {
        name: player.nickname,
        avatar: player.avatar || '',
        current: player.profile === me.id,
        ready: Boolean(player.ready),
        finished: Boolean(player.finished),
        rating: Number(player.rating || 1200),
        matches: Number(player.matches || 0),
        activity: act.activity,
        currentQid: act.currentQid,
        currentLabel: act.currentLabel,
        doneIds: act.doneIds,
        progress: room.mode === 'duel' ? player.submitted : player.completed,
        ...(ended && room.mode === 'duel'
          ? {
              score: player.score,
              ratingChange: result ? result.first_change * (result.first_player === player.profile ? 1 : -1) : null,
            }
          : {}),
      };
    }),
    questions: questions.map(({ prompt, answer, tag }) => (ended ? { prompt, answer, tag: tag || '' } : { prompt, tag: tag || '' })),
    answers: mine.map(({ question, correct, submitted_value }) =>
      ended ? { question, correct: Boolean(correct), submitted: submitted_value || '' } : { question }
    ),
  });
}

export async function handleRooms({ request, url, db, me, now, data, canUseCommunity, reply }) {
  const [route, code, action, extra] = url.pathname.slice(1).split('/');
  if (route !== 'rooms' || extra !== undefined) return reply({ error: 'Invalid room action.' }, 404);

  if (code === 'ratings' && !action && request.method === 'GET') {
    if (!canUseCommunity) return reply({ error: 'Ratings open during breaks or 18:00–22:30 Oslo time.' }, 423);
    const { results } = await db.prepare(`
      SELECT p.id, p.nickname, p.avatar, r.rating, r.matches
      FROM duel_ratings r JOIN profiles p ON p.id = r.profile
      WHERE r.matches > 0 ORDER BY r.rating DESC, r.matches DESC, p.nickname LIMIT 50
    `).all();
    const myRow = await db.prepare('SELECT rating, matches FROM duel_ratings WHERE profile = ?').bind(me.id).first();
    return reply({
      ratings: results.map((row) => ({
        nickname: row.nickname,
        avatar: row.avatar || '',
        rating: Number(row.rating || 1200),
        matches: Number(row.matches || 0),
        isMe: row.id === me.id,
      })),
      myRating: { rating: Number(myRow?.rating || 1200), matches: Number(myRow?.matches || 0) },
    });
  }

  if (code === 'open' && !action && request.method === 'GET') {
    if (!canUseCommunity) return reply({ error: 'Open rooms appear during breaks or 18:00–22:30 Oslo time.' }, 423);
    const { results } = await db.prepare(`
      SELECT r.code, r.mode, r.created_at, r.deck, r.owner,
        p.nickname AS host_name, p.avatar AS host_avatar,
        COALESCE(dr.rating, 1200) AS host_rating, COALESCE(dr.matches, 0) AS host_matches,
        (SELECT COUNT(*) FROM room_members m WHERE m.code = r.code) AS member_count,
        EXISTS(SELECT 1 FROM room_members m WHERE m.code = r.code AND m.profile = ?) AS joined
      FROM study_rooms r
      JOIN profiles p ON p.id = r.owner
      LEFT JOIN duel_ratings dr ON dr.profile = r.owner
      WHERE r.starts_at = 0 AND r.closed_at = 0 AND r.created_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM room_members other JOIN blocks b
            ON (b.owner = ? AND b.blocked = other.profile) OR (b.blocked = ? AND b.owner = other.profile)
          WHERE other.code = r.code
        )
      ORDER BY r.created_at DESC
      LIMIT 20
    `).bind(me.id, now - lobbyDuration, me.id, me.id).all();
    const open = [];
    for (const row of results) {
      const meta = parseRoomDeck(row.deck, row.mode);
      const maxPlayers = row.mode === 'duel' ? 2 : 8;
      if (!meta.isPublic) continue;
      if (row.member_count >= maxPlayers && !row.joined) continue;
      open.push({
        code: row.code,
        mode: row.mode,
        hostName: row.host_name,
        hostAvatar: row.host_avatar || '',
        hostRating: Number(row.host_rating || 1200),
        hostMatches: Number(row.host_matches || 0),
        subject: meta.subject || 'mixed',
        subjectLabel: SUBJECT_LABELS[meta.subject] || SUBJECT_LABELS.mixed,
        durationMin: meta.durationMin || (row.mode === 'duel' ? 5 : 50),
        courseId: meta.courseId || '',
        courseLabel: meta.courseLabel || '',
        players: Number(row.member_count || 1),
        maxPlayers,
        joined: Boolean(row.joined),
        createdAt: row.created_at,
      });
    }
    return reply({ rooms: open });
  }

  if (!code && request.method === 'GET') {
    const room = await db.prepare(activeRoom).bind(me.id, now - lobbyDuration, now).first();
    return reply({ code: room?.code || null });
  }

  if (!code && request.method === 'POST') {
    const candidate = typeof data.code === 'string' ? data.code.trim().toUpperCase() : '';
    if (candidate && !roomCode.test(candidate)) return reply({ error: 'Enter the eight-character room code.' }, 400);
    if (!candidate && !['group', 'duel'].includes(data.mode)) return reply({ error: 'Choose group or duel.' }, 400);

    // Allow creating or joining a private/playlist Study Together group pod anytime (studying together isn't break-only!)
    let allowAnytimeGroup = !candidate && data.mode === 'group' && (data.isPublic === false || Boolean(data.playlist));
    if (candidate) {
      const targetRow = await db.prepare('SELECT mode, deck FROM study_rooms WHERE code = ? AND closed_at = 0').bind(candidate).first();
      if (targetRow && targetRow.mode === 'group') {
        const tMeta = parseRoomDeck(targetRow.deck, 'group');
        if (!tMeta.isPublic || Boolean(tMeta.playlist)) allowAnytimeGroup = true;
      }
    }
    if (!canUseCommunity && !allowAnytimeGroup) {
      return reply({ error: 'Join or create a room during breaks or 18:00–22:30 Oslo time.' }, 423);
    }

    const existing = await db.prepare(activeRoom).bind(me.id, now - lobbyDuration, now).first();
    if (existing) return existing.code === candidate ? reply(existing) : reply({ error: 'Finish or leave your current room first.' }, 409);

    if (!candidate) {
      const generated = crypto.randomUUID().slice(0, 8).toUpperCase();
      const isDuel = data.mode === 'duel';
      const subject = ALLOWED_SUBJECTS.has(data.subject) ? data.subject : 'mixed';
      const rawDur = Number(data.durationMin);
      const durationMin = isDuel ? 5 : (ALLOWED_GROUP_MINS.has(rawDur) ? rawDur : 120);
      const isPublic = data.isPublic !== false;
      const courseId = typeof data.courseId === 'string' ? data.courseId.trim().slice(0, 32) : '';
      const courseLabel = typeof data.courseLabel === 'string' ? data.courseLabel.trim().slice(0, 60) : '';
      const playlist = isDuel ? null : cleanPlaylist(data.playlist, courseId, courseLabel, me.nickname, now);
      const autoStart = !isDuel && Boolean(data.autoStart);
      const startsAt = autoStart ? now : 0;
      const endsAt = autoStart ? now + durationMin * 60_000 : 0;
      const deckMeta = JSON.stringify({
        v: 2,
        subject,
        durationMin,
        isPublic,
        courseId: playlist?.courseId || courseId,
        courseLabel: playlist?.courseLabel || courseLabel,
        playlist,
        questions: [],
        rematchCode: '',
      });
      const result = await db.prepare(`
        INSERT OR IGNORE INTO study_rooms(code, owner, mode, created_at, starts_at, ends_at, deck)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (${activeRoom})
      `).bind(generated, me.id, data.mode, now, startsAt, endsAt, deckMeta, me.id, now - lobbyDuration, now).run();
      return result.meta.changes ? reply({ code: generated }, 201) : reply({ error: 'Try creating the room again.' }, 409);
    }

    // Group Study Together pods allow joining both in lobby AND while already running so partners can start whenever they want!
    const result = await db.prepare(`
      INSERT OR IGNORE INTO room_members(code, profile)
      SELECT r.code, ? FROM study_rooms r WHERE r.code = ? AND r.closed_at = 0
        AND (
          (r.starts_at = 0 AND r.created_at > ?)
          OR (r.mode = 'group' AND r.starts_at > 0 AND r.ends_at > ?)
        )
        AND (SELECT COUNT(*) FROM room_members WHERE code = r.code) < CASE WHEN r.mode = 'duel' THEN 2 ELSE 8 END
        AND NOT EXISTS (${activeRoom})
        AND NOT EXISTS (
          SELECT 1 FROM room_members other JOIN blocks b
            ON (b.owner = ? AND b.blocked = other.profile) OR (b.blocked = ? AND b.owner = other.profile)
          WHERE other.code = r.code
        )
    `).bind(me.id, candidate, now - lobbyDuration, now, me.id, now - lobbyDuration, now, me.id, me.id).run();
    return result.meta.changes ? reply({ code: candidate }, 201) : reply({ error: 'This room is full, started, or no longer open.' }, 409);
  }

  if (!roomCode.test(code || '')) return reply({ error: 'Invalid room code.' }, 400);
  if (!action && request.method === 'GET') return roomState(db, code, me, now, canUseCommunity, reply);
  if (request.method !== 'POST') return reply({ error: 'Invalid room action.' }, 404);

  const room = await db.prepare(`
    SELECT r.*, m.finished FROM study_rooms r JOIN room_members m ON m.code = r.code WHERE r.code = ? AND m.profile = ?
  `).bind(code, me.id).first();
  if (!room) return reply({ error: 'You are not in this room.' }, 404);

  // Collaborative shared playlist update inside any active Study Together group pod (lobby OR running)
  if (action === 'playlist' && room.mode === 'group' && !room.closed_at) {
    const meta = parseRoomDeck(room.deck, room.mode);
    const nextPlaylist = cleanPlaylist(data.playlist ?? data, meta.courseId, meta.courseLabel, me.nickname, now);
    if (!nextPlaylist) return reply({ error: 'Select at least one exercise or course for the playlist.' }, 400);
    const nextDeck = JSON.stringify({
      ...meta,
      courseId: nextPlaylist.courseId || meta.courseId || '',
      courseLabel: nextPlaylist.courseLabel || meta.courseLabel || '',
      playlist: nextPlaylist,
    });
    await db.prepare('UPDATE study_rooms SET deck = ? WHERE code = ? AND closed_at = 0').bind(nextDeck, code).run();
    return roomState(db, code, me, now, canUseCommunity, reply);
  }

  if (!room.starts_at) {
    const lobbyMeta = parseRoomDeck(room.deck, room.mode);
    const isStudyTogetherPod = room.mode === 'group' && (!lobbyMeta.isPublic || Boolean(lobbyMeta.playlist));
    if ((!canUseCommunity && !isStudyTogetherPod) || room.created_at <= now - lobbyDuration) {
      return reply({ error: 'This lobby is unavailable.' }, 423);
    }
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
      const meta = parseRoomDeck(room.deck, room.mode);
      const durationMs = duel ? duelDuration : (ALLOWED_GROUP_MINS.has(meta.durationMin) ? meta.durationMin : 120) * 60_000;
      const nextDeck = JSON.stringify({
        ...meta,
        questions: duel ? makeDuel(meta.subject) : [],
      });
      if (duel) {
        const result = await db.prepare(`
          UPDATE study_rooms SET starts_at = ?, ends_at = ?, deck = ?
          WHERE code = ? AND starts_at = 0 AND (SELECT COUNT(*) FROM room_members WHERE code = ?) >= 2
            AND NOT EXISTS (SELECT 1 FROM room_members WHERE code = ? AND ready = 0)
        `).bind(now, now + durationMs, nextDeck, code, code, code).run();
        return result.meta.changes ? reply({ ok: true }) : reply({ error: 'Everyone must be ready, with at least two members.' }, 409);
      }
      // Study Together pod can start right away even if partner joins shortly after
      const result = await db.prepare(`
        UPDATE study_rooms SET starts_at = ?, ends_at = ?, deck = ?
        WHERE code = ? AND starts_at = 0
      `).bind(now, now + durationMs, nextDeck, code).run();
      return result.meta.changes ? reply({ ok: true }) : reply({ error: 'Could not start study pod.' }, 409);
    }
    return reply({ error: 'This action requires a running room.' }, 409);
  }

  if (action === 'leave' && room.mode === 'group') {
    await db.prepare('UPDATE room_members SET finished = 1 WHERE code = ? AND profile = ?').bind(code, me.id).run();
    return reply({ ok: true });
  }

  if (action === 'finish') {
    await db.prepare('UPDATE room_members SET finished = 1 WHERE code = ? AND profile = ?').bind(code, me.id).run();
    return roomState(db, code, me, now, canUseCommunity, reply);
  }

  if (action === 'rematch') {
    if (!room.closed_at && room.ends_at > now) return reply({ error: 'Finish this round before starting a rematch.' }, 409);
    const recentFinish = Boolean(room.closed_at && room.closed_at >= now - rematchWindow);
    if (!canUseCommunity && !recentFinish) return reply({ error: 'Rematch opens during breaks or 18:00–22:30 Oslo time.' }, 423);
    const meta = parseRoomDeck(room.deck, room.mode);
    // If opponent already opened a rematch lobby, join it directly!
    if (meta.rematchCode && roomCode.test(meta.rematchCode)) {
      const openRematch = await db.prepare(`
        SELECT code FROM study_rooms WHERE code = ? AND starts_at = 0 AND closed_at = 0 AND created_at > ?
      `).bind(meta.rematchCode, now - lobbyDuration).first();
      if (openRematch) {
        await db.prepare(`
          INSERT OR IGNORE INTO room_members(code, profile)
          SELECT r.code, ? FROM study_rooms r WHERE r.code = ? AND r.starts_at = 0
            AND (SELECT COUNT(*) FROM room_members WHERE code = r.code) < CASE WHEN r.mode = 'duel' THEN 2 ELSE 8 END
        `).bind(me.id, meta.rematchCode).run();
        return reply({ code: meta.rematchCode }, 200);
      }
    }
    const existing = await db.prepare(activeRoom).bind(me.id, now - lobbyDuration, now).first();
    if (existing) return reply({ code: existing.code }, 200);
    const nextCode = crypto.randomUUID().slice(0, 8).toUpperCase();
    const nextDeck = JSON.stringify({
      v: 2,
      subject: meta.subject || 'mixed',
      durationMin: meta.durationMin || (room.mode === 'duel' ? 5 : 50),
      isPublic: false,
      courseId: meta.courseId || '',
      courseLabel: meta.courseLabel || '',
      questions: [],
      rematchCode: '',
    });
    await db.prepare(`
      INSERT OR IGNORE INTO study_rooms(code, owner, mode, created_at, deck) VALUES (?, ?, ?, ?, ?)
    `).bind(nextCode, me.id, room.mode, now, nextDeck).run();
    const updatedOldDeck = JSON.stringify({ ...meta, rematchCode: nextCode });
    await db.prepare('UPDATE study_rooms SET deck = ? WHERE code = ?').bind(updatedOldDeck, code).run();
    return reply({ code: nextCode }, 201);
  }

  if (room.closed_at || room.ends_at <= now || room.finished) return reply({ error: 'Your round is finished.' }, 409);

  if (action === 'progress' && room.mode === 'group') {
    if (!Number.isInteger(data.completed) || data.completed < 0 || data.completed > 500) return reply({ error: 'Invalid study total.' }, 400);
    const activityTxt = typeof data.activity === 'string' ? data.activity.trim().slice(0, 64) : '';
    const currentQid = typeof data.currentQid === 'string' ? data.currentQid.trim().slice(0, 80) : '';
    const currentLabel = typeof data.currentLabel === 'string' ? data.currentLabel.trim().slice(0, 48) : '';
    const doneIds = Array.isArray(data.doneIds)
      ? [...new Set(data.doneIds.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 80)))].slice(0, 60)
      : null;

    const existingRow = await db.prepare('SELECT activity FROM room_members WHERE code = ? AND profile = ?').bind(code, me.id).first();
    const prevAct = parseMemberActivity(existingRow?.activity || '');
    const mergedDone = doneIds ? [...new Set([...prevAct.doneIds, ...doneIds])].slice(0, 60) : prevAct.doneIds;
    const hasStructured = Boolean(currentQid || currentLabel || mergedDone.length);
    const storedActivity = hasStructured
      ? JSON.stringify({
          a: activityTxt || prevAct.activity || '',
          q: currentQid || prevAct.currentQid || '',
          l: currentLabel || prevAct.currentLabel || '',
          d: mergedDone,
        })
      : (activityTxt || prevAct.activity || '');

    if (storedActivity) {
      await db.prepare('UPDATE room_members SET completed = MAX(completed, ?), activity = ? WHERE code = ? AND profile = ? AND finished = 0')
        .bind(data.completed, storedActivity, code, me.id).run();
    } else {
      await db.prepare('UPDATE room_members SET completed = MAX(completed, ?) WHERE code = ? AND profile = ? AND finished = 0')
        .bind(data.completed, code, me.id).run();
    }
    return reply({ ok: true });
  }

  if (action === 'answer' && room.mode === 'duel') {
    const meta = parseRoomDeck(room.deck, room.mode);
    const deck = meta.questions || [];
    const question = data.question;
    const answer = typeof data.answer === 'string' ? data.answer.trim().replace(/\s+/g, '').replace(',', '.') : '';
    if (!Number.isInteger(question) || !deck[question] || !/^-?\d{1,12}(?:\.\d{1,8})?$/.test(answer)) {
      return reply({ error: 'Enter a numeric answer.' }, 400);
    }
    const correct = Number(Math.abs(Number(answer) - Number(deck[question].answer)) < 0.02);
    const result = await db.prepare(`
      INSERT OR IGNORE INTO room_answers(code, profile, question, correct, submitted_value)
      SELECT ?, ?, ?, ?, ? FROM room_members m JOIN study_rooms r ON r.code = m.code
      WHERE m.code = ? AND m.profile = ? AND m.finished = 0 AND r.closed_at = 0 AND r.ends_at > ?
    `).bind(code, me.id, question, correct, answer, code, me.id, now).run();
    return result.meta.changes ? reply({ ok: true }) : reply({ error: 'This answer was already submitted or time ran out.' }, 409);
  }
  return reply({ error: 'Invalid room action.' }, 404);
}
