// Built-in Socratic AI Tutor for Study-OS.
// Primary engine: Google Gemini Developer API (when GEMINI_API_KEY is configured).
// Zero-config built-in fallback: Cloudflare Workers AI (env.AI binding).

const validActions = new Set(['hint', 'check', 'concept', 'solution', 'chat']);
const defaultDailyLimit = 40;
const adminDailyLimit = 200;

const geminiModels = [
  { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
];

const cfModels = [
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Cloudflare AI · Llama 3.3 70B' },
  { id: '@cf/meta/llama-3.1-8b-instruct-fast', label: 'Cloudflare AI · Llama 3.1 8B' },
];

function dailyLimitFor(env, isAdmin) {
  if (isAdmin) return adminDailyLimit;
  const parsed = Number(env.AI_DAILY_LIMIT);
  return Number.isSafeInteger(parsed) && parsed >= 5 && parsed <= 500 ? parsed : defaultDailyLimit;
}

function activeProviderInfo(env) {
  const hasGemini = typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 10;
  const hasCf = Boolean(env.AI && typeof env.AI.run === 'function');
  if (hasGemini) return { available: true, provider: 'gemini', modelLabel: geminiModels[0].label };
  if (hasCf) return { available: true, provider: 'cloudflare', modelLabel: cfModels[0].label };
  return { available: false, provider: 'none', modelLabel: '' };
}

function buildSystemInstruction(action) {
  const formatting = [
    'You are the Study-OS Socratic Tutor for university students (Finance, Economics, Mathematics, Data Science).',
    'Formatting rules:',
    '- Write clear, concise Markdown. Use $...$ for inline math and $$...$$ for display equations.',
    '- Never output raw HTML or scripts. Keep answers scannable with short paragraphs or numbered steps.',
    '- Match the language of the student if they write in Norwegian or another language; otherwise reply in crisp English.',
  ];
  const modeRule = {
    hint: 'MODE: SMALL HINT. Give ONE focused next-step hint to unstick the student. Do NOT reveal the final numerical or multiple-choice answer. Keep it to 3-6 lines.',
    check: 'MODE: CHECK WORKING. Carefully check the student\'s current answers/working against the question. If blank, suggest the exact first step to set up. If incorrect, pinpoint the specific step or sign/formula error without immediately spoiling the final answer. If correct, confirm cleanly and note why it holds.',
    concept: 'MODE: KEY CONCEPT & FORMULA. Explain the core intuition, formula(s), and variable meanings needed for this problem type in exam-ready form without giving away the specific final answer.',
    solution: 'MODE: WORKED SOLUTION. Walk through the complete solution step-by-step with clear math, explain WHY each step follows, and call out any common exam pitfall at the end.',
    chat: 'MODE: FOLLOW-UP TUTORING. Answer the student\'s question directly and clearly. Stay Socratic (guide step-by-step) unless they explicitly ask for the full worked solution.',
  }[action] || '';

  return [...formatting, modeRule].join('\n');
}

function defaultActionPrompt(action) {
  return {
    hint: 'Give me one focused next-step hint for this question without spoiling the final answer.',
    check: 'Check my current answer and working on this question. Point out where I went right or where my mistake is.',
    concept: 'Explain the key concept and formula I should use to solve this type of question.',
    solution: 'Walk me through the complete step-by-step solution to this question.',
    chat: 'Help me understand this question.',
  }[action] || 'Help me with this question.';
}

async function callGemini(apiKey, systemInstruction, contextBlock, history, userPrompt, opts = {}) {
  const contents = [];
  const prefix = contextBlock
    ? `CURRENT EXERCISE CONTEXT:\n${contextBlock}\n\n---\n\n`
    : '';
  let attachedContext = false;

  for (const turn of history) {
    const role = turn.role === 'assistant' ? 'model' : 'user';
    const text = !attachedContext && role === 'user' ? (attachedContext = true, `${prefix}${turn.text}`) : turn.text;
    contents.push({ role, parts: [{ text }] });
  }
  contents.push({
    role: 'user',
    parts: [{ text: attachedContext ? userPrompt : `${prefix}${userPrompt}` }],
  });

  const generationConfig = {
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.35,
    maxOutputTokens: Number(opts.maxOutputTokens || 2048),
  };
  if (opts.jsonMode) generationConfig.responseMimeType = 'application/json';

  let lastError = 'Gemini request failed.';
  for (const model of geminiModels) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents,
            generationConfig,
          }),
        }
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        lastError = errBody?.error?.message || `Gemini HTTP ${res.status}`;
        if (res.status === 429 || res.status === 503 || res.status === 404) continue;
        break;
      }
      const payload = await res.json();
      const parts = payload?.candidates?.[0]?.content?.parts || [];
      const replyText = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
      if (replyText) {
        return { reply: replyText, provider: 'gemini', modelLabel: model.label };
      }
      lastError = 'Empty Gemini response.';
    } catch (err) {
      lastError = err?.message || 'Network error calling Gemini.';
    }
  }
  throw new Error(lastError);
}

