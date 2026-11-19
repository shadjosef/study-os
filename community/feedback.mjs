// User Feedback submission & Admin Inbox (stored in Cloudflare D1)

const ALLOWED_CATEGORIES = new Set(['idea', 'bug', 'course', 'other']);
const ID_RE = /^[0-9a-f-]{36}$/;

function cleanText(raw, maxLen) {
  return String(raw || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export async function handleFeedback({ request, path, db, me, isAdmin, now, data, reply }) {
  if (path === '/feedback' && request.method === 'GET') {
    if (isAdmin) {
      const { results } = await db.prepare(`
        SELECT id, profile_id AS profileId, nickname, category, message,
               page_context AS pageContext, status, created_at AS createdAt
        FROM user_feedback
        ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 80
      `).all();
      return reply({ isAdmin: true, items: results || [] });
    }
    const { results } = await db.prepare(`
      SELECT id, category, message, status, created_at AS createdAt
      FROM user_feedback
      WHERE profile_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).bind(me.id).all();
    return reply({ isAdmin: false, items: results || [] });
  }

  if (path === '/feedback' && request.method === 'POST') {
    const category = ALLOWED_CATEGORIES.has(data?.category) ? data.category : 'idea';
    const message = cleanText(data?.message, 1500);
    const pageContext = cleanText(data?.page, 80);
    if (message.length < 6) {
      return reply({ error: 'Write at least a few words so we can act on your feedback.' }, 400);
    }

    // Gentle spam guard: max 6 feedback notes per hour per non-admin user
    if (!isAdmin) {
      const recent = await db.prepare(
        'SELECT COUNT(*) AS n FROM user_feedback WHERE profile_id = ? AND created_at > ?'
      ).bind(me.id, now - 3_600_000).first();
      if (Number(recent?.n || 0) >= 6) {
        return reply({ error: 'You have sent several feedback notes this hour. Try again a little later.' }, 429);
      }
    }

    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO user_feedback(id, profile_id, nickname, category, message, page_context, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
    `).bind(id, me.id, me.nickname || 'Student', category, message, pageContext, now).run();

    return reply({
      ok: true,
      item: { id, category, message, status: 'open', createdAt: now },
    }, 201);
  }

  if (path === '/admin/feedback' && request.method === 'POST') {
    if (!isAdmin) return reply({ error: 'Admin access required.' }, 403);
    const id = String(data?.id || '').trim();
    const action = String(data?.action || '').trim();
    if (!ID_RE.test(id)) return reply({ error: 'Invalid feedback id.' }, 400);

    if (action === 'delete') {
      await db.prepare('DELETE FROM user_feedback WHERE id = ?').bind(id).run();
      return reply({ ok: true });
    }
    if (action === 'done' || action === 'open') {
      await db.prepare('UPDATE user_feedback SET status = ? WHERE id = ?').bind(action, id).run();
      return reply({ ok: true });
    }
    return reply({ error: 'Unknown feedback action.' }, 400);
  }

  return reply({ error: 'Method not allowed.' }, 405);
}
