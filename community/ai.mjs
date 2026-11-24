// Built-in Fast Socratic AI Tutor ("Adamlite") for Study-OS.
// Primary engine: Google Gemini Developer API (streaming SSE + configurable thinking speed, default MINIMAL).
// Zero-config built-in fallback: Cloudflare Workers AI (env.AI binding).

const validActions = new Set(['hint', 'check', 'concept', 'solution', 'chat']);
const validThinking = new Set(['minimal', 'low', 'medium', 'high']);
const defaultDailyLimit = 40;
const adminDailyLimit = 200;

const geminiModels = [
  { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
];

const cfModels = [
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Cloudflare AI · Llama 3.3 70B' },
  { id: '@cf/meta/llama-3.1-8b-instruct-fast', label: 'Cloudflare AI · Llama 3.1 8B' },
];

// Per-isolate fast caches so dead/404 model IDs or unsupported thinking schemas never waste round-trips
const deadModelUntil = new Map();
const modelThinkingStyle = new Map(); // modelId -> 'level' | 'level-low' | 'budget' | 'none'

function defaultThinkingStyleFor(modelId) {
  // Gemini 3+ and Gemini 4 models use thinkingLevel; only Gemini 2.5 uses thinkingBudget.
  return /^gemini-2\./i.test(String(modelId || '')) ? 'budget' : 'level';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dailyLimitFor(env, isAdmin) {
  if (isAdmin) return adminDailyLimit;
  const parsed = Number(env.AI_DAILY_LIMIT);
  return Number.isSafeInteger(parsed) && parsed >= 5 && parsed <= 500 ? parsed : defaultDailyLimit;
}

function activeProviderInfo(env) {
  const hasGemini = typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 10;
  const hasCf = Boolean(env.AI && typeof env.AI.run === 'function');
  if (hasGemini) {
    const firstAlive = geminiModels.find((m) => (deadModelUntil.get(m.id) || 0) <= Date.now()) || geminiModels[0];
    return { available: true, provider: 'gemini', modelLabel: firstAlive.label, modelId: firstAlive.id };
  }
  if (hasCf) return { available: true, provider: 'cloudflare', modelLabel: cfModels[0].label, modelId: cfModels[0].id };
  return { available: false, provider: 'none', modelLabel: '', modelId: '' };
}

function buildSystemInstruction(action, thinking = 'minimal', contextBlock = '', hasAutoImage = false) {
  const formatting = [
    'You are Adamlite, Study-OS\'s fast, concise university study tutor (Economics, Accounting & Finance, Mathematics, OB, Data Science).',
    'Rules:',
    '- Be direct, clear, and concise. Use $...$ for inline math and $$...$$ for display equations.',
    '- Never output raw HTML or scripts. Prefer tight bullet points or numbered steps over long walls of text.',
    '- Match the student\'s language (Norwegian if they write Norwegian, otherwise crisp English).',
    '- Ground formulas and definitions in the provided Reference Note snippet when relevant.',
    '- When ACTIVE STUDY CONTEXT or an attached question figure/PDF image is provided, use it directly right away — NEVER say you cannot see the problem or ask the student to paste it.',
  ];
  if (thinking === 'minimal') {
    formatting.push('- Speed mode is MINIMAL: get straight to the answer/step cleanly without filler.');
  }
  const modeRule = {
    hint: 'MODE: SMALL HINT. Give ONE focused next-step hint without spoiling the final answer (3–5 lines).',
    check: 'MODE: CHECK WORKING. Compare the student\'s working against the question. Pinpoint the first mistake or confirm if correct.',
    concept: 'MODE: KEY CONCEPT. Give the core intuition and formula(s) needed without spoiling the exact final number.',
    solution: 'MODE: WORKED SOLUTION. Walk through the full step-by-step solution cleanly with math and a 1-line exam pitfall.',
    chat: 'MODE: TUTORING. Answer the student\'s question directly and clearly.',
  }[action] || '';

  const parts = [...formatting, modeRule];
  if (contextBlock) {
    parts.push(`\nACTIVE STUDY CONTEXT (the student's current problem on screen right now):\n${contextBlock}`);
  }
  if (hasAutoImage) {
    parts.push('\nNote: Image(s) of the visible question prompt / PDF table on the student\'s screen are attached to the latest user message. Read exact numbers, tables, and diagrams directly from those image(s).');
  }
  return parts.filter(Boolean).join('\n');
}

function defaultActionPrompt(action) {
  return {
    hint: 'Give me one focused next-step hint without spoiling the final answer.',
    check: 'Check my current working and point out where I went right or wrong.',
    concept: 'Explain the key concept and formula for this problem.',
    solution: 'Walk me through the complete step-by-step solution.',
    chat: 'Help me with this question.',
  }[action] || 'Help me with this question.';
}

function sanitizeAttachments(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList.slice(0, 3)) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || 'attachment').trim().slice(0, 80);
    if (item.kind === 'image') {
      const mime = String(item.mimeType || '').toLowerCase();
      const b64 = typeof item.base64 === 'string' ? item.base64.trim() : '';
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) continue;
      if (!b64 || b64.length > 1_400_000 || !/^[A-Za-z0-9+/=]+$/.test(b64)) continue;
      out.push({ kind: 'image', name, mimeType: mime, base64: b64 });
    } else if (item.kind === 'text') {
      const text = String(item.text || '').trim().slice(0, 6000);
      if (!text) continue;
      out.push({ kind: 'text', name, text });
    }
  }
  return out;
}

