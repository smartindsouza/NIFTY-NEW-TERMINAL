/**
 * NIFTY Quant Analytics Terminal — Service Worker (v2)
 *
 * Trading app => FRESH CODE and LIVE DATA matter more than offline support.
 *  - /api, /ws, /socket, /auth   -> pass straight through (never cached, never faked)
 *  - app shell / HTML            -> NETWORK-FIRST (a new deploy is always picked up online)
 *  - hashed build assets (js/css)-> cache-first (filenames change each build, so this is safe)
 */

const CACHE_NAME = 'quant-terminal-v2';
const ASSET_RE = /\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|svg|webp|ico|gif)$/i;

self.addEventListener('install', () => {
  // Take over as soon as the new worker is installed (don't wait for all tabs to close)
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Purge every older cache (this also clears the old, unsafe cache-first shell from v1)
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only same-origin GET requests are ever eligible for handling.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Live endpoints: do NOT intercept. Let the browser fetch normally so real errors surface
  // and stale/offline data is never served on a real-money screen.
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/socket') ||
    url.pathname.startsWith('/auth')
  ) {
    return;
  }

  // Hashed static build assets: cache-first (safe — every build emits new filenames).
  if (ASSET_RE.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const res = await fetch(request);
        if (res && res.status === 200 && res.type === 'basic') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, res.clone());
        }
        return res;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // Navigations / HTML (the app shell): NETWORK-FIRST so freshly deployed code is always used
  // when online; fall back to the cached shell only when the device is offline.
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('/', res.clone());
        return res;
      } catch (e) {
        const cached = (await caches.match(request)) || (await caches.match('/'));
        return cached || Response.error();
      }
    })());
    return;
  }

  // Everything else: network-first, no caching.
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
