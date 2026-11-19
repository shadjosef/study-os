// Collaborative, deduplicated Community Course Catalog + Personal Canvas/Ed Sync.
// Copyright safety: stores ONLY course codes, titles, Canvas/Ed IDs, and module/syllabus
// topic headings (never copyrighted PDFs, slides, or private student posts).
// Personal assignment deadlines stay strictly private inside the student's own study_backups.

const numericId = /^[1-9][0-9]{0,19}$/;
const codeExtract = /\b([A-Z]{2,6})\s*[-_]?\s*(\d{3,6})(?!\d)\b/i;
const validEdHosts = new Set(['edstem.org', 'eu.edstem.org', 'us.edstem.org', 'au.edstem.org']);

function cleanText(value, maxLen = 160) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').slice(0, maxLen);
}

export function normalizeCourseCode(rawCode, rawName = '') {
  for (const candidate of [rawCode, rawName]) {
    if (typeof candidate !== 'string') continue;
    const match = candidate.match(codeExtract);
    if (match) return `${match[1].toUpperCase()}${match[2]}`;
  }
  return '';
}

function cleanTopics(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw.slice(0, 40)) {
    const t = cleanText(typeof entry === 'string' ? entry : entry?.name, 100);
    if (!t || t.length < 2) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 35) break;
  }
  return out;
}

function mergeTopics(existingJson, incomingList) {
  let existing = [];
  try {
    const parsed = JSON.parse(existingJson || '[]');
    if (Array.isArray(parsed)) existing = parsed;
  } catch {}
  return cleanTopics([...existing, ...incomingList]);
}

export function courseMetadata(item) {
  if (!item || !numericId.test(String(item.id || ''))) return null;
  const name = cleanText(item.name || item.title, 160);
  if (!name) return null;
  const code = normalizeCourseCode(item.code || '', name);
  return {
    id: String(item.id),
    name,
    code,
    topics: cleanTopics(item.topics || item.modules || []),
  };
}

function edCourseMetadata(item) {
  if (!item || !numericId.test(String(item.id || ''))) return null;
  const name = cleanText(item.name || item.title, 160);
  if (!name) return null;
  const code = normalizeCourseCode(item.code || '', name);
  const rawHost = typeof item.host === 'string' ? item.host.trim().toLowerCase() : 'eu.edstem.org';
  const host = validEdHosts.has(rawHost) ? rawHost : 'eu.edstem.org';
  return {
    id: String(item.id),
    name,
    code,
    host,
    topics: cleanTopics(item.topics || item.categories || []),
  };
}

async function mergePersonalCanvasBackup(db, profileId, courses, syncedAtIso, now) {
  let left = 1200;
  const cleanCourses = [];
  let deadlineCount = 0;
  for (const item of courses.slice(0, 100)) {
    const meta = courseMetadata(item);
    if (!meta) continue;
    const url = 'https://canvas.bi.no/courses/' + meta.id;
    const assignments = (Array.isArray(item.assignments) ? item.assignments : [])
      .filter((t) => t && typeof t === 'object' && numericId.test(String(t.id || '')) && typeof t.name === 'string' && Number.isFinite(Date.parse(t.dueAt)))
      .slice(0, left)
      .map((t) => ({
        id: String(t.id),
        name: cleanText(t.name, 200),
        dueAt: new Date(t.dueAt).toISOString(),
        url: `${url}/assignments/${t.id}`,
      }));
    left -= assignments.length;
    deadlineCount += assignments.length;
    cleanCourses.push({ id: meta.id, name: meta.name, code: meta.code, url, assignments });
  }
  const snapshot = { syncedAt: syncedAtIso, courses: cleanCourses };
  const row = await db.prepare('SELECT payload, record_count, attempt_count, session_count FROM study_backups WHERE profile_id = ?')
    .bind(profileId).first();
  if (row) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { payload = null; }
    if (!payload || typeof payload !== 'object') {
      payload = { format: 'study-os-backup-v1', syncedAt: syncedAtIso, progress: { records: {} }, attempts: [], sessions: [], customSchedule: { enabled: false, prefs: {}, blocks: [] } };
    }
    payload.canvasSnapshot = snapshot;
    await db.prepare('UPDATE study_backups SET payload = ?, updated_at = ? WHERE profile_id = ?')
      .bind(JSON.stringify(payload), now, profileId).run();
  } else {
    const payload = {
      format: 'study-os-backup-v1',
      syncedAt: syncedAtIso,
      progress: { records: {} },
      attempts: [],
      sessions: [],
      customSchedule: { enabled: false, prefs: {}, blocks: [] },
      canvasSnapshot: snapshot,
    };
    await db.prepare(`
      INSERT INTO study_backups(profile_id, payload, updated_at, record_count, attempt_count, session_count)
      VALUES (?, ?, ?, 0, 0, 0)
    `).bind(profileId, JSON.stringify(payload), now).run();
  }
  return { syncedCourses: cleanCourses.length, deadlineCount };
}

