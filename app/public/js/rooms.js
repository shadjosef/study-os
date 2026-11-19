'use strict';

window.StudyRooms = (() => {
  const { esc, clockSec, toast, workClock } = window.StudyUI;
  const { enabled, roomRequest } = window.StudyCommunity;
  const root = document.getElementById('study-room-root');
  const sessionKey = 'study-os-room';
  let code = '';
  let state;
  let clockOffset = 0;
  let nextPoll = 0;
  let pending = false;
  let questionsCompleted = 0;
  let signature = '';

  function running() {
    return state?.phase === 'running';
  }

  function updateLinks() {
    document.querySelector('[data-nav="room"]').hidden = !code;
    document.getElementById('runner-room-btn').hidden = !code || state?.mode !== 'group' || !running();
  }

  function reset() {
    code = '';
    state = null;
    signature = '';
    questionsCompleted = 0;
    try { sessionStorage.removeItem(sessionKey); } catch {}
    updateLinks();
  }

  function selectRoom(next) {
    if (code === next) return;
    code = next;
    state = null;
    signature = '';
    questionsCompleted = 0;
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

  function lobbyHtml() {
    return `
      <section class="panel">
        <h2>Study together</h2>
        ${code ? '<button class="primary-btn" type="button" id="open-study-room">Open my room</button>' : `
        <div class="row-actions">
          <button class="primary-btn" type="button" data-new-room="group">Create group room</button>
          <button class="ghost-btn" type="button" data-new-room="duel">Create rated maths duel</button>
        </div>
        <form id="join-study-room" class="row-actions">
          <label class="field-label">Room code <input name="code" maxlength="8" pattern="[a-fA-F0-9]{8}" required autocomplete="off"></label>
          <button class="ghost-btn" type="submit">Join room</button>
        </form>`}
        <p id="study-room-lobby-status" role="status"></p>
        <details id="duel-ratings">
          <summary>Duel Elo leaderboard</summary>
          <ol id="duel-ratings-list"></ol>
        </details>
      </section>`;
  }

  function bindLobby(panel) {
    const status = panel.querySelector('#study-room-lobby-status');
    async function enter(data) {
      try {
        const room = await roomRequest('', data);
        selectRoom(room.code);
        await window.StudyApp.navigate('room');
      } catch (error) {
        status.textContent = error.message;
      }
    }
    panel.querySelector('#open-study-room')?.addEventListener('click', () => window.StudyApp.navigate('room'));
    for (const button of panel.querySelectorAll('[data-new-room]')) {
      button.onclick = () => enter({ mode: button.dataset.newRoom });
    }
    panel.querySelector('#join-study-room')?.addEventListener('submit', (event) => {
      event.preventDefault();
      enter({ code: new FormData(event.currentTarget).get('code') });
    });
    panel.querySelector('#duel-ratings')?.addEventListener('toggle', async (event) => {
      if (!event.currentTarget.open) return;
      try {
        const { ratings } = await roomRequest('/ratings');
        panel.querySelector('#duel-ratings-list').innerHTML = ratings.map((row) =>
          `<li>${esc(row.nickname)} · ${row.rating} Elo · ${row.matches} played</li>`).join('') || '<li>No rated duels yet.</li>';
      } catch (error) {
        status.textContent = error.message;
      }
    });
  }

  function paintScoreboard() {
    const list = root.querySelector('#room-players');
    if (!list || !state) return;
    list.innerHTML = state.players.map((player) => {
      let detail = player.ready ? 'Ready' : 'Waiting';
      if (state.phase !== 'lobby') detail = state.mode === 'duel' ? `${player.progress} submitted` : `${player.progress} attempts`;
      if (state.phase === 'finished' && state.mode === 'duel') {
        detail = `${player.score}/${state.questions.length} correct`;
        if (player.ratingChange !== null) detail += ` · ${player.ratingChange > 0 ? '+' : ''}${player.ratingChange} Elo`;
      }
      return `<li><strong>${esc(player.name)}${player.current ? ' (you)' : ''}</strong> <span>${detail}${player.finished && running() ? ' · Finished' : ''}</span></li>`;
    }).join('');
    const start = root.querySelector('#room-start');
    if (start) start.disabled = state.players.length < 2 || state.players.some((player) => !player.ready);
  }

  function draw() {
    const { mode, phase, questions, answers, players } = state;
    const me = players.find((player) => player.current);
    const isDuel = mode === 'duel';
    const unanswered = questions.findIndex((_, index) => !answers.some((answer) => answer.question === index));
    let activity = '';
    if (phase === 'lobby') {
      activity = `
        <p>Share room code <strong>${code}</strong>.</p>
        <p>${isDuel ? 'Two players. Five minutes. Six maths problems. Each answer is final. Highest score wins, and equal scores draw.'
          : 'Up to eight people study for 25 minutes. Pick any subject and see each other’s practice counts.'}</p>
        <div class="row-actions">
          <button type="button" class="ghost-btn" id="room-copy">Copy code</button>
          <button type="button" class="primary-btn" id="room-ready">${me.ready ? 'Unready' : 'Ready'}</button>
          ${state.host ? '<button type="button" class="primary-btn" id="room-start">Start round</button>' : ''}
          <button type="button" class="ghost-btn" id="room-leave">${state.host ? 'Close lobby' : 'Leave lobby'}</button>
        </div>`;
    } else if (phase === 'running') {
      activity = '<p><strong id="room-countdown" aria-label="Time remaining"></strong> remaining</p>';
      if (isDuel && !me.finished && unanswered >= 0) {
        activity += `
          <form id="room-answer" class="row-actions">
            <label class="field-label">Question ${unanswered + 1} of ${questions.length} · ${esc(questions[unanswered].prompt)}
              <input name="answer" inputmode="decimal" required maxlength="25" autocomplete="off">
            </label>
            <button type="submit" class="primary-btn">Submit answer</button>
          </form>`;
      }
      if (!isDuel && !me.finished) activity += '<button type="button" class="primary-btn" id="room-practice">Choose practice</button>';
      activity += me.finished ? '<p>Waiting for the others to finish.</p>' :
        '<button type="button" class="ghost-btn" id="room-finish">Finish my round</button>';
    } else {
      activity = isDuel ? '<h2>Answer review</h2><ol>' + questions.map((question, index) => {
        const hit = answers.find((answer) => answer.question === index);
        return `<li>${esc(question.prompt)} <strong>${question.answer}</strong> · ${hit ? (hit.correct ? 'Correct' : 'Incorrect') : 'Skipped'}</li>`;
      }).join('') + '</ol>' : '<p>Group session complete.</p>';
      activity += '<button type="button" class="primary-btn" id="room-close">Back to Home</button>';
    }
    root.innerHTML = `
      <section class="panel">
        <h1>${isDuel ? 'Rated maths duel · Beta' : 'Group study room'}</h1>
        <ul id="room-players" class="room-players"></ul>
        ${activity}
        <p id="room-status" role="status"></p>
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
    bind('#room-copy', async () => { await navigator.clipboard.writeText(code); toast('Room code copied.'); });
    bind('#room-ready', async () => { await roomRequest('/' + code + '/ready', { ready: !me.ready }); await refresh(); });
    bind('#room-start', async () => { await roomRequest('/' + code + '/start', {}); await refresh(); });
    bind('#room-leave', async () => { await roomRequest('/' + code + '/leave', {}); reset(); await window.StudyApp.navigate('community'); });
    bind('#room-practice', () => window.StudyApp.navigate('home'));
    bind('#room-close', () => { reset(); return window.StudyApp.navigate('home'); });
    bind('#room-finish', async () => {
      if (isDuel && unanswered >= 0 && !window.confirm('Finish the round with unanswered questions?')) return;
      await roomRequest('/' + code + '/finish', {});
      await refresh();
    });
    root.querySelector('#room-answer')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        await roomRequest('/' + code + '/answer', { question: unanswered, answer: new FormData(form).get('answer') });
        await refresh();
      } catch (error) { showError(error); }
      finally { if (button.isConnected) button.disabled = false; }
    });
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
    nextPoll = Date.now() + 5000;
    try {
      const updated = await roomRequest('/' + requested);
      if (requested !== code) return;
      const wasRunning = running();
      state = updated;
      if (!wasRunning && running()) workClock.ensureWorking();
      clockOffset = state.now - Date.now();
      const me = state.players.find((player) => player.current);
      questionsCompleted = Math.max(questionsCompleted, me?.progress || 0);
      const mark = JSON.stringify([state.phase, me?.ready, me?.finished, state.answers.length]);
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
      countdown.textContent = clockSec((state.endsAt - clockOffset - Date.now()) / 1000);
    }
    const visible = !document.getElementById('view-room').hidden;
    if ((visible || running()) && Date.now() >= nextPoll && state?.phase !== 'finished') refresh();
  }

  function recordAttempt() {
    if (!running() || state.mode !== 'group' || state.players.find((p) => p.current)?.finished) return;
    questionsCompleted = Math.min(500, questionsCompleted + 1);
    roomRequest('/' + code + '/progress', { completed: questionsCompleted }).catch(() => {});
  }

  async function render() {
    if (code) await refresh(true);
    else root.innerHTML = '<section class="panel"><h1>Study room</h1><p>Start or join a room from Community during break access.</p></section>';
  }

  return { bindLobby, lobbyHtml, render, restore, reset, clockTick, recordAttempt, running };
})();
