const checks = new Map([
  ['/join', 'signup'],
  ['/auth/google/complete', 'signup'],
  ['/auth/link-redeem', 'link'],
  ['/auth/recovery', 'recovery'],
]);

export function turnstileSiteKey(env) {
  return env.TURNSTILE_SECRET_KEY?.trim() && env.TURNSTILE_SITE_KEY?.trim() || '';
}

export async function checkHuman(request, env, path, data, reply) {
  const action = checks.get(path);
  const rateAction = action || (path === '/auth/google' ? 'google' : '');
  if (!rateAction || request.method !== 'POST') return null;
  const client = request.headers.get('CF-Connecting-IP');
  if (client && env.AUTH_RATE_LIMIT) {
    const { success } = await env.AUTH_RATE_LIMIT.limit({ key: rateAction + ':' + client });
    if (!success) return reply({ error: 'Too many attempts. Wait a minute and try again.' }, 429);
  }
  if (!action || !turnstileSiteKey(env)) return null;
  const token = data.humanToken;
  if (typeof token !== 'string' || !token || token.length > 2048) {
    return reply({ error: 'Complete the security check to continue.' }, 403);
  }
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
      signal: AbortSignal.timeout(8000),
    });
    const result = await res.json();
    if (res.ok && result.success === true && result.action === action &&
        result.hostname === new URL(request.headers.get('Origin')).hostname) return null;
    return reply({ error: 'The security check expired or failed. Try again.' }, 403);
  } catch {
    return reply({ error: 'The security check is temporarily unavailable. Try again shortly.' }, 503);
  }
}
