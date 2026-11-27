// ONE OPEN LINE TO ZERODHA, REUSED (27 Nov 2026).
//
// Martin: "Also can you make the order placement like entry and exit much more
// quicker compared to Zerodha's own kite app where it places order instantly",
// and, offered this or a move to another host: "Let's try option 1 now and then
// think about 2 if needed".
//
// WHY EVERY CALL TOOK OVER A SECOND. Zerodha only takes orders from an address
// it has been told about, so every call leaves through the proxy in Bangalore,
// about 212 ms away from this server for one round trip (measured:
// GET /api/diag/egress). And every call opened its own line: connect to the
// proxy, ask it for a tunnel, agree encryption with Zerodha through it, and
// only then send the request — about five round trips, 1.1 s, for a single
// read of the funds. The library's default agent closes the line after each
// answer, so the next call paid it all again. An exit is two or more calls.
//
// WHAT THIS DOES. One agent, shared by every Zerodha client the app makes, that
// KEEPS its tunnels open and hands them to the next call: a call on an open
// line is one round trip. Nothing about WHAT is sent changes — the same
// requests, through the same proxy, from the same address.
//
//   - A line left idle for 30 s is closed by us, long before the proxy or
//     Zerodha would close it on theirs, so a call does not get handed a line
//     the other end has already dropped.
//   - A warmer makes one small read (the profile) every 15 s in market hours, so
//     an order that comes out of nowhere — a Telegram call, an SL — finds a line
//     already open instead of paying the 1.1 s.
//   - No request is ever sent twice by this: if a line fails under an order,
//     the order fails and says so, as before.
//   - KITE_KEEPALIVE=0 in the environment puts everything back as it was,
//     without a release.
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';

export const KEEPALIVE_IDLE_MS = 30000;
export const WARM_EVERY_MS = 15000;

type AgentOpts = { proxyUrl?: string; tls?: { rejectUnauthorized?: boolean } };
const counts = { newLines: 0, calls: 0, warmed: 0, warmFailed: 0, since: Date.now() };

/** A keep-alive agent: through the proxy when one is set, straight otherwise. */
export function makeKeepAliveAgent(o: AgentOpts = {}): https.Agent {
  const pool = { keepAlive: true, keepAliveMsecs: 10000, timeout: KEEPALIVE_IDLE_MS, maxSockets: 8, maxFreeSockets: 4, scheduling: 'lifo' as const, ...(o.tls || {}) };
  const agent: https.Agent = o.proxyUrl ? (new HttpsProxyAgent(o.proxyUrl, pool) as any) : new https.Agent(pool);
  // counted where a NEW line is made: a reused one never comes through here
  const make = (agent as any).createSocket;
  if (typeof make === 'function') (agent as any).createSocket = function (...a: any[]) { counts.newLines++; return make.apply(this, a); };
  return agent;
}

let shared: https.Agent | null = null;
let sharedFor = '';
export const keepAliveOn = () => String(process.env.KITE_KEEPALIVE ?? '1') !== '0';
function sharedAgent(): https.Agent {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (!shared || sharedFor !== proxyUrl) { try { shared?.destroy(); } catch (e) {} shared = makeKeepAliveAgent({ proxyUrl: proxyUrl || undefined }); sharedFor = proxyUrl; }
  return shared;
}

/** Gives a Zerodha client the shared open lines. The client is returned as it came when the switch is off. */
export function withKeepAlive<T>(kc: T, agent?: https.Agent): T {
  try {
    if (!keepAliveOn() && !agent) return kc;
    const inst: any = (kc as any)?.requestInstance;
    if (!inst?.defaults) return kc;                     // not the library's own client (the Dhan stand-in, a test double)
    const a = agent || sharedAgent();
    inst.defaults.httpsAgent = a;
    // Our agent does the tunnelling itself; axios must not add its own proxy handling on top.
    if (a instanceof (HttpsProxyAgent as any)) inst.defaults.proxy = false;
    if (!inst.__kaCounted) { inst.__kaCounted = true; inst.interceptors.request.use((r: any) => { counts.calls++; return r; }); }
  } catch (e) { /* the client still works, on the old path */ }
  return kc;
}

export function keepAliveStats() {
  const free = shared ? Object.values((shared as any).freeSockets || {}).reduce((n: number, l: any) => n + (l?.length || 0), 0) : 0;
  const busy = shared ? Object.values((shared as any).sockets || {}).reduce((n: number, l: any) => n + (l?.length || 0), 0) : 0;
  return { on: keepAliveOn(), viaProxy: !!sharedFor, calls: counts.calls, newLines: counts.newLines, reused: Math.max(0, counts.calls - counts.newLines), openIdle: free, openBusy: busy, warmed: counts.warmed, warmFailed: counts.warmFailed, sinceMs: Date.now() - counts.since };
}

/** Keeps a line open in market hours. `client` gives a logged-in client or null; `marketTime` says whether now counts. */
export function startKiteWarmer(client: () => any, marketTime: () => boolean, everyMs = WARM_EVERY_MS) {
  let busy = false;
  const t = setInterval(async () => {
    if (busy || !keepAliveOn() || !marketTime()) return;
    const kc = client();
    if (!kc?.access_token || typeof kc.getProfile !== 'function' || !kc.requestInstance) return;
    busy = true;
    try { await kc.getProfile(); counts.warmed++; } catch (e) { counts.warmFailed++; } finally { busy = false; }
  }, everyMs);
  if ((t as any).unref) (t as any).unref();
  return () => clearInterval(t);
}
