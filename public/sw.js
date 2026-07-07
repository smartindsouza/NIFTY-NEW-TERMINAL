/**
 * NIFTY Quant Analytics Terminal — Service Worker (v3)
 *
 * Trading app => FRESH CODE and LIVE DATA matter more than offline support.
 *  - /api, /ws, /socket, /auth   -> pass straight through (never cached, never faked)
 *  - app shell / HTML            -> NETWORK-FIRST (a new deploy is always picked up online)
 *  - hashed build assets (js/css)-> NETWORK-FIRST with cache fallback.
 *
 * Why network-first for assets (this is the fix for the post-deploy white screen):
 * on every deploy the HTML (network-first) references brand-new hashed chunk
 * filenames. A cache-first asset rule can't have those yet, so it fell through to
 * a fetch that could race the deploy and get index.html back (MIME "text/html"),
 * crashing the module load and blanking the whole app. Fetching assets from the
 * network first — and only using cache when truly offline — removes that race.
 */

const CACHE_NAME = 'quant-terminal-v3';
const ASSET_RE = /\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|svg|webp|ico|gif)$/i;

self.addEventListener('install', () => {
  // Take over as soon as the new worker is installed.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Purge every older cache (also clears the old, unsafe cache-first assets).
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

  // Live endpoints: do NOT intercept.
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/socket') ||
    url.pathname.startsWith('/auth')
  ) {
    return;
  }

  // Hashed static build assets: NETWORK-FIRST, cache only as an offline fallback.
  // Filenames are content-hashed, so the freshest network copy is always correct;
  // the cache is a safety net for offline, never a source of stale/mismatched code.
  if (ASSET_RE.test(url.pathname)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        // Only cache a real, successful, same-origin asset response — never an
        // HTML error/redirect page (that was the "text/html" crash source).
        const ct = res.headers.get('content-type') || '';
        const looksHtml = ct.includes('text/html');
        if (res && res.status === 200 && res.type === 'basic' && !looksHtml) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, res.clone());
        }
        return res;
      } catch (e) {
        // Offline (or fetch failed): fall back to a cached copy if we have one.
        const cached = await caches.match(request);
        return cached || Response.error();
      }
    })());
    return;
  }

  // Navigations / HTML (the app shell): NETWORK-FIRST so freshly deployed code is
  // always used when online; fall back to the cached shell only when offline.
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
