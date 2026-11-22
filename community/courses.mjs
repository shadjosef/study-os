// Collaborative, deduplicated Community Course Catalog + Personal Canvas/Ed Sync.
// Copyright safety: stores ONLY course codes, titles, Canvas/Ed IDs, and module/syllabus
// topic headings (never copyrighted PDFs, slides, or private student posts).
// Personal assignment deadlines stay strictly private inside the student's own study_backups.

const numericId = /^[1-9][0-9]{0,19}$/;
const codeExtract3to6 = /(?:^|[^A-Za-z0-9ÆØÅæøå])([A-Za-zÆØÅæøå]{2,6})(?:\s*[-_]\s*|\s?)(\d{3,6})(?!\d)/;
const codeExtract2 = /(?:^|[^A-Za-z0-9ÆØÅæøå])([A-Za-zÆØÅæøå]{2,6})[-_]?(\d{2})(?![A-Za-z0-9ÆØÅæøå])/;
const skipCode2Prefix = new Set(['WEEK', 'UKE', 'KAP', 'DEL', 'PART', 'MOD', 'SEM', 'DAG', 'DAY', 'TEMA', 'LEC', 'LAB', 'SET', 'CH', 'NO', 'NR', 'VG', 'H2', 'V2']);
const validEdHosts = new Set(['edstem.org', 'eu.edstem.org', 'us.edstem.org', 'au.edstem.org']);

const DEFAULT_CANVAS_ORIGIN = 'https://canvas.bi.no';
const KNOWN_CANVAS_SCHOOLS = {
  'canvas.bi.no': { school: 'BI Oslo', slug: 'BI' },
  'bi.instructure.com': { school: 'BI Oslo', slug: 'BI' },
  'uia.instructure.com': { school: 'UiA', slug: 'UIA' },
  'canvas.uia.no': { school: 'UiA', slug: 'UIA' },
  'mitt.uib.no': { school: 'UiB', slug: 'UIB' },
  'uib.instructure.com': { school: 'UiB', slug: 'UIB' },
  'uio.instructure.com': { school: 'UiO', slug: 'UIO' },
  'canvas.uio.no': { school: 'UiO', slug: 'UIO' },
  'ntnu.instructure.com': { school: 'NTNU', slug: 'NTNU' },
  'canvas.ntnu.no': { school: 'NTNU', slug: 'NTNU' },
  'oslomet.instructure.com': { school: 'OsloMet', slug: 'OSLOMET' },
  'canvas.oslomet.no': { school: 'OsloMet', slug: 'OSLOMET' },
  'nhh.instructure.com': { school: 'NHH', slug: 'NHH' },
  'canvas.nhh.no': { school: 'NHH', slug: 'NHH' },
  'uis.instructure.com': { school: 'UiS', slug: 'UIS' },
  'canvas.uis.no': { school: 'UiS', slug: 'UIS' },
  'uit.instructure.com': { school: 'UiT', slug: 'UIT' },
  'canvas.uit.no': { school: 'UiT', slug: 'UIT' },
  'usn.instructure.com': { school: 'USN', slug: 'USN' },
  'canvas.usn.no': { school: 'USN', slug: 'USN' },
  'nmbu.instructure.com': { school: 'NMBU', slug: 'NMBU' },
  'canvas.nmbu.no': { school: 'NMBU', slug: 'NMBU' },
  'hvl.instructure.com': { school: 'HVL', slug: 'HVL' },
  'canvas.hvl.no': { school: 'HVL', slug: 'HVL' },
  'kristiania.instructure.com': { school: 'Kristiania', slug: 'HK' },
  'canvas.kristiania.no': { school: 'Kristiania', slug: 'HK' },
};
const INSTRUCTURE_SKIP_SUBS = new Set(['login', 'sso', 'sso-login', 'cdn', 'canvas-cdn', 'community', 'www', 'status']);

export function cleanCanvasOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_CANVAS_ORIGIN;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return DEFAULT_CANVAS_ORIGIN;
    const host = u.hostname.toLowerCase();
    if (KNOWN_CANVAS_SCHOOLS[host]) return `https://${host}`;
    if (/^canvas\.[a-z0-9-]+\.no$/.test(host)) return `https://${host}`;
    const m = host.match(/^([a-z0-9-]+)\.instructure\.com$/);
    if (m && !INSTRUCTURE_SKIP_SUBS.has(m[1])) return `https://${host}`;
  } catch {}
  return DEFAULT_CANVAS_ORIGIN;
}

