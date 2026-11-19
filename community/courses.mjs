const canvasId = /^[1-9][0-9]{0,19}$/;
const codeFormat = /^[A-Z]{2,6}\s?\d{3,6}$/;

export function courseMetadata(item) {
  if (!item || !canvasId.test(item.id || '')) return null;
  const name = typeof item.name === 'string' ? item.name.trim().replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 160) : '';
  const code = String(item.code || '').trim().toUpperCase();
  if (!name) return null;
  return { id: String(item.id), name, code: codeFormat.test(code) ? code.replace(/\s/g, '') : '' };
}

export async function handleCourses({ path, request, db, data, me, isAdmin, now, reply }) {
  if (path === '/courses' && request.method === 'GET') {
    const { results } = await db.prepare(`
      SELECT code, title, canvas_id AS canvasId FROM community_courses WHERE status = 'approved'
      ORDER BY code, title LIMIT 300
    `).all();
    return reply({ courses: results });
  }
  if (path === '/courses/propose' && request.method === 'POST' && me) {
    if (!Array.isArray(data.courses) || data.courses.length > 60) return reply({ error: 'Choose up to 60 course suggestions.' }, 400);
    const seen = new Map();
    for (const item of data.courses) {
      const course = courseMetadata(item);
      if (course) seen.set(course.code || 'BI-' + course.id, course);
    }
    if (seen.size) {
      await db.batch([...seen].map(([key, course]) => db.prepare(`
        INSERT INTO community_courses(course_key, code, title, canvas_id, status, last_seen_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(course_key) DO UPDATE SET last_seen_at = excluded.last_seen_at
      `).bind(key, course.code, course.name, course.id, now)));
    }
    return reply({ accepted: seen.size });
  }
  if (path === '/admin/courses' && isAdmin) {
    if (request.method === 'GET') {
      const { results } = await db.prepare(`
        SELECT course_key AS id, code, title, canvas_id AS canvasId, status, last_seen_at AS lastSeenAt
        FROM community_courses ORDER BY status != 'pending', last_seen_at DESC LIMIT 200
      `).all();
      return reply({ courses: results });
    }
    if (request.method === 'POST' && ['approved', 'rejected', 'pending'].includes(data.status) &&
        typeof data.id === 'string' && data.id.length <= 28) {
      await db.prepare('UPDATE community_courses SET status = ? WHERE course_key = ?')
        .bind(data.status, data.id).run();
      return reply({ ok: true });
    }
  }
  return reply({ error: 'Course action unavailable.' }, 403);
}
