// User Feedback & In-Exercise Bug Reports (stored in Cloudflare D1)

const ALLOWED_CATEGORIES = new Set(['idea', 'bug', 'course', 'other']);
const ID_RE = /^[0-9a-f-]{36}$/;
const SCREENSHOT_RE = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]{16,420000}$/;

function cleanText(raw, maxLen) {
  return String(raw || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function cleanMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const picked = {};
  const fields = [
    ['courseId', 64],
    ['courseCode', 32],
    ['questionId', 120],
    ['questionTitle', 120],
    ['kind', 24],
    ['topicId', 32],
    ['mode', 24],
    ['url', 160],
    ['viewport', 24],
    ['theme', 16],
  ];
  for (const [k, max] of fields) {
    if (raw[k] != null && String(raw[k]).trim()) {
      picked[k] = cleanText(raw[k], max);
    }
  }
  if (!Object.keys(picked).length) return '';
  const serialized = JSON.stringify(picked);
  return serialized.length <= 1200 ? serialized : '';
}

export async function handleFeedback({ request, path, db, me, isAdmin, now, data, reply }) {
  if (path === '/feedback' && request.method === 'GET') {
    if (isAdmin) {
      const { results } = await db.prepare(`
        SELECT id, profile_id AS profileId, nickname, category, message,
               page_context AS pageContext, screenshot_data AS screenshotData,
               meta_json AS metaJson, status, created_at AS createdAt
        FROM user_feedback
        ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 80
      `).all();
      const items = (results || []).map((row) => {
        let meta = null;
        if (row.metaJson) {
          try { meta = JSON.parse(row.metaJson); } catch {}
        }
        return {
          id: row.id,
          profileId: row.profileId,
          nickname: row.nickname,
          category: row.category,
          message: row.message,
          pageContext: row.pageContext || '',
          screenshotData: row.screenshotData || '',
          meta,
          status: row.status,
          createdAt: row.createdAt,
        };
      });
      return reply({ isAdmin: true, items });
    }
    const { results } = await db.prepare(`
      SELECT id, category, message, page_context AS pageContext,
             CASE WHEN screenshot_data != '' THEN 1 ELSE 0 END AS hasScreenshot,
             status, created_at AS createdAt
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
    const pageContext = cleanText(data?.page, 160);
    const rawShot = typeof data?.screenshot === 'string' ? data.screenshot.trim() : '';
    const screenshot = rawShot && SCREENSHOT_RE.test(rawShot) ? rawShot : '';
    if (rawShot && !screenshot) {
      return reply({ error: 'Screenshot must be a PNG, JPEG, or WebP image under 300 KB.' }, 400);
    }
    const metaJson = cleanMeta(data?.meta);
    if (message.length < (screenshot ? 2 : 4)) {
      return reply({ error: 'Write a short note so we know what to fix.' }, 400);
    }

    // Gentle spam guard: max 10 reports per hour per non-admin user
    if (!isAdmin) {
      const recent = await db.prepare(
        'SELECT COUNT(*) AS n FROM user_feedback WHERE profile_id = ? AND created_at > ?'
      ).bind(me.id, now - 3_600_000).first();
      if (Number(recent?.n || 0) >= 10) {
        return reply({ error: 'You have sent several reports this hour. Try again a little later.' }, 429);
      }
    }

    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO user_feedback(id, profile_id, nickname, category, message, page_context, screenshot_data, meta_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `).bind(id, me.id, me.nickname || 'Student', category, message, pageContext, screenshot, metaJson, now).run();

    return reply({
      ok: true,
      item: { id, category, message, hasScreenshot: Boolean(screenshot), status: 'open', createdAt: now },
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
