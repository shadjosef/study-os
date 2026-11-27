// Private Admin-Gated E2E-Encrypted Evening Debrief Journal + Zero-Storage Whisper Transcription
// D1 stores ONLY authenticated AES-256-GCM ciphertext envelopes; audio is transcribed in memory and discarded.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const B64_RE = /^[A-Za-z0-9+/=_-]+$/;
const ALLOWED_LANGS = new Set(['en', 'no', 'nb', 'nn']);
const ALLOWED_AUDIO_MIMES = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/aac', 'audio/flac']);
const GEMINI_AUDIO_MODELS = ['gemini-3.5-transcribe', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
const MAX_CIPHER_CHARS = 65_536;
const MAX_AUDIO_B64_CHARS = 4_500_000;

function cleanAudioMime(raw) {
  const base = String(raw || 'audio/webm').split(';')[0].trim().toLowerCase();
  if (ALLOWED_AUDIO_MIMES.has(base)) return base === 'audio/mp3' ? 'audio/mpeg' : base;
  return 'audio/webm';
}

async function transcribeWithGemini(apiKey, audioBase64, mimeType, lang) {
  const langInstruction = lang === 'en'
    ? 'The speaker is speaking English (occasionally mentioning Norwegian course/university names like BI Oslo).'
    : lang === 'no' || lang === 'nb' || lang === 'nn'
    ? 'The speaker is speaking Norwegian (occasionally mixing in English technical/study terms).'
    : 'Transcribe in the language spoken (English or Norwegian).';
  const prompt = [
    'Transcribe this personal evening study voice note verbatim with clean, natural punctuation and paragraph breaks.',
    langInstruction,
    'Rules: Output ONLY the clean transcript text. Do not add commentary, timestamps, headings, or labels. Preserve honest phrasing and technical terms (Accounting, Economics, Math, Python, WISEflow, FSRS, Study-OS). If silent/unintelligible, return an empty string.',
  ].join(' ');

  for (const modelId of GEMINI_AUDIO_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: audioBase64 } },
            ],
          }],
          generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 2048,
          },
        }),
      });
      if (!res.ok) continue;
      const body = await res.json();
      const parts = body?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
      return { text, model: modelId };
    } catch {
      continue;
    }
  }
  return null;
}

function validateEncryptedEnvelope(raw) {
  if (typeof raw !== 'string' || raw.length < 40 || raw.length > MAX_CIPHER_CHARS) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.v !== 1 || parsed.alg !== 'AES-256-GCM' || parsed.kdf !== 'PBKDF2-SHA256') return null;
  const iter = Number(parsed.iter);
  if (!Number.isSafeInteger(iter) || iter < 100_000 || iter > 1_000_000) return null;
  if (typeof parsed.salt !== 'string' || parsed.salt.length < 16 || parsed.salt.length > 64 || !B64_RE.test(parsed.salt)) return null;
  if (typeof parsed.iv !== 'string' || parsed.iv.length < 12 || parsed.iv.length > 48 || !B64_RE.test(parsed.iv)) return null;
  if (typeof parsed.ct !== 'string' || parsed.ct.length < 16 || !B64_RE.test(parsed.ct)) return null;
  return JSON.stringify({
    v: 1,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iter,
    salt: parsed.salt,
    iv: parsed.iv,
    ct: parsed.ct,
  });
}

function base64ToBytes(b64) {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function handleJournal({ request, path, db, env, me, isAdmin, now, data, reply }) {
  if (!isAdmin) {
    return reply({ error: 'Admin access required.' }, 403);
  }

  if (path === '/journal' && request.method === 'GET') {
    const { results } = await db.prepare(`
      SELECT entry_date AS date, payload_enc AS payloadEnc, updated_at AS updatedAt
      FROM encrypted_journals
      WHERE profile_id = ?
      ORDER BY entry_date DESC
      LIMIT 400
    `).bind(me.id).all();
    return reply({
      ok: true,
      entries: (results || []).map((r) => ({
        date: String(r.date || ''),
        payloadEnc: String(r.payloadEnc || ''),
        updatedAt: Number(r.updatedAt || 0),
      })),
    });
  }

  if (path === '/journal' && request.method === 'POST') {
    const entryDate = typeof data?.date === 'string' ? data.date.trim() : '';
    if (!DATE_RE.test(entryDate)) {
      return reply({ error: 'Invalid journal date (expected YYYY-MM-DD).' }, 400);
    }

    if (data.action === 'delete') {
      await db.prepare('DELETE FROM encrypted_journals WHERE profile_id = ? AND entry_date = ?')
        .bind(me.id, entryDate).run();
      return reply({ ok: true, deleted: true, date: entryDate });
    }

    const cleanEnvelope = validateEncryptedEnvelope(data?.payloadEnc);
    if (!cleanEnvelope) {
      return reply({ error: 'Journal payload must be a valid AES-256-GCM encrypted envelope.' }, 400);
    }

    await db.prepare(`
      INSERT INTO encrypted_journals (profile_id, entry_date, payload_enc, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, entry_date) DO UPDATE SET
        payload_enc = excluded.payload_enc,
        updated_at = excluded.updated_at
    `).bind(me.id, entryDate, cleanEnvelope, now).run();

    return reply({ ok: true, date: entryDate, updatedAt: now });
  }

  if (path === '/journal/transcribe' && request.method === 'POST') {
    const geminiKey = typeof env?.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
    const hasCfAi = Boolean(env?.AI && typeof env.AI.run === 'function');
    if (!geminiKey && !hasCfAi) {
      return reply({ error: 'Voice transcription is not configured on this server.' }, 503);
    }
    const rawAudio = typeof data?.audioBase64 === 'string' ? data.audioBase64.trim() : '';
    if (!rawAudio || rawAudio.length < 120 || rawAudio.length > MAX_AUDIO_B64_CHARS || !B64_RE.test(rawAudio)) {
      return reply({ error: 'Invalid or oversized audio recording.' }, 400);
    }
    const rawLang = typeof data?.language === 'string' ? data.language.trim().toLowerCase() : 'en';
    const lang = ALLOWED_LANGS.has(rawLang) ? rawLang : '';
    const mimeType = cleanAudioMime(data?.mimeType);

    // 1. Primary: Gemini native audio STT (~2.5% WER, top-tier accuracy + natural punctuation on English/mixed jargon)
    if (geminiKey.length > 10) {
      const gem = await transcribeWithGemini(geminiKey, rawAudio, mimeType, lang);
      if (gem) {
        return reply({ ok: true, text: gem.text, model: gem.model });
      }
    }

    // 2. Fallback: Cloudflare Workers AI Whisper Large v3 Turbo (zero extra cost)
    if (hasCfAi) {
      const promptHint = 'University student evening study reflection about accounting, economics, math, programming, focus, breaks, and habits.';
      try {
        const turboInput = {
          audio: rawAudio,
          task: 'transcribe',
          vad_filter: true,
          initial_prompt: promptHint,
        };
        if (lang) turboInput.language = lang;
        const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', turboInput);
        const text = String(out?.text || '').trim();
        return reply({ ok: true, text, model: 'whisper-large-v3-turbo' });
      } catch {
        try {
          const bytes = base64ToBytes(rawAudio);
          const out = await env.AI.run('@cf/openai/whisper', { audio: [...bytes] });
          const text = String(out?.text || '').trim();
          return reply({ ok: true, text, model: 'whisper' });
        } catch {}
      }
    }

    return reply({ error: 'Voice transcription failed. Your recording is safe locally — try again.' }, 502);
  }

  return reply({ error: 'Not found.' }, 404);
}
