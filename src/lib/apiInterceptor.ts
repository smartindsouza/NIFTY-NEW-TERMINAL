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
  // /api/ta is hit by SEVERAL legitimate one-shot and slow queries (main chart,
  // decision poll, 60-min + daily HTF, other-index prefetch) whose distinct URLs
  // all pool under this one path in the counter — a fresh page open alone makes
  // ~6 calls within seconds, none of them a loop. Server side it sits behind a
  // 60s shared cache with in-flight dedupe, a per-day futures-contract cache,
  // market-hours pre-warm and 350ms request spacing, so request frequency here
  // is not broker frequency.
  ['/api/ta', '60s shared TA cache + in-flight dedupe + pre-warm in server/technical_analysis.ts'],
  // Reads one row from the local SQLite exit-rule table and an in-memory map.
  // It never calls Zerodha, so a broker 429 is not a possible outcome here.
  // Client side it is behind a 3s shared cache with in-flight dedupe, shared
  // across both split-view panes (fetchArmedRule in AdvancedChart.tsx).
  ['/api/premium-exit/get', 'local SQLite read; 3s shared client cache + in-flight dedupe, no broker call'],
  // Looks a contract up in the NFO/BFO instrument master, which the server
  // refreshes once every 24h. No broker call per request, so a 429 cannot come
  // from it. Client side it is cached once per symbol for the session
  // (fetchContractInfo in AdvancedChart.tsx), shared by all three callers.
  ['/api/contract-info', 'instrument-master lookup, 24h server cache; once-per-symbol client cache, no broker call'],
  // Reads one row from the local app_settings table. No broker call, so a 429 is
  // not a possible outcome. Client side it is behind a 5s shared cache with
  // in-flight dedupe (fetchSetting in AdvancedChart.tsx), shared by both panes.
  ['/api/settings/', 'local SQLite settings read; 5s shared client cache + dedupe, no broker call'],
  // The dated H-levels journal: a local SQLite upsert, no broker call. Written
  // only on a real edit now (hydration no longer echoes the server's value back).
  ['/api/h-levels', 'local SQLite journal upsert, no broker call'],
]);

/**
 * Exact-match lists cannot cover endpoints whose PATH carries a parameter:
 * /api/settings/h_levels, /api/settings/h_levels_BANKNIFTY and so on are one
 * endpoint with many paths. Entries ending in '/' are therefore treated as
 * prefixes. Same safety rule as the exact entries: an endpoint only goes on the
 * list if it cannot reach the broker, and the reason is recorded beside it.
 */
// The last decision this function made, surfaced in App Diagnostics. Martin's
// 14:00 build provably exempts /api/settings/h_levels — the logic was executed
// against that exact string — and the toast still appeared, which cannot be
// explained from the source. Recording the decision alongside the endpoint
// string actually seen ends the argument between the code and the screen.
export const lastFrequencyDecision = { endpoint: '', exempt: false, at: 0 };

/** Exported so App Diagnostics can label endpoints the same way the toast does.
 *  Read-only: it does not record a decision. */
export function isFrequencyExempt(rawEndpoint: string): boolean {
  const endpoint = String(rawEndpoint || '').toLowerCase().replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '');
  if (LOCAL_ONLY_ENDPOINTS.has(endpoint) || SERVER_CACHED_ENDPOINTS.has(endpoint)) return true;
  for (const key of SERVER_CACHED_ENDPOINTS.keys()) if (key.endsWith('/') ? endpoint.includes(key) : endpoint === key) return true;
  for (const key of LOCAL_ONLY_ENDPOINTS) if (typeof key === 'string' && key.endsWith('/') && endpoint.includes(key)) return true;
  return false;
}

function isExempt(rawEndpoint: string): boolean {
  // Normalise: an absolute URL (some wrappers rewrite fetch to one), a trailing
  // slash, or letter case must not defeat the match.
  const endpoint = String(rawEndpoint || '').toLowerCase().replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '');
  let exempt = false;
  if (LOCAL_ONLY_ENDPOINTS.has(endpoint) || SERVER_CACHED_ENDPOINTS.has(endpoint)) exempt = true;
  if (!exempt) for (const key of SERVER_CACHED_ENDPOINTS.keys()) {
    if (key.endsWith('/') ? endpoint.includes(key) : endpoint === key) { exempt = true; break; }
  }
  if (!exempt) for (const key of LOCAL_ONLY_ENDPOINTS) {
    if (typeof key === 'string' && key.endsWith('/') && endpoint.includes(key)) { exempt = true; break; }
  }
  lastFrequencyDecision.endpoint = rawEndpoint; lastFrequencyDecision.exempt = exempt; lastFrequencyDecision.at = Date.now();
  return exempt;
}

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
        if (warning && !isExempt(warning.endpoint)) {
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
        if (warning && !isExempt(warning.endpoint)) {
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
