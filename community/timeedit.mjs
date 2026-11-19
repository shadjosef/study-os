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
