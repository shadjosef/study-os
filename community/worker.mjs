const encoder = new TextEncoder();
const hex = (bytes) => [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
const digest = async (value) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
const tokenPattern = /^soc1_[0-9a-f]{64}$/;
const proofPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[0-9a-f-]{36}$/;
const maxInputBytes = 8192;

function equalProof(expected, supplied) {
  if (!proofPattern.test(expected || '') || !proofPattern.test(supplied || '')) return false;
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return different === 0;
}

async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxInputBytes) {
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

    const path = new URL(request.url).pathname;
    const db = env.DB;
    let data = {};
    if (request.method === 'POST') {
      try { data = await readJson(request); }
      catch { return reply({ error: 'Invalid request.' }, 400); }
    }

    if (path === '/join' && request.method === 'POST') {
      if (!equalProof(env.JOIN_PROOF, data.proof)) return reply({ error: 'Unlock the full library to join.' }, 403);
      const nickname = typeof data.nickname === 'string' ? data.nickname.trim().normalize('NFC') : '';
      if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,23}$/u.test(nickname)) {
        return reply({ error: 'Choose a nickname of 2–24 letters, numbers or spaces.' }, 400);
      }
      const token = 'soc1_' + hex(crypto.getRandomValues(new Uint8Array(32)));
      const result = await db.prepare('INSERT OR IGNORE INTO profiles(id, token_hash, nickname) VALUES (?, ?, ?)')
        .bind(crypto.randomUUID(), await digest(token), nickname).run();
      if (!result.meta.changes) return reply({ error: 'That nickname is taken.' }, 409);
      return reply({ token }, 201);
    }

    const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (!tokenPattern.test(token)) return reply({ error: 'Enter your profile key.' }, 401);
    const me = await db.prepare(`
      SELECT id, nickname, share_stats, study_minutes, completed, attempts, accuracy
      FROM profiles WHERE token_hash = ?
    `).bind(await digest(token)).first();
    if (!me) return reply({ error: 'That profile key is invalid.' }, 401);

    if (path === '/dashboard' && request.method === 'GET') {
      const ranks = await db.prepare(`
        SELECT nickname, study_minutes, completed, attempts, accuracy FROM profiles
        WHERE share_stats = 1 ORDER BY completed DESC, study_minutes DESC, nickname LIMIT 100
      `).all();
      const contacts = await db.prepare(`
        SELECT id, nickname FROM profiles WHERE id <> ?
        AND NOT EXISTS (SELECT 1 FROM blocks WHERE (owner = ? AND blocked = profiles.id)
          OR (blocked = ? AND owner = profiles.id)) ORDER BY nickname LIMIT 200
      `).bind(me.id, me.id, me.id).all();
      const messages = await db.prepare(`
        SELECT m.id, m.sender, m.recipient, a.nickname AS senderName, b.nickname AS recipientName,
          m.message, m.created_at AS createdAt
        FROM messages m JOIN profiles a ON a.id = m.sender JOIN profiles b ON b.id = m.recipient
        WHERE (m.sender = ? OR m.recipient = ?)
          AND NOT EXISTS (SELECT 1 FROM blocks WHERE owner = ? AND blocked IN (m.sender, m.recipient))
        ORDER BY m.created_at DESC LIMIT 100
      `).bind(me.id, me.id, me.id).all();
      const blocked = await db.prepare(`
        SELECT p.id, p.nickname FROM blocks b JOIN profiles p ON p.id = b.blocked WHERE b.owner = ?
      `).bind(me.id).all();
      return reply({ me, ranks: ranks.results, contacts: contacts.results, messages: messages.results, blocked: blocked.results });
    }

    if (path === '/stats' && request.method === 'POST') {
      if (data.share === false) {
        await db.prepare('UPDATE profiles SET share_stats = 0 WHERE id = ?').bind(me.id).run();
        return reply({ ok: true });
      }
      if (data.share !== true || !boundedInt(data.minutes, 600_000) || !boundedInt(data.completed, 100_000)
        || !boundedInt(data.attempts, 1_000_000) || !boundedInt(data.accuracy, 100)) {
        return reply({ error: 'Invalid study totals.' }, 400);
      }
      await db.prepare(`
        UPDATE profiles SET share_stats = 1, study_minutes = ?, completed = ?, attempts = ?, accuracy = ? WHERE id = ?
      `).bind(data.minutes, data.completed, data.attempts, data.accuracy, me.id).run();
      return reply({ ok: true });
    }

    if (path === '/message' && request.method === 'POST') {
      const message = typeof data.message === 'string' ? data.message.trim() : '';
      if (!idPattern.test(data.recipient || '') || data.recipient === me.id || !message || message.length > 1500) {
        return reply({ error: 'Choose a recipient and write a message of up to 1,500 characters.' }, 400);
      }
      const now = Date.now();
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

    return reply({ error: 'Unknown action.' }, 404);
  },
};
