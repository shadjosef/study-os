(() => {
  const byId = id => document.getElementById(id);
  const status = byId('canvas-sync-state');
  const controls = byId('canvas-controls');
  const issue = byId('canvas-link');
  const disconnect = byId('canvas-disconnect');
  const codeRow = byId('canvas-connection-code');
  const code = byId('canvas-code');
  const copy = byId('canvas-copy');
  const deadlines = byId('canvas-deadlines');
  const upcoming = byId('canvas-upcoming');
  const allCourses = byId('canvas-courses');
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  let lastRender;
  let codeTimer;
  let wasConnected = false;
  let refreshing = false;
  let busy = false;

  if (location.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(location.hostname)) {
    byId('canvas-instructions').textContent = 'Open the desktop Study-OS app to connect your browser to Canvas.';
    return;
  }

  async function api(action, method = 'GET') {
    const options = method === 'POST'
      ? { method, headers: { 'Content-Type': 'application/json' }, body: '{}' }
      : {};
    const response = await fetch(`/api/canvas/browser/${action}`, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Update the desktop Study-OS app and try again.');
    return result;
  }

  function clearCode() {
    clearTimeout(codeTimer);
    codeRow.hidden = true;
    code.value = '';
    copy.textContent = 'Copy code';
  }

  function canvasLink(item) {
    const link = document.createElement('a');
    link.href = item.url;
    link.textContent = item.name;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function assignmentList(items) {
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No assignments to show.';
      return empty;
    }
    const list = document.createElement('ul');
    for (const item of items) {
      const row = document.createElement('li');
      const due = document.createElement('span');
      due.className = 'muted canvas-due';
      const date = item.dueAt ? dateFormat.format(new Date(item.dueAt)) : 'No due date';
      due.textContent = item.courseName ? `${item.courseName} · ${date}` : date;
      row.append(canvasLink(item), due);
      list.append(row);
    }
    return list;
  }

  function render({ connected, snapshot }) {
    if (connected && !wasConnected) clearCode();
    wasConnected = connected;
    controls.hidden = false;
    issue.textContent = connected ? 'Connect another browser' : 'Get connection code';
    disconnect.hidden = !connected;
    const message = connected ? 'Browser connected.' : 'Browser disconnected.';
    status.textContent = snapshot
      ? `${message} Last sync ${dateFormat.format(new Date(snapshot.syncedAt))}.`
      : message;
    if (!snapshot) return;

    const now = Date.now();
    const recent = snapshot.courses.flatMap(course => course.assignments
      .filter(item => item.dueAt && Date.parse(item.dueAt) >= now)
      .map(item => ({ ...item, courseName: course.name })))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    const renderKey = `${snapshot.syncedAt}:${recent.length}`;
    if (renderKey === lastRender) return;
    lastRender = renderKey;
    upcoming.replaceChildren(assignmentList(recent));
    allCourses.replaceChildren(...snapshot.courses.map(course => {
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      heading.append(canvasLink(course));
      section.append(heading, assignmentList(course.assignments));
      return section;
    }));
    deadlines.hidden = false;
  }

  async function refresh() {
    if (refreshing || busy || document.hidden) return;
    refreshing = true;
    try {
      render(await api('status'));
    } catch (error) {
      status.textContent = error.message;
    } finally {
      refreshing = false;
    }
  }

  async function changeConnection(button, action) {
    button.disabled = busy = true;
    try {
      clearCode();
      const result = await api(action, 'POST');
      if (action === 'disconnect') {
        render(result);
      } else {
        code.value = result.code;
        codeRow.hidden = false;
        code.select();
        codeTimer = setTimeout(clearCode, result.expiresInSeconds * 1000);
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = busy = false;
    }
  }

  issue.addEventListener('click', () => changeConnection(issue, 'code'));
  disconnect.addEventListener('click', () => changeConnection(disconnect, 'disconnect'));
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.value);
      copy.textContent = 'Copied';
    } catch {
      code.select();
    }
  });
  document.addEventListener('visibilitychange', refresh);
  refresh();
  setInterval(refresh, 15_000);
})();
