const statusEl = document.getElementById('status');
const sitePill = document.getElementById('site-pill');
const pairForm = document.getElementById('pair');
const codeInput = document.getElementById('code');
const shareWrap = document.getElementById('share-wrap');
const shareCheckbox = document.getElementById('share-public');
const syncBtn = document.getElementById('sync-btn');
const disconnectBtn = document.getElementById('disconnect-btn');

const SITE_LABELS = {
  canvas: { pill: 'BI Canvas', btn: 'Sync Canvas courses & deadlines' },
  timeedit: { pill: 'BI TimeEdit', btn: 'Sync TimeEdit schedule' },
  ed: { pill: 'Ed Discussion', btn: 'Sync Ed courses' },
  other: { pill: 'Open a BI tab', btn: 'Sync this tab' },
};

let currentTabId = null;
let currentSite = 'other';

function showPair(message = 'Paste a 6-character device code from studyos.no to pair once.') {
  statusEl.textContent = message;
  pairForm.hidden = false;
  shareWrap.hidden = true;
  syncBtn.hidden = true;
  disconnectBtn.hidden = true;
}

async function refreshState(autoSync = false) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  const info = await chrome.runtime.sendMessage({ action: 'status', tabId: currentTabId });
  currentSite = info.site || 'other';
  const meta = SITE_LABELS[currentSite] || SITE_LABELS.other;
  sitePill.textContent = meta.pill;
  sitePill.classList.toggle('live', currentSite !== 'other');
  shareCheckbox.checked = info.sharePublic !== false;

  if (!info.connectedCloud && !info.connectedDesktop) {
    showPair();
    return;
  }

  pairForm.hidden = true;
  disconnectBtn.hidden = false;
  shareWrap.hidden = currentSite === 'timeedit';

  if (currentSite === 'other') {
    const who = info.nickname ? `Connected as ${info.nickname}. ` : 'Connected to Study-OS. ';
    statusEl.textContent = `${who}Open BI Canvas, TimeEdit, or Ed Discussion below, then click this extension to sync in 1 click.`;
    syncBtn.hidden = true;
    return;
  }

  syncBtn.textContent = meta.btn;
  syncBtn.hidden = false;
  if (autoSync) {
    await runSync();
  } else {
    const who = info.nickname ? `Connected as ${info.nickname} · ` : '';
    statusEl.textContent = `${who}Ready to sync ${meta.pill}.`;
  }
}

async function runSync() {
  syncBtn.disabled = true;
  const meta = SITE_LABELS[currentSite] || SITE_LABELS.other;
  statusEl.textContent = `Syncing ${meta.pill}…`;
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'sync',
      tabId: currentTabId,
      sharePublic: shareCheckbox.checked,
    });
    if (result.needsPair || result.state === 'pair') {
      showPair(result.error || 'Connection expired — paste a fresh 6-char device code.');
      return;
    }
    if (result.error) throw new Error(result.error);
    if (result.state === 'openSite') {
      statusEl.textContent = 'Open BI Canvas, TimeEdit, or Ed Discussion first, then click Sync.';
      return;
    }
    const s = result.summary || {};
    if (s.site === 'timeedit') {
      statusEl.textContent = `Synced TimeEdit timetable (${s.eventCount} events)! Open Schedule on studyos.no to view.`;
    } else if (s.site === 'ed') {
      const shareNote = s.sharedPublic
        ? ` (${s.createdCount} new, ${s.updatedCount} merged in Community)`
        : ' (private)';
      statusEl.textContent = `Synced ${s.courses} Ed course${s.courses === 1 ? '' : 's'}${shareNote}.`;
    } else {
      const shareNote = s.sharedPublic
        ? ` · ${s.createdCount} new, ${s.updatedCount} updated in Community`
        : ' · private';
      statusEl.textContent = `Synced ${s.courses} course${s.courses === 1 ? '' : 's'} & ${s.deadlines} deadline${s.deadlines === 1 ? '' : 's'}${shareNote}.`;
    }
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
  await chrome.runtime.sendMessage({ action: 'disconnect' });
  showPair('Disconnected. Paste a new 6-char code anytime to reconnect.');
});

refreshState(true);
