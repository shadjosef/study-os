// Private E2E-Encrypted Evening Debrief & Voice Journal (Admin-only preview)
// - Encrypts every entry client-side with PBKDF2-SHA256 (250k iter) + AES-256-GCM before syncing to D1.
// - 1-click Voice Note via MediaRecorder -> Cloudflare Workers AI Whisper Large v3 Turbo (audio discarded in RAM).
// - Optional local IndexedDB audio archive for offline replay or future LLM re-transcription.
window.StudyJournal = (() => {
  'use strict';

  const LOCAL_ENC_KEY = 'study-os-journal-enc-v1';
  const SESSION_PASS_KEY = 'study-os-journal-pass-session-v1';
  const DEVICE_PASS_KEY = 'study-os-journal-pass-device-v1';
  const LANG_PREF_KEY = 'study-os-journal-lang-v1';
  const KEEP_AUDIO_KEY = 'study-os-journal-keep-audio-v1';
  const AUDIO_DB_NAME = 'study-os-journal-audio-v1';
  const AUDIO_STORE = 'clips';
  const KDF_ITERATIONS = 250_000;
  const MAX_RECORD_SEC = 210; // 3m30s per clip (~840 KB @ 32kbps Opus)

  const MOODS = [
    { id: 'locked_in', label: 'Locked in' },
    { id: 'solid', label: 'Solid' },
    { id: 'drifted', label: 'Drifted' },
    { id: 'burned_out', label: 'Burned out' },
  ];

  const LEAK_TAGS = [
    'Phone / scroll',
    'Heavy meal crash',
    'Stuck on hard task',
    'Late start',
    'AI crutch',
    'Low sleep',
    'Distracted env',
  ];

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let passphrase = '';
  let entriesByDate = new Map(); // date -> decrypted object
  let rawEncryptedMap = new Map(); // date -> { payloadEnc, updatedAt }
  let activeDate = '';
  let saveTimer = null;
  let dirty = false;
  let syncStatus = '';

  // Voice recording state
  let mediaRecorder = null;
  let mediaStream = null;
  let audioCtx = null;
  let analyserNode = null;
  let levelRaf = null;
  let recordChunks = [];
  let recordStartedMs = 0;
  let recordTick = null;
  let isRecording = false;
  let isTranscribing = false;
  let currentClips = []; // local IndexedDB audio clips for activeDate
  let activeClipObjectUrls = [];

  const esc = (s) => window.StudyUI?.escapeHtml ? window.StudyUI.escapeHtml(s) : String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toast = (m) => window.StudyUI?.toast?.(m);

  function todayOsloKey() {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date());
      const y = parts.find((p) => p.type === 'year')?.value;
      const m = parts.find((p) => p.type === 'month')?.value;
      const d = parts.find((p) => p.type === 'day')?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch {}
    return new Date().toISOString().slice(0, 10);
  }

  function formatDateHuman(dateKey) {
    try {
      const [y, m, d] = String(dateKey || '').split('-').map(Number);
      if (!y || !m || !d) return dateKey;
      const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
      return new Intl.DateTimeFormat('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
      }).format(dt);
    } catch {
      return dateKey;
    }
  }

  function formatClock(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function isAvailable() {
    if (window.StudyCommunity?.isAdmin?.()) return true;
    return document.documentElement.dataset.studyMode === 'local';
  }

  // ---------------------------------------------------------------------------
  // WEB CRYPTO API: PBKDF2-SHA256 (250k) + AES-256-GCM
  // ---------------------------------------------------------------------------
  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const norm = String(b64 || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(norm);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveAesKey(pass, saltBytes, iterations = KDF_ITERATIONS) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(pass),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptEntryObject(obj, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(pass, salt, KDF_ITERATIONS);
    const pt = enc.encode(JSON.stringify(obj));
    const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
    return JSON.stringify({
      v: 1,
      alg: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iter: KDF_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(ctBuf)),
    });
  }

  async function decryptEntryEnvelope(payloadEncStr, pass) {
    const env = JSON.parse(payloadEncStr);
    if (!env || env.v !== 1 || env.alg !== 'AES-256-GCM') {
      throw new Error('Unsupported encryption format');
    }
    const salt = base64ToBytes(env.salt);
    const iv = base64ToBytes(env.iv);
    const ct = base64ToBytes(env.ct);
    const key = await deriveAesKey(pass, salt, Number(env.iter) || KDF_ITERATIONS);
    const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(dec.decode(ptBuf));
  }

  // ---------------------------------------------------------------------------
  // LOCAL ENCRYPTED MIRROR + CLOUD D1 SYNC
  // ---------------------------------------------------------------------------
  function readLocalEncryptedMap() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LOCAL_ENC_KEY) || '{}');
      const m = new Map();
      if (parsed && typeof parsed === 'object') {
        for (const [date, row] of Object.entries(parsed)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date) && row?.payloadEnc) {
            m.set(date, { payloadEnc: String(row.payloadEnc), updatedAt: Number(row.updatedAt || 0) });
          }
        }
      }
      return m;
    } catch {
      return new Map();
    }
  }

  function writeLocalEncryptedMap(map) {
    const obj = {};
    for (const [date, row] of map.entries()) {
      obj[date] = { payloadEnc: row.payloadEnc, updatedAt: row.updatedAt };
    }
    try { localStorage.setItem(LOCAL_ENC_KEY, JSON.stringify(obj)); } catch {}
  }

  function loadStoredPassphrase() {
    try {
      return sessionStorage.getItem(SESSION_PASS_KEY) || localStorage.getItem(DEVICE_PASS_KEY) || '';
    } catch {
      return '';
    }
  }

  function storePassphrase(pass, rememberOnDevice) {
    passphrase = pass;
    try {
      sessionStorage.setItem(SESSION_PASS_KEY, pass);
      if (rememberOnDevice) localStorage.setItem(DEVICE_PASS_KEY, pass);
      else localStorage.removeItem(DEVICE_PASS_KEY);
    } catch {}
  }

  function clearStoredPassphrase() {
    passphrase = '';
    entriesByDate.clear();
    try {
      sessionStorage.removeItem(SESSION_PASS_KEY);
      localStorage.removeItem(DEVICE_PASS_KEY);
    } catch {}
  }

  function getPreferredLang() {
    try { return localStorage.getItem(LANG_PREF_KEY) || 'en'; } catch { return 'en'; }
  }
  function setPreferredLang(v) {
    try { localStorage.setItem(LANG_PREF_KEY, v); } catch {}
  }
  function getKeepAudioLocal() {
    try { return localStorage.getItem(KEEP_AUDIO_KEY) === '1'; } catch { return false; }
  }
  function setKeepAudioLocal(on) {
    try { localStorage.setItem(KEEP_AUDIO_KEY, on ? '1' : '0'); } catch {}
  }

  async function pullEncryptedFromCloud() {
    const localMap = readLocalEncryptedMap();
    rawEncryptedMap = new Map(localMap);
    if (!window.StudyCommunity?.isAdmin?.() || !window.StudyCommunity?.journalRequest) {
      return rawEncryptedMap;
    }
    try {
      const res = await window.StudyCommunity.journalRequest('');
      if (res?.ok && Array.isArray(res.entries)) {
        for (const item of res.entries) {
          const prev = rawEncryptedMap.get(item.date);
          if (!prev || Number(item.updatedAt || 0) >= Number(prev.updatedAt || 0)) {
            rawEncryptedMap.set(item.date, {
              payloadEnc: String(item.payloadEnc || ''),
              updatedAt: Number(item.updatedAt || 0),
            });
          }
        }
        writeLocalEncryptedMap(rawEncryptedMap);
      }
    } catch {
      // Offline or local-only fallback cleanly preserves local encrypted entries
    }
    return rawEncryptedMap;
  }

  async function pushEncryptedToCloud(date, payloadEnc, updatedAt) {
    rawEncryptedMap.set(date, { payloadEnc, updatedAt });
    writeLocalEncryptedMap(rawEncryptedMap);
    if (!window.StudyCommunity?.isAdmin?.() || !window.StudyCommunity?.journalRequest) {
      syncStatus = 'Encrypted locally (AES-256-GCM)';
      return true;
    }
    try {
      await window.StudyCommunity.journalRequest('', { date, payloadEnc });
      syncStatus = 'Encrypted & synced · AES-256-GCM';
      return true;
    } catch {
      syncStatus = 'Encrypted locally (offline — will sync next save)';
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // PRIVATE INDEXEDDB AUDIO CLIP VAULT (Optional / Offline Fallback)
  // ---------------------------------------------------------------------------
  function openAudioDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('No IndexedDB'));
      const req = indexedDB.open(AUDIO_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(AUDIO_STORE)) {
          const store = db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
          store.createIndex('by_date', 'date', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB failed'));
    });
  }

  async function saveAudioClipLocally(date, blob, durationSec) {
    try {
      const db = await openAudioDb();
      const clip = {
        id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        date,
        mimeType: blob.type || 'audio/webm',
        durationSec: Math.max(1, Math.round(durationSec || 1)),
        createdAt: Date.now(),
        blob,
      };
      await new Promise((resolve, reject) => {
        const tx = db.transaction(AUDIO_STORE, 'readwrite');
        tx.objectStore(AUDIO_STORE).put(clip);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return clip;
    } catch {
      return null;
    }
  }

  async function listAudioClipsForDate(date) {
    try {
      const db = await openAudioDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(AUDIO_STORE, 'readonly');
        const idx = tx.objectStore(AUDIO_STORE).index('by_date');
        const req = idx.getAll(date);
        req.onsuccess = () => resolve((req.result || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
        req.onerror = () => resolve([]);
      });
    } catch {
      return [];
    }
  }

  async function deleteAudioClip(clipId) {
    try {
      const db = await openAudioDb();
      await new Promise((resolve) => {
        const tx = db.transaction(AUDIO_STORE, 'readwrite');
        tx.objectStore(AUDIO_STORE).delete(clipId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {}
  }

  function revokeClipUrls() {
    for (const u of activeClipObjectUrls) {
      try { URL.revokeObjectURL(u); } catch {}
    }
    activeClipObjectUrls = [];
  }

  // ---------------------------------------------------------------------------
  // ENTRY STATE & SNAPSHOT
  // ---------------------------------------------------------------------------
  function defaultEntryFor(date) {
    const isToday = date === todayOsloKey();
    const snap = isToday ? (window.StudyApp?.getTodayJournalSnapshot?.() || null) : null;
    return {
      date,
      text: '',
      mood: '',
      leaks: [],
      tomorrowFix: '',
      daySnapshot: snap,
      updatedAt: Date.now(),
    };
  }

  function getActiveEntry() {
    if (!activeDate) activeDate = todayOsloKey();
    let entry = entriesByDate.get(activeDate);
    if (!entry) {
      entry = defaultEntryFor(activeDate);
      entriesByDate.set(activeDate, entry);
    } else if (activeDate === todayOsloKey()) {
      const freshSnap = window.StudyApp?.getTodayJournalSnapshot?.() || null;
      if (freshSnap) entry.daySnapshot = freshSnap;
    }
    return entry;
  }

  async function saveActiveEntryNow() {
    if (!passphrase || !activeDate) return false;
    clearTimeout(saveTimer);
    saveTimer = null;
    const entry = getActiveEntry();
    entry.updatedAt = Date.now();
    if (activeDate === todayOsloKey()) {
      const freshSnap = window.StudyApp?.getTodayJournalSnapshot?.() || null;
      if (freshSnap) entry.daySnapshot = freshSnap;
    }
    const payloadEnc = await encryptEntryObject(entry, passphrase);
    const ok = await pushEncryptedToCloud(activeDate, payloadEnc, entry.updatedAt);
    dirty = false;
    updateStatusBadge();
    renderTimelineList();
    return ok;
  }

  function scheduleAutoSave() {
    dirty = true;
    syncStatus = 'Saving encrypted…';
    updateStatusBadge();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveActiveEntryNow().catch(() => {});
    }, 900);
  }

  function updateStatusBadge() {
    const el = document.getElementById('journal-sync-status');
    if (el) el.textContent = syncStatus || 'AES-256-GCM E2E';
  }

  // ---------------------------------------------------------------------------
  // VOICE RECORDING & WHISPER TRANSCRIPTION
  // ---------------------------------------------------------------------------
  function pickAudioMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    if (typeof MediaRecorder !== 'function' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || '';
  }

  function cleanupAudioCapture() {
    isRecording = false;
    clearInterval(recordTick);
    recordTick = null;
    if (levelRaf) {
      cancelAnimationFrame(levelRaf);
      levelRaf = null;
    }
    try { audioCtx?.close?.(); } catch {}
    audioCtx = null;
    analyserNode = null;
    if (mediaStream) {
      for (const tr of mediaStream.getTracks()) {
        try { tr.stop(); } catch {}
      }
      mediaStream = null;
    }
    mediaRecorder = null;
  }

  async function blobToBase64(blob) {
    const buf = await blob.arrayBuffer();
    return bytesToBase64(new Uint8Array(buf));
  }

  async function transcribeBlob(blob) {
    if (!window.StudyCommunity?.isAdmin?.() || !window.StudyCommunity?.journalRequest) {
      throw new Error('Sign in with your admin Study-OS account to use cloud voice transcription.');
    }
    const audioBase64 = await blobToBase64(blob);
    const lang = getPreferredLang();
    const mimeType = String(blob.type || 'audio/webm').split(';')[0].trim().toLowerCase() || 'audio/webm';
    const res = await window.StudyCommunity.journalRequest('/transcribe', {
      audioBase64,
      mimeType,
      language: lang === 'auto' ? '' : lang,
    });
    if (!res?.ok) throw new Error(res?.error || 'Transcription failed.');
    return { text: String(res.text || '').trim(), model: String(res.model || '') };
  }

  async function startVoiceRecording() {
    if (isRecording || isTranscribing) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function') {
      toast('Voice recording is not supported in this browser.');
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch {
      toast('Microphone permission was denied — check browser mic settings.');
      return;
    }

    recordChunks = [];
    const mimeType = pickAudioMimeType();
    const opts = { audioBitsPerSecond: 32_000 };
    if (mimeType) opts.mimeType = mimeType;

    try {
      mediaRecorder = new MediaRecorder(mediaStream, opts);
    } catch {
      mediaRecorder = new MediaRecorder(mediaStream);
    }

    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recordChunks.push(ev.data);
    };

    isRecording = true;
    recordStartedMs = Date.now();

    // Live gentle mic level meter
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        audioCtx = new AC();
        const src = audioCtx.createMediaStreamSource(mediaStream);
        analyserNode = audioCtx.createAnalyser();
        analyserNode.fftSize = 256;
        src.connect(analyserNode);
        const samples = new Uint8Array(analyserNode.frequencyBinCount);
        const paintLevel = () => {
          if (!isRecording || !analyserNode) return;
          analyserNode.getByteTimeDomainData(samples);
          let sumSq = 0;
          for (let i = 0; i < samples.length; i++) {
            const v = (samples[i] - 128) / 128;
            sumSq += v * v;
          }
          const rms = Math.min(1, Math.sqrt(sumSq / samples.length) * 3.4);
          const bar = document.getElementById('journal-mic-level');
          if (bar) bar.style.width = `${Math.max(8, Math.round(rms * 100))}%`;
          levelRaf = requestAnimationFrame(paintLevel);
        };
        levelRaf = requestAnimationFrame(paintLevel);
      }
    } catch {}

    mediaRecorder.start(500);
    renderVoiceControls();

    recordTick = setInterval(() => {
      const sec = Math.floor((Date.now() - recordStartedMs) / 1000);
      const tEl = document.getElementById('journal-rec-timer');
      if (tEl) tEl.textContent = formatClock(sec);
      if (sec >= MAX_RECORD_SEC) {
        stopVoiceRecording({ cancel: false });
      }
    }, 300);
  }

  async function stopVoiceRecording({ cancel = false } = {}) {
    if (!isRecording || !mediaRecorder) return;
    const rec = mediaRecorder;
    const elapsedSec = Math.max(1, Math.round((Date.now() - recordStartedMs) / 1000));
    const targetDate = activeDate;

    const blobPromise = new Promise((resolve) => {
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm';
        resolve(new Blob(recordChunks, { type }));
      };
    });

    try { rec.stop(); } catch {}
    cleanupAudioCapture();

    if (cancel) {
      recordChunks = [];
      renderVoiceControls();
      toast('Recording cancelled.');
      return;
    }

    const blob = await blobPromise;
    recordChunks = [];
    if (!blob || blob.size < 200) {
      renderVoiceControls();
      toast('Recording was too short.');
      return;
    }

    let savedClip = null;
    if (getKeepAudioLocal()) {
      savedClip = await saveAudioClipLocally(targetDate, blob, elapsedSec);
      if (savedClip) {
        currentClips = await listAudioClipsForDate(targetDate);
      }
    }

    isTranscribing = true;
    renderVoiceControls();
    try {
      const tr = await transcribeBlob(blob);
      const transcript = tr?.text || '';
      if (transcript) {
        const entry = getActiveEntry();
        entry.text = entry.text.trim() ? `${entry.text.trim()}\n\n${transcript}` : transcript;
        const ta = document.getElementById('journal-text-area');
        if (ta) ta.value = entry.text;
        await saveActiveEntryNow();
        const via = tr?.model ? ` · ${tr.model}` : '';
        toast(`Transcribed (${formatClock(elapsedSec)}${via}) & encrypted.`);
      } else {
        toast('No speech detected in clip.');
      }
    } catch (err) {
      // Automatically keep audio locally if transcription failed so the user NEVER loses their voice note!
      if (!savedClip) {
        await saveAudioClipLocally(targetDate, blob, elapsedSec);
        currentClips = await listAudioClipsForDate(targetDate);
      }
      toast(`${err?.message || 'Transcription failed'} — audio saved locally below.`);
    } finally {
      isTranscribing = false;
      renderVoiceControls();
      renderLocalClips();
    }
  }

  // ---------------------------------------------------------------------------
  // EXPORT (DECRYPTED LOCALLY IN BROWSER)
  // ---------------------------------------------------------------------------
  function exportJournal(format = 'md') {
    const sorted = [...entriesByDate.values()]
      .filter((e) => (e.text || '').trim() || (e.tomorrowFix || '').trim() || (e.leaks || []).length || e.mood)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (!sorted.length) {
      toast('No journal entries to export yet.');
      return;
    }
    let content = '';
    let mime = 'text/markdown;charset=utf-8';
    let ext = 'md';
    if (format === 'json') {
      content = JSON.stringify({ exportedAt: new Date().toISOString(), entries: sorted }, null, 2);
      mime = 'application/json;charset=utf-8';
      ext = 'json';
    } else {
      content = sorted.map((e) => {
        const s = e.daySnapshot;
        const snapLine = s
          ? `> Study-OS: ${s.activeMin}m active · ${s.screenMin}m screen${s.efficiencyPct != null ? ` (${s.efficiencyPct}% eff)` : ''} · ${s.attemptsCount} attempts (${s.aiAssistedCount} AI-assisted) · ${s.breaksCount} breaks`
          : '';
        const meta = [
          e.mood ? `Mood: **${MOODS.find((m) => m.id === e.mood)?.label || e.mood}**` : '',
          e.leaks?.length ? `Drift/Leaks: ${e.leaks.join(', ')}` : '',
        ].filter(Boolean).join(' · ');
        return [
          `# ${e.date} (${formatDateHuman(e.date)})`,
          snapLine,
          meta,
          '',
          (e.text || '').trim(),
          e.tomorrowFix?.trim() ? `\n**Tomorrow's 1 fix:** ${e.tomorrowFix.trim()}` : '',
        ].filter((x) => x !== '').join('\n');
      }).join('\n\n---\n\n');
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `study-os-evening-journal-${todayOsloKey()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
    toast(`Exported ${sorted.length} decrypted entr${sorted.length === 1 ? 'y' : 'ies'} (.${ext})`);
  }

  // ---------------------------------------------------------------------------
  // UI RENDERING
  // ---------------------------------------------------------------------------
  function renderVoiceControls() {
    const box = document.getElementById('journal-voice-bar');
    if (!box) return;
    const lang = getPreferredLang();
    const keepAudio = getKeepAudioLocal();
    if (isRecording) {
      const sec = Math.floor((Date.now() - recordStartedMs) / 1000);
      box.innerHTML = `
        <div class="j-voice-live">
          <span class="j-rec-dot" aria-hidden="true"></span>
          <strong>Recording</strong>
          <span id="journal-rec-timer" class="j-rec-timer">${formatClock(sec)}</span>
          <div class="j-mic-track"><div id="journal-mic-level" class="j-mic-level"></div></div>
          <div class="row-actions" style="gap:6px">
            <button type="button" class="primary-btn" id="j-btn-stop-rec">Stop &amp; Transcribe</button>
            <button type="button" class="ghost-btn" id="j-btn-cancel-rec">Cancel</button>
          </div>
        </div>
      `;
      document.getElementById('j-btn-stop-rec')?.addEventListener('click', () => stopVoiceRecording({ cancel: false }));
      document.getElementById('j-btn-cancel-rec')?.addEventListener('click', () => stopVoiceRecording({ cancel: true }));
      return;
    }
    if (isTranscribing) {
      box.innerHTML = `
        <div class="j-voice-live">
          <strong>Transcribing voice note…</strong>
          <span class="muted" style="font-size:12px">Processed in memory (Gemini Audio / Whisper) · never stored on server</span>
        </div>
      `;
      return;
    }
    box.innerHTML = `
      <div class="j-voice-idle">
        <button type="button" class="primary-btn j-rec-start-btn" id="j-btn-start-rec">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
          <span>Record Voice Note</span>
        </button>
        <div class="j-voice-opts">
          <div class="j-lang-seg" role="group" aria-label="Voice transcription language">
            <button type="button" class="j-lang-btn ${lang === 'en' ? 'is-active' : ''}" data-j-lang="en">EN</button>
            <button type="button" class="j-lang-btn ${lang === 'auto' ? 'is-active' : ''}" data-j-lang="auto">Auto</button>
            <button type="button" class="j-lang-btn ${lang === 'no' ? 'is-active' : ''}" data-j-lang="no">NO</button>
          </div>
          <label class="j-keep-audio-lbl" title="Also save raw audio privately in this browser so you can replay or re-transcribe with future models">
            <input type="checkbox" id="j-chk-keep-audio" ${keepAudio ? 'checked' : ''}>
            <span>Keep audio locally</span>
          </label>
        </div>
      </div>
    `;
    document.getElementById('j-btn-start-rec')?.addEventListener('click', startVoiceRecording);
    box.querySelectorAll('[data-j-lang]').forEach((b) => {
      b.addEventListener('click', () => {
        setPreferredLang(b.dataset.jLang || 'en');
        renderVoiceControls();
      });
    });
    document.getElementById('j-chk-keep-audio')?.addEventListener('change', (ev) => {
      setKeepAudioLocal(Boolean(ev.target.checked));
    });
  }

  function renderLocalClips() {
    const wrap = document.getElementById('journal-clips-list');
    if (!wrap) return;
    revokeClipUrls();
    if (!currentClips.length) {
      wrap.hidden = true;
      wrap.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    wrap.innerHTML = `
      <div class="j-clips-head">Saved local audio clips (${currentClips.length} · stays on this device only)</div>
      ${currentClips.map((c) => {
        const url = URL.createObjectURL(c.blob);
        activeClipObjectUrls.push(url);
        return `<div class="j-clip-row">
          <audio controls preload="none" src="${url}"></audio>
          <span class="muted" style="font-size:11.5px">${formatClock(c.durationSec)}</span>
          <button type="button" class="mini-tool-btn" data-j-retranscribe="${esc(c.id)}">Transcribe</button>
          <button type="button" class="mini-tool-btn" data-j-del-clip="${esc(c.id)}" title="Delete local audio">×</button>
        </div>`;
      }).join('')}
    `;
    wrap.querySelectorAll('[data-j-retranscribe]').forEach((b) => {
      b.addEventListener('click', async () => {
        const clip = currentClips.find((x) => x.id === b.dataset.jRetranscribe);
        if (!clip || isTranscribing) return;
        isTranscribing = true;
        renderVoiceControls();
        try {
          const tr = await transcribeBlob(clip.blob);
          const text = tr?.text || '';
          if (text) {
            const entry = getActiveEntry();
            entry.text = entry.text.trim() ? `${entry.text.trim()}\n\n${text}` : text;
            const ta = document.getElementById('journal-text-area');
            if (ta) ta.value = entry.text;
            await saveActiveEntryNow();
            toast('Transcribed saved clip & encrypted.');
          }
        } catch (err) {
          toast(err?.message || 'Transcription failed.');
        } finally {
          isTranscribing = false;
          renderVoiceControls();
        }
      });
    });
    wrap.querySelectorAll('[data-j-del-clip]').forEach((b) => {
      b.addEventListener('click', async () => {
        await deleteAudioClip(b.dataset.jDelClip);
        currentClips = await listAudioClipsForDate(activeDate);
        renderLocalClips();
      });
    });
  }

  function renderTimelineList() {
    const listEl = document.getElementById('journal-timeline-list');
    if (!listEl) return;
    const today = todayOsloKey();
    const dates = new Set([today, ...entriesByDate.keys()]);
    const ordered = [...dates].sort((a, b) => b.localeCompare(a));
    listEl.innerHTML = ordered.map((d) => {
      const e = entriesByDate.get(d);
      const words = (e?.text || '').trim() ? (e.text.trim().split(/\s+/).length) : 0;
      const moodLabel = MOODS.find((m) => m.id === e?.mood)?.label || '';
      const active = d === activeDate;
      return `<button type="button" class="j-day-item ${active ? 'is-active' : ''}" data-j-date="${esc(d)}">
        <div class="j-day-top">
          <strong>${d === today ? 'Today' : esc(formatDateHuman(d))}</strong>
          <small class="muted">${esc(d.slice(5))}</small>
        </div>
        <div class="j-day-sub">
          ${moodLabel ? `<span class="j-mood-dot is-${esc(e.mood)}"></span><span>${esc(moodLabel)}</span>` : '<span class="muted">No mood</span>'}
          <span class="muted">· ${words}w</span>
        </div>
      </button>`;
    }).join('');
    listEl.querySelectorAll('[data-j-date]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (dirty) await saveActiveEntryNow().catch(() => {});
        activeDate = btn.dataset.jDate || todayOsloKey();
        currentClips = await listAudioClipsForDate(activeDate);
        renderUnlockedBody();
      });
    });
  }

  function renderUnlockedBody() {
    const dlg = document.getElementById('journal-dialog');
    if (!dlg) return;
    const entry = getActiveEntry();
    const s = entry.daySnapshot;
    const snapHtml = s ? `
      <div class="j-day-receipt">
        <div class="j-receipt-stat"><strong>${s.activeMin}m</strong><span>Active</span></div>
        <div class="j-receipt-stat"><strong>${s.screenMin}m</strong><span>Screen${s.efficiencyPct != null ? ` · ${s.efficiencyPct}%` : ''}</span></div>
        <div class="j-receipt-stat"><strong>${s.attemptsCount}</strong><span>Attempts${s.aiAssistedCount ? ` · ${s.aiAssistedCount} AI` : ''}</span></div>
        <div class="j-receipt-stat"><strong>${s.breaksCount}</strong><span>Breaks</span></div>
      </div>
    ` : '<div class="j-day-receipt muted" style="font-size:12px">No Study-OS snapshot saved for this day.</div>';

    dlg.innerHTML = `
      <div class="j-shell">
        <header class="j-head">
          <div>
            <span class="j-eyebrow">PRIVATE · E2E ENCRYPTED</span>
            <h2 id="journal-title">Evening Debrief</h2>
          </div>
          <div class="row-actions" style="gap:6px">
            <span id="journal-sync-status" class="j-sync-pill">${esc(syncStatus || 'AES-256-GCM E2E')}</span>
            <button type="button" class="ghost-btn" id="j-export-md" title="Decrypt locally & download Markdown">Export .md</button>
            <button type="button" class="ghost-btn" id="j-export-json" title="Decrypt locally & download JSON + day metrics">JSON</button>
            <button type="button" class="ghost-btn" id="j-lock-btn" title="Lock & clear passphrase from this browser">Lock</button>
            <button type="button" class="ghost-btn" id="j-close-btn" aria-label="Close">✕</button>
          </div>
        </header>
        <div class="j-body">
          <aside class="j-sidebar">
            <div class="j-side-head">
              <span>TIMELINE</span>
              <button type="button" class="mini-tool-btn" id="j-today-btn">Today</button>
            </div>
            <div id="journal-timeline-list" class="j-timeline-list"></div>
          </aside>
          <section class="j-editor-pane">
            <div class="j-date-row">
              <h3>${activeDate === todayOsloKey() ? `Today · ${esc(formatDateHuman(activeDate))}` : esc(formatDateHuman(activeDate))}</h3>
              <span class="muted" style="font-size:12px">${esc(activeDate)}</span>
            </div>
            ${snapHtml}
            <div id="journal-voice-bar" class="j-voice-bar"></div>
            <div id="journal-clips-list" class="j-clips-list" hidden></div>

            <textarea id="journal-text-area" class="j-textarea" rows="8" placeholder="Hit Record and talk away, or type — what got done today, where you drifted/wasted time, what confused you, pros & cons…">${esc(entry.text || '')}</textarea>

            <div class="j-meta-row">
              <div class="j-pill-group">
                <small class="muted">DAY FEEL</small>
                <div class="j-pills">
                  ${MOODS.map((m) => `<button type="button" class="j-chip ${entry.mood === m.id ? 'is-active' : ''}" data-j-mood="${m.id}">${esc(m.label)}</button>`).join('')}
                </div>
              </div>
              <div class="j-pill-group">
                <small class="muted">TIME LEAKS / DRIFT</small>
                <div class="j-pills">
                  ${LEAK_TAGS.map((tag) => `<button type="button" class="j-chip ${(entry.leaks || []).includes(tag) ? 'is-active' : ''}" data-j-leak="${esc(tag)}">${esc(tag)}</button>`).join('')}
                </div>
              </div>
            </div>

            <div class="j-fix-row">
              <label for="journal-tomorrow-fix" class="muted" style="font-size:11.5px;font-weight:700">TOMORROW'S 1 FIX (OPTIONAL)</label>
              <input type="text" id="journal-tomorrow-fix" class="j-fix-input" maxlength="240" value="${esc(entry.tomorrowFix || '')}" placeholder="e.g. Phone in another room before 10:00 · redo Blue Sky closed-book">
            </div>

            <div class="row-between" style="margin-top:10px">
              <span class="muted" style="font-size:11.5px">Encrypted with AES-256-GCM before syncing to your Study-OS account.</span>
              <button type="button" class="primary-btn" id="j-save-now-btn">Save Encrypted</button>
            </div>
          </section>
        </div>
      </div>
    `;

    renderTimelineList();
    renderVoiceControls();
    renderLocalClips();

    document.getElementById('j-close-btn')?.addEventListener('click', () => close());
    document.getElementById('j-today-btn')?.addEventListener('click', async () => {
      if (dirty) await saveActiveEntryNow().catch(() => {});
      activeDate = todayOsloKey();
      currentClips = await listAudioClipsForDate(activeDate);
      renderUnlockedBody();
    });
    document.getElementById('j-export-md')?.addEventListener('click', () => exportJournal('md'));
    document.getElementById('j-export-json')?.addEventListener('click', () => exportJournal('json'));
    document.getElementById('j-lock-btn')?.addEventListener('click', async () => {
      if (dirty) await saveActiveEntryNow().catch(() => {});
      cleanupAudioCapture();
      clearStoredPassphrase();
      renderUnlockGate('');
      toast('Journal locked.');
    });
    document.getElementById('j-save-now-btn')?.addEventListener('click', async () => {
      await saveActiveEntryNow();
      toast('Saved & encrypted.');
    });

    const ta = document.getElementById('journal-text-area');
    ta?.addEventListener('input', () => {
      const e = getActiveEntry();
      e.text = ta.value;
      scheduleAutoSave();
    });
    const fixIn = document.getElementById('journal-tomorrow-fix');
    fixIn?.addEventListener('input', () => {
      const e = getActiveEntry();
      e.tomorrowFix = fixIn.value;
      scheduleAutoSave();
    });
    dlg.querySelectorAll('[data-j-mood]').forEach((b) => {
      b.addEventListener('click', () => {
        const e = getActiveEntry();
        e.mood = e.mood === b.dataset.jMood ? '' : b.dataset.jMood;
        dlg.querySelectorAll('[data-j-mood]').forEach((x) => x.classList.toggle('is-active', x.dataset.jMood === e.mood));
        scheduleAutoSave();
      });
    });
    dlg.querySelectorAll('[data-j-leak]').forEach((b) => {
      b.addEventListener('click', () => {
        const e = getActiveEntry();
        const tag = b.dataset.jLeak;
        const set = new Set(Array.isArray(e.leaks) ? e.leaks : []);
        if (set.has(tag)) set.delete(tag);
        else set.add(tag);
        e.leaks = [...set];
        b.classList.toggle('is-active', set.has(tag));
        scheduleAutoSave();
      });
    });
  }

  function renderUnlockGate(errMsg = '') {
    const dlg = document.getElementById('journal-dialog');
    if (!dlg) return;
    const hasExisting = rawEncryptedMap.size > 0;
    dlg.innerHTML = `
      <div class="j-shell j-gate-shell">
        <header class="j-head">
          <div>
            <span class="j-eyebrow">PRIVATE · E2E ENCRYPTED VAULT</span>
            <h2 id="journal-title">${hasExisting ? 'Unlock Evening Debrief' : 'Set Up Your Encrypted Journal'}</h2>
          </div>
          <button type="button" class="ghost-btn" id="j-close-btn" aria-label="Close">✕</button>
        </header>
        <form id="j-unlock-form" class="j-gate-form">
          <p class="muted" style="margin:0 0 12px;font-size:13px;line-height:1.45">
            ${hasExisting
              ? `Found <strong>${rawEncryptedMap.size}</strong> encrypted day${rawEncryptedMap.size === 1 ? '' : 's'} on your account. Enter your journal passphrase to decrypt them in this browser.`
              : 'Choose a passphrase to encrypt your evening notes with <strong>AES-256-GCM</strong> before syncing to your Study-OS account. Your passphrase never leaves your browser.'}
          </p>
          <input type="password" id="j-pass-input" class="j-fix-input" minlength="6" required autocomplete="current-password" placeholder="${hasExisting ? 'Enter your journal passphrase…' : 'Create passphrase (min 6 chars)…'}">
          <label class="j-keep-audio-lbl" style="margin-top:10px">
            <input type="checkbox" id="j-remember-device" checked>
            <span>Keep unlocked on this browser (passphrase stays local; cloud remains encrypted)</span>
          </label>
          ${errMsg ? `<p class="j-err-msg">${esc(errMsg)}</p>` : ''}
          <div class="row-between" style="margin-top:14px">
            <span class="muted" style="font-size:11.5px">PBKDF2-SHA256 (250k) · AES-256-GCM</span>
            <button type="submit" class="primary-btn">${hasExisting ? 'Unlock Journal' : 'Create Encrypted Vault'}</button>
          </div>
        </form>
      </div>
    `;
    document.getElementById('j-close-btn')?.addEventListener('click', () => close());
    const form = document.getElementById('j-unlock-form');
    const inp = document.getElementById('j-pass-input');
    setTimeout(() => inp?.focus?.(), 20);
    form?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const candidate = String(inp?.value || '');
      if (candidate.length < 6) {
        renderUnlockGate('Use at least 6 characters.');
        return;
      }
      const remember = Boolean(document.getElementById('j-remember-device')?.checked);
      const ok = await tryUnlockWithPassphrase(candidate, remember);
      if (!ok) {
        renderUnlockGate('Incorrect passphrase — could not decrypt existing entries.');
      }
    });
  }

  async function tryUnlockWithPassphrase(candidate, rememberOnDevice) {
    const decrypted = new Map();
    for (const [date, row] of rawEncryptedMap.entries()) {
      try {
        const obj = await decryptEntryEnvelope(row.payloadEnc, candidate);
        decrypted.set(date, obj);
      } catch {
        return false;
      }
    }
    storePassphrase(candidate, rememberOnDevice);
    entriesByDate = decrypted;
    activeDate = todayOsloKey();
    currentClips = await listAudioClipsForDate(activeDate);
    syncStatus = rawEncryptedMap.size ? 'Decrypted · AES-256-GCM' : 'AES-256-GCM E2E ready';
    renderUnlockedBody();
    return true;
  }

  async function open() {
    if (!isAvailable()) {
      toast('Evening Debrief is currently private (Admin preview only).');
      return;
    }
    const dlg = document.getElementById('journal-dialog');
    if (!dlg) return;
    if (!dlg.open) dlg.showModal();
    dlg.innerHTML = '<div class="j-shell j-gate-shell"><p class="muted" style="padding:20px">Loading encrypted vault…</p></div>';
    await pullEncryptedFromCloud();
    const cached = passphrase || loadStoredPassphrase();
    if (cached) {
      const remembered = Boolean(localStorage.getItem(DEVICE_PASS_KEY));
      const ok = await tryUnlockWithPassphrase(cached, remembered);
      if (ok) return;
      clearStoredPassphrase();
    }
    renderUnlockGate('');
  }

  function close() {
    if (dirty && passphrase) saveActiveEntryNow().catch(() => {});
    cleanupAudioCapture();
    revokeClipUrls();
    const dlg = document.getElementById('journal-dialog');
    if (dlg?.open) dlg.close();
  }

  return {
    isAvailable,
    open,
    close,
    // Exposed for automated unit & E2E testing of Web Crypto E2E envelope
    _crypto: { encryptEntryObject, decryptEntryEnvelope },
  };
})();
