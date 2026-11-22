/* Break-Aware Direct Duel Challenges for Study-OS
 * - Send a 1v1 BI Duel request to any classmate anytime (even while studying).
 * - Recipient is NEVER interrupted mid-focus: while studying, the invite waits quietly;
 *   during a break, it previews gently and pops up with 1 minute left on break (or right away if idle).
 * - The instant Recipient clicks Accept, Challenger gets a non-blocking banner (even while studying)
 *   to choose "Proceed to Duel ->" (launches live 1v1 room immediately for both) or "Not now".
 */
'use strict';

window.StudyDuels = (() => {
  const { esc, clockSec, toast, workClock } = window.StudyUI;
  const DUEL_SUBJECTS = [
    { id: 'mixed', label: 'Mixed BI', hint: 'Accounting + Econ + Maths' },
    { id: 'accounting', label: 'Accounting', hint: 'EXC 3430' },
    { id: 'economics', label: 'Economics', hint: 'EXC 3420' },
    { id: 'math', label: 'Maths', hint: 'EBA 1181' },
  ];

  let incoming = [];
  let outgoing = [];
  let serverOffsetMs = 0;
  let pollTimer = null;
  let uiTickHandle = null;
  let pollInFlight = false;
  let started = false;
  let lastRenderSig = '';
  let dismissedIds = new Set();
  let chimedKeys = new Set();
  let toastedFeedbackKeys = new Set();
  let launchedRoomCodes = new Set();

  function isReady() {
    return Boolean(window.StudyCommunity?.enabled && window.StudyCommunity?.isSignedIn?.());
  }

  function avatarHtml(name, avatar, size = 34) {
    return window.StudyCommunity?.avatarHtml ? window.StudyCommunity.avatarHtml(name, avatar, size) : '';
  }

  function playSoftChime(kind = 'invite') {
    try {
      if (document.hidden) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      if (ctx.state === 'suspended') { ctx.close().catch(() => {}); return; }
      const now = ctx.currentTime;
      const notes = kind === 'accepted' ? [587.33, 880] : [523.25, 659.25];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t0 = now + idx * 0.11;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.linearRampToValueAtTime(0.06, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.3);
      });
      setTimeout(() => ctx.close().catch(() => {}), 700);
    } catch {}
  }

  function getWorkSnapshot() {
    const ws = workClock?.getState?.() || { mode: 'idle', breakEndsAtMs: 0 };
    const mode = ws.mode || 'idle';
    const breakRemSec = mode === 'break'
      ? Math.max(0, Math.ceil(((ws.breakEndsAtMs || 0) - Date.now()) / 1000))
      : 0;
    return { mode, breakRemSec };
  }

  function choosePollDelayMs() {
    const hasAccepted = incoming.some((i) => i.status === 'accepted')
      || outgoing.some((i) => i.status === 'accepted');
    if (hasAccepted) return 3000;
    const hasPendingOut = outgoing.some((i) => i.status === 'pending');
    const { mode } = getWorkSnapshot();
    if (hasPendingOut || mode === 'break') return 8000;
    return 15000;
  }

  function schedulePoll(overrideMs = null) {
    clearTimeout(pollTimer);
    if (!isReady() || document.hidden) return;
    pollTimer = setTimeout(() => pollNow(), overrideMs ?? choosePollDelayMs());
  }

  async function pollNow() {
    if (!isReady() || pollInFlight) return;
    pollInFlight = true;
    try {
      const res = await window.StudyCommunity.duelRequest('/active');
      if (res && typeof res === 'object') {
        serverOffsetMs = (Number(res.now) || Date.now()) - Date.now();
        incoming = Array.isArray(res.incoming) ? res.incoming : [];
        outgoing = Array.isArray(res.outgoing) ? res.outgoing : [];
        processLifecycleEvents();
        renderOverlay(false);
      }
    } catch {
      // Quietly retry next tick
    } finally {
      pollInFlight = false;
      schedulePoll();
    }
  }

  function processLifecycleEvents() {
    // 1. Auto-join live duel room the instant Challenger clicks Proceed!
    const startedInv = [...incoming, ...outgoing].find(
      (i) => i.status === 'started' && i.roomCode && !launchedRoomCodes.has(i.roomCode)
    );
    if (startedInv) {
      launchedRoomCodes.add(startedInv.roomCode);
      const breakDlg = document.getElementById('break-modal');
      if (breakDlg?.open) breakDlg.close();
      toast(`⚔️ Duel started vs ${startedInv.opponent?.nickname || 'opponent'}!`);
      window.StudyRooms?.enterDuelRoom?.(startedInv.roomCode);
      return;
    }

    // 2. Polite feedback toasts on declined/cancelled invites
    for (const o of outgoing) {
      if (o.status === 'declined') {
        const key = `dec:${o.id}:${o.updatedAt}`;
        if (!toastedFeedbackKeys.has(key)) {
          toastedFeedbackKeys.add(key);
          toast(`${o.opponent?.nickname || 'Opponent'} declined your duel invite.`);
        }
      }
    }
    for (const inc of incoming) {
      if (inc.status === 'cancelled') {
        const key = `can:${inc.id}:${inc.updatedAt}`;
        if (!toastedFeedbackKeys.has(key)) {
          toastedFeedbackKeys.add(key);
          toast(`${inc.opponent?.nickname || 'Challenger'} postponed the duel for now.`);
        }
      }
    }
  }

  function computeDisplayCard() {
    if (!isReady()) return null;
    if (window.StudyRooms?.running?.()) return null;

    const { mode, breakRemSec } = getWorkSnapshot();
    const inRunner = !document.getElementById('view-runner')?.hidden;

    // Priority 1: Challenger's outgoing invite was ACCEPTED — show non-blocking Proceed banner even while studying!
    const acceptedOut = outgoing.find((i) => i.status === 'accepted' && !dismissedIds.has(`acc:${i.id}`));
    if (acceptedOut) {
      return { kind: 'challenger-accepted', invite: acceptedOut, urgent: true };
    }

    // Priority 2: Target already accepted — show calm "Waiting for Challenger to proceed" card
    const acceptedIn = incoming.find((i) => i.status === 'accepted');
    if (acceptedIn) {
      return { kind: 'target-waiting', invite: acceptedIn, urgent: false, breakRemSec };
    }

    // Priority 3: Target has a pending incoming duel invite — strictly break-aware!
    const pendingIn = incoming.find((i) => i.status === 'pending' && !dismissedIds.has(`pen:${i.id}`));
    if (pendingIn) {
      // NEVER pop up mid-focus while studying!
      if (mode === 'working') return null;

      // On break: quiet preview if > 60s left; prominent pop-up at <= 60s left!
      if (mode === 'break') {
        if (breakRemSec <= 60) {
          return { kind: 'target-popup', invite: pendingIn, urgent: true, breakRemSec };
        }
        return { kind: 'target-break-preview', invite: pendingIn, urgent: false, breakRemSec };
      }

      // Idle (not in a working wave): show pop-up unless actively mid-question in solo runner
      if (!inRunner) {
        return { kind: 'target-popup', invite: pendingIn, urgent: true, breakRemSec: 0 };
      }
    }

    return null;
  }

  function cardHtml(view) {
    const inv = view.invite;
    const opp = inv.opponent || {};
    const subj = inv.subjectLabel || 'BI Mixed Blitz';
    const noteHtml = inv.note ? `<p class="duel-card-note">“${esc(inv.note)}”</p>` : '';

    if (view.kind === 'challenger-accepted') {
      return `
        <div class="duel-live-card is-accepted" data-duel-id="${esc(inv.id)}" role="status" aria-live="polite">
          <div class="duel-card-top">
            ${avatarHtml(opp.nickname, opp.avatar, 36)}
            <div class="duel-card-copy">
              <div class="duel-card-eyebrow">⚔️ Duel accepted · Ready now</div>
              <strong>${esc(opp.nickname)} accepted your duel!</strong>
              <small class="muted">${esc(subj)} · 1v1 · 5 min · 6 Qs</small>
            </div>
          </div>
          <div class="duel-card-actions">
            <button type="button" class="primary-btn duel-act-btn" data-duel-act="proceed" data-duel-id="${esc(inv.id)}">Proceed to Duel →</button>
            <button type="button" class="ghost-btn duel-act-btn" data-duel-act="cancel" data-duel-id="${esc(inv.id)}">Not now</button>
          </div>
        </div>`;
    }

    if (view.kind === 'target-waiting') {
      const remTag = view.breakRemSec > 0
        ? ` · <span class="duel-break-cd">${clockSec(view.breakRemSec)}</span> left on break`
        : '';
      return `
        <div class="duel-live-card is-waiting" data-duel-id="${esc(inv.id)}" role="status" aria-live="polite">
          <div class="duel-card-top">
            ${avatarHtml(opp.nickname, opp.avatar, 34)}
            <div class="duel-card-copy">
              <div class="duel-card-eyebrow">⚔️ Ready for duel${remTag}</div>
              <strong>Waiting for ${esc(opp.nickname)} to start…</strong>
              <small class="muted">${esc(subj)} · You'll jump in automatically</small>
            </div>
          </div>
          <div class="duel-card-actions">
            <button type="button" class="ghost-btn duel-act-btn" data-duel-act="cancel" data-duel-id="${esc(inv.id)}">Cancel</button>
          </div>
        </div>`;
    }

    if (view.kind === 'target-break-preview') {
      return `
        <div class="duel-live-card is-preview" data-duel-id="${esc(inv.id)}">
          <div class="duel-card-top">
            ${avatarHtml(opp.nickname, opp.avatar, 32)}
            <div class="duel-card-copy">
              <div class="duel-card-eyebrow">⚔️ Queued duel · Pop-up at 1:00 left</div>
              <strong>${esc(opp.nickname)} challenged you</strong>
              <small class="muted">${esc(subj)} · <span class="duel-break-cd">${clockSec(view.breakRemSec)}</span> left on break</small>
            </div>
          </div>
          ${noteHtml}
          <div class="duel-card-actions">
            <button type="button" class="primary-btn duel-act-btn" data-duel-act="accept" data-duel-id="${esc(inv.id)}">Accept early ✓</button>
            <button type="button" class="ghost-btn duel-act-btn" data-duel-act="decline" data-duel-id="${esc(inv.id)}">Decline</button>
          </div>
        </div>`;
    }

    // target-popup (1 min left on break OR idle)
    const badgeTxt = view.breakRemSec > 0
      ? `⚔️ Break ending (<span class="duel-break-cd">${clockSec(view.breakRemSec)}</span> left) · Duel Invite`
      : '⚔️ Live Duel Challenge';
    return `
      <div class="duel-live-card is-popup" data-duel-id="${esc(inv.id)}" role="alertdialog" aria-label="Duel invite from ${esc(opp.nickname)}">
        <div class="duel-card-top">
          ${avatarHtml(opp.nickname, opp.avatar, 38)}
          <div class="duel-card-copy">
            <div class="duel-card-eyebrow">${badgeTxt}</div>
            <strong>${esc(opp.nickname)} wants to duel!</strong>
            <small class="muted">${esc(subj)} · 1v1 · 5 min · 6 Qs</small>
          </div>
        </div>
        ${noteHtml}
        <div class="duel-card-actions">
          <button type="button" class="primary-btn duel-act-btn" data-duel-act="accept" data-duel-id="${esc(inv.id)}">Accept Duel ✓</button>
          <button type="button" class="ghost-btn duel-act-btn" data-duel-act="decline" data-duel-id="${esc(inv.id)}">Decline</button>
        </div>
      </div>`;
  }

  function renderOverlay(force = false) {
    const floatHost = document.getElementById('duel-floating-host');
    const breakSlot = document.getElementById('break-duel-slot');
    if (!floatHost && !breakSlot) return;

    const view = computeDisplayCard();
    const breakDlgOpen = Boolean(document.getElementById('break-modal')?.open);

    if (!view) {
      if (lastRenderSig !== 'none' || force) {
        lastRenderSig = 'none';
        if (floatHost) { floatHost.innerHTML = ''; floatHost.hidden = true; }
        if (breakSlot) { breakSlot.innerHTML = ''; breakSlot.hidden = true; }
      }
      return;
    }

    // Trigger soft chime once when entering urgent popup or acceptance state
    if (view.kind === 'challenger-accepted' || view.kind === 'target-popup') {
      const cKey = `${view.kind}:${view.invite.id}`;
      if (!chimedKeys.has(cKey)) {
        chimedKeys.add(cKey);
        playSoftChime(view.kind === 'challenger-accepted' ? 'accepted' : 'invite');
      }
    }

    const mountInBreak = breakDlgOpen && Boolean(breakSlot);
    const sig = `${mountInBreak ? 'brk' : 'flt'}:${view.kind}:${view.invite.id}:${view.invite.status}:${view.invite.updatedAt}`;

    if (sig === lastRenderSig && !force) {
      // Only refresh break countdown text in-place so buttons stay rock-steady
      const activeContainer = mountInBreak ? breakSlot : floatHost;
      const cdEl = activeContainer?.querySelector('.duel-break-cd');
      if (cdEl && view.breakRemSec > 0) {
        cdEl.textContent = clockSec(view.breakRemSec);
      }
      return;
    }

    lastRenderSig = sig;
    const html = cardHtml(view);
    if (mountInBreak) {
      if (floatHost) { floatHost.innerHTML = ''; floatHost.hidden = true; }
      breakSlot.innerHTML = html;
      breakSlot.hidden = false;
    } else {
      if (breakSlot) { breakSlot.innerHTML = ''; breakSlot.hidden = true; }
      if (floatHost) {
        floatHost.innerHTML = html;
        floatHost.hidden = false;
      }
    }
  }

  async function handleCardAction(act, inviteId, btnEl) {
    if (!inviteId || !act) return;
    if (btnEl) btnEl.disabled = true;
    try {
      if (act === 'accept' || act === 'decline') {
        await window.StudyCommunity.duelRequest(`/${inviteId}/respond`, { action: act });
        toast(act === 'accept' ? '⚔️ Duel accepted! Notifying challenger…' : 'Duel invite declined.');
      } else if (act === 'proceed') {
        const res = await window.StudyCommunity.duelRequest(`/${inviteId}/proceed`, {});
        if (res?.code) {
          launchedRoomCodes.add(res.code);
          const breakDlg = document.getElementById('break-modal');
          if (breakDlg?.open) breakDlg.close();
          window.StudyRooms?.enterDuelRoom?.(res.code);
        }
      } else if (act === 'cancel') {
        await window.StudyCommunity.duelRequest(`/${inviteId}/cancel`, {});
        toast('Duel request cancelled.');
      }
      await pollNow();
    } catch (err) {
      toast(err?.message || 'Could not update duel invite.');
      if (btnEl && btnEl.isConnected) btnEl.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // CHALLENGE A CLASSMATE MODAL (#duel-challenge-dialog)
  // ---------------------------------------------------------------------------
  let challengeSelectedId = '';
  let challengeSubject = 'mixed';
  let cachedOpponents = [];

  function presencePillHtml(opp, nowMs) {
    if (opp.mode === 'break') {
      const rem = Math.max(0, Math.ceil(((opp.breakEndsAt || 0) - nowMs) / 1000));
      return `<span class="duel-pres-pill is-break">On break${rem > 0 ? ` · ${clockSec(rem)}` : ''}</span>`;
    }
    if (opp.mode === 'working') {
      return '<span class="duel-pres-pill is-working">Studying</span>';
    }
    return '<span class="duel-pres-pill is-offline">Offline</span>';
  }

  async function openChallengeModal(prefillTarget = null) {
    if (!window.StudyCommunity?.enabled) {
      toast('Direct duels require Study-OS Community.');
      return;
    }
    if (!window.StudyCommunity.isSignedIn()) {
      const ok = await window.StudyCommunity.requireProfile({ allowDemo: false, forcePrompt: true });
      if (!ok) return;
    }
    const dlg = document.getElementById('duel-challenge-dialog');
    if (!dlg) return;

    if (prefillTarget?.id) challengeSelectedId = String(prefillTarget.id);
    dlg.innerHTML = `
      <div class="duel-dlg-head">
        <div>
          <h2 id="duel-challenge-title" style="margin:0">⚔️ Challenge to a Duel</h2>
          <p class="muted" style="margin:3px 0 0;font-size:12.5px">Zero mid-focus interruption: they get a pop-up with 1 min left on their break (or right away if idle), and you choose Proceed once they accept.</p>
        </div>
        <button type="button" class="ios-done-btn" id="duel-dlg-close">Close</button>
      </div>
      <div id="duel-dlg-body" class="duel-dlg-body">
        <p class="muted" style="font-size:13px">Loading classmates…</p>
      </div>
    `;
    dlg.querySelector('#duel-dlg-close')?.addEventListener('click', () => dlg.close());
    if (!dlg.open) dlg.showModal();

    try {
      const [oppRes] = await Promise.all([
        window.StudyCommunity.duelRequest('/opponents'),
        pollNow(),
      ]);
      cachedOpponents = Array.isArray(oppRes?.opponents) ? oppRes.opponents : [];
      if (prefillTarget?.id && !cachedOpponents.some((o) => o.id === prefillTarget.id)) {
        cachedOpponents.unshift({
          id: prefillTarget.id,
          nickname: prefillTarget.nickname || 'Classmate',
          avatar: prefillTarget.avatar || '',
          school: prefillTarget.school || '',
          major: prefillTarget.major || '',
          rating: 1200,
          mode: 'offline',
          breakEndsAt: 0,
        });
      }
      if (!challengeSelectedId && cachedOpponents.length) {
        challengeSelectedId = cachedOpponents[0].id;
      }
      renderChallengeModalBody(dlg, Number(oppRes?.now) || Date.now());
    } catch (err) {
      const body = dlg.querySelector('#duel-dlg-body');
      if (body) body.innerHTML = `<p class="muted">${esc(err?.message || 'Could not load classmates.')}</p>`;
    }
  }

  function renderChallengeModalBody(dlg, nowMs) {
    const body = dlg.querySelector('#duel-dlg-body');
    if (!body) return;
    const activeOutgoing = outgoing.filter((o) => o.status === 'pending' || o.status === 'accepted');

    body.innerHTML = `
      ${activeOutgoing.length ? `
        <div class="duel-out-strip">
          <div class="duel-out-head">Active outgoing invites</div>
          ${activeOutgoing.map((o) => `
            <div class="duel-out-row">
              <div class="duel-out-who">
                ${avatarHtml(o.opponent?.nickname, o.opponent?.avatar, 24)}
                <strong>${esc(o.opponent?.nickname || 'Classmate')}</strong>
                <span class="muted">${esc(o.subjectLabel)}</span>
                <span class="badge ${o.status === 'accepted' ? 'good' : ''}">${o.status === 'accepted' ? 'Accepted!' : 'Waiting for break'}</span>
              </div>
              <div class="row-actions" style="gap:6px">
                ${o.status === 'accepted' ? `<button type="button" class="primary-btn duel-mini-btn" data-duel-act="proceed" data-duel-id="${esc(o.id)}">Proceed →</button>` : ''}
                <button type="button" class="ghost-btn duel-mini-btn" data-duel-act="cancel" data-duel-id="${esc(o.id)}">Cancel</button>
              </div>
            </div>`).join('')}
        </div>
      ` : ''}

      <div class="duel-dlg-section">
        <label class="field-label" style="margin-bottom:6px">Choose opponent
          <input type="search" id="duel-opp-filter" placeholder="Search classmate by name or school…" autocomplete="off">
        </label>
        <div id="duel-opp-list" class="duel-opp-list" role="listbox" aria-label="Classmates"></div>
      </div>

      <div class="duel-dlg-section">
        <span class="field-label" style="display:block;margin-bottom:6px">Duel subject (1v1 · 5 min · 6 Qs)</span>
        <div class="room-pill-row" id="duel-subj-pills">
          ${DUEL_SUBJECTS.map((s) => `
            <button type="button" class="preset-chip ${challengeSubject === s.id ? 'active' : ''}" data-challenge-subj="${esc(s.id)}" title="${esc(s.hint)}">${esc(s.label)}</button>
          `).join('')}
        </div>
      </div>

      <label class="field-label" style="margin:0">Short note <small class="muted">(optional)</small>
        <input type="text" id="duel-challenge-note" maxlength="90" placeholder="e.g. Quick Econ sprint after your break?">
      </label>

      <div class="row-between" style="margin-top:6px;gap:8px">
        <small id="duel-dlg-status" class="muted" role="status"></small>
        <button type="button" class="primary-btn" id="duel-send-btn" ${!cachedOpponents.length ? 'disabled' : ''}>Send Duel Request →</button>
      </div>
    `;

    const listEl = body.querySelector('#duel-opp-list');
    const filterEl = body.querySelector('#duel-opp-filter');
    const statusEl = body.querySelector('#duel-dlg-status');

    const paintOpponents = () => {
      const q = String(filterEl?.value || '').trim().toLowerCase();
      const filtered = q
        ? cachedOpponents.filter((o) => `${o.nickname} ${o.school} ${o.major}`.toLowerCase().includes(q))
        : cachedOpponents;
      if (!filtered.length) {
        listEl.innerHTML = '<p class="muted" style="padding:10px;font-size:12.5px;margin:0">No matching classmates found.</p>';
        return;
      }
      listEl.innerHTML = filtered.map((o) => {
        const selected = o.id === challengeSelectedId;
        const meta = [o.school, o.major, `Elo ${o.rating}`].filter(Boolean).join(' · ');
        return `
          <button type="button" class="duel-opp-row ${selected ? 'is-selected' : ''}" data-pick-opp="${esc(o.id)}" role="option" aria-selected="${selected ? 'true' : 'false'}">
            ${avatarHtml(o.nickname, o.avatar, 30)}
            <span class="duel-opp-meta">
              <strong>${esc(o.nickname)}</strong>
              <small class="muted">${esc(meta)}</small>
            </span>
            ${presencePillHtml(o, nowMs)}
          </button>`;
      }).join('');
    };

    paintOpponents();
    filterEl?.addEventListener('input', paintOpponents);
    listEl?.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('[data-pick-opp]');
      if (!btn) return;
      challengeSelectedId = btn.dataset.pickOpp;
      paintOpponents();
    });
    body.querySelectorAll('[data-challenge-subj]').forEach((btn) => {
      btn.addEventListener('click', () => {
        challengeSubject = btn.dataset.challengeSubj;
        body.querySelectorAll('[data-challenge-subj]').forEach((b) =>
          b.classList.toggle('active', b.dataset.challengeSubj === challengeSubject)
        );
      });
    });

    body.querySelector('#duel-send-btn')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      if (!challengeSelectedId) {
        if (statusEl) statusEl.textContent = 'Select a classmate first.';
        return;
      }
      btn.disabled = true;
      if (statusEl) statusEl.textContent = 'Sending invite…';
      try {
        const note = String(body.querySelector('#duel-challenge-note')?.value || '').trim();
        const res = await window.StudyCommunity.duelRequest('/invite', {
          targetId: challengeSelectedId,
          subject: challengeSubject,
          note,
        });
        const oppName = res?.invite?.opponent?.nickname || 'your classmate';
        toast(`⚔️ Duel request sent to ${oppName}! Keep studying — we'll alert you when they accept.`);
        await pollNow();
        dlg.close();
      } catch (err) {
        if (statusEl) statusEl.textContent = err?.message || 'Could not send invite.';
        btn.disabled = false;
      }
    });
  }

  function bindGlobalListeners() {
    if (started) return;
    started = true;

    // Delegated click handler for floating card, break slot, and challenge dialog action buttons
    document.addEventListener('click', (ev) => {
      const actBtn = ev.target?.closest?.('[data-duel-act]');
      if (actBtn) {
        ev.preventDefault();
        handleCardAction(actBtn.dataset.duelAct, actBtn.dataset.duelId, actBtn);
        return;
      }
      const chalBtn = ev.target?.closest?.('[data-challenge-member-id]');
      if (chalBtn) {
        ev.preventDefault();
        openChallengeModal({
          id: chalBtn.dataset.challengeMemberId,
          nickname: chalBtn.dataset.challengeMemberName || '',
        });
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && isReady()) pollNow();
      else clearTimeout(pollTimer);
    });

    // Re-evaluate break-remaining 1-minute pop-up threshold every second locally (zero network cost!)
    clearInterval(uiTickHandle);
    uiTickHandle = setInterval(() => {
      if (isReady()) renderOverlay(false);
    }, 1000);

    if (isReady()) pollNow();
  }

  function onAuthChanged() {
    if (isReady()) {
      pollNow();
    } else {
      incoming = [];
      outgoing = [];
      clearTimeout(pollTimer);
      renderOverlay(true);
    }
  }

  return {
    init: bindGlobalListeners,
    pollNow,
    onAuthChanged,
    openChallengeModal,
    getState: () => ({ incoming: [...incoming], outgoing: [...outgoing] }),
  };
})();
