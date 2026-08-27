import axios from 'axios';
import { performanceTracker } from './performanceTracker';
import { toast } from 'sonner';

let isAlertActive = false;

// Endpoints served entirely from OUR server's local state (no Kite/broker call
// behind them). High frequency here cannot cause broker 429s, so they are
// exempt from the broker-block warning (stats are still tracked).
const LOCAL_ONLY_ENDPOINTS = new Set([
  '/api/exit-rules',
  '/api/delta',
  '/api/market-context',
  '/api/analytics',
  '/api/healthz',
]);

// Endpoints that DO sit in front of the broker but are served from a short shared
// server-side cache, so N requests inside the cache window cost ONE broker call
// (or none). Request frequency here is not broker frequency, and this warning
// counts HTTP requests — so without this list it fires on traffic that cannot
// cause a 429. Every entry must name the cache that makes it safe; if that cache
// is ever removed, the endpoint must come off this list.
const SERVER_CACHED_ENDPOINTS = new Map<string, string>([
  ['/api/positions-live', '1.5s shared cache + shared in-flight promise in server.ts'],
  ['/api/leverage', '55s per-symbol cache + shared in-flight promise in server/leverage.ts'],
]);

function showTooFrequentWarning(endpoint: string, rate: number) {
  if (isAlertActive) return;
  isAlertActive = true;
  
  toast.warning("⚡ HIGH FREQUENCY API WARNING", {
    description: `Endpoint ${endpoint} has been called ${rate} times in the last 15 seconds. Throttling is advised to prevent broker 429 blocks.`,
    duration: 6000,
    onAutoClose: () => { isAlertActive = false; },
    onDismiss: () => { isAlertActive = false; }
  });
}

export function initializeInterceptor() {
  // 1. Intercept standard Fetch
  try {
    const originalFetch = window.fetch;
    const interceptedFetch = async function (this: any, input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : (input as Request).url || '';
      
      // Only intercept local API endpoints
      const isLocalApi = url.startsWith('/api') || url.includes('/api/');
      if (!isLocalApi) {
        return originalFetch(input, init);
      }

      performanceTracker.incrementActiveCalls();
      performanceTracker.logQueryCacheMiss(); // standard network fetch counts as a query cache miss at fetch-level
      
      const start = performance.now();
      try {
        const response = await originalFetch(input, init);
        const duration = performance.now() - start;
        
        performanceTracker.logApiCall(url.split('?')[0], duration, false);
        
        // Check for high-frequency warnings
        const warnings = performanceTracker.getEndpointFrequencyWarnings();
        const warning = warnings.find(w => w.endpoint === url.split('?')[0]);
        if (warning && !LOCAL_ONLY_ENDPOINTS.has(warning.endpoint) && !SERVER_CACHED_ENDPOINTS.has(warning.endpoint)) {
          showTooFrequentWarning(warning.endpoint, warning.ratePer15s);
        }

        return response;
      } catch (error) {
        throw error;
      } finally {
        performanceTracker.decrementActiveCalls();
      }
    };

    Object.defineProperty(window, 'fetch', {
      value: interceptedFetch,
      writable: true,
      configurable: true,
    });
  } catch (err) {
    console.warn("Failed to intercept window.fetch. Falling back to non-intercepted fetch.", err);
  }

  // 2. Intercept Axios
  axios.interceptors.request.use(
    (config) => {
      performanceTracker.incrementActiveCalls();
      performanceTracker.logQueryCacheMiss();
      (config as any)._startTime = performance.now();
      return config;
    },
    (error) => {
      performanceTracker.decrementActiveCalls();
      return Promise.reject(error);
    }
  );

  axios.interceptors.response.use(
    (response) => {
      performanceTracker.decrementActiveCalls();
      const startTime = (response.config as any)._startTime;
      if (startTime) {
        const duration = performance.now() - startTime;
        const url = response.config.url || 'axios-api';
        
        performanceTracker.logApiCall(url.split('?')[0], duration, false);

        // Check frequency
        const warnings = performanceTracker.getEndpointFrequencyWarnings();
        const warning = warnings.find(w => w.endpoint === url.split('?')[0]);
        if (warning && !LOCAL_ONLY_ENDPOINTS.has(warning.endpoint) && !SERVER_CACHED_ENDPOINTS.has(warning.endpoint)) {
          showTooFrequentWarning(warning.endpoint, warning.ratePer15s);
        }
      }
      return response;
    },
    (error) => {
      performanceTracker.decrementActiveCalls();
      if (error.config && (error.config as any)._startTime) {
        const duration = performance.now() - (error.config as any)._startTime;
        const url = error.config.url || 'axios-api';
        performanceTracker.logApiCall(url.split('?')[0], duration, false);
      }
      return Promise.reject(error);
    }
  );
}
