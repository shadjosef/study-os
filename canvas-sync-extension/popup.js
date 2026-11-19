const statusEl = document.getElementById('status');
const sitePill = document.getElementById('site-pill');
const resultsList = document.getElementById('results-list');
const pairForm = document.getElementById('pair');
const codeInput = document.getElementById('code');
const shareWrap = document.getElementById('share-wrap');
const shareCheckbox = document.getElementById('share-public');
const syncBtn = document.getElementById('sync-btn');
const disconnectBtn = document.getElementById('disconnect-btn');

const CHIP_MAP = {
  canvas: document.getElementById('chip-canvas'),
  timeedit: document.getElementById('chip-timeedit'),
  ed: document.getElementById('chip-ed'),
};

let openCount = 0;

function updateTabChips(openSites = {}) {
  openCount = 0;
  for (const key of ['canvas', 'timeedit', 'ed']) {
    const chip = CHIP_MAP[key];
    const detected = Boolean(openSites[key]);
    if (detected) openCount += 1;
    if (!chip) continue;
    chip.classList.toggle('detected', detected);
    const sub = chip.querySelector('.tab-chip-sub');
    if (sub) sub.textContent = detected ? '● Tab ready' : 'Open tab ↗';
  }
  sitePill.textContent = openCount ? `${openCount} tab${openCount === 1 ? '' : 's'} ready` : 'No BI tab open';
  sitePill.classList.toggle('live', openCount > 0);
}

function showPair(message = 'Paste a 6-character code from studyos.no → Sync BI to pair once.') {
  statusEl.textContent = message;
  resultsList.hidden = true;
  pairForm.hidden = false;
  shareWrap.hidden = true;
  syncBtn.hidden = true;
  disconnectBtn.hidden = true;
}

function formatResultLine(item) {
  const s = item.summary || {};
  if (!item.ok) {
    const name = item.site === 'canvas' ? 'BI Canvas' : item.site === 'timeedit' ? 'TimeEdit' : 'Ed';
    return { cls: 'err', text: `✕ ${name}: ${item.error}` };
  }
  if (item.site === 'timeedit') {
    return { cls: 'ok', text: `✓ TimeEdit: ${s.eventCount || 0} classes synced to Schedule` };
  }
  if (item.site === 'ed') {
    const note = s.sharedPublic ? ` (${s.createdCount} new, ${s.updatedCount} merged)` : ' (private)';
    return { cls: 'ok', text: `✓ Ed: ${s.courses} course${s.courses === 1 ? '' : 's'}${note}` };
  }
  const note = s.sharedPublic ? ` · ${s.createdCount} new, ${s.updatedCount} merged` : ' · private';
  return {
    cls: 'ok',
    text: `✓ Canvas: ${s.courses} course${s.courses === 1 ? '' : 's'}, ${s.deadlines} deadlines${note}`,
  };
}

async function refreshState(autoSync = false) {
  const info = await chrome.runtime.sendMessage({ action: 'status' });
  updateTabChips(info.openSites || {});
  shareCheckbox.checked = info.sharePublic !== false;

  if (!info.connectedCloud && !info.connectedDesktop) {
    showPair();
    return;
  }

  pairForm.hidden = true;
  disconnectBtn.hidden = false;
  shareWrap.hidden = false;

  if (openCount === 0) {
    const who = info.nickname ? `Connected as ${info.nickname}. ` : 'Connected to Study-OS. ';
    statusEl.textContent = `${who}Open your signed-in BI Canvas, TimeEdit, or Ed tabs above, then click this extension once.`;
    syncBtn.hidden = true;
    return;
  }

  syncBtn.textContent = openCount === 1 ? 'Sync open tab now' : `Sync all ${openCount} open tabs`;
  syncBtn.hidden = false;

  if (autoSync) {
    await runSync();
  } else {
    const who = info.nickname ? `Connected as ${info.nickname} · ` : '';
    statusEl.textContent = `${who}Ready to sync ${openCount} open tab${openCount === 1 ? '' : 's'} in 1 click.`;
  }
}

async function runSync() {
  syncBtn.disabled = true;
  resultsList.hidden = true;
  statusEl.textContent = openCount > 1 ? `Syncing ${openCount} open tabs to Study-OS…` : 'Syncing to Study-OS…';
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'syncAll',
      sharePublic: shareCheckbox.checked,
    });
    if (result.needsPair || result.state === 'pair') {
      showPair(result.error || 'Connection expired — paste a fresh 6-char code.');
      return;
    }
    if (result.error) throw new Error(result.error);
    if (result.state === 'openSite') {
      statusEl.textContent = 'Open BI Canvas, TimeEdit, or Ed Discussion first, then click Sync.';
      return;
    }
    const items = Array.isArray(result.results) ? result.results : [];
    const okCount = items.filter((r) => r.ok).length;
    statusEl.textContent = okCount === items.length
      ? 'Sync complete! Refresh studyos.no to see your updated courses & schedule.'
      : `Synced ${okCount}/${items.length} tabs — check details below.`;
    resultsList.innerHTML = '';
    for (const item of items) {
      const { cls, text } = formatResultLine(item);
      const li = document.createElement('li');
      li.className = cls;
      li.textContent = text;
      resultsList.appendChild(li);
    }
    resultsList.hidden = items.length === 0;
    syncBtn.textContent = 'Sync again';
  } catch (err) {
    statusEl.textContent = err.message || 'Sync failed.';
  } finally {
    syncBtn.disabled = false;
  }
}

pairForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const btn = pairForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  statusEl.textContent = 'Connecting…';
  try {
    const res = await chrome.runtime.sendMessage({ action: 'link', code: codeInput.value.trim() });
    if (res.error) throw new Error(res.error);
    codeInput.value = '';
    await refreshState(true);
  } catch (err) {
    showPair(err.message || 'Could not pair code.');
  } finally {
    btn.disabled = false;
  }
});

shareCheckbox.addEventListener('change', () => {
  chrome.runtime.sendMessage({ action: 'setSharePublic', sharePublic: shareCheckbox.checked });
});

syncBtn.addEventListener('click', runSync);

disconnectBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(['cloudToken', 'cloudNickname', 'token']).catch(() => {});
  await chrome.runtime.sendMessage({ action: 'disconnect' });
  showPair('Disconnected. Paste a new 6-char code anytime to reconnect.');
});

refreshState(true);