function buildGeminiContents(_contextBlock, history, userPrompt, attachments = []) {
  const contents = [];

  for (const turn of history) {
    const role = turn.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: turn.text }] });
  }

  const textAttachments = attachments
    .filter((a) => a.kind === 'text')
    .map((a) => `ATTACHED FILE (${a.name}):\n${a.text}`)
    .join('\n\n');
  const finalText = textAttachments ? `${textAttachments}\n\n${userPrompt}` : userPrompt;

  const userParts = [{ text: finalText }];
  for (const att of attachments) {
    if (att.kind === 'image') {
      userParts.push({ inlineData: { mimeType: att.mimeType, data: att.base64 } });
    }
  }
  contents.push({ role: 'user', parts: userParts });
  return contents;
}

function thinkingConfigFor(thinking, style) {
  if (style === 'none') return null;
  if (style === 'level-low') {
    // Fastest valid floor for Gemini 4 models whose minimum thinkingLevel is 'low'
    const map = { minimal: 'low', low: 'low', medium: 'medium', high: 'high' };
    return { thinkingLevel: map[thinking] || 'low' };
  }
  if (style === 'level') {
    const map = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' };
    return { thinkingLevel: map[thinking] || 'minimal' };
  }
  // Legacy Gemini 2.5 thinkingBudget (0 = instant minimal thinking)
  const budgets = { minimal: 0, low: 512, medium: 2048, high: 8192 };
  return { thinkingBudget: budgets[thinking] ?? 0 };
}

function orderedGeminiModels(preferredModelId) {
  const now = Date.now();
  const alive = geminiModels.filter((m) => (deadModelUntil.get(m.id) || 0) <= now);
  const pool = alive.length ? alive : geminiModels;
  if (preferredModelId && preferredModelId !== 'auto') {
    const exact = pool.find((m) => m.id === preferredModelId);
    if (exact) return [exact, ...pool.filter((m) => m.id !== exact.id)];
  }
  // Always lead with Gemini 4 Hydrogen (never downgrade to 3.5 Flash-Lite unless Hydrogen + 3.8 fail)
  return pool;
}

function extractVisibleText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
}

async function fetchGeminiWithThinkingFallback(apiKey, modelId, endpoint, bodyBase, thinking) {
  const preferredStyle = modelThinkingStyle.get(modelId) || defaultThinkingStyleFor(modelId);
  let stylesToTry;
  if (preferredStyle === 'level') {
    stylesToTry = thinking === 'minimal'
      ? ['level', 'level-low', 'budget', 'none']
      : ['level', 'budget', 'none'];
  } else if (preferredStyle === 'level-low') {
    stylesToTry = ['level-low', 'budget', 'none'];
  } else if (preferredStyle === 'budget') {
    stylesToTry = thinking === 'minimal'
      ? ['budget', 'level', 'level-low', 'none']
      : ['budget', 'level', 'none'];
  } else {
    stylesToTry = ['none'];
  }

  let lastRes = null;
  for (const style of stylesToTry) {
    const tc = thinkingConfigFor(thinking, style);
    const generationConfig = { ...bodyBase.generationConfig };
    if (tc) generationConfig.thinkingConfig = tc;
    else delete generationConfig.thinkingConfig;

    const doReq = () => fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:${endpoint}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({ ...bodyBase, generationConfig }),
        signal: AbortSignal.timeout(14_000),
      }
    );

    let res = await doReq();
    // For primary Hydrogen model, give one brief retry on transient 503/429 before downgrading
    if ((res.status === 503 || res.status === 429) && modelId === 'gemini-4-hydrogen') {
      await sleep(260);
      res = await doReq();
    }
    lastRes = res;
    if (res.ok) {
      modelThinkingStyle.set(modelId, style);
      return res;
    }
    if (res.status === 404) {
      deadModelUntil.set(modelId, Date.now() + 10 * 60_000);
      return res;
    }
    if (res.status === 400 && style !== 'none') {
      // Unsupported thinkingLevel/thinkingBudget value — step immediately to next style (e.g. minimal -> low)
      continue;
    }
    return res;
  }
  return lastRes;
}

async function callGemini(apiKey, systemInstruction, contextBlock, history, userPrompt, opts = {}) {
  const thinking = validThinking.has(opts.thinking) ? opts.thinking : 'minimal';
  const contents = buildGeminiContents(contextBlock, history, userPrompt, opts.attachments || []);
  const defaultTokens = thinking === 'minimal' ? 1024 : thinking === 'low' ? 1400 : thinking === 'medium' ? 2048 : 3072;
  const generationConfig = {
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
    maxOutputTokens: Number(opts.maxOutputTokens || defaultTokens),
  };
  if (opts.jsonMode) generationConfig.responseMimeType = 'application/json';

  const bodyBase = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig,
  };

  let lastError = 'Gemini request failed.';
  const models = orderedGeminiModels(opts.modelId, thinking);
  for (const model of models) {
    try {
      const res = await fetchGeminiWithThinkingFallback(apiKey, model.id, 'generateContent', bodyBase, thinking);
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        lastError = errBody?.error?.message || `Gemini HTTP ${res.status}`;
        if (res.status === 429 || res.status === 503 || res.status === 404) continue;
        break;
      }
      const payload = await res.json();
      const replyText = extractVisibleText(payload?.candidates?.[0]?.content?.parts).trim();
      if (replyText) {
        return { reply: replyText, provider: 'gemini', modelLabel: model.label, modelId: model.id };
      }
      lastError = 'Empty Gemini response.';
    } catch (err) {
      lastError = err?.message || 'Network error calling Gemini.';
    }
  }
  throw new Error(lastError);
}

