// DHAN CONNECTION (11 Nov 2026) — step 2 of moving the terminal from Zerodha to
// Dhan. Martin's Zerodha API access ends 12 Nov; Dhan's Data API (₹499) gives
// live prices, candles, option chain and expired-option history, and its trading
// API is free.
//
// CREDENTIALS live only in Railway variables, never in code or logs:
//   DHAN_CLIENT_ID     — always needed
//   DHAN_PIN + DHAN_TOTP_SECRET — if both set, the app makes the day's token
//                        itself (Dhan's official TOTP route, auth.dhan.co).
//   DHAN_ACCESS_TOKEN  — a token generated on web.dhan.co (24 h), used otherwise.
//   DHAN_API_KEY / DHAN_API_SECRET — for the browser "Login to Dhan" route.
// A token made here is kept in the database with its expiry, so the TOTP route
// is called at most once per token lifetime (Dhan publishes no lockout rules —
// don't hammer it). The PIN and TOTP travel in the URL query string per Dhan's
// spec, so the URL is never logged.
//
// EGRESS: every call goes through axios, which follows HTTPS_PROXY — the
// Bangalore proxy whose IP (64.227.131.47) is whitelisted on Dhan. Dhan requires
// a whitelisted static IP for order placement.

import axios from 'axios';
import crypto from 'crypto';

const API = 'https://api.dhan.co/v2';
let D: { db: any } | null = null;

const env = (k: string) => (process.env[k] || '').trim();
export const dhanConfigured = () => !!env('DHAN_CLIENT_ID') && (!!env('DHAN_ACCESS_TOKEN') || (!!env('DHAN_PIN') && !!env('DHAN_TOTP_SECRET')));

