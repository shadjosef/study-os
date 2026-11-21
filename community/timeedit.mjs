const limit = 2_000_000;
const ALLOWED_TIMETABLE_ORIGINS = new Set([
  'https://cloud.timeedit.net',
  'https://tp.educloud.no',
  'https://tp.uio.no',
]);

function isAllowedTimetableUrl(raw) {
  try {
    const input = typeof raw === 'string' ? raw.trim() : '';
    const url = new URL(input.replace(/^webcal:/i, 'https:'));
    if (input.length > 4096 || !ALLOWED_TIMETABLE_ORIGINS.has(url.origin) ||
        url.username || url.password || url.hash) return null;
    const looksIcal = /\.ics$/i.test(url.pathname) || /\/ical(?:\.php)?$/i.test(url.pathname);
    if (!looksIcal) return null;
    return url;
  } catch {
    return null;
  }
}

export async function readTimeEdit(data, reply) {
  const url = isAllowedTimetableUrl(data?.url);
  if (!url) {
    return reply({ error: 'Paste a TimeEdit (cloud.timeedit.net) or TP (tp.educloud.no / tp.uio.no) iCal/.ics subscription link, or upload an .ics file.' }, 400);
  }
  try {
    const result = await fetch(url, {
      headers: { Accept: 'text/calendar' }, redirect: 'error', signal: AbortSignal.timeout(12_000),
    });
    if (!result.ok || !result.body) throw new Error();
    const reader = result.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let calendar = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        return reply({ error: 'Choose a timetable calendar under 2 MB.' }, 413);
      }
      calendar += decoder.decode(value, { stream: true });
    }
    calendar += decoder.decode();
    if (!/^\s*BEGIN:VCALENDAR/i.test(calendar)) throw new Error();
    return reply({ calendar });
  } catch {
    return reply({ error: 'Could not read that timetable link. Check that it is an iCal/.ics subscription link or upload the downloaded file.' }, 422);
  }
}

export async function pushTimeEditFeed(db, profileId, data, now, reply) {
  const calendar = typeof data.calendar === 'string' ? data.calendar : '';
  if (!calendar || calendar.length > limit || !/^\s*BEGIN:VCALENDAR/i.test(calendar)) {
    return reply({ error: 'Invalid timetable .ics calendar payload.' }, 400);
  }
  let sourceUrl = '';
  if (typeof data.sourceUrl === 'string') {
    try {
      const u = new URL(data.sourceUrl.trim());
      if (ALLOWED_TIMETABLE_ORIGINS.has(u.origin)) sourceUrl = u.href.slice(0, 1024);
    } catch {}
  }
  await db.prepare(`
    INSERT INTO user_timeedit_feeds(profile_id, ics_text, source_url, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      ics_text = excluded.ics_text,
      source_url = excluded.source_url,
      updated_at = excluded.updated_at
  `).bind(profileId, calendar, sourceUrl, now).run();
  const eventCount = (calendar.match(/BEGIN:VEVENT/gi) || []).length;
  return reply({ ok: true, eventCount, updatedAt: now });
}

export async function getTimeEditFeed(db, profileId, reply) {
  const row = await db.prepare('SELECT ics_text, source_url, updated_at FROM user_timeedit_feeds WHERE profile_id = ?')
    .bind(profileId).first();
  if (!row) return reply({ hasFeed: false });
  return reply({
    hasFeed: true,
    calendar: row.ics_text,
    sourceUrl: row.source_url || '',
    updatedAt: Number(row.updated_at || 0),
  });
}
