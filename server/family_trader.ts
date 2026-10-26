// SECOND ACCOUNT — Telegram calls on Martin's wife's Zerodha account (26 Oct 2026).
//
// Martin asked for his wife's account to take the channel's calls too, and for it
// to be built so it cannot break anything that already works. So this module is a
// FOLLOWER that stands entirely on its own:
//
//   • Its own tables (family_tokens, family_trades) and its own settings key. It
//     never writes to kite_tokens, signal_calls, signal_trades, premium_exit_rules
//     or the trade journal. It READS signal_calls, nothing else of Martin's.
//   • Its own Kite login and client, from FAMILY_KITE_API_KEY / _SECRET. Martin's
//     session is "the newest kite_tokens row for today", so logging her in through
//     the normal login would silently have made the whole app trade HER account.
//     Her token therefore lives in its own table and is only ever used here.
//   • Her login is refused unless the Zerodha user id is FAMILY_KITE_USER_ID, and
//     refused if it is Martin's own id — so the slot can never end up trading
//     Martin's account twice.
//   • Prices come from Martin's live feed (her app can be Zerodha's free
//     "Personal" API, which has no market data). Only orders go to her account.
//   • Exits are this module's own: the same ladder rules as Martin's trades
//     (signal_ladder.ts, used read-only), checked on every tick, and a LIMIT sell
//     on her account for her quantity only, MIS only — never more than it bought,
//     so a position she holds herself in the same contract is not touched.
//   • Nothing runs unless FAMILY_KITE_API_KEY is set and her mode is not OFF.
//
// What it shares with Martin's engine (read-only hooks in signal_trader.ts): the
// complete call (entry range + TP/SL), the timing rules (points above range, wait,
// last entry, square-off), the clock, the alert bot and the PIN. Her own settings:
// Off / Practice / Live, lots (or max by her funds) and max trades a day. She takes
// the channel's calls whether Martin's own auto-trade is on or off.

import express from 'express';
import { KiteConnect } from 'kiteconnect';
import { validateSetup } from './signal_parser';
import { createLadder, onLadderPrice, keepTrailing, type LadderState, type LadderAction } from './signal_ladder';
import { onSignalCall, onSignalButton, signalTiming, signalNowMs, signalNotify, signalPinOk } from './signal_trader';

export interface FamilyDeps {
  db: any;
  getLatestTick: (token: number) => { ltp: number; ts: number } | undefined;
  getMartinKite: () => any;                 // prices only (getLTP)
  getMartinUserId: () => string | null;     // her login must not be this
  findOption: (u: 'NIFTY' | 'SENSEX', strike: number, type: 'CE' | 'PE', todayIst: string) =>
    Promise<{ tradingsymbol: string; instrument_token: number; exchange: string; lot_size: number; expiry: string } | null>;
  refreshSubscriptions: () => void;
  // tests only
  makeKite?: (accessToken: string) => any;
  generateSession?: (requestToken: string) => Promise<{ access_token: string; user_id: string; user_name?: string }>;
}

type Mode = 'OFF' | 'PRACTICE' | 'LIVE';
interface FamSettings { mode: Mode; name: string; lots: number | 'MAX'; maxLotsCap: number; maxTrades: number }
const DEFAULTS: FamSettings = { mode: 'OFF', name: 'Second account', lots: 1, maxLotsCap: 10, maxTrades: 3 };

let D: FamilyDeps;
let S: FamSettings = { ...DEFAULTS };

