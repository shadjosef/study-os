/**
 * Optional Cloudflare Edge GEO Worker for https://studyos.no
 *
 * Activate once `studyos.no` nameservers move from `ns.datacenter.no` to a free Cloudflare DNS zone
 * proxied in front of GitHub Pages:
 *   1. Content negotiation: Serves the clean `.md` mirror (`text/markdown; charset=utf-8`) whenever
 *      a client/agent requests `Accept: text/markdown` on any public HTML page (with `Vary: Accept`).
 *   2. Discovery headers: Adds `Link: <...md>; rel="alternate"; type="text/markdown"` on HTML pages
 *      so crawlers discover Markdown mirrors even from HTTP HEAD / headers alone.
 *   3. Privacy-safe AI crawler logging: Logs daily hit counts for ClaudeBot, PerplexityBot,
 *      OAI-SearchBot, GPTBot, Google-Extended, etc. into D1 (`ai_bot_daily_hits`) via `waitUntil`
 *      with zero IP addresses or PII stored.
 */

const AI_BOT_PATTERNS = [
  ['Claude-SearchBot', /Claude-SearchBot/i],
  ['Claude-User', /Claude-User/i],
  ['ClaudeBot', /ClaudeBot/i],
  ['Perplexity-User', /Perplexity-User/i],
  ['PerplexityBot', /PerplexityBot/i],
  ['OAI-SearchBot', /OAI-SearchBot/i],
  ['ChatGPT-User', /ChatGPT-User/i],
  ['GPTBot', /GPTBot/i],
  ['Google-Extended', /Google-Extended/i],
  ['Applebot-Extended', /Applebot-Extended/i],
  ['DeepSeekBot', /DeepSeek/i],
  ['CCBot', /CCBot/i],
];

const PUBLIC_MD_PAGES = new Set([
  '/',
  '/index.html',
  '/bi-oslo.html',
  '/norsk.html',
  '/wiseflow-practice.html',
  '/bi-canvas-timeedit-sync.html',
  '/notes.html',
  '/universities.html',
  '/gpa-calculator.html',
  '/compare.html',
  '/privacy.html',
  '/terms.html',
  '/courses/econ-2522.html',
  '/courses/acct-2527.html',
  '/courses/ob-2537.html',
  '/courses/prog-3021.html',
  '/courses/math-2588.html',
  '/uni/uia.html',
  '/uni/ntnu.html',
  '/uni/uio.html',
  '/uni/nhh.html',
  '/uni/uib.html',
  '/uni/oslomet.html',
  '/uni/canvas-lms.html',
]);

function detectAiBot(ua) {
  if (!ua) return null;
  for (const [label, re] of AI_BOT_PATTERNS) {
    if (re.test(ua)) return label;
  }
  return null;
}

function markdownMirrorPath(pathname) {
  if (pathname === '/' || pathname === '/index.html') return '/index.md';
  if (PUBLIC_MD_PAGES.has(pathname) && pathname.endsWith('.html')) {
    return pathname.slice(0, -5) + '.md';
  }
  return null;
}

async function recordBotHit(db, bot, path, servedFormat) {
  if (!db) return;
  const now = new Date();
  const dayUtc = now.toISOString().slice(0, 10);
  const ts = now.toISOString();
  await db.prepare(
    `INSERT INTO ai_bot_daily_hits (day_utc, bot, path, served_format, hits, last_seen_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(day_utc, bot, path, served_format)
     DO UPDATE SET hits = hits + 1, last_seen_at = excluded.last_seen_at`
  ).bind(dayUtc, bot, path.slice(0, 180), servedFormat, ts).run();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    const accept = request.headers.get('accept') || '';
    const ua = request.headers.get('user-agent') || '';
    const bot = detectAiBot(ua);
    const mdPath = isRead ? markdownMirrorPath(url.pathname) : null;
    const wantsMarkdown = Boolean(mdPath && /\btext\/markdown\b/i.test(accept));

    if (wantsMarkdown) {
      const mdUrl = new URL(mdPath, url.origin);
      const upstream = await fetch(mdUrl.toString(), {
        method,
        headers: { 'User-Agent': ua || 'Study-OS-Edge-GEO/1.0' },
      });
      if (upstream.ok) {
        const headers = new Headers(upstream.headers);
        headers.set('Content-Type', 'text/markdown; charset=utf-8');
        headers.set('Vary', 'Accept');
        headers.set('X-Markdown-Source', mdPath);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        if (bot && env?.DB) {
          ctx?.waitUntil?.(recordBotHit(env.DB, bot, url.pathname, 'markdown-negotiated').catch(() => {}));
        }
        return new Response(method === 'HEAD' ? null : upstream.body, {
          status: upstream.status,
          headers,
        });
      }
    }

    const response = await fetch(request);
    if (!isRead) return response;

    if (bot && env?.DB) {
      const fmt = url.pathname.endsWith('.md') || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt'
        ? 'markdown-direct'
        : 'html';
      ctx?.waitUntil?.(recordBotHit(env.DB, bot, url.pathname, fmt).catch(() => {}));
    }

    if (mdPath && response.ok) {
      const headers = new Headers(response.headers);
      headers.append('Link', `<${url.origin}${mdPath}>; rel="alternate"; type="text/markdown"`);
      headers.append('Vary', 'Accept');
      return new Response(method === 'HEAD' ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return response;
  },
};
