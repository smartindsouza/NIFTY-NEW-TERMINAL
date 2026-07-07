import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initializeInterceptor } from './lib/apiInterceptor';

// Initialize global performance trackers for API speeds and frequency warnings
initializeInterceptor();

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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        console.log('[PWA SW] Active and registered with scope:', reg.scope);
        // If a new worker takes control mid-session, reload once so the running
        // page and the active worker/build are always in sync.
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
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