const istParts = (ms = signalNowMs()) => {
  const d = new Date(ms + 5.5 * 3600000);
  return { date: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.getUTCDay() };
};
const hm = (s: string) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const tick05 = (x: number) => Math.floor(x / 0.05 + 1e-6) * 0.05;
const r2 = (x: number) => Math.round(x * 100) / 100;
const rs = (x: number) => `₹${r2(x).toLocaleString('en-IN')}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const who = () => `👤 ${S.name}`;

// ---------- persistence ----------
function initTables() {
  D.db.exec(`CREATE TABLE IF NOT EXISTS family_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, access_token TEXT, token_date TEXT, user_id TEXT, user_name TEXT, created_at INTEGER)`);
  D.db.exec(`CREATE TABLE IF NOT EXISTS family_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT, call_id INTEGER UNIQUE, day TEXT, mode TEXT,
    underlying TEXT, strike REAL, option_type TEXT, entry_low REAL, entry_high REAL, sl REAL, tp1 REAL, tp2 REAL, tp3 REAL,
    tradingsymbol TEXT, exchange TEXT, token INTEGER, lot_size INTEGER, expiry TEXT, watch_until INTEGER,
    qty INTEGER, entry REAL, entry_at INTEGER, order_id TEXT, ladder TEXT, status TEXT, reason TEXT, last_ltp REAL,
    exit_price REAL, exit_at INTEGER, exit_reason TEXT, pnl REAL, created_at INTEGER, updated_at INTEGER)`);
}
const getKV = (k: string): any => {
  try { const r = D.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k); return r ? JSON.parse(r.value) : null; } catch { return null; }
};
const setKV = (k: string, v: any) => {
  D.db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(k, JSON.stringify(v), Date.now());
};
const loadSettings = () => { S = { ...DEFAULTS, ...(getKV('family_settings') || {}) }; };
const saveSettings = () => setKV('family_settings', S);
const row = (id: number): any => D.db.prepare('SELECT * FROM family_trades WHERE id = ?').get(id);
const setRow = (id: number, f: Record<string, any>) => {
  const keys = Object.keys(f);
  D.db.prepare(`UPDATE family_trades SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => f[k]), Date.now(), id);
};
const log = (text: string) => console.log('[family]', text);
const notify = (text: string, buttons?: { text: string; data?: string; url?: string }[]) =>
  signalNotify(`${who()} · ${text}`, buttons).catch(() => { });

// ---------- her Zerodha session ----------
export const familyConfigured = () => !!(process.env.FAMILY_KITE_API_KEY && process.env.FAMILY_KITE_API_SECRET && process.env.FAMILY_KITE_USER_ID);
let kcCache: { token: string; kc: any } | null = null;
function tokenRow(): any {
  try { return D.db.prepare('SELECT * FROM family_tokens WHERE token_date = ? ORDER BY id DESC LIMIT 1').get(new Date().toISOString().slice(0, 10)); }
  catch { return null; }
}
function famKite(): any | null {
  if (!process.env.FAMILY_KITE_API_KEY) return null;
  const t = tokenRow();
  if (!t?.access_token) return null;
  if (kcCache?.token === t.access_token) return kcCache.kc;
  let kc: any;
  if (D.makeKite) kc = D.makeKite(t.access_token);
  else { kc = new KiteConnect({ api_key: process.env.FAMILY_KITE_API_KEY! }); kc.setAccessToken(t.access_token); }
  kcCache = { token: t.access_token, kc };
  return kc;
}

// ---------- prices (Martin's feed) ----------
const lastRestAt = new Map<number, number>(), restLtp = new Map<number, number>();
async function priceOf(token: number, exchange: string, tradingsymbol: string): Promise<number | null> {
  const t = D.getLatestTick(token);
  if (t && Date.now() - t.ts < 3000 && t.ltp > 0) return t.ltp;
  if ((lastRestAt.get(token) || 0) > Date.now() - 500) return restLtp.get(token) ?? null;
  lastRestAt.set(token, Date.now());
  try {
    const kc = D.getMartinKite();
    if (!kc || !kc.access_token) return null;
    const k = `${exchange}:${tradingsymbol}`;
    const q = await kc.getLTP([k]);
    const v = q?.[k]?.last_price;
    if (typeof v === 'number' && v > 0) { restLtp.set(token, v); return v; }
  } catch { }
  return null;
}
const watchTokens = new Set<number>();
export function familyTokens(): number[] { return Array.from(watchTokens); }

// ---------- a call from the channel ----------
const tradesToday = () => (D.db.prepare("SELECT COUNT(*) AS n FROM family_trades WHERE day = ? AND mode = ? AND entry IS NOT NULL")
  .get(istParts().date, S.mode) as any).n as number;
