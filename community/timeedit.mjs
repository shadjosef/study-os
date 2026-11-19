const limit = 2_000_000;

export async function readTimeEdit(data, reply) {
  let url;
  try {
    const input = typeof data.url === 'string' ? data.url.trim() : '';
    url = new URL(input.replace(/^webcal:/i, 'https:'));
    if (input.length > 4096 || url.origin !== 'https://cloud.timeedit.net' ||
        url.username || url.password || url.hash || !/\.ics$/i.test(url.pathname)) throw new Error();
  } catch {
    return reply({ error: 'Paste your cloud.timeedit.net subscription link ending in .ics, or upload an .ics file.' }, 400);
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
        return reply({ error: 'Choose a TimeEdit calendar under 2 MB.' }, 413);
      }
      calendar += decoder.decode(value, { stream: true });
    }
    calendar += decoder.decode();
    if (!/^\s*BEGIN:VCALENDAR/i.test(calendar)) throw new Error();
    return reply({ calendar });
  } catch {
    return reply({ error: 'Could not read that TimeEdit link. Check that it is the .ics subscription link or upload the downloaded file.' }, 422);
  }
}

export async function pushTimeEditFeed(db, profileId, data, now, reply) {
  const calendar = typeof data.calendar === 'string' ? data.calendar : '';
  if (!calendar || calendar.length > limit || !/^\s*BEGIN:VCALENDAR/i.test(calendar)) {
    return reply({ error: 'Invalid TimeEdit .ics calendar payload.' }, 400);
  }
  const sourceUrl = typeof data.sourceUrl === 'string' && data.sourceUrl.startsWith('https://cloud.timeedit.net/')
    ? data.sourceUrl.slice(0, 1024)
    : '';
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
