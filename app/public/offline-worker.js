'use strict';

// Build-time `tools/build_public_site.py` prepends `self.__STUDY_OS_VERSION__`
// and `self.__STUDY_OS_ASSETS__` into `dist/offline-worker.js`.
// Defaults below keep this file valid standalone (e.g. local dev server & `node --check`).
const CACHE_EPOCH = 'v2-option-b';
const BUILD_VERSION =
  (typeof self !== 'undefined' && typeof self.__STUDY_OS_VERSION__ === 'string' && self.__STUDY_OS_VERSION__)
    ? self.__STUDY_OS_VERSION__
    : '20261126-dev';

const OPTION_B_ICONS = [
  'favicon.ico',
  'pwa/favicon-48.png',
  'pwa/favicon-96.png',
  'pwa/study-os-192.png',
  'pwa/study-os-512.png',
];

const DEFAULT_ASSETS = [
  'index.html',
  'styles.css',
  'seo.css',
  '404.html',
  'app.webmanifest',
  ...OPTION_B_ICONS,
];

const RAW_ASSETS =
  (typeof self !== 'undefined' && Array.isArray(self.__STUDY_OS_ASSETS__) && self.__STUDY_OS_ASSETS__.length > 0)
    ? self.__STUDY_OS_ASSETS__
    : DEFAULT_ASSETS;

const scope = new URL(self.registration.scope);
const cachePrefix = `study-os:${scope.href}:`;
const cacheName = `${cachePrefix}${CACHE_EPOCH}:${BUILD_VERSION}`;

const precacheUrls = new Set(
  [...RAW_ASSETS, ...OPTION_B_ICONS]
    .filter((asset) => typeof asset === 'string' && asset && !asset.endsWith('offline-worker.js'))
    .map((asset) => new URL(asset, scope).href)
);

const indexUrl = new URL('index.html', scope);
const offlineFallbackUrl = new URL('404.html', scope);

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Offline · Study-OS</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#090d0c;color:#eff4f2;font:15.5px/1.55 -apple-system,BlinkMacSystemFont,"Inter",sans-serif}
    main{max-width:460px;padding:26px;border-radius:18px;background:#131a18;border:1px solid rgba(255,255,255,.1)}
    h1{margin:0 0 8px;font-size:22px}
    p{margin:0 0 16px;color:#93a59f}
    a{display:inline-block;padding:10px 16px;border-radius:999px;background:#34c78b;color:#091512;font-weight:700;text-decoration:none}
  </style>
</head>
<body>
  <main id="main-content">
    <h1>You are offline</h1>
    <p>This page has not been saved for offline use yet. Reconnect or return to the Study-OS workspace.</p>
    <a href="./">Open Study-OS</a>
  </main>
</body>
</html>`;

const NEVER_CACHE_PATH_RE =
  /(?:^|\/)(?:api|auth|oauth|oauth2|callback|login|logout|session|token|pdfcraft|downloads|member-library)(?:\/|$)/i;

const STATIC_ASSET_EXT_RE =
  /\.(?:css|js|mjs|json|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|webmanifest)$/i;

function shouldBypassCache(request, url) {
  if (request.method !== 'GET') return true;
  if (url.origin !== scope.origin) return true;
  if (url.pathname.endsWith('/offline-worker.js')) return true;
  if (NEVER_CACHE_PATH_RE.test(url.pathname)) return true;
  if (request.cache === 'no-store') return true;
  if (request.headers && request.headers.has('authorization')) return true;
  return false;
}

function isCacheableResponse(response) {
  if (!response || !response.ok || response.status !== 200) return false;
  if (response.type !== 'basic') return false;
  const cacheControl = (response.headers.get('cache-control') || '').toLowerCase();
  if (cacheControl.includes('no-store') || cacheControl.includes('private')) return false;
  if (response.headers.has('set-cookie')) return false;
  return true;
}

function canonicalCacheKey(url, isNavigation) {
  if (isNavigation && (url.pathname === scope.pathname || url.pathname === indexUrl.pathname)) {
    return indexUrl.href;
  }
  return `${url.origin}${url.pathname}`;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    try {
      await cache.addAll(
        [...precacheUrls].map((url) => new Request(url, { cache: 'reload' }))
      );
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(cachePrefix) && key !== cacheName)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (shouldBypassCache(request, url)) return;

  // 1. Network-first navigation with safe fallback to cached page / index.html / offline page
  if (request.mode === 'navigate') {
    const navKey = canonicalCacheKey(url, true);
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      try {
        const fresh = await fetch(request);
        if (isCacheableResponse(fresh)) {
          cache.put(navKey, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch {
        const exact = await cache.match(navKey);
        if (exact) return exact;
        const cachedIndex = await cache.match(indexUrl.href);
        if (cachedIndex) return cachedIndex;
        const cachedFallback = await cache.match(offlineFallbackUrl.href);
        if (cachedFallback) return cachedFallback;
        return new Response(OFFLINE_HTML, {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // 2. Stale-while-revalidate for precached & same-origin static assets (CSS, JS including js/core/**, icons, fonts, static JSON)
  const assetKey = canonicalCacheKey(url, false);
  const isKnownStatic = precacheUrls.has(assetKey) || STATIC_ASSET_EXT_RE.test(url.pathname);
  if (!isKnownStatic) return;

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(assetKey);
    const networkFetch = fetch(request).then((response) => {
      if (isCacheableResponse(response)) {
        cache.put(assetKey, response.clone()).catch(() => {});
      }
      return response;
    });

    if (cached) {
      event.waitUntil(networkFetch.catch(() => {}));
      return cached;
    }

    try {
      return await networkFetch;
    } catch {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
