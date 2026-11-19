'use strict';

window.StudyCommunity = (() => {
  const api = document.documentElement.dataset.communityApi;
  const keyName = 'study-os-community-profile';
  const demoKey = 'study-os-demo';
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

  function renderEntry(root, error = '', onSignedIn = render, onDemo) {
    root.innerHTML = `
      <section class="panel">
        ${onDemo ? '<div class="row-actions" style="margin-bottom:8px"><button type="button" class="primary-btn" id="community-demo">Try demo (no code needed)</button></div><p class="muted" style="margin-top:0">Explore practice questions and study notes without an invite code.</p>' : ''}
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
    if (onDemo) root.querySelector('#community-demo').onclick = onDemo;
    const join = root.querySelector('#community-join');
    action(join, async (form) => {
      const invite = form.get('invite').trim();
      if (!/^\S{6,120}$/.test(invite)) throw new Error('Enter a valid Community invite code.');
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

  async function requireProfile({ allowDemo = false, forcePrompt = false } = {}) {
    if (!api) return true;
    if (token) {
      try {
        await request('/profile');
        return true;
      } catch (error) {
        if (error.status !== 401) return true;
        useProfile('');
      }
    }
    if (allowDemo && !forcePrompt) {
      try { if (sessionStorage.getItem(demoKey)) return false; } catch {}
    }
    const gate = document.getElementById('profile-gate');
    return new Promise((resolve) => {
      const tryDemo = () => {
        try { sessionStorage.setItem(demoKey, '1'); } catch {}
        gate.close();
        resolve(false);
      };
      renderEntry(gate, '', () => {
        gate.close();
        try { sessionStorage.removeItem(demoKey); } catch {}
        queueStatsSync();
        resolve(true);
      }, allowDemo ? tryDemo : undefined);
      gate.oncancel = (event) => {
        event.preventDefault();
        if (allowDemo) tryDemo();
      };
      if (!gate.open) gate.showModal();
    });
  }

  function profileActions(root) {
    root.querySelector('#community-logout').onclick = async () => {
      useProfile('');
      window.StudyRooms?.reset();
      await requireProfile({ allowDemo: true, forcePrompt: true });
      await window.StudyRooms?.restore();
      await render();
    };
    root.querySelector('#community-delete').onclick = async () => {
      if (!window.confirm('Delete your Community profile, study totals and messages?')) return;
      try {
        await request('/delete-profile', { confirm: true });
        useProfile('');
        window.StudyRooms?.reset();
        await requireProfile({ allowDemo: true, forcePrompt: true });
        await window.StudyRooms?.restore();
        await render();
        toast('Community profile deleted.');
      } catch (error) {
        toast(error.message);
      }
    };
  }

  const AVATAR_PRESETS = [
    { id: 'owl', glyph: '🦉', bg: '#2c4c6e' },
    { id: 'fox', glyph: '🦊', bg: '#9a4c28' },
    { id: 'cat', glyph: '🐱', bg: '#6d3b8e' },
    { id: 'penguin', glyph: '🐧', bg: '#285e6b' },
    { id: 'rocket', glyph: '🚀', bg: '#29487d' },
    { id: 'book', glyph: '📚', bg: '#1f6b58' },
    { id: 'coffee', glyph: '☕', bg: '#704b31' },
    { id: 'spark', glyph: '⚡', bg: '#8a6116' },
    { id: 'mountain', glyph: '🏔️', bg: '#375c4b' },
    { id: 'cactus', glyph: '🌵', bg: '#2e6f40' },
  ];
  const AVATAR_DATA_RE = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]{16,28000}$/;
  const INITIAL_COLORS = ['#1f6b58', '#29577a', '#6d3b8e', '#8a5a19', '#943c4c', '#2e655f', '#4e4c8a', '#6f4e37'];

  function avatarInitials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function avatarColor(name) {
    let hash = 0;
    const str = String(name || '');
    for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    return INITIAL_COLORS[Math.abs(hash) % INITIAL_COLORS.length];
  }

  function avatarHtml(nickname, avatar = '', size = 30) {
    const safeSize = Math.max(20, Math.min(96, Number(size) || 30));
    const val = String(avatar || '').trim();
    if (AVATAR_DATA_RE.test(val)) {
      return `<img class="community-avatar" src="${esc(val)}" alt="" width="${safeSize}" height="${safeSize}" style="width:${safeSize}px;height:${safeSize}px" loading="lazy" decoding="async">`;
    }
    if (val.startsWith('preset:')) {
      const preset = AVATAR_PRESETS.find((item) => item.id === val.slice(7));
      if (preset) {
        const fontSize = Math.round(safeSize * 0.54);
        return `<span class="community-avatar community-avatar-preset" aria-hidden="true" style="width:${safeSize}px;height:${safeSize}px;background:${preset.bg};font-size:${fontSize}px">${preset.glyph}</span>`;
      }
    }
    const fontSize = Math.round(safeSize * 0.4);
    return `<span class="community-avatar community-avatar-initials" aria-hidden="true" style="width:${safeSize}px;height:${safeSize}px;background:${avatarColor(nickname)};font-size:${fontSize}px">${esc(avatarInitials(nickname))}</span>`;
  }

  function resizeAvatarFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\/(?:png|jpeg|webp|gif)$/i.test(file.type || '')) {
        reject(new Error('Choose a PNG, JPEG, WebP, or GIF image.'));
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        reject(new Error('Choose an image smaller than 10 MB.'));
        return;
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
        const sx = Math.floor(((img.naturalWidth || img.width) - side) / 2);
        const sy = Math.floor(((img.naturalHeight || img.height) - side) / 2);
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 96;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, side, side, 0, 0, 96, 96);
        let out = '';
        for (const [mime, q] of [['image/webp', 0.82], ['image/webp', 0.65], ['image/jpeg', 0.82], ['image/jpeg', 0.62]]) {
          const candidate = canvas.toDataURL(mime, q);
          if (AVATAR_DATA_RE.test(candidate)) {
            out = candidate;
            break;
          }
        }
        if (!out) reject(new Error('Could not compress that image small enough. Try a simpler image.'));
        else resolve(out);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read that image file.'));
      };
      img.src = url;
    });
  }

  function formatOsloDate(ms) {
    return new Date(ms).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Oslo',
    });
  }

  function profileEditorHtml(profile) {
    const lockedUntil = !profile.isAdmin && profile.nextNicknameChangeAt > Date.now()
      ? formatOsloDate(profile.nextNicknameChangeAt)
      : '';
    const nickHint = profile.isAdmin
      ? '<span class="badge admin-badge">Admin · unlimited nickname edits</span>'
      : lockedUntil
      ? `<span class="badge warn">Nickname locked until ${esc(lockedUntil)} (once per 30 days)</span>`
      : '<small class="muted">You can change your nickname once every 30 days. Avatar and bio can be updated anytime.</small>';

    return `
      <details class="community-profile-editor" id="community-profile-editor">
        <summary class="ghost-btn" style="display:inline-flex">Edit profile &amp; PFP</summary>
        <form id="community-profile-form" class="community-profile-form">
          <div class="community-profile-preview-row">
            <div id="community-avatar-preview">${avatarHtml(profile.nickname, profile.avatar, 60)}</div>
            <div style="flex:1;min-width:200px">
              <div class="row-actions">
                <label class="ghost-btn" style="cursor:pointer">
                  Upload photo
                  <input type="file" id="community-avatar-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
                </label>
                <button type="button" class="ghost-btn" id="community-avatar-reset">Use initials</button>
              </div>
              <small class="muted" style="display:block;margin-top:4px">Auto-cropped to a 96×96 circle. Or pick a preset below:</small>
            </div>
          </div>
          <div class="avatar-preset-grid" role="group" aria-label="Preset avatars">
            ${AVATAR_PRESETS.map((p) => `
              <button type="button" class="avatar-preset-btn ${profile.avatar === 'preset:' + p.id ? 'active' : ''}"
                data-avatar-preset="preset:${p.id}" title="${esc(p.id)}" style="background:${p.bg}">${p.glyph}</button>
            `).join('')}
          </div>
          <label class="field-label">Nickname
            <input name="nickname" value="${esc(profile.nickname)}" minlength="2" maxlength="24" required
              ${lockedUntil ? 'readonly aria-readonly="true"' : ''}>
          </label>
          <div style="margin:-4px 0 8px">${nickHint}</div>
          <label class="field-label">Short bio / study focus <small class="muted">(optional, up to 140 chars)</small>
            <input name="bio" value="${esc(profile.bio || '')}" maxlength="140" placeholder="e.g. BSc Data Science · Grinding OB &amp; Maths">
          </label>
          <div class="row-actions">
            <button type="submit" class="primary-btn">Save profile</button>
          </div>
          <p id="community-profile-status" class="muted" role="status"></p>
        </form>
      </details>`;
  }

  function bindProfileEditor(root, profile, onSaved) {
    const form = root.querySelector('#community-profile-form');
    if (!form) return;
    const status = root.querySelector('#community-profile-status');
    const preview = root.querySelector('#community-avatar-preview');
    const fileInput = root.querySelector('#community-avatar-file');
    const nickInput = form.elements.nickname;
    let draftAvatar = profile.avatar || '';

    const refreshPreview = () => {
      preview.innerHTML = avatarHtml(nickInput.value.trim() || profile.nickname, draftAvatar, 60);
      for (const btn of form.querySelectorAll('[data-avatar-preset]')) {
        btn.classList.toggle('active', btn.dataset.avatarPreset === draftAvatar);
      }
    };

    nickInput.addEventListener('input', refreshPreview);
    for (const btn of form.querySelectorAll('[data-avatar-preset]')) {
      btn.onclick = () => {
        draftAvatar = btn.dataset.avatarPreset;
        status.textContent = '';
        refreshPreview();
      };
    }
    root.querySelector('#community-avatar-reset').onclick = () => {
      draftAvatar = '';
      if (fileInput) fileInput.value = '';
      status.textContent = '';
      refreshPreview();
    };
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      status.textContent = 'Preparing avatar…';
      try {
        draftAvatar = await resizeAvatarFile(file);
        status.textContent = 'Photo ready — click Save profile to apply.';
        refreshPreview();
      } catch (err) {
        status.textContent = err.message;
      }
      fileInput.value = '';
    });

    form.onsubmit = async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type=submit]');
      submit.disabled = true;
      status.textContent = 'Saving profile…';
      try {
        const payload = {
          avatar: draftAvatar,
          bio: String(form.elements.bio.value || '').trim(),
        };
        const candidateNick = String(nickInput.value || '').trim();
        if (candidateNick && candidateNick !== profile.nickname) {
          payload.nickname = candidateNick;
        }
        await request('/profile', payload);
        toast('Profile updated.');
        await onSaved();
      } catch (error) {
        status.textContent = error.message || 'Could not update profile.';
        submit.disabled = false;
      }
    };
  }

  function formatBreakDuration(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }

  function breakSummaryData(row) {
    const breakMin = Math.max(0, Number(row.break_minutes) || 0);
    const breakCount = Math.max(0, Number(row.break_count) || 0);
    const studyMin = Math.max(0, Number(row.study_minutes) || 0);
    const avgMin = breakCount ? Math.round((breakMin / breakCount) * 10) / 10 : 0;
    const perHour = studyMin >= 15 && breakCount
      ? Math.round((breakCount / (studyMin / 60)) * 10) / 10
      : null;
    const ratioPct = studyMin >= 15 && breakMin
      ? Math.round((100 * breakMin) / studyMin)
      : null;
    return { breakMin, breakCount, studyMin, avgMin, perHour, ratioPct };
  }

  function breakCellHtml(row) {
    const b = breakSummaryData(row);
    if (!b.breakCount && !b.breakMin) return '<span class="muted">—</span>';
    const subParts = [];
    if (b.avgMin) subParts.push(`${b.avgMin}m avg`);
    if (b.perHour !== null) subParts.push(`${b.perHour}/hr`);
    else if (b.ratioPct !== null) subParts.push(`${b.ratioPct}% ratio`);
    return `<div class="community-break-cell">
      <strong>${esc(formatBreakDuration(b.breakMin))} · ${b.breakCount}×</strong>
      ${subParts.length ? `<small class="muted">${esc(subParts.join(' · '))}</small>` : ''}
    </div>`;
  }

  function profileBreakStripHtml(me) {
    const localBrk = workClock.getBreakStats?.() || { totalBreakMinutes: 0, totalBreaks: 0, dayBreaks: 0, dayBreakMinutes: 0 };
    const merged = {
      study_minutes: Math.max(Number(me.study_minutes) || 0, 0),
      break_minutes: Math.max(Number(me.break_minutes) || 0, Number(localBrk.totalBreakMinutes) || 0),
      break_count: Math.max(Number(me.break_count) || 0, Number(localBrk.totalBreaks) || 0),
    };
    const b = breakSummaryData(merged);
    const freqLabel = b.perHour !== null
      ? `${b.perHour} breaks / study hr`
      : b.breakCount
      ? `${b.breakCount} total`
      : 'No breaks yet';
    const avgLabel = b.avgMin ? `${b.avgMin}m avg` : '—';
    const todayLabel = localBrk.dayBreaks
      ? `${localBrk.dayBreaks} today (${formatBreakDuration(localBrk.dayBreakMinutes)})`
      : '0 today';
    return `
      <div class="community-break-strip" aria-label="Break tracking summary">
        <span class="kpi-pill"><small>Break time</small> <b>${esc(formatBreakDuration(b.breakMin))}</b></span>
        <span class="kpi-pill"><small>Breaks</small> <b>${b.breakCount}</b></span>
        <span class="kpi-pill"><small>Frequency</small> <b>${esc(freqLabel)}</b></span>
        <span class="kpi-pill"><small>Avg break</small> <b>${esc(avgLabel)}</b></span>
        ${b.ratioPct !== null ? `<span class="kpi-pill"><small>Break / study</small> <b>${b.ratioPct}%</b></span>` : ''}
        <span class="kpi-pill"><small>Today</small> <b>${esc(todayLabel)}</b></span>
      </div>`;
  }

  function adminPanelHtml(me) {
    if (!me?.isAdmin) return '';
    return `
      <details class="panel community-admin-panel" id="community-admin-panel">
        <summary><strong>Admin · Join strings, access &amp; members</strong> <span class="badge admin-badge">Admin only</span></summary>
        <div id="community-admin-body" style="margin-top:12px">
          <p class="muted">Open to load invite codes, signup settings, and member controls…</p>
        </div>
      </details>`;
  }

  function bindAdminPanel(root, me) {
    const panel = root.querySelector('#community-admin-panel');
    if (!panel || !me?.isAdmin) return;
    let lastCreatedCode = '';

    async function loadAdmin() {
      const body = panel.querySelector('#community-admin-body');
      if (!body) return;
      body.innerHTML = '<p class="muted">Loading admin controls…</p>';
      try {
        const overview = await request('/admin/overview');
        if (!body.isConnected) return;
        renderAdminBody(body, overview);
      } catch (err) {
        body.innerHTML = `<p class="muted">${esc(err.message || 'Could not load admin controls.')}</p>`;
      }
    }

    function renderAdminBody(body, { settings, invites, members, now }) {
      const inviteRows = (invites || []).map((inv) => {
        const expired = inv.expiresAt > 0 && inv.expiresAt <= now;
        const full = inv.maxUses > 0 && inv.uses >= inv.maxUses;
        const badge = inv.revoked
          ? '<span class="badge bad">Revoked</span>'
          : expired
          ? '<span class="badge warn">Expired</span>'
          : full
          ? '<span class="badge warn">Full</span>'
          : '<span class="badge good">Active</span>';
        const usesLabel = inv.maxUses > 0 ? `${inv.uses} / ${inv.maxUses}` : `${inv.uses} / ∞`;
        const expLabel = inv.expiresAt > 0 ? formatOsloDate(inv.expiresAt) : 'Never';
        return `<tr>
          <td><strong>${esc(inv.label || 'Invite')}</strong><br><small class="muted"><code>${esc(inv.hint)}</code></small></td>
          <td>${usesLabel}</td>
          <td>${esc(expLabel)}</td>
          <td>${badge}</td>
          <td>
            <div class="row-actions">
              <button type="button" class="ghost-btn" data-inv-act="${inv.revoked ? 'restore' : 'revoke'}" data-inv-id="${esc(inv.id)}" style="padding:4px 9px;font-size:12px">${inv.revoked ? 'Restore' : 'Revoke'}</button>
              <button type="button" class="ghost-btn" data-inv-act="delete" data-inv-id="${esc(inv.id)}" style="padding:4px 9px;font-size:12px">Delete</button>
            </div>
          </td>
        </tr>`;
      }).join('');

      const memberRows = (members || []).map((m) => {
        const isSelf = m.id === me.id;
        const locked = !isSelf && m.nicknameChangedAt > 0 && m.nicknameChangedAt + 30 * 86_400_000 > now;
        return `<tr>
          <td><span class="community-member-inline">${avatarHtml(m.nickname, m.avatar, 26)}<strong>${esc(m.nickname)}</strong>${isSelf ? ' <span class="badge admin-badge">You</span>' : ''}</span></td>
          <td>${(m.studyMinutes / 60).toFixed(1)}h · ${m.completed} Qs</td>
          <td>${m.breakCount ? `${formatBreakDuration(m.breakMinutes)} · ${m.breakCount}×` : '—'}</td>
          <td>${locked ? `<span class="badge warn">Locked until ${esc(formatOsloDate(m.nicknameChangedAt + 30 * 86_400_000))}</span>` : '<span class="badge good">Unlocked</span>'}</td>
          <td>
            <div class="row-actions">
              <button type="button" class="ghost-btn" data-mem-rename="${esc(m.id)}" data-mem-name="${esc(m.nickname)}" style="padding:4px 9px;font-size:12px">Rename</button>
              ${locked ? `<button type="button" class="ghost-btn" data-mem-reset="${esc(m.id)}" style="padding:4px 9px;font-size:12px">Reset 30d lock</button>` : ''}
              ${isSelf ? '' : `<button type="button" class="ghost-btn" data-mem-remove="${esc(m.id)}" data-mem-name="${esc(m.nickname)}" style="padding:4px 9px;font-size:12px">Remove</button>`}
            </div>
          </td>
        </tr>`;
      }).join('');

      body.innerHTML = `
        <div class="admin-section">
          <div class="row-between">
            <h3>Joining access</h3>
            <button type="button" class="ghost-btn" id="admin-refresh-btn" style="padding:4px 10px;font-size:12.5px">Refresh</button>
          </div>
          <div class="admin-toggles">
            <label class="check-row">
              <input type="checkbox" id="admin-toggle-signups" ${settings.signupsOpen ? 'checked' : ''}>
              <span><strong>Allow new signups</strong> <small class="muted">(uncheck to pause all new Community joins immediately)</small></span>
            </label>
            ${settings.hasEnvJoinProof ? `
              <label class="check-row">
                <input type="checkbox" id="admin-toggle-env-join" ${settings.envJoinEnabled ? 'checked' : ''}>
                <span><strong>Allow original Wrangler env invite code</strong> <small class="muted">(uncheck to rely only on invite codes created below)</small></span>
              </label>` : ''}
          </div>
          <p id="admin-action-status" class="muted" role="status"></p>
        </div>

        <div class="admin-section">
          <h3>Create join string / invite code</h3>
          <form id="admin-create-invite" class="admin-invite-form">
            <label class="field-label">Label <input name="label" maxlength="60" placeholder="e.g. OB Class Nov 2026"></label>
            <label class="field-label">Max uses <small class="muted">(0 = unlimited)</small> <input name="maxUses" type="number" min="0" max="10000" value="0"></label>
            <label class="field-label">Expires in days <small class="muted">(0 = never)</small> <input name="expiresInDays" type="number" min="0" max="365" value="0"></label>
            <label class="field-label">Custom join string <small class="muted">(optional, 6–120 chars, no spaces — leave blank to auto-generate secure <code>soci1_…</code>)</small>
              <input name="customCode" maxlength="120" autocomplete="off" spellcheck="false" placeholder="Leave blank for random soci1_... code">
            </label>
            <div class="row-actions">
              <button type="submit" class="primary-btn">Create join string</button>
            </div>
          </form>
          ${lastCreatedCode ? `
            <div class="admin-created-code">
              <div>
                <strong>New join string (shown once — copy it now):</strong>
                <code id="admin-new-code-text" style="display:block;margin-top:4px;word-break:break-all">${esc(lastCreatedCode)}</code>
              </div>
              <button type="button" class="primary-btn" id="admin-copy-new-code">Copy join string</button>
            </div>` : ''}
          ${inviteRows ? `<div class="community-table" style="margin-top:10px"><table>
            <thead><tr><th>Invite</th><th>Uses</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${inviteRows}</tbody></table></div>` : '<p class="muted" style="margin-top:8px">No custom invite codes created yet.</p>'}
        </div>

        <div class="admin-section">
          <h3>Members (${(members || []).length})</h3>
          ${memberRows ? `<div class="community-table"><table>
            <thead><tr><th>Member</th><th>Study</th><th>Breaks</th><th>Nickname lock</th><th>Actions</th></tr></thead>
            <tbody>${memberRows}</tbody></table></div>` : ''}
        </div>
      `;

      const status = body.querySelector('#admin-action-status');
      body.querySelector('#admin-refresh-btn').onclick = () => loadAdmin();

      const updateSetting = async (payload, msg) => {
        status.textContent = 'Saving…';
        try {
          await request('/admin/settings', payload);
          status.textContent = msg;
          toast(msg);
        } catch (err) {
          status.textContent = err.message;
          await loadAdmin();
        }
      };

      body.querySelector('#admin-toggle-signups').onchange = (ev) =>
        updateSetting({ signupsOpen: ev.currentTarget.checked }, ev.currentTarget.checked ? 'Signups opened.' : 'Signups paused.');
      body.querySelector('#admin-toggle-env-join')?.addEventListener('change', (ev) =>
        updateSetting({ envJoinEnabled: ev.currentTarget.checked }, ev.currentTarget.checked ? 'Legacy env invite enabled.' : 'Legacy env invite disabled.'));

      body.querySelector('#admin-copy-new-code')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(lastCreatedCode);
          toast('Join string copied.');
        } catch {
          status.textContent = 'Select and copy the join string shown above.';
        }
      });

      const createForm = body.querySelector('#admin-create-invite');
      createForm.onsubmit = async (ev) => {
        ev.preventDefault();
        const btn = createForm.querySelector('button[type=submit]');
        btn.disabled = true;
        status.textContent = 'Creating invite code…';
        try {
          const fd = new FormData(createForm);
          const res = await request('/admin/invites', {
            action: 'create',
            label: String(fd.get('label') || '').trim(),
            maxUses: Number(fd.get('maxUses') || 0),
            expiresInDays: Number(fd.get('expiresInDays') || 0),
            customCode: String(fd.get('customCode') || '').trim(),
          });
          lastCreatedCode = res.code || '';
          toast('Join string created — copy it below.');
          await loadAdmin();
        } catch (err) {
          status.textContent = err.message || 'Could not create join string.';
          btn.disabled = false;
        }
      };

      for (const btn of body.querySelectorAll('[data-inv-act]')) {
        btn.onclick = async () => {
          const act = btn.dataset.invAct;
          if (act === 'delete' && !window.confirm('Permanently delete this invite code?')) return;
          btn.disabled = true;
          try {
            await request('/admin/invites', { action: act, id: btn.dataset.invId });
            await loadAdmin();
          } catch (err) {
            status.textContent = err.message;
            btn.disabled = false;
          }
        };
      }

      for (const btn of body.querySelectorAll('[data-mem-rename]')) {
        btn.onclick = async () => {
          const next = window.prompt('Enter new nickname (2–24 characters):', btn.dataset.memName || '');
          if (!next || next.trim() === btn.dataset.memName) return;
          btn.disabled = true;
          try {
            await request('/admin/members', { action: 'rename', id: btn.dataset.memRename, nickname: next.trim() });
            toast('Member renamed.');
            await loadAdmin();
          } catch (err) {
            status.textContent = err.message;
            btn.disabled = false;
          }
        };
      }

      for (const btn of body.querySelectorAll('[data-mem-reset]')) {
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            await request('/admin/members', { action: 'reset_cooldown', id: btn.dataset.memReset });
            toast('30-day nickname lock cleared.');
            await loadAdmin();
          } catch (err) {
            status.textContent = err.message;
            btn.disabled = false;
          }
        };
      }

      for (const btn of body.querySelectorAll('[data-mem-remove]')) {
        btn.onclick = async () => {
          if (!window.confirm(`Remove member "${btn.dataset.memName}" and delete their profile & messages?`)) return;
          btn.disabled = true;
          try {
            await request('/admin/members', { action: 'remove', id: btn.dataset.memRemove });
            toast('Member removed.');
            await loadAdmin();
          } catch (err) {
            status.textContent = err.message;
            btn.disabled = false;
          }
        };
      }
    }

    panel.ontoggle = () => {
      if (panel.open) loadAdmin();
    };
  }

  function renderLocked(root, profile) {
    const me = typeof profile === 'string' ? { nickname: profile, avatar: '', bio: '', isAdmin: false, nextNicknameChangeAt: 0 } : profile;
    root.innerHTML = `
      <section class="panel" id="community-locked">
        <div class="community-identity">
          ${avatarHtml(me.nickname, me.avatar, 48)}
          <div>
            <h1 style="margin-bottom:2px">Study community</h1>
            <p class="muted" style="margin:0" id="community-signed-in">
              Signed in as <strong>${esc(me.nickname)}</strong>${me.isAdmin ? ' <span class="badge admin-badge">Admin</span>' : ''}
            </p>
            ${me.bio ? `<p class="community-bio-sub">${esc(me.bio)}</p>` : ''}
          </div>
        </div>
        ${profileBreakStripHtml(me)}
        <p>Community opens during a timed break and from 20:00 to midnight Oslo time. You can still edit your profile and avatar anytime:</p>
        ${profileEditorHtml(me)}
        <div class="row-actions" style="margin-top:12px">
          <button type="button" class="ghost-btn" id="community-logout">Sign out</button>
          <button type="button" class="ghost-btn" id="community-delete">Delete my profile</button>
        </div>
      </section>
      ${adminPanelHtml(me)}
      ${privacyNote}`;
    profileActions(root);
    bindProfileEditor(root, me, () => render());
    bindAdminPanel(root, me);
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
        <li><div class="row-between"><span class="community-member-inline">${avatarHtml(message.nickname, message.avatar, 24)}<strong>${esc(message.nickname)}</strong></span>
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
        <li><div class="community-member-inline">${avatarHtml(set.nickname, set.avatar, 22)}<strong>${esc(set.title)}</strong> <small>${set.card_count} cards · ${esc(set.nickname)}</small></div>
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
    const leaderRows = ranks.map((row, index) => `<tr class="${row.id === me.id ? 'community-row-me' : ''}">
      <td>${offset + index + 1}</td>
      <td>
        <div class="community-member-cell">
          ${avatarHtml(row.nickname, row.avatar, 32)}
          <div class="community-member-meta">
            <strong>${esc(row.nickname)}${row.id === me.id ? ' <span class="badge">You</span>' : ''}</strong>
            ${row.bio ? `<small class="community-bio-sub">${esc(row.bio)}</small>` : ''}
          </div>
        </div>
      </td>
      <td>${(row.study_minutes / 60).toFixed(1)}</td>
      <td>${row.completed}</td><td>${row.attempts}</td><td>${row.attempts ? row.accuracy + '%' : '—'}</td><td>${breakCellHtml(row)}</td><td>${presenceLabel(row, now)}</td>
    </tr>`).join('');
    const messageRows = messages.map((row) => {
      const peerName = row.sender === me.id ? row.recipientName : row.senderName;
      const peerAvatar = row.sender === me.id ? row.recipientAvatar : row.senderAvatar;
      return `
      <li>
        <div class="row-between"><span class="community-member-inline">${avatarHtml(peerName, peerAvatar, 24)}<strong>${row.sender === me.id ? 'To ' + esc(row.recipientName) : 'From ' + esc(row.senderName)}</strong></span>
        <small>${esc(new Date(row.createdAt).toLocaleString())}</small></div>
        <p>${esc(row.message)}</p>
        ${row.sender === me.id ? '' : `<button type="button" class="ghost-btn" data-block-profile="${esc(row.sender)}">Block sender</button>`}
      </li>`;
    }).join('');
    root.innerHTML = `
      <section class="panel" id="community-social">
        <div class="row-between">
          <div class="community-identity">
            ${avatarHtml(me.nickname, me.avatar, 48)}
            <div>
              <h1 style="margin-bottom:2px">Study community</h1>
              <p class="muted" style="margin:0">Signed in as <strong id="community-signed-in">${esc(me.nickname)}</strong>${me.isAdmin ? ' <span class="badge admin-badge">Admin</span>' : ''}</p>
              ${me.bio ? `<p class="community-bio-sub">${esc(me.bio)}</p>` : ''}
            </div>
          </div>
          <div class="row-actions">
            <button type="button" class="ghost-btn" id="community-copy-key">Copy profile key</button>
            <button type="button" class="ghost-btn" id="community-logout">Sign out</button>
          </div>
        </div>
        ${profileBreakStripHtml(me)}
        ${profileEditorHtml(me)}
        <p class="muted" style="margin-top:8px">Keep your profile key to use your account on another device.</p>
        <p id="community-status" role="status"></p>
      </section>
      ${adminPanelHtml(me)}
      ${window.StudyRooms.lobbyHtml()}
      <section class="panel">
        <h2>Leaderboard</h2>
        <p class="muted">All Community profiles appear here with avatar, nickname, bio, study totals, break habits, and live timer.</p>
        <div class="row-actions">
          <button type="button" class="ghost-btn" id="community-stats">Refresh totals</button>
        </div>
        ${leaderRows ? `<div class="community-table"><table>
          <thead><tr><th>Rank</th><th>Member</th><th>Hours</th><th>Completed</th><th>Attempts</th><th>Accuracy</th><th>Breaks</th><th>Current timer</th></tr></thead>
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
    bindProfileEditor(root, me, () => render(offset));
    bindAdminPanel(root, me);
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
        const profile = await request('/profile');
        renderLocked(root, profile);
        return;
      }
      const generation = token;
      await syncPresence(state);
      const result = await request('/dashboard?offset=' + offset);
      if (generation !== token) return;
      if (canUse()) renderDashboard(root, result, offset);
      else renderLocked(root, result.me);
    } catch (error) {
      if (error.status === 401) {
        useProfile('');
        await requireProfile({ allowDemo: true, forcePrompt: true });
        await render(offset);
      } else if (error.status === 423) {
        const profile = await request('/profile');
        renderLocked(root, profile);
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

  return { enabled: Boolean(api), hasProfile: () => !api || Boolean(token), avatarHtml, render, queueStatsSync, clockTick,
    canShareSet, shareSet, requireProfile, roomRequest };
})();