async function openGeminiStream(apiKey, systemInstruction, contextBlock, history, userPrompt, opts = {}) {
  const thinking = validThinking.has(opts.thinking) ? opts.thinking : 'minimal';
  const contents = buildGeminiContents(contextBlock, history, userPrompt, opts.attachments || []);
  const defaultTokens = thinking === 'minimal' ? 1024 : thinking === 'low' ? 1400 : thinking === 'medium' ? 2048 : 3072;
  const bodyBase = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
      maxOutputTokens: Number(opts.maxOutputTokens || defaultTokens),
    },
  };

  let lastError = 'Gemini stream failed.';
  const models = orderedGeminiModels(opts.modelId, thinking);
  for (const model of models) {
    try {
      const res = await fetchGeminiWithThinkingFallback(
        apiKey,
        model.id,
        'streamGenerateContent?alt=sse',
        bodyBase,
        thinking
      );
      if (res.ok && res.body) {
        return { upstream: res.body, provider: 'gemini', modelLabel: model.label, modelId: model.id };
      }
      const errBody = await res.json().catch(() => ({}));
      lastError = errBody?.error?.message || `Gemini HTTP ${res.status}`;
      if (res.status === 429 || res.status === 503 || res.status === 404) continue;
      break;
    } catch (err) {
      lastError = err?.message || 'Network error streaming Gemini.';
    }
  }
  throw new Error(lastError);
}

async function callCloudflareAi(aiBinding, systemInstruction, contextBlock, history, userPrompt, opts = {}) {
  const messages = [{ role: 'system', content: systemInstruction }];
  if (contextBlock) {
    messages.push({ role: 'system', content: `STUDY CONTEXT:\n${contextBlock}` });
  }
  for (const turn of history) {
    messages.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: turn.text,
    });
  }
  const textAtts = (opts.attachments || [])
    .filter((a) => a.kind === 'text')
    .map((a) => `ATTACHED FILE (${a.name}):\n${a.text}`)
    .join('\n\n');
  messages.push({ role: 'user', content: textAtts ? `${textAtts}\n\n${userPrompt}` : userPrompt });

  let lastError = 'Cloudflare Workers AI request failed.';
  for (const model of cfModels) {
    try {
      const res = await aiBinding.run(model.id, {
        messages,
        max_tokens: Number(opts.maxOutputTokens || 1024),
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
      });
      const text =
        (typeof res?.response === 'string' && res.response.trim())
        || (typeof res?.choices?.[0]?.message?.content === 'string' && res.choices[0].message.content.trim())
        || (typeof res === 'string' && res.trim())
        || '';
      if (text) {
        return { reply: text, provider: 'cloudflare', modelLabel: model.label, modelId: model.id };
      }
      lastError = 'Empty response from Cloudflare AI.';
    } catch (err) {
      lastError = err?.message || 'Cloudflare Workers AI error.';
    }
  }
  throw new Error(lastError);
}

function parseGeneratedSetJson(rawText, fallbackTitle) {
  let cleaned = String(rawText || '').trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) cleaned = fenced[1].trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  const parsed = JSON.parse(cleaned);
  const rawQuestions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const questions = [];
  for (const q of rawQuestions.slice(0, 20)) {
    if (!q || typeof q !== 'object') continue;
    const promptMarkdown = String(q.promptMarkdown || q.prompt || q.question || '').trim().slice(0, 900);
    const solutionMarkdown = String(q.solutionMarkdown || q.solution || q.answer || '').trim().slice(0, 1200);
    if (!promptMarkdown || !solutionMarkdown) continue;
    const rawOptions = Array.isArray(q.options) ? q.options.map((o) => String(o || '').trim().slice(0, 260)).filter(Boolean) : [];
    const ansIdx = Number(q.answerIndex);
    const isMcq = (q.kind === 'mcq' || rawOptions.length >= 2) && rawOptions.length >= 2 && rawOptions.length <= 5
      && Number.isInteger(ansIdx) && ansIdx >= 0 && ansIdx < rawOptions.length;
    const diff = [1, 2, 3].includes(Number(q.difficulty)) ? Number(q.difficulty) : 2;
    questions.push({
      title: String(q.title || `Question ${questions.length + 1}`).trim().slice(0, 100),
      kind: isMcq ? 'mcq' : 'written',
      difficulty: diff,
      topic: String(q.topic || '').trim().slice(0, 80),
      promptMarkdown,
      ...(isMcq ? { options: rawOptions, answerIndex: ansIdx } : {}),
      hint: String(q.hint || '').trim().slice(0, 320),
      solutionMarkdown,
    });
  }
  if (!questions.length) throw new Error('AI returned no valid practice questions. Try again.');
  const title = String(parsed?.title || fallbackTitle || 'Custom Study Set').trim().slice(0, 90);
  return { title, questions };
}

