import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initializeInterceptor } from './lib/apiInterceptor';
import { initPositionCardLog } from './lib/positionCardLog';
import { restoreOptionList } from './lib/optionListStore';

// Initialize global performance trackers for API speeds and frequency warnings
initializeInterceptor();
// A note to the server each time a trade is put into, or emptied from, the saved copy of open trades.
initPositionCardLog();
// The list of option charts, put back from the device's lasting storage before any screen reads it.
restoreOptionList();

// Self-heal after a deploy: if a lazily-imported chunk 404s because the build
// changed underneath an open tab (the "Failed to fetch dynamically imported
// module" / "text/html MIME" white screen), reload ONCE to pull the fresh build.
// The sessionStorage guard prevents an infinite reload loop if it's a real error.
function isChunkLoadError(msg: string): boolean {
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|expected a JavaScript-or-Wasm module/i.test(msg);
}
function reloadOnceForChunkError(reason: string) {
  if (!isChunkLoadError(reason)) return;
  const KEY = 'chunk-reload-attempted';
  if (sessionStorage.getItem(KEY)) return; // already tried once — let the error show
  sessionStorage.setItem(KEY, '1');
  window.location.reload();
}
// Clear the guard on a fully successful load so future deploys can self-heal too.
window.addEventListener('load', () => {
  setTimeout(() => { try { sessionStorage.removeItem('chunk-reload-attempted'); } catch {} }, 4000);
});
window.addEventListener('error', (e) => {
  const msg = (e?.message || '') + ' ' + ((e as any)?.filename || '');
  reloadOnceForChunkError(msg);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e as any)?.reason?.message || (e as any)?.reason || '');
  reloadOnceForChunkError(msg);
});

// Register progressive service worker for offline shell caching and installation hooks
if ('serviceWorker' in navigator) {
  // Read as the page starts, before the worker is even asked for: whether a
  // worker was serving this page when it loaded (see NOT WHEN THERE WAS NO
  // WORKER BEFORE, below). Read any later, a fast first install could already
  // have taken the page over.
  const hadWorker = !!navigator.serviceWorker.controller;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        console.log('[PWA SW] Active and registered with scope:', reg.scope);
        // If a new worker takes control mid-session, reload once so the running
        // page and the active worker/build are always in sync.
        // NOT WHEN THERE WAS NO WORKER BEFORE (17 Nov 2026). On a first open the
        // worker installs and takes the page over — and this reloaded it, so the
        // whole app loaded twice (timed on the live app: every read made again
        // three seconds in). A page no worker had is already running the build
        // the worker serves; there is nothing to swap. A worker replacing another
        // still reloads, as before.
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!hadWorker) return;
          if (refreshing) return;
          refreshing = true;
          window.location.reload();
        });
      })
      .catch((err) => {
        console.error('[PWA SW] Installation failed:', err);
      });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// THE SCREEN STAYS ON (18 Nov 2026). Martin: "make sure my display remains on
// and doesn't go to sleep whenever my web app is open". A screen wake lock,
// held while the app is the visible page. The browser drops it whenever the
// app is hidden (another tab, the home screen, the phone locked by hand), so it
// is asked for again each time the app comes back; some browsers only grant it
// after a touch, so the first touch asks too. Where the browser has no wake
// lock (iPhone home-screen apps before iOS 18.4) nothing happens.
(() => {
  const nav: any = navigator;
  if (!nav.wakeLock || typeof nav.wakeLock.request !== 'function') return;
  let lock: any = null;
  const hold = async () => {
    if (document.visibilityState !== 'visible' || (lock && !lock.released)) return;
    try { lock = await nav.wakeLock.request('screen'); } catch (e) { lock = null; }
  };
  document.addEventListener('visibilitychange', () => { void hold(); });
  window.addEventListener('focus', () => { void hold(); });
  window.addEventListener('pointerdown', () => { void hold(); }, { passive: true });
  void hold();
})();
