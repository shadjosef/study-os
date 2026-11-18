'use strict';

window.StudyCommunity = (() => {
  const api = document.documentElement.dataset.communityApi;
  const keyName = 'study-os-community-profile';
  const { esc, toast } = window.StudyUI;
  let token = '';
  try { token = localStorage.getItem(keyName) || ''; } catch {}

  function useProfile(key) {
    localStorage.setItem(keyName, key);
    token = key;
  }

  async function request(path, data, key = token) {
    const response = await fetch(api + path, {
      method: data ? 'POST' : 'GET',
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}) },
      body: data ? JSON.stringify(data) : undefined,
      credentials: 'omit',
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || 'Could not reach the community.');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function action(form, handler, status) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type=submit]');
      submit.disabled = true;
      status.textContent = '';
      try {
        await handler(new FormData(form));
      } catch (error) {
        status.textContent = error.message || 'Could not complete that action.';
      } finally {
        submit.disabled = false;
      }
    });
  }

  function renderEntry(root, error = '') {
    const proof = window.StudyMembers.communityProof();
    root.innerHTML = `
      <section class="panel">
        <h1>Study community</h1>
        <p class="muted">Use a nickname for the leaderboard and direct messages. Your study details stay private until you choose to share your totals.</p>
        ${proof ? `<form id="community-join" class="row-actions">
          <label class="field-label">Nickname <input name="nickname" type="text" minlength="2" maxlength="24" required></label>
          <button type="submit" class="primary-btn">Create profile</button>
        </form>` : '<p>Unlock the full library on Home to create a profile.</p>'}
        <form id="community-sign-in" class="row-actions">
          <label class="field-label">Personal profile key <input name="key" type="password" required autocomplete="off"></label>
          <button type="submit" class="ghost-btn">Use my profile</button>
        </form>
        <p id="community-status" role="status">${esc(error)}</p>
      </section>`;
    const status = root.querySelector('#community-status');
    const join = root.querySelector('#community-join');
    if (join) action(join, async (form) => {
      const result = await request('/join', { nickname: form.get('nickname'), proof }, '');
      useProfile(result.token);
      await render();
    }, status);
    action(root.querySelector('#community-sign-in'), async (form) => {
      const key = form.get('key').trim();
      const result = await request('/dashboard', null, key);
      useProfile(key);
      renderDashboard(root, result);
    }, status);
  }

  function renderDashboard(root, { me, ranks, contacts, messages, blocked }) {
    const leaderRows = ranks.map((row, index) => `<tr>
      <td>${index + 1}</td><td>${esc(row.nickname)}</td><td>${(row.study_minutes / 60).toFixed(1)}</td>
      <td>${row.completed}</td><td>${row.attempts}</td><td>${row.attempts ? row.accuracy + '%' : '—'}</td>
    </tr>`).join('');
    const messageRows = messages.map((row) => `
      <li>
        <div class="row-between"><strong>${row.sender === me.id ? 'To ' + esc(row.recipientName) : 'From ' + esc(row.senderName)}</strong>
        <small>${esc(new Date(row.createdAt).toLocaleString())}</small></div>
        <p>${esc(row.message)}</p>
        ${row.sender === me.id ? '' : `<button type="button" class="ghost-btn" data-block-profile="${esc(row.sender)}">Block sender</button>`}
      </li>`).join('');
    root.innerHTML = `
      <section class="panel">
        <div class="row-between">
          <div><h1>Study community</h1><p class="muted">Signed in as ${esc(me.nickname)}</p></div>
          <div class="row-actions">
            <button type="button" class="ghost-btn" id="community-copy-key">Copy profile key</button>
            <button type="button" class="ghost-btn" id="community-logout">Sign out</button>
          </div>
        </div>
        <p class="muted">Keep your profile key to use your account on another device.</p>
        <p id="community-status" role="status"></p>
      </section>
      <section class="panel">
        <h2>Leaderboard</h2>
        <p class="muted">Only shared totals appear. Stats are taken from the browser of each member who chooses to share.</p>
        <div class="row-actions">
          <button type="button" class="primary-btn" id="community-stats">${me.share_stats ? 'Update my totals' : 'Share my totals'}</button>
          ${me.share_stats ? '<button type="button" class="ghost-btn" id="community-hide">Hide my totals</button>' : ''}
        </div>
        ${leaderRows ? `<div class="community-table"><table>
          <thead><tr><th>Rank</th><th>Nickname</th><th>Hours</th><th>Completed</th><th>Attempts</th><th>Accuracy</th></tr></thead>
          <tbody>${leaderRows}</tbody></table></div>` : '<p class="muted">No one has shared their totals yet.</p>'}
      </section>
      <section class="panel">
        <div class="row-between"><h2>Messages</h2><button type="button" class="ghost-btn" id="community-refresh">Refresh</button></div>
        ${contacts.length ? `<form id="community-message">
          <label class="field-label">Recipient <select name="recipient">${contacts.map((p) => `<option value="${esc(p.id)}">${esc(p.nickname)}</option>`).join('')}</select></label>
          <label class="field-label">Message <textarea name="message" rows="3" maxlength="1500" required></textarea></label>
          <button type="submit" class="primary-btn">Send message</button>
        </form>` : '<p class="muted">Messages become available when another member joins.</p>'}
        <ul class="community-messages">${messageRows}</ul>
        ${blocked.length ? `<details><summary>Blocked members</summary>${blocked.map((p) =>
          `<p>${esc(p.nickname)} <button type="button" class="ghost-btn" data-unblock-profile="${esc(p.id)}">Unblock</button></p>`).join('')}</details>` : ''}
      </section>`;
    const status = root.querySelector('#community-status');
    const doAction = (element, handler) => {
      if (!element) return;
      element.onclick = async () => {
        element.disabled = true;
        try { await handler(); } catch (error) { status.textContent = error.message; }
        finally { element.disabled = false; }
      };
    };
    doAction(root.querySelector('#community-copy-key'), async () => {
      await navigator.clipboard.writeText(token);
      status.textContent = 'Profile key copied. Keep it somewhere private.';
    });
    doAction(root.querySelector('#community-logout'), async () => {
      useProfile('');
      await render();
    });
    doAction(root.querySelector('#community-refresh'), render);
    doAction(root.querySelector('#community-stats'), async () => {
      const stats = window.StudyApp.communityStats();
      await request('/stats', { share: true, ...stats });
      await render();
      toast('Your totals are on the leaderboard.');
    });
    doAction(root.querySelector('#community-hide'), async () => {
      await request('/stats', { share: false });
      await render();
      toast('Your totals are hidden.');
    });

    const messageForm = root.querySelector('#community-message');
    if (messageForm) action(messageForm, async (form) => {
      await request('/message', { recipient: form.get('recipient'), message: form.get('message') });
      await render();
      toast('Message sent.');
    }, status);
    for (const button of root.querySelectorAll('[data-block-profile], [data-unblock-profile]')) {
      doAction(button, async () => {
        await request('/block', { profile: button.dataset.blockProfile || button.dataset.unblockProfile,
          blocked: Boolean(button.dataset.blockProfile) });
        await render();
      });
    }
  }

  async function render() {
    if (!api) return;
    const root = document.getElementById('community-root');
    if (!token) {
      renderEntry(root);
      return;
    }
    try {
      renderDashboard(root, await request('/dashboard'));
    } catch (error) {
      renderEntry(root, error.status === 401 ? 'Enter a current profile key or create a new profile.' : 'The community is unavailable. Please try again.');
    }
  }
  return { enabled: Boolean(api), render };
})();