function parseHmToMins(hm, fallback = 450) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

function minsToHm(mins) {
  const n = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

function deriveBedTimeFromWake(wakeTime, sleepHours = 8) {
  const wakeMins = parseHmToMins(wakeTime, 7 * 60 + 30);
  const sleep = Math.max(6, Math.min(10, Number(sleepHours) || 8));
  return minsToHm(wakeMins - Math.round(sleep * 60));
}

function parseGeneratedScheduleJson(rawText, opts = {}) {
  let cleaned = String(rawText || '').trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) cleaned = fenced[1].trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  const parsed = JSON.parse(cleaned);
  const rawBlocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];

  const courses = Array.isArray(opts.courses) ? opts.courses : [];
  const validCourseIds = new Set(courses.map((c) => c.courseId));
  const byCode = new Map(
    courses.filter((c) => c.code).map((c) => [c.code.toUpperCase().replace(/[\s-]+/g, ''), c.courseId])
  );
  const fallbackCourseId = courses[0]?.courseId || '';

  const wakeMins = parseHmToMins(opts.wakeTime, 7 * 60 + 30);
  const sleep = Math.max(6, Math.min(10, Number(opts.sleepHours) || 8));
  const bedMinsRaw = wakeMins - Math.round(sleep * 60);
  const awakeStart = wakeMins + 30;
  const awakeEnd = (bedMinsRaw <= wakeMins ? bedMinsRaw + 1440 : bedMinsRaw) - 30;
  const toAwakeMin = (hmMins) => (hmMins < wakeMins ? hmMins + 1440 : hmMins);

  const fixedByDate = new Map();
  for (const ev of Array.isArray(opts.fixedEvents) ? opts.fixedEvents : []) {
    if (!ev?.date) continue;
    const s = parseHmToMins(ev.startTime, -1);
    const e = parseHmToMins(ev.endTime, -1);
    if (s < 0 || e <= s) continue;
    if (!fixedByDate.has(ev.date)) fixedByDate.set(ev.date, []);
    fixedByDate.get(ev.date).push([s, e]);
  }

  const startDateOpt = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.startDate || '').trim())
    ? String(opts.startDate).trim()
    : '';
  const currentTimeMins = /^\d{2}:\d{2}$/.test(String(opts.currentTime || '').trim())
    ? parseHmToMins(opts.currentTime, -1)
    : -1;

  const takenByDate = new Map();
  const blocks = [];
  for (const b of rawBlocks.slice(0, 110)) {
    if (!b || typeof b !== 'object') continue;
    const date = String(b.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (startDateOpt && date < startDateOpt) continue;
    const sMins = parseHmToMins(b.startTime || b.start, -1);
    const eMinsRaw = b.endTime || b.end ? parseHmToMins(b.endTime || b.end, -1) : sMins + Number(b.durationMinutes || 50);
    if (sMins < 0 || eMinsRaw <= sMins) continue;
    // Never schedule a block on startDate that already ended or started in the past
    if (startDateOpt && date === startDateOpt && currentTimeMins >= 0 && (eMinsRaw <= currentTimeMins || sMins < currentTimeMins - 5)) {
      continue;
    }
    const dur = eMinsRaw - sMins;
    if (dur < 20 || dur > 120) continue;

    // Enforce wake + 30m .. bedtime - 30m (8h sleep protection)
    const relStart = toAwakeMin(sMins);
    const relEnd = relStart + dur;
    if (relStart < awakeStart || relEnd > awakeEnd) continue;

    // Prevent overlap with fixed TimeEdit/TP classes & already-scheduled study blocks
    const fixed = fixedByDate.get(date) || [];
    const taken = takenByDate.get(date) || [];
    const clashes = (arr) => arr.some(([a, z]) => sMins < z && eMinsRaw > a);
    if (clashes(fixed) || clashes(taken)) continue;

    let courseId = typeof b.courseId === 'string' ? b.courseId.trim() : '';
    if (!validCourseIds.has(courseId)) {
      const norm = courseId.toUpperCase().replace(/[\s-]+/g, '');
      courseId = byCode.get(norm) || fallbackCourseId;
    }

    const rawDlpfc = String(b.dlpfc || b.dlpfcMode || '').toLowerCase();
    const dlpfcMode = rawDlpfc.includes('high')
      ? 'high_dlpfc'
      : rawDlpfc.includes('low')
      ? 'low_dlpfc'
      : rawDlpfc.includes('med')
      ? 'med_dlpfc'
      : (relStart - wakeMins < 420 ? 'high_dlpfc' : relStart - wakeMins < 660 ? 'med_dlpfc' : 'low_dlpfc');

    const title = String(b.title || b.summary || 'Focused study block').trim().slice(0, 140);
    const profile = b.profile === 'exam' ? 'exam' : 'learning';

    if (!takenByDate.has(date)) takenByDate.set(date, []);
    takenByDate.get(date).push([sMins, eMinsRaw]);

    blocks.push({
      date,
      startTime: minsToHm(sMins),
      endTime: minsToHm(eMinsRaw),
      durationMinutes: dur,
      courseId,
      title,
      dlpfcMode,
      profile,
    });
    if (blocks.length >= 84) break;
  }

  blocks.sort((a, b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`));
  if (!blocks.length) throw new Error('Hydrogen returned no valid study blocks within your awake window. Try adjusting work hours or notes.');
  const summary = String(parsed?.summary || '').trim().slice(0, 240);
  return { summary, blocks };
}

async function getUsage(db, profileId, dayUtc) {
  const row = await db.prepare('SELECT used_count FROM ai_usage WHERE profile_id = ? AND day_utc = ?')
    .bind(profileId, dayUtc).first();
  return Number(row?.used_count || 0);
}

async function bumpUsage(db, profileId, dayUtc, now) {
  await db.prepare(`
    INSERT INTO ai_usage(profile_id, day_utc, used_count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(profile_id, day_utc) DO UPDATE SET
      used_count = used_count + 1,
      updated_at = excluded.updated_at
  `).bind(profileId, dayUtc, now).run();
}

export async function handleAi({ request, path, db, env, me, isAdmin, now, data, reply, corsHeaders = {} }) {
  const dayUtc = new Date(now).toISOString().slice(0, 10);
  const limit = dailyLimitFor(env, isAdmin);
  const info = activeProviderInfo(env);

  if (path === '/ai/status' && request.method === 'GET') {
    const used = await getUsage(db, me.id, dayUtc);
    return reply({
      ...info,
      used,
      limit,
      remaining: Math.max(0, limit - used),
    });
  }

  if (path === '/ai/tutor' && request.method === 'POST') {
    if (!info.available) {
      return reply({ error: 'Adamlite is not configured on this server yet.' }, 503);
    }

    const action = validActions.has(data.action) ? data.action : 'chat';
    const thinking = validThinking.has(data.thinking) ? data.thinking : 'minimal';
    const modelId = typeof data.model === 'string' ? data.model.trim() : 'auto';
    const wantStream = Boolean(data.stream);
    const rawMsg = typeof data.message === 'string' ? data.message.trim() : '';
    const attachments = sanitizeAttachments(data.attachments);
    const userPrompt = (rawMsg || (attachments.length ? 'Help me with the attached file(s).' : defaultActionPrompt(action))).slice(0, 2000);
    const contextBlock = (typeof data.context === 'string' ? data.context.trim() : '').slice(0, 9_500);
    if (!contextBlock && !rawMsg && !attachments.length) {
      return reply({ error: 'Ask a question, attach a file, or open a practice problem first.' }, 400);
    }

    const rawHistory = Array.isArray(data.history) ? data.history.slice(-8) : [];
    const history = rawHistory
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim())
      .map((t) => ({ role: t.role, text: t.text.trim().slice(0, 1800) }));

    const usedBefore = await getUsage(db, me.id, dayUtc);
    if (usedBefore >= limit) {
      return reply({
        error: `Daily Adamlite limit reached (${limit}/day). Resets at 00:00 UTC.`,
        used: usedBefore,
        limit,
        remaining: 0,
      }, 429);
    }

    const hasAutoImage = attachments.some((a) => a.kind === 'image');
    const systemInstruction = buildSystemInstruction(action, thinking, contextBlock, hasAutoImage);
    const geminiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
    const hasCf = Boolean(env.AI && typeof env.AI.run === 'function');
    let triedGemini = false;
    let firstError = null;

    // Fast Real-Time SSE Streaming path
    if (wantStream && geminiKey.length > 10) {
      triedGemini = true;
      try {
        const streamInfo = await openGeminiStream(geminiKey, systemInstruction, contextBlock, history, userPrompt, {
          thinking,
          modelId,
          attachments,
        });
        const enc = new TextEncoder();
        const dec = new TextDecoder();
        const usedAfter = usedBefore + 1;

        const sseStream = new ReadableStream({
          async start(controller) {
            const reader = streamInfo.upstream.getReader();
            let buf = '';
            let gotAny = false;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                  if (!line.startsWith('data:')) continue;
                  const raw = line.slice(5).trim();
                  if (!raw || raw === '[DONE]') continue;
                  try {
                    const parsed = JSON.parse(raw);
                    const delta = extractVisibleText(parsed?.candidates?.[0]?.content?.parts);
                    if (delta) {
                      gotAny = true;
                      controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta })}\n\n`));
                    }
                  } catch {}
                }
              }
              if (gotAny) {
                await bumpUsage(db, me.id, dayUtc, now);
              }
              controller.enqueue(enc.encode(`data: ${JSON.stringify({
                done: true,
                provider: streamInfo.provider,
                modelLabel: streamInfo.modelLabel,
                used: gotAny ? usedAfter : usedBefore,
                limit,
                remaining: Math.max(0, limit - (gotAny ? usedAfter : usedBefore)),
              })}\n\n`));
            } catch (err) {
              controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: err?.message || 'Stream interrupted.' })}\n\n`));
            } finally {
              controller.close();
            }
          },
        });

        return new Response(sseStream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-store',
            ...corsHeaders,
          },
        });
      } catch (err) {
        firstError = err;
        // Skip re-running Gemini a second time; fall directly to Cloudflare AI fallback below
      }
    }

    let result = null;
    if (!triedGemini && geminiKey.length > 10) {
      try {
        result = await callGemini(geminiKey, systemInstruction, contextBlock, history, userPrompt, {
          thinking,
          modelId,
          attachments,
        });
      } catch (err) {
        firstError = err;
      }
    }
    if (!result && hasCf) {
      try {
        result = await callCloudflareAi(env.AI, systemInstruction, '', history, userPrompt, { attachments });
      } catch (err) {
        firstError = firstError || err;
      }
    }
    if (!result) {
      return reply({ error: firstError?.message || 'Adamlite is temporarily busy. Please try again.' }, 502);
    }

    await bumpUsage(db, me.id, dayUtc, now);
    const used = usedBefore + 1;
    return reply({
      reply: result.reply,
      provider: result.provider,
      modelLabel: result.modelLabel,
      used,
      limit,
      remaining: Math.max(0, limit - used),
    });
  }

  if (path === '/ai/generate-set' && request.method === 'POST') {
    if (!info.available) {
      return reply({ error: 'Built-in AI generator is not configured yet — use the "Your Own AI" tab to paste a set.' }, 503);
    }

    const courseCode = typeof data.courseCode === 'string' ? data.courseCode.trim().slice(0, 32) : '';
    const courseTitle = typeof data.courseTitle === 'string' ? data.courseTitle.trim().slice(0, 140) : '';
    const school = typeof data.school === 'string' ? data.school.trim().slice(0, 48) : (me.school || '');
    const topics = Array.isArray(data.topics)
      ? data.topics.map((t) => String(t || '').trim().slice(0, 100)).filter(Boolean).slice(0, 20)
      : [];
    const sourceText = typeof data.sourceText === 'string' ? data.sourceText.trim().slice(0, 16_000) : '';
    const style = ['mixed', 'mcq', 'written'].includes(data.style) ? data.style : 'mixed';
    const language = ['auto', 'en', 'nb'].includes(data.language) ? data.language : 'auto';
    const count = Math.max(4, Math.min(15, Number(data.count) || 8));

    if (!courseTitle && !courseCode && !topics.length && !sourceText) {
      return reply({ error: 'Enter a course name, topic, or paste some lecture notes first.' }, 400);
    }

    const usedBefore = await getUsage(db, me.id, dayUtc);
    if (usedBefore >= limit) {
      return reply({
        error: `Daily AI limit reached (${limit}/day). Use the "Your Own AI" tab to paste a set from ChatGPT/Claude/Gemini anytime.`,
        used: usedBefore,
        limit,
        remaining: 0,
      }, 429);
    }

    const langRule = language === 'nb'
      ? 'Write ALL questions, options, hints, and solutions in clear Norwegian Bokmål.'
      : language === 'en'
      ? 'Write ALL questions, options, hints, and solutions in crisp English.'
      : 'Match the primary language of the course title / syllabus / notes (Norwegian Bokmål if Norwegian, otherwise crisp English).';

    const styleRule = style === 'mcq'
      ? 'Every question must be kind="mcq" with exactly 4 plausible options and integer answerIndex (0-3).'
      : style === 'written'
      ? 'Every question must be kind="written" requiring active recall, derivation, calculation, or structured case analysis.'
      : 'Mix roughly 60% kind="mcq" (4 plausible options, answerIndex 0-3) and 40% kind="written" (active-recall / calculation / short case).';

    const sys = [
      'You are an expert university exam-prep author creating original, rigorous practice questions for Study-OS.',
      'Return ONLY valid JSON with this exact shape:',
      '{"title":"Short Set Title (max 70 chars)","questions":[{"title":"Short Question Title","kind":"mcq"|"written","difficulty":1|2|3,"topic":"Topic name","promptMarkdown":"Question text (use $...$ for math)","options":["A","B","C","D"],"answerIndex":0,"hint":"Focused Socratic hint without spoiling answer","solutionMarkdown":"Step-by-step worked solution & key takeaway"}]}',
      '- Omit "options" and "answerIndex" for kind="written".',
      '- difficulty: 1 = Low DLPFC (recall/concept), 2 = Med DLPFC (applied/procedural), 3 = High DLPFC (synthesis/case/multi-step).',
      `- Create exactly ${count} original, non-trivial exam-grade questions.`,
      `- ${styleRule}`,
      `- ${langRule}`,
      '- Never reproduce copyrighted exam text verbatim; write fresh exam-style questions testing the underlying concepts.',
    ].join('\n');

    const promptParts = [
      courseCode || courseTitle ? `COURSE: ${[courseCode, courseTitle].filter(Boolean).join(' · ')}` : '',
      school ? `UNIVERSITY / SCHOOL: ${school}` : '',
      topics.length ? `SYLLABUS / CANVAS MODULES:\n- ${topics.join('\n- ')}` : '',
      sourceText ? `STUDENT NOTES / EXCERPT:\n${sourceText}` : '',
      `Generate ${count} high-quality exam practice questions as strict JSON.`,
    ].filter(Boolean).join('\n\n');

    const geminiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
    const hasCf = Boolean(env.AI && typeof env.AI.run === 'function');
    let result = null;
    let firstError = null;
    if (geminiKey.length > 10) {
      try {
        result = await callGemini(geminiKey, sys, '', [], promptParts, {
          jsonMode: true,
          thinking: 'low',
          maxOutputTokens: 4096,
          temperature: 0.4,
        });
      } catch (err) {
        firstError = err;
      }
    }
    if (!result && hasCf) {
      try {
        result = await callCloudflareAi(env.AI, sys, '', [], promptParts, {
          maxOutputTokens: 3072,
          temperature: 0.35,
        });
      } catch (err) {
        firstError = firstError || err;
      }
    }
    if (!result) {
      return reply({ error: firstError?.message || 'Could not generate set right now. Try again or use "Your Own AI".' }, 502);
    }

    let parsedSet;
    try {
      const fallbackTitle = [courseCode, courseTitle].filter(Boolean).join(' · ') || 'Custom Study Set';
      parsedSet = parseGeneratedSetJson(result.reply, fallbackTitle);
    } catch (err) {
      return reply({ error: err?.message || 'AI output could not be parsed. Please try again.' }, 502);
    }

    await bumpUsage(db, me.id, dayUtc, now);
    const used = usedBefore + 1;
    return reply({
      ok: true,
      set: {
        id: crypto.randomUUID(),
        title: parsedSet.title,
        courseCode,
        courseTitle,
        school,
        modelLabel: result.modelLabel,
        createdAt: new Date(now).toISOString(),
        questions: parsedSet.questions,
      },
      provider: result.provider,
      modelLabel: result.modelLabel,
      used,
      limit,
      remaining: Math.max(0, limit - used),
    });
  }

  // POST /ai/generate-schedule — Gemini 4 Hydrogen circadian DLPFC study schedule planner
  if (path === '/ai/generate-schedule' && request.method === 'POST') {
    const info = activeProviderInfo(env);
    if (!info.available) {
      return reply({ error: 'Gemini 4 Hydrogen is unavailable right now — use Quick auto-plan instead.' }, 503);
    }

    const usedBefore = await getUsage(db, me.id, dayUtc);
    if (usedBefore >= limit) {
      return reply({
        error: `Daily AI limit reached (${limit}/day). Use Quick auto-plan or try again tomorrow.`,
        used: usedBefore,
        limit,
        remaining: 0,
      }, 429);
    }

    const wakeTime = /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(data.wakeTime || '').trim())
      ? String(data.wakeTime).trim()
      : '07:30';
    const sleepHours = Math.max(6, Math.min(10, Number(data.sleepHours) || 8));
    const bedTime = deriveBedTimeFromWake(wakeTime, sleepHours);
    const weeklyWorkHours = Math.max(0, Math.min(50, Number(data.weeklyWorkHours) || 0));
    const targetStudyHours = Math.max(2, Math.min(45, Number(data.targetStudyHours) || 24));
    const blockMinutes = [40, 50, 75].includes(Number(data.blockMinutes)) ? Number(data.blockMinutes) : 50;
    const breakMinutes = [10, 15].includes(Number(data.breakMinutes)) ? Number(data.breakMinutes) : 10;
    const restDays = Array.isArray(data.restDays)
      ? data.restDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).slice(0, 4)
      : [6];
    const notes = typeof data.notes === 'string' ? data.notes.trim().slice(0, 600) : '';
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(data.startDate || '').trim())
      ? String(data.startDate).trim()
      : new Date(now).toISOString().slice(0, 10);
    const currentTime = /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(data.currentTime || '').trim())
      ? String(data.currentTime).trim()
      : '';
    const horizonDays = Math.max(7, Math.min(14, Number(data.horizonDays) || 14));

    const courses = (Array.isArray(data.courses) ? data.courses : [])
      .filter((c) => c && typeof c === 'object' && typeof c.courseId === 'string' && c.courseId.trim())
      .slice(0, 12)
      .map((c) => ({
        courseId: String(c.courseId).trim().slice(0, 64),
        code: String(c.code || '').trim().slice(0, 24),
        title: String(c.title || c.shortTitle || '').trim().slice(0, 90),
        examDate: String(c.examDate || '').trim().slice(0, 24),
        done: Math.max(0, Number(c.done) || 0),
        total: Math.max(0, Number(c.total) || 0),
        weight: Math.max(0.5, Math.min(2, Number(c.weight) || 1)),
        topics: Array.isArray(c.topics) ? c.topics.slice(0, 6).map((t) => String(t || '').trim().slice(0, 60)).filter(Boolean) : [],
      }));

    if (!courses.length) {
      return reply({ error: 'No active courses available to schedule.' }, 400);
    }

    const fixedEvents = (Array.isArray(data.fixedEvents) ? data.fixedEvents : [])
      .filter((ev) => ev && typeof ev === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(String(ev.date || '')))
      .slice(0, 60)
      .map((ev) => ({
        date: String(ev.date),
        startTime: String(ev.startTime || '').slice(0, 5),
        endTime: String(ev.endTime || '').slice(0, 5),
        summary: String(ev.summary || '').trim().slice(0, 80),
        kind: ev.kind === 'exam' ? 'exam' : 'class',
      }));

    const deadlines = (Array.isArray(data.deadlines) ? data.deadlines : [])
      .filter((d) => d && typeof d === 'object' && d.name)
      .slice(0, 15)
      .map((d) => ({
        date: String(d.date || '').slice(0, 16),
        name: String(d.name || '').trim().slice(0, 90),
        course: String(d.course || '').trim().slice(0, 60),
      }));

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const restDayNames = restDays.map((d) => dayNames[d]).filter(Boolean);
    const wakeStudyStart = minsToHm(parseHmToMins(wakeTime) + 30);
    const bedStudyEnd = minsToHm(parseHmToMins(bedTime) - 30);

    const sys = [
      'You are Study-OS\'s circadian DLPFC study schedule planner.',
      'Return ONLY valid JSON with this exact schema:',
      '{"summary":"1 short sentence describing the 2-week framework","blocks":[{"date":"YYYY-MM-DD","startTime":"HH:MM","endTime":"HH:MM","courseId":"exact_courseId","title":"Concise specific focus topic (max 80 chars)","dlpfc":"high"|"med"|"low","profile":"learning"|"exam"}]}',
      'Hard rules:',
      `- Protect ${sleepHours}h of sleep: wakeTime=${wakeTime}, auto-bedtime=${bedTime}. EVERY block MUST stay strictly inside ${wakeStudyStart}–${bedStudyEnd}.`,
      `- Use ${blockMinutes}-minute focus blocks with at least ${breakMinutes} minutes break between consecutive blocks.`,
      '- NEVER overlap any fixed lecture/exam in FIXED_TIMETABLE or any shifts/commitments mentioned in STUDENT_NOTES.',
      '- Circadian DLPFC energy curve: "high" (hard problem sets, proofs, coding, cases) in the first 7h after waking (max 4.5h/day); "med" (procedural drills) mid-day; "low" (conceptual review/recall) in the evening.',
      '- Prioritize courses with upcoming deadlines, nearer exam dates, higher weights, or lower completion.',
      '- Keep block titles specific and actionable (referencing real course topics when listed). No fluff.',
    ].join('\n');

    const userPrompt = [
      `PLAN HORIZON: ${horizonDays} days starting ${startDate}${currentTime ? ` (CURRENT OSLO TIME: ${currentTime} — NEVER schedule blocks earlier than ${currentTime} on ${startDate} or on any date before ${startDate})` : ''}`,
      `WEEKLY WORK HOURS: ${weeklyWorkHours}h/wk -> TARGET SELF-STUDY: ~${targetStudyHours}h/wk (~${Math.round((targetStudyHours * horizonDays) / 7)}h total over ${horizonDays} days, capped at 56 blocks max)`,
      `WAKE-UP: ${wakeTime} | AUTO-BEDTIME (${sleepHours}h sleep): ${bedTime} | STUDY WINDOW: ${wakeStudyStart}–${bedStudyEnd}`,
      restDayNames.length ? `PREFERRED REST / LIGHT DAYS: ${restDayNames.join(', ')}` : '',
      notes ? `STUDENT_NOTES (shifts, gym, priorities — MUST respect): ${notes}` : '',
      '',
      'COURSES (use exact courseId):',
      ...courses.map((c) => `- ${c.courseId} | ${c.code} ${c.title} | Weight: ${c.weight}x | Done: ${c.done}/${c.total} | Exam: ${c.examDate || 'TBD'}${c.topics.length ? ` | Focus topics: ${c.topics.join('; ')}` : ''}`),
      '',
      fixedEvents.length
        ? `FIXED_TIMETABLE (synced TimeEdit/TP classes & exams — NEVER overlap):\n${fixedEvents.map((ev) => `- ${ev.date} ${ev.startTime}-${ev.endTime} [${ev.kind}]: ${ev.summary}`).join('\n')}`
        : 'FIXED_TIMETABLE: None synced yet — schedule cleanly inside the awake window.',
      deadlines.length
        ? `\nUPCOMING CANVAS DEADLINES:\n${deadlines.map((d) => `- ${d.date}: ${d.name} (${d.course})`).join('\n')}`
        : '',
      '\nReturn strict JSON only.',
    ].filter(Boolean).join('\n');

    const geminiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
    const hasCf = Boolean(env.AI && typeof env.AI.run === 'function');
    let result = null;
    let firstError = null;
    if (geminiKey.length > 10) {
      try {
        result = await callGemini(geminiKey, sys, '', [], userPrompt, {
          modelId: 'gemini-4-hydrogen',
          jsonMode: true,
          thinking: 'low',
          maxOutputTokens: 4096,
          temperature: 0.35,
        });
      } catch (err) {
        firstError = err;
      }
    }
    if (!result && hasCf) {
      try {
        result = await callCloudflareAi(env.AI, sys, '', [], userPrompt, {
          maxOutputTokens: 3072,
          temperature: 0.3,
        });
      } catch (err) {
        firstError = firstError || err;
      }
    }
    if (!result) {
      return reply({ error: firstError?.message || 'Could not generate schedule right now — try Quick auto-plan.' }, 502);
    }

    let parsedPlan;
    try {
      parsedPlan = parseGeneratedScheduleJson(result.reply, {
        courses,
        fixedEvents,
        startDate,
        currentTime,
        horizonDays,
        wakeTime,
        sleepHours,
      });
    } catch (err) {
      return reply({ error: err?.message || 'Could not parse generated schedule. Please try again.' }, 502);
    }

    await bumpUsage(db, me.id, dayUtc, now);
    const used = usedBefore + 1;
    return reply({
      ok: true,
      summary: parsedPlan.summary,
      wakeTime,
      bedTime,
      sleepHours,
      blocks: parsedPlan.blocks,
      provider: result.provider,
      modelLabel: result.modelLabel,
      used,
      limit,
      remaining: Math.max(0, limit - used),
    });
  }

  return reply({ error: 'Not found.' }, 404);
}