export function schoolForOrigin(origin) {
  try {
    const host = new URL(cleanCanvasOrigin(origin)).hostname.toLowerCase();
    if (KNOWN_CANVAS_SCHOOLS[host]) return KNOWN_CANVAS_SCHOOLS[host].school;
    const mNo = host.match(/^canvas\.([a-z0-9-]+)\.no$/);
    if (mNo) return mNo[1].toUpperCase();
    const m = host.match(/^([a-z0-9-]+)\.instructure\.com$/);
    if (m) {
      const sub = m[1];
      return sub.length <= 4 ? sub.toUpperCase() : sub.charAt(0).toUpperCase() + sub.slice(1);
    }
  } catch {}
  return 'BI Oslo';
}

export function schoolSlugForOrigin(origin) {
  try {
    const host = new URL(cleanCanvasOrigin(origin)).hostname.toLowerCase();
    if (KNOWN_CANVAS_SCHOOLS[host]) return KNOWN_CANVAS_SCHOOLS[host].slug;
    const m = host.match(/^(?:canvas\.)?([a-z0-9-]+)\.(?:instructure\.com|no)$/);
    if (m) return m[1].replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 10) || 'CVS';
  } catch {}
  return 'BI';
}

function cleanText(value, maxLen = 160) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').slice(0, maxLen);
}

export function normalizeCourseCode(rawCode, rawName = '') {
  for (const candidate of [rawCode, rawName]) {
    if (typeof candidate !== 'string') continue;
    const match = candidate.match(codeExtract3to6);
    if (match) return `${match[1].toUpperCase()}${match[2]}`;
  }
  for (const candidate of [rawCode, rawName]) {
    if (typeof candidate !== 'string') continue;
    const match = candidate.match(codeExtract2);
    if (match && !skipCode2Prefix.has(match[1].toUpperCase())) {
      return `${match[1].toUpperCase()}${match[2]}`;
    }
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

function cleanMultilineText(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

export function cleanEdSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isFinite(Date.parse(raw.syncedAt))) return null;
  const syncedAt = new Date(raw.syncedAt).toISOString();
  const courses = [];
  const courseMap = new Map();
  for (const item of (Array.isArray(raw.courses) ? raw.courses : []).slice(0, 60)) {
    const meta = edCourseMetadata(item);
    if (!meta) continue;
    courses.push({
      id: meta.id,
      name: meta.name,
      code: meta.code,
      host: meta.host,
      topics: meta.topics.slice(0, 20),
    });
    courseMap.set(meta.id, meta);
  }
  const threads = [];
  const seen = new Set();
  for (const t of (Array.isArray(raw.threads) ? raw.threads : []).slice(0, 80)) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.id || '').trim();
    const courseId = String(t.courseId || '').trim();
    if (!numericId.test(id) || !numericId.test(courseId)) continue;
    const key = `${courseId}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cm = courseMap.get(courseId);
    const rawHost = typeof t.host === 'string' ? t.host.trim().toLowerCase() : (cm?.host || 'eu.edstem.org');
    const host = validEdHosts.has(rawHost) ? rawHost : 'eu.edstem.org';
    const title = cleanText(t.title, 180);
    if (!title) continue;
    const snippet = cleanMultilineText(t.snippet || t.text || '', 650);
    const createdAt = Number.isFinite(Date.parse(t.createdAt)) ? new Date(t.createdAt).toISOString() : syncedAt;
    const updatedAt = Number.isFinite(Date.parse(t.updatedAt)) ? new Date(t.updatedAt).toISOString() : createdAt;
    const num = Number(t.number);
    const type = ['announcement', 'question', 'post'].includes(t.type) ? t.type : 'post';
    threads.push({
      id,
      courseId,
      courseCode: cleanText(t.courseCode || cm?.code || '', 24),
      courseName: cleanText(t.courseName || cm?.name || '', 120),
      host,
      number: Number.isInteger(num) && num > 0 && num < 1_000_000 ? num : 0,
      title,
      snippet,
      category: cleanText(t.category || '', 60),
      type,
      isPinned: Boolean(t.isPinned),
      isAnswered: Boolean(t.isAnswered),
      isStaff: Boolean(t.isStaff),
      author: cleanText(t.author || '', 60),
      replyCount: Math.max(0, Math.min(9999, Math.floor(Number(t.replyCount) || 0))),
      createdAt,
      updatedAt,
      url: `https://${host}/courses/${courseId}/discussion/${id}`,
    });
    if (threads.length >= 60) break;
  }
  if (!courses.length && !threads.length) return null;
  return { syncedAt, courses, threads };
}

