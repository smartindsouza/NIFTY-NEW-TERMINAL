// TELEGRAM SIGNAL AUTO-TRADER (23 Oct 2026, Martin's request).
//
// Reads ONE Telegram channel as Martin's own account, turns each NIFTY/SENSEX
// BUY call into a 1-lot entry inside the posted range, and manages the stop with
// the ladder in signal_ladder.ts. This is the first thing in the app that places
// an ENTRY order without a tap, so every gate below fails closed: anything not
// understood, late, outside the range or outside the session is SKIPPED and
// reported, never guessed at.
//
// THE FLOW
//   call message  → contract resolved (nearest expiry, exact strike), token streamed
//   levels message (a reply to the call, or within 3 min of it)
//                 → validated → WATCHING: buy when LTP ≤ entryHigh + allowance
//                   and LTP > SL, within `waitMin` minutes, else skip
//   order         → LIMIT BUY at entryHigh + allowance (fills at the ask, never
//                   above the cap); cancelled if not filled in 20 s
//   filled        → premium_exit_rules armed with the message's SL (TP leg OFF:
//                   there is no target exit) — the existing tick engine exits
//   ladder        → TP1: SL→entry · TP2: SL→TP1 · TP3: SL→TP2 + ask Exit/Keep
//   15:15 IST     → square-off of anything still open (calls are intraday only)
//
// Martin said there is NO daily rupee limit — the message's SL is the risk — but
// "max 2 to 3 trades a day", so maxTrades (default 3) caps entries per day.
//
// If he moves the SL on the chart himself, the app hands the trade to him: the
// ladder stops and his chart rule is in charge (signalNoteManualRearm).

import crypto from 'node:crypto';
import express from 'express';
import { TelegramClient, Api, sessions, password as tgPassword } from 'telegram';
import { parseSignalMessage, validateSetup, type ParsedCall, type ParsedLevels } from './signal_parser';
import { createLadder, onLadderPrice, keepTrailing, type LadderState, type LadderAction } from './signal_ladder';

export interface SignalDeps {
  db: any;
  getKiteClient: () => any;
  getLatestTick: (token: number) => { ltp: number; ts: number } | undefined;
  findOption: (u: 'NIFTY' | 'SENSEX', strike: number, type: 'CE' | 'PE', todayIst: string) =>
    Promise<{ tradingsymbol: string; instrument_token: number; exchange: string; lot_size: number; expiry: string } | null>;
  refreshSubscriptions: () => void;
  armRule: (r: { tradingsymbol: string; exchange: string; qty: number; entry: number; sl: number; tp: number; token: number | null }) => void;
  setRuleSl: (tradingsymbol: string, sl: number) => void;
  ruleStatus: (tradingsymbol: string) => string | null;
  exitPosition: (tradingsymbol: string, reason: string) => Promise<{ ok: boolean; error?: string; alreadyClosed?: boolean }>;
  journalOpen: (o: any) => void;
  // the 09:10 readiness message
  kiteLoggedInToday: () => boolean;
  isTradingDay: (dateIst: string) => boolean;
}

type Mode = 'OFF' | 'PRACTICE' | 'LIVE';
interface Settings {
  mode: Mode; lots: number | 'MAX'; maxLotsCap: number; maxTrades: number; allowAbove: number; waitMin: number;
  lastEntry: string; squareOff: string; channelId: string | null; channelTitle: string | null;
}
const DEFAULTS: Settings = {
  mode: 'OFF', lots: 1, maxLotsCap: 20, maxTrades: 3, allowAbove: 2, waitMin: 10,
  lastEntry: '15:00', squareOff: '15:15', channelId: null, channelTitle: null,
};

// ---------- clock (IST) ----------
let clockOffsetMs = 0;                 // test harness only: pretend it is market time
const istParts = (ms = Date.now() + clockOffsetMs) => {
  const d = new Date(ms + 5.5 * 3600000);
  return { date: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.getUTCDay() };
};
const hm = (s: string) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const fmtIst = (ms: number) => new Date(ms + 5.5 * 3600000).toISOString().slice(11, 16);
const tick05 = (x: number) => Math.floor(x / 0.05 + 1e-6) * 0.05;
const r2 = (x: number) => Math.round(x * 100) / 100;
const rs = (x: number) => `₹${r2(x).toLocaleString('en-IN')}`;

let D: SignalDeps;
let settings: Settings = { ...DEFAULTS };

// ---------- persistence ----------
function initTables() {
  D.db.exec(`CREATE TABLE IF NOT EXISTS signal_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, msg_id INTEGER, levels_msg_id INTEGER,
    day TEXT, received_at INTEGER, raw TEXT, underlying TEXT, strike REAL, option_type TEXT,
    entry_low REAL, entry_high REAL, sl REAL, tp1 REAL, tp2 REAL, tp3 REAL,
    tradingsymbol TEXT, exchange TEXT, token INTEGER, lot_size INTEGER, expiry TEXT,
    status TEXT, reason TEXT, mode TEXT, watch_until INTEGER, updated_at INTEGER,
    UNIQUE(chat_id, msg_id))`);
  D.db.exec(`CREATE TABLE IF NOT EXISTS signal_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT, call_id INTEGER, day TEXT, mode TEXT,
    tradingsymbol TEXT, exchange TEXT, token INTEGER, qty INTEGER, entry REAL, entry_at INTEGER,
    order_id TEXT, ladder TEXT, status TEXT, last_ltp REAL, exit_price REAL, exit_at INTEGER,
    exit_reason TEXT, pnl REAL, updated_at INTEGER)`);
  D.db.exec(`CREATE TABLE IF NOT EXISTS signal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, day TEXT, text TEXT)`);
}
const getKV = (k: string): any => {
  try { const r = D.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k); return r ? JSON.parse(r.value) : null; }
  catch { return null; }
};
const setKV = (k: string, v: any) => {
  D.db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(k, JSON.stringify(v), Date.now());
};
function loadSettings() { settings = { ...DEFAULTS, ...(getKV('signals_settings') || {}) }; }
function saveSettings() { setKV('signals_settings', settings); }

function logEvent(text: string) {
  console.log('[signals]', text);
  try { D.db.prepare('INSERT INTO signal_events (at, day, text) VALUES (?, ?, ?)').run(Date.now(), istParts().date, text); } catch { }
}

// ---------- notifications: bot (with buttons) → Saved Messages → log only ----------
const BOT = () => process.env.TELEGRAM_BOT_TOKEN || '';
async function botCall(method: string, body: any): Promise<any> {
  if (!BOT()) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT()}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 10000),
    });
    return await r.json();
  } catch (e: any) { return { ok: false, description: e?.message || String(e) }; }
}
// A button either calls back into the app (data) or opens a page (url).
type Btn = { text: string; data?: string; url?: string };
async function notify(text: string, buttons?: Btn[]) {
  logEvent(text.replace(/\n/g, ' · '));
  const chat = getKV('signals_bot_chat');
  if (BOT() && chat) {
    const r = await botCall('sendMessage', {
      chat_id: chat, text, disable_web_page_preview: true,
      ...(buttons?.length ? { reply_markup: { inline_keyboard: [buttons.map(b => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))] } } : {}),
    });
    if (r?.ok) return;
  }
  // No bot linked: Martin's own Saved Messages, so an alert is never silently lost.
  try { if (tg && tgLoggedIn) await tg.sendMessage('me', { message: `[NIFTY app] ${text}` }); } catch { }
}

