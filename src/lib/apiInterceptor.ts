import axios from 'axios';
import { performanceTracker } from './performanceTracker';
import { toast } from 'sonner';

let isAlertActive = false;

/** Pull the server's own processing time out of the Server-Timing header, so the
 *  breakdown can separate "the server was slow" from "the wire was slow". */
function readServerMs(h: string | null | undefined): number | undefined {
  if (!h) return undefined;
  const m = /app;dur=([0-9.]+)/.exec(h);
  if (!m) return undefined;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

// Endpoints served entirely from OUR server's local state (no Kite/broker call
// behind them). High frequency here cannot cause broker 429s, so they are
// exempt from the broker-block warning (stats are still tracked).
const LOCAL_ONLY_ENDPOINTS = new Set([
  '/api/exit-rules',
  '/api/delta',
  '/api/market-context',
  '/api/analytics',
  '/api/healthz',
  // Telegram Auto-Trade page poll: local SQLite rows + in-memory state only
  // (server/signal_trader.ts). It never calls Zerodha, so it cannot cause a 429.
  '/api/signals/status',
  // My Order sheet: the list is local SQLite; the preview subscribes the contract
  // to the live ticker on its first call and is answered from ticks after that.
  // Polled every 2-3 s while the sheet is open — without this the "too frequent"
  // warning Martin already found noisy would fire within a minute.
  '/api/signals/manual',
  '/api/signals/manual/',
  // Second-account card on the same page: local SQLite only.
  '/api/family/status',
  // Golden-zone Swap-Sweep watch card: local SQLite only.
  '/api/golden-sweep/status',
  // The SL/TP lines mirrored on the spot chart: Black-Scholes on the two latest
  // ticks the server already holds in memory, plus a lookup in the instrument
  // master (which the server refreshes once every 24h — the same reason
  // /api/contract-info is exempt below). No broker call per request. Polled
  // every 4 s while a trade is open, and twice more when a mirrored line is
  // dropped — which was enough to set the warning off on every drag on the
  // spot chart.
  '/api/premium-spot-map',
  // The Jodi card and the Strategy button's dot (server/jodi.ts): the read is the
  // Jodi's row out of the local database with the two prices the live feed
  // already holds. Every 2 s while a Jodi is waiting or running.
  '/api/jodi',
  // Price-age measurement: a clock ping each minute and a summary every 30 s.
  '/api/diag/time',
  '/api/diag/latency/client',
  // The report of a warning shown (see showTooFrequentWarning): a line in the
  // server's log, nothing more. It must never raise a warning of its own.
  '/api/diag/freq-warning',
]);

// COUNTED BY WHAT IT IS (18 Nov 2026). The warning counted a path, whatever was
// done to it — and the list of waiting orders is one path for two different
// things: reading the list (every five seconds, a row or two out of the local
// database, nothing asked of the broker) and setting an order to wait (once a
// tap, and that one does ask the broker what it will cost). Three reads are
// always inside any fifteen seconds; two orders set to wait a few seconds
// apart, each with the read that follows it, made seven — and the app warned
// about the broker over reads that never reach it. A request that is not a GET
// is now counted apart, under its method ("POST /api/triggers"), so a loop of
// writes is still caught, by its own count. And these are the paths whose READS
// are local, though a write to the same path is not: only their GETs are
// excused.
const LOCAL_ONLY_GET_ENDPOINTS = new Set([
  // SELECT from pending_triggers in the local SQLite file (server/triggers.ts).
  '/api/triggers',
]);

// Endpoints that DO sit in front of the broker but are served from a short shared
// server-side cache, so N requests inside the cache window cost ONE broker call
// (or none). Request frequency here is not broker frequency, and this warning
// counts HTTP requests — so without this list it fires on traffic that cannot
// cause a 429. Every entry must name the cache that makes it safe; if that cache
// is ever removed, the endpoint must come off this list.
const SERVER_CACHED_ENDPOINTS = new Map<string, string>([
  // THE SEARCH (17 Nov 2026). Martin, minutes after the search got its +: "I get
  // a error warning when I search and add options to list", with the toast
  // naming this endpoint, 6 times in 15 seconds. Typing is one call per pause
  // (300ms), so a few strikes looked up one after another pass 5 easily — and
  // the + made that the ordinary way to use it. The search is answered from
  // the contract list the server holds in memory (fetched from Zerodha once a
  // day), so typing asks the broker nothing and cannot earn a 429.
  ['/api/instruments/search', 'answered from the in-memory contract list (one broker fetch a day) in server/kite_service.ts'],
  // The home page's futures heatmap asks every 5 seconds while the market is
  // open; the server answers from one quote of every stock future kept 5 s.
  ['/api/futures-heatmap', '5s shared cache + shared in-flight promise in server/futures_heatmap.ts'],
  // THE OPTION CHAIN (18 Nov 2026). Martin: "High frequency api warnings still
  // appear" — this was the one: the chart reads the chain every 10 s, the
  // option chain sheet every 5 while it is open, the cards under the chart
  // every 15, and a change of expiry asks at once; six in fifteen seconds with
  // nothing looping. What the server does for each of them: the nearest expiry
  // of NIFTY, SENSEX and Bank Nifty is answered from the copy its own
  // ten-second loop keeps (no broker call for the request); any other expiry
  // shares one read of the broker for three seconds, and a read on its way is
  // waited for rather than repeated. So requests here are not broker requests.
  ['/api/option-chain', "nearest expiry: the 10s loop's copies in server.ts (latestChainData, latestSensexChainData, latestBankChainData); any other: 3s shared cache + shared in-flight promise in getLiveOptionChain, server/kite_service.ts"],
  // The funds: every chart on screen asks every 15 s (two on the desktop's
  // split view), and the journal's funds screen as well. The server keeps the
  // answer 2 s and shares a read on its way, and an order or an exit makes
  // the kept answer old at once.
  ['/api/margins', '2s shared cache + shared in-flight promise in server.ts; forgotten on /api/orders and /api/exit-position'],
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
  const { endpoint, isGet } = counted(rawEndpoint);
  if (isGet && LOCAL_ONLY_GET_ENDPOINTS.has(endpoint)) return true;
  if (LOCAL_ONLY_ENDPOINTS.has(endpoint) || SERVER_CACHED_ENDPOINTS.has(endpoint)) return true;
  for (const key of SERVER_CACHED_ENDPOINTS.keys()) if (key.endsWith('/') ? endpoint.includes(key) : endpoint === key) return true;
  for (const key of LOCAL_ONLY_ENDPOINTS) if (typeof key === 'string' && key.endsWith('/') && endpoint.includes(key)) return true;
  return false;
}

/** What a counted name is: the path, and whether it was a GET. A name is the
 *  path alone for a GET and "POST /api/x" (or PUT, PATCH, DELETE) otherwise —
 *  see COUNTED BY WHAT IT IS. An absolute URL (some wrappers rewrite fetch to
 *  one), a trailing slash, or letter case must not defeat the match. */
function counted(rawEndpoint: string): { endpoint: string; isGet: boolean } {
  let e = String(rawEndpoint || '').toLowerCase();
  const m = /^(post|put|patch|delete|head|options) /.exec(e);
  if (m) e = e.slice(m[0].length);
  return { endpoint: e.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, ''), isGet: !m };
}
/** The name a request is counted under for the warning. */
export function countedAs(method: string | undefined, path: string): string {
  const m = String(method || 'GET').toUpperCase();
  return m === 'GET' ? path : `${m} ${path}`;
}

function isExempt(rawEndpoint: string): boolean {
  const { endpoint, isGet } = counted(rawEndpoint);
  let exempt = false;
  if (isGet && LOCAL_ONLY_GET_ENDPOINTS.has(endpoint)) exempt = true;
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

declare const __APP_VERSION__: string;
function showTooFrequentWarning(endpoint: string, rate: number) {
  if (isAlertActive) return;
  isAlertActive = true;

  // Told to the server as well, each time (see /api/diag/freq-warning in
  // server/latency_diag.ts): which endpoint, how many, on which page. The toast
  // is gone in six seconds and was the only record there was.
  try {
    let screen = '';
    try { screen = sessionStorage.getItem('scalpPro') === '1' && window.location.pathname.startsWith('/advanced-chart') ? 'ScalperX' : ''; } catch (e) {}
    let version = '';
    try { version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''; } catch (e) {}
    void fetch('/api/diag/freq-warning', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, rate, page: window.location.pathname, screen, version }),
    }).catch(() => {});
  } catch (e) {}
  
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
        const serverMs = readServerMs(response.headers?.get?.('Server-Timing'));

        const path = url.split('?')[0];
        const method = init?.method || (typeof input !== 'string' && !(input instanceof URL) ? (input as Request).method : 'GET');
        const key = countedAs(method, path);
        performanceTracker.logApiCall(path, duration, false, serverMs, key);

        // Check for high-frequency warnings
        const warnings = performanceTracker.getEndpointFrequencyWarnings();
        const warning = warnings.find(w => w.endpoint === key);
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
        
        const path = url.split('?')[0];
        const key = countedAs(response.config.method, path);
        performanceTracker.logApiCall(path, duration, false, readServerMs((response.headers as any)?.['server-timing']), key);

        // Check frequency
        const warnings = performanceTracker.getEndpointFrequencyWarnings();
        const warning = warnings.find(w => w.endpoint === key);
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
        performanceTracker.logApiCall(url.split('?')[0], duration, false, undefined, countedAs(error.config.method, url.split('?')[0]));
      }
      return Promise.reject(error);
    }
  );
}
