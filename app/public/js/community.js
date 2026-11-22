'use strict';

window.StudyCommunity = (() => {
  const api = document.documentElement.dataset.communityApi;
  const keyName = 'study-os-community-profile';
  const demoKey = 'study-os-demo';
  const { esc, toast, clockSec, workClock } = window.StudyUI;
  let token = '';
  let currentProfile = null;
  let authConfigPromise = null;
  let turnstilePromise = null;
  let gsiLoadPromise = null;
  let gsiInitializedClient = '';
  let gsiActiveCallback = null;
  let lastSync = '';
  let syncTimer;
  let lastPresence = '';
  let lastPresenceAt = 0;
  let presenceSync = Promise.resolve();
  let lastChatAt = 0;
  let chatLoading = false;
  let openingBreak = false;
  const demoMessages = [];
  const canUse = () => workClock.canUseBreakTools() && !window.StudyRooms?.running();
  try { token = localStorage.getItem(keyName) || ''; } catch {}

  function useProfile(key) {
    localStorage.setItem(keyName, key);
    token = key;
    if (!key) {
      currentProfile = null;
      if (window.StudyMembers?.isTransient?.()) {
        window.StudyMembers.forget().catch(() => {});
      }
    }
    lastSync = '';
    lastPresence = '';
    lastPresenceAt = 0;
    clearTimeout(syncTimer);
    window.StudyApp?.syncSettingsRows?.();
  }

  async function hashAccessCode(rawCode) {
    const clean = String(rawCode || '').trim();
    if (!/^\S{4,120}$/.test(clean)) return null;
    const enc = new TextEncoder();
    const shaHex = async (str) => {
      const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str)));
      return [...buf].map((v) => v.toString(16).padStart(2, '0')).join('');
    };
    const proof = await shaHex(clean);
    const upper = clean.toUpperCase();
    const proofUpper = upper === clean ? proof : await shaHex(upper);
    return { proof, proofUpper };
  }

  async function syncTransientArchiveFromProfile(profile) {
    if (!window.StudyMembers?.enabled) return false;
    const mk = profile?.archiveMemberKey || '';
    if (mk) {
      if (!window.StudyMembers.isUnlocked()) {
        try {
          await window.StudyMembers.unlockTransient(mk);
          await window.StudyApp?.refreshArchiveViews?.();
          return true;
        } catch {}
      }
      return true;
    }
    if (window.StudyMembers.isTransient?.()) {
      await window.StudyMembers.forget().catch(() => {});
      await window.StudyApp?.refreshArchiveViews?.();
    }
    return false;
  }

  async function redeemAccessCode(rawCode) {
    if (!api || !token) throw new Error('Sign in first to redeem an access code.');
    const clean = String(rawCode || '').trim();
    if (/^sos1_/i.test(clean)) {
      throw new Error('Paste a sos1_… archive key directly in Settings → Private PDF Archive.');
    }
    const hashes = await hashAccessCode(clean);
    if (!hashes) throw new Error('Enter a valid access code (at least 4 characters).');
    const res = await request('/auth/redeem-code', hashes);
    if (res?.archiveMemberKey && window.StudyMembers?.enabled) {
      await window.StudyMembers.unlockTransient(res.archiveMemberKey);
      await window.StudyApp?.refreshArchiveViews?.();
    }
    return res;
  }

  function toBase64Url(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function detectDeviceLabel() {
    const ua = navigator.userAgent || '';
    const os = /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) ? 'iPad'
      : /Macintosh|Mac OS/.test(ua) ? 'Mac'
      : /Windows/.test(ua) ? 'Windows'
      : /Android/.test(ua) ? 'Android'
      : 'Device';
    const browser = /Vivaldi/.test(ua) ? 'Vivaldi'
      : /Edg\//.test(ua) ? 'Edge'
      : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari'
      : 'Browser';
    return `${os} · ${browser}`;
  }

  function getAuthConfig() {
    if (!api) return Promise.resolve({});
    if (!authConfigPromise) {
      authConfigPromise = request('/auth/config', null, '')
        .catch(() => {
          authConfigPromise = null;
          return {};
        });
    }
    return authConfigPromise;
  }

  async function humanToken(form, action, status) {
    const { turnstileSiteKey } = await getAuthConfig();
    if (!turnstileSiteKey) return '';
    status.textContent = 'Checking that you’re human…';
    if (!window.turnstile && !turnstilePromise) {
      turnstilePromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Could not load the security check. Try again.'));
        document.head.appendChild(script);
      }).catch(error => {
        turnstilePromise = null;
        throw error;
      });
    }
    await turnstilePromise;
    const mount = document.createElement('div');
    form.append(mount);
    let widget;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        const failed = () => reject(new Error('The security check could not finish. Try again.'));
        timer = setTimeout(failed, 120_000);
        widget = window.turnstile.render(mount, {
          sitekey: turnstileSiteKey, action, size: 'flexible', execution: 'execute', appearance: 'interaction-only',
          callback: resolve, 'error-callback': failed, 'expired-callback': failed, 'timeout-callback': failed,
        });
        window.turnstile.execute(widget);
      });
    } finally {
      clearTimeout(timer);
      if (widget) window.turnstile.remove(widget);
      mount.remove();
    }
  }

  const SCHOOL_CATALOG = [
    { name: 'BI Oslo', short: 'BI', canvasOrigin: 'https://canvas.bi.no', timetableUrl: 'https://cloud.timeedit.net/bi/web/public/ri1Q7.html', timetableLabel: 'BI TimeEdit' },
    { name: 'HVL', short: 'HVL', canvasOrigin: 'https://hvl.instructure.com', timetableUrl: 'https://tp.educloud.no/hvl/', timetableLabel: 'HVL TP' },
    { name: 'Kristiania', short: 'Kristiania', canvasOrigin: 'https://kristiania.instructure.com', timetableUrl: 'https://cloud.timeedit.net/kristiania/web/', timetableLabel: 'Kristiania TimeEdit' },
    { name: 'NHH', short: 'NHH', canvasOrigin: 'https://nhh.instructure.com', timetableUrl: 'https://cloud.timeedit.net/nhh/web/', timetableLabel: 'NHH TimeEdit' },
    { name: 'NMBU', short: 'NMBU', canvasOrigin: 'https://nmbu.instructure.com', timetableUrl: 'https://cloud.timeedit.net/nmbu/web/', timetableLabel: 'NMBU TimeEdit' },
    { name: 'NTNU', short: 'NTNU', canvasOrigin: 'https://ntnu.instructure.com', timetableUrl: 'https://tp.educloud.no/ntnu/', timetableLabel: 'NTNU TP' },
    { name: 'OsloMet', short: 'OsloMet', canvasOrigin: 'https://oslomet.instructure.com', timetableUrl: 'https://tp.educloud.no/oslomet/', timetableLabel: 'OsloMet TP' },
    { name: 'UiA', short: 'UiA', canvasOrigin: 'https://uia.instructure.com', timetableUrl: 'https://tp.educloud.no/uia/', timetableLabel: 'UiA TP' },
    { name: 'UiB', short: 'UiB', canvasOrigin: 'https://mitt.uib.no', timetableUrl: 'https://tp.educloud.no/uib/', timetableLabel: 'UiB TP' },
    { name: 'UiO', short: 'UiO', canvasOrigin: 'https://uio.instructure.com', timetableUrl: 'https://tp.educloud.no/uio/', timetableLabel: 'UiO TP' },
    { name: 'UiS', short: 'UiS', canvasOrigin: 'https://uis.instructure.com', timetableUrl: 'https://tp.educloud.no/uis/', timetableLabel: 'UiS TP' },
    { name: 'UiT', short: 'UiT', canvasOrigin: 'https://uit.instructure.com', timetableUrl: 'https://tp.educloud.no/uit/', timetableLabel: 'UiT TP' },
    { name: 'USN', short: 'USN', canvasOrigin: 'https://usn.instructure.com', timetableUrl: 'https://cloud.timeedit.net/usn/web/', timetableLabel: 'USN TimeEdit' },
  ];
  const MAJOR_CATALOG = [
    'Accounting & Auditing',
    'Architecture & Design',
    'BBA (Business Administration)',
    'Biology & Life Sciences',
    'Business Analytics',
    'Computer Science',
    'Data Science for Business',
    'Digital Business',
    'Economics',
    'Engineering',
    'Entrepreneurship & Innovation',
    'Finance',
    'International Business',
    'Law',
    'Management & Leadership',
    'Marketing & Communication',
    'Mathematics & Statistics',
    'Medicine & Health Sciences',
    'Political Science & International Relations',
    'Psychology',
    'Quantitative Finance',
    'Real Estate',
    'Shipping & Maritime Management',
    'Software Engineering',
    'Supply Chain & Logistics',
  ];
  const PREFER_NOT_TO_SAY = 'Prefer not to say';
  const LOCAL_SCHOOL_KEY = 'study-os-selected-school-v1';
  const LOCAL_MAJOR_KEY = 'study-os-selected-major-v1';

  const isPublicBadgeVal = (val) => {
    const s = String(val || '').trim();
    return Boolean(s && s.toLowerCase() !== PREFER_NOT_TO_SAY.toLowerCase());
  };

  function bindTypeaheadSelect(sel) {
    if (!sel || sel.dataset.typeaheadBound === '1') return;
    sel.dataset.typeaheadBound = '1';
    let buffer = '';
    let lastChar = '';
    let lastTime = 0;
    let cyclingChar = '';

    sel.addEventListener('keydown', (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (!ev.key || ev.key.length !== 1 || /\s/.test(ev.key)) {
        if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === 'Tab') {
          buffer = '';
          cyclingChar = '';
        }
        return;
      }
      const ch = ev.key.toLowerCase();
      const now = Date.now();
      const withinWindow = (now - lastTime) < 950;
      const allOpts = [...sel.options].filter((o) => !o.disabled && o.value !== '');
      if (!allOpts.length) return;

      const labelOf = (opt) => String(opt.textContent || '').trim().toLowerCase();
      const pickOption = (opt) => {
        if (!opt) return;
        const idx = opt.index;
        if (sel.selectedIndex !== idx) {
          sel.selectedIndex = idx;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };

      // Repeated same-letter press cycles down matching options (e.g. D -> Data Science -> Digital Business)
      if (withinWindow && ch === lastChar && (buffer.length === 1 || cyclingChar === ch)) {
        ev.preventDefault();
        cyclingChar = ch;
        buffer = ch;
        lastTime = now;
        const matches = allOpts.filter((o) => labelOf(o).startsWith(ch));
        if (matches.length) {
          const curPos = matches.findIndex((o) => o.index === sel.selectedIndex);
          pickOption(matches[(curPos + 1) % matches.length]);
        }
        return;
      }

      ev.preventDefault();
      if (withinWindow && !cyclingChar) {
        buffer += ch;
      } else {
        buffer = ch;
        cyclingChar = '';
      }
      lastChar = ch;
      lastTime = now;

      // Try multi-character prefix first (e.g. "di" -> Digital Business, "uio" -> UiO)
      let hit = allOpts.find((o) => labelOf(o).startsWith(buffer));
      if (!hit && buffer.length > 1) {
        buffer = ch;
        const singleMatches = allOpts.filter((o) => labelOf(o).startsWith(ch));
        if (singleMatches.length) {
          const curPos = singleMatches.findIndex((o) => o.index === sel.selectedIndex);
          hit = curPos >= 0 ? singleMatches[(curPos + 1) % singleMatches.length] : singleMatches[0];
        }
      } else if (hit && buffer.length === 1) {
        // Fresh single-letter press: if currently on an option starting with ch, jump to the NEXT one
        const singleMatches = allOpts.filter((o) => labelOf(o).startsWith(ch));
        if (singleMatches.length > 1) {
          const curPos = singleMatches.findIndex((o) => o.index === sel.selectedIndex);
          if (curPos >= 0) hit = singleMatches[(curPos + 1) % singleMatches.length];
        }
      }
      if (hit) pickOption(hit);
    });
  }

  function normalizeCanvasUrl(raw) {
    const val = String(raw || '').trim();
    if (!val) return '';
    const candidate = /^https?:\/\//i.test(val) ? val : `https://${val}`;
    try {
      const u = new URL(candidate);
      if (u.protocol !== 'https:') return '';
      return `https://${u.hostname.toLowerCase()}`;
    } catch {
      return '';
    }
  }

  function schoolConfigFor(name = '', origin = '') {
    const normName = String(name || '').trim().toLowerCase();
    const normOrigin = normalizeCanvasUrl(origin);
    if (normName) {
      const byName = SCHOOL_CATALOG.find((s) => s.name.toLowerCase() === normName || s.short.toLowerCase() === normName);
      if (byName) return { ...byName, canvasOrigin: normOrigin || byName.canvasOrigin };
    }
    if (normOrigin) {
      const host = new URL(normOrigin).hostname;
      const byOrigin = SCHOOL_CATALOG.find((s) => {
        try { return new URL(s.canvasOrigin).hostname === host; } catch { return false; }
      });
      if (byOrigin) return { ...byOrigin, name: String(name || '').trim() || byOrigin.name };
    }
    const cleanName = String(name || '').trim().slice(0, 48);
    if (cleanName || normOrigin) {
      const shortLabel = cleanName ? (cleanName.length <= 14 ? cleanName : cleanName.slice(0, 14)) : 'Canvas';
      return {
        name: cleanName || 'Custom Canvas',
        short: shortLabel,
        canvasOrigin: normOrigin,
        timetableUrl: 'https://cloud.timeedit.net/',
        timetableLabel: 'TimeEdit / TP',
        isCustom: true,
      };
    }
    return {
      name: '',
      short: '',
      canvasOrigin: '',
      timetableUrl: 'https://cloud.timeedit.net/',
      timetableLabel: 'TimeEdit / TP',
    };
  }

  function readLocalSchool() {
    try {
      const raw = JSON.parse(localStorage.getItem(LOCAL_SCHOOL_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        return { school: String(raw.school || '').trim(), canvasOrigin: String(raw.canvasOrigin || '').trim() };
      }
    } catch {}
    return { school: '', canvasOrigin: '' };
  }

  function saveLocalSchool(school = '', canvasOrigin = '') {
    try {
      const cleanSchool = String(school || '').trim().slice(0, 48);
      const cleanOrigin = normalizeCanvasUrl(canvasOrigin);
      if (!cleanSchool && !cleanOrigin) localStorage.removeItem(LOCAL_SCHOOL_KEY);
      else localStorage.setItem(LOCAL_SCHOOL_KEY, JSON.stringify({ school: cleanSchool, canvasOrigin: cleanOrigin }));
    } catch {}
  }

  function readLocalMajor() {
    try {
      return String(localStorage.getItem(LOCAL_MAJOR_KEY) || '').trim().slice(0, 64);
    } catch {
      return '';
    }
  }

  function saveLocalMajor(major = '') {
    try {
      const clean = String(major || '').trim().slice(0, 64);
      if (!clean) localStorage.removeItem(LOCAL_MAJOR_KEY);
      else localStorage.setItem(LOCAL_MAJOR_KEY, clean);
    } catch {}
  }

  function schoolFieldHtml(selectedSchool = '', selectedOrigin = '') {
    const cleanSchool = String(selectedSchool || '').trim();
    const cleanOrigin = normalizeCanvasUrl(selectedOrigin);
    const isPrivate = cleanSchool.toLowerCase() === PREFER_NOT_TO_SAY.toLowerCase();
    const preset = isPrivate ? null : SCHOOL_CATALOG.find((s) => s.name.toLowerCase() === cleanSchool.toLowerCase());
    const isCustom = Boolean(!isPrivate && !preset && (cleanSchool || cleanOrigin));
    const selectValue = isPrivate ? '__private__' : preset ? preset.name : isCustom ? '__custom__' : '';
    return `
      <div class="school-picker-wrap" data-school-picker>
        <label class="field-label">University / school <small class="muted">(type letters to jump/cycle)</small>
          <select name="schoolPreset" data-school-select>
            <option value="" ${!selectValue ? 'selected' : ''}>Select your university / school (optional)</option>
            ${SCHOOL_CATALOG.map((s) => `<option value="${esc(s.name)}" ${selectValue === s.name ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            <option value="__custom__" ${selectValue === '__custom__' ? 'selected' : ''}>Not listed here (enter custom…)</option>
            <option value="__private__" ${selectValue === '__private__' ? 'selected' : ''}>Prefer not to say</option>
          </select>
        </label>
        <div class="school-picker-custom" data-school-custom ${isCustom ? '' : 'hidden'}>
          <label class="field-label">School / university name
            <input name="customSchool" type="text" maxlength="48" value="${esc(isCustom ? cleanSchool : '')}" placeholder="e.g. CBS, Stockholm University, MIT" ${isCustom ? '' : 'disabled'}>
          </label>
          <label class="field-label">Canvas URL <small class="muted">(optional)</small>
            <input name="customCanvasOrigin" type="text" maxlength="120" value="${esc(isCustom ? cleanOrigin : '')}" placeholder="https://yourschool.instructure.com" autocomplete="off" autocapitalize="off" spellcheck="false" ${isCustom ? '' : 'disabled'}>
          </label>
        </div>
      </div>`;
  }

  function majorFieldHtml(selectedMajor = '') {
    const cleanMajor = String(selectedMajor || '').trim();
    const isPrivate = cleanMajor.toLowerCase() === PREFER_NOT_TO_SAY.toLowerCase();
    const preset = isPrivate ? null : MAJOR_CATALOG.find((m) => m.toLowerCase() === cleanMajor.toLowerCase());
    const isCustom = Boolean(!isPrivate && !preset && cleanMajor);
    const selectValue = isPrivate ? '__private__' : preset ? preset : isCustom ? '__custom__' : '';
    return `
      <div class="school-picker-wrap" data-major-picker>
        <label class="field-label">Major / study program <small class="muted">(optional · press a letter repeatedly to cycle)</small>
          <select name="majorPreset" data-major-select>
            <option value="" ${!selectValue ? 'selected' : ''}>Select your major (optional)</option>
            ${MAJOR_CATALOG.map((m) => `<option value="${esc(m)}" ${selectValue === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
            <option value="__custom__" ${selectValue === '__custom__' ? 'selected' : ''}>Not listed here (enter custom…)</option>
            <option value="__private__" ${selectValue === '__private__' ? 'selected' : ''}>Prefer not to say</option>
          </select>
        </label>
        <div class="school-picker-custom" data-major-custom ${isCustom ? '' : 'hidden'}>
          <label class="field-label">Custom major / program
            <input name="customMajor" type="text" maxlength="64" value="${esc(isCustom ? cleanMajor : '')}" placeholder="e.g. Industrial Economics, Cognitive Science" ${isCustom ? '' : 'disabled'}>
          </label>
        </div>
      </div>`;
  }

  function bindSchoolPickers(root) {
    if (!root) return;
    root.querySelectorAll('[data-school-picker]').forEach((wrap) => {
      const sel = wrap.querySelector('[data-school-select]');
      const customBox = wrap.querySelector('[data-school-custom]');
      if (!sel || !customBox) return;
      bindTypeaheadSelect(sel);
      const sync = () => {
        const isCustom = sel.value === '__custom__';
        customBox.hidden = !isCustom;
        customBox.querySelectorAll('input').forEach((inp) => { inp.disabled = !isCustom; });
      };
      sel.addEventListener('change', sync);
      sync();
    });
    root.querySelectorAll('[data-major-picker]').forEach((wrap) => {
      const sel = wrap.querySelector('[data-major-select]');
      const customBox = wrap.querySelector('[data-major-custom]');
      if (!sel || !customBox) return;
      bindTypeaheadSelect(sel);
      const sync = () => {
        const isCustom = sel.value === '__custom__';
        customBox.hidden = !isCustom;
        customBox.querySelectorAll('input').forEach((inp) => { inp.disabled = !isCustom; });
      };
      sel.addEventListener('change', sync);
      sync();
    });
    root.querySelectorAll('select[name="secondaryLanguage"]').forEach(bindTypeaheadSelect);
  }

  function extractSchoolFields(formData) {
    const presetVal = String(formData.get('schoolPreset') || '').trim();
    if (!presetVal) return { school: '', canvasOrigin: '' };
    if (presetVal === '__private__') return { school: PREFER_NOT_TO_SAY, canvasOrigin: '' };
    if (presetVal === '__custom__') {
      const school = String(formData.get('customSchool') || '').trim().slice(0, 48);
      const canvasOrigin = normalizeCanvasUrl(formData.get('customCanvasOrigin') || '');
      return { school, canvasOrigin };
    }
    const found = SCHOOL_CATALOG.find((s) => s.name === presetVal);
    return found ? { school: found.name, canvasOrigin: found.canvasOrigin } : { school: presetVal.slice(0, 48), canvasOrigin: '' };
  }

  function extractMajorField(formData) {
    const presetVal = String(formData.get('majorPreset') || '').trim();
    if (!presetVal) return '';
    if (presetVal === '__private__') return PREFER_NOT_TO_SAY;
    if (presetVal === '__custom__') return String(formData.get('customMajor') || '').trim().slice(0, 64);
    return presetVal.slice(0, 64);
  }

  const SECONDARY_LANGUAGES = [
    { code: '', label: 'None (English only)' },
    { code: 'nb', label: 'Norwegian (Bokmål)' },
    { code: 'nn', label: 'Norwegian (Nynorsk)' },
    { code: 'sv', label: 'Swedish' },
    { code: 'da', label: 'Danish' },
    { code: 'ar', label: 'Arabic (العربية)' },
    { code: 'ur', label: 'Urdu (اردو)' },
    { code: 'pl', label: 'Polish (Polski)' },
    { code: 'de', label: 'German (Deutsch)' },
    { code: 'fr', label: 'French (Français)' },
    { code: 'es', label: 'Spanish (Español)' },
    { code: 'zh', label: 'Chinese (中文)' },
    { code: 'hi', label: 'Hindi (हिन्दी)' },
    { code: 'uk', label: 'Ukrainian (Українська)' },
    { code: 'lt', label: 'Lithuanian (Lietuvių)' },
    { code: 'so', label: 'Somali (Soomaali)' },
    { code: 'vi', label: 'Vietnamese (Tiếng Việt)' },
    { code: 'pt', label: 'Portuguese (Português)' },
    { code: 'it', label: 'Italian (Italiano)' },
    { code: 'ru', label: 'Russian (Русский)' },
    { code: 'tr', label: 'Turkish (Türkçe)' },
    { code: 'fa', label: 'Persian (فارسی)' },
    { code: 'ko', label: 'Korean (한국어)' },
    { code: 'ja', label: 'Japanese (日本語)' },
  ];

  function secondaryLanguageFieldHtml(selected = '') {
    return `
      <label class="field-label">Secondary language <small class="muted">(optional · coming soon: translated materials)</small>
        <select name="secondaryLanguage">
          ${SECONDARY_LANGUAGES.map((l) => `<option value="${esc(l.code)}" ${selected === l.code ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}
        </select>
      </label>`;
  }

  function signupConsentHtml({ showEmailField = false } = {}) {
    return `
      <label class="check-row" style="font-size:12.5px;align-items:flex-start">
        <input name="tosAccepted" type="checkbox" required style="margin-top:2px">
        <span>I agree to the <a href="./terms.html" target="_blank" rel="noopener">Terms</a> and <a href="./privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span>
      </label>
      <label class="check-row" style="font-size:12.5px;align-items:flex-start">
        <input name="newsletterOptIn" type="checkbox" style="margin-top:2px">
        <span>
          <strong>Monthly Study-OS digest &amp; updates</strong> <small class="muted">(optional)</small><br>
          <small class="muted">1–2 emails/month: newly added past exams &amp; courses, plus an upcoming end-of-month profile recap with tailored Al study tips. Unsubscribe anytime.</small>
        </span>
      </label>
      ${showEmailField ? `
        <label class="field-label" data-newsletter-email hidden>Email for monthly digest
          <input name="contactEmail" type="email" placeholder="you@example.com" autocomplete="email" disabled>
        </label>
      ` : ''}`;
  }

  function loadGoogleGsi() {
    if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
    if (!gsiLoadPromise) {
      gsiLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client?hl=en';
        script.async = true;
        script.defer = true;
        script.onload = () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error('Google Sign-In unavailable.')));
        script.onerror = () => reject(new Error('Could not load Google Sign-In.'));
        document.head.appendChild(script);
      });
    }
    return gsiLoadPromise;
  }

  async function mountGoogleButton(container, onCredential, { text = 'continue_with', width = 380 } = {}) {
    if (!container) return false;
    const { googleClientId } = await getAuthConfig();
    if (!googleClientId) {
      container.hidden = true;
      return false;
    }
    try {
      const gsi = await loadGoogleGsi();
      const dark = document.documentElement.dataset.theme === 'dark';
      container.hidden = false;
      container.innerHTML = '';
      gsiActiveCallback = onCredential;
      if (gsiInitializedClient !== googleClientId) {
        gsi.initialize({
          client_id: googleClientId,
          callback: (response) => {
            if (response?.credential && gsiActiveCallback) gsiActiveCallback(response.credential);
          },
          ux_mode: 'popup',
        });
        gsiInitializedClient = googleClientId;
      }
      const rectW = Math.floor(container.getBoundingClientRect().width || container.clientWidth || 0);
      const viewportCap = Math.max(220, Math.floor(window.innerWidth - 88));
      const targetWidth = Math.max(220, Math.min(width, rectW > 40 ? rectW - 4 : viewportCap, viewportCap));
      gsi.renderButton(container, {
        type: 'standard',
        theme: dark ? 'filled_black' : 'outline',
        size: 'large',
        shape: 'pill',
        text,
        locale: 'en',
        width: targetWidth,
      });
      return true;
    } catch {
      container.hidden = true;
      return false;
    }
  }

  function supportsPasskeys() {
    return Boolean(window.PublicKeyCredential && navigator.credentials?.create && navigator.credentials?.get && window.isSecureContext);
  }

  async function signInWithPasskey() {
    if (!supportsPasskeys()) throw new Error('Passkeys require a modern browser over HTTPS.');
    const opts = await request('/auth/passkey/login/options', {}, '');
    const publicKey = {
      challenge: fromBase64Url(opts.challenge),
      rpId: opts.rpId,
      timeout: opts.timeout || 60000,
      userVerification: opts.userVerification || 'preferred',
    };
    const assertion = await navigator.credentials.get({ publicKey });
    if (!assertion) throw new Error('Passkey sign-in was cancelled.');
    const res = await request('/auth/passkey/login/verify', {
      credentialId: assertion.id,
      clientDataJSON: toBase64Url(assertion.response.clientDataJSON),
      authenticatorData: toBase64Url(assertion.response.authenticatorData),
      signature: toBase64Url(assertion.response.signature),
      label: detectDeviceLabel(),
    }, '');
    useProfile(res.token);
    const prof = await request('/profile').catch(() => null);
    if (prof) currentProfile = prof;
    return res;
  }

  async function registerPasskey() {
    if (!supportsPasskeys()) throw new Error('Passkeys require a modern browser over HTTPS.');
    const opts = await request('/auth/passkey/register/options', {});
    const publicKey = {
      ...opts,
      challenge: fromBase64Url(opts.challenge),
      user: { ...opts.user, id: fromBase64Url(opts.user.id) },
      excludeCredentials: (opts.excludeCredentials || []).map((c) => ({
        ...c,
        id: fromBase64Url(c.id),
      })),
    };
    const cred = await navigator.credentials.create({ publicKey });
    if (!cred) throw new Error('Passkey setup was cancelled.');
    const spki = cred.response.getPublicKey?.();
    const authData = cred.response.getAuthenticatorData?.();
    const alg = cred.response.getPublicKeyAlgorithm?.() ?? -7;
    if (!spki || !authData) {
      throw new Error('This browser does not support passkey key export. Use a 6-character device code instead.');
    }
    return request('/auth/passkey/register/verify', {
      credentialId: cred.id,
      publicKeySpki: toBase64Url(spki),
      algorithm: alg,
      clientDataJSON: toBase64Url(cred.response.clientDataJSON),
      authenticatorData: toBase64Url(authData),
      label: detectDeviceLabel(),
    });
  }

  async function signOut() {
    if (api && token) {
      await request('/auth/logout', {}).catch(() => {});
    }
    useProfile('');
    window.StudyRooms?.reset?.();
    try { sessionStorage.setItem(demoKey, '1'); } catch {}
    window.StudyApp?.syncSettingsRows?.();
  }

  async function fetchCloudBackup() {
    if (!api || !token) return { hasBackup: false };
    return request('/sync');
  }

  async function pushCloudBackup(payload) {
    if (!api || !token) return { ok: false };
    return request('/sync', payload);
  }

  async function fetchTimeEdit(url) {
    if (!token) throw new Error('Sign in to load the TimeEdit link, or upload your .ics file.');
    const result = await request('/schedule/timeedit', { url });
    return result.calendar;
  }

  async function fetchExtensionTimeEdit() {
    if (!api || !token) return { hasFeed: false };
    return request('/schedule/timeedit-feed');
  }

  async function approvedCourses() {
    return api ? (await request('/courses', null, '')).courses : [];
  }

  function proposeCourses(courses) {
    return request('/courses/propose', { courses });
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
    if (!api || !token || window.StudyUI?.devMode?.isActive?.()) return;
    const key = token;
    const stats = window.StudyApp.communityStats();
    const snapshot = JSON.stringify(stats);
    if (snapshot === lastSync) return;
    await request('/stats', stats, key);
    if (token === key) lastSync = snapshot;
  }

  function queueStatsSync() {
    if (!api || !token || window.StudyUI?.devMode?.isActive?.()) return;
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
    if (!api || !token || window.StudyUI?.devMode?.isActive?.()) return Promise.resolve();
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
    if (!api) return;
    if (token) {
      const state = timerStatus();
      if (state.mode !== 'idle' || (lastPresence && lastPresence !== 'idle')) syncPresence(state).catch(() => {});
    }
    const root = document.getElementById('community-root');
    if (document.getElementById('view-community').hidden) return;
    const available = canUse();
    if (!available && root.querySelector('#community-social, #community-demo-view')) {
      renderLocked(root, currentProfile);
    } else if (available && root.querySelector('#community-locked') && !openingBreak) {
      openingBreak = true;
      render().finally(() => { openingBreak = false; });
    } else if (available && token && Date.now() - lastChatAt >= 30_000) {
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
        await handler(new FormData(form), form);
      } catch (error) {
        status.textContent = error.message || 'Could not complete that action.';
      } finally {
        submit.disabled = false;
      }
    });
  }

  const privacyNote = `
    <details class="auth-privacy-note">
      <summary>Community privacy &amp; rules</summary>
      <p>Study-OS Community is run independently by the Study-OS project (not affiliated with any university). Use a nickname and keep private info, restricted course files, and active assessment material out of messages.</p>
      <p>Cloudflare (EU) stores your display name, optional university/school, avatar &amp; bio, study and break totals, synced progress, custom study sets and schedule, passkey public keys, recovery key hash, room results, duel rating, chat posts, direct messages, shared study sets, and block list.</p>
      <p>Delete your profile anytime to erase your account, passkeys, synced backup, and message history from the active database. Cloudflare may retain rolling backups briefly.</p>
    </details>`;

  function renderEntry(root, error = '', onSignedIn = render, onDemo, prefillCode = '') {
    const passkeyReady = supportsPasskeys();
    const localSchool = readLocalSchool();
    const localMajor = readLocalMajor();
    const cleanPrefill = String(prefillCode || '').trim().slice(0, 120);
    root.innerHTML = `
      <div class="auth-card">
        <div class="auth-head">
          <div class="auth-emblem" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
            </svg>
          </div>
          <div>
            <h1 class="auth-title">Unlock full Study-OS</h1>
            <p class="muted auth-sub">Free student account — save progress across devices, unlock AI tutor &amp; study sets, and open BI course PDFs.</p>
            <p class="mobile-auth-tip muted">On a computer, you can also sync Canvas &amp; TimeEdit in 1 click.</p>
          </div>
        </div>

        ${cleanPrefill ? `<div class="auth-pass-ready-pill" role="status">✓ Access pass link detected — sign in below to unlock full version &amp; jump straight to your course!</div>` : ''}

        <div id="community-top-code-wrap" class="auth-access-code-box" ${cleanPrefill ? '' : 'hidden'}>
          <label class="field-label" style="margin:0">
            Access code <small class="muted" id="community-top-code-hint">(required for new accounts &amp; instant course PDF access)</small>
            <input id="community-top-code" type="text" value="${esc(cleanPrefill)}" autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="e.g. BI2026" maxlength="120">
          </label>
        </div>

        <div id="community-google-slot" class="auth-google-slot" hidden></div>

        ${passkeyReady ? `
          <button type="button" class="primary-btn auth-passkey-btn" id="community-passkey-login">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="8" cy="15" r="4"></circle>
              <path d="M10.85 12.15L19 4"></path>
              <path d="M18 5l2 2"></path>
              <path d="M15 8l2 2"></path>
            </svg>
            <span>Sign in with Passkey</span>
          </button>
          <button type="button" class="ghost-btn auth-passkey-create-btn" id="community-passkey-create">New profile + Passkey</button>
        ` : ''}
        <div class="auth-or" id="community-auth-or" ${passkeyReady ? '' : 'hidden'}><span>or</span></div>

        <div id="community-google-complete-wrap" hidden>
          <p class="muted" style="margin:0 0 8px;font-size:13px" id="community-google-complete-note"></p>
          <form id="community-google-complete-form" class="auth-form">
            <input type="hidden" name="ticket">
            <label class="field-label">Nickname <input name="nickname" type="text" minlength="2" maxlength="24" required></label>
            ${schoolFieldHtml(localSchool.school, localSchool.canvasOrigin)}
            ${majorFieldHtml(localMajor)}
            <label class="field-label" data-join-invite="google" hidden>Access code <input name="invite" type="text" disabled autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="e.g. BI2026"></label>
            ${secondaryLanguageFieldHtml('')}
            ${signupConsentHtml({ showEmailField: false })}
            <div class="row-actions">
              <button type="submit" class="primary-btn" style="flex:1">Finish &amp; Sign In</button>
              <button type="button" class="ghost-btn" id="community-google-back">Back</button>
            </div>
          </form>
        </div>

        <div id="community-classic-wrap">
          <div class="ios-segmented auth-tabs" role="tablist" aria-label="Sign in method">
            <button type="button" role="tab" class="active" data-auth-tab="join" aria-selected="true">Create profile</button>
            <button type="button" role="tab" data-auth-tab="code" aria-selected="false">Device code</button>
            <button type="button" role="tab" data-auth-tab="key" aria-selected="false">Use a key</button>
          </div>

          <form id="community-join" class="auth-form" data-auth-pane="join">
            <label class="field-label">Nickname <input name="nickname" type="text" minlength="2" maxlength="24" placeholder="e.g. Alex" required></label>
            ${schoolFieldHtml(localSchool.school, localSchool.canvasOrigin)}
            ${majorFieldHtml(localMajor)}
            <label class="field-label" data-join-invite hidden>Access code <input name="invite" type="text" disabled autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="e.g. BI2026"></label>
            ${secondaryLanguageFieldHtml('')}
            ${passkeyReady ? '<label class="check-row"><input name="withPasskey" type="checkbox" checked> Set up a passkey after signup</label>' : ''}
            ${signupConsentHtml({ showEmailField: true })}
            <button type="submit" class="primary-btn" aria-describedby="community-stats-notice">Create profile</button>
            <small class="muted" id="community-stats-notice">Your nickname, school, study hours, breaks, and practice totals appear on the members leaderboard.</small>
          </form>

          <form id="community-link-redeem" class="auth-form" data-auth-pane="code" hidden>
            <label class="field-label">6-character device code
              <input name="code" type="text" maxlength="7" autocomplete="off" spellcheck="false" placeholder="K7M-9P2" style="text-transform:uppercase;letter-spacing:0.12em;font-family:ui-monospace,monospace;font-weight:700" required>
            </label>
            <button type="submit" class="primary-btn">Link this device</button>
            <small class="muted">On a signed-in device, open <b>Settings → Passkeys &amp; Linked Devices</b> to generate a 5-minute code.</small>
          </form>

          <form id="community-sign-in" class="auth-form" data-auth-pane="key" hidden>
            <label class="field-label">Recovery or profile key <input name="key" type="password" required autocomplete="off" autocapitalize="off" spellcheck="false"></label>
            <button type="submit" class="primary-btn">Sign in with key</button>
          </form>
        </div>

        <p id="community-status" class="auth-status" role="status">${esc(error)}</p>

        ${onDemo ? `
          <div class="auth-demo-bar">
            <button type="button" class="ghost-btn" id="community-demo">Continue with limited preview (no sync or PDFs)</button>
          </div>
        ` : ''}
        ${privacyNote}
      </div>`;

    const status = root.querySelector('#community-status');
    bindSchoolPickers(root);
    if (onDemo) root.querySelector('#community-demo').onclick = onDemo;

    const googleSlot = root.querySelector('#community-google-slot');
    const googleCompleteWrap = root.querySelector('#community-google-complete-wrap');
    const classicWrap = root.querySelector('#community-classic-wrap');
    const authOr = root.querySelector('#community-auth-or');
    const topCodeWrap = root.querySelector('#community-top-code-wrap');
    const topCodeInput = root.querySelector('#community-top-code');
    const topCodeHint = root.querySelector('#community-top-code-hint');

    const syncCodeInputs = (val) => {
      root.querySelectorAll('input[name="invite"]').forEach((inp) => {
        if (inp.value !== val) inp.value = val;
      });
    };
    if (cleanPrefill) syncCodeInputs(cleanPrefill);
    topCodeInput?.addEventListener('input', () => syncCodeInputs(topCodeInput.value));
    root.querySelectorAll('input[name="invite"]').forEach((inp) => {
      inp.addEventListener('input', () => {
        if (topCodeInput && topCodeInput.value !== inp.value) topCodeInput.value = inp.value;
      });
    });

    getAuthConfig().then(({ openSignup, googleOpenSignup, requireCodeOnLogin, archivePassEnabled }) => {
      const showTopCode = Boolean(requireCodeOnLogin || !openSignup || archivePassEnabled);
      if (topCodeWrap) topCodeWrap.hidden = !showTopCode;
      if (topCodeHint) {
        topCodeHint.textContent = requireCodeOnLogin
          ? '(enter your short class code to sign up & unlock PDFs)'
          : archivePassEnabled
          ? '(optional with Google — enter a class code to skip Canvas Sync)'
          : '(required for Create profile)';
      }
      root.querySelectorAll('[data-join-invite]').forEach(label => {
        const isGoogleField = label.dataset.joinInvite === 'google';
        const open = Boolean(openSignup || (isGoogleField && googleOpenSignup && !requireCodeOnLogin));
        label.hidden = open;
        label.firstElementChild.disabled = open;
        label.firstElementChild.required = !open;
      });
    });

    async function signupAccess(form, element, google = false) {
      const { openSignup, googleOpenSignup, requireCodeOnLogin } = await getAuthConfig();
      const rawInvite = String(form.get('invite') || topCodeInput?.value || '').trim();
      if (/^sos1_/i.test(rawInvite)) {
        throw new Error('That is a 48-char sos1_… archive key — use your short class code here (or paste sos1_… in Settings → Private PDF Archive).');
      }
      const optionalHashes = rawInvite ? await hashAccessCode(rawInvite) : null;
      if (openSignup) {
        return { humanToken: await humanToken(element, 'signup', status), ...(optionalHashes || {}) };
      }
      if (google && googleOpenSignup && !requireCodeOnLogin) {
        return optionalHashes || {};
      }
      if (!optionalHashes) throw new Error('Enter your access code (e.g. BI2026).');
      return optionalHashes;
    }

    mountGoogleButton(googleSlot, async (idToken) => {
      status.textContent = 'Signing in with Google…';
      try {
        const res = await request('/auth/google', { idToken, label: detectDeviceLabel() }, '');
        if (res.needsJoin && res.ticket) {
          status.textContent = '';
          const form = root.querySelector('#community-google-complete-form');
          form.elements.ticket.value = res.ticket;
          form.elements.nickname.value = res.suggestedName || '';
          if (form.elements.invite && topCodeInput?.value) {
            form.elements.invite.value = topCodeInput.value.trim();
          }
          root.querySelector('#community-google-complete-note').textContent = 'Pick a nickname & school to finish setting up your Google sign-in.';
          googleCompleteWrap.hidden = false;
          classicWrap.hidden = true;
          googleSlot.hidden = true;
          if (topCodeWrap) topCodeWrap.hidden = true;
          const pkBtn = root.querySelector('#community-passkey-login');
          if (pkBtn) pkBtn.hidden = true;
          const createBtn = root.querySelector('#community-passkey-create');
          if (createBtn) createBtn.hidden = true;
          if (authOr) authOr.hidden = true;
          form.elements.nickname.focus();
          return;
        }
        useProfile(res.token);
        const typedCode = (topCodeInput?.value || '').trim();
        if (typedCode && !/^sos1_/i.test(typedCode)) {
          await redeemAccessCode(typedCode).catch(() => {});
        }
        currentProfile = await request('/profile').catch(() => null);
        await syncTransientArchiveFromProfile(currentProfile);
        toast(`Welcome back, ${res.nickname}!`);
        await onSignedIn();
      } catch (err) {
        status.textContent = err.message || 'Google sign-in failed.';
      }
    }).then((shown) => {
      if (shown && authOr) authOr.hidden = false;
    });

    root.querySelector('#community-google-back')?.addEventListener('click', () => {
      googleCompleteWrap.hidden = true;
      classicWrap.hidden = false;
      googleSlot.hidden = false;
      if (topCodeWrap) topCodeWrap.hidden = false;
      const pkBtn = root.querySelector('#community-passkey-login');
      if (pkBtn) pkBtn.hidden = false;
      const createBtn = root.querySelector('#community-passkey-create');
      if (createBtn) createBtn.hidden = false;
      if (authOr) authOr.hidden = false;
      status.textContent = '';
    });

    action(root.querySelector('#community-google-complete-form'), async (form, element) => {
      const { school, canvasOrigin } = extractSchoolFields(form);
      const major = extractMajorField(form);
      const res = await request('/auth/google/complete', {
        ticket: form.get('ticket'),
        nickname: form.get('nickname'),
        school,
        major,
        canvasOrigin,
        secondaryLanguage: String(form.get('secondaryLanguage') || ''),
        tosAccepted: form.get('tosAccepted') === 'on',
        newsletterOptIn: form.get('newsletterOptIn') === 'on',
        ...await signupAccess(form, element, true),
        label: detectDeviceLabel(),
      }, '');
      if (school || canvasOrigin) saveLocalSchool(school, canvasOrigin);
      if (major) saveLocalMajor(major);
      useProfile(res.token);
      currentProfile = await request('/profile').catch(() => null);
      const unlocked = await syncTransientArchiveFromProfile(currentProfile);
      toast(unlocked ? `Welcome, ${res.nickname}! Course PDFs unlocked.` : `Welcome, ${res.nickname}! Google Sign-In is now linked.`);
      await onSignedIn();
    }, status);

    const joinNewsletterCb = root.querySelector('#community-join input[name="newsletterOptIn"]');
    const joinEmailWrap = root.querySelector('#community-join [data-newsletter-email]');
    joinNewsletterCb?.addEventListener('change', () => {
      if (!joinEmailWrap) return;
      const on = joinNewsletterCb.checked;
      joinEmailWrap.hidden = !on;
      const inp = joinEmailWrap.querySelector('input');
      if (inp) {
        inp.disabled = !on;
        inp.required = on;
      }
    });

    root.querySelectorAll('[data-auth-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.dataset.authTab;
        root.querySelectorAll('[data-auth-tab]').forEach((t) => {
          const active = t.dataset.authTab === mode;
          t.classList.toggle('active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        root.querySelectorAll('[data-auth-pane]').forEach((pane) => {
          pane.hidden = pane.dataset.authPane !== mode;
        });
        status.textContent = '';
      });
    });

    const passkeyBtn = root.querySelector('#community-passkey-login');
    root.querySelector('#community-passkey-create')?.addEventListener('click', () => {
      root.querySelector('[data-auth-tab="join"]').click();
      root.querySelector('#community-join input[name="nickname"]').focus();
    });
    if (passkeyBtn) {
      passkeyBtn.onclick = async () => {
        passkeyBtn.disabled = true;
        status.textContent = 'Waiting for Face ID / Touch ID…';
        try {
          const res = await signInWithPasskey();
          toast(`Welcome back, ${res.nickname}!`);
          await onSignedIn();
        } catch (err) {
          status.textContent = err?.name === 'NotAllowedError'
            ? 'Passkey sign-in was cancelled.'
            : err?.message || 'Could not sign in with Passkey.';
        } finally {
          passkeyBtn.disabled = false;
        }
      };
    }

    action(root.querySelector('#community-join'), async (form, element) => {
      const { school, canvasOrigin } = extractSchoolFields(form);
      const major = extractMajorField(form);
      const result = await request('/join', {
        nickname: form.get('nickname'),
        school,
        major,
        canvasOrigin,
        secondaryLanguage: String(form.get('secondaryLanguage') || ''),
        tosAccepted: form.get('tosAccepted') === 'on',
        newsletterOptIn: form.get('newsletterOptIn') === 'on',
        contactEmail: String(form.get('contactEmail') || '').trim(),
        ...await signupAccess(form, element),
      }, '');
      if (school || canvasOrigin) saveLocalSchool(school, canvasOrigin);
      if (major) saveLocalMajor(major);
      useProfile(result.token);
      currentProfile = await request('/profile').catch(() => null);
      const unlocked = await syncTransientArchiveFromProfile(currentProfile);
      toast(unlocked ? 'Profile created & course PDFs unlocked!' : 'Profile created. Save a recovery key in Settings → Sign-in & Devices.');
      await onSignedIn();
      if (form.get('withPasskey') === 'on') {
        await openSecuritySheet();
        window.requestAnimationFrame(() => document.getElementById('sec-add-passkey')?.focus());
      }
    }, status);

    action(root.querySelector('#community-link-redeem'), async (form, element) => {
      const res = await request('/auth/link-redeem', {
        code: form.get('code'),
        label: detectDeviceLabel(),
        humanToken: await humanToken(element, 'link', status),
      }, '');
      useProfile(res.token);
      currentProfile = await request('/profile').catch(() => null);
      toast(`Linked as ${res.nickname}!`);
      await onSignedIn();
    }, status);

    action(root.querySelector('#community-sign-in'), async (form, element) => {
      const key = form.get('key').trim();
      if (/^soc1_/.test(key)) {
        currentProfile = await request('/profile', null, key);
        useProfile(key);
      } else {
        const res = await request('/auth/recovery', {
          key, label: detectDeviceLabel(), humanToken: await humanToken(element, 'recovery', status),
        }, '');
        useProfile(res.token);
        currentProfile = await request('/profile').catch(() => null);
      }
      element.reset();
      await onSignedIn();
    }, status);
  }

  async function requireProfile({ allowDemo = false, forcePrompt = false, silent = false, prefillCode = '' } = {}) {
    if (!api) return true;
    if (token) {
      try {
        currentProfile = await request('/profile');
        await syncTransientArchiveFromProfile(currentProfile);
        window.StudyApp?.syncSettingsRows?.();
        return true;
      } catch (error) {
        if (error.status !== 401) return true;
        useProfile('');
      }
    }
    if (silent && !forcePrompt) {
      window.StudyApp?.syncSettingsRows?.();
      return false;
    }
    if (allowDemo && !forcePrompt && !prefillCode) {
      try { if (sessionStorage.getItem(demoKey)) return false; } catch {}
    }
    const gate = document.getElementById('profile-gate');
    return new Promise((resolve) => {
      const tryDemo = () => {
        try { sessionStorage.setItem(demoKey, '1'); } catch {}
        gate.close();
        window.StudyApp?.syncSettingsRows?.();
        resolve(false);
      };
      renderEntry(gate, '', () => {
        gate.close();
        try { sessionStorage.removeItem(demoKey); } catch {}
        queueStatsSync();
        window.StudyApp?.syncSettingsRows?.();
        window.StudyApp?.syncCloudProgress?.().catch(() => {});
        resolve(true);
      }, allowDemo ? tryDemo : undefined, prefillCode);
      gate.oncancel = (event) => {
        event.preventDefault();
        if (allowDemo) tryDemo();
      };
      if (!gate.open) {
        gate.showModal();
        gate.focus({ preventScroll: true });
      }
    });
  }

  async function openSecuritySheet() {
    const dialog = document.getElementById('account-security-dialog');
    if (!dialog || !api || !token) return;
    let activeCode = null;

    async function paint() {
      dialog.innerHTML = `
        <div class="row-between" style="margin:0 0 12px">
          <h2 id="security-sheet-title" style="margin:0">Sign-in &amp; Devices</h2>
          <button type="button" class="ios-done-btn" id="security-sheet-close">Done</button>
        </div>
        <p class="muted" style="margin:0 0 14px;font-size:13.5px">Sign in with Face ID / Touch ID across devices, or generate a 5-minute code to link another phone or computer.</p>
        <div class="row-actions" style="margin-bottom:12px">
          ${supportsPasskeys() ? '<button type="button" class="primary-btn" id="sec-add-passkey">+ Add Passkey</button>' : ''}
          <button type="button" class="ghost-btn" id="sec-gen-link-code">Generate 5-min device code</button>
        </div>
        <div id="sec-link-code-box" class="admin-created-code" hidden></div>
        <div id="sec-recovery" hidden>
          <button type="button" class="ghost-btn" id="sec-generate-recovery">Generate recovery key</button>
          <div id="sec-recovery-key" hidden class="admin-created-code">
            <p>Save this key in your password manager. A new key replaces your previous one.</p>
            <input type="text" id="sec-recovery-value" readonly aria-label="Recovery key">
            <button type="button" class="ghost-btn" id="sec-copy-recovery">Copy key</button>
          </div>
        </div>
        <p id="sec-status" role="status" class="muted" style="font-size:13px"></p>
        <div id="sec-lists"><p class="muted">Loading devices…</p></div>
      `;
      dialog.querySelector('#security-sheet-close').onclick = () => dialog.close();
      const statusEl = dialog.querySelector('#sec-status');
      const codeBox = dialog.querySelector('#sec-link-code-box');
      const listsEl = dialog.querySelector('#sec-lists');
      const recovery = dialog.querySelector('#sec-recovery');
      const recoveryBox = dialog.querySelector('#sec-recovery-key');
      const recoveryInput = dialog.querySelector('#sec-recovery-value');
      getAuthConfig().then(config => { recovery.hidden = !config.recoveryEnabled; });
      dialog.addEventListener('close', () => { recoveryInput.value = ''; recoveryBox.hidden = true; }, { once: true });
      dialog.querySelector('#sec-generate-recovery').onclick = async event => {
        const btn = event.currentTarget;
        btn.disabled = true;
        statusEl.textContent = '';
        try {
          const res = await request('/auth/recovery/create', {});
          recoveryInput.value = res.key;
          recoveryBox.hidden = false;
          recoveryInput.select();
        } catch (err) {
          statusEl.textContent = err.message || 'Could not generate a recovery key.';
        } finally {
          btn.disabled = false;
        }
      };
      dialog.querySelector('#sec-copy-recovery').onclick = async () => {
        try {
          await navigator.clipboard.writeText(recoveryInput.value);
          toast('Recovery key copied.');
        } catch {
          recoveryInput.select();
        }
      };

      const renderCodeBox = () => {
        if (!activeCode) { codeBox.hidden = true; return; }
        const mins = Math.max(1, Math.ceil((activeCode.expiresAt - Date.now()) / 60000));
        codeBox.hidden = false;
        codeBox.innerHTML = `
          <div>
            <small style="display:block">Enter this code on your other device (expires in ~${mins} min):</small>
            <code style="font-size:22px;font-weight:800;letter-spacing:0.14em">${esc(activeCode.code)}</code>
          </div>
          <button type="button" class="ghost-btn" id="sec-copy-link-code">Copy</button>
        `;
        codeBox.querySelector('#sec-copy-link-code').onclick = async () => {
          try {
            await navigator.clipboard.writeText(activeCode.code);
            toast('Copied device code!');
          } catch {}
        };
      };
      renderCodeBox();

      dialog.querySelector('#sec-add-passkey')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        statusEl.textContent = 'Follow your device prompt to save a passkey…';
        try {
          await registerPasskey();
          toast('Passkey added! You can now sign in with Face ID / Touch ID.');
          await paint();
        } catch (err) {
          statusEl.textContent = err?.name === 'NotAllowedError'
            ? 'Passkey setup was cancelled.'
            : err?.message || 'Could not register passkey.';
        } finally {
          btn.disabled = false;
        }
      });

      dialog.querySelector('#sec-gen-link-code').onclick = async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        statusEl.textContent = 'Generating code…';
        try {
          activeCode = await request('/auth/link-code', {});
          statusEl.textContent = '';
          renderCodeBox();
        } catch (err) {
          statusEl.textContent = err.message || 'Could not generate code.';
        } finally {
          btn.disabled = false;
        }
      };

      try {
        const { passkeys, sessions, googleEnabled, google } = await request('/auth/devices');
        const fmt = (ms) => ms ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Never';
        const googleSectionHtml = googleEnabled ? `
          <div class="sec-section">
            <h3 class="ios-group-title" style="margin-left:2px">Google Sign-In</h3>
            <div class="ios-group">
              ${google?.linked ? `
                <div class="ios-row">
                  <span class="ios-row-copy">
                    <span class="ios-row-label">Google account <span class="badge live">Connected</span></span>
                    <small class="ios-row-sub">${esc(google.emailHint || 'Linked')} · Added ${fmt(google.createdAt)}</small>
                  </span>
                  <button type="button" class="ghost-btn" style="padding:4px 10px;font-size:12px" id="sec-unlink-google">Disconnect</button>
                </div>
              ` : `
                <div class="ios-row" style="flex-direction:column;align-items:stretch;gap:8px;padding:12px 14px">
                  <small class="muted">Connect Google so you can sign in with 1 click on any phone, iPad, or laptop:</small>
                  <div id="sec-link-google-slot" class="auth-google-slot"></div>
                </div>
              `}
            </div>
          </div>
        ` : '';
        listsEl.innerHTML = `
          ${googleSectionHtml}
          <div class="sec-section">
            <h3 class="ios-group-title" style="margin-left:2px">Passkeys (${passkeys.length})</h3>
            ${passkeys.length ? `<div class="ios-group">${passkeys.map((k) => `
              <div class="ios-row">
                <span class="ios-row-copy">
                  <span class="ios-row-label">${esc(k.label || 'Passkey')}</span>
                  <small class="ios-row-sub">Added ${fmt(k.createdAt)} · Last used ${fmt(k.lastUsedAt)}</small>
                </span>
                <button type="button" class="ghost-btn" style="padding:4px 10px;font-size:12px" data-del-passkey="${esc(k.id)}">Remove</button>
              </div>`).join('')}</div>`
              : '<p class="muted" style="font-size:13px;margin:4px 0 0">No passkeys saved yet. Tap <b>+ Add Passkey</b> for 1-tap Face ID / Touch ID sign-in.</p>'}
          </div>
          <div class="sec-section">
            <h3 class="ios-group-title" style="margin-left:2px">Linked Device Sessions (${sessions.length})</h3>
            ${sessions.length ? `<div class="ios-group">${sessions.map((s) => `
              <div class="ios-row">
                <span class="ios-row-copy">
                  <span class="ios-row-label">${esc(s.label || 'Browser')}${s.current ? ' <span class="badge live">This device</span>' : ''}</span>
                  <small class="ios-row-sub">Active ${fmt(s.lastUsedAt)}</small>
                </span>
                ${s.current ? '' : `<button type="button" class="ghost-btn" style="padding:4px 10px;font-size:12px" data-revoke-session="${esc(s.id)}">Revoke</button>`}
              </div>`).join('')}</div>`
              : '<p class="muted" style="font-size:13px;margin:4px 0 0">Signed in with primary personal profile key.</p>'}
          </div>
        `;
        const unlinkGoogleBtn = listsEl.querySelector('#sec-unlink-google');
        if (unlinkGoogleBtn) {
          unlinkGoogleBtn.onclick = async () => {
            if (!window.confirm('Disconnect Google Sign-In from this profile?')) return;
            unlinkGoogleBtn.disabled = true;
            await request('/auth/google/unlink', {}).catch(() => {});
            toast('Google Sign-In disconnected.');
            await paint();
          };
        }
        const linkGoogleSlot = listsEl.querySelector('#sec-link-google-slot');
        if (linkGoogleSlot) {
          mountGoogleButton(linkGoogleSlot, async (idToken) => {
            statusEl.textContent = 'Linking Google account…';
            try {
              await request('/auth/google/link', { idToken });
              toast('Google Sign-In connected! You can now sign in with 1 click.');
              await paint();
            } catch (err) {
              statusEl.textContent = err.message || 'Could not link Google account.';
            }
          }, { text: 'continue_with', width: 340 });
        }
        listsEl.querySelectorAll('[data-del-passkey]').forEach((b) => {
          b.onclick = async () => {
            if (!window.confirm('Remove this passkey from your profile?')) return;
            b.disabled = true;
            await request('/auth/passkey/delete', { id: b.dataset.delPasskey }).catch(() => {});
            toast('Passkey removed.');
            await paint();
          };
        });
        listsEl.querySelectorAll('[data-revoke-session]').forEach((b) => {
          b.onclick = async () => {
            b.disabled = true;
            await request('/auth/session/revoke', { id: b.dataset.revokeSession }).catch(() => {});
            toast('Device session revoked.');
            await paint();
          };
        });
      } catch (err) {
        listsEl.innerHTML = `<p class="muted">${esc(err.message || 'Could not load devices.')}</p>`;
      }
    }

    if (!dialog.open) dialog.showModal();
    await paint();
  }

  function profileActions(root) {
    root.querySelector('#community-logout').onclick = async () => {
      await signOut();
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
            <input name="bio" value="${esc(profile.bio || '')}" maxlength="140" placeholder="e.g. BSc Economics · Grinding Finance &amp; Maths">
          </label>
          ${schoolFieldHtml(profile.school || '', profile.canvasOrigin || '')}
          ${majorFieldHtml(profile.major || readLocalMajor())}
          ${secondaryLanguageFieldHtml(profile.secondaryLanguage || '')}
          <label class="check-row" style="font-size:13px;align-items:flex-start;margin:6px 0">
            <input name="newsletterOptIn" type="checkbox" ${profile.newsletterOptIn ? 'checked' : ''} style="margin-top:2px">
            <span>
              <strong>Monthly Study-OS digest &amp; updates</strong> <small class="muted">(1–2/month)</small><br>
              <small class="muted">New past exams, courses &amp; upcoming monthly profile recap with tailored Al study tips.${profile.contactEmailHint ? ` Currently sent to ${esc(profile.contactEmailHint)}.` : ''}</small>
            </span>
          </label>
          <label class="field-label" data-profile-newsletter-email ${profile.newsletterOptIn && !profile.contactEmailHint ? '' : 'hidden'}>Email for monthly digest
            <input name="contactEmail" type="email" placeholder="you@example.com" autocomplete="email" ${profile.newsletterOptIn && !profile.contactEmailHint ? '' : 'disabled'}>
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

    const profNewsletterCb = form.querySelector('input[name="newsletterOptIn"]');
    const profEmailWrap = form.querySelector('[data-profile-newsletter-email]');
    bindSchoolPickers(form);
    profNewsletterCb?.addEventListener('change', () => {
      if (!profEmailWrap) return;
      const show = profNewsletterCb.checked && !profile.contactEmailHint;
      profEmailWrap.hidden = !show;
      const inp = profEmailWrap.querySelector('input');
      if (inp) inp.disabled = !show;
    });

    form.onsubmit = async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type=submit]');
      submit.disabled = true;
      status.textContent = 'Saving profile…';
      try {
        const fd = new FormData(form);
        const { school, canvasOrigin } = extractSchoolFields(fd);
        const major = extractMajorField(fd);
        const payload = {
          avatar: draftAvatar,
          bio: String(form.elements.bio.value || '').trim(),
          school,
          major,
          canvasOrigin,
          secondaryLanguage: String(form.elements.secondaryLanguage?.value || ''),
          newsletterOptIn: Boolean(form.elements.newsletterOptIn?.checked),
        };
        const rawEmail = String(form.elements.contactEmail?.value || '').trim();
        if (payload.newsletterOptIn && rawEmail) payload.contactEmail = rawEmail;
        const candidateNick = String(nickInput.value || '').trim();
        if (candidateNick && candidateNick !== profile.nickname) {
          payload.nickname = candidateNick;
        }
        const updated = await request('/profile', payload);
        if (updated && typeof updated === 'object') currentProfile = { ...currentProfile, ...updated };
        saveLocalSchool(school, canvasOrigin);
        saveLocalMajor(major);
        window.StudyApp?.onSchoolChanged?.();
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
        const [overview, courseList, feedbackRes] = await Promise.all([
          request('/admin/overview'),
          request('/admin/courses').catch(() => ({ courses: [] })),
          request('/feedback').catch(() => ({ items: [] })),
        ]);
        if (!body.isConnected) return;
        renderAdminBody(body, overview);

        const fbItems = Array.isArray(feedbackRes?.items) ? feedbackRes.items : [];
        const fbSec = document.createElement('section');
        fbSec.className = 'panel course-review';
        const openFbCount = fbItems.filter((f) => f.status !== 'done').length;
        fbSec.innerHTML = `<h3>Feedback inbox (${openFbCount} open · ${fbItems.length} total)</h3>${fbItems.length
          ? fbItems.map((f) => `<div class="row-between" style="gap:8px;padding:8px 0;border-bottom:1px solid var(--line);align-items:flex-start">
              <div style="flex:1;min-width:0">
                <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:3px">
                  <span class="badge ${f.status === 'done' ? '' : 'gold'}">${esc(f.category || 'idea')}</span>
                  <strong>${esc(f.nickname || 'Student')}</strong>
                  <small class="muted">${esc(new Date(f.createdAt).toLocaleString())}</small>
                  ${f.status === 'done' ? '<span class="badge good">Done</span>' : ''}
                </div>
                <p style="margin:2px 0 0;font-size:13.5px;white-space:pre-wrap;word-break:break-word">${esc(f.message)}</p>
              </div>
              <div class="row-actions" style="flex-shrink:0">
                <button type="button" class="ghost-btn" data-fb-act="${f.status === 'done' ? 'open' : 'done'}" data-fb-id="${esc(f.id)}">${f.status === 'done' ? 'Reopen' : 'Done'}</button>
                <button type="button" class="ghost-btn" data-fb-act="delete" data-fb-id="${esc(f.id)}">Delete</button>
              </div>
            </div>`).join('')
          : '<p class="muted">No user feedback yet.</p>'}`;
        body.prepend(fbSec);
        fbSec.querySelectorAll('[data-fb-act]').forEach((btn) => {
          btn.onclick = async () => {
            btn.disabled = true;
            try {
              await request('/admin/feedback', { id: btn.dataset.fbId, action: btn.dataset.fbAct });
              await loadAdmin();
            } catch (err) {
              toast(err.message || 'Could not update feedback.');
              btn.disabled = false;
            }
          };
        });

        const courses = document.createElement('section');
        courses.className = 'panel course-review';
        courses.innerHTML = `<h3>Community-synced courses (${courseList.courses.length})</h3>${courseList.courses.length
          ? courseList.courses.map(course => `<div class="row-between" style="gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">
            <span>
              <strong>${esc(course.code || 'BI')} · ${esc(course.title)}</strong>
              ${course.verified ? '<span class="badge good" style="margin-left:4px">Verified</span>' : ''}
              ${course.status === 'rejected' ? '<span class="badge bad" style="margin-left:4px">Hidden</span>' : ''}
              <br><small class="muted">${course.contributorCount || 1} student${(course.contributorCount || 1) === 1 ? '' : 's'} · ${course.syncCount || 1} sync${(course.syncCount || 1) === 1 ? '' : 's'}${course.topicCount ? ` · ${course.topicCount} topics` : ''}${course.edCourseId ? ' · Ed linked' : ''}</small>
            </span>
            <div class="row-actions">
              <button type="button" class="ghost-btn" data-course-verify="${course.verified ? '0' : '1'}" data-id="${esc(course.id)}">${course.verified ? 'Unverify' : 'Verify'}</button>
              ${course.status !== 'approved' ? `<button type="button" class="ghost-btn" data-course-review="approved" data-id="${esc(course.id)}">Show</button>` : ''}
              ${course.status !== 'rejected' ? `<button type="button" class="ghost-btn" data-course-review="rejected" data-id="${esc(course.id)}">Hide</button>` : ''}
            </div>
          </div>`).join('')
          : '<p class="muted">No community courses synced from Canvas or Ed yet.</p>'}`;
        body.prepend(courses);
        courses.querySelectorAll('[data-course-verify]').forEach(button => {
          button.onclick = async () => {
            button.disabled = true;
            try {
              await request('/admin/courses', { id: button.dataset.id, verified: button.dataset.courseVerify === '1' });
              await loadAdmin();
            } catch (error) {
              toast(error.message || 'Could not update course verification.');
              button.disabled = false;
            }
          };
        });
        courses.querySelectorAll('[data-course-review]').forEach(button => {
          button.onclick = async () => {
            button.disabled = true;
            try {
              await request('/admin/courses', { id: button.dataset.id, status: button.dataset.courseReview });
              await loadAdmin();
            } catch (error) {
              toast(error.message || 'Could not review the course.');
              button.disabled = false;
            }
          };
        });
      } catch (err) {
        body.innerHTML = `<p class="muted">${esc(err.message || 'Could not load admin controls.')}</p>`;
      }
    }

    function renderAdminBody(body, { settings, invites, members, newsletterCount, now }) {
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
        const prefTags = [
          m.secondaryLanguage ? `<span class="badge">${esc(m.secondaryLanguage.toUpperCase())}</span>` : '',
          Number(m.newsletterOptIn) === 1 ? '<span class="badge good">Digest</span>' : '',
        ].filter(Boolean).join(' ');
        return `<tr>
          <td><span class="community-member-inline">${avatarHtml(m.nickname, m.avatar, 26)}<strong>${esc(m.nickname)}</strong>${isSelf ? ' <span class="badge admin-badge">You</span>' : ''}${prefTags ? ' ' + prefTags : ''}</span></td>
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
            <label class="check-row">
              <input type="checkbox" id="admin-toggle-google-code" ${settings.requireInviteForGoogle ? 'checked' : ''}>
              <span><strong>Require access code on Google sign-in too</strong> <small class="muted">(asks everyone for a short code when joining — uncheck for open Google signup)</small></span>
            </label>
            <label class="check-row">
              <input type="checkbox" id="admin-toggle-archive-pass" ${settings.archivePassEnabled ? 'checked' : ''}>
              <span><strong>Temporary PDF Archive Pass (skip Canvas Sync)</strong> <small class="muted">(auto-unlocks PDFs in-memory for active code holders; uncheck or revoke a code to cut off access instantly)</small></span>
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
          <h3>Private PDF archive</h3>
          <p class="muted">Archive keys begin with <code>sos1_</code> and decrypt the currently published PDF archive. A replacement key requires republishing the encrypted archive.</p>
          ${!window.StudyMembers?.enabled ? '<p class="muted">This deployment has no published PDF archive.</p>'
            : settings.hasAdminMemberKey ? `
              <button type="button" class="ghost-btn" id="admin-copy-archive-key" disabled>Copy archive access string</button>
              <p class="muted" role="status" id="admin-archive-status">Checking the saved key against the published archive…</p>`
            : '<p class="muted">Unlock the PDF archive once while signed in as an admin to save its key here.</p>'}
          <a href="https://github.com/shadjosef/study-os#full-member-library" target="_blank" rel="noopener">Archive publishing and key rotation</a>
        </div>

        <div class="admin-section">
          <h3>Community invite codes</h3>
          <p class="muted">Use these codes to create a Community profile. Generated invites start with <code>soci1_</code>.</p>
          <form id="admin-create-invite" class="admin-invite-form">
            <label class="field-label">Label <input name="label" maxlength="60" placeholder="e.g. OB Class Nov 2026"></label>
            <label class="field-label">Max uses <small class="muted">(0 = unlimited)</small> <input name="maxUses" type="number" min="0" max="10000" value="0"></label>
            <label class="field-label">Expires in days <small class="muted">(7 = 1 week · 0 = never)</small> <input name="expiresInDays" type="number" min="0" max="365" value="7"></label>
            <label class="field-label">Custom access code <small class="muted">(optional, 4–120 chars, no spaces — e.g. <code>BI2026</code>, or leave blank for random <code>soci1_…</code>)</small>
              <input name="customCode" maxlength="120" autocomplete="off" spellcheck="false" placeholder="e.g. BI2026 (easy to type)">
            </label>
            <div class="row-actions">
              <button type="submit" class="primary-btn">Create access code</button>
            </div>
          </form>
          ${lastCreatedCode ? `
            <div class="admin-created-code">
              <div>
                <strong>New access code (shown once — copy code or share link now):</strong>
                <code id="admin-new-code-text" style="display:block;margin-top:4px;word-break:break-all">${esc(lastCreatedCode)}</code>
              </div>
              <div class="row-actions" style="gap:6px;flex-wrap:wrap">
                <button type="button" class="primary-btn" id="admin-copy-new-code">Copy code</button>
                <button type="button" class="ghost-btn" id="admin-copy-new-link">Copy access link</button>
              </div>
            </div>` : ''}
          ${inviteRows ? `<div class="community-table" style="margin-top:10px"><table>
            <thead><tr><th>Invite</th><th>Uses</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${inviteRows}</tbody></table></div>` : '<p class="muted" style="margin-top:8px">No custom invite codes created yet.</p>'}
        </div>

        <div class="admin-section">
          <div class="row-between">
            <h3>Members (${(members || []).length})</h3>
            <span class="badge${newsletterCount ? ' good' : ''}">Newsletter opt-ins: ${Number(newsletterCount) || 0}</span>
          </div>
          ${memberRows ? `<div class="community-table"><table>
            <thead><tr><th>Member</th><th>Study</th><th>Breaks</th><th>Nickname lock</th><th>Actions</th></tr></thead>
            <tbody>${memberRows}</tbody></table></div>` : ''}
        </div>
      `;

      const status = body.querySelector('#admin-action-status');
      body.querySelector('#admin-refresh-btn').onclick = () => loadAdmin();

      const copyArchiveKey = body.querySelector('#admin-copy-archive-key');
      if (copyArchiveKey) {
        const archiveStatus = body.querySelector('#admin-archive-status');
        const adminToken = token;
        request('/profile', null, adminToken).then(async (profile) => {
          if (!profile.isAdmin || !profile.memberKey) throw new Error('This admin profile has no saved archive key.');
          await window.StudyMembers.verifyAccessString(profile.memberKey);
          if (token !== adminToken || !copyArchiveKey.isConnected) return;
          archiveStatus.textContent = 'Verified for the published PDF archive.';
          copyArchiveKey.disabled = false;
          copyArchiveKey.onclick = async () => {
            if (token !== adminToken || !copyArchiveKey.isConnected) return;
            try {
              await navigator.clipboard.writeText(profile.memberKey);
              archiveStatus.textContent = 'Archive access string copied.';
            } catch {
              archiveStatus.textContent = 'Clipboard access was blocked by this browser.';
            }
          };
        }).catch((error) => {
          archiveStatus.textContent = error.message || 'Could not verify the saved archive key.';
        });
      }

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
      body.querySelector('#admin-toggle-google-code')?.addEventListener('change', (ev) =>
        updateSetting({ requireInviteForGoogle: ev.currentTarget.checked }, ev.currentTarget.checked ? 'Google sign-in now requires an access code.' : 'Google sign-in is now open without a code.'));
      body.querySelector('#admin-toggle-archive-pass')?.addEventListener('change', (ev) =>
        updateSetting({ archivePassEnabled: ev.currentTarget.checked }, ev.currentTarget.checked ? 'Temporary PDF Archive Pass enabled.' : 'Temporary PDF Archive Pass disabled — users will sync their own Canvas.'));
      body.querySelector('#admin-toggle-env-join')?.addEventListener('change', (ev) =>
        updateSetting({ envJoinEnabled: ev.currentTarget.checked }, ev.currentTarget.checked ? 'Legacy env invite enabled.' : 'Legacy env invite disabled.'));

      body.querySelector('#admin-copy-new-code')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(lastCreatedCode);
          toast('Access code copied.');
        } catch {
          status.textContent = 'Select and copy the access code shown above.';
        }
      });
      body.querySelector('#admin-copy-new-link')?.addEventListener('click', async () => {
        const link = `${window.location.origin}/?code=${encodeURIComponent(lastCreatedCode)}`;
        try {
          await navigator.clipboard.writeText(link);
          toast('Expiring access link copied!');
        } catch {
          window.prompt('Copy this access link:', link);
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

  function feedbackPanelHtml() {
    return `
      <details class="panel community-feedback-box" id="community-feedback-panel">
        <summary><strong>Send feedback</strong> <small class="muted" style="font-weight:500;margin-left:6px">Ideas, bugs &amp; missing courses</small></summary>
        <form id="community-feedback-form" style="margin-top:12px">
          <div class="row-actions" style="margin-bottom:8px;gap:6px">
            <label class="field-label" style="margin:0;flex:1;min-width:150px">Type
              <select name="category">
                <option value="idea">Feature idea</option>
                <option value="bug">Bug / issue</option>
                <option value="course">Course / exam request</option>
                <option value="other">Other</option>
              </select>
            </label>
          </div>
          <label class="field-label">Your feedback
            <textarea name="message" rows="3" maxlength="1500" minlength="6" placeholder="What would make Study-OS better for your studying?" required></textarea>
          </label>
          <div class="row-actions" style="margin-top:8px">
            <button type="submit" class="primary-btn">Send feedback</button>
            <span class="muted" id="community-feedback-status" role="status" style="font-size:12.5px"></span>
          </div>
        </form>
      </details>`;
  }

  function bindFeedbackPanel(root) {
    const form = root.querySelector('#community-feedback-form');
    const status = root.querySelector('#community-feedback-status');
    if (!form) return;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      if (status) status.textContent = 'Sending…';
      try {
        await request('/feedback', {
          category: String(fd.get('category') || 'idea'),
          message: String(fd.get('message') || '').trim(),
          page: 'community',
        });
        form.reset();
        if (status) status.textContent = 'Sent — thanks for helping improve Study-OS!';
        toast('Feedback sent — thank you!');
      } catch (err) {
        if (status) status.textContent = err?.message || 'Could not send feedback.';
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  async function openFeedbackDialog() {
    if (!api) {
      toast('Feedback requires the hosted Study-OS site.');
      return;
    }
    if (!token) {
      const ok = await requireProfile({ allowDemo: true, forcePrompt: true });
      if (!ok) return;
    }
    let dlg = document.getElementById('feedback-modal-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'feedback-modal-dialog';
      dlg.className = 'member-dialog playbook-sheet';
      dlg.tabIndex = -1;
      dlg.setAttribute('aria-labelledby', 'feedback-modal-title');
      dlg.addEventListener('click', (ev) => {
        if (ev.target === dlg) dlg.close();
      });
      document.body.appendChild(dlg);
    }
    dlg.innerHTML = `
      <div class="playbook-head">
        <div>
          <span class="eyebrow">Study-OS</span>
          <h2 id="feedback-modal-title" style="margin:2px 0 4px">Send Feedback</h2>
          <p class="muted" style="margin:0;font-size:13px">Report a bug, suggest a feature, or request a course.</p>
        </div>
        <button type="button" class="ios-done-btn" id="feedback-modal-done">Done</button>
      </div>
      <div class="playbook-body">
        <form id="feedback-modal-form" class="playbook-card" style="display:flex;flex-direction:column;gap:10px">
          <label class="field-label" style="margin:0">Category
            <select name="category">
              <option value="idea">Feature idea</option>
              <option value="bug">Bug / issue</option>
              <option value="course">Course / exam request</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label class="field-label" style="margin:0">Message
            <textarea name="message" rows="4" maxlength="1500" minlength="6" placeholder="Share what worked, what broke, or what you want next…" required></textarea>
          </label>
          <div class="row-actions">
            <button type="submit" class="primary-btn">Send feedback</button>
            <span class="muted" id="feedback-modal-status" role="status" style="font-size:12.5px"></span>
          </div>
        </form>
      </div>
    `;
    dlg.querySelector('#feedback-modal-done')?.addEventListener('click', () => dlg.close());
    const form = dlg.querySelector('#feedback-modal-form');
    const status = dlg.querySelector('#feedback-modal-status');
    form?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      if (status) status.textContent = 'Sending…';
      try {
        await request('/feedback', {
          category: String(fd.get('category') || 'idea'),
          message: String(fd.get('message') || '').trim(),
          page: 'settings',
        });
        toast('Feedback sent — thank you!');
        dlg.close();
      } catch (err) {
        if (status) status.textContent = err?.message || 'Could not send feedback.';
        if (btn) btn.disabled = false;
      }
    });
    if (!dlg.open) {
      dlg.showModal();
      dlg.focus({ preventScroll: true });
    }
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      bin += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(bin);
  }

  async function listMaterials() {
    if (!api || !token) return { items: [], usedBytes: 0, maxBytes: 200 * 1024 * 1024, maxFileBytes: 50 * 1024 * 1024 };
    return request('/materials');
  }

  async function uploadMaterial(file, { courseCode = '', courseTitle = '', onProgress } = {}) {
    if (!api || !token) throw new Error('Sign in to sync curriculum files to your profile.');
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const chunkSize = 245_760;
    const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / chunkSize));
    const init = await request('/materials/init', {
      title: file.name || 'document.pdf',
      mimeType: file.type || '',
      sizeBytes: bytes.byteLength,
      chunkCount,
      courseCode,
      courseTitle,
    });
    const actualChunk = Number(init.chunkBytes || chunkSize);
    for (let i = 0; i < chunkCount; i++) {
      const slice = bytes.subarray(i * actualChunk, Math.min(bytes.byteLength, (i + 1) * actualChunk));
      await request('/materials/chunk', {
        id: init.id,
        index: i,
        data: bytesToBase64(slice),
      });
      onProgress?.(i + 1, chunkCount);
    }
    return request('/materials/complete', { id: init.id });
  }

  async function deleteMaterial(id) {
    if (!api || !token) throw new Error('Sign in first.');
    return request('/materials/delete', { id });
  }

  async function openMaterial(id, title = 'material') {
    if (!api || !token) throw new Error('Sign in first.');
    const res = await fetch(`${api}/materials/download?id=${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Could not download file.');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const disp = res.headers.get('Content-Disposition') || '';
    if (disp.startsWith('attachment')) {
      const a = document.createElement('a');
      a.href = url;
      a.download = title;
      a.click();
    } else {
      const win = window.open(url, '_blank', 'noopener');
      if (!win) {
        const a = document.createElement('a');
        a.href = url;
        a.download = title;
        a.click();
      }
    }
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  }

  const DEMO_LEADERBOARD_ROWS = [
    { id: 'demo-1', nickname: 'Mira', avatar: '🦉', bio: 'EXC 3430 · Aiming for A on WISEflow', study_minutes: 1320, break_minutes: 210, break_count: 26, completed: 164, attempts: 182, accuracy: 91, mode: 'working', elapsed_seconds: 1840, updated_at: Date.now() - 12_000, break_ends_at: 0 },
    { id: 'demo-2', nickname: 'Noah', avatar: '🦊', bio: 'EBA 1181 & EBA 3400 · Daily 75m blocks', study_minutes: 840, break_minutes: 145, break_count: 18, completed: 96, attempts: 112, accuracy: 86, mode: 'break', elapsed_seconds: 0, updated_at: Date.now() - 8_000, break_ends_at: Date.now() + 260_000 },
    { id: 'demo-3', nickname: 'Lin', avatar: '⚡', bio: 'EXC 3420 Macro & WS-PS drills', study_minutes: 510, break_minutes: 85, break_count: 11, completed: 54, attempts: 60, accuracy: 90, mode: 'working', elapsed_seconds: 920, updated_at: Date.now() - 20_000, break_ends_at: 0 },
    { id: 'demo-4', nickname: 'Henrik', avatar: '🎯', bio: 'BI Oslo · Accounting & OB notes', study_minutes: 290, break_minutes: 50, break_count: 7, completed: 29, attempts: 37, accuracy: 78, mode: 'idle', elapsed_seconds: 0, updated_at: 0, break_ends_at: 0 },
    { id: 'demo-5', nickname: 'Sofia', avatar: '📚', bio: 'First week on Study-OS', study_minutes: 110, break_minutes: 20, break_count: 3, completed: 12, attempts: 15, accuracy: 80, mode: 'idle', elapsed_seconds: 0, updated_at: 0, break_ends_at: 0 },
  ];

  let activeBoardTab = 'overall';

  function studyTitleMeta(row) {
    const comp = Number(row.completed) || 0;
    const hrs = (Number(row.study_minutes) || 0) / 60;
    if (comp >= 150 || hrs >= 40) return { code: 'GM', name: 'Grandmaster (150+ tasks or 40h+)', cls: 'lb-title-gm' };
    if (comp >= 80 || hrs >= 20) return { code: 'IM', name: 'Master (80+ tasks or 20h+)', cls: 'lb-title-im' };
    if (comp >= 40 || hrs >= 10) return { code: 'FM', name: 'Scholar (40+ tasks or 10h+)', cls: 'lb-title-fm' };
    if (comp >= 15 || hrs >= 4) return { code: 'CM', name: 'Fellow (15+ tasks or 4h+)', cls: 'lb-title-cm' };
    return { code: 'CL', name: 'Club Member', cls: 'lb-title-cl' };
  }

  function presencePillHtml(row, now) {
    if (row.mode === 'break') {
      const left = clockSec(Math.max(0, Math.ceil(((row.break_ends_at || 0) - now) / 1000)));
      return `<span class="lb-status lb-status-break"><i aria-hidden="true"></i>On break · ${esc(left)}</span>`;
    }
    if (row.mode === 'working') {
      const elapsed = clockSec(Math.min(4500, (Number(row.elapsed_seconds) || 0) + Math.max(0, Math.floor((now - (row.updated_at || now)) / 1000))));
      return `<span class="lb-status lb-status-live"><i aria-hidden="true"></i>Studying · ${esc(elapsed)}</span>`;
    }
    if (row.mode === 'paused') {
      return `<span class="lb-status lb-status-paused"><i aria-hidden="true"></i>Paused · ${esc(clockSec(Number(row.elapsed_seconds) || 0))}</span>`;
    }
    return '<span class="lb-status lb-status-idle"><i aria-hidden="true"></i>Offline</span>';
  }

  function sortBoardRows(rows, tab) {
    const copy = [...(rows || [])];
    if (tab === 'hours') {
      copy.sort((a, b) => (Number(b.study_minutes) || 0) - (Number(a.study_minutes) || 0) || (Number(b.completed) || 0) - (Number(a.completed) || 0));
    } else if (tab === 'accuracy') {
      copy.sort((a, b) => {
        const qa = (Number(a.attempts) || 0) >= 3 ? (Number(a.accuracy) || 0) : -1;
        const qb = (Number(b.attempts) || 0) >= 3 ? (Number(b.accuracy) || 0) : -1;
        return qb - qa || (Number(b.completed) || 0) - (Number(a.completed) || 0);
      });
    } else {
      copy.sort((a, b) => (Number(b.completed) || 0) - (Number(a.completed) || 0) || (Number(b.study_minutes) || 0) - (Number(a.study_minutes) || 0));
    }
    return copy;
  }

  function chessLeaderboardHtml({ rows, meId = '', offset = 0, now = Date.now(), isDemo = false, tab = 'overall', hasMoreRanks = false }) {
    const sorted = sortBoardRows(rows, tab);
    const crownSvg = '<svg class="lb-crown" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3 18h18v2H3v-2zm0-2L1 7l5.5 3.5L12 4l5.5 6.5L23 7l-2 9H3z"/></svg>';

    const podiumHtml = offset === 0 && sorted.length
      ? `<div class="lb-podium" aria-label="Top ranked members">
          ${sorted.slice(0, 3).map((row, idx) => {
            const rank = idx + 1;
            const t = studyTitleMeta(row);
            const hrs = ((Number(row.study_minutes) || 0) / 60).toFixed(1);
            const acc = Number(row.attempts) ? `${Number(row.accuracy) || 0}%` : '—';
            const isOnline = row.mode === 'working' || row.mode === 'break';
            const primaryMetric = tab === 'hours'
              ? `<strong>${hrs}h</strong><small>Study hours</small>`
              : tab === 'accuracy'
              ? `<strong>${acc}</strong><small>Accuracy</small>`
              : tab === 'elo'
              ? `<strong class="lb-elo-dots">•••••</strong><small>ELO coming soon</small>`
              : `<strong>${Number(row.completed) || 0}</strong><small>Completed</small>`;
            return `<article class="lb-podium-card lb-rank-${rank} ${row.id === meId ? 'is-me' : ''}">
              <div class="lb-podium-head">
                <span class="lb-medal lb-medal-${rank}">${rank === 1 ? crownSvg : ''}#${rank}</span>
                <span class="lb-title-tag ${t.cls}" title="${esc(t.name)}">${esc(t.code)}</span>
              </div>
              <div class="lb-podium-avatar-wrap">
                ${avatarHtml(row.nickname, row.avatar, rank === 1 ? 56 : 48)}
                ${isOnline ? `<span class="lb-online-dot ${row.mode === 'break' ? 'is-break' : ''}" title="${row.mode === 'break' ? 'On break' : 'Studying now'}"></span>` : ''}
              </div>
              <div class="lb-podium-name">
                <strong>${esc(row.nickname)}</strong>${row.id === meId ? ' <span class="badge good">You</span>' : ''}${isPublicBadgeVal(row.school) ? ` <span class="leaderboard-school-pill">${esc(row.school)}</span>` : ''}${isPublicBadgeVal(row.major) ? ` <span class="leaderboard-major-pill">${esc(row.major)}</span>` : ''}
              </div>
              <div class="lb-podium-primary">${primaryMetric}</div>
              <div class="lb-podium-sub">
                <span>${hrs}h</span>
                <span>·</span>
                <span>${Number(row.completed) || 0} Qs</span>
                <span>·</span>
                <span>${acc}</span>
              </div>
              <div class="lb-podium-elo" title="Ranked Study ELO is coming soon">
                <span>ELO</span>
                <b class="lb-elo-dots">•••••</b>
                <small>Soon</small>
              </div>
            </article>`;
          }).join('')}
        </div>`
      : '';

    const myIdx = meId ? sorted.findIndex((r) => r.id === meId) : -1;
    const myStandingHtml = myIdx >= 0 ? (() => {
      const meRow = sorted[myIdx];
      const t = studyTitleMeta(meRow);
      return `<div class="lb-my-standing">
        <div class="lb-my-standing-left">
          <span class="lb-rank-chip">#${offset + myIdx + 1}</span>
          <span class="lb-title-tag ${t.cls}" title="${esc(t.name)}">${esc(t.code)}</span>
          <strong>${esc(meRow.nickname)}</strong>
          <span class="badge good">Your standing</span>
        </div>
        <div class="lb-my-standing-stats">
          <span><b>${Number(meRow.completed) || 0}</b> Qs</span>
          <span><b>${((Number(meRow.study_minutes) || 0) / 60).toFixed(1)}h</b></span>
          <span><b>${Number(meRow.attempts) ? `${meRow.accuracy}%` : '—'}</b> acc</span>
          <span class="lb-elo-pill" title="Ranked ELO duels coming soon">ELO <b class="lb-elo-dots">•••••</b> <small>Soon</small></span>
        </div>
      </div>`;
    })() : '';

    const eloBannerHtml = tab === 'elo'
      ? `<div class="lb-elo-teaser">
          <div>
            <span class="badge gold">Ranked Arena · Coming Soon</span>
            <h3 style="margin:6px 0 4px">Study-OS ELO Rating (<span class="lb-elo-dots">•••••</span>)</h3>
            <p class="muted" style="margin:0;font-size:13px">Head-to-head timed duels &amp; exam-pace rating tiers (1200 Provisional → 2000+ GM) are launching soon. Everyone's ELO slot is reserved as <code>•••••</code> until Season 1 opens.</p>
          </div>
          <div class="lb-elo-tiers">
            <span class="lb-title-tag lb-title-cl">1200 Club</span>
            <span class="lb-title-tag lb-title-cm">1400 CM</span>
            <span class="lb-title-tag lb-title-fm">1650 FM</span>
            <span class="lb-title-tag lb-title-im">1850 IM</span>
            <span class="lb-title-tag lb-title-gm">2000+ GM</span>
          </div>
        </div>`
      : '';

    const rowsHtml = sorted.map((row, index) => {
      const rank = offset + index + 1;
      const t = studyTitleMeta(row);
      const hrs = ((Number(row.study_minutes) || 0) / 60).toFixed(1);
      const hasAcc = Number(row.attempts) > 0;
      const accNum = hasAcc ? Math.max(0, Math.min(100, Number(row.accuracy) || 0)) : 0;
      const isOnline = row.mode === 'working' || row.mode === 'break';
      const rankBadge = rank <= 3
        ? `<span class="lb-rank-box lb-rank-box-${rank}">${rank}</span>`
        : `<span class="lb-rank-num">${rank}</span>`;
      return `<tr class="lb-row ${rank <= 3 ? `lb-row-top-${rank}` : ''} ${row.id === meId ? 'community-row-me' : ''}">
        <td class="lb-col-rank">${rankBadge}</td>
        <td>
          <div class="community-member-cell">
            <div class="lb-avatar-wrap">
              ${avatarHtml(row.nickname, row.avatar, 34)}
              ${isOnline ? `<span class="lb-online-dot ${row.mode === 'break' ? 'is-break' : ''}"></span>` : ''}
            </div>
            <div class="community-member-meta">
              <div class="lb-player-line">
                <span class="lb-title-tag ${t.cls}" title="${esc(t.name)}">${esc(t.code)}</span>
                <strong>${esc(row.nickname)}</strong>
                ${isPublicBadgeVal(row.school) ? `<span class="leaderboard-school-pill">${esc(row.school)}</span>` : ''}
                ${isPublicBadgeVal(row.major) ? `<span class="leaderboard-major-pill">${esc(row.major)}</span>` : ''}
                ${row.id === meId ? '<span class="badge good">You</span>' : ''}
              </div>
              ${row.bio ? `<small class="community-bio-sub">${esc(row.bio)}</small>` : ''}
            </div>
          </div>
        </td>
        <td class="lb-col-elo">
          <span class="lb-elo-pill" title="ELO rating coming soon">
            <b class="lb-elo-dots">•••••</b>
            <small>Soon</small>
          </span>
        </td>
        <td class="lb-col-num"><strong>${Number(row.completed) || 0}</strong>${!isDemo ? `<small class="muted lb-sub-num">${Number(row.attempts) || 0} att</small>` : ''}</td>
        <td class="lb-col-num"><strong>${hrs}h</strong></td>
        <td class="lb-col-acc">
          ${hasAcc ? `<div class="lb-acc-wrap">
            <strong>${accNum}%</strong>
            <div class="lb-acc-bar"><i style="width:${accNum}%"></i></div>
          </div>` : '<span class="muted">—</span>'}
        </td>
        ${!isDemo ? `<td>${breakCellHtml(row)}</td>` : ''}
        <td>${presencePillHtml(row, now)}</td>
      </tr>`;
    }).join('');

    return `
      <section class="panel lb-arena-panel" data-lb-root="${isDemo ? 'demo' : 'live'}">
        <div class="lb-arena-header">
          <div>
            <div class="lb-arena-title-row">
              <span class="lb-arena-icon" aria-hidden="true">${crownSvg}</span>
              <h2 style="margin:0">${isDemo ? 'Leaderboard Preview' : 'Leaderboard'}</h2>
              <span class="lb-hours-chip" title="Open during timed breaks or daily 18:00–22:30 Oslo time">18:00–22:30 Oslo · or Break</span>
            </div>
            <p class="muted" style="margin:4px 0 0;font-size:13px">${isDemo
              ? 'Chess-style study rankings, live status & upcoming ELO arena (sample players).'
              : 'University study rankings with titles, accuracy bars, break habits, live timers & upcoming ELO.'}</p>
          </div>
          <div class="lb-arena-controls">
            <div class="lb-tab-strip" role="tablist" aria-label="Leaderboard ranking category">
              <button type="button" class="lb-tab-btn ${tab === 'overall' ? 'active' : ''}" data-lb-tab="overall" role="tab" aria-selected="${tab === 'overall'}">Overall</button>
              <button type="button" class="lb-tab-btn ${tab === 'hours' ? 'active' : ''}" data-lb-tab="hours" role="tab" aria-selected="${tab === 'hours'}">Hours</button>
              <button type="button" class="lb-tab-btn ${tab === 'accuracy' ? 'active' : ''}" data-lb-tab="accuracy" role="tab" aria-selected="${tab === 'accuracy'}">Accuracy</button>
              <button type="button" class="lb-tab-btn ${tab === 'elo' ? 'active' : ''}" data-lb-tab="elo" role="tab" aria-selected="${tab === 'elo'}">ELO <span class="lb-tab-soon">•••••</span></button>
            </div>
            ${!isDemo ? '<button type="button" class="ghost-btn" id="community-stats" style="padding:6px 11px;font-size:12.5px">Refresh</button>' : ''}
          </div>
        </div>
        ${podiumHtml}
        ${myStandingHtml}
        ${eloBannerHtml}
        ${rowsHtml ? `<div class="community-table lb-table-wrap"><table class="lb-table">
          <thead><tr>
            <th>#</th>
            <th>Player</th>
            <th>ELO</th>
            <th>Completed</th>
            <th>Hours</th>
            <th>Accuracy</th>
            ${!isDemo ? '<th>Breaks</th>' : ''}
            <th>Status</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody></table></div>` : '<p class="muted">No ranked members yet.</p>'}
        ${!isDemo && (offset || hasMoreRanks) ? `<div class="row-actions" style="margin-top:12px">
          <button type="button" class="ghost-btn" id="community-ranks-prev" ${offset ? '' : 'disabled'}>Previous</button>
          <button type="button" class="ghost-btn" id="community-ranks-next" ${hasMoreRanks ? '' : 'disabled'}>Next</button>
        </div>` : ''}
      </section>`;
  }

  function demoCardsHtml(interactive = false) {
    return `
      <div class="community-demo-stack">
        <section class="panel room-hub-panel">
          <div class="row-between" style="margin:0 0 10px;flex-wrap:wrap;gap:8px">
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <h2 style="margin:0">Study together &amp; Live Duels</h2>
                <span class="badge gold">Live Beta · Elo Arena</span>
              </div>
              <p class="muted" style="margin:3px 0 0;font-size:13px">Sign in to challenge classmates to 5m Study Duels (Accounting, Economics, Maths, Mixed) or join open 25m/50m/75m Study Pods.</p>
            </div>
          </div>
          <div class="room-open-list">
            <div class="room-open-item is-duel">
              <div class="room-open-info">
                ${avatarHtml('Jonas', '', 28)}
                <div>
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <strong>Jonas</strong>
                    <span class="lb-title-tag lb-title-fm">FM</span>
                    <small class="muted">1384 Elo</small>
                    <span class="badge">⚔️ Duel · 1/2</span>
                  </div>
                  <small class="muted">Accounting &amp; Finance (EXC 3430) · 5m · 6 Qs</small>
                </div>
              </div>
              <span class="badge">Sign in to accept</span>
            </div>
            <div class="room-open-item is-group">
              <div class="room-open-info">
                ${avatarHtml('Mira', '', 28)}
                <div>
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <strong>Mira</strong>
                    <span class="badge">📚 Pod · 3/8</span>
                  </div>
                  <small class="muted">50m Study Pod · EXC 3420 Economics</small>
                </div>
              </div>
              <span class="badge">Sign in to join</span>
            </div>
          </div>
        </section>
        ${chessLeaderboardHtml({ rows: DEMO_LEADERBOARD_ROWS, offset: 0, now: Date.now(), isDemo: true, tab: activeBoardTab })}
        <section class="panel">
          <h2>Chat &amp; messages</h2>
          ${interactive ? `
            <form id="community-demo-chat" class="community-demo-form">
              <label class="field-label">Send to
                <select name="channel">
                  <option value="global">Global chat</option>
                  <option value="direct">Mira · Direct message</option>
                </select>
              </label>
              <ul id="community-demo-messages" class="community-messages" aria-live="polite"></ul>
              <label class="field-label">Message
                <input name="message" maxlength="300" placeholder="Try writing a message" autocomplete="off" required>
              </label>
              <button type="submit" class="ghost-btn">Send demo message</button>
            </form>
          ` : `
            <ul class="community-messages">
              <li><strong>Noah</strong><p>Anyone up for a group session after break?</p></li>
              <li><strong>Lin</strong><p>Yes! I’m reviewing the last two chapters.</p></li>
            </ul>
          `}
        </section>
      </div>`;
  }

  function renderDemo(root) {
    root.innerHTML = `
      <section class="panel" id="community-demo-view">
        <h1 id="community-demo-title" tabindex="-1">Study community</h1>
        <p class="muted">Explore the Chess-style leaderboard, upcoming ELO arena, Ed Discussion course forums, and try sending a message in this tab. Live Community opens during breaks or 18:00–22:30 Oslo time.</p>
        <div class="row-actions">
          <button type="button" class="primary-btn" id="community-join-live">Join live Community</button>
        </div>
      </section>
      ${demoCardsHtml(true)}
      ${edDiscussionSectionHtml()}`;
    root.querySelectorAll('[data-lb-tab]').forEach((btn) => {
      btn.onclick = () => {
        activeBoardTab = btn.dataset.lbTab || 'overall';
        renderDemo(root);
      };
    });
    const join = root.querySelector('#community-join-live');
    join.onclick = async () => {
      if (!canUse()) return;
      const signedIn = await requireProfile({ allowDemo: true, forcePrompt: true });
      if (!signedIn) return;
      await window.StudyRooms?.restore();
      await render();
    };

    const form = root.querySelector('#community-demo-chat');
    const { channel, message } = form.elements;
    const paintMessages = () => {
      const sample = channel.value === 'global'
        ? ['Noah', 'Anyone up for a group session after break?']
        : ['Mira', 'How did your last practice block go?'];
      form.querySelector('#community-demo-messages').innerHTML = [sample, ...demoMessages
        .filter((entry) => entry.channel === channel.value)
        .map((entry) => ['You', entry.message])]
        .map(([name, text]) => `<li><strong>${esc(name)}</strong><p>${esc(text)}</p></li>`).join('');
    };
    channel.onchange = paintMessages;
    form.onsubmit = (event) => {
      event.preventDefault();
      if (!canUse() || !message.value.trim()) return;
      demoMessages.push({ channel: channel.value, message: message.value.trim() });
      if (demoMessages.length > 20) demoMessages.shift();
      message.value = '';
      paintMessages();
      message.focus();
    };
    paintMessages();
    mountEdDiscussionSection(root);
  }

  function renderLocked(root, me = null) {
    const roomRunning = window.StudyRooms?.running();
    root.innerHTML = `
      <section class="panel" id="community-locked" aria-labelledby="community-locked-title">
        <h1 id="community-locked-title">Study community</h1>
        <div class="community-preview-lock">
          <div class="community-preview-blur" inert aria-hidden="true">${demoCardsHtml()}</div>
          <div class="community-break-gate">
            <h2>${roomRunning ? 'Your study room is active' : 'Community opens on break or 18:00–22:30 Oslo'}</h2>
            <p>${roomRunning
              ? 'Finish your study room to return to the leaderboard, chat, and messages.'
              : 'Use the leaderboard, chat, messages, and study rooms during timed breaks or every evening from 18:00 to 22:30 Oslo time.'}</p>
            ${roomRunning
              ? '<button type="button" class="primary-btn" id="community-return-to-room">Return to study room</button>'
              : '<button type="button" class="primary-btn" id="community-start-break">Start a break</button>'}
          </div>
        </div>
      </section>
      ${edDiscussionSectionHtml()}
      ${me ? `<section class="panel">
        <div class="community-identity">
          ${avatarHtml(me.nickname, me.avatar, 48)}
          <div>
            <strong>Signed in as ${esc(me.nickname)}</strong>${isPublicBadgeVal(me.school) ? ` <span class="leaderboard-school-pill">${esc(me.school)}</span>` : ''}${isPublicBadgeVal(me.major) ? ` <span class="leaderboard-major-pill">${esc(me.major)}</span>` : ''}${me.isAdmin ? ' <span class="badge admin-badge">Admin</span>' : ''}
            ${me.bio ? `<p class="community-bio-sub">${esc(me.bio)}</p>` : ''}
          </div>
        </div>
        ${profileBreakStripHtml(me)}
        ${profileEditorHtml(me)}
        <div class="row-actions" style="margin-top:12px">
          <button type="button" class="ghost-btn" id="community-logout">Sign out</button>
          <button type="button" class="ghost-btn" id="community-delete">Delete my profile</button>
        </div>
      </section>
      ${feedbackPanelHtml()}
      ${adminPanelHtml(me)}
      ${privacyNote}` : ''}`;
    root.querySelector('#community-return-to-room')?.addEventListener('click', () => window.StudyApp.navigate('room'));
    root.querySelector('#community-start-break')?.addEventListener('click', () => {
      workClock.triggerBreak();
      if (canUse()) {
        document.getElementById('break-modal').close();
        root.querySelector('#community-demo-title')?.focus();
      }
    });
    mountEdDiscussionSection(root);
    if (!me) return;
    profileActions(root);
    bindProfileEditor(root, me, () => render());
    bindFeedbackPanel(root);
    bindAdminPanel(root, me);
  }

  function presenceLabel(row, now) {
    if (row.mode === 'break') return 'On break · ' + clockSec(Math.max(0, Math.ceil((row.break_ends_at - now) / 1000)));
    if (row.mode === 'working') return 'Studying · ' + clockSec(Math.min(4500, row.elapsed_seconds + Math.floor((now - row.updated_at) / 1000)));
    if (row.mode === 'paused') return 'Paused · ' + clockSec(row.elapsed_seconds);
    return '—';
  }

  function roomInviteChipHtml(text) {
    const m = String(text || '').match(/(?:join_room=|\broom\s+)([A-F0-9]{8})\b/i);
    if (!m) return '';
    const roomCode = m[1].toUpperCase();
    return `<div style="margin-top:6px"><button type="button" class="primary-btn" style="padding:4px 11px;font-size:12px" data-chat-join-room="${esc(roomCode)}">Join Room ${esc(roomCode)} →</button></div>`;
  }

  function bindChatJoinButtons(container) {
    container?.querySelectorAll('[data-chat-join-room]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        await window.StudyRooms?.joinByCode?.(btn.dataset.chatJoinRoom);
        if (btn.isConnected) btn.disabled = false;
      };
    });
  }

  async function refreshChat(root) {
    const list = root.querySelector('#community-chat-list');
    if (chatLoading || !list || !canUse()) return;
    chatLoading = true;
    lastChatAt = Date.now();
    try {
      const { messages } = await request('/chat');
      if (list.isConnected) {
        list.innerHTML = messages.map((message) => `
          <li><div class="row-between"><span class="community-member-inline">${avatarHtml(message.nickname, message.avatar, 24)}<strong>${esc(message.nickname)}</strong></span>
            <small>${esc(new Date(message.createdAt).toLocaleString())}</small></div>
            <p>${esc(message.message)}</p>${roomInviteChipHtml(message.message)}</li>`).join('') || '<li>No messages yet.</li>';
        bindChatJoinButtons(list);
      }
    } finally {
      chatLoading = false;
    }
  }

  async function renderStudySets(root, me) {
    const panel = root.querySelector('#community-study-sets');
    const { sets } = await request('/sets');
    if (!panel.isConnected) return;
    panel.innerHTML = `
      <p>Create a Study Set on Home with Gemini 4 Hydrogen or your own AI, then share it here or send a direct link to classmates. Practice on custom sets earns no leaderboard or Elo points.</p>
      <p id="community-set-status" role="status"></p>
      <ul class="community-messages">${sets.map((set) => `
        <li><div class="community-member-inline">${avatarHtml(set.nickname, set.avatar, 22)}<strong>${esc(set.title)}</strong> <small>${set.card_count} Qs · ${esc(set.nickname)}</small></div>
          <div class="row-actions">
            <button type="button" class="primary-btn" style="padding:5px 11px;font-size:12.5px" data-practice-community-set="${esc(set.id)}">Practice →</button>
            <button type="button" class="ghost-btn" data-save-community-set="${esc(set.id)}">Save to my sets</button>
            ${set.owner === me.id ? `<button type="button" class="ghost-btn" data-remove-community-set="${esc(set.id)}">Remove from Community</button>` : ''}
          </div></li>`).join('') || '<li>No shared sets yet.</li>'}</ul>`;
    const status = panel.querySelector('#community-set-status');
    for (const button of panel.querySelectorAll('[data-practice-community-set], [data-save-community-set], [data-remove-community-set]')) {
      button.onclick = async () => {
        button.disabled = true;
        try {
          if (button.dataset.practiceCommunitySet) {
            const raw = await request('/sets?id=' + encodeURIComponent(button.dataset.practiceCommunitySet));
            const normalized = window.StudySets.normalizeSet ? window.StudySets.normalizeSet(raw) : raw;
            window.StudySets.save(normalized);
            window.StudySets.launchSet(normalized);
          } else if (button.dataset.saveCommunitySet) {
            const raw = await request('/sets?id=' + encodeURIComponent(button.dataset.saveCommunitySet));
            const normalized = window.StudySets.normalizeSet ? window.StudySets.normalizeSet(raw) : raw;
            window.StudySets.save(normalized);
            toast('Saved under My Study Sets on Home.');
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

  // ---------------------------------------------------------------------------
  // ED DISCUSSION HUB (Accessible inside Community even during focus blocks)
  // ---------------------------------------------------------------------------
  const LOCAL_ED_LINKS_KEY = 'study-os-ed-links-v1';
  let cachedApprovedCourses = null;
  let cachedApprovedAt = 0;

  function loadLocalEdLinks() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LOCAL_ED_LINKS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveLocalEdLinks(list) {
    try {
      localStorage.setItem(LOCAL_ED_LINKS_KEY, JSON.stringify((list || []).slice(0, 30)));
    } catch {}
  }

  function parseEdCourseInput(rawUrl) {
    const val = String(rawUrl || '').trim();
    if (!val) return null;
    const candidate = /^https?:\/\//i.test(val) ? val : `https://${val}`;
    try {
      const u = new URL(candidate);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      const host = u.hostname.toLowerCase();
      if (!/^(?:(?:eu|us|au)\.)?edstem\.org$/.test(host)) return null;
      const pathMatch = u.pathname.match(/^(?:\/(eu|us|au))?\/courses\/([1-9][0-9]{0,19})(?:\/|$)/i);
      if (!pathMatch) return null;
      const pathRegion = (pathMatch[1] || '').toLowerCase();
      const edHost = host === 'edstem.org' && pathRegion ? `${pathRegion}.edstem.org` : host;
      return { edHost, edCourseId: pathMatch[2] };
    } catch {
      return null;
    }
  }

  function edDiscussionSectionHtml() {
    return `
      <section class="panel ed-hub-panel" id="community-ed-section" aria-labelledby="community-ed-title">
        <div class="row-between ed-hub-header">
          <div>
            <div class="ed-hub-title-row">
              <h2 id="community-ed-title" style="margin:0">Ed Discussion</h2>
              <span class="badge" id="ed-hub-count-badge">Loading…</span>
            </div>
            <p class="muted" style="margin:4px 0 0">Jump straight into synced course Q&amp;A forums, browse Ed categories, ask questions, or turn discussion topics into practice sets. Always open during focus blocks.</p>
          </div>
          <div class="row-actions" style="gap:7px">
            <button type="button" class="primary-btn" id="ed-hub-sync-btn">Sync Ed Discussion</button>
            <a class="ghost-btn" id="ed-hub-open-portal" href="https://eu.edstem.org/" target="_blank" rel="noopener">Open Ed ↗</a>
          </div>
        </div>
        <div class="ed-hub-controls" id="ed-hub-controls" hidden>
          <input type="search" id="ed-hub-search" class="ed-hub-search" placeholder="Filter by course code, name, school, or Ed topic…" aria-label="Filter Ed Discussion courses" />
          <div class="ed-hub-filter-pills" id="ed-hub-school-pills"></div>
        </div>
        <div class="ed-course-grid" id="community-ed-grid">
          <p class="muted" style="margin:6px 0">Loading synced Ed Discussion course forums…</p>
        </div>
        <details class="ed-pin-details" id="ed-hub-pin-details">
          <summary>+ Pin an Ed Discussion course link (EU / US / AU)</summary>
          <form class="ed-pin-form" id="ed-hub-pin-form">
            <label class="field-label">
              Ed Discussion course URL
              <input type="url" name="url" placeholder="https://eu.edstem.org/courses/3304" required />
            </label>
            <div class="ed-pin-row">
              <label class="field-label">
                Course code (optional)
                <input type="text" name="code" placeholder="e.g. EXC 3420" maxlength="24" />
              </label>
              <label class="field-label">
                Course name (optional)
                <input type="text" name="title" placeholder="e.g. Economics I" maxlength="120" />
              </label>
            </div>
            <div class="row-actions" style="gap:8px;margin-top:6px">
              <button type="submit" class="primary-btn">Pin Course</button>
              <span class="muted" id="ed-hub-pin-status" role="status"></span>
            </div>
          </form>
        </details>
      </section>`;
  }

  async function loadApprovedCoursesCached() {
    if (!api) return [];
    if (cachedApprovedCourses && Date.now() - cachedApprovedAt < 60_000) {
      return cachedApprovedCourses;
    }
    try {
      const list = await approvedCourses();
      cachedApprovedCourses = Array.isArray(list) ? list : [];
      cachedApprovedAt = Date.now();
      return cachedApprovedCourses;
    } catch {
      return cachedApprovedCourses || [];
    }
  }

  async function mountEdDiscussionSection(root) {
    const section = root?.querySelector('#community-ed-section');
    if (!section) return;
    const grid = section.querySelector('#community-ed-grid');
    const badge = section.querySelector('#ed-hub-count-badge');
    const controls = section.querySelector('#ed-hub-controls');
    const searchEl = section.querySelector('#ed-hub-search');
    const schoolPills = section.querySelector('#ed-hub-school-pills');
    const portalLink = section.querySelector('#ed-hub-open-portal');
    const pinForm = section.querySelector('#ed-hub-pin-form');
    const pinStatus = section.querySelector('#ed-hub-pin-status');

    section.querySelector('#ed-hub-sync-btn')?.addEventListener('click', () => {
      if (window.StudyApp?.openBiSyncHub) window.StudyApp.openBiSyncHub();
      else toast('Install & open the Study-OS Sync extension on your Ed Discussion tab.');
    });

    let activeSchool = 'all';
    let query = '';
    const catalog = window.StudyApp?.getCatalog?.() || [];
    const catalogByCode = new Map();
    for (const c of catalog) {
      const norm = String(c.code || '').toUpperCase().replace(/[\s-]+/g, '');
      if (norm) catalogByCode.set(norm, c);
    }

    const userSchool = (currentProfile?.school || readLocalSchool().school || '').trim();

    let remoteEdCourses = [];
    const buildMergedList = () => {
      const merged = [];
      const seen = new Set();
      for (const local of loadLocalEdLinks()) {
        const key = `${local.edHost}:${local.edCourseId}`;
        if (!local.edCourseId || seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...local, pinned: true });
      }
      for (const c of remoteEdCourses) {
        if (!/^[1-9][0-9]{0,19}$/.test(String(c.edCourseId || ''))) continue;
        const edHost = /^(?:(?:eu|us|au)\.)?edstem\.org$/.test(c.edHost || '') ? c.edHost : 'eu.edstem.org';
        const key = `${edHost}:${c.edCourseId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({
          code: c.code || '',
          title: c.title || `Ed Course #${c.edCourseId}`,
          school: c.school || '',
          edCourseId: String(c.edCourseId),
          edHost,
          topics: Array.isArray(c.topics) ? c.topics : [],
          contributorCount: Number(c.contributorCount || 1),
          verified: Boolean(c.verified),
          pinned: false,
        });
      }
      return merged;
    };

    const paintGrid = () => {
      if (!section.isConnected) return;
      const all = buildMergedList();
      if (portalLink && all.length) {
        portalLink.href = `https://${all[0].edHost}/`;
      }
      if (badge) {
        badge.textContent = all.length
          ? `${all.length} linked forum${all.length === 1 ? '' : 's'}`
          : 'Not synced yet';
        badge.classList.toggle('live', all.length > 0);
      }

      const schools = [...new Set(all.map((c) => c.school).filter(Boolean))];
      if (controls) controls.hidden = all.length < 2;
      if (schoolPills) {
        if (schools.length > 1) {
          schoolPills.innerHTML = [
            `<button type="button" class="ed-filter-pill ${activeSchool === 'all' ? 'active' : ''}" data-ed-school="all">All schools</button>`,
            ...schools.map((s) => `<button type="button" class="ed-filter-pill ${activeSchool === s ? 'active' : ''}" data-ed-school="${esc(s)}">${esc(s)}</button>`),
          ].join('');
          schoolPills.querySelectorAll('[data-ed-school]').forEach((btn) => {
            btn.onclick = () => {
              activeSchool = btn.dataset.edSchool || 'all';
              paintGrid();
            };
          });
        } else {
          schoolPills.innerHTML = '';
        }
      }

      const qNorm = query.trim().toLowerCase();
      const filtered = all.filter((c) => {
        if (activeSchool !== 'all' && c.school !== activeSchool) return false;
        if (!qNorm) return true;
        const hay = `${c.code} ${c.title} ${c.school} ${(c.topics || []).join(' ')}`.toLowerCase();
        return hay.includes(qNorm);
      });

      if (!all.length) {
        grid.innerHTML = `
          <div class="ed-empty-card">
            <strong>No Ed Discussion courses linked yet</strong>
            <p class="muted">Open your signed-in Ed Discussion tab (<code>eu.edstem.org</code>, <code>us.edstem.org</code>, or <code>au.edstem.org</code>) and click <strong>Sync Ed Discussion</strong> with the Study-OS extension — or pin any Ed course URL below.</p>
          </div>`;
        return;
      }

      if (!filtered.length) {
        grid.innerHTML = `<p class="muted" style="margin:6px 0">No Ed Discussion forums match “${esc(query)}”.</p>`;
        return;
      }

      grid.innerHTML = filtered.map((c, idx) => {
        const normCode = String(c.code || '').toUpperCase().replace(/[\s-]+/g, '');
        const matchedLocal = normCode ? catalogByCode.get(normCode) : null;
        const topics = Array.isArray(c.topics) ? c.topics : [];
        const topicsHtml = topics.length
          ? `<div class="community-course-topics">${topics.slice(0, 6).map((t) => `<span class="topic-mini-chip">${esc(t)}</span>`).join('')}${topics.length > 6 ? `<span class="topic-mini-chip">+${topics.length - 6}</span>` : ''}</div>`
          : '';
        const forumUrl = `https://${c.edHost}/courses/${c.edCourseId}/discussion/`;
        const askUrl = `https://${c.edHost}/courses/${c.edCourseId}/discussion/new`;
        return `
          <article class="ed-course-card">
            <div class="ed-course-top">
              <div class="row-actions" style="gap:6px;flex-wrap:wrap">
                <span class="course-code-pill">${esc(c.code || `Ed #${c.edCourseId}`)}</span>
                ${c.school ? `<span class="course-school-pill">${esc(c.school)}</span>` : ''}
              </div>
              <span class="badge ${c.verified ? 'good' : ''}">${c.pinned ? 'Pinned' : c.verified ? 'Verified' : 'Synced'}</span>
            </div>
            <h3 class="ed-course-title">${esc(c.title)}</h3>
            <p class="muted ed-course-meta">${esc(c.edHost)}${!c.pinned ? ` · ${c.contributorCount} student${c.contributorCount === 1 ? '' : 's'} synced` : ''}${topics.length ? ` · ${topics.length} categor${topics.length === 1 ? 'y' : 'ies'}` : ''}</p>
            ${topicsHtml}
            <div class="ed-course-actions">
              <a class="primary-btn" href="${esc(forumUrl)}" target="_blank" rel="noopener">Open Forum ↗</a>
              <a class="ghost-btn" href="${esc(askUrl)}" target="_blank" rel="noopener">Ask Question ↗</a>
              ${matchedLocal ? `<button type="button" class="ghost-btn" data-ed-practice="${esc(matchedLocal.courseId)}">Practice →</button>` : ''}
              <button type="button" class="ghost-btn" data-ed-ai-set="${idx}">✨ AI Set</button>
              ${c.pinned ? `<button type="button" class="ghost-btn" data-ed-unpin="${esc(c.edHost + ':' + c.edCourseId)}" title="Remove pinned link">Remove</button>` : ''}
            </div>
          </article>`;
      }).join('');

      grid.querySelectorAll('[data-ed-practice]').forEach((btn) => {
        btn.onclick = () => window.StudyApp?.navigate?.('course', { courseId: btn.dataset.edPractice });
      });
      grid.querySelectorAll('[data-ed-ai-set]').forEach((btn) => {
        btn.onclick = () => {
          const course = filtered[Number(btn.dataset.edAiSet)];
          if (!course || !window.StudySets?.openGenerator) return;
          window.StudySets.openGenerator({
            courseCode: course.code || '',
            courseTitle: course.title || '',
            school: course.school || userSchool || '',
            topics: Array.isArray(course.topics) ? course.topics : [],
          });
        };
      });
      grid.querySelectorAll('[data-ed-unpin]').forEach((btn) => {
        btn.onclick = () => {
          const targetKey = btn.dataset.edUnpin;
          const next = loadLocalEdLinks().filter((item) => `${item.edHost}:${item.edCourseId}` !== targetKey);
          saveLocalEdLinks(next);
          toast('Removed pinned Ed Discussion course.');
          paintGrid();
        };
      });
    };

    if (searchEl) {
      searchEl.oninput = () => {
        query = searchEl.value || '';
        paintGrid();
      };
    }

    if (pinForm) {
      pinForm.onsubmit = (ev) => {
        ev.preventDefault();
        const fd = new FormData(pinForm);
        const parsed = parseEdCourseInput(fd.get('url'));
        if (!parsed) {
          if (pinStatus) pinStatus.textContent = 'Enter a valid Ed Discussion course URL (e.g. https://eu.edstem.org/courses/3304).';
          return;
        }
        const code = String(fd.get('code') || '').trim().toUpperCase().slice(0, 24);
        const title = String(fd.get('title') || '').trim().slice(0, 120) || (code ? `${code} Discussion` : `Ed Discussion #${parsed.edCourseId}`);
        const existing = loadLocalEdLinks().filter((item) => `${item.edHost}:${item.edCourseId}` !== `${parsed.edHost}:${parsed.edCourseId}`);
        existing.unshift({
          edHost: parsed.edHost,
          edCourseId: parsed.edCourseId,
          code,
          title,
          school: userSchool || '',
          topics: [],
        });
        saveLocalEdLinks(existing);
        pinForm.reset();
        if (pinStatus) pinStatus.textContent = 'Pinned to your Ed Discussion hub.';
        toast('Pinned Ed Discussion course.');
        paintGrid();
      };
    }

    // Paint local pins immediately, then merge live synced community Ed courses
    paintGrid();
    remoteEdCourses = await loadApprovedCoursesCached();
    paintGrid();
  }

  function renderDashboard(root, dashboardData, offset) {
    const { me, ranks, hasMoreRanks, contacts, messages, blocked, now } = dashboardData;
    const messageRows = messages.map((row) => {
      const peerName = row.sender === me.id ? row.recipientName : row.senderName;
      const peerAvatar = row.sender === me.id ? row.recipientAvatar : row.senderAvatar;
      return `
      <li>
        <div class="row-between"><span class="community-member-inline">${avatarHtml(peerName, peerAvatar, 24)}<strong>${row.sender === me.id ? 'To ' + esc(row.recipientName) : 'From ' + esc(row.senderName)}</strong></span>
        <small>${esc(new Date(row.createdAt).toLocaleString())}</small></div>
        <p>${esc(row.message)}</p>${roomInviteChipHtml(row.message)}
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
              <p class="muted" style="margin:0">Signed in as <strong id="community-signed-in">${esc(me.nickname)}</strong>${isPublicBadgeVal(me.school) ? ` <span class="leaderboard-school-pill">${esc(me.school)}</span>` : ''}${isPublicBadgeVal(me.major) ? ` <span class="leaderboard-major-pill">${esc(me.major)}</span>` : ''}${me.isAdmin ? ' <span class="badge admin-badge">Admin</span>' : ''}</p>
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
      <div id="community-leaderboard-mount">${chessLeaderboardHtml({ rows: ranks, meId: me.id, offset, now, isDemo: false, tab: activeBoardTab, hasMoreRanks })}</div>
      ${edDiscussionSectionHtml()}
      <section class="panel">
        <div class="row-between"><h2>Global chat</h2><button type="button" class="ghost-btn" id="community-chat-refresh">Refresh</button></div>
        <p class="muted">All Community members can read these conversations during breaks or 18:00–22:30 Oslo time.</p>
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
      ${feedbackPanelHtml()}
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
    const bindLeaderboardControls = () => {
      const mount = root.querySelector('#community-leaderboard-mount');
      if (!mount) return;
      mount.querySelectorAll('[data-lb-tab]').forEach((btn) => {
        btn.onclick = () => {
          activeBoardTab = btn.dataset.lbTab || 'overall';
          mount.innerHTML = chessLeaderboardHtml({ rows: ranks, meId: me.id, offset, now, isDemo: false, tab: activeBoardTab, hasMoreRanks });
          bindLeaderboardControls();
        };
      });
      doAction(mount.querySelector('#community-stats'), () => render(offset));
      doAction(mount.querySelector('#community-ranks-prev'), () => render(offset - 50));
      doAction(mount.querySelector('#community-ranks-next'), () => render(offset + 50));
    };
    bindLeaderboardControls();
    doAction(root.querySelector('#community-copy-key'), async () => {
      await navigator.clipboard.writeText(token);
      status.textContent = 'Profile key copied. Keep it somewhere private.';
    });
    profileActions(root);
    bindProfileEditor(root, me, () => render(offset));
    bindFeedbackPanel(root);
    bindAdminPanel(root, me);
    window.StudyRooms.bindLobby(root);
    mountEdDiscussionSection(root);
    bindChatJoinButtons(root);
    doAction(root.querySelector('#community-refresh'), () => render(offset));
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
      if (canUse()) renderDemo(root);
      else renderLocked(root);
      return;
    }
    const generation = token;
    if (!canUse()) renderLocked(root, currentProfile);
    try {
      await syncStats().catch(() => {});
      if (generation !== token) return;
      const state = timerStatus();
      if (!canUse()) {
        const profile = await request('/profile');
        if (generation !== token) return;
        currentProfile = profile;
        window.StudyApp?.syncSettingsRows?.();
        if (!canUse()) renderLocked(root, profile);
        return;
      }
      await syncPresence(state);
      if (generation !== token) return;
      const result = await request('/dashboard?offset=' + offset);
      if (generation !== token) return;
      currentProfile = result.me;
      window.StudyApp?.syncSettingsRows?.();
      if (canUse()) renderDashboard(root, result, offset);
      else renderLocked(root, result.me);
    } catch (error) {
      if (generation !== token) return;
      if (error.status === 401) {
        useProfile('');
        await render(offset);
      } else if (error.status === 423) {
        renderLocked(root, currentProfile);
      } else {
        root.innerHTML = `<section class="panel"><h1>Study community</h1><p>Community is unavailable. Open the Community tab to retry.</p></section>${edDiscussionSectionHtml()}`;
        mountEdDiscussionSection(root);
      }
    }
  }
  const canShareSet = () => Boolean(api && token);
  async function shareSet(set) {
    if (!canShareSet() || !canUse()) throw new Error('Sign in to Community and share during break access (or 18:00–22:30 Oslo).');
    await syncPresence();
    if (!canUse()) throw new Error('Your break has ended.');
    if (Array.isArray(set?.questions) && set.questions.length) {
      return request('/sets', {
        title: set.title,
        courseCode: set.courseCode || '',
        questions: set.questions,
      });
    }
    return request('/sets', { title: set.title, cards: set.cards });
  }

  async function updateProfileSchool(school, canvasOrigin = '', major = undefined) {
    const cleanSchool = String(school || '').trim().slice(0, 48);
    const cleanOrigin = normalizeCanvasUrl(canvasOrigin);
    saveLocalSchool(cleanSchool, cleanOrigin);
    const body = { school: cleanSchool, canvasOrigin: cleanOrigin };
    if (major !== undefined) {
      const cleanMajor = String(major || '').trim().slice(0, 64);
      saveLocalMajor(cleanMajor);
      body.major = cleanMajor;
    }
    if (api && token) {
      try {
        const updated = await request('/profile', body);
        if (updated && typeof updated === 'object') {
          currentProfile = { ...(currentProfile || {}), ...updated };
        }
      } catch {}
    }
    window.StudyApp?.onSchoolChanged?.();
  }

  function renderSettingsSchoolMajor() {
    const mount = document.getElementById('settings-school-major-box');
    if (!mount) return;
    const localSch = readLocalSchool();
    const curSchool = currentProfile?.school || localSch.school || '';
    const curOrigin = currentProfile?.canvasOrigin || localSch.canvasOrigin || '';
    const curMajor = currentProfile?.major || readLocalMajor() || '';

    mount.innerHTML = `
      <form id="settings-school-major-form" class="settings-school-major-form">
        ${schoolFieldHtml(curSchool, curOrigin)}
        ${majorFieldHtml(curMajor)}
        <div class="settings-school-major-foot">
          <small class="muted" id="settings-school-major-status">Press any letter repeatedly on a dropdown to cycle options.</small>
          <button type="submit" class="ghost-btn settings-sm-save-btn">Save</button>
        </div>
      </form>`;
    bindSchoolPickers(mount);
    const form = mount.querySelector('#settings-school-major-form');
    const status = mount.querySelector('#settings-school-major-status');
    const persistForm = async (quiet = false) => {
      const fd = new FormData(form);
      const { school, canvasOrigin } = extractSchoolFields(fd);
      const major = extractMajorField(fd);
      await updateProfileSchool(school, canvasOrigin, major);
      if (status) {
        const summary = [
          school ? (school === PREFER_NOT_TO_SAY ? 'School hidden' : school) : '',
          major ? (major === PREFER_NOT_TO_SAY ? 'Major hidden' : major) : '',
        ].filter(Boolean).join(' · ');
        status.textContent = summary ? `Saved · ${summary}` : 'Cleared';
      }
      if (!quiet) toast('School & major updated');
    };
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      persistForm(false);
    });
    // Auto-save non-custom selections smoothly on change (custom values save on Save/blur)
    form.querySelectorAll('[data-school-select], [data-major-select]').forEach((sel) => {
      sel.addEventListener('change', () => {
        if (sel.value !== '__custom__') persistForm(true);
      });
    });
  }

  async function generateAiSet(payload) {
    if (!api || !token) throw new Error('Sign in to generate study sets with built-in Gemini 4 Hydrogen, or use the "Your Own AI" tab.');
    return request('/ai/generate-set', payload);
  }

  async function roomRequest(path = '', data) {
    if (canUse()) await syncPresence();
    return request('/rooms' + path, data);
  }

  async function aiRequest(path = '', data) {
    return request('/ai' + path, data);
  }

  return {
    enabled: Boolean(api),
    SCHOOL_CATALOG,
    MAJOR_CATALOG,
    schoolConfigFor,
    readLocalSchool,
    saveLocalSchool,
    readLocalMajor,
    saveLocalMajor,
    bindTypeaheadSelect,
    renderSettingsSchoolMajor,
    updateProfileSchool,
    generateAiSet,
    hasProfile: () => !api || Boolean(token),
    isSignedIn: () => Boolean(api && token),
    isAdmin: () => Boolean(currentProfile?.isAdmin),
    getCurrentProfile: () => currentProfile,
    avatarHtml,
    render,
    queueStatsSync,
    clockTick,
    canShareSet,
    shareSet,
    requireProfile,
    roomRequest,
    aiRequest,
    openSecuritySheet,
    createLinkCode: () => request('/auth/link-code', {}),
    signOut,
    fetchCloudBackup,
    pushCloudBackup,
    fetchTimeEdit,
    fetchExtensionTimeEdit,
    approvedCourses,
    proposeCourses,
    openFeedbackDialog,
    listMaterials,
    uploadMaterial,
    deleteMaterial,
    openMaterial,
    postChatMessage: (message) => request('/chat', { message: String(message || '').trim() }),
    saveAdminMemberKey: (memberKey) => request('/admin/settings', { memberKey: String(memberKey || '').trim() }),
    redeemAccessCode,
  };
})();