async function upsertCommunityCourses(db, profileId, entries, source, now) {
  let createdCount = 0;
  let updatedCount = 0;

  for (const [key, course] of entries) {
    const existing = await db.prepare(`
      SELECT course_key, code, title, canvas_id, status, topics_json, ed_course_id, ed_host
      FROM community_courses WHERE course_key = ?
    `).bind(key).first();

    if (!existing) {
      const topicsJson = JSON.stringify(course.topics || []);
      await db.prepare(`
        INSERT INTO community_courses(
          course_key, code, title, canvas_id, status, last_seen_at,
          topics_json, ed_course_id, ed_host, contributor_count, sync_count, verified
        ) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, 1, 1, 0)
      `).bind(
        key,
        course.code || '',
        course.name,
        source === 'canvas' ? course.id : '',
        now,
        topicsJson,
        source === 'ed' ? course.id : '',
        source === 'ed' ? (course.host || 'eu.edstem.org') : ''
      ).run();
      await db.prepare(`
        INSERT INTO community_course_contributors(course_key, profile_id, synced_at)
        VALUES (?, ?, ?)
        ON CONFLICT(course_key, profile_id) DO UPDATE SET synced_at = excluded.synced_at
      `).bind(key, profileId, now).run();
      createdCount += 1;
      continue;
    }

    // Existing course found — contribute directly without creating a duplicate!
    // Never resurrect an admin-rejected course.
    const nextTopics = JSON.stringify(mergeTopics(existing.topics_json, course.topics || []));
    const nextTitle = course.name.length >= (existing.title || '').length && existing.status !== 'rejected'
      ? course.name
      : existing.title;
    const nextCanvasId = source === 'canvas' ? course.id : (existing.canvas_id || '');
    const nextEdId = source === 'ed' ? course.id : (existing.ed_course_id || '');
    const nextEdHost = source === 'ed' ? (course.host || 'eu.edstem.org') : (existing.ed_host || '');

    await db.prepare(`
      INSERT INTO community_course_contributors(course_key, profile_id, synced_at)
      VALUES (?, ?, ?)
      ON CONFLICT(course_key, profile_id) DO UPDATE SET synced_at = excluded.synced_at
    `).bind(key, profileId, now).run();

    const cntRow = await db.prepare('SELECT COUNT(*) AS n FROM community_course_contributors WHERE course_key = ?')
      .bind(key).first();
    const contributorCount = Math.max(1, Number(cntRow?.n || 1));

    await db.prepare(`
      UPDATE community_courses SET
        code = CASE WHEN ? <> '' THEN ? ELSE code END,
        title = ?,
        canvas_id = CASE WHEN ? <> '' THEN ? ELSE canvas_id END,
        ed_course_id = CASE WHEN ? <> '' THEN ? ELSE ed_course_id END,
        ed_host = CASE WHEN ? <> '' THEN ? ELSE ed_host END,
        topics_json = ?,
        contributor_count = ?,
        sync_count = sync_count + 1,
        last_seen_at = ?
      WHERE course_key = ?
    `).bind(
      course.code || '', course.code || '',
      nextTitle,
      nextCanvasId, nextCanvasId,
      nextEdId, nextEdId,
      nextEdHost, nextEdHost,
      nextTopics,
      contributorCount,
      now,
      key
    ).run();
    updatedCount += 1;
  }

  return { createdCount, updatedCount };
}