// ---- RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from the base32 setup key ----
function base32(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of clean) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totpNow(secret: string, at = Date.now()): string {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = crypto.createHmac('sha1', base32(secret)).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

// ---- token ----
type Tok = { token: string; expiresAt: number; source: 'totp' | 'env' };
let tok: Tok | null = null;
let minting: Promise<Tok> | null = null;
let lastError = '';

function loadTok(): Tok | null {
  try { const r: any = D?.db.prepare("SELECT value FROM dhan_kv WHERE key='token'").get(); return r ? JSON.parse(r.value) : null; } catch { return null; }
}
function saveTok(t: Tok) {
  try { D?.db.prepare("INSERT INTO dhan_kv (key, value) VALUES ('token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(t)); } catch { }
}

async function mintByTotp(): Promise<Tok> {
  // Avoid the last 3 s of a 30 s window so the code is still valid on arrival.
  if ((Date.now() / 1000) % 30 > 27) await new Promise(r => setTimeout(r, 3500));
  const q = new URLSearchParams({ dhanClientId: env('DHAN_CLIENT_ID'), pin: env('DHAN_PIN'), totp: totpNow(env('DHAN_TOTP_SECRET')) });
  const r = await axios.post(`https://auth.dhan.co/app/generateAccessToken?${q}`, null, { timeout: 20000, validateStatus: () => true });
  const d: any = r.data || {};
  if (r.status !== 200 || !d.accessToken) throw new Error(`Dhan TOTP login refused (HTTP ${r.status}${d.message || d.errorMessage ? ': ' + (d.message || d.errorMessage) : ''})`);
  const exp = d.expiryTime ? Date.parse(String(d.expiryTime).replace(' ', 'T') + (/[zZ+]/.test(String(d.expiryTime).slice(-6)) ? '' : '+05:30')) : NaN;
  return { token: String(d.accessToken), expiresAt: isFinite(exp) ? exp : Date.now() + 23.5 * 3600e3, source: 'totp' };
}

export async function dhanToken(): Promise<string> {
  const fresh = (t: Tok | null) => t && t.expiresAt - Date.now() > 10 * 60e3;
  if (!fresh(tok)) tok = loadTok();
  if (fresh(tok)) return tok!.token;
  if (env('DHAN_PIN') && env('DHAN_TOTP_SECRET') && env('DHAN_CLIENT_ID')) {
    if (!minting) minting = mintByTotp().finally(() => { minting = null; });
    try { tok = await minting; saveTok(tok); lastError = ''; return tok.token; }
    catch (e: any) { lastError = e?.message || String(e); if (!env('DHAN_ACCESS_TOKEN')) throw e; }
  }
  if (env('DHAN_ACCESS_TOKEN')) { tok = { token: env('DHAN_ACCESS_TOKEN'), expiresAt: Date.now() + 3600e3, source: 'env' }; return tok.token; }
  throw new Error('Dhan is not set up: add DHAN_CLIENT_ID and either DHAN_PIN + DHAN_TOTP_SECRET or DHAN_ACCESS_TOKEN in Railway.');
}

// One call helper for every Dhan endpoint. A 401 drops the cached token once and
// retries, so an expired or revoked token heals itself on the TOTP route.
export async function dhanCall(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: any, retry = true): Promise<any> {
  const token = await dhanToken();
  const r = await axios.request({ method, url: `${API}${path}`, data: body, timeout: 20000, validateStatus: () => true,
    headers: { 'access-token': token, 'client-id': env('DHAN_CLIENT_ID'), 'Content-Type': 'application/json', Accept: 'application/json' } });
  if ((r.status === 401 || r.status === 403) && retry && tok?.source === 'totp') {
    tok = null; try { D?.db.prepare("DELETE FROM dhan_kv WHERE key='token'").run(); } catch { }
    return dhanCall(method, path, body, false);
  }
  if (r.status >= 400) {
    const d: any = r.data || {};
    throw Object.assign(new Error(`Dhan ${path} HTTP ${r.status}: ${d.errorMessage || d.message || d.remarks || JSON.stringify(d).slice(0, 200)}`), { status: r.status, data: d });
  }
  return r.data;
}

export function registerDhan(app: any, deps: { db: any }) {
  D = deps;
  D.db.exec('CREATE TABLE IF NOT EXISTS dhan_kv (key TEXT PRIMARY KEY, value TEXT)');
  // What is set up (yes/no only — never a value) and whether Dhan accepts it.
  app.get('/api/dhan/status', async (_req: any, res: any) => {
    const has = (k: string) => !!env(k);
    const out: any = {
      settings: { DHAN_CLIENT_ID: has('DHAN_CLIENT_ID'), DHAN_ACCESS_TOKEN: has('DHAN_ACCESS_TOKEN'), DHAN_API_KEY: has('DHAN_API_KEY'),
        DHAN_API_SECRET: has('DHAN_API_SECRET'), DHAN_PIN: has('DHAN_PIN'), DHAN_TOTP_SECRET: has('DHAN_TOTP_SECRET') },
      loginRoute: has('DHAN_PIN') && has('DHAN_TOTP_SECRET') ? 'automatic (TOTP)' : has('DHAN_ACCESS_TOKEN') ? 'token from web.dhan.co (24 h)' : 'not set',
    };
    try {
      const p = await dhanCall('GET', '/profile');
      out.connected = true; out.tokenSource = tok?.source; out.tokenValidUntilIst = tok ? new Date(tok.expiresAt + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : null;
      out.profile = { name: p.dhanClientName ? String(p.dhanClientName).split(' ')[0] : undefined, segments: p.activeSegment, dataPlan: p.dataPlan, dataValidity: p.dataValidity, ddpi: p.ddpi };
      try { const q = await dhanCall('POST', '/marketfeed/ltp', { IDX_I: [13] }); out.niftyLtp = q?.data?.IDX_I?.['13']?.last_price ?? null; out.dataApi = out.niftyLtp != null ? 'working' : 'no price returned'; }
      catch (e: any) { out.dataApi = `not working: ${e.message}`; }
    } catch (e: any) { out.connected = false; out.error = e.message; }
    if (lastError) out.lastLoginError = lastError;
    res.json(out);
  });
  console.log('[dhan] connection module registered');
}
