const checks = new Map([
  ['/join', 'signup'],
  ['/auth/google/complete', 'signup'],
  ['/auth/link-redeem', 'link'],
  ['/auth/recovery', 'recovery'],
]);

const rateOnlyPaths = new Map([
  ['/auth/google', 'google'],
  ['/auth/extension-link', 'extlink'],
  ['/auth/passkey/login/options', 'passkey_opts'],
  ['/auth/passkey/login/verify', 'passkey_verify'],
  ['/auth/redeem-code', 'redeem'],
]);

function safeHostname(origin) {
  if (typeof origin !== 'string' || !origin) return '';
  try { return new URL(origin).hostname; } catch { return ''; }
}

export function turnstileSiteKey(env) {
  return env.TURNSTILE_SECRET_KEY?.trim() && env.TURNSTILE_SITE_KEY?.trim() || '';
}

export async function checkHuman(request, env, path, data, reply) {
  const action = checks.get(path);
  const rateAction = action || rateOnlyPaths.get(path) || '';
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
  const expectedHost = safeHostname(request.headers.get('Origin'));
  if (!expectedHost) {
    return reply({ error: 'The security check expired or failed. Try again.' }, 403);
  }
  try {
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
    if (client) form.set('remoteip', client);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    const result = await res.json();
    if (res.ok && result.success === true && result.action === action &&
        result.hostname === expectedHost) return null;
    return reply({ error: 'The security check expired or failed. Try again.' }, 403);
  } catch {
    return reply({ error: 'The security check is temporarily unavailable. Try again shortly.' }, 503);
  }
}