export async function handleCourses({ path, request, db, data, me, isAdmin, now, reply }) {
  if (path === '/courses' && request.method === 'GET') {
    const { results } = await db.prepare(`
      SELECT course_key AS id, code, title, canvas_id AS canvasId,
        ed_course_id AS edCourseId, ed_host AS edHost,
        topics_json AS topicsJson, contributor_count AS contributorCount,
        sync_count AS syncCount, verified, last_seen_at AS lastSeenAt
      FROM community_courses
      WHERE status = 'approved'
      ORDER BY verified DESC, contributor_count DESC, code ASC, title ASC
      LIMIT 300
    `).all();
    const courses = (results || []).map((r) => {
      let topics = [];
      try { topics = JSON.parse(r.topicsJson || '[]'); } catch {}
      return {
        id: r.id,
        code: r.code || '',
        title: r.title,
        canvasId: r.canvasId || '',
        edCourseId: r.edCourseId || '',
        edHost: r.edHost || '',
        topics: Array.isArray(topics) ? topics : [],
        contributorCount: Number(r.contributorCount || 1),
        syncCount: Number(r.syncCount || 1),
        verified: Boolean(r.verified),
        lastSeenAt: Number(r.lastSeenAt || 0),
      };
    });
    return reply({ courses });
  }

  // Unified one-click browser extension sync (Canvas or Ed Discussion)
  // Default: public course catalog sharing ON, personal deadlines private.
  if (path === '/courses/sync' && request.method === 'POST' && me) {
    const source = data.source === 'ed' ? 'ed' : 'canvas';
    const sharePublic = data.sharePublic !== false; // default TRUE!
    if (!Array.isArray(data.courses) || data.courses.length > 80) {
      return reply({ error: 'Send up to 80 courses per sync.' }, 400);
    }
    const syncedAtIso = Number.isFinite(Date.parse(data.capturedAt))
      ? new Date(data.capturedAt).toISOString()
      : new Date(now).toISOString();

    let personal = { syncedCourses: 0, deadlineCount: 0 };
    if (source === 'canvas') {
      personal = await mergePersonalCanvasBackup(db, me.id, data.courses, syncedAtIso, now);
    }

    const deduped = new Map();
    for (const item of data.courses) {
      const parsed = source === 'ed' ? edCourseMetadata(item) : courseMetadata(item);
      if (!parsed) continue;
      const key = parsed.code || (source === 'ed' ? `ED-${parsed.id}` : `BI-${parsed.id}`);
      const prev = deduped.get(key);
      if (prev) {
        prev.topics = cleanTopics([...prev.topics, ...parsed.topics]);
      } else {
        deduped.set(key, parsed);
      }
    }

    let communityStats = { createdCount: 0, updatedCount: 0 };
    if (sharePublic && deduped.size) {
      communityStats = await upsertCommunityCourses(db, me.id, deduped, source, now);
    }

    return reply({
      ok: true,
      source,
      sharedPublic: sharePublic,
      syncedCourses: source === 'canvas' ? personal.syncedCourses : deduped.size,
      deadlineCount: personal.deadlineCount,
      createdCount: communityStats.createdCount,
      updatedCount: communityStats.updatedCount,
    });
  }

  // Legacy/manual propose route (now also merges & deduplicates cleanly, public by default)
  if (path === '/courses/propose' && request.method === 'POST' && me) {
    if (!Array.isArray(data.courses) || data.courses.length > 60) {
      return reply({ error: 'Choose up to 60 course suggestions.' }, 400);
    }
    const seen = new Map();
    for (const item of data.courses) {
      const course = courseMetadata(item);
      if (course) seen.set(course.code || 'BI-' + course.id, course);
    }
    const stats = seen.size ? await upsertCommunityCourses(db, me.id, seen, 'canvas', now) : { createdCount: 0, updatedCount: 0 };
    return reply({ accepted: seen.size, ...stats });
  }

  if (path === '/admin/courses' && isAdmin) {
    if (request.method === 'GET') {
      const { results } = await db.prepare(`
        SELECT course_key AS id, code, title, canvas_id AS canvasId,
          ed_course_id AS edCourseId, ed_host AS edHost,
          topics_json AS topicsJson, contributor_count AS contributorCount,
          sync_count AS syncCount, verified, status, last_seen_at AS lastSeenAt
        FROM community_courses
        ORDER BY status = 'rejected', verified DESC, last_seen_at DESC
        LIMIT 200
      `).all();
      return reply({
        courses: (results || []).map((r) => {
          let topics = [];
          try { topics = JSON.parse(r.topicsJson || '[]'); } catch {}
          return {
            id: r.id,
            code: r.code || '',
            title: r.title,
            canvasId: r.canvasId || '',
            edCourseId: r.edCourseId || '',
            edHost: r.edHost || '',
            topicCount: Array.isArray(topics) ? topics.length : 0,
            contributorCount: Number(r.contributorCount || 1),
            syncCount: Number(r.syncCount || 1),
            verified: Boolean(r.verified),
            status: r.status,
            lastSeenAt: Number(r.lastSeenAt || 0),
          };
        }),
      });
    }
    if (request.method === 'POST' && typeof data.id === 'string' && data.id.length <= 40) {
      if (typeof data.verified === 'boolean') {
        await db.prepare('UPDATE community_courses SET verified = ? WHERE course_key = ?')
          .bind(data.verified ? 1 : 0, data.id).run();
        return reply({ ok: true });
      }
      if (['approved', 'rejected', 'pending'].includes(data.status)) {
        await db.prepare('UPDATE community_courses SET status = ? WHERE course_key = ?')
          .bind(data.status, data.id).run();
        return reply({ ok: true });
      }
    }
  }

  return reply({ error: 'Course action unavailable.' }, 403);
}