async function callCloudflareAi(aiBinding, systemInstruction, contextBlock, history, userPrompt, opts = {}) {
  const messages = [{ role: 'system', content: systemInstruction }];
  if (contextBlock) {
    messages.push({ role: 'system', content: `CURRENT EXERCISE CONTEXT:\n${contextBlock}` });
  }
  for (const turn of history) {
    messages.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: turn.text,
    });
  }
  messages.push({ role: 'user', content: userPrompt });

  let lastError = 'Cloudflare Workers AI request failed.';
  for (const model of cfModels) {
    try {
      const res = await aiBinding.run(model.id, {
        messages,
        max_tokens: Number(opts.maxOutputTokens || 1024),
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.35,
      });
      const text =
        (typeof res?.response === 'string' && res.response.trim())
        || (typeof res?.choices?.[0]?.message?.content === 'string' && res.choices[0].message.content.trim())
        || (typeof res === 'string' && res.trim())
        || '';
      if (text) {
        return { reply: text, provider: 'cloudflare', modelLabel: model.label };
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
  const title = String(parsed?.title || fallbackTitle || 'AI Practice Set').trim().slice(0, 90);
  return { title, questions };
}

async function getUsage(db, profileId, dayUtc) {
  const row = await db.prepare('SELECT used_count FROM ai_usage WHERE profile_id = ? AND day_utc = ?')
    .bind(profileId, dayUtc).first();
  return Number(row?.used_count || 0);
}

export async function handleAi({ request, path, db, env, me, isAdmin, now, data, reply }) {
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
      return reply({ error: 'AI Tutor is not configured on this server yet.' }, 503);
    }

    const action = validActions.has(data.action) ? data.action : 'chat';
    const rawMsg = typeof data.message === 'string' ? data.message.trim() : '';
    const userPrompt = (rawMsg || defaultActionPrompt(action)).slice(0, 1500);
    const contextBlock = (typeof data.context === 'string' ? data.context.trim() : '').slice(0, 14_000);
    if (!contextBlock && !rawMsg) {
      return reply({ error: 'Ask a question or open a practice problem first.' }, 400);
    }

    const rawHistory = Array.isArray(data.history) ? data.history.slice(-8) : [];
    const history = rawHistory
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim())
      .map((t) => ({ role: t.role, text: t.text.trim().slice(0, 2000) }));

    const usedBefore = await getUsage(db, me.id, dayUtc);
    if (usedBefore >= limit) {
      return reply({
        error: `Daily AI Tutor limit reached (${limit}/day). Resets at 00:00 UTC — you can still use Copy for AI anytime.`,
        used: usedBefore,
        limit,
        remaining: 0,
      }, 429);
    }

    const systemInstruction = buildSystemInstruction(action);
    const geminiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
    const hasCf = Boolean(env.AI && typeof env.AI.run === 'function');

    let result = null;
    let firstError = null;
    if (geminiKey.length > 10) {
      try {
        result = await callGemini(geminiKey, systemInstruction, contextBlock, history, userPrompt);
      } catch (err) {
        firstError = err;
      }
    }
    if (!result && hasCf) {
      try {
        result = await callCloudflareAi(env.AI, systemInstruction, contextBlock, history, userPrompt);
      } catch (err) {
        firstError = firstError || err;
      }
    }
    if (!result) {
      return reply({ error: firstError?.message || 'AI Tutor is temporarily busy. Please try again.' }, 502);
    }

    await db.prepare(`
      INSERT INTO ai_usage(profile_id, day_utc, used_count, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(profile_id, day_utc) DO UPDATE SET
        used_count = used_count + 1,
        updated_at = excluded.updated_at
    `).bind(me.id, dayUtc, now).run();

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
      const fallbackTitle = [courseCode, courseTitle].filter(Boolean).join(' · ') || 'AI Study Set';
      parsedSet = parseGeneratedSetJson(result.reply, fallbackTitle);
    } catch (err) {
      return reply({ error: err?.message || 'AI output could not be parsed. Please try again.' }, 502);
    }

    await db.prepare(`
      INSERT INTO ai_usage(profile_id, day_utc, used_count, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(profile_id, day_utc) DO UPDATE SET
        used_count = used_count + 1,
        updated_at = excluded.updated_at
    `).bind(me.id, dayUtc, now).run();

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

  return reply({ error: 'Not found.' }, 404);
}
