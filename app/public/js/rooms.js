'use strict';

window.StudyRooms = (() => {
  const { esc, clockSec, toast, workClock } = window.StudyUI;
  const { enabled, avatarHtml, roomRequest } = window.StudyCommunity;
  const root = document.getElementById('study-room-root');
  const sessionKey = 'study-os-room';
  let code = '';
  let state;
  let clockOffset = 0;
  let nextPoll = 0;
  let pending = false;
  let questionsCompleted = 0;
  let lastActivity = '';
  let signature = '';

  let selectedDuelSubject = 'mixed';
  let selectedGroupMins = 50;
  let selectedGroupCourse = '';

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

  function inviteUrlFor(roomCode) {
    return `${window.location.origin}/?join_room=${encodeURIComponent(roomCode)}`;
  }

  function updateLinks() {
    const navBtn = document.querySelector('[data-nav="room"]');
    if (navBtn) navBtn.hidden = !code;
    const runnerBtn = document.getElementById('runner-room-btn');
    if (runnerBtn) runnerBtn.hidden = !code || state?.mode !== 'group' || !running();
  }

  function reset() {
    code = '';
    state = null;
    signature = '';
    questionsCompleted = 0;
    lastActivity = '';
    try { sessionStorage.removeItem(sessionKey); } catch {}
    updateLinks();
  }

  function selectRoom(next) {
    if (code === next) return;
    code = next;
    state = null;
    signature = '';
    questionsCompleted = 0;
    lastActivity = '';
    try { sessionStorage.setItem(sessionKey, code); } catch {}
    updateLinks();
  }

  async function restore() {
    if (!enabled) return;
    try {
      const active = (await roomRequest()).code;
      const remembered = sessionStorage.getItem(sessionKey) || '';
      if (active || /^[A-F0-9]{8}$/.test(remembered)) selectRoom(active || remembered);
    } catch {}
  }

  async function joinByCode(rawCode) {
    const clean = String(rawCode || '').trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(clean)) {
      toast('Enter a valid 8-character room code.');
      return false;
    }
    try {
      const room = await roomRequest('', { code: clean });
      selectRoom(room.code);
      await window.StudyApp.navigate('room');
      return true;
    } catch (error) {
      toast(error?.message || 'Could not join that room.');
      return false;
    }
  }

  function catalogCourseOptions() {
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
      .map((c) => `<option value="${esc(c.id)}" ${selectedGroupCourse === c.id ? 'selected' : ''}>${esc(c.label)}</option>`)
      .join('');
  }

  function lobbyHtml() {
    const duelSubjectPills = DUEL_SUBJECTS.map((s) =>
      `<button type="button" class="preset-chip ${selectedDuelSubject === s.id ? 'active' : ''}" data-duel-subj="${esc(s.id)}" title="${esc(s.hint)}">${esc(s.label)}</button>`
    ).join('');
    const durPills = [25, 50, 75].map((m) =>
      `<button type="button" class="preset-chip ${selectedGroupMins === m ? 'active' : ''}" data-group-mins="${m}">${m}m</button>`
    ).join('');

    return `
      <section class="panel room-hub-panel">
        <div class="row-between" style="margin:0 0 12px;flex-wrap:wrap;gap:8px">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <h2 style="margin:0">Study together &amp; BI Duels</h2>
              <span class="badge gold">Live Beta · Elo Arena</span>
            </div>
            <p class="muted" style="margin:3px 0 0;font-size:13px">Challenge a classmate to a 5-minute BI sprint or lock into a shared focus pod.</p>
          </div>
          ${code ? `<button class="primary-btn" type="button" id="open-study-room">Rejoin room ${esc(code)} →</button>` : ''}
        </div>

        ${code ? '' : `
          <div class="room-create-grid">
            <div class="room-create-card room-create-duel">
              <div class="row-between" style="margin:0 0 6px">
                <strong>⚔️ Rated BI Duel</strong>
                <span class="badge">1v1 · 5m · 6 Qs</span>
              </div>
              <p class="muted" style="margin:0 0 10px;font-size:12.5px">Head-to-head procedural exam calculations with live Elo updates &amp; instant rematch.</p>
              <div class="room-pill-row" role="group" aria-label="Duel deck">${duelSubjectPills}</div>
              <div class="row-between" style="margin-top:10px;gap:8px;flex-wrap:wrap">
                <label class="room-vis-toggle"><input type="checkbox" id="duel-open-toggle" checked> Open in lobby</label>
                <button class="primary-btn" type="button" data-new-room="duel">Create Duel →</button>
              </div>
            </div>

            <div class="room-create-card room-create-group">
              <div class="row-between" style="margin:0 0 6px">
                <strong>📚 Group Study Pod</strong>
                <span class="badge">2–8 students</span>
              </div>
              <p class="muted" style="margin:0 0 10px;font-size:12.5px">Shared countdown timer with live practice counts &amp; active course badges across your group.</p>
              <div class="room-pod-controls">
                <div class="room-pill-row" role="group" aria-label="Study pod duration">${durPills}</div>
                <select id="group-course-sel" aria-label="Target BI course" style="font-size:12.5px;padding:5px 9px;flex:1;min-width:150px">${catalogCourseOptions()}</select>
              </div>
              <div class="row-between" style="margin-top:10px;gap:8px;flex-wrap:wrap">
                <label class="room-vis-toggle"><input type="checkbox" id="group-open-toggle" checked> Open in lobby</label>
                <button class="primary-btn" type="button" data-new-room="group">Start Study Pod →</button>
              </div>
            </div>
          </div>

          <div class="room-open-bar">
            <div class="room-open-head">
              <div style="display:flex;align-items:center;gap:8px">
                <strong style="font-size:13.5px">Open Rooms &amp; Challenges</strong>
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
        listEl.innerHTML = '<span class="muted" style="font-size:12.5px">No open lobbies right now — create a Duel or Study Pod above to invite classmates!</span>';
        return;
      }
      listEl.innerHTML = rooms.map((r) => {
        const isDuel = r.mode === 'duel';
        const t = eloTitle(r.hostRating);
        const sub = isDuel
          ? `${r.subjectLabel} · 5m`
          : `${r.durationMin}m Pod${r.courseLabel ? ` · ${r.courseLabel}` : ''}`;
        return `<div class="room-open-item ${isDuel ? 'is-duel' : 'is-group'}">
          <div class="room-open-info">
            ${avatarHtml(r.hostName, r.hostAvatar, 28)}
            <div>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <strong>${esc(r.hostName)}</strong>
                ${isDuel ? `<span class="lb-title-tag ${t.cls}">${t.code}</span><small class="muted">${r.hostRating} Elo</small>` : ''}
                <span class="badge">${isDuel ? '⚔️ Duel' : '📚 Pod'} · ${r.players}/${r.maxPlayers}</span>
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
      if (listEl.isConnected) listEl.innerHTML = '<span class="muted" style="font-size:12.5px">Open rooms appear during breaks or 18:00–22:30 Oslo time.</span>';
    }
  }

  function bindLobby(panel) {
    const status = panel.querySelector('#study-room-lobby-status');
    async function enter(data) {
      status.textContent = '';
      try {
        const room = await roomRequest('', data);
        selectRoom(room.code);
        await window.StudyApp.navigate('room');
      } catch (error) {
        status.textContent = error.message;
      }
    }
    panel.querySelector('#open-study-room')?.addEventListener('click', () => window.StudyApp.navigate('room'));

    panel.querySelectorAll('[data-duel-subj]').forEach((btn) => {
      btn.onclick = () => {
        selectedDuelSubject = btn.dataset.duelSubj || 'mixed';
        panel.querySelectorAll('[data-duel-subj]').forEach((b) => b.classList.toggle('active', b === btn));
      };
    });
    panel.querySelectorAll('[data-group-mins]').forEach((btn) => {
      btn.onclick = () => {
        selectedGroupMins = Number(btn.dataset.groupMins) || 50;
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
            const isPublic = panel.querySelector('#group-open-toggle')?.checked !== false;
            const selEl = panel.querySelector('#group-course-sel');
            const courseId = selEl?.value || '';
            const courseLabel = courseId ? (selEl.selectedOptions?.[0]?.textContent || '') : '';
            await enter({ mode: 'group', durationMin: selectedGroupMins, isPublic, courseId, courseLabel });
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
        list.innerHTML = state.players.map((player) => {
          let detailHtml = `<span class="badge ${player.ready ? 'good' : ''}">${player.ready ? 'Ready ✓' : 'Waiting'}</span>`;
          if (state.phase !== 'lobby') {
            detailHtml = `<strong>${player.progress}</strong> <small class="muted">attempts${player.finished && running() ? ' · Done' : ''}</small>`;
          }
          return `<li class="room-player-card ${player.current ? 'is-me' : ''}">
            <div class="community-member-inline">
              ${avatarHtml(player.name, player.avatar, 32)}
              <div>
                <strong>${esc(player.name)}${player.current ? ' (you)' : ''}</strong>
                ${player.activity ? `<div><small class="badge" style="font-size:10.5px;margin-top:2px">${esc(player.activity)}</small></div>` : ''}
              </div>
            </div>
            <div class="room-player-stat">${detailHtml}</div>
          </li>`;
        }).join('');
      }
    }
    const start = root.querySelector('#room-start');
    if (start) start.disabled = state.players.length < 2 || state.players.some((player) => !player.ready);

    // Live rematch banner if opponent clicked Rematch while we're viewing results
    const rematchBanner = root.querySelector('#room-rematch-banner');
    if (rematchBanner && state.phase === 'finished' && state.rematchCode) {
      rematchBanner.hidden = false;
      rematchBanner.querySelector('strong').textContent = `Rematch lobby ${state.rematchCode} is open!`;
    }
  }

  function draw() {
    const { mode, phase, questions, answers, players } = state;
    const me = players.find((player) => player.current);
    const opponent = players.find((player) => !player.current);
    const isDuel = mode === 'duel';
    const unanswered = questions.findIndex((_, index) => !answers.some((answer) => answer.question === index));
    const roomSubtitle = isDuel
      ? `${state.subjectLabel || 'BI Mixed Blitz'} · 5 min · ${questions.length || 6} problems`
      : `${state.durationMin || 50}m Group Study Pod${state.courseLabel ? ` · ${state.courseLabel}` : ''}`;

    let activity = '';
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
        <p class="muted" style="font-size:13px;margin:10px 0 12px">${isDuel
          ? 'Two players · 5 minutes · 6 BI exam-style calculations. Each answer is final; highest score wins (ties draw).'
          : `Up to 8 students study together for ${state.durationMin || 50} minutes with live progress counts.`}</p>
        <div class="row-actions" style="flex-wrap:wrap">
          <button type="button" class="primary-btn" id="room-ready">${me.ready ? '✓ Ready (click to unready)' : 'Mark Ready'}</button>
          ${state.host ? '<button type="button" class="primary-btn" id="room-start">Start round →</button>' : '<span class="muted" style="font-size:12.5px">Waiting for host to start once everyone is ready…</span>'}
          <button type="button" class="ghost-btn" id="room-leave">${state.host ? 'Close lobby' : 'Leave lobby'}</button>
        </div>`;
    } else if (phase === 'running') {
      const clockHtml = `<div class="room-live-clock"><small class="muted">TIME REMAINING</small><strong id="room-countdown" aria-label="Time remaining">--:--</strong></div>`;
      if (isDuel) {
        if (!me.finished && unanswered >= 0) {
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
            ${!me.finished ? '<button type="button" class="primary-btn" id="room-finish" style="margin-top:10px">Lock in &amp; finish</button>' : ''}`;
        }
      } else {
        const launchLbl = state.courseLabel ? `Practice ${state.courseLabel} (${state.durationMin || 50}m) →` : 'Open Courses & Practice →';
        activity = `
          ${clockHtml}
          <div class="row-actions" style="margin-top:12px;flex-wrap:wrap">
            ${!me.finished ? `<button type="button" class="primary-btn" id="room-practice">${esc(launchLbl)}</button>` : '<span class="badge good">Your block is finished · waiting on pod</span>'}
            ${!me.finished ? '<button type="button" class="ghost-btn" id="room-finish">Finish my block</button>' : ''}
          </div>`;
      }
    } else {
      let verdictHtml = '';
      if (isDuel && me) {
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
      const reviewHtml = isDuel
        ? `<h3 style="margin:14px 0 8px">Answer review</h3>
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
           }).join('')}</ol>`
        : '<div class="duel-verdict-banner is-win"><div><h2 style="margin:0">Group Study Pod Complete ✓</h2><small class="muted">Great work staying locked in together.</small></div></div>';

      activity = `
        ${verdictHtml}
        <div id="room-rematch-banner" class="room-rematch-banner" ${state.rematchCode ? '' : 'hidden'}>
          <strong>Rematch lobby ${esc(state.rematchCode || '')} is open!</strong>
          <button type="button" class="primary-btn" id="room-accept-rematch" style="padding:6px 12px;font-size:12.5px">Accept Rematch ⚔️</button>
        </div>
        ${reviewHtml}
        <div class="row-actions" style="margin-top:14px;flex-wrap:wrap">
          ${isDuel ? '<button type="button" class="primary-btn" id="room-rematch">Rematch ⚔️</button>' : ''}
          <button type="button" class="ghost-btn" id="room-back-community">Back to Community</button>
          <button type="button" class="ghost-btn" id="room-close">Home</button>
        </div>`;
    }

    root.innerHTML = `
      <section class="panel room-arena-panel">
        <div class="row-between" style="margin:0 0 12px;flex-wrap:wrap;gap:8px">
          <div>
            <span class="eyebrow">${isDuel ? 'Rated BI Duel · Beta' : 'Live Group Study Pod'}</span>
            <h1 style="margin:2px 0 0;font-size:22px">${esc(roomSubtitle)}</h1>
          </div>
          <span class="badge">${phase === 'lobby' ? 'Lobby' : phase === 'running' ? '● Live' : 'Finished'}</span>
        </div>
        <ul id="room-players" class="room-players-grid ${isDuel ? 'is-duel' : 'is-group'}"></ul>
        ${activity}
        <p id="room-status" class="muted" role="status" style="margin:10px 0 0;font-size:13px"></p>
      </section>`;

    paintScoreboard();

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
      toast(`Room code ${code} copied.`);
    });
    bind('#room-copy-link', async () => {
      await navigator.clipboard.writeText(inviteUrlFor(code));
      toast('1-click invite link copied! Send it to your study partner.');
    });
    bind('#room-share-chat', async () => {
      const msg = isDuel
        ? `⚔️ Open ${state.subjectLabel || 'BI'} Duel (5m) — join room ${code}! ${inviteUrlFor(code)}`
        : `📚 Open ${state.durationMin || 50}m Study Pod${state.courseLabel ? ` (${state.courseLabel})` : ''} — join room ${code}! ${inviteUrlFor(code)}`;
      await window.StudyCommunity.postChatMessage(msg);
      toast('Posted room invite to Global Chat!');
    });
    bind('#room-ready', async () => { await roomRequest('/' + code + '/ready', { ready: !me.ready }); await refresh(true); });
    bind('#room-start', async () => { await roomRequest('/' + code + '/start', {}); await refresh(true); });
    bind('#room-leave', async () => { await roomRequest('/' + code + '/leave', {}); reset(); await window.StudyApp.navigate('community'); });
    bind('#room-practice', async () => {
      if (state.courseId && window.StudyApp?.launchCourseBlock) {
        await window.StudyApp.launchCourseBlock(state.courseId, state.durationMin || 50);
      } else {
        await window.StudyApp.navigate('home');
      }
    });
    bind('#room-close', () => { reset(); return window.StudyApp.navigate('home'); });
    bind('#room-back-community', () => { reset(); return window.StudyApp.navigate('community'); });
    bind('#room-rematch', async () => {
      const res = await roomRequest('/' + code + '/rematch', {});
      if (res?.code) {
        selectRoom(res.code);
        toast('Rematch lobby ready!');
        await refresh(true);
      }
    });
    bind('#room-accept-rematch', async () => {
      const res = await roomRequest('/' + code + '/rematch', {});
      if (res?.code) {
        selectRoom(res.code);
        await refresh(true);
      }
    });
    bind('#room-finish', async () => {
      if (isDuel && unanswered >= 0 && !window.confirm('Finish the round with unanswered questions?')) return;
      await roomRequest('/' + code + '/finish', {});
      await refresh(true);
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

  function showError(error) {
    const status = root.querySelector('#room-status');
    if (status) status.textContent = error.message;
    else root.innerHTML = `<section class="panel"><h1>Study room</h1><p>${esc(error.message)}</p></section>`;
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
      if (!wasRunning && running()) workClock.ensureWorking();
      clockOffset = state.now - Date.now();
      const me = state.players.find((player) => player.current);
      questionsCompleted = Math.max(questionsCompleted, me?.progress || 0);
      const mark = JSON.stringify([state.phase, me?.ready, me?.finished, state.answers.length, Boolean(state.rematchCode)]);
      if (mark !== signature || force) { signature = mark; draw(); }
      else paintScoreboard();
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
    const countdown = root.querySelector('#room-countdown');
    if (countdown && running()) {
      const rem = Math.max(0, (state.endsAt - clockOffset - Date.now()) / 1000);
      countdown.textContent = clockSec(rem);
      if (rem <= 0 && !pending) refresh(true);
    }
    const visible = !document.getElementById('view-room')?.hidden;
    const keepPollingFinished = visible && state?.phase === 'finished' && state?.mode === 'duel' && !state?.rematchCode;
    if ((visible || running()) && Date.now() >= nextPoll && (state?.phase !== 'finished' || keepPollingFinished)) {
      refresh();
    }
  }

  function recordAttempt(activityLabel = '') {
    if (!running() || state?.mode !== 'group' || state.players.find((p) => p.current)?.finished) return;
    questionsCompleted = Math.min(500, questionsCompleted + 1);
    const cleanAct = String(activityLabel || lastActivity || '').trim().slice(0, 48);
    if (cleanAct) lastActivity = cleanAct;
    roomRequest('/' + code + '/progress', {
      completed: questionsCompleted,
      ...(cleanAct ? { activity: cleanAct } : {}),
    }).catch(() => {});
  }

  async function render() {
    if (code) await refresh(true);
    else root.innerHTML = '<section class="panel"><h1>Study room</h1><p class="muted">Create or join a Rated BI Duel or Group Study Pod from the Community tab during breaks or 18:00–22:30 Oslo time.</p></section>';
  }

  return { bindLobby, lobbyHtml, render, restore, reset, clockTick, recordAttempt, running, joinByCode };
})();
