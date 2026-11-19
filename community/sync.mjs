// Cross-Device Cloud Progress Sync stored in Cloudflare D1 (EU)

const MAX_PAYLOAD_BYTES = 500_000;
const MAX_RECORDS = 5000;
const MAX_ATTEMPTS = 5000;
const MAX_SESSIONS = 500;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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
          prefs: data.customSchedule.prefs,
          blocks: data.customSchedule.blocks.filter(isObj).slice(0, 200),
        }
      : { enabled: false, prefs: {}, blocks: [] };

    const cleanPayload = {
      format: 'study-os-backup-v1',
      syncedAt: new Date(now).toISOString(),
      progress: { records },
      attempts,
      sessions,
      customSchedule,
    };

    const serialized = JSON.stringify(cleanPayload);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      return reply({ error: 'Sync payload exceeds 500 KB limit.' }, 413);
    }

    await db.prepare(`
      INSERT INTO study_backups(profile_id, payload, updated_at, record_count, attempt_count, session_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        payload = excluded.payload,
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
