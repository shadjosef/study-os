'use strict';

window.StudyCommunity = (() => {
  const api = document.documentElement.dataset.communityApi;
  const keyName = 'study-os-community-profile';
  const { esc, toast, clockSec, workClock } = window.StudyUI;
  let token = '';
  let lastSync = '';
  let syncTimer;
  let lastPresence = '';
  let lastPresenceAt = 0;
  let presenceSync = Promise.resolve();
  let lastChatAt = 0;
  let chatLoading = false;
  let openingBreak = false;
  const canUse = () => workClock.canUseBreakTools() && !window.StudyRooms?.running();
  try { token = localStorage.getItem(keyName) || ''; } catch {}

  function useProfile(key) {
    localStorage.setItem(keyName, key);
    token = key;
    lastSync = '';
    lastPresence = '';
    lastPresenceAt = 0;
    clearTimeout(syncTimer);
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

  async function syncStats() {
    if (!api || !token) return;
    const key = token;
    const stats = window.StudyApp.communityStats();
    const snapshot = JSON.stringify(stats);
    if (snapshot === lastSync) return;
    await request('/stats', stats, key);
    if (token === key) lastSync = snapshot;
  }

  function queueStatsSync() {
    if (!api || !token) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncStats().catch(() => {}), 800);
  }

  function timerStatus() {
    const state = workClock.getState();
    const remaining = Math.ceil((Number(state.breakEndsAtMs || 0) - Date.now()) / 1000);
    if (state.mode === 'break' && remaining > 0) {
      return { mode: 'break', remaining: Math.min(1800, remaining), elapsed: 0, breakEndsAt: state.breakEndsAtMs };
    }
    if (state.mode === 'working') {
      return { mode: state.wavePausedSinceMs ? 'paused' : 'working', remaining: 0, elapsed: state.elapsedSec };
    }
    return { mode: 'idle', remaining: 0, elapsed: 0 };
  }

  function syncPresence(status = timerStatus()) {
    if (!api || !token) return Promise.resolve();
    const marker = status.mode + (status.breakEndsAt || '');
    if (marker === lastPresence && (status.mode === 'idle' || Date.now() - lastPresenceAt < 60_000)) {
      return presenceSync;
    }
    lastPresence = marker;
    lastPresenceAt = Date.now();
    const key = token;
    presenceSync = presenceSync.catch(() => {}).then(() => {
      if (token !== key) return;
      const { mode, remaining, elapsed } = timerStatus();
      return request('/presence', { mode, remaining, elapsed }, key);
    }).catch((error) => {
      if (token === key && lastPresence === marker) lastPresence = '';
      throw error;
    });
    return presenceSync;
  }

  function clockTick() {
    if (!api || !token) return;
    const state = timerStatus();
    if (state.mode !== 'idle' || (lastPresence && lastPresence !== 'idle')) syncPresence(state).catch(() => {});
    const root = document.getElementById('community-root');
    if (document.getElementById('view-community').hidden) return;
    const available = canUse();
    if (!available && root.querySelector('#community-social')) {
      renderLocked(root, root.querySelector('#community-signed-in').textContent);
    } else if (available && root.querySelector('#community-locked') && !openingBreak) {
      openingBreak = true;
      render().finally(() => { openingBreak = false; });
    } else if (available && Date.now() - lastChatAt >= 30_000) {
      refreshChat(root).catch(() => {});
    }
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

  const privacyNote = `
    <details class="panel">
      <summary>Community privacy and rules</summary>
      <p>Study-OS Community is run by the Study-OS project, independently of BI. Use a nickname. Keep private information, restricted course files and material from active assessments out of messages.</p>
      <p>Cloudflare stores your display name, study totals, room results, duel rating, chat posts, direct messages, shared study sets and block list. Only the sender and recipient see each direct message in the app.</p>
      <p>Study-OS keeps your most recent timer status, which expires when updates stop. Delete your profile to remove your leaderboard entry and message history from the active database. Cloudflare may retain database backups for a limited period.</p>
    </details>`;

  function renderEntry(root, error = '', onSignedIn = render) {
    root.innerHTML = `
      <section class="panel">
        <h1>Create your Study-OS profile</h1>
        <p id="community-stats-notice">Your display name, study hours, completed questions, attempts, accuracy and current study timer are visible to members during break access.</p>
        <form id="community-join" class="row-actions">
          <label class="field-label">Name on leaderboard <input name="nickname" type="text" minlength="2" maxlength="24" required></label>
          <label class="field-label">Community invite code <input name="invite" type="password" required autocomplete="off"></label>
          <button type="submit" class="primary-btn" aria-describedby="community-stats-notice">Create profile</button>
        </form>
        <form id="community-sign-in" class="row-actions">
          <label class="field-label">Personal profile key <input name="key" type="password" required autocomplete="off"></label>
          <button type="submit" class="ghost-btn">Use my profile</button>
        </form>
        <p id="community-status" role="status">${esc(error)}</p>
      </section>${privacyNote}`;
    const status = root.querySelector('#community-status');
    const join = root.querySelector('#community-join');
    action(join, async (form) => {
      const invite = form.get('invite').trim();
      if (!/^soci1_[A-Za-z0-9_-]{43}$/.test(invite)) throw new Error('Enter a valid Community invite code.');
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(invite)));
      const proof = [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
      const result = await request('/join', { nickname: form.get('nickname'), proof }, '');
      useProfile(result.token);
      await onSignedIn();
    }, status);
    action(root.querySelector('#community-sign-in'), async (form) => {
      const key = form.get('key').trim();
      await request('/profile', null, key);
      useProfile(key);
      await onSignedIn();
    }, status);
  }

  async function requireProfile() {
    if (!api) return;
    if (token) {
      try {
        await request('/profile');
        return;
      } catch (error) {
        if (error.status !== 401) return;
        useProfile('');
      }
    }
    const gate = document.getElementById('profile-gate');
    return new Promise((resolve) => {
      renderEntry(gate, '', () => {
        gate.close();
        queueStatsSync();
        resolve();
      });
      gate.oncancel = (event) => event.preventDefault();
      if (!gate.open) gate.showModal();
    });
  }

  function profileActions(root) {
    root.querySelector('#community-logout').onclick = async () => {
      useProfile('');
      window.StudyRooms?.reset();
      await requireProfile();
      await window.StudyRooms?.restore();
      await render();
    };
    root.querySelector('#community-delete').onclick = async () => {
      if (!window.confirm('Delete your Community profile, study totals and messages?')) return;
      try {
        await request('/delete-profile', { confirm: true });
        useProfile('');
        window.StudyRooms?.reset();
        await requireProfile();
        await window.StudyRooms?.restore();
        await render();
        toast('Community profile deleted.');
      } catch (error) {
        toast(error.message);
      }
    };
  }

  function renderLocked(root, nickname) {
    root.innerHTML = `
      <section class="panel" id="community-locked">
        <h1>Study community</h1>
        <p id="community-signed-in">Signed in as ${esc(nickname)}</p>
        <p>Community opens during a timed break and from 20:00 to midnight Oslo time.</p>
        <div class="row-actions">
          <button type="button" class="ghost-btn" id="community-logout">Sign out</button>
          <button type="button" class="ghost-btn" id="community-delete">Delete my profile</button>
        </div>
      </section>${privacyNote}`;
    profileActions(root);
  }

  function presenceLabel(row, now) {
    if (row.mode === 'break') return 'On break · ' + clockSec(Math.max(0, Math.ceil((row.break_ends_at - now) / 1000)));
    if (row.mode === 'working') return 'Studying · ' + clockSec(Math.min(4500, row.elapsed_seconds + Math.floor((now - row.updated_at) / 1000)));
    if (row.mode === 'paused') return 'Paused · ' + clockSec(row.elapsed_seconds);
    return '—';
  }

  async function refreshChat(root) {
    const list = root.querySelector('#community-chat-list');
    if (chatLoading || !list || !canUse()) return;
    chatLoading = true;
    lastChatAt = Date.now();
    try {
      const { messages } = await request('/chat');
      if (list.isConnected) list.innerHTML = messages.map((message) => `
        <li><div class="row-between"><strong>${esc(message.nickname)}</strong>
          <small>${esc(new Date(message.createdAt).toLocaleString())}</small></div>
          <p>${esc(message.message)}</p></li>`).join('') || '<li>No messages yet.</li>';
    } finally {
      chatLoading = false;
    }
  }

  async function renderStudySets(root, me) {
    const panel = root.querySelector('#community-study-sets');
    const { sets } = await request('/sets');
    if (!panel.isConnected) return;
    panel.innerHTML = `
      <p>Open a Study-OS link from your AI to share a new set. Practice here earns no leaderboard or Elo points.</p>
      <p id="community-set-status" role="status"></p>
      <ul class="community-messages">${sets.map((set) => `
        <li><strong>${esc(set.title)}</strong> <small>${set.card_count} cards · ${esc(set.nickname)}</small>
          <div class="row-actions">
            <button type="button" class="ghost-btn" data-save-community-set="${esc(set.id)}">Save to my sets</button>
            ${set.owner === me.id ? `<button type="button" class="ghost-btn" data-remove-community-set="${esc(set.id)}">Remove from Community</button>` : ''}
          </div></li>`).join('') || '<li>No shared sets yet.</li>'}</ul>`;
    const status = panel.querySelector('#community-set-status');
    for (const button of panel.querySelectorAll('[data-save-community-set], [data-remove-community-set]')) {
      button.onclick = async () => {
        button.disabled = true;
        try {
          if (button.dataset.saveCommunitySet) {
            const set = await request('/sets?id=' + encodeURIComponent(button.dataset.saveCommunitySet));
            window.StudySets.save(set);
            toast('Saved under My study sets on Home.');
          } else {
            await request('/sets', { action: 'remove', id: button.dataset.removeCommunitySet });
            await renderStudySets(root, me);
          }
        } catch (error) {
          status.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      };
    }
  }

  function renderDashboard(root, { me, ranks, hasMoreRanks, contacts, messages, blocked, now }, offset) {
    const leaderRows = ranks.map((row, index) => `<tr>
      <td>${offset + index + 1}</td><td>${esc(row.nickname)}</td><td>${(row.study_minutes / 60).toFixed(1)}</td>
      <td>${row.completed}</td><td>${row.attempts}</td><td>${row.attempts ? row.accuracy + '%' : '—'}</td><td>${presenceLabel(row, now)}</td>
    </tr>`).join('');
    const messageRows = messages.map((row) => `
      <li>
        <div class="row-between"><strong>${row.sender === me.id ? 'To ' + esc(row.recipientName) : 'From ' + esc(row.senderName)}</strong>
        <small>${esc(new Date(row.createdAt).toLocaleString())}</small></div>
        <p>${esc(row.message)}</p>
        ${row.sender === me.id ? '' : `<button type="button" class="ghost-btn" data-block-profile="${esc(row.sender)}">Block sender</button>`}
      </li>`).join('');
    root.innerHTML = `
      <section class="panel" id="community-social">
        <div class="row-between">
          <div><h1>Study community</h1><p class="muted">Signed in as <span id="community-signed-in">${esc(me.nickname)}</span></p></div>
          <div class="row-actions">
            <button type="button" class="ghost-btn" id="community-copy-key">Copy profile key</button>
            <button type="button" class="ghost-btn" id="community-logout">Sign out</button>
          </div>
        </div>
        <p class="muted">Keep your profile key to use your account on another device.</p>
        <p id="community-status" role="status"></p>
      </section>
      ${window.StudyRooms.lobbyHtml()}
      <section class="panel">
        <h2>Leaderboard</h2>
        <p class="muted">All Community profiles appear here. Practice stats use the browser with the most recorded attempts and update while you’re signed in.</p>
        <div class="row-actions">
          <button type="button" class="ghost-btn" id="community-stats">Refresh totals</button>
        </div>
        ${leaderRows ? `<div class="community-table"><table>
          <thead><tr><th>Rank</th><th>Nickname</th><th>Hours</th><th>Completed</th><th>Attempts</th><th>Accuracy</th><th>Current timer</th></tr></thead>
          <tbody>${leaderRows}</tbody></table></div>` : ''}
        ${offset || hasMoreRanks ? `<div class="row-actions">
          <button type="button" class="ghost-btn" id="community-ranks-prev" ${offset ? '' : 'disabled'}>Previous</button>
          <button type="button" class="ghost-btn" id="community-ranks-next" ${hasMoreRanks ? '' : 'disabled'}>Next</button>
        </div>` : ''}
      </section>
      <section class="panel">
        <div class="row-between"><h2>Global chat</h2><button type="button" class="ghost-btn" id="community-chat-refresh">Refresh</button></div>
        <p class="muted">All Community members can read these conversations during their breaks.</p>
        <form id="community-chat">
          <label class="field-label">Message <textarea name="message" rows="2" maxlength="1500" required></textarea></label>
          <button type="submit" class="primary-btn">Post to chat</button>
        </form>
        <ul class="community-messages" id="community-chat-list"></ul>
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
      </section>
      <details id="community-set-panel" class="panel">
        <summary>Shared study sets</summary>
        <div id="community-study-sets"></div>
      </details>
      ${privacyNote}
      <button type="button" class="ghost-btn" id="community-delete">Delete my profile</button>`;
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
    profileActions(root);
    window.StudyRooms.bindLobby(root);
    doAction(root.querySelector('#community-refresh'), () => render(offset));
    doAction(root.querySelector('#community-stats'), () => render(offset));
    doAction(root.querySelector('#community-ranks-prev'), () => render(offset - 50));
    doAction(root.querySelector('#community-ranks-next'), () => render(offset + 50));
    doAction(root.querySelector('#community-chat-refresh'), () => refreshChat(root));
    action(root.querySelector('#community-chat'), async (form) => {
      await request('/chat', { message: form.get('message') });
      root.querySelector('#community-chat')?.reset();
      await refreshChat(root);
    }, status);
    refreshChat(root).catch((error) => { status.textContent = error.message; });
    root.querySelector('#community-set-panel').ontoggle = (event) => {
      if (event.currentTarget.open) {
        renderStudySets(root, me).catch((error) => { status.textContent = error.message; });
      }
    };

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

  async function render(offset = 0) {
    if (!api) return;
    const root = document.getElementById('community-root');
    if (!token) {
      renderEntry(root);
      return;
    }
    try {
      await syncStats().catch(() => {});
      const state = timerStatus();
      if (!canUse()) {
        const { nickname } = await request('/profile');
        renderLocked(root, nickname);
        return;
      }
      const generation = token;
      await syncPresence(state);
      const result = await request('/dashboard?offset=' + offset);
      if (generation !== token) return;
      if (canUse()) renderDashboard(root, result, offset);
      else renderLocked(root, result.me.nickname);
    } catch (error) {
      if (error.status === 401) {
        useProfile('');
        await requireProfile();
        await render(offset);
      } else if (error.status === 423) {
        const { nickname } = await request('/profile');
        renderLocked(root, nickname);
      } else {
        root.innerHTML = '<section class="panel"><h1>Study community</h1><p>Community is unavailable. Open the Community tab to retry.</p></section>';
      }
    }
  }
  const canShareSet = () => Boolean(api && token);
  async function shareSet(set) {
    if (!canShareSet() || !canUse()) throw new Error('Sign in to Community and share during break access.');
    await syncPresence();
    if (!canUse()) throw new Error('Your break has ended.');
    return request('/sets', { title: set.title, cards: set.cards });
  }

  async function roomRequest(path = '', data) {
    if (canUse()) await syncPresence();
    return request('/rooms' + path, data);
  }

  return { enabled: Boolean(api), render, queueStatsSync, clockTick, canShareSet, shareSet, requireProfile, roomRequest };
})();
