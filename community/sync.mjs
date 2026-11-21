// Cross-Device Cloud Progress Sync stored in Cloudflare D1 (EU)
import { courseMetadata, cleanCanvasOrigin, schoolForOrigin } from './courses.mjs';

const MAX_PAYLOAD_BYTES = 500_000;
const MAX_RECORDS = 5000;
const MAX_ATTEMPTS = 5000;
const MAX_SESSIONS = 500;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function canvasForSync(raw) {
  if (!isObj(raw) || !Number.isFinite(Date.parse(raw.syncedAt)) || !Array.isArray(raw.courses)) return null;
  const snapshotOrigin = cleanCanvasOrigin(raw.canvasOrigin || raw.courses[0]?.url || '');
  const school = schoolForOrigin(snapshotOrigin);
  let left = 1200;
  const courses = [];
  for (const item of raw.courses.slice(0, 100)) {
    const course = courseMetadata(item);
    if (!course) continue;
    const itemOrigin = typeof item.url === 'string' && item.url.startsWith('https://')
      ? cleanCanvasOrigin(item.url)
      : snapshotOrigin;
    const url = `${itemOrigin}/courses/${course.id}`;
    const assignments = (Array.isArray(item.assignments) ? item.assignments : []).filter(task =>
      isObj(task) && /^[1-9][0-9]{0,19}$/.test(task.id || '') && typeof task.name === 'string' &&
      Number.isFinite(Date.parse(task.dueAt))
    ).slice(0, left).map(task => ({
      id: String(task.id), name: task.name.slice(0, 200), dueAt: new Date(task.dueAt).toISOString(),
      url: `${url}/assignments/${task.id}`,
    }));
    left -= assignments.length;
    courses.push({
      ...course,
      topics: course.topics.slice(0, 20).map((t) => t.slice(0, 80)),
      url,
      assignments,
    });
  }
  return { syncedAt: new Date(raw.syncedAt).toISOString(), canvasOrigin: snapshotOrigin, school, courses };
}

function cleanCompletedEvents(raw) {
  if (!isObj(raw)) return {};
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k || k.length > 160) continue;
    if (typeof v === 'string' && Number.isFinite(Date.parse(v))) {
      out[k] = { at: new Date(v).toISOString(), early: false, method: 'manual' };
    } else if (isObj(v) && typeof v.at === 'string' && Number.isFinite(Date.parse(v.at))) {
      out[k] = {
        at: new Date(v.at).toISOString(),
        early: Boolean(v.early),
        method: typeof v.method === 'string' ? v.method.slice(0, 24) : 'manual',
      };
    } else {
      continue;
    }
    if (++count >= 300) break;
  }
  return out;
}

function cleanDismissedEvents(raw) {
  if (!isObj(raw)) return {};
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k || k.length > 160) continue;
    if (typeof v === 'string' && Number.isFinite(Date.parse(v))) {
      out[k] = new Date(v).toISOString();
      if (++count >= 300) break;
    }
  }
  return out;
}

function cleanCustomSets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw.slice(0, 25)) {
    if (!isObj(s) || typeof s.id !== 'string' || !s.id || s.id.length > 64) continue;
    const title = typeof s.title === 'string' ? s.title.trim().slice(0, 100) : '';
    if (!title) continue;
    if (Array.isArray(s.questions) && s.questions.length) {
      const qs = s.questions.slice(0, 25).map((q) => {
        if (!isObj(q)) return null;
        const promptMarkdown = typeof q.promptMarkdown === 'string' ? q.promptMarkdown.trim().slice(0, 900) : '';
        const solutionMarkdown = typeof q.solutionMarkdown === 'string' ? q.solutionMarkdown.trim().slice(0, 1200) : '';
        if (!promptMarkdown || !solutionMarkdown) return null;
        const opts = Array.isArray(q.options) ? q.options.slice(0, 5).map((o) => String(o || '').trim().slice(0, 260)).filter(Boolean) : [];
        const isMcq = q.kind === 'mcq' && opts.length >= 2 && Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < opts.length;
        return {
          title: typeof q.title === 'string' ? q.title.trim().slice(0, 100) : '',
          kind: isMcq ? 'mcq' : 'written',
          difficulty: [1, 2, 3].includes(Number(q.difficulty)) ? Number(q.difficulty) : 2,
          topic: typeof q.topic === 'string' ? q.topic.trim().slice(0, 80) : '',
          promptMarkdown,
          ...(isMcq ? { options: opts, answerIndex: q.answerIndex } : {}),
          hint: typeof q.hint === 'string' ? q.hint.trim().slice(0, 320) : '',
          solutionMarkdown,
        };
      }).filter(Boolean);
      if (!qs.length) continue;
      out.push({
        id: s.id,
        title,
        courseCode: typeof s.courseCode === 'string' ? s.courseCode.trim().slice(0, 32) : '',
        courseTitle: typeof s.courseTitle === 'string' ? s.courseTitle.trim().slice(0, 140) : '',
        school: typeof s.school === 'string' ? s.school.trim().slice(0, 48) : '',
        modelLabel: typeof s.modelLabel === 'string' ? s.modelLabel.trim().slice(0, 48) : '',
        createdAt: typeof s.createdAt === 'string' ? s.createdAt.slice(0, 40) : '',
        questions: qs,
      });
    } else if (Array.isArray(s.cards) && s.cards.length) {
      const cards = s.cards.slice(0, 30)
        .filter((c) => Array.isArray(c) && c.length === 2 && typeof c[0] === 'string' && typeof c[1] === 'string')
        .map(([q, a]) => [q.trim().slice(0, 300), a.trim().slice(0, 500)])
        .filter(([q, a]) => q && a);
      if (!cards.length) continue;
      out.push({ id: s.id, title, cards });
    }
  }
  return out;
}

