const CANVAS_ORIGIN = 'https://canvas.bi.no';
const DESKTOP = 'http://127.0.0.1:8765';
let syncJob;

// Chrome serializes this function before running it in the open Canvas tab.
async function collectCanvas() {
  const canvasOrigin = 'https://canvas.bi.no';
  const capturedAt = new Date().toISOString();
  if (location.origin !== canvasOrigin) return { error: 'Open your signed-in BI Canvas tab first.' };

  async function list(path, params, maximum) {
    let page = new URL(path, canvasOrigin);
    page.search = new URLSearchParams({ ...params, per_page: 100 });
    const seen = new Set();
    const rows = [];
    while (page) {
      if (page.origin !== canvasOrigin || page.pathname !== path || seen.has(page.href) || seen.size >= 55) {
        throw new Error('Canvas returned an unexpected next page. Try syncing again.');
      }
      seen.add(page.href);
      const response = await fetch(page, {
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000)
      });
      if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403 ||
          (response.ok && !response.headers.get('Content-Type')?.includes('json'))) {
        throw new Error('Sign in to BI Canvas and open one of your courses, then try again.');
      }
      if (!response.ok) throw new Error('Canvas could not load the course list or assignments. Try again.');
      const items = JSON.parse((await response.text()).replace(/^\s*while\s*\(1\)\s*;\s*/, ''));
      if (!Array.isArray(items) || rows.length + items.length > maximum) {
        throw new Error('Canvas returned an invalid list or too many items for one sync.');
      }
      rows.push(...items);
      const next = response.headers.get('Link')?.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?(?=\s*[,;]|\s*$)/i)?.[1];
      page = next ? new URL(next, page) : null;
    }
    return rows;
  }

  function id(value) {
    const result = String(value);
    if (!/^[1-9]\d{0,19}$/.test(result)) throw new Error('Canvas returned an invalid course or assignment ID.');
    return result;
  }

  try {
    const all = await list('/api/v1/courses', { enrollment_type: 'student', enrollment_state: 'active' }, 100);
    const courses = all.filter(course => typeof course.name === 'string' && course.name.trim()).map(course => ({
      id: id(course.id),
      name: course.name.trim().slice(0, 300),
      code: [course.course_code, course.name].map(text => typeof text === 'string'
        ? text.match(/\b([A-Z]{2,6})\s*(\d{3,6})(?!\d)\b/)?.slice(1).join('')
        : '').find(Boolean) || ''
    }));
    let remaining = 5000;
    for (const course of courses) {
      const assignments = await list(`/api/v1/courses/${course.id}/assignments`, {}, remaining);
      course.assignments = assignments.map(assignment => ({
        id: id(assignment.id),
        name: assignment.name?.trim().slice(0, 300),
        dueAt: assignment.due_at ?? null
      }));
      remaining -= course.assignments.length;
    }
    return { snapshot: { version: 1, canvasOrigin, capturedAt, courses } };
  } catch (error) {
    return {
      error: error.name === 'TimeoutError' || error instanceof TypeError || error instanceof SyntaxError
        ? 'Canvas could not load your courses. Check the Canvas tab and try again.'
        : error.message
    };
  }
}

async function desktop(action, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${DESKTOP}/api/canvas/browser/${action}`, {
      method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new Error('Open the desktop Study-OS app and try again.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'Open an updated copy of desktop Study-OS and try again.');
    error.needsPair = action === 'snapshot' && response.status === 403;
    throw error;
  }
  return result;
}

async function sync(tabId, token) {
  let result;
  try {
    [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: collectCanvas });
  } catch {
    throw new Error('Open your signed-in BI Canvas tab, then click the extension again.');
  }
  if (!result || result.error) throw new Error(result?.error || 'Canvas closed during sync. Reopen it and try again.');
  return desktop('snapshot', result.snapshot, token);
}

async function handle(message) {
  if (message.action === 'link') {
    const linked = await desktop('link', { code: message.code });
    if (!/^[A-Za-z0-9_-]{43}$/.test(linked.token)) throw new Error('Study-OS did not return a connection.');
    await chrome.storage.local.set({ token: linked.token });
    return { state: 'linked' };
  }
  if (message.action !== 'sync') return { error: 'Unknown action.' };
  const { token } = await chrome.storage.local.get('token');
  if (!token) return { state: 'pair' };
  const tab = Number.isInteger(message.tabId) ? await chrome.tabs.get(message.tabId) : null;
  if (!tab?.url?.startsWith(`${CANVAS_ORIGIN}/`)) return { state: 'openCanvas' };
  if (!syncJob) syncJob = sync(message.tabId, token).finally(() => { syncJob = null; });
  return { state: 'synced', summary: await syncJob };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== chrome.runtime.getURL('popup.html')) return false;
  handle(message).then(respond, async error => {
    if (error.needsPair) await chrome.storage.local.remove('token');
    respond({ error: error.message, needsPair: Boolean(error.needsPair) });
  });
  return true;
});