// ---------- Telegram user client (reads the channel as Martin) ----------
let tg: TelegramClient | null = null;
let tgLoggedIn = false;
let tgMe: { id: string; name: string } | null = null;
let tgStatus = 'not started';
let pendingLogin: { phone: string; hash: string } | null = null;
let channelEntity: any = null;
let handlerAdded = false;
let channelResolvedAt = 0;
let lastUpdateAt = 0;            // any update from Telegram: the push stream is alive
let lastChannelPushAt = 0;       // a new message in the chosen channel arrived by push
const seen = new Set<string>();         // `${chat}:${msg}` already handled (push and poll race)
const recentMsgs: { at: number; text: string; parsed: string }[] = [];

const apiCreds = () => {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0), apiHash = process.env.TELEGRAM_API_HASH || '';
  return apiId && apiHash ? { apiId, apiHash } : null;
};

async function tgConnect(): Promise<void> {
  const c = apiCreds();
  if (!c) { tgStatus = 'TELEGRAM_API_ID / TELEGRAM_API_HASH not set in Railway'; return; }
  if (tg) return;
  const saved = getKV('signals_tg_session') || '';
  tg = new TelegramClient(new sessions.StringSession(saved), c.apiId, c.apiHash, { connectionRetries: 10, autoReconnect: true });
  try { (tg as any).setLogLevel?.('error'); } catch { }
  tgStatus = 'connecting';
  try {
    await Promise.race([tg.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 30 s')), 30000))]);
  } catch (e: any) {
    // Left for the 60 s retry in housekeeping, so a Telegram blip at boot does
    // not leave the reader dead until the next deploy.
    tgStatus = `could not connect (${e?.message || e}) — retrying`;
    const dead = tg; tg = null;
    try { await (dead as any).destroy(); } catch { }
    return;
  }
  tgLoggedIn = saved ? await tg.checkAuthorization().catch(() => false) : false;
  tgStatus = tgLoggedIn ? 'connected' : 'connected, not logged in';
  if (tgLoggedIn) await afterLogin();
}

async function afterLogin() {
  if (!tg) return;
  const me: any = await tg.getMe();
  tgMe = { id: String(me.id), name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || 'you' };
  setKV('signals_owner_id', tgMe.id);
  await tg.getDialogs({ limit: 300 });            // fills the entity cache so the channel resolves after a restart
  await resolveChannel();
  if (!handlerAdded) { tg.addEventHandler((u: any) => { void onUpdate(u); }); handlerAdded = true; }
}

async function resolveChannel() {
  channelEntity = null;
  if (!tg || !settings.channelId) return;
  try {
    // From the dialog list, not getEntity(id): GramJS ids are big-integer
    // objects, and the dialog carries the access hash the channel needs.
    const ds: any[] = await tg.getDialogs({ limit: 300 });
    channelEntity = ds.find(d => String(d.entity?.id) === settings.channelId)?.entity || null;
    if (!channelEntity) { logEvent('the chosen channel is not in your Telegram chats any more'); return; }
    // Whatever is already in the channel is history: mark it seen so neither a
    // restart nor the first poll can act on an old call.
    const last: any[] = await tg.getMessages(channelEntity, { limit: 100 });
    for (const m of last) seen.add(`${settings.channelId}:${m.id}`);
    // Show some on the page (history, never traded) — proof that the channel is
    // readable and how the parser reads its real messages: the newest 8, plus the
    // newest 6 calls / TP-SL messages among the last 100 (the channel posts many
    // price updates between calls, which the newest 8 alone would be).
    recentMsgs.length = 0;
    const rows = last.map(m => { const p = parseSignalMessage(String(m.message || '')); return { at: Number(m.date || 0) * 1000, text: String(m.message || '').slice(0, 160), parsed: p ? p.kind : 'ignored' }; });
    const pick = new Set([...rows.slice(0, 8), ...rows.filter(r => r.parsed !== 'ignored').slice(0, 6)]);
    for (const r of rows) if (pick.has(r)) recentMsgs.push(r);
    channelResolvedAt = Date.now();
  } catch (e: any) { logEvent(`could not open the channel: ${e?.message || e}`); }
}

const msgChannelId = (m: any): string | null => {
  const p = m?.peerId;
  if (p && p.channelId != null) return String(p.channelId);
  return null;
};

async function onUpdate(u: any) {
  try {
    lastUpdateAt = Date.now();
    if (!(u instanceof Api.UpdateNewChannelMessage)) return;
    const m: any = u.message;
    if (msgChannelId(m) !== settings.channelId) return;
    lastChannelPushAt = Date.now();
    await handleMessage(m, 'push');
  } catch (e: any) { console.error('[signals] update error', e?.message || e); }
}

/** Safety net under the push updates, which Telegram does not guarantee for
 *  big channels: every 4 s in session, read the newest messages. The `seen`
 *  set makes push and poll race-safe. */
async function pollChannel() {
  if (!tg || !tgLoggedIn || !channelEntity) return;
  const t = istParts();
  if (t.day === 0 || t.day === 6 || t.mins < 9 * 60 + 10 || t.mins > hm(settings.squareOff)) return;
  try {
    const msgs: any[] = await tg.getMessages(channelEntity, { limit: 5 });
    for (const m of msgs.slice().reverse()) await handleMessage(m, 'poll');
  } catch (e: any) { /* FloodWait or a blip: the next poll retries */ }
}

// ---------- calls ----------
async function handleMessage(m: any, via: string) {
  const key = `${settings.channelId}:${m.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 2000) { const first = seen.values().next().value; if (first) seen.delete(first); }
  const text = String(m.message || '');
  const ageSec = Math.floor(Date.now() / 1000) - Number(m.date || 0);
  const p = parseSignalMessage(text);
  recentMsgs.unshift({ at: Date.now(), text: text.slice(0, 160), parsed: p ? p.kind : 'ignored' });
  recentMsgs.length = Math.min(recentMsgs.length, 25);
  if (!p) return;
  // A message older than 3 minutes is history (a restart, a backlog): never traded.
  if (ageSec > 180) { logEvent(`ignored a ${p.kind} message ${Math.round(ageSec / 60)} min old (${via})`); return; }

  if (p.kind === 'CALL') {
    const callId = insertCall(m, p.call, text);
    if (!callId) return;
    void prepareContract(callId);
    if (p.levels) await completeCall(callId, p.levels, m.id);
    else logEvent(`call received: BUY ${p.call.underlying} ${p.call.strike} ${p.call.optionType} ${p.call.entryLow}-${p.call.entryHigh} — waiting for TP/SL`);
    return;
  }
  // LEVELS: the call it replies to, else the newest call still waiting (≤3 min).
  const replyTo = Number(m.replyTo?.replyToMsgId || 0);
  let row: any = replyTo ? D.db.prepare("SELECT * FROM signal_calls WHERE chat_id = ? AND msg_id = ?").get(settings.channelId, replyTo) : null;
  if (!row) row = D.db.prepare("SELECT * FROM signal_calls WHERE chat_id = ? AND status = 'WAITING_LEVELS' AND received_at > ? ORDER BY id DESC LIMIT 1")
    .get(settings.channelId, Date.now() - 180000);
  if (!row) { logEvent('TP/SL message with no call to attach it to — ignored'); return; }
  if (row.status !== 'WAITING_LEVELS') return;
  await completeCall(row.id, p.levels, m.id);
}

function insertCall(m: any, c: ParsedCall, raw: string): number | null {
  try {
    const r = D.db.prepare(`INSERT OR IGNORE INTO signal_calls (chat_id, msg_id, day, received_at, raw, underlying, strike, option_type,
      entry_low, entry_high, status, mode, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'WAITING_LEVELS', ?, ?)`)
      .run(settings.channelId, m.id, istParts().date, Date.now(), raw.slice(0, 1000), c.underlying, c.strike, c.optionType,
        c.entryLow, c.entryHigh, settings.mode, Date.now());
    return r.changes ? Number(r.lastInsertRowid) : null;
  } catch (e) { console.error('[signals] insert call', e); return null; }
}

const callContract = new Map<number, Promise<boolean>>();
function prepareContract(callId: number): Promise<boolean> {
  if (callContract.has(callId)) return callContract.get(callId)!;
  const p = (async () => {
    const c: any = D.db.prepare('SELECT * FROM signal_calls WHERE id = ?').get(callId);
    const opt = await D.findOption(c.underlying, c.strike, c.option_type, istParts().date).catch(() => null);
    if (!opt || !opt.lot_size) return false;
    D.db.prepare('UPDATE signal_calls SET tradingsymbol=?, exchange=?, token=?, lot_size=?, expiry=?, updated_at=? WHERE id=?')
      .run(opt.tradingsymbol, opt.exchange, opt.instrument_token, opt.lot_size, opt.expiry, Date.now(), callId);
    watchTokens.add(opt.instrument_token);
    D.refreshSubscriptions();                     // stream it now, so the price is live when the levels land
    // MAX lots: size now, from the call alone (the cap is entry-high + allowance),
    // so the funds check is finished before the TP/SL message even arrives.
    if (settings.lots === 'MAX') presize({ ...c, tradingsymbol: opt.tradingsymbol, exchange: opt.exchange, lot_size: opt.lot_size });
    return true;
  })();
  callContract.set(callId, p);
  return p;
}

function setCall(id: number, status: string, reason: string | null = null) {
  D.db.prepare('UPDATE signal_calls SET status=?, reason=?, updated_at=? WHERE id=?').run(status, reason, Date.now(), id);
}
async function skip(id: number, reason: string, quiet = false) {
  setCall(id, 'SKIPPED', reason);
  const c: any = D.db.prepare('SELECT * FROM signal_calls WHERE id = ?').get(id);
  const what = c ? `${c.underlying} ${c.strike} ${c.option_type}` : 'call';
  if (!quiet) await notify(`⏭ SKIPPED ${what}: ${reason}`);
  else logEvent(`skipped ${what}: ${reason}`);
}

const tradesToday = () => (D.db.prepare("SELECT COUNT(*) AS n FROM signal_trades WHERE day = ? AND mode = ?").get(istParts().date, settings.mode) as any).n as number;

async function completeCall(callId: number, lv: ParsedLevels, levelsMsgId: number) {
  D.db.prepare('UPDATE signal_calls SET sl=?, tp1=?, tp2=?, tp3=?, levels_msg_id=?, updated_at=? WHERE id=?')
    .run(lv.sl, lv.tps[0], lv.tps[1], lv.tps[2], levelsMsgId, Date.now(), callId);
  const c: any = D.db.prepare('SELECT * FROM signal_calls WHERE id = ?').get(callId);
  const call: ParsedCall = { underlying: c.underlying, strike: c.strike, optionType: c.option_type, entryLow: c.entry_low, entryHigh: c.entry_high };
  const label = `${call.underlying} ${call.strike} ${call.optionType} · entry ${call.entryLow}-${call.entryHigh} · SL ${lv.sl} · TP ${lv.tps.join('/')}`;

  if (settings.mode === 'OFF') return skip(callId, 'auto-trade is switched OFF', true);
  const bad = validateSetup(call, lv);
  if (bad) return skip(callId, bad);
  const t = istParts();
  if (t.day === 0 || t.day === 6 || t.mins < 9 * 60 + 15) return skip(callId, 'market is not open');
  if (t.mins > hm(settings.lastEntry)) return skip(callId, `after the last entry time (${settings.lastEntry})`);
  if (tradesToday() >= settings.maxTrades) return skip(callId, `already ${settings.maxTrades} trades today`);
  if (settings.mode === 'LIVE') {
    const kc = D.getKiteClient();
    if (!kc || !kc.access_token) return skip(callId, 'Zerodha is not logged in today');
  }
  const ready = await prepareContract(callId);
  if (!ready) return skip(callId, `could not find the ${call.underlying} ${call.strike} ${call.optionType} contract`);
  const fresh: any = D.db.prepare('SELECT * FROM signal_calls WHERE id = ?').get(callId);
  const open = D.db.prepare("SELECT 1 FROM signal_trades WHERE tradingsymbol = ? AND status IN ('OPEN','MANUAL')").get(fresh.tradingsymbol);
  if (open) return skip(callId, 'already holding this contract from an earlier call');

  D.db.prepare("UPDATE signal_calls SET status='WATCHING', mode=?, watch_until=?, updated_at=? WHERE id=?")
    .run(settings.mode, Date.now() + settings.waitMin * 60000, Date.now(), callId);
  if (fresh.token) watchingTokens.set(fresh.token, [...(watchingTokens.get(fresh.token) || []), callId]);
  if (!sizing.has(callId) || Date.now() - sizing.get(callId)!.at > 60000) presize(fresh);
  logEvent(`${settings.mode === 'LIVE' ? '' : '[practice] '}call complete: ${label} — watching for price ≤ ${r2(call.entryHigh + settings.allowAbove)}`);
  await checkWatching(callId);                    // try at once: speed matters
}

// ---------- prices ----------
const watchTokens = new Set<number>();
const lastRestAt = new Map<number, number>();
const restLtp = new Map<number, number>();
async function priceOf(token: number, exchange: string, tradingsymbol: string): Promise<number | null> {
  const t = D.getLatestTick(token);
  if (t && Date.now() - t.ts < 3000 && t.ltp > 0) return t.ltp;
  if ((lastRestAt.get(token) || 0) > Date.now() - 500) return restLtp.get(token) ?? null;
  lastRestAt.set(token, Date.now());
  try {
    const kc = D.getKiteClient();
    if (!kc || !kc.access_token) return null;
    const k = `${exchange}:${tradingsymbol}`;
    const q = await kc.getLTP([k]);
    const v = q?.[k]?.last_price;
    if (typeof v === 'number' && v > 0) { restLtp.set(token, v); return v; }
  } catch { }
  return null;
}

// ---------- entry ----------
const entering = new Set<number>();
// token -> calls currently WATCHING for their price (rebuilt by housekeeping)
const watchingTokens = new Map<number, number[]>();
async function checkWatching(callId: number) {
  // The whole check is one critical section per call: ticks, the 1 s loop and
  // the first check can all arrive together, and only one may ever reach enter().
  if (entering.has(callId)) return;
  entering.add(callId);
  try {
    const c: any = D.db.prepare('SELECT * FROM signal_calls WHERE id = ?').get(callId);
    if (!c || c.status !== 'WATCHING') return;
    if (settings.mode === 'OFF') return skip(callId, 'auto-trade was switched OFF', true);
    if (Date.now() > c.watch_until) return skip(callId, `price never came into range within ${settings.waitMin} min`);
    if (istParts().mins > hm(settings.lastEntry)) return skip(callId, 'reached the last entry time');
    const ltp = await priceOf(c.token, c.exchange, c.tradingsymbol);
    if (ltp == null) return;
    const cap = r2(c.entry_high + settings.allowAbove);
    if (ltp <= c.sl) return skip(callId, `price ${ltp} is already at/below the SL ${c.sl}`);
    if (ltp > cap) return;                          // keep watching
    await enter(c, ltp, cap);
  } finally { entering.delete(callId); }
}

// MAX LOTS (Martin, 23 Oct): as many lots as the funds allow, sized the way the
// trigger engine sizes at fire time (server/triggers.ts): Zerodha's own margin
// calculator prices ONE lot exactly as the order will be priced (LIMIT at the
// cap, MIS) with charges, and the largest whole number of lots that fits in
// 98.5% of the live balance is bought. Never more than maxLotsCap (default 20,
// at most 25): 25 lots stays under the exchange's single-order freeze for both
// NIFTY (25 x 65 = 1,625) and SENSEX (25 x 20 = 500), so one order is enough.
// Sized when the TP/SL message lands (pre-sized, so the buy itself waits on
// nothing) and again only if that answer is over a minute old. If the funds
// cannot be read, 1 lot is bought and the alert says so — a failed sizing step
// must not cost the trade, and must not guess big.
const sizing = new Map<number, { at: number; p: Promise<{ lots: number; note: string | null }> }>();
async function sizeMaxLots(c: any, cap: number): Promise<{ lots: number; note: string | null }> {
  const ceiling = Math.max(1, Math.min(25, Math.round(settings.maxLotsCap || 20)));
  try {
    const kc = D.getKiteClient();
    if (!kc || !kc.access_token) return { lots: 1, note: 'MAX sizing: Zerodha not logged in — bought 1 lot' };
    const [mg, funds] = await Promise.all([
      kc.orderMargins([{ exchange: c.exchange, tradingsymbol: c.tradingsymbol, transaction_type: 'BUY', variety: 'regular',
        product: 'MIS', order_type: 'LIMIT', quantity: c.lot_size, price: r2(tick05(cap)), trigger_price: 0 }]),
      kc.getMargins(),
    ]);
    const perLot = Number(mg?.[0]?.total) + (Number(mg?.[0]?.charges?.total) || 0);
    const available = Number(funds?.equity?.available?.live_balance ?? funds?.equity?.net);
    if (!(perLot > 0) || !isFinite(available)) return { lots: 1, note: 'MAX sizing: could not read funds — bought 1 lot' };
    const fit = Math.floor((available * 0.985) / perLot);
    const lots = Math.min(ceiling, fit);
    const note = `MAX: ₹${Math.round(available).toLocaleString('en-IN')} available, ₹${Math.round(perLot).toLocaleString('en-IN')} a lot at ${r2(tick05(cap))}` +
      (fit > ceiling ? ` → capped at ${ceiling} lots` : ` → ${lots} lot${lots === 1 ? '' : 's'}`);
    return { lots, note };
  } catch (e: any) {
    return { lots: 1, note: `MAX sizing failed (${e?.message || e}) — bought 1 lot` };
  }
}
function presize(c: any) {
  if (settings.lots !== 'MAX') return;
  sizing.set(c.id, { at: Date.now(), p: sizeMaxLots(c, r2(c.entry_high + settings.allowAbove)) });
}

async function enter(c: any, ltp: number, cap: number) {
  let lots = 1, sizeNote: string | null = null;
  if (settings.lots === 'MAX') {
    let s = sizing.get(c.id);
    if (!s || Date.now() - s.at > 60000) { presize(c); s = sizing.get(c.id)!; }
    ({ lots, note: sizeNote } = await s.p);
    sizing.delete(c.id);
    if (lots < 1) return skip(c.id, `not enough funds for 1 lot (${sizeNote})`);
  } else lots = settings.lots;
  const qty = lots * c.lot_size;
  const mode: Mode = c.mode === 'LIVE' ? 'LIVE' : 'PRACTICE';
  if (tradesToday() >= settings.maxTrades) return skip(c.id, `already ${settings.maxTrades} trades today`);
  setCall(c.id, 'ORDERED');
  let fillPx = ltp, filledQty = qty, orderId: string | null = null;

  if (mode === 'LIVE') {
    const kc = D.getKiteClient();
    try {
      const resp = await kc.placeOrder('regular', {
        exchange: c.exchange, tradingsymbol: c.tradingsymbol, transaction_type: 'BUY', quantity: qty,
        product: 'MIS', order_type: 'LIMIT', price: r2(tick05(cap)), validity: 'DAY', tag: 'tgsignal',
      });
      orderId = typeof resp === 'string' ? resp : resp?.order_id;
    } catch (e: any) {
      setCall(c.id, 'FAILED', e?.message || String(e));
      return notify(`❌ ORDER REJECTED ${c.tradingsymbol}: ${e?.message || e}`);
    }
    // Wait for the fill (≤ 20 s), then cancel whatever is left.
    let st: any = null;
    // Checked every 250 ms: a marketable limit normally fills on the first look.
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 250));
      try { const h = await kc.getOrderHistory(orderId); st = h?.[h.length - 1]; } catch { continue; }
      if (st && ['COMPLETE', 'REJECTED', 'CANCELLED'].includes(st.status)) break;
    }
    if (st && st.status !== 'COMPLETE' && st.status !== 'REJECTED' && st.status !== 'CANCELLED') {
      try { await kc.cancelOrder('regular', orderId); } catch { }
      try { const h = await kc.getOrderHistory(orderId); st = h?.[h.length - 1] || st; } catch { }
    }
    filledQty = Number(st?.filled_quantity || 0);
    fillPx = Number(st?.average_price || 0);
    if (!(filledQty > 0) || !(fillPx > 0)) {
      setCall(c.id, 'FAILED', st?.status_message || st?.status || 'not filled');
      return notify(`❌ NOT FILLED ${c.tradingsymbol} (limit ${r2(tick05(cap))}): ${st?.status_message || st?.status || 'no fill in 20 s'} — skipped`);
    }
  }

  const ladder = createLadder(fillPx, c.sl, [c.tp1, c.tp2, c.tp3]);
  const ins = D.db.prepare(`INSERT INTO signal_trades (call_id, day, mode, tradingsymbol, exchange, token, qty, entry, entry_at, order_id, ladder, status, last_ltp, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'OPEN', ?, ?)`)
    .run(c.id, istParts().date, mode, c.tradingsymbol, c.exchange, c.token, filledQty, fillPx, Date.now(), orderId, JSON.stringify(ladder), fillPx, Date.now());
  const tradeId = Number(ins.lastInsertRowid);
  setCall(c.id, 'ENTERED');
  if (mode === 'LIVE') {
    // SL armed straight away through the existing premium-exit engine; TP leg off.
    try { D.armRule({ tradingsymbol: c.tradingsymbol, exchange: c.exchange, qty: filledQty, entry: fillPx, sl: c.sl, tp: c.tp3, token: c.token }); }
    catch (e: any) { await notify(`🚨 BOUGHT ${c.tradingsymbol} but the SL could NOT be armed (${e?.message || e}). Put a stop at ${rs(c.sl)} in Kite NOW.`); }
    try { D.journalOpen({ tradingsymbol: c.tradingsymbol, exchange: c.exchange, side: 'BUY', qty: filledQty, product: 'MIS', entryPrice: fillPx,
      optionType: c.option_type, strike: c.strike, context: { source: 'telegram', channel: settings.channelTitle, entryRange: [c.entry_low, c.entry_high], sl: c.sl, tps: [c.tp1, c.tp2, c.tp3] } }); } catch { }
  }
  openTrades.set(tradeId, ladder);
  await notify(`${mode === 'LIVE' ? '✅ BOUGHT' : '🧪 PRACTICE BUY'} ${c.underlying} ${c.strike} ${c.option_type} (${c.expiry})\n` +
    `${filledQty} qty (${Math.round(filledQty / c.lot_size)} lot${filledQty / c.lot_size === 1 ? '' : 's'}) @ ${rs(fillPx)}\nSL ${rs(c.sl)} · TP1 ${rs(c.tp1)} · TP2 ${rs(c.tp2)} · TP3 ${rs(c.tp3)}` +
    (sizeNote ? `\n${sizeNote}` : '') + (filledQty < qty ? `\nOnly ${filledQty} of ${qty} filled — the rest was cancelled.` : ''),
    [{ text: '🚪 Exit now', data: `exit:${tradeId}` }]);
}

// ---------- open trades: ladder, exits, square-off ----------
const openTrades = new Map<number, LadderState>();
function loadOpenTrades() {
  openTrades.clear();
  const rows: any[] = D.db.prepare("SELECT * FROM signal_trades WHERE status = 'OPEN'").all();
  for (const r of rows) { try { openTrades.set(r.id, JSON.parse(r.ladder)); watchTokens.add(r.token); } catch { } }
}
const tradeRow = (id: number): any => D.db.prepare('SELECT * FROM signal_trades WHERE id = ?').get(id);
function saveLadder(id: number, st: LadderState, ltp?: number) {
  D.db.prepare('UPDATE signal_trades SET ladder=?, last_ltp=COALESCE(?, last_ltp), updated_at=? WHERE id=?').run(JSON.stringify(st), ltp ?? null, Date.now(), id);
}

async function applyLadder(id: number, acts: LadderAction[]) {
  if (!acts.length) return;
  const t = tradeRow(id), st = openTrades.get(id);
  if (!t || !st) return;
  saveLadder(id, st);
  // Every stop move reaches the exit engine BEFORE any message goes out: a gap
  // through two targets must not leave the second raise waiting on Telegram.
  if (t.mode === 'LIVE' && t.status === 'OPEN') D.setRuleSl(t.tradingsymbol, st.sl);
  for (const a of acts) {
    if (a.type === 'SET_SL') {
      await notify(`🔼 ${t.tradingsymbol}: ${a.reason} → SL ${rs(a.sl)}`, [{ text: '🚪 Exit now', data: `exit:${id}` }]);
    } else if (a.type === 'ASK_TP3') {
      await notify(`🎯 TP3 reached on ${t.tradingsymbol}. SL is now at TP2 (${rs(st.sl)}).\nExit now, or keep trailing?`,
        [{ text: '🚪 Exit now', data: `exit:${id}` }, { text: '📈 Keep trailing', data: `keep:${id}` }]);
    }
  }
}

const closing = new Set<number>();
const lastCloseTry = new Map<number, number>();
async function closeTrade(id: number, reason: string, pxHint?: number, automatic = false) {
  if (closing.has(id)) return { ok: false, error: 'already closing' };
  // An automatic retry (square-off) waits 20 s after a failure, so a broker
  // outage produces one alert every 20 s, not one a second.
  if (automatic && (lastCloseTry.get(id) || 0) > Date.now() - 20000) return { ok: false, error: 'retrying shortly' };
  lastCloseTry.set(id, Date.now());
  closing.add(id);
  try {
    const t = tradeRow(id);
    if (!t || !['OPEN', 'MANUAL', 'CLOSING'].includes(t.status)) return { ok: false, error: 'trade is not open' };
    if (t.mode === 'LIVE') {
      const r = await D.exitPosition(t.tradingsymbol, `TG ${reason}`);
      if (!r.ok && !r.alreadyClosed) { await notify(`⚠️ EXIT FAILED ${t.tradingsymbol}: ${r.error}. Exit it in Kite!`); return r; }
      // exit price and P&L are filled in by the reconcile loop from the broker book
      D.db.prepare("UPDATE signal_trades SET status='CLOSING', exit_reason=?, updated_at=? WHERE id=?").run(reason, Date.now(), id);
    } else {
      const px = pxHint ?? (await priceOf(t.token, t.exchange, t.tradingsymbol)) ?? t.last_ltp;
      finishTrade(id, px, reason);
    }
    openTrades.delete(id);
    return { ok: true };
  } finally { closing.delete(id); }
}
function finishTrade(id: number, px: number | null, reason: string) {
  const t = tradeRow(id);
  const pnl = px != null ? r2((px - t.entry) * t.qty) : null;
  D.db.prepare("UPDATE signal_trades SET status='CLOSED', exit_price=?, exit_at=?, exit_reason=COALESCE(exit_reason, ?), pnl=?, updated_at=? WHERE id=?")
    .run(px, Date.now(), reason, pnl, Date.now(), id);
  openTrades.delete(id);
  void notify(`🏁 CLOSED ${t.mode === 'LIVE' ? '' : '(practice) '}${t.tradingsymbol} @ ${px != null ? rs(px) : '?'} — ${reason}` +
    (pnl != null ? `\nP&L ${pnl >= 0 ? '+' : ''}${rs(pnl)} (before charges)` : ''));
}

/** Called on every option tick (server.ts). Cheap when nothing is open. */
export function signalOnTick(token: number, ltp: number) {
  if (!(ltp > 0)) return;
  // A call waiting for its price is checked on the very tick, not on the next
  // 1-second housekeeping pass.
  if (watchingTokens.size && watchingTokens.has(token)) {
    for (const id of watchingTokens.get(token)!) void checkWatching(id).catch(() => { });
  }
  if (!openTrades.size) return;
  for (const [id, st] of openTrades) {
    const t = tradeRow(id);
    if (!t || t.token !== token || t.status !== 'OPEN') continue;
    const acts = onLadderPrice(st, ltp);
    if (acts.length) void applyLadder(id, acts);
    if (t.mode === 'PRACTICE' && ltp <= st.sl) void closeTrade(id, `SL ${st.sl} hit`, ltp);
  }
}

/** The 1 s housekeeping loop: entries being watched, ladder fallback when ticks
 *  are missing, live exits detected from the rule / broker, and square-off. */
let hkBusy = false;
let warmedFor = '';
async function housekeeping() {
  if (hkBusy) return;
  hkBusy = true;
  try { await housekeepingInner(); } finally { hkBusy = false; }
}
let lastConnectTry = 0;
// (A morning "Log in to Zerodha" button lived here, 25-26 Oct 2026. Martin found
// logging in through it clumsy and asked for it to go; he logs in as before. The
// 09:10 readiness message below still says when Zerodha is not logged in.)

let lastResolveTry = 0;
// MORNING READINESS (09:10 on trading days, while auto-trade is on): one message
// that says either "ready" or exactly what is not — so a problem is found before
// the first call, not by a call being missed.
function readinessTick(t: ReturnType<typeof istParts>) {
  if (settings.mode === 'OFF' || t.day === 0 || t.day === 6 || t.mins < 9 * 60 + 10 || t.mins > 15 * 60) return;
  try { if (!D.isTradingDay(t.date)) return; } catch { }
  const st = getKV('signals_ready_check') || {};
  if (st.date === t.date) return;
  setKV('signals_ready_check', { date: t.date, at: Date.now() });
  const problems: string[] = [];
  if (!tgLoggedIn) problems.push('Telegram is not logged in (Setup, step 2)');
  else if (!channelEntity) problems.push(`the channel "${settings.channelTitle || '?'}" could not be opened`);
  let kiteOk = false; try { kiteOk = D.kiteLoggedInToday(); } catch { }
  if (settings.mode === 'LIVE' && !kiteOk) problems.push('Zerodha is not logged in');
  const size = settings.lots === 'MAX' ? `max lots (up to ${settings.maxLotsCap})` : `${settings.lots} lot${settings.lots === 1 ? '' : 's'}`;
  if (problems.length) void notify(`⚠️ Auto-trade is ${settings.mode} but NOT ready:\n• ${problems.join('\n• ')}`);
  else void notify(`✅ Auto-trade ready (${settings.mode}): reading "${settings.channelTitle}", Zerodha logged in, ${size}, max ${settings.maxTrades} trades.`);
}

async function housekeepingInner() {
  const t = istParts();
  try { readinessTick(t); } catch (e) { console.error('[signals] readiness', e); }
  if (tg && tgLoggedIn && settings.channelId && !channelEntity && Date.now() - lastResolveTry > 60000) {
    lastResolveTry = Date.now();
    void resolveChannel();
  }
  if (!tg && apiCreds() && Date.now() - lastConnectTry > 60000) {
    lastConnectTry = Date.now();
    void tgConnect().catch((e: any) => { tgStatus = `error: ${e?.message || e}`; });
  }
  // Load both contract files before the open, so the first call of the day does
  // not wait on a multi-megabyte download.
  if (t.mins >= 9 * 60 && warmedFor !== t.date && t.day >= 1 && t.day <= 5) {
    warmedFor = t.date;
    // Yesterday's watched contracts leave the live feed; open trades stay.
    watchTokens.clear();
    for (const [id] of openTrades) { const r = tradeRow(id); if (r) watchTokens.add(r.token); }
    D.refreshSubscriptions();
    void D.findOption('NIFTY', 0, 'CE', t.date).catch(() => { });
    void D.findOption('SENSEX', 0, 'CE', t.date).catch(() => { });
  }
  // watched calls
  const watching = D.db.prepare("SELECT id, token FROM signal_calls WHERE status='WATCHING'").all() as any[];
  watchingTokens.clear();
  for (const c of watching) { if (c.token) watchingTokens.set(c.token, [...(watchingTokens.get(c.token) || []), c.id]); }
  for (const c of watching) await checkWatching(c.id);
  // expire calls whose levels never came
  for (const c of D.db.prepare("SELECT id FROM signal_calls WHERE status='WAITING_LEVELS' AND received_at < ?").all(Date.now() - 180000) as any[])
    await skip(c.id, 'the TP/SL message never arrived (3 min)', settings.mode === 'OFF');
  // open trades
  for (const [id, st] of openTrades) {
    const tr = tradeRow(id);
    if (!tr) { openTrades.delete(id); continue; }
    const tick = D.getLatestTick(tr.token);
    if (!tick || Date.now() - tick.ts > 3000) {
      const px = await priceOf(tr.token, tr.exchange, tr.tradingsymbol);
      if (px != null) signalOnTick(tr.token, px);
    }
    if (tr.mode === 'LIVE') {
      const rs_ = D.ruleStatus(tr.tradingsymbol);
      if (rs_ && rs_ !== 'ACTIVE') {          // the engine exited (SL), or the rule was cleared elsewhere
        D.db.prepare("UPDATE signal_trades SET status='CLOSING', exit_reason=COALESCE(exit_reason, ?), updated_at=? WHERE id=?")
          // TRIGGERED is the engine's stop exit in flight, DONE the same exit placed —
          // both are the SL. Anything else (CANCELLED) was cleared elsewhere.
          .run(rs_ === 'DONE' || rs_ === 'TRIGGERED' ? `SL ${st.sl} hit` : `rule ${rs_.toLowerCase()}`, Date.now(), id);
        openTrades.delete(id);
      }
    }
  }
  // square-off
  if (t.mins >= hm(settings.squareOff) && t.mins < 15 * 60 + 40) {
    for (const id of Array.from(openTrades.keys())) await closeTrade(id, `intraday square-off ${settings.squareOff}`, undefined, true);
    for (const r of D.db.prepare("SELECT id FROM signal_trades WHERE status='MANUAL'").all() as any[]) await closeTrade(r.id, `intraday square-off ${settings.squareOff}`, undefined, true);
  }
  if (t.mins > hm(settings.lastEntry)) for (const c of D.db.prepare("SELECT id FROM signal_calls WHERE status IN ('WAITING_LEVELS','WATCHING')").all() as any[])
    await skip(c.id, 'reached the last entry time', true);
}

/** Live trades marked CLOSING are finished from the broker's own book, so the
 *  exit price and P&L are Zerodha's numbers, not ours. Every 5 s. */
const stuckWarned = new Set<number>();
async function reconcileLive() {
  const rows: any[] = D.db.prepare("SELECT * FROM signal_trades WHERE mode='LIVE' AND status IN ('CLOSING','MANUAL')").all();
  if (!rows.length) return;
  const kc = D.getKiteClient();
  if (!kc || !kc.access_token) return;
  let net: any[] = [];
  try { net = (await kc.getPositions())?.net || []; } catch { return; }
  for (const r of rows) {
    const p = net.find((x: any) => x.tradingsymbol === r.tradingsymbol);
    if (p && Number(p.quantity) !== 0) {                  // still open
      if (r.status === 'CLOSING' && Date.now() - r.updated_at > 60000 && !stuckWarned.has(r.id)) {
        stuckWarned.add(r.id);
        await notify(`⚠️ ${r.tradingsymbol} is STILL OPEN a minute after the exit was sent. Check Kite and exit it there.`, [{ text: '🚪 Try exit again', data: `exit:${r.id}` }]);
      }
      continue;
    }
    const px = p && Number(p.sell_price) > 0 ? Number(p.sell_price) : null;
    finishTrade(r.id, px, r.exit_reason || 'closed');
  }
}

// ---------- hooks used by server.ts ----------
export function signalTokens(): number[] { return Array.from(watchTokens); }

/** Martin re-armed SL/TP on the chart for a contract the app is managing: hand
 *  it over. His rule is now in charge; the ladder stops moving the stop. */
export function signalNoteManualRearm(tradingsymbol: string) {
  if (!D) return;
  for (const [id, st] of openTrades) {
    const t = tradeRow(id);
    if (t?.tradingsymbol === tradingsymbol && t.mode === 'LIVE') {
      // In the first 15 s this is the chart's automatic -10%/+20% default
      // landing just after the fill (it arms any position it sees with no rule),
      // not Martin. The message's SL wins: re-arm it.
      if (Date.now() - t.entry_at < 15000) {
        D.armRule({ tradingsymbol, exchange: t.exchange, qty: t.qty, entry: t.entry, sl: st.sl, tp: st.tps[2], token: t.token });
        logEvent(`${tradingsymbol}: the chart's default SL/TP arrived just after the fill — replaced with the message's SL ${st.sl}`);
        continue;
      }
      D.db.prepare("UPDATE signal_trades SET status='MANUAL', updated_at=? WHERE id=?").run(Date.now(), id);
      openTrades.delete(id);
      void notify(`✋ You changed the SL/TP of ${tradingsymbol} on the chart — the app has stopped moving its stop. Your chart levels are in charge now (15:15 square-off still applies).`);
    }
  }
}

async function keep(id: number) {
  const st = openTrades.get(id);
  if (!st) return 'That trade is no longer open.';
  if (st.stage < 3) return 'TP3 has not been reached yet.';
  if (st.decision === 'KEEP') return 'Already trailing.';
  const acts = keepTrailing(st);
  saveLadder(id, st);
  await notify(`📈 Keeping ${tradeRow(id).tradingsymbol} — SL trails up in steps of ${rs(st.tps[2] - st.tps[1])} above TP3. Now SL ${rs(st.sl)}.`);
  await applyLadder(id, acts);
  return 'Keeping it — trailing.';
}

// ---------- bot polling (buttons, /start) ----------
let botOffset = 0;
let botUser: string | null = null;
async function botLoop() {
  for (;;) {
    if (!BOT()) { await new Promise(r => setTimeout(r, 30000)); continue; }
    if (!botUser) { const me = await botCall('getMe', {}); botUser = me?.ok ? me.result.username : null; }
    const r = await botCall('getUpdates', { offset: botOffset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
    if (!r?.ok) { await new Promise(res => setTimeout(res, 5000)); continue; }
    for (const u of r.result || []) {
      botOffset = u.update_id + 1;
      try { await onBotUpdate(u); } catch (e: any) { console.error('[signals] bot update', e?.message || e); }
    }
  }
}
async function onBotUpdate(u: any) {
  const owner = getKV('signals_owner_id');
  const from = String(u.message?.from?.id || u.callback_query?.from?.id || '');
  // Only Martin's own Telegram account (learned at login) may use the bot.
  if (!owner || from !== String(owner)) {
    if (u.message) await botCall('sendMessage', { chat_id: u.message.chat.id, text: owner ? 'This bot is private.' : 'Log in to Telegram on the app\'s Signals page first, then press Start again.' });
    if (u.callback_query) await botCall('answerCallbackQuery', { callback_query_id: u.callback_query.id, text: 'Not allowed' });
    return;
  }
  if (u.message) {
    setKV('signals_bot_chat', u.message.chat.id);
    await botCall('sendMessage', { chat_id: u.message.chat.id, text: `✅ Linked. NIFTY app alerts will come here.\nAuto-trade is ${settings.mode}${settings.channelTitle ? ` on "${settings.channelTitle}"` : ''}.` });
    return;
  }
  const q = u.callback_query;
  const [act, idS] = String(q.data || '').split(':');
  const id = Number(idS);
  let answer = '…';
  if (act === 'exit') { const r = await closeTrade(id, 'Exit button (Telegram)'); answer = r.ok ? 'Exiting…' : (r.error || 'failed'); }
  else if (act === 'keep') answer = await keep(id);
  await botCall('answerCallbackQuery', { callback_query_id: q.id, text: answer });
}

// ---------- HTTP API ----------
function pinOk(given: any): boolean {
  const want = String(process.env.SIGNALS_PIN || '');
  if (!want) return false;
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const needPin = (req: any, res: any) => {
  if (!process.env.SIGNALS_PIN) { res.status(403).json({ ok: false, error: 'Set SIGNALS_PIN in Railway first.' }); return false; }
  if (!pinOk(req.body?.pin)) { res.status(401).json({ ok: false, error: 'Wrong PIN.' }); return false; }
  return true;
};

export function registerSignalTrader(app: any, deps: SignalDeps) {
  D = deps;
  initTables();
  loadSettings();
  loadOpenTrades();
  deps.refreshSubscriptions();
  const json = express.json({ limit: '20kb' });

  app.get('/api/signals/status', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    const day = istParts().date;
    const calls = D.db.prepare('SELECT * FROM signal_calls WHERE day = ? ORDER BY id DESC').all(day);
    const trades = D.db.prepare("SELECT * FROM signal_trades WHERE day = ? OR status IN ('OPEN','MANUAL','CLOSING') ORDER BY id DESC").all(day)
      .map((t: any) => ({ ...t, ladder: (() => { try { return JSON.parse(t.ladder); } catch { return null; } })() }));
    const events = D.db.prepare('SELECT at, text FROM signal_events WHERE day = ? ORDER BY id DESC LIMIT 60').all(day);
    res.json({
      settings, pinConfigured: !!process.env.SIGNALS_PIN,
      telegram: { apiConfigured: !!apiCreds(), status: tgStatus, loggedIn: tgLoggedIn, me: tgMe?.name || null, awaitingCode: !!pendingLogin,
        channelOpen: !!channelEntity, channelOpenedAt: channelResolvedAt || null, lastUpdateAt: lastUpdateAt || null, lastChannelPushAt: lastChannelPushAt || null },
      bot: { configured: !!BOT(), username: botUser, linked: !!getKV('signals_bot_chat') },
      tradesToday: tradesToday(), calls, trades, events, recentMessages: recentMsgs.slice(0, 15),
      kite: { loggedInToday: (() => { try { return D.kiteLoggedInToday(); } catch { return false; } })() },
    });
  });

  app.post('/api/signals/settings', json, (req: any, res: any) => {
    const b = req.body || {};
    // Switching OFF needs no PIN: anyone must be able to stop it.
    if (b.mode === 'OFF' && Object.keys(b).every(k => k === 'mode' || k === 'pin')) {
      settings.mode = 'OFF'; saveSettings(); logEvent('auto-trade switched OFF'); return res.json({ ok: true, settings });
    }
    if (!needPin(req, res)) return;
    const num = (v: any, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
    if (b.mode && ['OFF', 'PRACTICE', 'LIVE'].includes(b.mode)) {
      if (b.mode !== 'OFF' && !settings.channelId) return res.json({ ok: false, error: 'Pick the channel first.' });
      settings.mode = b.mode;
    }
    if (b.lots !== undefined) settings.lots = String(b.lots).toUpperCase() === 'MAX' ? 'MAX' : Math.round(num(b.lots, 1, 25, settings.lots === 'MAX' ? 1 : settings.lots));
    if (b.maxLotsCap !== undefined) settings.maxLotsCap = Math.round(num(b.maxLotsCap, 1, 25, settings.maxLotsCap));
    if (b.maxTrades !== undefined) settings.maxTrades = Math.round(num(b.maxTrades, 1, 10, settings.maxTrades));
    if (b.allowAbove !== undefined) settings.allowAbove = num(b.allowAbove, 0, 20, settings.allowAbove);
    if (b.waitMin !== undefined) settings.waitMin = num(b.waitMin, 0, 60, settings.waitMin);
    if (typeof b.lastEntry === 'string' && /^\d{2}:\d{2}$/.test(b.lastEntry)) settings.lastEntry = b.lastEntry;
    if (typeof b.squareOff === 'string' && /^\d{2}:\d{2}$/.test(b.squareOff)) settings.squareOff = b.squareOff;
    saveSettings();
    logEvent(`settings: ${settings.mode}, ${settings.lots === 'MAX' ? `MAX lots (cap ${settings.maxLotsCap})` : `${settings.lots} lot`}, max ${settings.maxTrades}/day, +${settings.allowAbove} above range, wait ${settings.waitMin} min`);
    res.json({ ok: true, settings });
  });

  app.post('/api/signals/tg/send-code', json, async (req: any, res: any) => {
    if (!needPin(req, res)) return;
    try {
      await tgConnect();
      if (!tg) return res.json({ ok: false, error: tgStatus });
      const phone = String(req.body?.phone || '').replace(/[^\d+]/g, '');
      if (!/^\+\d{8,15}$/.test(phone)) return res.json({ ok: false, error: 'Enter the phone number with country code, e.g. +971…' });
      const r = await tg.sendCode(apiCreds()!, phone);
      pendingLogin = { phone, hash: r.phoneCodeHash };
      res.json({ ok: true, viaApp: r.isCodeViaApp });
    } catch (e: any) { res.json({ ok: false, error: e?.errorMessage || e?.message || String(e) }); }
  });

  app.post('/api/signals/tg/sign-in', json, async (req: any, res: any) => {
    if (!needPin(req, res)) return;
    if (!tg || !pendingLogin) return res.json({ ok: false, error: 'Request a code first.' });
    const code = String(req.body?.code || '').replace(/\D/g, '');
    const pw = String(req.body?.password || '');
    try {
      try {
        await tg.invoke(new Api.auth.SignIn({ phoneNumber: pendingLogin.phone, phoneCodeHash: pendingLogin.hash, phoneCode: code }));
      } catch (e: any) {
        if (e?.errorMessage !== 'SESSION_PASSWORD_NEEDED') throw e;
        if (!pw) return res.json({ ok: false, needPassword: true, error: 'Your Telegram has a 2-step password — enter it too.' });
        const info = await tg.invoke(new Api.account.GetPassword());
        await tg.invoke(new Api.auth.CheckPassword({ password: await tgPassword.computeCheck(info, pw) }));
      }
      setKV('signals_tg_session', (tg.session as any).save());
      pendingLogin = null; tgLoggedIn = true; tgStatus = 'connected';
      await afterLogin();
      logEvent(`Telegram logged in as ${tgMe?.name}`);
      res.json({ ok: true, me: tgMe?.name });
    } catch (e: any) { res.json({ ok: false, error: e?.errorMessage || e?.message || String(e) }); }
  });

  app.post('/api/signals/tg/logout', json, async (req: any, res: any) => {
    if (!needPin(req, res)) return;
    settings.mode = 'OFF'; saveSettings();
    try { if (tg && tgLoggedIn) await tg.invoke(new Api.auth.LogOut()); } catch { }
    try { await tg?.disconnect(); } catch { }
    tg = null; tgLoggedIn = false; tgMe = null; channelEntity = null; handlerAdded = false; tgStatus = 'logged out';
    setKV('signals_tg_session', ''); setKV('signals_owner_id', null);
    logEvent('Telegram logged out; auto-trade OFF');
    res.json({ ok: true });
  });

  app.post('/api/signals/tg/channels', json, async (req: any, res: any) => {
    if (!needPin(req, res)) return;
    if (!tg || !tgLoggedIn) return res.json({ ok: false, error: 'Log in to Telegram first.' });
    try {
      const ds: any[] = await tg.getDialogs({ limit: 300 });
      const list = ds.filter(d => d.isChannel || d.isGroup).map(d => ({ id: String(d.entity?.id), title: d.title, broadcast: !!d.entity?.broadcast }));
      res.json({ ok: true, channels: list });
    } catch (e: any) { res.json({ ok: false, error: e?.message || String(e) }); }
  });

  app.post('/api/signals/channel', json, async (req: any, res: any) => {
    if (!needPin(req, res)) return;
    const id = String(req.body?.id || ''), title = String(req.body?.title || '').slice(0, 120);
    if (!/^\d+$/.test(id)) return res.json({ ok: false, error: 'Bad channel id' });
    settings.channelId = id; settings.channelTitle = title; saveSettings();
    await resolveChannel();
    logEvent(`channel set: ${title}`);
    res.json({ ok: true, settings });
  });

  app.post('/api/signals/exit', json, async (req: any, res: any) => {
    const r = await closeTrade(Number(req.body?.id), 'Exit button (app)');
    res.json(r);
  });
  app.post('/api/signals/keep', json, async (req: any, res: any) => {
    res.json({ ok: true, message: await keep(Number(req.body?.id)) });
  });
  app.post('/api/signals/test-alert', json, async (req: any, res: any) => {
    if (!needPin(req, res)) return;
    await notify('🔔 Test alert from your NIFTY app. Buttons and trade alerts will arrive here.');
    res.json({ ok: true, linked: !!getKV('signals_bot_chat') });
  });

  // background
  lastConnectTry = Date.now();
  void tgConnect().catch((e: any) => { tgStatus = `error: ${e?.message || e}`; console.error('[signals] connect', e); });
  void botLoop();
  setInterval(() => { void housekeeping().catch(e => console.error('[signals] housekeeping', e)); }, 1000);
  setInterval(() => { void pollChannel(); }, 3000);
  setInterval(() => { void reconcileLive().catch(() => { }); }, 5000);
  console.log('[signals] registered: /api/signals/*');
}

// exported for the end-to-end test harness
export const __test = {
  handleMessage, housekeeping, reconcileLive, closeTrade, keep, onBotUpdate,
  get settings() { return settings; }, setSettings(s: Partial<Settings>) { settings = { ...settings, ...s }; },
  setClockOffset(ms: number) { clockOffsetMs = ms; }, clearPriceCache() { lastRestAt.clear(); restLtp.clear(); }, setOwner(id: string) { setKV('signals_owner_id', id); },
};
