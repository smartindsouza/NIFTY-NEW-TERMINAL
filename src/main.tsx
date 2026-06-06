import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initializeInterceptor } from './lib/apiInterceptor';

// Initialize global performance trackers for API speeds and frequency warnings
initializeInterceptor();

// Register progressive service worker for offline shell caching and installation hooks
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        console.log('[PWA SW] Active and registered with scope:', reg.scope);
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

