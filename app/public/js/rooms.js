'use strict';

window.StudyRooms = (() => {
  const { esc, clockSec, toast, workClock } = window.StudyUI;
  const { enabled, avatarHtml, roomRequest } = window.StudyCommunity;
  const root = document.getElementById('study-room-root');
  const sessionKey = 'study-os-room';
  const localPlaylistPrefix = 'study-os-room-playlist:';

  let code = '';
  let localMode = '';
  let state;
  let clockOffset = 0;
  let nextPoll = 0;
  let pending = false;
  let questionsCompleted = 0;
  let lastActivity = '';
  let myCurrentQid = '';
  let myCurrentLabel = '';
  let myDoneIds = new Set();
  let lastPingAt = 0;
  let pingTimer = null;
  let signature = '';

  let selectedDuelSubject = 'mixed';
  let selectedGroupMins = 75;
  let selectedGroupCourse = '';

  // Collaborative exercise picker state inside Study Together pod
  let pickerOpen = false;
  let pickerCourseId = '';
  let pickerCollId = '';
  let pickerQuery = '';
  let pickerSelected = new Set();

  const localPlaylists = new Map();

  const DUEL_SUBJECTS = [
    { id: 'mixed', label: 'Mixed BI', hint: 'Accounting + Econ + Maths' },
    { id: 'accounting', label: 'Accounting', hint: 'EXC 3430' },
    { id: 'economics', label: 'Economics', hint: 'EXC 3420' },
    { id: 'math', label: 'Maths', hint: 'EBA 1181' },
  ];

  function eloTitle(rating) {
    const r = Number(rating) || 1200;
    if (r >= 1650) return { code: 'GM', cls: 'lb-title-gm' };
    if (r >= 1500) return { code: 'IM', cls: 'lb-title-im' };
    if (r >= 1350) return { code: 'FM', cls: 'lb-title-fm' };
    if (r >= 1250) return { code: 'CM', cls: 'lb-title-cm' };
    return { code: 'CL', cls: 'lb-title-cl' };
  }

  function running() {
    return state?.phase === 'running';
  }

  function isInGroupPod() {
    if (!code) return false;
    if (state) return state.mode === 'group' && state.phase !== 'finished';
    return localMode === 'group';
  }

  function normalizePlaylist(spec) {
    if (!spec || typeof spec !== 'object') return null;
    const courseId = String(spec.courseId || spec.cMeta?.courseId || '').trim().slice(0, 40);
    const cMeta = (window.StudyApp?.getCatalog?.() || []).find((c) => c.courseId === courseId);
    const courseLabel = String(
      spec.courseLabel || (cMeta ? `${cMeta.code} · ${cMeta.shortTitle || cMeta.title}` : '')
    ).trim().slice(0, 64);
    const rawIds = Array.isArray(spec.questionIds) ? spec.questionIds : [];
    const seen = new Set();
    const questionIds = [];
    for (const id of rawIds) {
      const clean = String(id || '').trim().slice(0, 80);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      questionIds.push(clean);
      if (questionIds.length >= 60) break;
    }
    const examCollectionId = String(spec.examCollectionId || '').trim().slice(0, 64);
    if (!courseId && !questionIds.length && !examCollectionId) return null;
    const title = String(spec.title || courseLabel || 'Shared Playlist').trim().slice(0, 100);
    return {
      title,
      courseId,
      courseLabel,
      mode: spec.mode === 'exam' ? 'exam' : 'practice',
      examStyle: spec.examStyle === 'blind' ? 'blind' : 'guided',
      examCollectionId,
      questionIds,
      updatedBy: String(spec.updatedBy || '').trim().slice(0, 40),
      updatedAt: Number(spec.updatedAt || Date.now()),
    };
  }

  function saveLocalPlaylist(roomCode, pl) {
    if (!roomCode || !pl) return;
    localPlaylists.set(roomCode, pl);
    try { sessionStorage.setItem(localPlaylistPrefix + roomCode, JSON.stringify(pl)); } catch {}
  }

  function loadLocalPlaylist(roomCode) {
    if (!roomCode) return null;
    if (localPlaylists.has(roomCode)) return localPlaylists.get(roomCode);
    try {
      const raw = sessionStorage.getItem(localPlaylistPrefix + roomCode);
      if (raw) {
        const parsed = normalizePlaylist(JSON.parse(raw));
        if (parsed) {
          localPlaylists.set(roomCode, parsed);
          return parsed;
        }
      }
    } catch {}
    return null;
  }

  function activePlaylist() {
    if (state?.playlist?.courseId || state?.playlist?.questionIds?.length) return state.playlist;
    return loadLocalPlaylist(code);
  }

  function getState() {
    const pl = activePlaylist();
    if (state) return { ...state, playlist: pl };
    if (!code) return null;
    return { code, mode: localMode || 'group', phase: 'lobby', players: [], playlist: pl };
  }

  function inviteUrlFor(roomCode) {
    return `${window.location.origin}/?join_room=${encodeURIComponent(roomCode)}`;
  }

  function shareInviteUrl(roomCode = code) {
    const pl = activePlaylist();
    if (pl && state?.mode !== 'duel' && window.StudyApp?.buildPlaylistShareUrl) {
      return window.StudyApp.buildPlaylistShareUrl({ ...pl, roomCode });
    }
    return inviteUrlFor(roomCode);
  }

  function initialsOf(name) {
    const clean = String(name || '?').trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return clean.slice(0, 2).toUpperCase() || '?';
  }

  function quietPartnerStatus(player, plTotal = 0) {
    const doneOnPl = plTotal > 0 && Array.isArray(player.doneIds) && activePlaylist()?.questionIds?.length
      ? player.doneIds.filter((id) => activePlaylist().questionIds.includes(id)).length
      : 0;
    if (player.finished && running()) return 'wrapped up';
    if (player.currentLabel) {
      return doneOnPl > 0 && plTotal > 0 ? `${player.currentLabel} · ${doneOnPl}/${plTotal}` : player.currentLabel;
    }
    if (doneOnPl > 0 && plTotal > 0) return `${doneOnPl}/${plTotal} done`;
    if (player.activity) return player.activity;
    if (player.progress > 0) return `${player.progress} done`;
    return state?.phase === 'lobby' ? 'in pod' : 'studying';
  }

  function updateLinks() {
    const navBtn = document.querySelector('[data-nav="room"]');
    if (navBtn) navBtn.hidden = !code;
    const runnerBtn = document.getElementById('runner-room-btn');
    if (runnerBtn) {
      const showPod = isInGroupPod();
      runnerBtn.hidden = !showPod;
      if (showPod) {
        const count = state?.players?.length || 1;
        runnerBtn.innerHTML = count > 1
          ? `<span class="pod-live-dot" aria-hidden="true"></span>${count} studying`
          : `<span class="pod-live-dot is-idle" aria-hidden="true"></span>Pod ${esc(code)}`;
        runnerBtn.title = `Study Together pod ${code} (${count} ${count === 1 ? 'person' : 'people'})`;
      }
    }
    const pop = document.getElementById('runner-room-popover');
    if (pop && pop.matches(':popover-open')) {
      renderRunnerPopover();
    }
  }

  function reset() {
    const prev = code;
    code = '';
    localMode = '';
    state = null;
    signature = '';
    questionsCompleted = 0;
    lastActivity = '';
    myCurrentQid = '';
    myCurrentLabel = '';
    myDoneIds = new Set();
    pickerOpen = false;
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
    try {
      sessionStorage.removeItem(sessionKey);
      if (prev) sessionStorage.removeItem(localPlaylistPrefix + prev);
    } catch {}
    if (prev) localPlaylists.delete(prev);
    const pop = document.getElementById('runner-room-popover');
    if (pop && pop.matches(':popover-open')) {
      try { pop.hidePopover(); } catch {}
    }
    updateLinks();
  }

  function selectRoom(next, modeHint = '') {
    if (code === next) {
      if (modeHint && !localMode) localMode = modeHint;
      updateLinks();
      return;
    }
    code = next;
    localMode = modeHint;
    state = null;
    signature = '';
    questionsCompleted = 0;
    lastActivity = '';
    myCurrentQid = '';
    myCurrentLabel = '';
    myDoneIds = new Set();
    pickerOpen = false;
    try { sessionStorage.setItem(sessionKey, code); } catch {}
    updateLinks();
  }

  async function restore() {
    if (!enabled) return;
    try {
      const active = (await roomRequest()).code;
      const remembered = sessionStorage.getItem(sessionKey) || '';
      const target = active || (/^[A-F0-9]{8}$/.test(remembered) ? remembered : '');
      if (target) {
        selectRoom(target);
        await refresh(false);
      }
    } catch {}
  }

  async function joinByCode(rawCode, opts = {}) {
    const clean = String(rawCode || '').trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(clean)) {
      toast('Enter a valid 8-character room code.');
      return false;
    }
    try {
      const room = await roomRequest('', { code: clean });
      selectRoom(room.code, opts.fallbackPlaylist ? 'group' : '');
      if (opts.fallbackPlaylist) {
        const pl = normalizePlaylist(opts.fallbackPlaylist);
        if (pl) saveLocalPlaylist(room.code, pl);
      }
      await refresh(true);
      if (!opts.stayInView) {
        await window.StudyApp.navigate('room');
      }
      return true;
    } catch (error) {
      toast(error?.message || 'Could not join that room.');
      return false;
    }
  }

  async function createPodWithPlaylist(spec = {}) {
    const pl = normalizePlaylist(spec);
    if (!pl) {
      toast('Could not prepare that playlist for Study Together.');
      return '';
    }
    try {
      const room = await roomRequest('', {
        mode: 'group',
        durationMin: 75,
        isPublic: false,
        autoStart: true,
        courseId: pl.courseId,
        courseLabel: pl.courseLabel,
        playlist: pl,
      });
      selectRoom(room.code, 'group');
      saveLocalPlaylist(room.code, pl);
      await refresh(true);
      return room.code;
    } catch (error) {
      toast(error?.message || 'Could not start a Study Together pod right now.');
      return '';
    }
  }

  async function syncPlaylist(spec = {}) {
    if (!code) return false;
    const pl = normalizePlaylist(spec);
    if (!pl) {
      toast('Select at least one exercise for the shared playlist.');
      return false;
    }
    saveLocalPlaylist(code, pl);
    try {
      const updated = await roomRequest('/' + code + '/playlist', { playlist: pl });
      if (updated?.code) {
        state = updated;
        clockOffset = state.now - Date.now();
        signature = '';
        if (!document.getElementById('view-room')?.hidden) draw();
        updateLinks();
      }
      return true;
    } catch (error) {
      // Graceful fallback if Cloudflare Worker hasn't been redeployed with /playlist yet
      if (error?.status === 404 || error?.status === 405) {
        signature = '';
        if (!document.getElementById('view-room')?.hidden) draw();
        updateLinks();
        return true;
      }
      toast(error?.message || 'Could not sync playlist to pod.');
      return false;
    }
  }

  async function enterDuelRoom(rawCode) {
    const clean = String(rawCode || '').trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(clean)) return false;
    try {
      const breakDlg = document.getElementById('break-modal');
      if (breakDlg?.open) breakDlg.close();
      if (!document.getElementById('view-runner')?.hidden) {
        window.StudyRunner?.pauseIfRunning?.();
      }
      selectRoom(clean, 'duel');
      workClock?.ensureWorking?.();
      await window.StudyApp.navigate('room');
      await refresh(true);
      return true;
    } catch (error) {
      toast(error?.message || 'Could not enter duel room.');
      return false;
    }
  }

  function catalogCourseOptions(selectedId = selectedGroupCourse) {
    const courses = window.StudyApp?.getCatalog?.() || [];
    const defaults = courses.length
      ? courses.map((c) => ({ id: c.courseId, label: `${c.code} · ${c.shortTitle || c.title}` }))
      : [
          { id: 'econ-2522', label: 'EXC 3420 · Economics' },
          { id: 'acct-2527', label: 'EXC 3430 · Accounting' },
          { id: 'ob-2537', label: 'EXC 3460 · OB & Leadership' },
          { id: 'prog-3021', label: 'EBA 3400 · Programming' },
          { id: 'math-2588', label: 'EBA 1181 · Maths' },
        ];
    return `<option value="">Any BI course</option>` + defaults
      .map((c) => `<option value="${esc(c.id)}" ${selectedId === c.id ? 'selected' : ''}>${esc(c.label)}</option>`)
      .join('');
  }

  function lobbyHtml() {
    const duelSubjectPills = DUEL_SUBJECTS.map((s) =>
      `<button type="button" class="preset-chip ${selectedDuelSubject === s.id ? 'active' : ''}" data-duel-subj="${esc(s.id)}" title="${esc(s.hint)}">${esc(s.label)}</button>`
    ).join('');
    const durPills = [50, 75, 120].map((m) =>
      `<button type="button" class="preset-chip ${selectedGroupMins === m ? 'active' : ''}" data-group-mins="${m}">${m}m</button>`
    ).join('');

    return `
      <section class="panel room-hub-panel">
        <div class="row-between" style="margin:0 0 12px;flex-wrap:wrap;gap:8px">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <h2 style="margin:0">Study Together &amp; BI Duels</h2>
              <span class="badge">Two separate modes</span>
            </div>
            <p class="muted" style="margin:3px 0 0;font-size:13px">Pick exercises together at your own pace in a quiet Study Together pod, or challenge a classmate in a competitive BI Duel.</p>
          </div>
          ${code ? `<button class="primary-btn" type="button" id="open-study-room">Open room ${esc(code)} →</button>` : ''}
        </div>

        ${code ? '' : `
          <div class="room-create-grid">
            <div class="room-create-card room-create-group">
              <div class="row-between" style="margin:0 0 6px">
                <strong>📚 Study Together</strong>
                <span class="badge good">Calm · Synced Playlist</span>
              </div>
              <p class="muted" style="margin:0 0 10px;font-size:12.5px">Pick exercises together, hop in whenever you want, and quietly see each other’s progress — zero scoreboard pressure.</p>
              <div class="room-pod-controls">
                <div class="room-pill-row" role="group" aria-label="Study pod window">${durPills}</div>
                <select id="group-course-sel" aria-label="Target BI course" style="font-size:12.5px;padding:5px 9px;flex:1;min-width:150px">${catalogCourseOptions()}</select>
              </div>
              <div class="row-between" style="margin-top:10px;gap:8px;flex-wrap:wrap">
                <label class="room-vis-toggle"><input type="checkbox" id="group-open-toggle"> List in open lobby</label>
                <button class="primary-btn" type="button" data-new-room="group">Start Study Together →</button>
              </div>
            </div>

            <div class="room-create-card room-create-duel">
              <div class="row-between" style="margin:0 0 6px">
                <strong>⚔️ Rated BI Duel</strong>
                <span class="badge gold">1v1 · 5m · Elo</span>
              </div>
              <p class="muted" style="margin:0 0 10px;font-size:12.5px">Head-to-head procedural exam calculations with live Elo updates &amp; instant rematch.</p>
              <div class="room-pill-row" role="group" aria-label="Duel deck">${duelSubjectPills}</div>
              <div class="row-between" style="margin-top:10px;gap:8px;flex-wrap:wrap">
                <label class="room-vis-toggle"><input type="checkbox" id="duel-open-toggle" checked> Open in lobby</label>
                <div class="row-actions" style="gap:6px">
                  <button class="ghost-btn" type="button" id="btn-challenge-classmate" style="padding:7px 11px;font-size:12.5px">⚔️ Challenge…</button>
                  <button class="primary-btn" type="button" data-new-room="duel">Create Duel →</button>
                </div>
              </div>
            </div>
          </div>

          <div class="room-open-bar">
            <div class="room-open-head">
              <div style="display:flex;align-items:center;gap:8px">
                <strong style="font-size:13.5px">Open Rooms &amp; Join by Code</strong>
                <button type="button" class="ghost-btn" id="refresh-open-rooms" style="padding:3px 9px;font-size:11.5px">Refresh</button>
              </div>
              <form id="join-study-room" class="room-join-inline">
                <input name="code" maxlength="8" pattern="[a-fA-F0-9]{8}" placeholder="8-char code" aria-label="Room code" required autocomplete="off">
                <button class="ghost-btn" type="submit" style="padding:5px 11px;font-size:12.5px">Join</button>
              </form>
            </div>
            <div id="open-rooms-list" class="room-open-list"><span class="muted" style="font-size:12.5px">Checking open BI rooms…</span></div>
          </div>
        `}

        <p id="study-room-lobby-status" class="muted" role="status" style="margin:8px 0 0;font-size:12.5px"></p>

        <details id="duel-ratings" class="room-elo-details">
          <summary>Rated BI Duel Elo Leaderboard (Beta)</summary>
          <div id="duel-ratings-my" class="muted" style="font-size:12.5px;margin:6px 0"></div>
          <ol id="duel-ratings-list" class="room-elo-list"></ol>
        </details>
      </section>`;
  }

  async function loadOpenRooms(panel) {
    const listEl = panel.querySelector('#open-rooms-list');
    if (!listEl) return;
    try {
      const { rooms } = await roomRequest('/open');
      if (!listEl.isConnected) return;
      if (!rooms?.length) {
        listEl.innerHTML = '<span class="muted" style="font-size:12.5px">No open public lobbies right now — start a private Study Together pod or Duel above!</span>';
        return;
      }
      listEl.innerHTML = rooms.map((r) => {
        const isDuel = r.mode === 'duel';
        const t = eloTitle(r.hostRating);
        const sub = isDuel
          ? `${r.subjectLabel} · 5m`
          : `${r.durationMin}m Study Together${r.courseLabel ? ` · ${r.courseLabel}` : ''}`;
        return `<div class="room-open-item ${isDuel ? 'is-duel' : 'is-group'}">
          <div class="room-open-info">
            ${avatarHtml(r.hostName, r.hostAvatar, 28)}
            <div>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <strong>${esc(r.hostName)}</strong>
                ${isDuel ? `<span class="lb-title-tag ${t.cls}">${t.code}</span><small class="muted">${r.hostRating} Elo</small>` : ''}
                <span class="badge">${isDuel ? '⚔️ Duel' : '📚 Study Together'} · ${r.players}/${r.maxPlayers}</span>
              </div>
              <small class="muted">${esc(sub)}</small>
            </div>
          </div>
          <button type="button" class="primary-btn" style="padding:5px 12px;font-size:12.5px" data-join-open="${esc(r.code)}">${r.joined ? 'Open →' : isDuel ? 'Accept Duel →' : 'Join Pod →'}</button>
        </div>`;
      }).join('');
      listEl.querySelectorAll('[data-join-open]').forEach((btn) => {
        btn.onclick = async () => {
          btn.disabled = true;
          await joinByCode(btn.dataset.joinOpen);
          if (btn.isConnected) btn.disabled = false;
        };
      });
    } catch {
      if (listEl.isConnected) listEl.innerHTML = '<span class="muted" style="font-size:12.5px">Open public lobbies appear during breaks or 18:00–22:30 Oslo time. Private Study Together pods work anytime.</span>';
    }
  }

  function bindLobby(panel) {
    const status = panel.querySelector('#study-room-lobby-status');
    async function enter(data) {
      status.textContent = '';
      try {
        const room = await roomRequest('', data);
        selectRoom(room.code, data.mode || '');
        await window.StudyApp.navigate('room');
      } catch (error) {
        status.textContent = error.message;
      }
    }
    panel.querySelector('#open-study-room')?.addEventListener('click', () => window.StudyApp.navigate('room'));
    panel.querySelector('#btn-challenge-classmate')?.addEventListener('click', () => window.StudyDuels?.openChallengeModal?.());

    panel.querySelectorAll('[data-duel-subj]').forEach((btn) => {
      btn.onclick = () => {
        selectedDuelSubject = btn.dataset.duelSubj || 'mixed';
        panel.querySelectorAll('[data-duel-subj]').forEach((b) => b.classList.toggle('active', b === btn));
      };
    });
    panel.querySelectorAll('[data-group-mins]').forEach((btn) => {
      btn.onclick = () => {
        selectedGroupMins = Number(btn.dataset.groupMins) || 75;
        panel.querySelectorAll('[data-group-mins]').forEach((b) => b.classList.toggle('active', b === btn));
      };
    });
    const courseSel = panel.querySelector('#group-course-sel');
    if (courseSel) {
      courseSel.onchange = () => { selectedGroupCourse = courseSel.value; };
    }

    for (const button of panel.querySelectorAll('[data-new-room]')) {
      button.onclick = async () => {
        button.disabled = true;
        try {
          const mode = button.dataset.newRoom;
          if (mode === 'duel') {
            const isPublic = panel.querySelector('#duel-open-toggle')?.checked !== false;
            await enter({ mode: 'duel', subject: selectedDuelSubject, isPublic });
          } else {
            const isPublic = panel.querySelector('#group-open-toggle')?.checked === true;
            const selEl = panel.querySelector('#group-course-sel');
            const courseId = selEl?.value || '';
            const courseLabel = courseId ? (selEl.selectedOptions?.[0]?.textContent || '') : '';
            await enter({
              mode: 'group',
              durationMin: selectedGroupMins,
              isPublic,
              autoStart: !isPublic,
              courseId,
              courseLabel,
            });
          }
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      };
    }

    panel.querySelector('#join-study-room')?.addEventListener('submit', (event) => {
      event.preventDefault();
      enter({ code: new FormData(event.currentTarget).get('code') });
    });

    panel.querySelector('#refresh-open-rooms')?.addEventListener('click', () => loadOpenRooms(panel));
    if (!code) loadOpenRooms(panel);

    panel.querySelector('#duel-ratings')?.addEventListener('toggle', async (event) => {
      if (!event.currentTarget.open) return;
      try {
        const { ratings, myRating } = await roomRequest('/ratings');
        const myEl = panel.querySelector('#duel-ratings-my');
        if (myEl && myRating) {
          const mt = eloTitle(myRating.rating);
          myEl.innerHTML = `Your Duel Elo: <span class="lb-title-tag ${mt.cls}">${mt.code}</span> <strong>${myRating.rating}</strong> (${myRating.matches} ${myRating.matches === 1 ? 'match' : 'matches'})`;
        }
        panel.querySelector('#duel-ratings-list').innerHTML = (ratings || []).map((row, i) => {
          const t = eloTitle(row.rating);
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          return `<li class="${row.isMe ? 'is-me' : ''}">
            <span class="room-elo-rank">${medal}</span>
            <span class="community-member-inline">${avatarHtml(row.nickname, row.avatar, 24)}<span class="lb-title-tag ${t.cls}">${t.code}</span><strong>${esc(row.nickname)}</strong>${row.isMe ? ' <span class="badge good">You</span>' : ''}</span>
            <span class="room-elo-score"><strong>${row.rating}</strong> Elo <small class="muted">· ${row.matches}m</small></span>
          </li>`;
        }).join('') || '<li class="muted">No rated duels finished yet — challenge someone above!</li>';
      } catch (error) {
        status.textContent = error.message;
      }
    });
  }

  function renderProgressDots(done, total) {
    const n = Math.max(1, Number(total) || 6);
    const d = Math.max(0, Math.min(n, Number(done) || 0));
    let html = '<span class="duel-pips" aria-label="' + d + ' of ' + n + ' answered">';
    for (let i = 0; i < n; i++) html += `<i class="${i < d ? 'filled' : ''}"></i>`;
    return html + '</span>';
  }

  function paintScoreboard() {
    if (!state) return;
    const isDuel = state.mode === 'duel';
    const list = root.querySelector('#room-players');
    if (list) {
      if (isDuel) {
        const slots = [...state.players];
        if (state.phase === 'lobby' && slots.length < 2) {
          slots.push({ placeholder: true });
        }
        list.innerHTML = slots.map((player) => {
          if (player.placeholder) {
            return `<li class="room-player-card is-waiting">
              <div class="room-wait-pulse" aria-hidden="true">?</div>
              <div>
                <strong>Waiting for opponent…</strong>
                <small class="muted">Share invite link or post to Global Chat</small>
              </div>
            </li>`;
          }
          const t = eloTitle(player.rating);
          let detailHtml = `<span class="badge ${player.ready ? 'good' : ''}">${player.ready ? 'Ready ✓' : 'Not ready'}</span>`;
          if (state.phase === 'running') {
            detailHtml = `${renderProgressDots(player.progress, state.questions.length)} <small class="muted">${player.progress}/${state.questions.length}${player.finished ? ' · Done' : ''}</small>`;
          } else if (state.phase === 'finished') {
            const delta = player.ratingChange != null
              ? `<span class="badge ${player.ratingChange > 0 ? 'good' : player.ratingChange < 0 ? 'debt' : ''}">${player.ratingChange > 0 ? '+' : ''}${player.ratingChange} Elo</span>`
              : '';
            detailHtml = `<strong>${player.score}/${state.questions.length}</strong> ${delta}`;
          }
          return `<li class="room-player-card ${player.current ? 'is-me' : ''}">
            <div class="community-member-inline">
              ${avatarHtml(player.name, player.avatar, 36)}
              <div>
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                  <span class="lb-title-tag ${t.cls}">${t.code}</span>
                  <strong>${esc(player.name)}${player.current ? ' (you)' : ''}</strong>
                </div>
                <small class="muted">${player.rating || 1200} Elo${player.matches ? ` · ${player.matches} duels` : ' · Provisional'}</small>
              </div>
            </div>
            <div class="room-player-stat">${detailHtml}</div>
          </li>`;
        }).join('');
      } else {
        const pl = activePlaylist();
        const plIds = Array.isArray(pl?.questionIds) ? pl.questionIds : [];
        const plTotal = plIds.length;
        list.innerHTML = state.players.map((player) => {
          const doneIds = Array.isArray(player.doneIds) ? player.doneIds : [];
          const doneOnPl = plTotal > 0
            ? doneIds.filter((id) => plIds.includes(id)).length
            : 0;
          const pct = plTotal > 0
            ? Math.min(100, Math.round(((doneOnPl || Math.min(player.progress || 0, plTotal)) / plTotal) * 100))
            : 0;
          const quietSub = quietPartnerStatus(player, plTotal);
          return `<li class="room-player-card is-quiet-partner ${player.current ? 'is-me' : ''}">
            <div class="community-member-inline" style="min-width:0">
              ${avatarHtml(player.name, player.avatar, 30)}
              <div style="min-width:0">
                <div class="pod-partner-name">${esc(player.name)}${player.current ? ' <span class="muted">(you)</span>' : ''}</div>
                <small class="muted pod-partner-sub">${esc(quietSub)}</small>
              </div>
            </div>
            ${plTotal > 0 ? `
              <div class="pod-quiet-bar-wrap" title="${doneOnPl}/${plTotal} in playlist">
                <div class="pod-quiet-bar"><i style="width:${pct}%"></i></div>
              </div>` : ''}
          </li>`;
        }).join('');
      }
    }
    const start = root.querySelector('#room-start');
    if (start && isDuel) {
      start.disabled = state.players.length < 2 || state.players.some((player) => !player.ready);
    }

    // Live rematch banner if opponent clicked Rematch while we're viewing results
    const rematchBanner = root.querySelector('#room-rematch-banner');
    if (rematchBanner && state.phase === 'finished' && state.rematchCode) {
      rematchBanner.hidden = false;
      rematchBanner.querySelector('strong').textContent = `Rematch lobby ${state.rematchCode} is open!`;
    }

    // Also update quiet partner presence dots inside the shared playlist if visible
    if (!isDuel) paintPlaylistPartnerDots();
  }

  function paintPlaylistPartnerDots() {
    const items = root.querySelectorAll('[data-pod-pl-qid]');
    if (!items.length || !state?.players) return;
    items.forEach((row) => {
      const qid = row.dataset.podPlQid;
      const dotsEl = row.querySelector('.pod-partner-dots');
      if (!dotsEl) return;
      const chips = [];
      for (const p of state.players) {
        const isOn = p.currentQid === qid;
        const isDone = Array.isArray(p.doneIds) && p.doneIds.includes(qid);
        if (!isOn && !isDone) continue;
        const cls = isOn ? 'is-on' : 'is-done';
        const tip = isOn
          ? `${p.name}${p.current ? ' (you)' : ''} is working on this now`
          : `${p.name}${p.current ? ' (you)' : ''} finished this`;
        chips.push(`<span class="pod-q-dot ${cls}" title="${esc(tip)}">${esc(initialsOf(p.name))}</span>`);
      }
      dotsEl.innerHTML = chips.join('');
    });
  }

  async function renderPodPlaylistItems() {
    const host = root.querySelector('#pod-playlist-items');
    if (!host || !state || state.mode === 'duel') return;
    const pl = activePlaylist();
    if (!pl || !pl.courseId) {
      host.innerHTML = '<p class="muted" style="margin:6px 0 0;font-size:12.5px">No exercises picked yet — click <strong>Pick exercises</strong> to build a shared set together.</p>';
      return;
    }
    try {
      const bank = await window.StudyApp.ensureCourseBank(pl.courseId);
      if (!host.isConnected) return;
      const byId = Object.fromEntries((bank.questions || []).map((q) => [q.id, q]));
      const topicById = Object.fromEntries((bank.topics || []).map((t) => [String(t.id), t.title]));
      let questions = [];
      if (pl.questionIds?.length) {
        questions = pl.questionIds.map((id) => byId[id]).filter((q) => q && q.available !== false);
      } else if (pl.examCollectionId) {
        questions = (bank.questions || []).filter((q) => q.available !== false && String(q.collectionId) === String(pl.examCollectionId));
      }
      if (!questions.length) {
        host.innerHTML = '<p class="muted" style="margin:6px 0 0;font-size:12.5px">No exercises matched in this course — pick a new set below.</p>';
        return;
      }
      host.innerHTML = `<div class="pod-playlist-list">${questions.map((q, idx) => {
        const myRec = window.StudyApp?.getProgressRecord?.(q.id);
        const myDone = myRec?.status === 'done';
        const topic = topicById[String(q.topicId)] || '';
        return `<button type="button" class="pod-playlist-item" data-pod-pl-qid="${esc(q.id)}" data-pod-pl-idx="${idx}">
          <span class="playlist-row-num">${idx + 1}</span>
          <span class="playlist-row-copy">
            <strong>${esc(q.title)}</strong>
            ${topic ? `<small class="muted">${esc(topic)}</small>` : ''}
          </span>
          <span class="pod-item-right">
            <span class="pod-partner-dots"></span>
            ${myDone ? '<span class="badge good" title="You completed this">✓</span>' : ''}
          </span>
        </button>`;
      }).join('')}</div>`;
      paintPlaylistPartnerDots();
      host.querySelectorAll('[data-pod-pl-idx]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = Number(btn.dataset.podPlIdx || 0);
          await startPodPlaylistAt(idx);
        });
      });
    } catch {
      if (host.isConnected) host.innerHTML = '<p class="muted" style="margin:6px 0 0;font-size:12.5px">Could not load course exercises right now.</p>';
    }
  }

  async function renderPodPicker() {
    const panel = root.querySelector('#pod-picker-panel');
    if (!panel || !pickerOpen) return;
    const courses = window.StudyApp?.getCatalog?.() || [];
    const pl = activePlaylist();
    if (!pickerCourseId) {
      pickerCourseId = pl?.courseId || state?.courseId || courses[0]?.courseId || '';
    }
    if (!pickerSelected.size && pl?.courseId === pickerCourseId && Array.isArray(pl.questionIds)) {
      pl.questionIds.forEach((id) => pickerSelected.add(id));
    }

    const courseOpts = courses.map((c) =>
      `<option value="${esc(c.courseId)}" ${pickerCourseId === c.courseId ? 'selected' : ''}>${esc(c.code)} · ${esc(c.shortTitle || c.title)}</option>`
    ).join('');

    panel.innerHTML = `
      <div class="pod-picker-controls">
        <select id="pod-picker-course" aria-label="Course">${courseOpts}</select>
        <select id="pod-picker-coll" aria-label="Collection or exam"><option value="">All sets &amp; topics</option></select>
        <input type="search" id="pod-picker-search" value="${esc(pickerQuery)}" placeholder="Search exercises…" aria-label="Search exercises">
      </div>
      <div class="pod-picker-quickbar">
        <span class="muted" id="pod-picker-count" style="font-size:12px">${pickerSelected.size} selected</span>
        <div class="row-actions" style="gap:6px">
          <button type="button" class="ghost-btn" id="pod-picker-select-vis" style="padding:3px 9px;font-size:11.5px">Select shown</button>
          <button type="button" class="ghost-btn" id="pod-picker-clear" style="padding:3px 9px;font-size:11.5px">Clear</button>
        </div>
      </div>
      <div id="pod-picker-list" class="pod-picker-list"><span class="muted" style="font-size:12.5px">Loading exercises…</span></div>
      <div class="row-actions" style="margin-top:10px;justify-content:flex-end;gap:8px;flex-wrap:wrap">
        <button type="button" class="ghost-btn" id="pod-picker-cancel">Cancel</button>
        <button type="button" class="primary-btn" id="pod-picker-save">Sync playlist to pod (${pickerSelected.size})</button>
      </div>
    `;

    const cSel = panel.querySelector('#pod-picker-course');
    const collSel = panel.querySelector('#pod-picker-coll');
    const searchInp = panel.querySelector('#pod-picker-search');
    const listEl = panel.querySelector('#pod-picker-list');
    const saveBtn = panel.querySelector('#pod-picker-save');
    const countEl = panel.querySelector('#pod-picker-count');

    let bank = null;
    try {
      bank = await window.StudyApp.ensureCourseBank(pickerCourseId);
    } catch {
      if (listEl.isConnected) listEl.innerHTML = '<span class="muted">Could not load course exercises.</span>';
      return;
    }
    if (!listEl.isConnected) return;

    const collections = Array.isArray(bank.collections) ? bank.collections : [];
    collSel.innerHTML = `<option value="">All sets &amp; topics</option>` + collections.map((col) =>
      `<option value="${esc(col.id)}" ${pickerCollId === String(col.id) ? 'selected' : ''}>${esc(col.title || col.id)}</option>`
    ).join('');

    const topicById = Object.fromEntries((bank.topics || []).map((t) => [String(t.id), t.title]));
    const allQs = (bank.questions || []).filter((q) => q.available !== false);

    const updateCounts = () => {
      countEl.textContent = `${pickerSelected.size} selected`;
      saveBtn.textContent = `Sync playlist to pod (${pickerSelected.size})`;
      saveBtn.disabled = pickerSelected.size === 0;
    };

    const visibleQs = () => {
      const qStr = pickerQuery.trim().toLowerCase();
      return allQs.filter((q) => {
        if (pickerCollId && String(q.collectionId) !== pickerCollId) return false;
        if (!qStr) return true;
        const hay = `${q.title || ''} ${topicById[String(q.topicId)] || ''} ${q.collectionTitle || ''}`.toLowerCase();
        return hay.includes(qStr);
      });
    };

    const paintList = () => {
      const shown = visibleQs();
      if (!shown.length) {
        listEl.innerHTML = '<span class="muted" style="font-size:12.5px;padding:8px">No matching exercises.</span>';
        updateCounts();
        return;
      }
      listEl.innerHTML = shown.slice(0, 120).map((q) => {
        const checked = pickerSelected.has(q.id);
        const myDone = window.StudyApp?.getProgressRecord?.(q.id)?.status === 'done';
        const topic = topicById[String(q.topicId)] || '';
        return `<label class="pod-picker-item${checked ? ' is-picked' : ''}">
          <input type="checkbox" data-pick-qid="${esc(q.id)}" ${checked ? 'checked' : ''}>
          <span class="pod-picker-copy">
            <strong>${esc(q.title)}</strong>
            ${topic ? `<small class="muted">${esc(topic)}</small>` : ''}
          </span>
          ${myDone ? '<span class="badge good" style="font-size:10px">✓</span>' : ''}
        </label>`;
      }).join('');
      listEl.querySelectorAll('[data-pick-qid]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const id = cb.dataset.pickQid;
          if (cb.checked) {
            if (pickerSelected.size >= 60) {
              cb.checked = false;
              toast('Up to 60 exercises per shared playlist.');
              return;
            }
            pickerSelected.add(id);
          } else {
            pickerSelected.delete(id);
          }
          cb.closest('.pod-picker-item')?.classList.toggle('is-picked', cb.checked);
          updateCounts();
        });
      });
      updateCounts();
    };

    paintList();

    cSel.onchange = () => {
      pickerCourseId = cSel.value;
      pickerCollId = '';
      pickerSelected.clear();
      renderPodPicker();
    };
    collSel.onchange = () => {
      pickerCollId = collSel.value;
      paintList();
    };
    searchInp.oninput = () => {
      pickerQuery = searchInp.value;
      paintList();
    };
    panel.querySelector('#pod-picker-select-vis')?.addEventListener('click', () => {
      for (const q of visibleQs()) {
        if (pickerSelected.size >= 60) break;
        pickerSelected.add(q.id);
      }
      paintList();
    });
    panel.querySelector('#pod-picker-clear')?.addEventListener('click', () => {
      pickerSelected.clear();
      paintList();
    });
    panel.querySelector('#pod-picker-cancel')?.addEventListener('click', () => {
      pickerOpen = false;
      panel.hidden = true;
    });
    saveBtn.addEventListener('click', async () => {
      if (!pickerSelected.size) return;
      saveBtn.disabled = true;
      const orderedIds = allQs.filter((q) => pickerSelected.has(q.id)).map((q) => q.id).slice(0, 60);
      const cMeta = courses.find((c) => c.courseId === pickerCourseId);
      const colObj = pickerCollId ? collections.find((c) => String(c.id) === pickerCollId) : null;
      const title = colObj && orderedIds.length >= 2
        ? `${colObj.title || colObj.id} (${orderedIds.length})`
        : `${cMeta?.shortTitle || cMeta?.title || 'Study'} · Shared Set (${orderedIds.length})`;
      const ok = await syncPlaylist({
        courseId: pickerCourseId,
        courseLabel: cMeta ? `${cMeta.code} · ${cMeta.shortTitle || cMeta.title}` : '',
        title,
        questionIds: orderedIds,
        examCollectionId: colObj ? String(colObj.id) : '',
        mode: 'practice',
      });
      if (ok) {
        pickerOpen = false;
        toast(`Synced ${orderedIds.length} exercises to pod ${code}!`);
        draw();
      } else if (saveBtn.isConnected) {
        saveBtn.disabled = false;
      }
    });
  }

  async function startPodPlaylistAt(idx = 0) {
    const pl = activePlaylist();
    // If host is still in lobby, silently start the Study Together pod so quiet progress syncs immediately
    if (state?.mode === 'group' && state?.phase === 'lobby' && state?.host) {
      try {
        await roomRequest('/' + code + '/start', {});
        await refresh(false);
      } catch {}
    }
    if (pl && (pl.courseId || pl.questionIds?.length)) {
      await window.StudyApp.launchSharedPlaylist(pl, idx);
    } else if (state?.courseId && window.StudyApp?.launchCourseBlock) {
      await window.StudyApp.launchCourseBlock(state.courseId, state.durationMin || 75);
    } else {
      await window.StudyApp.navigate('home');
    }
  }

  function draw() {
    if (!state || !root) return;
    const { mode, phase, questions, answers, players } = state;
    const me = players.find((player) => player.current);
    const opponent = players.find((player) => !player.current);
    const isDuel = mode === 'duel';
    const pl = !isDuel ? activePlaylist() : null;
    const unanswered = questions.findIndex((_, index) => !answers.some((answer) => answer.question === index));
    const roomSubtitle = isDuel
      ? `${state.subjectLabel || 'BI Mixed Blitz'} · 5 min · ${questions.length || 6} problems`
      : (pl?.title || (state.courseLabel ? `Study Together · ${state.courseLabel}` : 'Study Together Pod'));

    let activity = '';
    if (isDuel) {
      if (phase === 'lobby') {
        activity = `
          <div class="room-invite-strip">
            <div>
              <small class="muted" style="display:block;font-weight:700">ROOM CODE</small>
              <code class="room-code-big">${esc(code)}</code>
              <span class="badge" style="margin-left:6px">${state.isPublic ? 'Open in Community' : 'Private link only'}</span>
            </div>
            <div class="row-actions" style="flex-wrap:wrap;gap:6px">
              <button type="button" class="ghost-btn" id="room-copy-link">Copy invite link</button>
              <button type="button" class="ghost-btn" id="room-copy">Copy code</button>
              <button type="button" class="ghost-btn" id="room-share-chat">Post to Global Chat</button>
            </div>
          </div>
          <p class="muted" style="font-size:13px;margin:10px 0 12px">Two players · 5 minutes · 6 BI exam-style calculations. Each answer is final; highest score wins (ties draw).</p>
          <div class="row-actions" style="flex-wrap:wrap">
            <button type="button" class="primary-btn" id="room-ready">${me?.ready ? '✓ Ready (click to unready)' : 'Mark Ready'}</button>
            ${state.host ? '<button type="button" class="primary-btn" id="room-start">Start round →</button>' : '<span class="muted" style="font-size:12.5px">Waiting for host to start once everyone is ready…</span>'}
            <button type="button" class="ghost-btn" id="room-leave">${state.host ? 'Close lobby' : 'Leave lobby'}</button>
          </div>`;
      } else if (phase === 'running') {
        const clockHtml = `<div class="room-live-clock"><small class="muted">TIME REMAINING</small><strong id="room-countdown" aria-label="Time remaining">--:--</strong></div>`;
        if (!me?.finished && unanswered >= 0) {
          const curQ = questions[unanswered];
          activity = `
            ${clockHtml}
            <div class="duel-question-card">
              <div class="row-between" style="margin:0 0 8px">
                <span class="badge live">Question ${unanswered + 1} of ${questions.length}</span>
                ${curQ.tag ? `<span class="badge">${esc(curQ.tag)}</span>` : ''}
              </div>
              <p class="duel-prompt-text">${esc(curQ.prompt)}</p>
              <form id="room-answer" class="duel-answer-form">
                <input name="answer" id="duel-answer-input" inputmode="decimal" placeholder="Enter numeric answer…" required maxlength="25" autocomplete="off">
                <button type="submit" class="primary-btn">Submit (Enter) →</button>
              </form>
            </div>
            <div class="row-actions" style="margin-top:10px">
              <button type="button" class="ghost-btn" id="room-finish" style="font-size:12.5px">Finish early</button>
            </div>`;
        } else {
          activity = `
            ${clockHtml}
            <div class="duel-wait-card">
              <strong>All ${answers.length}/${questions.length} submitted!</strong>
              <p class="muted" style="margin:4px 0 0">Waiting for ${esc(opponent?.name || 'your opponent')} to finish (or timer to expire) to reveal scores &amp; Elo.</p>
            </div>
            ${!me?.finished ? '<button type="button" class="primary-btn" id="room-finish" style="margin-top:10px">Lock in &amp; finish</button>' : ''}`;
        }
      } else {
        let verdictHtml = '';
        if (me) {
          const oppScore = opponent ? Number(opponent.score || 0) : null;
          const myScore = Number(me.score || 0);
          const verdict = oppScore == null
            ? 'Duel Complete'
            : myScore > oppScore ? '🏆 Victory!'
            : myScore < oppScore ? 'Defeat — Run it back!'
            : '🤝 Draw!';
          const vCls = oppScore == null ? '' : myScore > oppScore ? 'is-win' : myScore < oppScore ? 'is-loss' : 'is-draw';
          const delta = me.ratingChange != null
            ? `<span class="badge ${me.ratingChange > 0 ? 'good' : me.ratingChange < 0 ? 'debt' : ''}">${me.ratingChange > 0 ? '+' : ''}${me.ratingChange} Elo</span>`
            : '';
          verdictHtml = `
            <div class="duel-verdict-banner ${vCls}">
              <div>
                <h2 style="margin:0">${verdict}</h2>
                <small class="muted">${esc(state.subjectLabel || 'BI Duel')} · ${myScore}${oppScore != null ? ` – ${oppScore}` : `/${questions.length}`}</small>
              </div>
              <div>${delta}</div>
            </div>`;
        }
        const reviewHtml = `<h3 style="margin:14px 0 8px">Answer review</h3>
          <ol class="duel-review-list">${questions.map((question, index) => {
            const hit = answers.find((answer) => answer.question === index);
            const cls = hit ? (hit.correct ? 'is-correct' : 'is-wrong') : 'is-skipped';
            return `<li class="duel-review-item ${cls}">
              <div class="row-between" style="gap:8px;align-items:flex-start">
                <span>${question.tag ? `<span class="badge" style="margin-right:6px">${esc(question.tag)}</span>` : ''}${esc(question.prompt)}</span>
                <span class="badge ${hit?.correct ? 'good' : 'debt'}">${hit ? (hit.correct ? '✓ Correct' : '✕ Wrong') : 'Skipped'}</span>
              </div>
              <div class="duel-review-ans">
                <span>Correct: <strong>${esc(String(question.answer))}</strong></span>
                ${hit?.submitted ? `<span class="muted">Your answer: <code>${esc(hit.submitted)}</code></span>` : ''}
              </div>
            </li>`;
          }).join('')}</ol>`;
        activity = `
          ${verdictHtml}
          <div id="room-rematch-banner" class="room-rematch-banner" ${state.rematchCode ? '' : 'hidden'}>
            <strong>Rematch lobby ${esc(state.rematchCode || '')} is open!</strong>
            <button type="button" class="primary-btn" id="room-accept-rematch" style="padding:6px 12px;font-size:12.5px">Accept Rematch ⚔️</button>
          </div>
          ${reviewHtml}
          <div class="row-actions" style="margin-top:14px;flex-wrap:wrap">
            <button type="button" class="primary-btn" id="room-rematch">Rematch ⚔️</button>
            <button type="button" class="ghost-btn" id="room-back-community">Back to Community</button>
            <button type="button" class="ghost-btn" id="room-close">Home</button>
          </div>`;
      }
    } else {
      // Quiet, calm Study Together pod (completely distinct from competitive Duels)
      const plCount = pl?.questionIds?.length || 0;
      const startLabel = pl
        ? `Start playlist${plCount ? ` (${plCount})` : ''} →`
        : state.courseLabel ? `Practice ${state.courseLabel} →` : 'Open Courses →';
      const inviteStrip = phase !== 'finished' ? `
        <div class="room-invite-strip">
          <div>
            <small class="muted" style="display:block;font-weight:700">STUDY POD · QUIET SYNC</small>
            <code class="room-code-big">${esc(code)}</code>
            ${phase === 'running' ? `<span class="badge" style="margin-left:8px" title="Pod session window"><span id="room-countdown">--:--</span> left</span>` : ''}
          </div>
          <div class="row-actions" style="flex-wrap:wrap;gap:6px">
            <button type="button" class="ghost-btn" id="room-copy-link">Copy invite link</button>
            <button type="button" class="ghost-btn" id="room-copy">Copy code</button>
            ${state.isPublic && phase === 'lobby' ? '<button type="button" class="ghost-btn" id="room-share-chat">Post to Chat</button>' : ''}
          </div>
        </div>` : '';

      const playlistCard = `
        <div class="pod-playlist-card">
          <div class="row-between" style="gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <div>
              <strong>${esc(pl?.title || 'Shared Exercise Playlist')}</strong>
              ${pl?.courseLabel ? `<span class="badge" style="margin-left:6px">${esc(pl.courseLabel)}</span>` : ''}
              ${pl?.updatedBy ? `<small class="muted" style="display:block;margin-top:2px">Picked by ${esc(pl.updatedBy)} · click any exercise to jump in at your own pace</small>` : '<small class="muted" style="display:block;margin-top:2px">Anyone in the pod can pick or adjust exercises together.</small>'}
            </div>
            ${phase !== 'finished' ? `<button type="button" class="ghost-btn" id="pod-toggle-picker" style="padding:5px 11px;font-size:12.5px">${pickerOpen ? 'Hide picker' : 'Pick exercises'}</button>` : ''}
          </div>
          <div id="pod-picker-panel" class="pod-picker-panel" ${pickerOpen ? '' : 'hidden'}></div>
          <div id="pod-playlist-items"></div>
        </div>`;

      const footerActions = phase === 'finished'
        ? `<div class="duel-verdict-banner is-win" style="margin-top:12px">
             <div><h2 style="margin:0;font-size:17px">Study Together session wrapped up ✓</h2><small class="muted">You can still open any exercise above solo anytime.</small></div>
           </div>
           <div class="row-actions" style="margin-top:12px;flex-wrap:wrap">
             ${pl ? `<button type="button" class="primary-btn" id="room-practice">${esc(startLabel)}</button>` : ''}
             <button type="button" class="ghost-btn" id="room-back-community">Back to Community</button>
             <button type="button" class="ghost-btn" id="room-close">Home</button>
           </div>`
        : `<div class="row-actions" style="margin-top:14px;flex-wrap:wrap;gap:8px">
             ${!me?.finished ? `<button type="button" class="primary-btn" id="room-practice">${esc(startLabel)}</button>` : '<span class="badge good">Wrapped up · still visible to pod</span>'}
             ${phase === 'lobby' && state.host ? '<button type="button" class="ghost-btn" id="room-start">Start quiet sync</button>' : ''}
             <button type="button" class="ghost-btn" id="room-leave">${phase === 'lobby' && state.host ? 'Close pod' : 'Leave pod'}</button>
           </div>`;

      activity = `${inviteStrip}${playlistCard}${footerActions}`;
    }

    root.innerHTML = `
      <section class="panel room-arena-panel">
        <div class="row-between" style="margin:0 0 12px;flex-wrap:wrap;gap:8px">
          <div>
            <span class="eyebrow">${isDuel ? 'Rated BI Duel · Beta' : 'Study Together · Quiet Progress'}</span>
            <h1 style="margin:2px 0 0;font-size:21px">${esc(roomSubtitle)}</h1>
          </div>
          <span class="badge">${phase === 'lobby' ? (isDuel ? 'Lobby' : 'Ready') : phase === 'running' ? (isDuel ? '● Live' : '● Synced') : 'Finished'}</span>
        </div>
        <ul id="room-players" class="room-players-grid ${isDuel ? 'is-duel' : 'is-group'}"></ul>
        ${activity}
        <p id="room-status" class="muted" role="status" style="margin:10px 0 0;font-size:13px"></p>
      </section>`;

    paintScoreboard();
    if (!isDuel) {
      renderPodPlaylistItems();
      if (pickerOpen) renderPodPicker();
    }

    function bind(selector, handler) {
      root.querySelector(selector)?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await handler(); } catch (error) { showError(error); }
        finally { if (button.isConnected) button.disabled = false; }
      });
    }

    bind('#room-copy', async () => {
      await navigator.clipboard.writeText(code);
      toast(`Pod code ${code} copied.`);
    });
    bind('#room-copy-link', async () => {
      await navigator.clipboard.writeText(shareInviteUrl(code));
      toast(isDuel ? 'Duel invite link copied!' : 'Study Together + playlist link copied!');
    });
    bind('#room-share-chat', async () => {
      const msg = isDuel
        ? `⚔️ Open ${state.subjectLabel || 'BI'} Duel (5m) — join room ${code}! ${inviteUrlFor(code)}`
        : `📚 Open Study Together pod${pl?.title ? ` (${pl.title})` : state.courseLabel ? ` (${state.courseLabel})` : ''} — join ${code}! ${shareInviteUrl(code)}`;
      await window.StudyCommunity.postChatMessage(msg);
      toast('Posted invite to Global Chat!');
    });
    bind('#room-ready', async () => { await roomRequest('/' + code + '/ready', { ready: !me?.ready }); await refresh(true); });
    bind('#room-start', async () => { await roomRequest('/' + code + '/start', {}); await refresh(true); });
    bind('#room-leave', async () => {
      try {
        await roomRequest('/' + code + '/leave', {});
      } catch (err) {
        // Fallback for older Worker where /leave only worked in lobby
        if (state?.phase === 'running' && !isDuel) {
          await roomRequest('/' + code + '/finish', {}).catch(() => {});
        } else if (err?.status !== 404) {
          throw err;
        }
      }
      reset();
      await window.StudyApp.navigate(isDuel ? 'community' : 'home');
    });
    bind('#room-practice', async () => {
      await startPodPlaylistAt(0);
    });
    bind('#room-close', () => { reset(); return window.StudyApp.navigate('home'); });
    bind('#room-back-community', () => { reset(); return window.StudyApp.navigate('community'); });
    bind('#room-rematch', async () => {
      const res = await roomRequest('/' + code + '/rematch', {});
      if (res?.code) {
        selectRoom(res.code, 'duel');
        toast('Rematch lobby ready!');
        await refresh(true);
      }
    });
    bind('#room-accept-rematch', async () => {
      const res = await roomRequest('/' + code + '/rematch', {});
      if (res?.code) {
        selectRoom(res.code, 'duel');
        await refresh(true);
      }
    });
    bind('#room-finish', async () => {
      if (isDuel && unanswered >= 0 && !window.confirm('Finish the round with unanswered questions?')) return;
      await roomRequest('/' + code + '/finish', {});
      await refresh(true);
    });

    root.querySelector('#pod-toggle-picker')?.addEventListener('click', () => {
      pickerOpen = !pickerOpen;
      const panel = root.querySelector('#pod-picker-panel');
      const btn = root.querySelector('#pod-toggle-picker');
      if (btn) btn.textContent = pickerOpen ? 'Hide picker' : 'Pick exercises';
      if (panel) {
        panel.hidden = !pickerOpen;
        if (pickerOpen) renderPodPicker();
      }
    });

    const ansForm = root.querySelector('#room-answer');
    if (ansForm) {
      root.querySelector('#duel-answer-input')?.focus();
      ansForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button');
        button.disabled = true;
        try {
          await roomRequest('/' + code + '/answer', { question: unanswered, answer: new FormData(form).get('answer') });
          await refresh(true);
        } catch (error) {
          showError(error);
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
    }
  }

  function renderRunnerPopover() {
    const pop = document.getElementById('runner-room-popover');
    if (!pop) return;
    if (!isInGroupPod()) {
      pop.innerHTML = '<p class="muted" style="margin:4px;font-size:12.5px">No active Study Together pod.</p>';
      return;
    }
    const pl = activePlaylist();
    const plIds = Array.isArray(pl?.questionIds) ? pl.questionIds : [];
    const plTotal = plIds.length;
    const players = state?.players || [];
    const runSpec = window.StudyRunner?.getShareSpec?.() || null;
    const sameSet = Boolean(
      pl && runSpec && pl.courseId === runSpec.courseId
      && JSON.stringify(plIds) === JSON.stringify((runSpec.questionIds || []).slice(0, 60))
    );

    const rowsHtml = players.length
      ? players.map((p) => {
          const doneOnPl = plTotal > 0 && Array.isArray(p.doneIds)
            ? p.doneIds.filter((id) => plIds.includes(id)).length
            : 0;
          const pct = plTotal > 0
            ? Math.min(100, Math.round(((doneOnPl || Math.min(p.progress || 0, plTotal)) / plTotal) * 100))
            : 0;
          return `<div class="pod-pop-member">
            <div class="pod-pop-member-top">
              <span class="pod-pop-name">${avatarHtml(p.name, p.avatar, 20)}<span>${esc(p.name)}${p.current ? ' (you)' : ''}</span></span>
              <span class="muted pod-pop-stat">${esc(quietPartnerStatus(p, plTotal))}</span>
            </div>
            ${plTotal > 0 ? `<div class="pod-quiet-bar"><i style="width:${pct}%"></i></div>` : ''}
          </div>`;
        }).join('')
      : '<p class="muted" style="margin:4px 0;font-size:12px">Waiting for your study partner to hop in…</p>';

    pop.innerHTML = `
      <div class="pod-pop-head">
        <div>
          <strong style="font-size:13px">Study Together</strong>
          <code class="pod-mini-code">${esc(code)}</code>
        </div>
        <span class="muted" style="font-size:11px">Quiet sync</span>
      </div>
      ${pl ? `<div class="pod-pop-playlist">
        <span class="pod-pop-pl-title" title="${esc(pl.title)}">${esc(pl.title)}</span>
        ${!sameSet ? '<button type="button" class="mini-tool-btn" id="pop-open-pl">Open →</button>' : '<span class="muted" style="font-size:11px">Synced</span>'}
      </div>` : ''}
      <div class="pod-pop-members">${rowsHtml}</div>
      <div class="runner-menu-divider"></div>
      <div class="pod-pop-actions">
        <button type="button" class="runner-menu-item" id="pop-copy-invite">Copy invite link</button>
        ${runSpec && !sameSet ? '<button type="button" class="runner-menu-item" id="pop-sync-mine">Sync my current set to pod</button>' : ''}
        <button type="button" class="runner-menu-item" id="pop-open-room">Pick exercises / Pod view →</button>
        <button type="button" class="runner-menu-item" id="pop-leave-pod" style="color:var(--muted)">Leave pod</button>
      </div>
    `;

    pop.querySelector('#pop-open-pl')?.addEventListener('click', async () => {
      try { pop.hidePopover(); } catch {}
      if (pl) await window.StudyApp.launchSharedPlaylist(pl, 0);
    });
    pop.querySelector('#pop-copy-invite')?.addEventListener('click', async () => {
      const url = shareInviteUrl(code);
      try {
        await navigator.clipboard.writeText(url);
        toast(`Study Together link (${code}) copied!`);
      } catch {
        window.prompt('Copy this Study Together link:', url);
      }
      try { pop.hidePopover(); } catch {}
    });
    pop.querySelector('#pop-sync-mine')?.addEventListener('click', async () => {
      if (!runSpec) return;
      const ok = await syncPlaylist(runSpec);
      if (ok) toast('Synced your current playlist to the pod!');
      renderRunnerPopover();
    });
    pop.querySelector('#pop-open-room')?.addEventListener('click', async () => {
      try { pop.hidePopover(); } catch {}
      if (!document.getElementById('view-runner')?.hidden) {
        document.getElementById('run-exit-btn')?.click();
      }
      await window.StudyApp.navigate('room');
    });
    pop.querySelector('#pop-leave-pod')?.addEventListener('click', async () => {
      try { pop.hidePopover(); } catch {}
      try {
        await roomRequest('/' + code + '/leave', {});
      } catch {
        await roomRequest('/' + code + '/finish', {}).catch(() => {});
      }
      reset();
      toast('Left Study Together pod.');
    });
  }

  function showError(error) {
    const status = root?.querySelector('#room-status');
    if (status) status.textContent = error.message;
    else if (root) root.innerHTML = `<section class="panel"><h1>Study room</h1><p>${esc(error.message)}</p></section>`;
  }

  async function refresh(force = false) {
    if (!code || pending) return;
    const requested = code;
    pending = true;
    const pollMs = state?.phase === 'lobby' || state?.mode === 'duel' ? 2500 : 5000;
    nextPoll = Date.now() + pollMs;
    try {
      const updated = await roomRequest('/' + requested);
      if (requested !== code) return;
      const wasRunning = running();
      state = updated;
      localMode = updated.mode || localMode;
      if (updated.playlist) saveLocalPlaylist(requested, updated.playlist);
      if (!wasRunning && running() && updated.mode === 'duel') workClock.ensureWorking();
      clockOffset = state.now - Date.now();
      const me = state.players.find((player) => player.current);
      questionsCompleted = Math.max(questionsCompleted, me?.progress || 0);
      if (Array.isArray(me?.doneIds)) {
        me.doneIds.forEach((id) => myDoneIds.add(id));
      }
      const plSig = updated.playlist ? `${updated.playlist.updatedAt || 0}:${(updated.playlist.questionIds || []).join(',')}` : '';
      const mark = JSON.stringify([state.phase, me?.ready, me?.finished, state.answers.length, Boolean(state.rematchCode), plSig]);
      if ((mark !== signature || force) && !document.getElementById('view-room')?.hidden) {
        signature = mark;
        draw();
      } else if (!document.getElementById('view-room')?.hidden) {
        paintScoreboard();
      } else if (mark !== signature) {
        signature = mark;
      }
      updateLinks();
    } catch (error) {
      if (requested !== code) return;
      if (error.status === 404) reset();
      showError(error);
    } finally {
      pending = false;
    }
  }

  function clockTick() {
    if (!code) return;
    const countdown = root?.querySelector('#room-countdown');
    if (countdown && running()) {
      const rem = Math.max(0, (state.endsAt - clockOffset - Date.now()) / 1000);
      countdown.textContent = clockSec(rem);
      if (rem <= 0 && !pending) refresh(true);
    }
    const visible = !document.getElementById('view-room')?.hidden;
    const keepPollingFinished = visible && state?.phase === 'finished' && state?.mode === 'duel' && !state?.rematchCode;
    const keepPollingGroup = isInGroupPod();
    if ((visible || running() || keepPollingGroup) && Date.now() >= nextPoll && (state?.phase !== 'finished' || keepPollingFinished)) {
      refresh();
    }
  }

  function sendQuietProgress(activityLabel = '') {
    if (!running() || state?.mode !== 'group' || state.players.find((p) => p.current)?.finished) return;
    const cleanAct = String(activityLabel || lastActivity || myCurrentLabel || '').trim().slice(0, 48);
    if (cleanAct) lastActivity = cleanAct;
    lastPingAt = Date.now();
    roomRequest('/' + code + '/progress', {
      completed: questionsCompleted,
      ...(cleanAct ? { activity: cleanAct } : {}),
      ...(myCurrentQid ? { currentQid: myCurrentQid } : {}),
      ...(myCurrentLabel ? { currentLabel: myCurrentLabel } : {}),
      ...(myDoneIds.size ? { doneIds: [...myDoneIds].slice(-60) } : {}),
    }).catch(() => {});
  }

  function recordAttempt(activityLabel = '', meta = {}) {
    if (!running() || state?.mode !== 'group' || state.players.find((p) => p.current)?.finished) return;
    questionsCompleted = Math.min(500, questionsCompleted + 1);
    if (meta?.questionId) myDoneIds.add(String(meta.questionId));
    sendQuietProgress(activityLabel);
  }

  function reportCurrentQuestion(q, run) {
    if (!isInGroupPod() || !running() || !q?.id) return;
    const me = state?.players?.find((p) => p.current);
    if (me?.finished) return;
    const idx = Number(run?.index || 0) + 1;
    const total = Array.isArray(run?.questionIds) ? run.questionIds.length : 1;
    const shortCourse = run?.courseMeta?.code || '';
    const nextLabel = total > 1 ? `on Q${idx}/${total}` : (q.title || 'studying').slice(0, 32);
    const nextAct = shortCourse ? `${shortCourse} · ${nextLabel}` : nextLabel;
    const changed = q.id !== myCurrentQid || nextLabel !== myCurrentLabel;
    myCurrentQid = q.id;
    myCurrentLabel = nextLabel;
    if (!changed && Date.now() - lastPingAt < 8000) return;
    if (pingTimer) clearTimeout(pingTimer);
    const wait = Date.now() - lastPingAt < 2500 ? 1200 : 650;
    pingTimer = setTimeout(() => {
      pingTimer = null;
      sendQuietProgress(nextAct);
    }, wait);
  }

  async function render() {
    if (code) await refresh(true);
    else if (root) root.innerHTML = '<section class="panel"><h1>Study Together</h1><p class="muted">Create or join a Study Together pod or Rated BI Duel from the Community tab, or click Share inside any exercise set.</p></section>';
  }

  return {
    bindLobby,
    lobbyHtml,
    render,
    restore,
    reset,
    clockTick,
    recordAttempt,
    reportCurrentQuestion,
    running,
    isInGroupPod,
    getState,
    joinByCode,
    createPodWithPlaylist,
    syncPlaylist,
    renderRunnerPopover,
    enterDuelRoom,
  };
})();
