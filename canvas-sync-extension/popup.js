const status = document.getElementById('status');
const pair = document.getElementById('pair');
const code = document.getElementById('code');
const retry = document.getElementById('retry');
const study = document.getElementById('study');
const canvas = document.getElementById('canvas');

function pairing(message = 'Get a one-time connection code from Study-OS setup.') {
  status.textContent = message;
  pair.hidden = false;
  study.textContent = 'Open Study-OS setup';
}

async function sync() {
  status.textContent = 'Syncing Canvas courses and assignments…';
  pair.hidden = retry.hidden = canvas.hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({ action: 'sync', tabId: tab?.id });
    if (result.needsPair || result.state === 'pair') {
      pairing(result.error);
      return;
    }
    if (result.error) throw new Error(result.error);
    study.textContent = 'View in Study-OS';
    if (result.state === 'openCanvas') {
      status.textContent = 'Open BI Canvas, then click this extension to sync.';
      canvas.hidden = false;
      return;
    }
    const { courses, assignments } = result.summary;
    const count = (value, name) => `${value} ${name}${value === 1 ? '' : 's'}`;
    status.textContent = `Synced ${count(courses, 'course')} and ${count(assignments, 'assignment')}.`;
  } catch (error) {
    status.textContent = error.message;
  }
  retry.hidden = false;
}

pair.addEventListener('submit', async event => {
  event.preventDefault();
  const button = pair.querySelector('button');
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'link', code: code.value.trim() });
    if (result.error) throw new Error(result.error);
    code.value = '';
    await sync();
  } catch (error) {
    pairing(error.message);
  } finally {
    button.disabled = false;
  }
});

retry.addEventListener('click', sync);
sync();
