'use strict';

// VERSION and ASSETS come from the static site build.
const scope = new URL(self.registration.scope);
const cachePrefix = `study-os:${scope.href}:`;
const cacheName = cachePrefix + VERSION;
const assets = new Set(ASSETS.map((path) => new URL(path, scope).href));
const index = new URL('index.html', scope);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    try {
      await cache.addAll([...assets].map((url) => new Request(url, { cache: 'reload' })));
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(cachePrefix) && key !== cacheName)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const isHome = request.mode === 'navigate'
    && url.origin === scope.origin
    && (url.pathname === scope.pathname || url.pathname === index.pathname);
  const key = isHome ? index.href : url.href;
  if (assets.has(key)) {
    event.respondWith(caches.open(cacheName).then(async (cache) => (await cache.match(key)) || fetch(request)));
  }
});