function record(c: any, status: string, reason: string | null, extra: Record<string, any> = {}): number | null {
  try {
    const r = D.db.prepare(`INSERT OR IGNORE INTO family_trades (call_id, day, mode, underlying, strike, option_type, entry_low, entry_high,
      sl, tp1, tp2, tp3, status, reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(c.id, istParts().date, S.mode, c.underlying, c.strike, c.option_type, c.entry_low, c.entry_high,
        c.sl, c.tp1, c.tp2, c.tp3, status, reason, Date.now(), Date.now());
    if (!r.changes) return null;
    const id = Number(r.lastInsertRowid);
    if (Object.keys(extra).length) setRow(id, extra);
    return id;
  } catch (e: any) { log(`record failed: ${e?.message || e}`); return null; }
}

async function onCall(callId: number) {
  if (S.mode === 'OFF' || !process.env.FAMILY_KITE_API_KEY) return;
  const c: any = D.db.prepare('SELECT * FROM signal_calls WHERE id = ?').get(callId);
  if (!c || (c.source && c.source !== 'telegram') || c.sl == null) return;
  if (D.db.prepare('SELECT 1 FROM family_trades WHERE call_id = ?').get(callId)) return;
  const what = `${c.underlying} ${c.strike} ${c.option_type}`;
  const T = signalTiming();
  const skip = (reason: string, loud = false) => { record(c, 'SKIPPED', reason); log(`skipped ${what}: ${reason}`); if (loud) void notify(`⏭ SKIPPED ${what}: ${reason}`); };

  const bad = validateSetup({ underlying: c.underlying, strike: c.strike, optionType: c.option_type, entryLow: c.entry_low, entryHigh: c.entry_high },
    { sl: c.sl, tps: [c.tp1, c.tp2, c.tp3] });
  if (bad) return skip(bad);
  const t = istParts();
  if (t.day === 0 || t.day === 6 || t.mins < 9 * 60 + 15) return skip('market is not open');
  if (t.mins > hm(T.lastEntry)) return skip(`after the last entry time (${T.lastEntry})`);
  if (tradesToday() >= S.maxTrades) return skip(`already ${S.maxTrades} trades today`, true);
  if (S.mode === 'LIVE' && !famKite()) return skip('her Zerodha is not logged in today', true);
  const opt = await D.findOption(c.underlying, c.strike, c.option_type, t.date).catch(() => null);
  if (!opt || !opt.lot_size) return skip(`could not find the ${what} contract`, true);
  const holding = D.db.prepare("SELECT 1 FROM family_trades WHERE tradingsymbol = ? AND status IN ('ORDERED','OPEN','CLOSING')").get(opt.tradingsymbol);
  if (holding) return skip('already holding this contract from an earlier call');

  const id = record(c, 'WATCHING', null, {
    tradingsymbol: opt.tradingsymbol, exchange: opt.exchange, token: opt.instrument_token, lot_size: opt.lot_size, expiry: opt.expiry,
    watch_until: Date.now() + T.waitMin * 60000,
  });
  if (!id) return;
  watchTokens.add(opt.instrument_token);
  try { D.refreshSubscriptions(); } catch { }
  if (S.lots === 'MAX') presize(id);
  log(`${S.mode === 'LIVE' ? '' : '[practice] '}watching ${opt.tradingsymbol} for ≤ ${r2(c.entry_high + T.allowAbove)}`);
  await checkWatching(id);
}

// ---------- entry ----------
const entering = new Set<number>();
async function checkWatching(id: number) {
  if (entering.has(id)) return;
  entering.add(id);
  try {
    const r = row(id);
    if (!r || r.status !== 'WATCHING') return;
    const T = signalTiming();
    const skip = (reason: string) => { setRow(id, { status: 'SKIPPED', reason }); log(`skipped ${r.tradingsymbol}: ${reason}`); };
    if (S.mode === 'OFF') return skip('switched OFF');
    if (Date.now() > r.watch_until) return skip(`price never came into range within ${T.waitMin} min`);
    if (istParts().mins > hm(T.lastEntry)) return skip('reached the last entry time');
    const ltp = await priceOf(r.token, r.exchange, r.tradingsymbol);
    if (ltp == null) return;
    const cap = r2(r.entry_high + T.allowAbove);
    if (ltp <= r.sl) return skip(`price ${ltp} is already at/below the SL ${r.sl}`);
    if (ltp > cap) return;
    await enter(r, ltp, cap);
  } catch (e: any) { log(`check ${id} failed: ${e?.message || e}`); }
  finally { entering.delete(id); }
}

// MAX lots on HER funds — the same arithmetic as Martin's (98.5% of her live
// balance over Zerodha's own margin for one lot at the cap), never above her cap.
const sizing = new Map<number, { at: number; p: Promise<{ lots: number; note: string | null }> }>();
async function sizeMaxLots(r: any, cap: number): Promise<{ lots: number; note: string | null }> {
  const ceiling = Math.max(1, Math.min(25, Math.round(S.maxLotsCap || 10)));
  try {
    const kc = famKite();
    if (!kc) return { lots: 1, note: 'MAX sizing: not logged in — 1 lot' };
    const [mg, funds] = await Promise.all([
      kc.orderMargins([{ exchange: r.exchange, tradingsymbol: r.tradingsymbol, transaction_type: 'BUY', variety: 'regular',
        product: 'MIS', order_type: 'LIMIT', quantity: r.lot_size, price: r2(tick05(cap)), trigger_price: 0 }]),
      kc.getMargins(),
    ]);
    const perLot = Number(mg?.[0]?.total) + (Number(mg?.[0]?.charges?.total) || 0);
    const available = Number(funds?.equity?.available?.live_balance ?? funds?.equity?.net);
    if (!(perLot > 0) || !isFinite(available)) return { lots: 1, note: 'MAX sizing: could not read her funds — 1 lot' };
    const fit = Math.floor((available * 0.985) / perLot);
    return { lots: Math.min(ceiling, fit), note: `MAX: ₹${Math.round(available).toLocaleString('en-IN')} available → ${Math.min(ceiling, fit)} lot(s)` };
  } catch (e: any) { return { lots: 1, note: `MAX sizing failed (${e?.message || e}) — 1 lot` }; }
}
function presize(id: number) {
  const r = row(id); if (!r) return;
  sizing.set(id, { at: Date.now(), p: sizeMaxLots(r, r2(r.entry_high + signalTiming().allowAbove)) });
}

async function enter(r: any, ltp: number, cap: number) {
  let lots = 1, note: string | null = null;
  if (S.lots === 'MAX') {
    let s = sizing.get(r.id);
    if (!s || Date.now() - s.at > 60000) { presize(r.id); s = sizing.get(r.id)!; }
    ({ lots, note } = await s.p);
    sizing.delete(r.id);
    if (lots < 1) { setRow(r.id, { status: 'SKIPPED', reason: `not enough funds for 1 lot (${note})` }); return void notify(`⏭ SKIPPED ${r.tradingsymbol}: not enough funds for 1 lot`); }
  } else lots = Math.max(1, Math.min(25, Number(S.lots) || 1));
  if (tradesToday() >= S.maxTrades) { setRow(r.id, { status: 'SKIPPED', reason: `already ${S.maxTrades} trades today` }); return; }
  // one claim: only one caller moves WATCHING → ORDERED
  const claim = D.db.prepare("UPDATE family_trades SET status='ORDERED', mode=?, updated_at=? WHERE id=? AND status='WATCHING'").run(S.mode, Date.now(), r.id);
  if (!claim.changes) return;
  const mode: Mode = S.mode === 'LIVE' ? 'LIVE' : 'PRACTICE';
  const qty = lots * r.lot_size;
  let fillPx = ltp, filled = qty, orderId: string | null = null;

  if (mode === 'LIVE') {
    const kc = famKite();
    if (!kc) { setRow(r.id, { status: 'FAILED', reason: 'not logged in' }); return void notify(`❌ ${r.tradingsymbol}: her Zerodha is not logged in`); }
    try {
      const resp = await kc.placeOrder('regular', {
        exchange: r.exchange, tradingsymbol: r.tradingsymbol, transaction_type: 'BUY', quantity: qty,
        product: 'MIS', order_type: 'LIMIT', price: r2(tick05(cap)), validity: 'DAY', tag: 'tgfamily',
      });
      orderId = typeof resp === 'string' ? resp : resp?.order_id;
    } catch (e: any) {
      setRow(r.id, { status: 'FAILED', reason: e?.message || String(e) });
      return void notify(`❌ ORDER REJECTED ${r.tradingsymbol}: ${e?.message || e}`);
    }
    let st: any = null;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      try { const h = await kc.getOrderHistory(orderId); st = h?.[h.length - 1]; } catch { continue; }
      if (st && ['COMPLETE', 'REJECTED', 'CANCELLED'].includes(st.status)) break;
    }
    if (st && !['COMPLETE', 'REJECTED', 'CANCELLED'].includes(st.status)) {
      try { await kc.cancelOrder('regular', orderId); } catch { }
      try { const h = await kc.getOrderHistory(orderId); st = h?.[h.length - 1] || st; } catch { }
    }
    filled = Number(st?.filled_quantity || 0);
    fillPx = Number(st?.average_price || 0);
    if (!(filled > 0) || !(fillPx > 0)) {
      setRow(r.id, { status: 'FAILED', reason: st?.status_message || st?.status || 'not filled', order_id: orderId });
      return void notify(`❌ NOT FILLED ${r.tradingsymbol} (limit ${r2(tick05(cap))}): ${st?.status_message || st?.status || 'no fill in 20 s'}`);
    }
  }
  const ladder = createLadder(fillPx, r.sl, [r.tp1, r.tp2, r.tp3]);
  setRow(r.id, { status: 'OPEN', mode, qty: filled, entry: fillPx, entry_at: Date.now(), order_id: orderId, ladder: JSON.stringify(ladder), last_ltp: fillPx });
  openTrades.set(r.id, ladder);
  watchTokens.add(r.token);
  await notify(`${mode === 'LIVE' ? '✅ BOUGHT' : '🧪 PRACTICE BUY'} ${r.underlying} ${r.strike} ${r.option_type}\n` +
    `${filled} qty @ ${rs(fillPx)} · SL ${rs(r.sl)} · TP ${r.tp1}/${r.tp2}/${r.tp3}` + (note ? `\n${note}` : '') +
    (filled < qty ? `\nOnly ${filled} of ${qty} filled — the rest was cancelled.` : ''),
    [{ text: '🚪 Exit her trade', data: `fexit:${r.id}` }]);
}

// ---------- open trades ----------
const openTrades = new Map<number, LadderState>();
function loadOpen() {
  openTrades.clear();
  for (const r of D.db.prepare("SELECT * FROM family_trades WHERE status IN ('OPEN','CLOSING')").all() as any[]) {
    try { if (r.status === 'CLOSING') setRow(r.id, { status: 'OPEN' }); openTrades.set(r.id, JSON.parse(r.ladder)); watchTokens.add(r.token); } catch { }
  }
  for (const r of D.db.prepare("SELECT * FROM family_trades WHERE status = 'WATCHING'").all() as any[]) if (r.token) watchTokens.add(r.token);
  // an order whose fill was never recorded (restart mid-order): say so, do not guess
  for (const r of D.db.prepare("SELECT * FROM family_trades WHERE status = 'ORDERED'").all() as any[]) {
    setRow(r.id, { status: 'FAILED', reason: 'app restarted while ordering — check her Kite' });
    void notify(`⚠️ ${r.tradingsymbol}: the app restarted while her order was going in. Check her Kite positions.`);
  }
}
async function applyLadder(id: number, acts: LadderAction[]) {
  const r = row(id), st = openTrades.get(id);
  if (!r || !st || !acts.length) return;
  setRow(id, { ladder: JSON.stringify(st) });
  for (const a of acts) {
    if (a.type === 'SET_SL') await notify(`🔼 ${r.tradingsymbol}: ${a.reason} → SL ${rs(a.sl)}`, [{ text: '🚪 Exit her trade', data: `fexit:${id}` }]);
    else if (a.type === 'ASK_TP3') await notify(`🎯 TP3 reached on ${r.tradingsymbol}. Her SL is now at TP2 (${rs(st.sl)}).\nExit now, or keep trailing?`,
      [{ text: '🚪 Exit her trade', data: `fexit:${id}` }, { text: '📈 Keep trailing', data: `fkeep:${id}` }]);
  }
}
function onPrice(id: number, ltp: number) {
  const st = openTrades.get(id), r = row(id);
  if (!st || !r || r.status !== 'OPEN') return;
  const acts = onLadderPrice(st, ltp);
  if (acts.length) void applyLadder(id, acts);
  lastPriceAt.set(id, Date.now());
  if (ltp <= st.sl) void closeTrade(id, `SL ${st.sl} hit`, ltp, true);
}
const lastPriceAt = new Map<number, number>();

const closing = new Set<number>();
const lastCloseTry = new Map<number, number>();
async function closeTrade(id: number, reason: string, pxHint?: number, automatic = false): Promise<{ ok: boolean; error?: string }> {
  if (closing.has(id)) return { ok: false, error: 'already closing' };
  if (automatic && (lastCloseTry.get(id) || 0) > Date.now() - 20000) return { ok: false, error: 'retrying shortly' };
  lastCloseTry.set(id, Date.now());
  closing.add(id);
  try {
    const r = row(id);
    if (!r || r.status !== 'OPEN') return { ok: false, error: 'trade is not open' };
    if (r.mode !== 'LIVE') {
      const px = pxHint ?? (await priceOf(r.token, r.exchange, r.tradingsymbol)) ?? r.last_ltp;
      finish(id, px, reason);
      return { ok: true };
    }
    setRow(id, { status: 'CLOSING', exit_reason: reason });
    const res = await sellOnHerAccount(r);
    if (res.ok) { finish(id, res.avg, res.note ? `${reason} — ${res.note}` : reason); return { ok: true }; }
    setRow(id, { status: 'OPEN' });
    await notify(`⚠️ EXIT FAILED ${r.tradingsymbol}: ${res.error}. Exit it in her Kite!`, [{ text: '🔁 Try again', data: `fexit:${id}` }]);
    return { ok: false, error: res.error };
  } finally { closing.delete(id); }
}

// Sells ONLY what this module bought (capped at her open MIS quantity), with a
// marketable LIMIT priced off Martin's feed; up to 3 tries, each re-priced.
async function sellOnHerAccount(r: any): Promise<{ ok: boolean; avg: number | null; note?: string; error?: string }> {
  const kc = famKite();
  if (!kc) return { ok: false, avg: null, error: 'her Zerodha is not logged in' };
  let pos: any;
  try { pos = ((await kc.getPositions())?.net || []).find((p: any) => p.tradingsymbol === r.tradingsymbol && p.product === 'MIS' && Number(p.quantity) > 0); }
  catch (e: any) { return { ok: false, avg: null, error: `could not read her positions (${e?.message || e})` }; }
  if (!pos) return { ok: true, avg: null, note: 'already closed in her Kite' };
  let left = Math.min(Number(pos.quantity), Number(r.qty)), soldQty = 0, soldVal = 0;
  for (let attempt = 0; attempt < 3 && left > 0; attempt++) {
    const ltp = (await priceOf(r.token, r.exchange, r.tradingsymbol)) ?? r.last_ltp;
    if (!(ltp > 0)) return { ok: false, avg: null, error: 'no live price to price the exit' };
    const price = Math.max(0.05, r2(tick05(ltp * (attempt === 0 ? 0.995 : 0.98))));
    let orderId: string;
    try {
      const resp = await kc.placeOrder('regular', { exchange: r.exchange, tradingsymbol: r.tradingsymbol, transaction_type: 'SELL',
        quantity: left, product: 'MIS', order_type: 'LIMIT', price, validity: 'DAY', tag: 'tgfamily' });
      orderId = typeof resp === 'string' ? resp : resp?.order_id;
    } catch (e: any) { return { ok: false, avg: null, error: e?.message || String(e) }; }
    let st: any = null;
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      try { const h = await kc.getOrderHistory(orderId); st = h?.[h.length - 1]; } catch { continue; }
      if (st && ['COMPLETE', 'REJECTED', 'CANCELLED'].includes(st.status)) break;
    }
    if (st && !['COMPLETE', 'REJECTED', 'CANCELLED'].includes(st.status)) {
      try { await kc.cancelOrder('regular', orderId); } catch { }
      try { const h = await kc.getOrderHistory(orderId); st = h?.[h.length - 1] || st; } catch { }
    }
    const f = Number(st?.filled_quantity || 0);
    if (f > 0) { soldQty += f; soldVal += f * Number(st.average_price || price); left -= f; }
    if (st?.status === 'REJECTED' && f === 0) return { ok: false, avg: null, error: st?.status_message || 'exit rejected' };
  }
  if (left > 0) return { ok: false, avg: null, error: `${left} qty still open after 3 tries` };
  return { ok: true, avg: soldQty ? r2(soldVal / soldQty) : null };
}

function finish(id: number, px: number | null, reason: string) {
  const r = row(id);
  const pnl = px != null ? r2((px - r.entry) * r.qty) : null;
  setRow(id, { status: 'CLOSED', exit_price: px, exit_at: Date.now(), exit_reason: reason, pnl });
  openTrades.delete(id);
  void notify(`🏁 CLOSED ${r.mode === 'LIVE' ? '' : '(practice) '}${r.tradingsymbol} @ ${px != null ? rs(px) : '?'} — ${reason}` +
    (pnl != null ? `\nP&L ${pnl >= 0 ? '+' : ''}${rs(pnl)} (before charges)` : ''));
}

async function keep(id: number): Promise<string> {
  const st = openTrades.get(id);
  if (!st) return 'That trade is no longer open.';
  if (st.stage < 3) return 'TP3 has not been reached yet.';
  if (st.decision === 'KEEP') return 'Already trailing.';
  const acts = keepTrailing(st);
  setRow(id, { ladder: JSON.stringify(st) });
  await notify(`📈 Keeping ${row(id).tradingsymbol} — SL trails above TP3. Now SL ${rs(st.sl)}.`);
  await applyLadder(id, acts);
  return 'Keeping her trade — trailing.';
}

/** Every option tick (server.ts). Cheap when nothing is watched or open. */
export function familyOnTick(token: number, ltp: number) {
  if (!(ltp > 0) || !watchTokens.has(token)) return;
  for (const r of D.db.prepare("SELECT id, status FROM family_trades WHERE token = ? AND status IN ('WATCHING','OPEN')").all(token) as any[]) {
    if (r.status === 'WATCHING') void checkWatching(r.id);
    else onPrice(r.id, ltp);
  }
}

// ---------- 1 s housekeeping ----------
let hkBusy = false, lastReconcile = 0, lastTokenSweep = Date.now();
const missing = new Map<number, number>();
async function housekeeping() {
  if (hkBusy) return;
  hkBusy = true;
  try {
    const t = istParts(), T = signalTiming();
    for (const r of D.db.prepare("SELECT id FROM family_trades WHERE status = 'WATCHING'").all() as any[]) await checkWatching(r.id);
    const open = D.db.prepare("SELECT * FROM family_trades WHERE status = 'OPEN'").all() as any[];
    for (const r of open) {
      if (t.day >= 1 && t.day <= 5 && t.mins >= hm(T.squareOff)) { await closeTrade(r.id, `square-off ${T.squareOff}`, undefined, true); continue; }
      // ticks missing for 3 s: price it from REST so the stop still works
      if ((lastPriceAt.get(r.id) || 0) < Date.now() - 3000) {
        const px = await priceOf(r.token, r.exchange, r.tradingsymbol);
        if (px != null) { setRow(r.id, { last_ltp: px }); onPrice(r.id, px); }
      }
    }
    // closed by hand in her Kite? (two misses in a row, 15 s apart)
    if (Date.now() - lastReconcile > 15000 && open.some(r => r.mode === 'LIVE')) {
      lastReconcile = Date.now();
      const kc = famKite();
      if (kc) {
        try {
          const net = (await kc.getPositions())?.net || [];
          for (const r of open.filter(x => x.mode === 'LIVE')) {
            const has = net.some((p: any) => p.tradingsymbol === r.tradingsymbol && p.product === 'MIS' && Number(p.quantity) > 0);
            if (has) { missing.delete(r.id); continue; }
            missing.set(r.id, (missing.get(r.id) || 0) + 1);
            if (missing.get(r.id)! >= 2 && row(r.id)?.status === 'OPEN') { missing.delete(r.id); finish(r.id, null, 'closed in her Kite (outside the app)'); }
          }
        } catch { }
      }
    }
    // contracts no longer watched or held leave the live feed (once a minute)
    if (Date.now() - lastTokenSweep > 60000) {
      lastTokenSweep = Date.now();
      const keep = new Set((D.db.prepare("SELECT DISTINCT token FROM family_trades WHERE status IN ('WATCHING','ORDERED','OPEN','CLOSING') AND token IS NOT NULL").all() as any[]).map(x => Number(x.token)));
      if ([...watchTokens].some(x => !keep.has(x))) { watchTokens.clear(); for (const x of keep) watchTokens.add(x); try { D.refreshSubscriptions(); } catch { } }
    }
    // 09:10 on weekdays: one heads-up if she is Live but not logged in
    if (S.mode === 'LIVE' && t.day >= 1 && t.day <= 5 && t.mins >= 9 * 60 + 10 && t.mins < 15 * 60 && !famKite()) {
      if (getKV('family_ready_warned') !== t.date) {
        setKV('family_ready_warned', t.date);
        void notify('Her Zerodha is not logged in today — channel calls will be skipped for her until she logs in (Telegram Auto-Trade page → Second account).');
      }
    }
  } catch (e: any) { log(`housekeeping: ${e?.message || e}`); }
  finally { hkBusy = false; }
}

// ---------- HTTP ----------
export function registerFamilyTrader(app: any, deps: FamilyDeps) {
  D = deps;
  initTables();
  loadSettings();
  loadOpen();
  onSignalCall(onCall);
  onSignalButton(async (act, id) => {
    if (act === 'fexit') { const r = await closeTrade(id, 'Exit button (Telegram)'); return r.ok ? 'Exiting her trade…' : (r.error || 'failed'); }
    if (act === 'fkeep') return keep(id);
    return null;
  });
  if (!(globalThis as any).__familyHk) (globalThis as any).__familyHk = setInterval(() => { void housekeeping(); }, 1000);
  const json = express.json({ limit: '10kb' });

  app.get('/api/family/status', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    const day = istParts().date;
    const tok = tokenRow();
    const rows = (D.db.prepare("SELECT * FROM family_trades WHERE day = ? OR status IN ('OPEN','CLOSING') ORDER BY id DESC").all(day) as any[])
      .map(r => ({ ...r, ladder: (() => { try { return JSON.parse(r.ladder); } catch { return null; } })() }));
    res.json({
      ok: true, configured: familyConfigured(), settings: S, timing: signalTiming(),
      kite: { loggedIn: !!tok?.access_token, user: tok ? (tok.user_name || tok.user_id) : null, at: tok?.created_at || null },
      tradesToday: tradesToday(), trades: rows,
    });
  });

  app.post('/api/family/settings', json, (req: any, res: any) => {
    const b = req.body || {};
    if (b.mode === 'OFF' && Object.keys(b).every(k => k === 'mode' || k === 'pin')) {
      S.mode = 'OFF'; saveSettings(); log('switched OFF'); return res.json({ ok: true, settings: S });
    }
    if (!process.env.SIGNALS_PIN) return res.status(403).json({ ok: false, error: 'Set SIGNALS_PIN in Railway first.' });
    if (!signalPinOk(b.pin)) return res.status(401).json({ ok: false, error: 'Wrong PIN.' });
    const num = (v: any, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
    if (b.mode && ['OFF', 'PRACTICE', 'LIVE'].includes(b.mode)) {
      if (b.mode !== 'OFF' && !familyConfigured()) return res.json({ ok: false, error: 'Add FAMILY_KITE_API_KEY, FAMILY_KITE_API_SECRET and FAMILY_KITE_USER_ID in Railway first.' });
      S.mode = b.mode;
    }
    if (typeof b.name === 'string' && b.name.trim()) S.name = b.name.trim().slice(0, 30);
    if (b.lots !== undefined) S.lots = String(b.lots).toUpperCase() === 'MAX' ? 'MAX' : Math.round(num(b.lots, 1, 25, S.lots === 'MAX' ? 1 : S.lots));
    if (b.maxLotsCap !== undefined) S.maxLotsCap = Math.round(num(b.maxLotsCap, 1, 25, S.maxLotsCap));
    if (b.maxTrades !== undefined) S.maxTrades = Math.round(num(b.maxTrades, 1, 10, S.maxTrades));
    saveSettings();
    log(`settings: ${S.mode}, ${S.lots === 'MAX' ? `MAX (cap ${S.maxLotsCap})` : `${S.lots} lot`}, max ${S.maxTrades}/day`);
    res.json({ ok: true, settings: S });
  });

  app.post('/api/family/exit', json, async (req: any, res: any) => res.json(await closeTrade(Number(req.body?.id), 'Exit button (app)')));
  app.post('/api/family/keep', json, async (req: any, res: any) => res.json({ ok: true, message: await keep(Number(req.body?.id)) }));

  // Her daily Zerodha login. The redirect URL of HER Kite app must be
  //   https://<this app>/api/family/kite/callback
  app.get('/api/family/kite/login', (_req: any, res: any) => {
    const key = process.env.FAMILY_KITE_API_KEY;
    if (!familyConfigured() || !key) return res.status(400).send('Second account is not set up yet (FAMILY_KITE_API_KEY / _SECRET / _USER_ID).');
    res.redirect(`https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(key)}`);
  });
  app.get('/api/family/kite/callback', async (req: any, res: any) => {
    const back = (q: string) => res.redirect(`/telegram-signals?family=${q}`);
    try {
      if (!familyConfigured()) return back('notset');
      const rt = String(req.query.request_token || '');
      if (req.query.status !== 'success' || !rt) return back('cancelled');
      let sess: { access_token: string; user_id: string; user_name?: string };
      if (D.generateSession) sess = await D.generateSession(rt);
      else {
        const kc: any = new KiteConnect({ api_key: process.env.FAMILY_KITE_API_KEY! });
        sess = await kc.generateSession(rt, process.env.FAMILY_KITE_API_SECRET!);
      }
      const uid = String(sess.user_id || '').toUpperCase();
      if (uid !== String(process.env.FAMILY_KITE_USER_ID).trim().toUpperCase()) { log(`login refused: ${uid} is not FAMILY_KITE_USER_ID`); return back('wronguser'); }
      const martin = String(D.getMartinUserId() || '').toUpperCase();
      if (martin && uid === martin) return back('wronguser');
      D.db.prepare('INSERT INTO family_tokens (access_token, token_date, user_id, user_name, created_at) VALUES (?,?,?,?,?)')
        .run(sess.access_token, new Date().toISOString().slice(0, 10), uid, sess.user_name || null, Date.now());
      kcCache = null;
      log(`her Zerodha logged in (${uid})`);
      back('ok');
    } catch (e: any) { log(`login failed: ${e?.message || e}`); back('error'); }
  });
  app.post('/api/family/kite/logout', json, (req: any, res: any) => {
    if (!signalPinOk(req.body?.pin)) return res.status(401).json({ ok: false, error: 'Wrong PIN.' });
    D.db.prepare('DELETE FROM family_tokens').run(); kcCache = null;
    res.json({ ok: true });
  });
  log(`registered (${familyConfigured() ? 'configured' : 'not configured'}, ${S.mode})`);
}

export const __ftest = { housekeeping, closeTrade, keep, onCall, get settings() { return S; }, setSettings(s: Partial<FamSettings>) { S = { ...S, ...s }; }, clearPriceCache() { lastRestAt.clear(); restLtp.clear(); } };
