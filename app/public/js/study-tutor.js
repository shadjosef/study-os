'use strict';

window.StudyTutor = (() => {
  const web = document.documentElement.dataset.studyMode === 'web';
  const localOrigin = 'http://127.0.0.1:8765';
  const siteOrigins = ['https://shadjosef.github.io', 'https://studyos.no'];
  const prompt = 'Use Study-OS get_current_exercise to see what I am working on. Tutor me with one next step or hint at a time. Check my working and cite the relevant notes or page when helpful. Give the full solution only if I explicitly ask.';
  const sharingKey = 'study-os-live-tutor';
  const tab = crypto.randomUUID();
  const dialog = document.getElementById('tutor-dialog');
  const status = document.getElementById('tutor-status');
  let localSharing = false;
  try { localSharing = !web && sessionStorage.getItem(sharingKey) === 'yes'; } catch {}
  let popup;
  let paired = false;
  let lastSnapshot = '';
  let activity = 0;
  let timer;

  function send(state, beacon = false) {
    const message = { kind: 'study-os:tutor-context', tab, activity, state };
    if (web) {
      if (paired && popup && !popup.closed) popup.postMessage(message, localOrigin);
    } else if (localSharing) {
      const body = JSON.stringify(message);
      if (beacon) navigator.sendBeacon('/api/tutor/live', new Blob([body], { type: 'application/json' }));
      else fetch('/api/tutor/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        .then((response) => {
          if (!response.ok) status.textContent = 'Restart the desktop Study-OS server to enable live tutoring.';
        }).catch(() => { status.textContent = 'Open the desktop Study-OS app to reconnect.'; });
    }
  }

  function publish(refresh = false) {
    if (web ? !paired || popup?.closed : !localSharing) return;
    const state = window.StudyQuestionCopy.tutorContext();
    const snapshot = JSON.stringify(state);
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      activity = Math.max(activity + 1, Date.now());
    } else if (!refresh) return;
    send(state);
  }

  function changed() {
    clearTimeout(timer);
    timer = setTimeout(publish, 150);
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        status.textContent = 'Copied.';
        return;
      } catch {}
    }
    const field = document.getElementById('tutor-copy-text');
    field.hidden = false;
    field.value = value;
    field.select();
    status.textContent = 'Copy the selected text.';
  }

  async function copySetup(codex) {
    try {
      const response = await fetch('/api/tutor/config');
      if (!response.ok) throw new Error();
      const { script, port } = await response.json();
      const args = ['run', '--script', script, '--port', String(port)];
      await copyText(codex ? `[mcp_servers.study-os]\ncommand = "uv"\nargs = ${JSON.stringify(args)}`
        : JSON.stringify({ mcpServers: { 'study-os': { command: 'uv', args } } }, null, 2));
    } catch {
      status.textContent = 'Restart Study-OS to load the current desktop setup.';
    }
  }

  function isSharing() {
    return Boolean(web ? paired && !popup?.closed : localSharing);
  }

  function open() {
    const connect = document.getElementById('tutor-pair');
    const localControls = document.getElementById('tutor-local-controls');
    connect.hidden = !web;
    localControls.hidden = web;
    status.textContent = isSharing()
      ? 'Live exercise sharing is on.' : '';
    document.getElementById('tutor-copy-text').hidden = true;
    if (!dialog.open) dialog.showModal();
  }

  document.getElementById('tutor-pair').onclick = () => {
    if (popup && !popup.closed) {
      popup.focus();
      return;
    }
    paired = false;
    popup = window.open(`${localOrigin}/tutor-bridge.html?site=${encodeURIComponent(location.origin)}`, '_blank', 'popup,width=510,height=600');
    status.textContent = popup ? 'Confirm sharing in the desktop window.' : 'Allow the desktop window to open, then retry.';
    window.StudyUI?.updateSettingsIndicators?.();
  };
  document.getElementById('tutor-enable').onclick = () => {
    localSharing = true;
    lastSnapshot = '';
    try { sessionStorage.setItem(sharingKey, 'yes'); } catch {}
    status.textContent = 'Live exercise sharing is on.';
    publish(true);
    window.StudyUI?.updateSettingsIndicators?.();
  };
  document.getElementById('tutor-disable').onclick = () => {
    send({ mode: 'waiting' }, true);
    localSharing = paired = false;
    if (popup && !popup.closed) popup.close();
    try { sessionStorage.removeItem(sharingKey); } catch {}
    status.textContent = 'Live exercise sharing is off.';
    window.StudyUI?.updateSettingsIndicators?.();
  };
  document.getElementById('tutor-copy-prompt').onclick = () => copyText(prompt);
  document.getElementById('tutor-copy-codex').onclick = () => copySetup(true);
  document.getElementById('tutor-copy-config').onclick = () => copySetup(false);

  if (web && siteOrigins.includes(location.origin)) window.addEventListener('message', (event) => {
    if (event.origin !== localOrigin || event.source !== popup || event.data !== 'study-os:tutor-ready') return;
    paired = true;
    lastSnapshot = '';
    status.textContent = 'Live exercise sharing is on. Keep the desktop window open.';
    publish(true);
    window.StudyUI?.updateSettingsIndicators?.();
  });
  document.getElementById('view-runner').addEventListener('input', changed);
  window.addEventListener('pagehide', () => send({ mode: 'waiting' }, true));
  // Renew the local lease while studying, even when the AI window has keyboard focus.
  setInterval(() => publish(true), 10_000);
  return { open, changed, isSharing };
})();
