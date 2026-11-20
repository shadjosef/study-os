'use strict';

(() => {
  const siteOrigins = ['https://shadjosef.github.io', 'https://studyos.no'];
  const hosted = new URLSearchParams(location.search).get('site') || siteOrigins[0];
  const connect = document.getElementById('bridge-connect');
  const status = document.getElementById('bridge-status');
  const codex = document.getElementById('bridge-codex');
  const json = document.getElementById('bridge-json');
  let enabled = false;
  let last;

  if (!['127.0.0.1', 'localhost'].includes(location.hostname)) {
    status.textContent = 'Start the desktop Study-OS app to use this connection.';
    return;
  }

  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value);
      status.textContent = 'Settings copied.';
    } catch {
      const field = document.getElementById('bridge-copy');
      field.hidden = false;
      field.value = value;
      field.select();
      status.textContent = 'Copy the selected settings.';
    }
  }

  fetch('/api/tutor/config').then(async (response) => {
    if (!response.ok) throw new Error();
    const { script, port } = await response.json();
    const args = ['run', '--script', script, '--port', String(port)];
    connect.disabled = !window.opener || !siteOrigins.includes(hosted);
    codex.disabled = json.disabled = false;
    codex.onclick = () => copy(`[mcp_servers.study-os]\ncommand = "uv"\nargs = ${JSON.stringify(args)}`);
    json.onclick = () => copy(JSON.stringify({ mcpServers: { 'study-os': { command: 'uv', args } } }, null, 2));
    status.textContent = connect.disabled ? 'Open this window from Al tutor in the Study-OS website.' : 'Ready to connect.';
  }).catch(() => { status.textContent = 'Restart the desktop Study-OS server to load the tutor connection.'; });

  connect.onclick = () => {
    enabled = true;
    connect.disabled = true;
    status.textContent = 'Connected. You can minimize this window.';
    window.opener?.postMessage('study-os:tutor-ready', hosted);
  };
  window.addEventListener('message', (event) => {
    if (!enabled || event.origin !== hosted || event.source !== window.opener
        || event.data?.kind !== 'study-os:tutor-context') return;
    last = event.data;
    fetch('/api/tutor/live', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(last),
    }).then((response) => {
      if (!response.ok) status.textContent = 'Could not share this exercise. Reopen the tutor connection.';
    }).catch(() => { status.textContent = 'The desktop connection was interrupted.'; });
  });
  window.addEventListener('pagehide', () => {
    if (!last) return;
    const body = JSON.stringify({ ...last, state: { mode: 'waiting' } });
    navigator.sendBeacon('/api/tutor/live', new Blob([body], { type: 'application/json' }));
  });
})();