async function mergePersonalEdBackup(db, profileId, courses, threads, syncedAtIso, now) {
  const snapshot = cleanEdSnapshot({ syncedAt: syncedAtIso, courses, threads });
  if (!snapshot) return { syncedCourses: 0, threadCount: 0 };
  const row = await db.prepare('SELECT payload FROM study_backups WHERE profile_id = ?')
    .bind(profileId).first();
  if (row) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { payload = null; }
    if (!payload || typeof payload !== 'object') {
      payload = { format: 'study-os-backup-v1', syncedAt: syncedAtIso, progress: { records: {} }, attempts: [], sessions: [], customSchedule: { enabled: false, prefs: {}, blocks: [] } };
    }
    payload.edSnapshot = snapshot;
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
      edSnapshot: snapshot,
    };
    await db.prepare(`
      INSERT INTO study_backups(profile_id, payload, updated_at, record_count, attempt_count, session_count)
      VALUES (?, ?, ?, 0, 0, 0)
    `).bind(profileId, JSON.stringify(payload), now).run();
  }
  return { syncedCourses: snapshot.courses.length, threadCount: snapshot.threads.length };
}

async function mergePersonalCanvasBackup(db, profileId, courses, syncedAtIso, now, canvasOriginRaw = DEFAULT_CANVAS_ORIGIN) {
  const defaultOrigin = cleanCanvasOrigin(canvasOriginRaw);
  const school = schoolForOrigin(defaultOrigin);
  let left = 1200;
  const cleanCourses = [];
  let deadlineCount = 0;
  for (const item of courses.slice(0, 100)) {
    const meta = courseMetadata(item);
    if (!meta) continue;
    const itemOrigin = typeof item.url === 'string' && item.url.startsWith('https://')
      ? cleanCanvasOrigin(item.url)
      : defaultOrigin;
    const url = `${itemOrigin}/courses/${meta.id}`;
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
    cleanCourses.push({
      id: meta.id,
      name: meta.name,
      code: meta.code,
      url,
      topics: meta.topics.slice(0, 20).map((t) => t.slice(0, 80)),
      assignments,
    });
  }
  const snapshot = { syncedAt: syncedAtIso, canvasOrigin: defaultOrigin, school, courses: cleanCourses };
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

async function upsertCommunityCourses(db, profileId, entries, source, now, canvasOrigin = DEFAULT_CANVAS_ORIGIN, school = '') {
  let createdCount = 0;
  let updatedCount = 0;
  const resolvedOrigin = source === 'canvas' ? cleanCanvasOrigin(canvasOrigin) : '';
  const resolvedSchool = source === 'canvas' ? (cleanText(school, 40) || schoolForOrigin(resolvedOrigin)) : '';

  for (const [key, course] of entries) {
    const existing = await db.prepare(`
      SELECT course_key, code, title, canvas_id, canvas_origin, school, status, topics_json, ed_course_id, ed_host
      FROM community_courses WHERE course_key = ?
    `).bind(key).first();

    if (!existing) {
      const topicsJson = JSON.stringify(course.topics || []);
      await db.prepare(`
        INSERT INTO community_courses(
          course_key, code, title, canvas_id, canvas_origin, school, status, last_seen_at,
          topics_json, ed_course_id, ed_host, contributor_count, sync_count, verified
        ) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, 1, 1, 0)
      `).bind(
        key,
        course.code || '',
        course.name,
        source === 'canvas' ? course.id : '',
        resolvedOrigin || DEFAULT_CANVAS_ORIGIN,
        resolvedSchool,
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
    const nextCanvasOrigin = source === 'canvas' ? resolvedOrigin : (existing.canvas_origin || DEFAULT_CANVAS_ORIGIN);
    const nextSchool = source === 'canvas' ? resolvedSchool : (existing.school || '');
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
        canvas_origin = CASE WHEN ? <> '' THEN ? ELSE canvas_origin END,
        school = CASE WHEN ? <> '' THEN ? ELSE school END,
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
      nextCanvasOrigin, nextCanvasOrigin,
      nextSchool, nextSchool,
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
        canvas_origin AS canvasOrigin, school,
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
      const origin = cleanCanvasOrigin(r.canvasOrigin || DEFAULT_CANVAS_ORIGIN);
      return {
        id: r.id,
        code: r.code || '',
        title: r.title,
        canvasId: r.canvasId || '',
        canvasOrigin: origin,
        school: r.school || schoolForOrigin(origin),
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
    const canvasOrigin = source === 'canvas' ? cleanCanvasOrigin(data.canvasOrigin) : DEFAULT_CANVAS_ORIGIN;
    const school = source === 'canvas' ? schoolForOrigin(canvasOrigin) : '';
    const slug = source === 'canvas' ? schoolSlugForOrigin(canvasOrigin) : 'ED';
    const syncedAtIso = Number.isFinite(Date.parse(data.capturedAt))
      ? new Date(data.capturedAt).toISOString()
      : new Date(now).toISOString();

    let personal = { syncedCourses: 0, deadlineCount: 0, threadCount: 0 };
    if (source === 'canvas') {
      personal = { ...(await mergePersonalCanvasBackup(db, me.id, data.courses, syncedAtIso, now, canvasOrigin)), threadCount: 0 };
      // Auto-populate profile school & Canvas origin if not chosen yet
      if (!me.school && school) {
        await db.prepare(`
          UPDATE profiles SET school = ?, canvas_origin = CASE WHEN canvas_origin = '' THEN ? ELSE canvas_origin END
          WHERE id = ? AND school = ''
        `).bind(school, canvasOrigin, me.id).run().catch(() => {});
      }
    } else if (source === 'ed') {
      const edRes = await mergePersonalEdBackup(db, me.id, data.courses, Array.isArray(data.threads) ? data.threads : [], syncedAtIso, now);
      personal = { syncedCourses: edRes.syncedCourses, deadlineCount: 0, threadCount: edRes.threadCount };
    }

    const deduped = new Map();
    for (const item of data.courses) {
      const parsed = source === 'ed' ? edCourseMetadata(item) : courseMetadata(item);
      if (!parsed) continue;
      const key = source === 'ed'
        ? (parsed.code || `ED-${parsed.id}`)
        : slug === 'BI'
        ? (parsed.code || `BI-${parsed.id}`)
        : parsed.code ? `${slug}-${parsed.code}` : `${slug}-${parsed.id}`;
      const prev = deduped.get(key);
      if (prev) {
        prev.topics = cleanTopics([...prev.topics, ...parsed.topics]);
      } else {
        deduped.set(key, parsed);
      }
    }

    let communityStats = { createdCount: 0, updatedCount: 0 };
    if (sharePublic && deduped.size) {
      communityStats = await upsertCommunityCourses(db, me.id, deduped, source, now, canvasOrigin, school);
    }

    return reply({
      ok: true,
      source,
      school,
      canvasOrigin: source === 'canvas' ? canvasOrigin : '',
      sharedPublic: sharePublic,
      syncedCourses: source === 'canvas' ? personal.syncedCourses : (personal.syncedCourses || deduped.size),
      deadlineCount: personal.deadlineCount,
      threadCount: personal.threadCount || 0,
      createdCount: communityStats.createdCount,
      updatedCount: communityStats.updatedCount,
    });
  }

  // Legacy/manual propose route (now also merges & deduplicates cleanly, public by default)
  if (path === '/courses/propose' && request.method === 'POST' && me) {
    if (!Array.isArray(data.courses) || data.courses.length > 60) {
      return reply({ error: 'Choose up to 60 course suggestions.' }, 400);
    }
    const canvasOrigin = cleanCanvasOrigin(data.canvasOrigin);
    const school = schoolForOrigin(canvasOrigin);
    const slug = schoolSlugForOrigin(canvasOrigin);
    const seen = new Map();
    for (const item of data.courses) {
      const course = courseMetadata(item);
      if (!course) continue;
      const key = slug === 'BI'
        ? (course.code || 'BI-' + course.id)
        : course.code ? `${slug}-${course.code}` : `${slug}-${course.id}`;
      seen.set(key, course);
    }
    const stats = seen.size ? await upsertCommunityCourses(db, me.id, seen, 'canvas', now, canvasOrigin, school) : { createdCount: 0, updatedCount: 0 };
    return reply({ accepted: seen.size, ...stats });
  }

  if (path === '/admin/courses' && isAdmin) {
    if (request.method === 'GET') {
      const { results } = await db.prepare(`
        SELECT course_key AS id, code, title, canvas_id AS canvasId,
          canvas_origin AS canvasOrigin, school,
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
          const origin = cleanCanvasOrigin(r.canvasOrigin || DEFAULT_CANVAS_ORIGIN);
          return {
            id: r.id,
            code: r.code || '',
            title: r.title,
            canvasId: r.canvasId || '',
            canvasOrigin: origin,
            school: r.school || schoolForOrigin(origin),
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
