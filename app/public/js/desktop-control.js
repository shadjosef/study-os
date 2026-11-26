/* Study-OS Opt-In Desktop Telemetry, Focus Shield & Verifiable Local Control Widget
 * Zero dependencies · Dual-mode:
 *   1. Local Desktop Mode (127.0.0.1 / localhost with /api/desktop/status):
 *      - Master opt-in toggle, 1-click Pause / Incognito, Focus Shield toggle
 *      - Today's per-app & category breakdown bars (Deep Study, Reading, Browser, Distraction, Idle)
 *      - Verifiable Privacy Proof badge (0 network uploads · 0 keystrokes · 0 screenshots + sourceSha256)
 *      - Download Verifiable Audit JSON (/api/desktop/export)
 *   2. Web Mode (studyos.no / static build):
 *      - Non-intrusive "Full Control & Verifiable Local Desktop Edition" card with GitHub Releases,
 *        DESKTOP_TELEMETRY.md audit spec, and 1-line local launch command.
 */
'use strict';

window.StudyDesktopControl = (() => {
  const REPO_URL = 'https://github.com/shadjosef/study-os';
  const RELEASES_URL = `${REPO_URL}/releases`;
  const AUDIT_DOC_URL = `${REPO_URL}/blob/main/docs/DESKTOP_TELEMETRY.md`;
  const QUICK_CLONE_CMD = 'git clone https://github.com/shadjosef/study-os.git && cd study-os && python3 app/server.py --open';

  const CATEGORY_META = [
    { key: 'deep_study', label: 'Deep Study / IDE', color: '#0f766e' },
    { key: 'reading_notes', label: 'Reading / Notes', color: '#2563eb' },
    { key: 'browser', label: 'Browser', color: '#d97706' },
    { key: 'distraction', label: 'Distraction', color: '#dc2626' },
    { key: 'other', label: 'Other', color: '#64748b' },
    { key: 'idle', label: 'System Idle', color: '#94a3b8' },
  ];

  const CATEGORY_LABELS = Object.fromEntries(CATEGORY_META.map((c) => [c.key, c.label]));
  const CATEGORY_COLORS = Object.fromEntries(CATEGORY_META.map((c) => [c.key, c.color]));

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const fmtDuration = (sec) => {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s === 0) return '0m';
    if (s < 60) return `${s}s`;
    const mins = Math.round(s / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  };

  const fmtPlatform = (p) => {
    if (p === 'darwin') return 'macOS';
    if (p === 'win32') return 'Windows';
    if (p === 'linux') return 'Linux';
    return String(p || 'Desktop');
  };

  const state = {
    mode: 'unknown', // 'local' | 'web' | 'unknown'
    status: null,
    busy: false,
    error: '',
    container: null,
    pollTimer: null,
    lastWorkMode: null,
  };

  let analyticsObserver = null;
  let autoMounting = false;

  function ensureStyles() {
    if (document.getElementById('study-desktop-control-styles')) return;
    const style = document.createElement('style');
    style.id = 'study-desktop-control-styles';
    style.textContent = `
      .dc-card {
        background: var(--panel, #ffffff);
        border: 1px solid var(--border, var(--line, rgba(17, 22, 21, 0.1)));
        border-radius: var(--radius, 18px);
        padding: 18px 20px;
        margin-bottom: 14px;
        color: var(--text, var(--ink, #111615));
        box-shadow: var(--shadow, 0 1px 2px rgba(15, 23, 21, 0.04));
        max-width: 100%;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .dc-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .dc-eyebrow {
        display: inline-block;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--accent, #0f6e57);
        margin-bottom: 3px;
      }
      .dc-title {
        margin: 0;
        font-size: 16.5px;
        font-weight: 700;
        line-height: 1.25;
        color: var(--text, var(--ink, #111615));
      }
      .dc-sub {
        margin: 4px 0 0;
        font-size: 13px;
        color: var(--muted, #4e5c59);
        line-height: 1.45;
      }
      .dc-badges {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .dc-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 11.5px;
        font-weight: 700;
        border: 1px solid var(--border, var(--line, rgba(17, 22, 21, 0.1)));
        background: var(--panel-alt, #eef2f5);
        color: var(--text, var(--ink, #111615));
        white-space: nowrap;
      }
      .dc-pill.is-live {
        background: var(--good-soft, rgba(18, 104, 64, 0.12));
        color: var(--good, #126840);
        border-color: transparent;
      }
      .dc-pill.is-paused {
        background: var(--warn-soft, rgba(217, 119, 6, 0.14));
        color: var(--warn, #8a4f04);
        border-color: transparent;
      }
      .dc-pill.is-off {
        background: var(--panel-alt, #eef2f5);
        color: var(--muted, #4e5c59);
      }
      .dc-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: currentColor;
        display: inline-block;
      }
      .dc-controls-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: 10px;
        margin: 12px 0 14px;
      }
      .dc-toggle-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 11px 13px;
        border-radius: 13px;
        border: 1px solid var(--border, var(--line, rgba(17, 22, 21, 0.1)));
        background: var(--panel-alt, #eef2f5);
        min-width: 0;
      }
      .dc-toggle-copy {
        min-width: 0;
        flex: 1;
      }
      .dc-toggle-copy strong {
        display: block;
        font-size: 13px;
        line-height: 1.3;
        color: var(--text, var(--ink, #111615));
      }
      .dc-toggle-copy small {
        display: block;
        font-size: 11.5px;
        color: var(--muted, #4e5c59);
        line-height: 1.35;
        margin-top: 2px;
      }
      .dc-switch {
        position: relative;
        flex-shrink: 0;
        width: 42px;
        height: 24px;
        border-radius: 999px;
        border: 1px solid var(--border, var(--line, rgba(17, 22, 21, 0.16)));
        background: var(--panel, #ffffff);
        cursor: pointer;
        padding: 0;
        transition: background 0.16s ease, border-color 0.16s ease;
      }
      .dc-switch::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 2px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--muted, #4e5c59);
        transition: transform 0.16s ease, background 0.16s ease;
      }
      .dc-switch[aria-checked="true"] {
        background: var(--accent, #0f6e57);
        border-color: var(--accent, #0f6e57);
      }
      .dc-switch[aria-checked="true"]::after {
        transform: translateX(18px);
        background: #ffffff;
      }
      html[data-theme="dark"] .dc-switch[aria-checked="true"]::after {
        background: #091512;
      }
      .dc-switch:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .dc-action-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 7px 12px;
        border-radius: 10px;
        font-size: 12.5px;
        font-weight: 650;
        line-height: 1.25;
        cursor: pointer;
        text-decoration: none;
        border: 1px solid var(--border, var(--line, rgba(17, 22, 21, 0.12)));
        background: var(--panel, #ffffff);
        color: var(--text, var(--ink, #111615));
        transition: background 0.15s ease, border-color 0.15s ease;
        white-space: nowrap;
      }
      .dc-action-btn:hover {
        border-color: var(--accent, #0f6e57);
        text-decoration: none;
      }
      .dc-action-btn.is-primary {
        background: var(--accent, #0f6e57);
        border-color: var(--accent, #0f6e57);
        color: #ffffff;
      }
      html[data-theme="dark"] .dc-action-btn.is-primary {
        color: #091512;
      }
      .dc-action-btn.is-warn {
        background: var(--warn-soft, rgba(217, 119, 6, 0.14));
        border-color: var(--warn, #8a4f04);
        color: var(--warn, #8a4f04);
      }
      .dc-breakdown {
        margin: 10px 0 14px;
      }
      .dc-stack-track {
        display: flex;
        width: 100%;
        height: 10px;
        border-radius: 999px;
        overflow: hidden;
        background: var(--panel-alt, #eef2f5);
        border: 1px solid var(--border, var(--line, rgba(17, 22, 21, 0.08)));
        margin-bottom: 10px;
      }
      .dc-stack-seg {
        height: 100%;
        min-width: 2px;
      }
      .dc-cat-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 8px;
        margin-bottom: 12px;
      }
      .dc-cat-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 10px;
        border-radius: 10px;
        background: var(--panel-alt, #eef2f5);
        font-size: 12.5px;
        min-width: 0;
      }
      .dc-cat-name {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--muted, #4e5c59);
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dc-cat-swatch {
        width: 8px;
        height: 8px;
        border-radius: 2px;
        flex-shrink: 0;
      }
      .dc-apps-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .dc-app-row {
        display: grid;
        grid-template-columns: minmax(90px, 150px) 1fr auto;
        align-items: center;
        gap: 10px;
        font-size: 12.5px;
      }
      .dc-app-name {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dc-app-bar-wrap {
        height: 7px;
        border-radius: 999px;
        background: var(--panel-alt, #eef2f5);
        overflow: hidden;
        min-width: 40px;
      }
      .dc-app-bar-fill {
        height: 100%;
        border-radius: 999px;
      }
      .dc-app-time {
        font-variant-numeric: tabular-nums;
        color: var(--muted, #4e5c59);
        font-weight: 600;
        white-space: nowrap;
      }
      .dc-proof-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        padding-top: 12px;
        border-top: 1px solid var(--border, var(--line, rgba(17, 22, 21, 0.09)));
      }
      .dc-proof-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        font-size: 12px;
        color: var(--muted, #4e5c59);
      }
      .dc-proof-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 9px;
        border-radius: 8px;
        background: var(--accent-soft, rgba(15, 110, 87, 0.11));
        color: var(--accent, #0f6e57);
        font-weight: 700;
        font-size: 11.5px;
      }
      .dc-hash-code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11.5px;
        padding: 2px 6px;
        border-radius: 6px;
        background: var(--panel-alt, #eef2f5);
        color: var(--text, var(--ink, #111615));
      }
      .dc-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .dc-web-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(195px, 1fr));
        gap: 10px;
        margin: 12px 0;
      }
      .dc-web-feature {
        padding: 11px 12px;
        border-radius: 12px;
        background: var(--panel-alt, #eef2f5);
        border: 1px solid var(--border, var(--line, rgba(17, 22, 21, 0.08)));
        font-size: 12.5px;
        line-height: 1.45;
      }
      .dc-web-feature strong {
        display: block;
        margin-bottom: 3px;
        font-size: 13px;
        color: var(--text, var(--ink, #111615));
      }
      .dc-web-feature span {
        color: var(--muted, #4e5c59);
      }
      .dc-cmd-box {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        padding: 9px 12px;
        border-radius: 11px;
        background: var(--panel-alt, #eef2f5);
        border: 1px solid var(--border, var(--line, rgba(17, 22, 21, 0.1)));
        margin: 10px 0 12px;
      }
      .dc-cmd-box code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        color: var(--text, var(--ink, #111615));
        word-break: break-all;
        flex: 1 1 220px;
      }
      .dc-empty {
        padding: 10px 12px;
        border-radius: 11px;
        background: var(--panel-alt, #eef2f5);
        font-size: 12.5px;
        color: var(--muted, #4e5c59);
      }
      .dc-error {
        margin: 8px 0 0;
        font-size: 12.5px;
        color: var(--bad, #b91c34);
        font-weight: 600;
      }
      @media (max-width: 520px) {
        .dc-card {
          padding: 14px;
        }
        .dc-app-row {
          grid-template-columns: minmax(80px, 115px) 1fr auto;
          gap: 8px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function isStaticWebBuild() {
    return document.documentElement?.dataset?.studyMode === 'web';
  }

  function isLoopbackHost() {
    const host = String(window.location?.hostname || '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  }

  async function fetchDesktopStatus() {
    if (isStaticWebBuild() || !isLoopbackHost()) {
      state.mode = 'web';
      state.status = null;
      return null;
    }
    try {
      const res = await fetch('/api/desktop/status', {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        state.mode = 'web';
        state.status = null;
        return null;
      }
      const data = await res.json();
      if (data && data.available === true) {
        state.mode = 'local';
        state.status = data;
        state.error = '';
        return data;
      }
    } catch {
      // Fallback cleanly to web edition info card when local server is absent.
    }
    state.mode = 'web';
    state.status = null;
    return null;
  }

  async function patchDesktopConfig(patch) {
    state.busy = true;
    state.error = '';
    renderCurrent();
    try {
      const res = await fetch('/api/desktop/config', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        state.error = data.error || `Could not update settings (HTTP ${res.status}).`;
      } else {
        state.status = data;
        state.mode = 'local';
        state.error = '';
      }
    } catch {
      state.error = 'Could not reach the local Study-OS desktop server.';
    } finally {
      state.busy = false;
      renderCurrent();
    }
  }

  async function copyText(text, successMsg) {
    try {
      await navigator.clipboard.writeText(text);
      window.StudyUI?.toast?.(successMsg);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        window.StudyUI?.toast?.(successMsg);
      } catch {}
      ta.remove();
    }
  }

  function renderWebMode(container) {
    container.innerHTML = `
      <section class="dc-card" aria-labelledby="dc-web-heading">
        <div class="dc-head">
          <div>
            <span class="dc-eyebrow">Full Control · Open-Source Local Server</span>
            <h3 class="dc-title" id="dc-web-heading">Full Control &amp; Verifiable Local Desktop Edition</h3>
            <p class="dc-sub">
              <strong>studyos.no</strong> stays zero-install for instant study anywhere. For power users and privacy-conscious students,
              run the 100% open-source Desktop Edition locally on <code>127.0.0.1:8765</code> with SHA-256 verifiable builds.
            </p>
          </div>
          <div class="dc-badges">
            <span class="dc-pill is-live"><span class="dc-dot" aria-hidden="true"></span>100% Stdlib · Auditable</span>
          </div>
        </div>

        <div class="dc-web-grid">
          <div class="dc-web-feature">
            <strong>Opt-In OS App Telemetry</strong>
            <span>Track active study across VS Code, Excel, Obsidian, Preview &amp; PDFs — stored locally in JSONL.</span>
          </div>
          <div class="dc-web-feature">
            <strong>Opt-In Focus Shield</strong>
            <span>Soft-hides distracting apps (Discord, Slack, Messages) only during active study blocks — never on breaks.</span>
          </div>
          <div class="dc-web-feature">
            <strong>Unlimited Local Disk &amp; Proof</strong>
            <span>Zero network uploads, zero keylogging, zero screenshots, plus verifiable <code>sourceSha256</code> audit exports.</span>
          </div>
        </div>

        <div class="dc-cmd-box">
          <code>${esc(QUICK_CLONE_CMD)}</code>
          <button type="button" class="dc-action-btn" id="dc-copy-cmd">Copy command</button>
        </div>

        <div class="dc-proof-bar">
          <div class="dc-proof-meta">
            <span class="dc-proof-badge">0 network uploads · 0 keystrokes · 0 screenshots</span>
            <span>Verify downloads against <code>SHA256SUMS.txt</code></span>
          </div>
          <div class="dc-actions">
            <a class="dc-action-btn is-primary" href="${esc(RELEASES_URL)}" target="_blank" rel="noopener">GitHub Releases (SHA256SUMS) ↗</a>
            <a class="dc-action-btn" href="${esc(AUDIT_DOC_URL)}" target="_blank" rel="noopener">Privacy &amp; Audit Spec ↗</a>
          </div>
        </div>
      </section>
    `;

    container.querySelector('#dc-copy-cmd')?.addEventListener('click', () => {
      copyText(QUICK_CLONE_CMD, 'Copied local Desktop Edition launch command!');
    });
  }

  function renderLocalMode(container) {
    const st = state.status;
    if (!st) {
      renderWebMode(container);
      return;
    }

    const enabled = Boolean(st.enabled);
    const paused = Boolean(st.paused);
    const shield = Boolean(st.focusShieldEnabled);
    const sessionActive = Boolean(st.sessionActive);
    const today = st.today || {};
    const byCat = today.byCategory || {};
    const idleSec = Math.max(0, Number(today.idleSec) || 0);
    const totalSec = Math.max(0, Number(today.totalSec) || 0);
    const topApps = Array.isArray(today.topApps) ? today.topApps : [];
    const audit = st.audit || {};
    const fullHash = String(audit.sourceSha256 || '');
    const shortHash = fullHash ? fullHash.slice(0, 12) : 'unavailable';

    const statusBadge = !enabled
      ? '<span class="dc-pill is-off"><span class="dc-dot" aria-hidden="true"></span>OFF · Opt-In Required</span>'
      : paused
      ? '<span class="dc-pill is-paused"><span class="dc-dot" aria-hidden="true"></span>PAUSED · Incognito</span>'
      : '<span class="dc-pill is-live"><span class="dc-dot" aria-hidden="true"></span>ACTIVE · Local Only</span>';

    const catValues = CATEGORY_META.map((meta) => ({
      ...meta,
      sec: meta.key === 'idle' ? idleSec : Math.max(0, Number(byCat[meta.key]) || 0),
    }));
    const stackTotal = catValues.reduce((sum, c) => sum + c.sec, 0);

    const stackHtml = stackTotal > 0
      ? `<div class="dc-stack-track" role="img" aria-label="Today's desktop activity category distribution">
          ${catValues
            .filter((c) => c.sec > 0)
            .map((c) => {
              const pct = Math.max(1, (c.sec / stackTotal) * 100);
              return `<span class="dc-stack-seg" style="width:${pct.toFixed(2)}%;background:${esc(c.color)}" title="${esc(c.label)}: ${esc(fmtDuration(c.sec))}"></span>`;
            })
            .join('')}
        </div>`
      : '';

    const catGridHtml = `
      <div class="dc-cat-grid">
        ${catValues
          .map(
            (c) => `
          <div class="dc-cat-item">
            <span class="dc-cat-name"><i class="dc-cat-swatch" style="background:${esc(c.color)}" aria-hidden="true"></i>${esc(c.label)}</span>
            <strong>${esc(fmtDuration(c.sec))}</strong>
          </div>`
          )
          .join('')}
      </div>
    `;

    const maxAppSec = topApps.length ? Math.max(...topApps.map((a) => Number(a.sec) || 0), 1) : 1;
    const appsHtml = topApps.length
      ? `<div class="dc-apps-list">
          ${topApps
            .slice(0, 8)
            .map((a) => {
              const pct = Math.max(4, Math.min(100, Math.round(((Number(a.sec) || 0) / maxAppSec) * 100)));
              const color = CATEGORY_COLORS[a.category] || '#64748b';
              const catLabel = CATEGORY_LABELS[a.category] || 'Other';
              return `
                <div class="dc-app-row" title="${esc(a.app)} (${esc(catLabel)}) — ${esc(fmtDuration(a.sec))}">
                  <span class="dc-app-name">${esc(a.app)}</span>
                  <div class="dc-app-bar-wrap" aria-hidden="true">
                    <div class="dc-app-bar-fill" style="width:${pct}%;background:${esc(color)}"></div>
                  </div>
                  <span class="dc-app-time">${esc(fmtDuration(a.sec))}</span>
                </div>`;
            })
            .join('')}
        </div>`
      : `<div class="dc-empty">${
          enabled
            ? paused
              ? 'Incognito pause is active — no app names or idle samples are being recorded.'
              : 'Waiting for first 60s local sample. Switch between your study apps (VS Code, Excel, Obsidian, Preview) to see today’s breakdown.'
            : 'Desktop tracking is strictly OFF by default. Enable local OS app tracking above to measure real time spent in IDEs, PDFs, and notes — stored only on this computer.'
        }</div>`;

    const shieldArmed = enabled && shield && sessionActive && !paused;

    container.innerHTML = `
      <section class="dc-card" aria-labelledby="dc-local-heading">
        <div class="dc-head">
          <div>
            <span class="dc-eyebrow">Full-Control Desktop Edition · ${esc(fmtPlatform(st.platform))}</span>
            <h3 class="dc-title" id="dc-local-heading">Desktop Telemetry &amp; Focus Shield</h3>
            <p class="dc-sub">
              Strictly local OS app tracking (app name + idle seconds only; never window titles, keystrokes, or screenshots).
              ${today.shieldTriggers ? `Focus Shield softened ${today.shieldTriggers} distraction${today.shieldTriggers === 1 ? '' : 's'} today.` : ''}
            </p>
          </div>
          <div class="dc-badges">
            ${statusBadge}
            <span class="dc-pill">Today: ${esc(fmtDuration(totalSec))}</span>
          </div>
        </div>

        <div class="dc-controls-grid">
          <div class="dc-toggle-card">
            <div class="dc-toggle-copy">
              <strong>Enable Local OS App Tracking</strong>
              <small>Opt-in 60s JSONL summaries on disk</small>
            </div>
            <button type="button" class="dc-switch" id="dc-toggle-enabled" role="switch" aria-checked="${enabled ? 'true' : 'false'}" aria-label="Enable Local OS App Tracking" ${state.busy ? 'disabled' : ''}></button>
          </div>

          <div class="dc-toggle-card">
            <div class="dc-toggle-copy">
              <strong>Focus Shield ${shieldArmed ? '· Armed' : ''}</strong>
              <small>Soft-hide distracting apps during study blocks</small>
            </div>
            <button type="button" class="dc-switch" id="dc-toggle-shield" role="switch" aria-checked="${shield ? 'true' : 'false'}" aria-label="Enable Focus Shield" ${state.busy ? 'disabled' : ''}></button>
          </div>

          <div class="dc-toggle-card">
            <div class="dc-toggle-copy">
              <strong>Pause / Incognito</strong>
              <small>${paused ? 'Recording &amp; Focus Shield suspended' : '1-click instant privacy pause'}</small>
            </div>
            <button type="button" class="dc-action-btn ${paused ? 'is-warn' : ''}" id="dc-btn-pause" aria-pressed="${paused ? 'true' : 'false'}" ${state.busy ? 'disabled' : ''}>
              ${paused ? 'Resume' : 'Pause'}
            </button>
          </div>

          <div class="dc-toggle-card">
            <div class="dc-toggle-copy">
              <strong>Study Block Lock</strong>
              <small>${sessionActive ? 'Shield active for distracting apps' : 'Standby (free / on break)'}</small>
            </div>
            <button type="button" class="dc-switch" id="dc-toggle-session" role="switch" aria-checked="${sessionActive ? 'true' : 'false'}" aria-label="Study Block Active for Focus Shield" ${state.busy ? 'disabled' : ''}></button>
          </div>
        </div>

        <div class="dc-breakdown">
          ${stackHtml}
          ${catGridHtml}
          ${appsHtml}
        </div>

        ${state.error ? `<p class="dc-error" role="alert">${esc(state.error)}</p>` : ''}

        <div class="dc-proof-bar">
          <div class="dc-proof-meta">
            <span class="dc-proof-badge">0 network uploads · 0 keystrokes · 0 screenshots</span>
            <span title="SHA-256 of ${esc(audit.sourcePath || 'app/desktop_tracker.py')}: ${esc(fullHash)}">
              <code>sourceSha256</code> <code class="dc-hash-code">${esc(shortHash)}</code>
            </span>
          </div>
          <div class="dc-actions">
            ${fullHash ? '<button type="button" class="dc-action-btn" id="dc-copy-hash">Copy SHA-256</button>' : ''}
            <a class="dc-action-btn is-primary" href="/api/desktop/export" download="study-os-desktop-telemetry.json">Download Verifiable Audit JSON</a>
            <a class="dc-action-btn" href="${esc(AUDIT_DOC_URL)}" target="_blank" rel="noopener">Audit Spec ↗</a>
          </div>
        </div>
      </section>
    `;

    container.querySelector('#dc-toggle-enabled')?.addEventListener('click', () => {
      patchDesktopConfig({ enabled: !enabled });
    });
    container.querySelector('#dc-toggle-shield')?.addEventListener('click', () => {
      patchDesktopConfig({ focusShieldEnabled: !shield });
    });
    container.querySelector('#dc-btn-pause')?.addEventListener('click', () => {
      patchDesktopConfig({ paused: !paused });
    });
    container.querySelector('#dc-toggle-session')?.addEventListener('click', () => {
      patchDesktopConfig({ sessionActive: !sessionActive });
    });
    container.querySelector('#dc-copy-hash')?.addEventListener('click', () => {
      copyText(fullHash, 'Copied app/desktop_tracker.py SHA-256 hash!');
    });
  }

  function renderCurrent() {
    const container = state.container;
    if (!container || !container.isConnected) {
      stopPolling();
      return;
    }
    ensureStyles();
    if (state.mode === 'local' && state.status) {
      renderLocalMode(container);
    } else {
      renderWebMode(container);
    }
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function syncWorkClockSessionIfNeeded() {
    if (state.mode !== 'local' || !state.status || !state.status.enabled || !state.status.focusShieldEnabled) {
      return;
    }
    const wcState = window.StudyUI?.workClock?.getState?.();
    if (!wcState || typeof wcState.mode !== 'string') return;
    const isWorking = wcState.mode === 'working' && !wcState.wavePausedSinceMs;
    if (state.lastWorkMode !== null && state.lastWorkMode !== isWorking && state.status.sessionActive !== isWorking) {
      state.lastWorkMode = isWorking;
      patchDesktopConfig({ sessionActive: isWorking });
      return;
    }
    state.lastWorkMode = isWorking;
  }

  function startPolling() {
    stopPolling();
    if (state.mode !== 'local') return;
    state.pollTimer = setInterval(async () => {
      if (!state.container || !state.container.isConnected) {
        stopPolling();
        return;
      }
      if (document.hidden) return;
      syncWorkClockSessionIfNeeded();
      if (state.status?.enabled && !state.status?.paused && !state.busy) {
        await fetchDesktopStatus();
        renderCurrent();
      }
    }, 30_000);
  }

  async function mount(container) {
    if (!container) return;
    ensureStyles();
    state.container = container;
    container.dataset.dcMounted = '1';

    if (state.mode === 'unknown') {
      await fetchDesktopStatus();
    } else if (state.mode === 'local') {
      await fetchDesktopStatus();
    }
    renderCurrent();
    startPolling();
  }

  async function refresh() {
    if (!state.container || !state.container.isConnected) return null;
    const data = await fetchDesktopStatus();
    renderCurrent();
    startPolling();
    return data;
  }

  function ensureMountedInAnalytics(root) {
    if (!root || autoMounting) return;
    // Wait until StudyMetrics has rendered the dashboard inside #analytics-root
    const hasMetrics = Boolean(root.querySelector('.mc-top-head, .mc-kpi-grid, #mc-desktop-control-slot'));
    if (!hasMetrics) return;

    let slot = root.querySelector('#mc-desktop-control-slot');
    if (slot && slot.dataset.dcMounted === '1') return;

    autoMounting = true;
    try {
      if (!slot) {
        slot = document.createElement('div');
        slot.id = 'mc-desktop-control-slot';
        const briefEl = root.querySelector('.mc-brief-details');
        if (briefEl && briefEl.parentNode === root) {
          root.insertBefore(slot, briefEl);
        } else {
          root.appendChild(slot);
        }
      }
      mount(slot);
    } finally {
      autoMounting = false;
    }
  }

  function initAutoObserver() {
    const root = document.getElementById('analytics-root');
    if (!root || analyticsObserver) return;
    ensureMountedInAnalytics(root);
    analyticsObserver = new MutationObserver(() => {
      if (autoMounting) return;
      ensureMountedInAnalytics(root);
    });
    analyticsObserver.observe(root, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAutoObserver, { once: true });
  } else {
    initAutoObserver();
  }

  return {
    mount,
    refresh,
    getState: () => ({ mode: state.mode, status: state.status }),
  };
})();