export async function handleSync({ request, db, me, now, data, reply }) {
  if (request.method === 'GET') {
    const row = await db.prepare(
      'SELECT payload, updated_at, record_count, attempt_count, session_count FROM study_backups WHERE profile_id = ?'
    ).bind(me.id).first();
    if (!row) return reply({ hasBackup: false });
    try {
      return reply({
        hasBackup: true,
        updatedAt: Number(row.updated_at || 0),
        recordCount: Number(row.record_count || 0),
        attemptCount: Number(row.attempt_count || 0),
        sessionCount: Number(row.session_count || 0),
        data: JSON.parse(row.payload),
      });
    } catch {
      return reply({ hasBackup: false });
    }
  }

  if (request.method === 'POST') {
    const rawRecords = data?.progress?.records ?? data?.records;
    if (!isObj(rawRecords)) {
      return reply({ error: 'Invalid sync payload.' }, 400);
    }
    const recordEntries = Object.entries(rawRecords)
      .filter(([qid, rec]) => typeof qid === 'string' && qid.includes(':') && qid.length <= 160 && isObj(rec))
      .slice(0, MAX_RECORDS);
    const records = Object.fromEntries(recordEntries);

    const attempts = Array.isArray(data.attempts)
      ? data.attempts.filter((a) => isObj(a) && typeof a.questionId === 'string').slice(-MAX_ATTEMPTS)
      : [];
    const sessions = Array.isArray(data.sessions)
      ? data.sessions.filter((s) => isObj(s) && typeof s.sessionId === 'string').slice(-MAX_SESSIONS)
      : [];
    const customSchedule = isObj(data.customSchedule) && typeof data.customSchedule.enabled === 'boolean'
      && isObj(data.customSchedule.prefs) && Array.isArray(data.customSchedule.blocks)
      ? {
          enabled: data.customSchedule.enabled,
          source: typeof data.customSchedule.source === 'string' ? data.customSchedule.source.slice(0, 64) : '',
          updatedAt: typeof data.customSchedule.updatedAt === 'string' ? data.customSchedule.updatedAt.slice(0, 64) : '',
          prefs: Object.fromEntries(Object.entries(data.customSchedule.prefs).filter(([key]) => key !== 'timeeditUrl')),
          blocks: data.customSchedule.blocks.filter(isObj).slice(0, 200),
          completedEvents: cleanCompletedEvents(data.customSchedule.completedEvents),
          dismissedEvents: cleanDismissedEvents(data.customSchedule.dismissedEvents),
        }
      : { enabled: false, prefs: {}, blocks: [], completedEvents: {}, dismissedEvents: {} };

    const cleanPayload = {
      format: 'study-os-backup-v1',
      syncedAt: new Date(now).toISOString(),
      progress: { records },
      attempts,
      sessions,
      customSchedule,
      canvasSnapshot: canvasForSync(data.canvasSnapshot),
      customSets: cleanCustomSets(data.customSets),
    };

    const serialized = JSON.stringify(cleanPayload);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      return reply({ error: 'Sync payload exceeds 500 KB limit.' }, 413);
    }

    await db.prepare(`
      INSERT INTO study_backups(profile_id, payload, updated_at, record_count, attempt_count, session_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        payload = json_set(excluded.payload,
          '$.customSchedule', json_remove(json(CASE
            WHEN COALESCE(julianday(json_extract(study_backups.payload, '$.customSchedule.updatedAt')), 0)
              > COALESCE(julianday(json_extract(excluded.payload, '$.customSchedule.updatedAt')), 0)
            THEN json_extract(study_backups.payload, '$.customSchedule')
            ELSE json_extract(excluded.payload, '$.customSchedule') END), '$.prefs.timeeditUrl'),
          '$.canvasSnapshot', json(CASE
            WHEN COALESCE(julianday(json_extract(study_backups.payload, '$.canvasSnapshot.syncedAt')), 0)
              > COALESCE(julianday(json_extract(excluded.payload, '$.canvasSnapshot.syncedAt')), 0)
            THEN json_extract(study_backups.payload, '$.canvasSnapshot')
            ELSE json_extract(excluded.payload, '$.canvasSnapshot') END)),
        updated_at = excluded.updated_at,
        record_count = excluded.record_count,
        attempt_count = excluded.attempt_count,
        session_count = excluded.session_count
    `).bind(me.id, serialized, now, recordEntries.length, attempts.length, sessions.length).run();

    return reply({
      ok: true,
      updatedAt: now,
      recordCount: recordEntries.length,
      attemptCount: attempts.length,
      sessionCount: sessions.length,
    });
  }

  return reply({ error: 'Method not allowed.' }, 405);
}
