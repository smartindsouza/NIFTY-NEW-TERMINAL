import express from "express";
import path from "path";
import axios from 'axios';
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from 'ws';
import * as http from 'http';
import cron from 'node-cron';
import Database from 'better-sqlite3';
import { generateSimulatedChain } from './server/simulate_data';
import { computeAnalytics } from './server/analytics_engine';
import { getTechnicalAnalysis, kiteDiagnostics, taFreshness } from './server/technical_analysis';
import { getKiteClient, generateSession, getLiveOptionChain, getKiteLoginUrl, searchInstruments, clearInstrumentsCache, getKiteReportData, getIndexFuturesTokens, getBseIndexToken, getOptionToken } from './server/kite_service';
import { getHistoricalAnalytics } from './server/analytics_service';
import { runRsiBacktest } from './server/rsi_backtest';
import { getLiveSignal, runOptionConfirmBacktest, getAlertSignal } from './server/option_rsi';
import { ivAndDelta } from './server/options_math';
import { getGammaBlast } from './server/gamma_blast';
import { getPremiumPulse, getPremiumPulseBias } from './server/premium_pulse';
import { getFiiData, getCashFiiDii } from './server/fii_service';
import { registerGapScorecard, toISTString } from './server/gap_scorecard';
import { registerCalendar, isNseHoliday as calIsNseHoliday, holidayName } from './server/calendar_service';
import { GAP_CONFIG } from './server/config/gapScorecard';
import { evaluateQuantSignals } from './server/quant_engine';
import { generateGamePlan } from './server/game_plan_service';

import { getLiveNews, rateLimitMiddleware, currentAIStatus } from './server/news_service';
import { startTicker, setSubscriptions, isTickerConnected } from './server/ticker_service';
import { setDeltaFuturesToken, getDeltaFuturesToken, onFuturesTick, getDeltaSnapshot } from './server/delta_tracker';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const KITE_DATA_DIR = process.env.KITE_DATA_DIR || '.';
const db = new Database(`${KITE_DATA_DIR}/kite_session.db`);
// Premium-based auto-exit rules: the draggable SL/TP lines on the traded
// option's chart. One rule per symbol; the engine below watches option LTP and
// fires a real exit through closePositionBySymbol when a level is crossed.
// Daily journal of externally-supplied "H levels" (formula undisclosed).
// Stored dated for later reverse-engineering against price data.
// PER-INDEX H-LEVELS. The original table keyed rows by DATE alone, which was fine
// while NIFTY was the only chart — but Bank Nifty and SENSEX have their own levels,
// and on a shared date they would silently overwrite each other AND corrupt the
// NIFTY series that has been collecting since 23 Jul for the formula hunt.
//
// The rebuild is done as a NEW table rather than an ALTER, because the primary key
// itself has to change (sqlite cannot alter one in place). Existing rows are copied
// across and tagged NIFTY, which is what they are. The original table is left
// untouched as a backup — nothing is dropped.
db.exec(`CREATE TABLE IF NOT EXISTS h_levels_v2 (
  symbol TEXT NOT NULL, date TEXT NOT NULL, levels TEXT NOT NULL, note TEXT DEFAULT '',
  created_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (symbol, date)
);`);
try {
  const already: any = db.prepare('SELECT COUNT(*) AS n FROM h_levels_v2').get();
  if (!already || already.n === 0) {
    const moved = db.prepare(`INSERT OR IGNORE INTO h_levels_v2 (symbol, date, levels, note, created_at, updated_at)
      SELECT 'NIFTY', date, levels, note, created_at, updated_at FROM h_levels`).run();
    if (moved && moved.changes) console.log(`[h-levels] migrated ${moved.changes} existing rows to NIFTY`);
  }
} catch (e) { console.error('[h-levels] migration skipped:', e); }

db.exec(`CREATE TABLE IF NOT EXISTS h_levels (
  date TEXT PRIMARY KEY, levels TEXT NOT NULL, note TEXT DEFAULT '',
  created_at INTEGER, updated_at INTEGER
);`);
db.exec(`CREATE TABLE IF NOT EXISTS premium_exit_rules (
  tradingsymbol TEXT PRIMARY KEY, exchange TEXT, side TEXT, qty INTEGER,
  entry REAL, sl REAL, tp REAL, status TEXT, attempts INTEGER DEFAULT 0,
  last_ltp REAL, detail TEXT, created_at INTEGER, updated_at INTEGER
);`);
// Tick engine: the armed contract's instrument token, resolved at arm time so
// the Kite ticker can stream it. Nullable — rules without a token still work
// through the 3s poll. ALTER throws if the column already exists; that's fine.
try { db.exec(`ALTER TABLE premium_exit_rules ADD COLUMN instrument_token INTEGER`); } catch (e) { /* column exists */ }

// In-memory mirror of ACTIVE premium-exit rules, keyed by instrument token, so
// the tick handler can evaluate SL/TP in O(1) per tick without touching sqlite.
// The DB stays the source of truth; this map is rebuilt from it on start and
// kept in sync by arm / clear / fire below.
const premiumRulesByToken = new Map<number, any>();
function premiumRuleTokens(): number[] { return Array.from(premiumRulesByToken.keys()); }
function syncPremiumRuleInMemory(row: any | null, removeToken?: number | null) {
  if (removeToken) premiumRulesByToken.delete(removeToken);
  if (row && row.status === 'ACTIVE' && row.instrument_token) {
    premiumRulesByToken.set(Number(row.instrument_token), row);
  }
}
function loadActivePremiumRules() {
  premiumRulesByToken.clear();
  try {
    const rows: any[] = db.prepare("SELECT * FROM premium_exit_rules WHERE status='ACTIVE'").all() as any[];
    for (const r of rows) syncPremiumRuleInMemory(r);
  } catch (e) { console.error('[premium-exit] load ACTIVE rules failed', e); }
}
loadActivePremiumRules();
// WAL lets readers and a writer work concurrently; busy_timeout makes writes wait
// instead of failing with "database is locked" (the two DB connections share one file).
try { db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000'); } catch (e) { console.error('DB pragma error', e); }
db.pragma('journal_mode = WAL');

// Simple Token Table
db.prepare(`
  CREATE TABLE IF NOT EXISTS kite_tokens (
    id INTEGER PRIMARY KEY,
    access_token TEXT,
    token_date TEXT
  )
`).run();

// Auto-exit rules (server-side stoploss/target watcher: spot levels + RSI levels)
db.prepare(`
  CREATE TABLE IF NOT EXISTS exit_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tradingsymbol TEXT,
    exchange TEXT,
    qty INTEGER,
    product TEXT,
    exit_side TEXT,
    spot_lower REAL,
    spot_upper REAL,
    spot_mode TEXT,
    rsi_lower REAL,
    rsi_upper REAL,
    timeframe TEXT,
    underlying_token TEXT,
    status TEXT,
    detail TEXT,
    created_at INTEGER
  )
`).run();

// Trade Journal (Phase 1 of AI analysis): every trade recorded with its market context,
// so Claude can later review them for patterns. Append-only history, separate from live positions.
db.prepare(`
  CREATE TABLE IF NOT EXISTS trade_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tradingsymbol TEXT,
    exchange TEXT,
    option_type TEXT,
    strike REAL,
    side TEXT,
    qty INTEGER,
    product TEXT,
    entry_price REAL,
    entry_time INTEGER,
    entry_spot REAL,
    context TEXT,
    test_mode INTEGER DEFAULT 0,
    simulated INTEGER DEFAULT 0,
    status TEXT DEFAULT 'OPEN',
    exit_price REAL,
    exit_time INTEGER,
    exit_reason TEXT,
    pnl REAL,
    created_at INTEGER,
    updated_at INTEGER
  )
`).run();

// Migration: add trailing-stop columns if they don't exist yet
for (const [col, def] of ([
  ['trail_enabled', 'INTEGER DEFAULT 0'],
  ['trail_candles', 'INTEGER DEFAULT 3'],
  ['target_price', 'REAL'],
  ['trail_dir', 'TEXT'],
  ['trail_active', 'INTEGER DEFAULT 0'],
  ['trail_stop', 'REAL'],
  ['stop_mode', "TEXT DEFAULT 'CLOSE'"],
  ['target_mode', "TEXT DEFAULT 'CLOSE'"],
  ['structure_stop', 'TEXT'],
] as [string, string][])) {
  try { db.prepare(`ALTER TABLE exit_rules ADD COLUMN ${col} ${def}`).run(); } catch (e) { /* column already exists */ }
}

// Generic synced-settings store. This app is single-user, so one row per key is
// shared by all of the user's logged-in devices (they all hit this same server +
// DB). Used for sidebar order, H-levels, and any future cross-device preference.
db.prepare(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  )
`).run();

function getTodayAccessToken(): string | null {
  try {
    const today = new Date().toISOString().split('T')[0];
    const row = db.prepare('SELECT access_token FROM kite_tokens WHERE token_date = ? ORDER BY id DESC LIMIT 1').get(today) as any;
    return row?.access_token || null;
  } catch { return null; }
}

// Places a LIMIT exit order on Kite (used by the auto-exit watcher).
// SELL to close a long, BUY to cover a short. Priced at live ±0.5% (tick-rounded) so it fills fast.
async function placeKiteLimitExit(opts: { exchange: string; tradingsymbol: string; qty: number; product: string; side: string; }): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  try {
    const kc = getKiteClient();
    // @ts-ignore
    if (!kc || !kc.access_token) return { ok: false, error: 'No active Kite session — cannot place exit order' };
    const fullSymbol = `${opts.exchange}:${opts.tradingsymbol}`;
    let basePrice = 0;
    try {
      const q = await kc.getQuote([fullSymbol]);
      basePrice = q?.[fullSymbol]?.last_price || 0;
    } catch {}
    if (!basePrice || basePrice <= 0) return { ok: false, error: 'Could not fetch live price for exit' };
    const isBuy = String(opts.side).toUpperCase() === 'BUY';
    const buffer = isBuy ? 1.005 : 0.995;
    const price = parseFloat((Math.round((basePrice * buffer) / 0.05) * 0.05).toFixed(2));
    const payload: any = {
      exchange: opts.exchange,
      tradingsymbol: opts.tradingsymbol,
      transaction_type: opts.side,
      quantity: opts.qty,
      product: opts.product || 'MIS',
      order_type: 'LIMIT',
      price,
      validity: 'DAY',
    };
    const resp = await kc.placeOrder('regular', payload);
    const orderId = typeof resp === 'string' ? resp : (resp as any).order_id;
    return { ok: true, orderId };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Closes the ACTUAL open position for a symbol: reads its real product, quantity and
// direction from Kite and places a matching closing order. This guarantees the order
// flattens the position (no product mismatch, no accidental new short).
// ===== Trade Journal helpers (Phase 1) =====
function journalOpenTrade(o: {
  tradingsymbol: string; exchange?: string; side: string; qty: number; product?: string;
  entryPrice?: number; entrySpot?: number; optionType?: string; strike?: number;
  context?: any; testMode?: boolean; simulated?: boolean;
}) {
  try {
    const now = Date.now();
    db.prepare(`INSERT INTO trade_journal
      (tradingsymbol, exchange, option_type, strike, side, qty, product, entry_price, entry_time, entry_spot, context, test_mode, simulated, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'OPEN', ?, ?)`)
      .run(
        o.tradingsymbol, o.exchange || 'NFO', o.optionType || null, (o.strike ?? null) as any,
        o.side, o.qty, o.product || 'MIS', (o.entryPrice ?? null) as any, now, (o.entrySpot ?? null) as any,
        o.context ? JSON.stringify(o.context) : null, o.testMode ? 1 : 0, o.simulated ? 1 : 0, now, now
      );
  } catch (e) { console.error('[Journal] open insert failed', e); }
}

function journalCloseTrade(tradingsymbol: string, c: { exitPrice?: number; pnl?: number; reason?: string }) {
  try {
    const now = Date.now();
    // Close the most recent still-open row for this symbol (no-op if none — keeps double-close safe)
    const row = db.prepare(`SELECT id FROM trade_journal WHERE tradingsymbol = ? AND status = 'OPEN' ORDER BY entry_time DESC LIMIT 1`).get(tradingsymbol) as any;
    if (!row) return;
    db.prepare(`UPDATE trade_journal SET status='CLOSED', exit_price=?, exit_time=?, exit_reason=?, pnl=?, updated_at=? WHERE id=?`)
      .run((c.exitPrice ?? null) as any, now, c.reason || 'MANUAL', (c.pnl ?? null) as any, now, row.id);
  } catch (e) { console.error('[Journal] close update failed', e); }
}

async function closePositionBySymbol(tradingsymbol: string, reason: string = 'MANUAL'): Promise<{ ok: boolean; orderId?: string; error?: string; alreadyClosed?: boolean }> {
  try {
    const kc = getKiteClient();
    // @ts-ignore
    if (!kc || !kc.access_token) return { ok: false, error: 'No active Kite session — please log in to Zerodha today.' };
    let positions: any;
    try { positions = await kc.getPositions(); } catch (e: any) { return { ok: false, error: 'Could not read positions: ' + (e?.message || e) }; }
    const net = (positions && positions.net) || [];
    const pos = net.find((p: any) => p.tradingsymbol === tradingsymbol && p.quantity !== 0);
    if (!pos) return { ok: false, alreadyClosed: true, error: `No open position found for ${tradingsymbol} on Zerodha (it may already be closed).` };
    const qty = Math.abs(pos.quantity);
    const side = pos.quantity > 0 ? 'SELL' : 'BUY'; // long -> sell to close; short -> buy to close
    const exitResult = await placeKiteLimitExit({ exchange: pos.exchange || 'NFO', tradingsymbol, qty, product: pos.product || 'NRML', side });
    if (exitResult.ok) {
      // Record the close in the trade journal (Kite's own last price + P&L for this leg)
      journalCloseTrade(tradingsymbol, { exitPrice: pos.last_price, pnl: pos.pnl, reason });
    }
    return exitResult;
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ===== Premium-exit shared core (used by BOTH the tick path and the 3s poll) =====
// One evaluation, one fire path, one atomic claim — the tick handler and the
// poll can race freely and at most ONE exit order can ever result.
function evalPremiumRule(rule: any, ltp: number): 'SL' | 'TARGET' | null {
  const long = rule.side === 'BUY';
  const hitSl = long ? ltp <= rule.sl : ltp >= rule.sl;
  const hitTp = long ? ltp >= rule.tp : ltp <= rule.tp;
  return hitSl ? 'SL' : hitTp ? 'TARGET' : null;
}

// Ticks arrive many times a second; sqlite doesn't need every one. last_ltp is a
// display/debug field — 1 write/sec per symbol keeps it fresh without hammering.
const lastRuleLtpWriteAt = new Map<string, number>();
function persistRuleLtpThrottled(tradingsymbol: string, ltp: number) {
  const now = Date.now();
  if ((lastRuleLtpWriteAt.get(tradingsymbol) || 0) > now - 1000) return;
  lastRuleLtpWriteAt.set(tradingsymbol, now);
  try { db.prepare("UPDATE premium_exit_rules SET last_ltp=?, updated_at=? WHERE tradingsymbol=?").run(ltp, now, tradingsymbol); } catch (e) {}
}

const premiumExitBusy = new Set<string>();
async function firePremiumExit(tradingsymbol: string, reason: string): Promise<void> {
  if (premiumExitBusy.has(tradingsymbol)) return;
  premiumExitBusy.add(tradingsymbol);
  try {
    // Atomic claim: only ONE caller can move ACTIVE → TRIGGERED. Everyone else
    // sees changes === 0 and walks away order-free. On top of this,
    // closePositionBySymbol re-verifies the position live on Zerodha, so even a
    // logic bug here could at worst place one flattening order, never an entry.
    const claim = db.prepare("UPDATE premium_exit_rules SET status='TRIGGERED', detail=?, updated_at=? WHERE tradingsymbol=? AND status='ACTIVE'")
      .run(reason, Date.now(), tradingsymbol);
    if (claim.changes === 0) return;
    const row: any = db.prepare("SELECT * FROM premium_exit_rules WHERE tradingsymbol=?").get(tradingsymbol);
    console.log(`[premium-exit] ${reason} -> exiting ${tradingsymbol}`);
    try {
      const result = await closePositionBySymbol(tradingsymbol, reason);
      if (result.ok || result.alreadyClosed) {
        db.prepare("UPDATE premium_exit_rules SET status='DONE', detail=?, updated_at=? WHERE tradingsymbol=?")
          .run(reason + (result.alreadyClosed ? ' | position was already closed' : ' | exit placed'), Date.now(), tradingsymbol);
        syncPremiumRuleInMemory(null, row?.instrument_token ? Number(row.instrument_token) : null);
      } else {
        const attempts = (row?.attempts || 0) + 1;
        const nextStatus = attempts >= 3 ? 'ERROR' : 'ACTIVE';
        db.prepare("UPDATE premium_exit_rules SET status=?, attempts=?, detail=?, updated_at=? WHERE tradingsymbol=?")
          .run(nextStatus, attempts, reason + ' | exit FAILED: ' + (result.error || 'rejected'), Date.now(), tradingsymbol);
        console.error(`[premium-exit] exit failed for ${tradingsymbol} (attempt ${attempts}):`, result.error);
        const fresh: any = db.prepare("SELECT * FROM premium_exit_rules WHERE tradingsymbol=?").get(tradingsymbol);
        syncPremiumRuleInMemory(nextStatus === 'ACTIVE' ? fresh : null, row?.instrument_token ? Number(row.instrument_token) : null);
      }
    } catch (e: any) {
      db.prepare("UPDATE premium_exit_rules SET status='ACTIVE', attempts=attempts+1, detail=?, updated_at=? WHERE tradingsymbol=?")
        .run(reason + ' | exit threw: ' + (e?.message || e), Date.now(), tradingsymbol);
      const fresh: any = db.prepare("SELECT * FROM premium_exit_rules WHERE tradingsymbol=?").get(tradingsymbol);
      syncPremiumRuleInMemory(fresh, row?.instrument_token ? Number(row.instrument_token) : null);
    }
  } finally {
    premiumExitBusy.delete(tradingsymbol);
  }
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  
  // Setup WS Server
  const wss = new WebSocketServer({ server, path: '/api/ws' });

  wss.on('connection', (ws) => {
    ws.on('message', (message) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.type === 'subscribe') {
          (ws as any).subscribedSymbol = parsed.symbol;
          console.log(`[WS Server] Client subscribed to dynamic symbols: ${parsed.symbol}`);
          ws.send(JSON.stringify({ type: 'subscribed', symbol: parsed.symbol }));
        }
      } catch (err) {
        console.error("WS parse error:", err);
      }
    });
    ws.send(JSON.stringify({ type: 'connected' }));
  });

  function isNSEMarketOpen(): boolean {
    const now = new Date();
    const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
    const ist = new Date(istMs);
    const day = ist.getUTCDay();
    if (day === 0 || day === 6) return false;
    const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
  }

  setInterval(() => {
    if (isTickerConnected()) return;
    if (!isNSEMarketOpen()) return;
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        const symbol = (client as any).subscribedSymbol || 'NSE:NIFTY 50';
        const isNifty = symbol === 'NSE:NIFTY 50' || symbol === 'NIFTY 50';
        const tickPrice = isNifty ? latestSpot : 22100;
        const timestampSeconds = Math.floor(Date.now() / 1000);
        client.send(JSON.stringify({
          type: 'tick', symbol, price: tickPrice, timestamp: timestampSeconds,
          candle: { time: timestampSeconds, open: tickPrice, high: tickPrice, low: tickPrice, close: tickPrice }
        }));
      }
    });
  }, 1000);

  // Keep-alive heartbeat so reverse proxy doesn't kill idle connections
  setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.readyState === 1) { // 1 = OPEN
        client.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
      }
    });
  }, 30000);

let latestSpot = 22000;
let lastRealSpotTickAt = 0; // ms timestamp of the last REAL spot tick (for watcher safety)
let latestChainData: any = null;
let latestAnalytics: any = null;

// ===== SENSEX (BSE/BFO) support =====
// The SENSEX index token streams ALWAYS (one token — powers the index chart's
// live candle). The SENSEX option-chain cache + its option tokens only refresh
// while someone is actually using SENSEX (chain page / chart / open ticket),
// signalled by /api/option-chain?symbol=SENSEX hits — keeps the ticker set and
// Kite quote calls small when Martin is trading NIFTY as usual.
let sensexIndexToken: number | null = null;
let latestSensexChainData: any = null;
let latestSensexAnalytics: any = null;
let latestSensexChainAt = 0;
let sensexActiveUntil = 0;
let lastNiftyChainTokens: number[] = [256265];
let lastSensexChainTokens: number[] = [];

// One place computes the full ticker subscription set. setSubscriptions REPLACES
// the set on the Kite ticker, so every caller must go through this union or it
// would silently unsubscribe someone else's tokens.
function pushTickerSubscriptions() {
  const all = new Set<number>(lastNiftyChainTokens);
  if (sensexIndexToken) all.add(sensexIndexToken);
  for (const t of lastSensexChainTokens) all.add(t);
  for (const t of premiumRuleTokens()) all.add(t);
  setSubscriptions(Array.from(all));
}

async function refreshData() {
  try {
    latestChainData = await getLiveOptionChain('NSE:NIFTY 50');
    if (latestChainData) {
      const tokens: number[] = [256265];
      for (const k of (latestChainData.strikes || [])) {
        if (latestChainData.ceData?.[k]?.instrument_token) tokens.push(latestChainData.ceData[k].instrument_token);
        if (latestChainData.peData?.[k]?.instrument_token) tokens.push(latestChainData.peData[k].instrument_token);
      }
      // Also subscribe the front-month NIFTY future so the delta tracker gets its
      // ticks (the index itself has no volume). Best-effort; ignore failures.
      try {
        const futs = await getIndexFuturesTokens('NIFTY');
        if (futs && futs.length) {
          const front = [...futs].sort((a, b) => a.expiry.localeCompare(b.expiry))[0];
          if (front?.token) { setDeltaFuturesToken(front.token); tokens.push(front.token); }
        }
      } catch (e) { /* delta is optional; don't break the feed */ }
      lastNiftyChainTokens = tokens;

      // SENSEX side: resolve the index token once (24h-cached downstream), and
      // refresh the SENSEX chain only inside the activity window. Best-effort —
      // a SENSEX failure must never break the NIFTY feed.
      try {
        if (!sensexIndexToken) sensexIndexToken = await getBseIndexToken('SENSEX');
        if (Date.now() < sensexActiveUntil) {
          const sx = await getLiveOptionChain('BSE:SENSEX');
          if (sx && !sx.isMock) {
            latestSensexChainData = sx;
            latestSensexAnalytics = computeAnalytics(sx);
            latestSensexChainAt = Date.now();
            const stok: number[] = [];
            for (const k of (sx.strikes || [])) {
              if (sx.ceData?.[k]?.instrument_token) stok.push(sx.ceData[k].instrument_token);
              if (sx.peData?.[k]?.instrument_token) stok.push(sx.peData[k].instrument_token);
            }
            lastSensexChainTokens = stok;
          }
        } else if (lastSensexChainTokens.length) {
          lastSensexChainTokens = []; // idle: drop SENSEX option tokens from the ticker
        }
      } catch (e) { /* SENSEX is optional; NIFTY feed continues */ }

      pushTickerSubscriptions();

      if (latestChainData.isMock) {
        // Random walk for mock data so candlesticks aren't flat
        latestSpot = latestSpot + (Math.random() * 6 - 3);
        latestChainData.spot = latestSpot;
      } else {
        latestSpot = latestChainData.spot;
      }
      latestAnalytics = computeAnalytics(latestChainData);
    }
  } catch (e) {
    console.error("Error refreshing data:", e);
  }
}

  // Broadcast function
  const broadcast = (data: any) => {
    wss.clients.forEach((client) => {
      if (client.readyState === 1) { // OPEN
        client.send(JSON.stringify(data));
      }
    });
  };

function connectTicker() {
  const apiKey = process.env.KITE_API_KEY;
  const token = getTodayAccessToken();
  if (!apiKey || !token) return;
  startTicker(apiKey, token, (tick) => {
    if (tick.token === 256265) {
      latestSpot = tick.ltp;
      lastRealSpotTickAt = Date.now();
      const ts = Math.floor(Date.now() / 1000);
      broadcast({ type: 'tick', symbol: 'NSE:NIFTY 50', price: tick.ltp, timestamp: ts,
        candle: { time: ts, open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp } });
    } else if (sensexIndexToken && tick.token === sensexIndexToken) {
      // SENSEX index tick → same live-candle shape the chart consumes for NIFTY.
      // Deliberately does NOT touch latestSpot/lastRealSpotTickAt — those are the
      // NIFTY numbers every existing watcher and scorecard runs on.
      const ts = Math.floor(Date.now() / 1000);
      broadcast({ type: 'tick', symbol: 'BSE:SENSEX', price: tick.ltp, timestamp: ts,
        candle: { time: ts, open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp } });
    } else if (tick.token === getDeltaFuturesToken()) {
      // Front-month future: update the delta (pressure) proxy. Also broadcast the
      // option tick shape is irrelevant here; the future isn't shown as an option.
      onFuturesTick({ token: tick.token, ltp: tick.ltp, volume: tick.volume, ts: Date.now() });
    } else {
      // PRIMARY premium-exit path: evaluate the armed rule (if any) on the very
      // tick that crossed the level — this is the expiry-day seatbelt. The 3s
      // REST poll below stays alive as the fallback net; the atomic claim inside
      // firePremiumExit makes the two paths race-safe.
      const rule = premiumRulesByToken.get(tick.token);
      if (rule && typeof tick.ltp === 'number' && tick.ltp > 0) {
        const hit = evalPremiumRule(rule, tick.ltp);
        persistRuleLtpThrottled(rule.tradingsymbol, tick.ltp);
        if (hit) {
          const reason = `PREMIUM ${hit} @ ${tick.ltp} (tick)`;
          void firePremiumExit(rule.tradingsymbol, reason).catch((e) =>
            console.error('[premium-exit] tick fire failed', e?.message || e));
        }
      }
      broadcast({ type: 'optionTick', token: tick.token, ltp: tick.ltp, oi: tick.oi, volume: tick.volume });
    }
  });
}

refreshData();
connectTicker();

// One-time best-effort: rules armed before this deploy have no instrument_token
// yet — resolve them so the tick engine covers them too (poll covers them either
// way). Runs once at boot; needs a live Kite session, silently skips without one.
(async () => {
  try {
    const rows: any[] = db.prepare("SELECT * FROM premium_exit_rules WHERE status='ACTIVE' AND instrument_token IS NULL").all() as any[];
    for (const r of rows) {
      const tok = await getOptionToken(r.exchange || 'NFO', r.tradingsymbol);
      if (tok) {
        db.prepare("UPDATE premium_exit_rules SET instrument_token=?, updated_at=? WHERE tradingsymbol=?").run(tok, Date.now(), r.tradingsymbol);
        const fresh: any = db.prepare("SELECT * FROM premium_exit_rules WHERE tradingsymbol=?").get(r.tradingsymbol);
        syncPremiumRuleInMemory(fresh);
      }
    }
    if (rows.length) pushTickerSubscriptions();
  } catch (e) { /* backfill is optional */ }
})();

// Broadcast the futures delta (pressure) snapshot to all clients every 2s.
setInterval(() => {
  try {
    const snap = getDeltaSnapshot();
    if (snap.token) broadcast({ type: 'delta', ...snap });
  } catch (e) { /* ignore */ }
}, 2000);

  // ===== Auto-Exit Watcher: server-side stoploss/target on spot levels + RSI =====
  const lastClosedCandleByTf: Record<string, number> = {};

  async function triggerRuleExit(rule: any, reason: string) {
    // Atomic claim prevents double-firing across overlapping loops
    const claim = db.prepare("UPDATE exit_rules SET status='TRIGGERING', detail=? WHERE id=? AND status='ACTIVE'").run(reason, rule.id);
    if (claim.changes === 0) return;
    const result = await closePositionBySymbol(rule.tradingsymbol, `AUTO: ${reason}`);
    if (result.ok) {
      db.prepare("UPDATE exit_rules SET status='TRIGGERED', detail=? WHERE id=?").run(`${reason} | exit order ${result.orderId}`, rule.id);
      console.log(`[ExitWatcher] EXITED ${rule.tradingsymbol}: ${reason} (order ${result.orderId})`);
    } else if (result.alreadyClosed) {
      db.prepare("UPDATE exit_rules SET status='CANCELLED', detail=? WHERE id=?").run(`${reason} | position already closed, rule auto-cancelled`, rule.id);
      console.log(`[ExitWatcher] Rule auto-cancelled (already closed): ${rule.tradingsymbol}`);
    } else {
      db.prepare("UPDATE exit_rules SET status='ERROR', detail=? WHERE id=?").run(`${reason} | FAILED: ${result.error}`, rule.id);
      console.error(`[ExitWatcher] EXIT FAILED ${rule.tradingsymbol}: ${result.error}`);
    }
  }

  // Fast loop (2s): live TOUCH triggers — stop, target activation, and trailing-stop exits whose mode is TOUCH
  setInterval(async () => {
    try {
      if (!isNSEMarketOpen()) return; // only act during live market hours
      if (!latestSpot || latestSpot <= 0) return;
      if (Date.now() - lastRealSpotTickAt > 30000) return; // require a fresh real tick (no stale/sim spot)
      const rules = db.prepare("SELECT * FROM exit_rules WHERE status='ACTIVE'").all() as any[];
      for (const r of rules) {
        let hit = '';
        const dir = r.trail_dir as ('LONG' | 'SHORT' | null);
        const stopMode = r.stop_mode || r.spot_mode || 'CLOSE';
        const targetMode = r.target_mode || r.spot_mode || 'CLOSE';
        if (!dir) {
          // Legacy rule (no direction): both lines are hard touch stops when spot_mode = TOUCH
          if ((r.spot_mode || 'CLOSE') === 'TOUCH') {
            if (r.spot_lower && latestSpot <= r.spot_lower) hit = `Spot ${latestSpot.toFixed(2)} hit lower ${r.spot_lower}`;
            else if (r.spot_upper && latestSpot >= r.spot_upper) hit = `Spot ${latestSpot.toFixed(2)} hit upper ${r.spot_upper}`;
          }
          if (hit) await triggerRuleExit(r, hit);
          continue;
        }
        const stopLevel = dir === 'LONG' ? r.spot_lower : r.spot_upper;
        if (!r.trail_active) {
          if (stopMode === 'TOUCH' && stopLevel) {
            if (dir === 'LONG' && latestSpot <= stopLevel) hit = `Spot ${latestSpot.toFixed(2)} touched stop ${stopLevel}`;
            if (dir === 'SHORT' && latestSpot >= stopLevel) hit = `Spot ${latestSpot.toFixed(2)} touched stop ${stopLevel}`;
          }
          if (!hit && r.target_price && targetMode === 'TOUCH') {
            const reached = (dir === 'LONG' && latestSpot >= r.target_price) || (dir === 'SHORT' && latestSpot <= r.target_price);
            if (reached) {
              if (r.trail_enabled) {
                db.prepare("UPDATE exit_rules SET trail_active=1 WHERE id=? AND trail_active=0").run(r.id);
                r.trail_active = 1; // trail level gets set on the next candle close
                console.log(`[ExitWatcher] Target touched ${r.target_price} for ${r.tradingsymbol} — trailing armed`);
              } else {
                hit = `Target ${r.target_price} touched`;
              }
            }
          }
        } else if (stopMode === 'TOUCH' && r.trail_stop) {
          if (dir === 'LONG' && latestSpot <= r.trail_stop) hit = `Spot ${latestSpot.toFixed(2)} touched trailing stop ${r.trail_stop}`;
          if (dir === 'SHORT' && latestSpot >= r.trail_stop) hit = `Spot ${latestSpot.toFixed(2)} touched trailing stop ${r.trail_stop}`;
        }
        if (hit) await triggerRuleExit(r, hit);
      }
    } catch (e) { /* keep watcher alive */ }
  }, 2000);

  // Slow loop (15s): candle-close triggers — close-mode stop/target, trailing init+ratchet+exit, and RSI
  setInterval(async () => {
    try {
      if (!isNSEMarketOpen()) return; // only act during live market hours
      const rules = db.prepare("SELECT * FROM exit_rules WHERE status='ACTIVE'").all() as any[];
      if (!rules.length) return;
      const timeframes = Array.from(new Set(rules.map(r => String(r.timeframe || '5'))));
      for (const tf of timeframes) {
        let ta: any;
        try { ta = await getTechnicalAnalysis(latestSpot, parseInt(tf, 10) || 5, '256265', 'NIFTY 50'); } catch { continue; }
        const candles = ta?.candles;
        if (!candles || candles.length < 2) continue;
        const closed = candles[candles.length - 2]; // last fully-closed candle
        const closedTime = new Date(closed.time).getTime();
        if (lastClosedCandleByTf[tf] === closedTime) continue; // already evaluated this candle
        lastClosedCandleByTf[tf] = closedTime;
        const closePrice = closed.close;
        const closeRsi = closed.rsi14;
        for (const r of rules.filter(rr => String(rr.timeframe || '5') === tf)) {
          let hit = '';
          const dir = r.trail_dir as ('LONG' | 'SHORT' | null);
          const stopMode = r.stop_mode || r.spot_mode || 'CLOSE';
          const targetMode = r.target_mode || r.spot_mode || 'CLOSE';
          const N = r.trail_candles || 3;
          const win = candles.slice(Math.max(0, candles.length - 1 - N), candles.length - 1); // last N closed candles
          const lows = win.map((c: any) => c.low).filter((x: any) => typeof x === 'number');
          const highs = win.map((c: any) => c.high).filter((x: any) => typeof x === 'number');
          const lowestLow = lows.length ? Math.min(...lows) : null;
          const highestHigh = highs.length ? Math.max(...highs) : null;

          if (!dir) {
            // Legacy rule: both lines are hard close stops when spot_mode = CLOSE
            if ((r.spot_mode || 'CLOSE') === 'CLOSE') {
              if (r.spot_lower && closePrice <= r.spot_lower) hit = `Candle closed ${closePrice} below lower ${r.spot_lower}`;
              else if (r.spot_upper && closePrice >= r.spot_upper) hit = `Candle closed ${closePrice} above upper ${r.spot_upper}`;
            }
          } else {
            const stopLevel = dir === 'LONG' ? r.spot_lower : r.spot_upper;
            if (!r.trail_active) {
              if (stopMode === 'CLOSE' && stopLevel) {
                if (dir === 'LONG' && closePrice <= stopLevel) hit = `Candle closed ${closePrice} below stop ${stopLevel}`;
                if (dir === 'SHORT' && closePrice >= stopLevel) hit = `Candle closed ${closePrice} above stop ${stopLevel}`;
              }
              if (!hit && r.target_price && targetMode === 'CLOSE') {
                const reached = (dir === 'LONG' && closePrice >= r.target_price) || (dir === 'SHORT' && closePrice <= r.target_price);
                if (reached) {
                  if (r.trail_enabled) {
                    const initStop = dir === 'LONG' ? lowestLow : highestHigh;
                    db.prepare("UPDATE exit_rules SET trail_active=1, trail_stop=? WHERE id=?").run(initStop, r.id);
                    r.trail_active = 1; r.trail_stop = initStop;
                    console.log(`[ExitWatcher] Target closed ${r.target_price} for ${r.tradingsymbol} — trailing activated, trail=${initStop}`);
                  } else {
                    hit = `Target ${r.target_price} reached on close`;
                  }
                }
              }
            }
            if (!hit && r.trail_active) {
              // initialise the trail level if it was armed via a TOUCH target in the fast loop
              if (r.trail_stop === null || r.trail_stop === undefined) {
                const initStop = dir === 'LONG' ? lowestLow : highestHigh;
                if (initStop !== null) { db.prepare("UPDATE exit_rules SET trail_stop=? WHERE id=?").run(initStop, r.id); r.trail_stop = initStop; }
              }
              if (r.trail_stop !== null && r.trail_stop !== undefined) {
                let newStop = r.trail_stop;
                if (dir === 'LONG' && lowestLow !== null) newStop = Math.max(r.trail_stop, lowestLow);
                if (dir === 'SHORT' && highestHigh !== null) newStop = Math.min(r.trail_stop, highestHigh);
                if (newStop !== r.trail_stop) { db.prepare("UPDATE exit_rules SET trail_stop=? WHERE id=?").run(newStop, r.id); r.trail_stop = newStop; }
                if (stopMode === 'CLOSE') {
                  if (dir === 'LONG' && closePrice < r.trail_stop) hit = `Trailing stop: closed ${closePrice} below ${N}-candle trail ${r.trail_stop}`;
                  if (dir === 'SHORT' && closePrice > r.trail_stop) hit = `Trailing stop: closed ${closePrice} above ${N}-candle trail ${r.trail_stop}`;
                }
              }
            }
          }

          // Structure stop (opt-in): auto-exit when the candle CLOSES beyond a
          // dynamic reference — session VWAP, or today's opening-range low/high.
          // LONG exits below the ref; SHORT exits above it.
          if (!hit && r.structure_stop && dir) {
            let ref: number | null = null;
            let label = '';
            if (r.structure_stop === 'VWAP') {
              ref = (typeof ta.vwap === 'number' ? ta.vwap : null);
              label = 'VWAP';
            } else if (r.structure_stop === 'OR' && ta.openingRange) {
              ref = dir === 'LONG' ? ta.openingRange.low : ta.openingRange.high;
              label = dir === 'LONG' ? 'opening-range low' : 'opening-range high';
            }
            if (typeof ref === 'number' && ref > 0) {
              if (dir === 'LONG' && closePrice < ref) hit = `Closed ${closePrice} below ${label} ${ref.toFixed(1)}`;
              if (dir === 'SHORT' && closePrice > ref) hit = `Closed ${closePrice} above ${label} ${ref.toFixed(1)}`;
            }
          }

          if (!hit && typeof closeRsi === 'number') {
            if (r.rsi_lower && closeRsi <= r.rsi_lower) hit = `RSI ${closeRsi.toFixed(1)} reached ${r.rsi_lower} on close`;
            else if (r.rsi_upper && closeRsi >= r.rsi_upper) hit = `RSI ${closeRsi.toFixed(1)} reached ${r.rsi_upper} on close`;
          }
          if (hit) await triggerRuleExit(r, hit);
        }
      }
    } catch (e) { /* keep watcher alive */ }
  }, 15000);

  // Schedule updates every 30 seconds
  cron.schedule('*/10 * * * * *', async () => {
    await refreshData();
    const now = new Date();
    broadcast({ 
      type: 'heartbeat', 
      timestamp: now.toISOString(),
      data: {
        spot: latestSpot,
        analytics: latestAnalytics
      }
    });
  });

  // ===== Auto-Exit Rules API =====
  // Live position data straight from Kite — real avg fill price, real LTP, Zerodha's own P&L
  app.get('/api/positions-live', async (_req, res) => {
    try {
      const kc = getKiteClient();
      // @ts-ignore
      if (!kc || !kc.access_token) return res.json({ success: false, error: 'No active Kite session' });
      const positions = await kc.getPositions();
      const net = (positions && positions.net) || [];
      const open = net.filter((p: any) => p.quantity !== 0);
      // getPositions() last_price is often stale / previous close — pull a LIVE quote per symbol instead
      const instruments = open.map((p: any) => `${p.exchange}:${p.tradingsymbol}`);
      let quotes: any = {};
      if (instruments.length > 0) {
        try { quotes = await kc.getQuote(instruments); } catch (e) { quotes = {}; }
      }
      let openUnrealised = 0;
      const out = open.map((p: any) => {
        const key = `${p.exchange}:${p.tradingsymbol}`;
        const q = quotes[key];
        const ltp = (q && q.last_price > 0) ? q.last_price : (p.last_price || p.average_price);
        // quantity is signed by Kite (+ for long, − for short), so this works for both
        const pnl = (ltp - p.average_price) * p.quantity;
        openUnrealised += pnl;
        return {
          tradingsymbol: p.tradingsymbol,
          quantity: p.quantity,
          product: p.product,
          average_price: p.average_price,
          last_price: ltp,
          pnl: Math.round(pnl * 100) / 100,
        };
      });
      // Net day P&L: everything booked so far today (incl. already-closed trades) + live unrealised on open legs
      const realisedTotal = net.reduce((s: number, p: any) => s + (p.realised || 0), 0);
      const netPnl = Math.round((realisedTotal + openUnrealised) * 100) / 100;
      return res.json({
        success: true,
        positions: out,
        netPnl,
        realisedPnl: Math.round(realisedTotal * 100) / 100,
        openPnl: Math.round(openUnrealised * 100) / 100,
      });
    } catch (e: any) {
      return res.json({ success: false, error: e?.message || String(e) });
    }
  });

  // --- Synced settings (shared across all of the user's devices) ---
  // GET  /api/settings/:key  -> { value }  (value is null when unset)
  // PUT  /api/settings/:key  body { value } -> { ok }
  app.get('/api/settings/:key', (req, res) => {
    try {
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(req.params.key) as any;
      if (!row) return res.json({ value: null });
      let value: any = null;
      try { value = JSON.parse(row.value); } catch { value = row.value; }
      return res.json({ value });
    } catch (e: any) {
      return res.status(500).json({ value: null, error: e?.message || 'settings read failed' });
    }
  });

  app.put('/api/settings/:key', express.json({ limit: '256kb' }), (req, res) => {
    try {
      const value = (req.body && typeof req.body === 'object' && 'value' in req.body) ? req.body.value : req.body;
      const serialized = JSON.stringify(value);
      db.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(req.params.key, serialized, Date.now());
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'settings write failed' });
    }
  });

  // ===== Premium-based auto-exit (draggable SL/TP lines on the option chart) =====
  // set: validates the position live on Zerodha, then arms/updates the rule.
  app.post('/api/premium-exit/set', express.json(), async (req, res) => {
    try {
      const { tradingsymbol, sl, tp, entry } = req.body || {};
      const slN = Number(sl), tpN = Number(tp);
      if (!tradingsymbol || !isFinite(slN) || !isFinite(tpN) || slN <= 0 || tpN <= 0) {
        return res.status(400).json({ success: false, error: 'Missing tradingsymbol / sl / tp' });
      }
      const kc = getKiteClient();
      // @ts-ignore
      if (!kc || !kc.access_token) return res.json({ success: false, error: 'No active Kite session — please log in to Zerodha today.' });
      let positions: any;
      try { positions = await kc.getPositions(); } catch (e: any) { return res.json({ success: false, error: 'Could not read positions: ' + (e?.message || e) }); }
      const pos = ((positions && positions.net) || []).find((p: any) => p.tradingsymbol === tradingsymbol && p.quantity !== 0);
      if (!pos) return res.json({ success: false, error: `No open position for ${tradingsymbol} on Zerodha.` });
      // SAFETY GUARD: the auto-exit engine has only ever been live-verified on
      // NSE (NFO) orders. Refuse to arm on BSE/BFO positions rather than guard
      // real money with an untested net. Removed only after the SENSEX stage-2
      // one-lot test-trade ritual passes.
      if ((pos.exchange || 'NFO') !== 'NFO') {
        return res.json({ success: false, error: `${pos.exchange} auto SL/TP is not verified yet — manage this position's exit in the Kite app for now.` });
      }
      const side = pos.quantity > 0 ? 'BUY' : 'SELL';
      const long = side === 'BUY';
      // Orientation sanity: a long option exits DOWN at SL and UP at target.
      if (long ? !(slN < tpN) : !(slN > tpN)) {
        return res.json({ success: false, error: long ? 'For a long option, SL must be below TARGET.' : 'For a short option, SL must be above TARGET.' });
      }
      const entryPx = Number(entry) > 0 ? Number(entry) : (pos.average_price || 0);
      // Resolve the contract's instrument token so the ticker can stream it (the
      // tick engine's primary path). null is fine — the 3s poll covers the rule.
      let ruleToken: number | null = null;
      try { ruleToken = await getOptionToken(pos.exchange || 'NFO', tradingsymbol); } catch (e) { ruleToken = null; }
      db.prepare(`INSERT INTO premium_exit_rules (tradingsymbol, exchange, side, qty, entry, sl, tp, status, attempts, last_ltp, detail, instrument_token, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, NULL, '', ?, ?, ?)
        ON CONFLICT(tradingsymbol) DO UPDATE SET exchange=excluded.exchange, side=excluded.side, qty=excluded.qty,
          entry=excluded.entry, sl=excluded.sl, tp=excluded.tp, status='ACTIVE', attempts=0, detail='',
          instrument_token=excluded.instrument_token, updated_at=excluded.updated_at`)
        .run(tradingsymbol, pos.exchange || 'NFO', side, Math.abs(pos.quantity), entryPx, slN, tpN, ruleToken, Date.now(), Date.now());
      const armedRow: any = db.prepare("SELECT * FROM premium_exit_rules WHERE tradingsymbol=?").get(tradingsymbol);
      syncPremiumRuleInMemory(armedRow);
      pushTickerSubscriptions(); // stream the armed contract right away (don't wait for the 10s refresh)
      console.log(`[premium-exit] ARMED ${tradingsymbol} side=${side} entry=${entryPx} sl=${slN} tp=${tpN} token=${ruleToken ?? 'unresolved (poll only)'}`);
      return res.json({ success: true, rule: { tradingsymbol, side, entry: entryPx, sl: slN, tp: tpN, status: 'ACTIVE' } });
    } catch (e: any) {
      console.error('[premium-exit set]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  app.get('/api/premium-exit/get', (req, res) => {
    try {
      const sym = String(req.query.tradingsymbol || '');
      if (!sym) return res.json({ rule: null });
      const row: any = db.prepare("SELECT * FROM premium_exit_rules WHERE tradingsymbol=?").get(sym);
      return res.json({ rule: row && row.status === 'ACTIVE' ? row : null });
    } catch (e: any) { return res.status(500).json({ rule: null, error: e?.message || String(e) }); }
  });

  app.post('/api/premium-exit/clear', express.json(), (req, res) => {
    try {
      const { tradingsymbol } = req.body || {};
      if (!tradingsymbol) return res.status(400).json({ success: false, error: 'Missing tradingsymbol' });
      const prevRow: any = db.prepare("SELECT instrument_token FROM premium_exit_rules WHERE tradingsymbol=?").get(tradingsymbol);
      db.prepare("UPDATE premium_exit_rules SET status='CANCELLED', updated_at=? WHERE tradingsymbol=? AND status='ACTIVE'").run(Date.now(), tradingsymbol);
      syncPremiumRuleInMemory(null, prevRow?.instrument_token ? Number(prevRow.instrument_token) : null);
      return res.json({ success: true });
    } catch (e: any) { return res.status(500).json({ success: false, error: e?.message || String(e) }); }
  });

  // FALLBACK watcher: every 3s, batch-fetch LTP over REST for all ACTIVE rules.
  // The tick path above is the primary trigger (reacts within the tick that
  // crossed the level — the expiry-day seatbelt); this poll is the net under it
  // for rules with no resolved token, WS disconnects, or missed ticks. Both
  // paths funnel into firePremiumExit, whose atomic ACTIVE→TRIGGERED claim
  // guarantees at most one exit order no matter who sees the cross first.
  setInterval(async () => {
    try {
      const rules: any[] = db.prepare("SELECT * FROM premium_exit_rules WHERE status='ACTIVE'").all() as any[];
      if (!rules.length) return;
      const kc = getKiteClient();
      // @ts-ignore
      if (!kc || !kc.access_token) return;
      const keys = rules.map(r => `${r.exchange || 'NFO'}:${r.tradingsymbol}`);
      let ltpMap: any = {};
      try { ltpMap = await kc.getLTP(keys); } catch { return; }
      for (const r of rules) {
        const k = `${r.exchange || 'NFO'}:${r.tradingsymbol}`;
        const ltp = ltpMap && ltpMap[k] && ltpMap[k].last_price;
        if (typeof ltp !== 'number' || ltp <= 0) continue;
        try { db.prepare("UPDATE premium_exit_rules SET last_ltp=?, updated_at=? WHERE tradingsymbol=?").run(ltp, Date.now(), r.tradingsymbol); } catch (e) {}
        const hit = evalPremiumRule(r, ltp);
        if (!hit) continue;
        const reason = `PREMIUM ${hit} @ ${ltp} (poll)`;
        await firePremiumExit(r.tradingsymbol, reason);
      }
    } catch (e) { /* the watcher must never crash the server */ }
  }, 3000);

  app.post('/api/exit-position', express.json(), async (req, res) => {
    try {
      const { tradingsymbol, reason } = req.body || {};
      if (!tradingsymbol) return res.status(400).json({ success: false, error: 'Missing tradingsymbol' });
      const result = await closePositionBySymbol(tradingsymbol, reason || 'MANUAL');
      // A manual exit disarms any premium SL/TP rule for the symbol.
      if (result.ok || result.alreadyClosed) {
        try {
          const prevRow: any = db.prepare("SELECT instrument_token FROM premium_exit_rules WHERE tradingsymbol=?").get(tradingsymbol);
          db.prepare("UPDATE premium_exit_rules SET status='CANCELLED', updated_at=? WHERE tradingsymbol=? AND status='ACTIVE'").run(Date.now(), tradingsymbol);
          syncPremiumRuleInMemory(null, prevRow?.instrument_token ? Number(prevRow.instrument_token) : null);
        } catch (e) {}
      }
      if (result.ok) return res.json({ success: true, orderId: result.orderId });
      return res.json({ success: false, error: result.error, alreadyClosed: !!result.alreadyClosed });
    } catch (e: any) {
      console.error('[exit-position]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  app.post('/api/exit-rules', express.json(), (req, res) => {
    try {
      const { tradingsymbol, exchange, qty, product, positionSide, spotLower, spotUpper, spotMode, rsiLower, rsiUpper, timeframe } = req.body;
      if (!tradingsymbol || !qty) return res.status(400).json({ success: false, error: 'Missing tradingsymbol or qty' });
      const { trailEnabled, trailCandles, targetPrice, trailDir, stopMode, targetMode, structureStop } = req.body || {};
      const exitSide = String(positionSide).toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
      const sMode = (stopMode === 'TOUCH' ? 'TOUCH' : 'CLOSE');
      const tMode = (targetMode === 'TOUCH' ? 'TOUCH' : 'CLOSE');
      const structStop = (structureStop === 'VWAP' || structureStop === 'OR') ? structureStop : null;
      db.prepare("UPDATE exit_rules SET status='CANCELLED' WHERE tradingsymbol=? AND status='ACTIVE'").run(tradingsymbol);
      const info = db.prepare(`INSERT INTO exit_rules
        (tradingsymbol, exchange, qty, product, exit_side, spot_lower, spot_upper, spot_mode, rsi_lower, rsi_upper, timeframe, underlying_token, status, detail, created_at, trail_enabled, trail_candles, target_price, trail_dir, trail_active, trail_stop, stop_mode, target_mode, structure_stop)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', '', ?, ?,?,?,?, 0, NULL, ?, ?, ?)`).run(
          tradingsymbol, exchange || 'NFO', parseInt(qty, 10), product || 'MIS', exitSide,
          spotLower || null, spotUpper || null, sMode,
          rsiLower || null, rsiUpper || null, String(timeframe || '5'), '256265', Math.floor(Date.now() / 1000),
          trailEnabled ? 1 : 0, parseInt(trailCandles, 10) || 3, targetPrice || null, (trailDir === 'SHORT' ? 'SHORT' : (trailDir === 'LONG' ? 'LONG' : null)),
          sMode, tMode, structStop
        );
      const kc = getKiteClient();
      // @ts-ignore
      const armed = !!(kc && kc.access_token);
      return res.json({ success: true, id: Number(info.lastInsertRowid), armed });
    } catch (e: any) {
      console.error('[exit-rules POST]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ===== Trade Journal endpoints (Phase 1) =====
  // List journaled trades (most recent first). Optional ?status=OPEN|CLOSED and ?limit=N.
  app.get('/api/journal', (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : null;
      const limit = Math.min(parseInt(String(req.query.limit || '500'), 10) || 500, 2000);
      const rows = (status === 'OPEN' || status === 'CLOSED')
        ? db.prepare(`SELECT * FROM trade_journal WHERE status = ? ORDER BY entry_time DESC LIMIT ?`).all(status, limit)
        : db.prepare(`SELECT * FROM trade_journal ORDER BY entry_time DESC LIMIT ?`).all(limit);
      const trades = (rows as any[]).map((r) => ({ ...r, context: r.context ? JSON.parse(r.context) : null }));
      return res.json({ success: true, trades });
    } catch (e: any) {
      console.error('[journal GET]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // Client-driven close (e.g. "Exit All", which closes via opposite orders rather than the
  // server-side close path). Safe to call repeatedly — only the latest OPEN row is updated.
  app.post('/api/journal/close', express.json(), (req, res) => {
    try {
      const { tradingsymbol, exitPrice, pnl, reason } = req.body || {};
      if (!tradingsymbol) return res.status(400).json({ success: false, error: 'Missing tradingsymbol' });
      journalCloseTrade(tradingsymbol, { exitPrice, pnl, reason: reason || 'MANUAL' });
      return res.json({ success: true });
    } catch (e: any) {
      console.error('[journal close]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  app.delete('/api/journal/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'Bad id' });
      db.prepare(`DELETE FROM trade_journal WHERE id = ?`).run(id);
      return res.json({ success: true });
    } catch (e: any) {
      console.error('[journal DELETE]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  app.get('/api/exit-rules', (_req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM exit_rules WHERE status IN ('ACTIVE','TRIGGERING','TRIGGERED','ERROR') ORDER BY id DESC LIMIT 50").all();
      const kc = getKiteClient();
      // @ts-ignore
      const armed = !!(kc && kc.access_token);
      return res.json({ success: true, rules: rows, armed });
    } catch (e: any) {
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  app.delete('/api/exit-rules/:id', (req, res) => {
    try {
      db.prepare("UPDATE exit_rules SET status='CANCELLED' WHERE id=? AND status='ACTIVE'").run(req.params.id);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // Keep the chart combinations a user actually switches between WARM. Cold, a
  // single switch costs three sequential Kite fetches (candles + two futures
  // pulls for volume) over the slow link to Bangalore — that is the 5-6 second
  // wait. Warm, the same request is served from the 60s cache in milliseconds.
  // Runs only during market hours; failures are silent because this is a comfort
  // feature and must never disturb anything that matters.
  let sensexPrewarmToken: string | null = null;
  setInterval(async () => {
    try {
      const x = new Date(Date.now() + 5.5 * 3600 * 1000);
      const day = x.getUTCDay(), min = x.getUTCHours() * 60 + x.getUTCMinutes();
      if (day === 0 || day === 6) return;
      if (min < 550 || min > 935) return;           // ~09:10 to ~15:35 IST
      const kc: any = getKiteClient();
      if (!kc || !kc.access_token) return;

      const combos: Array<{ tf: number; token: string; symbol: string }> = [
        { tf: 1, token: '256265', symbol: 'NIFTY 50' },
        { tf: 3, token: '256265', symbol: 'NIFTY 50' },
        { tf: 5, token: '256265', symbol: 'NIFTY 50' },
        { tf: 15, token: '256265', symbol: 'NIFTY 50' },
        { tf: 5, token: '260105', symbol: 'NIFTY BANK' },
        { tf: 15, token: '260105', symbol: 'NIFTY BANK' },
      ];
      if (!sensexPrewarmToken) {
        try { const t = await getBseIndexToken('SENSEX'); if (t) sensexPrewarmToken = String(t); } catch (e) {}
      }
      if (sensexPrewarmToken) {
        combos.push({ tf: 5, token: sensexPrewarmToken, symbol: 'BSE:SENSEX' });
        combos.push({ tf: 15, token: sensexPrewarmToken, symbol: 'BSE:SENSEX' });
      }
      // Sequential on purpose: firing six Kite calls at once through one proxy is
      // exactly the traffic spike that made the outages worse.
      for (const c of combos) {
        try { await getTechnicalAnalysis(latestSpot, c.tf, c.token, c.symbol); } catch (e) {}
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (e) { /* comfort feature — never let it surface */ }
  }, 45000);

  app.get('/api/ta', async (req, res) => {
    const timeframe = req.query.timeframe ? parseInt(req.query.timeframe as string) : 5;
    const token = req.query.token as string || "256265";
    const symbol = req.query.symbol as string || "NIFTY 50";
    try {
      const data = await getTechnicalAnalysis(latestSpot, timeframe, token, symbol);
      res.json(data);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to fetch TA" });
    }
  });

  // Example API routes
  // Why are the newest candles missing? One tap, small answer — see taFreshness.
  app.get('/api/ta/freshness', async (req, res) => {
    try {
      const tf = parseInt(String(req.query.timeframe || '5'), 10) || 5;
      const token = String(req.query.token || '256265');
      res.json(await taFreshness(tf, token));
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get('/api/healthz', (req, res) => {
    res.json({ status: "ok" });
  });

  app.get('/api/server-ip', async (req, res) => {
    try {
      const ipRes = await fetch("https://api.ipify.org?format=json");
      const ipObj = await ipRes.json() as any;
      res.json({ ip: ipObj?.ip || "unknown" });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch server IP", details: err.message });
    }
  });

  app.get('/api/diagnostics', (req, res) => {
    res.json({
      requestCountPerMinute: kiteDiagnostics.requestCountPerMinute,
      lastRequestTime: kiteDiagnostics.lastRequestTime,
      cacheHits: kiteDiagnostics.cacheHits,
      cacheMisses: kiteDiagnostics.cacheMisses,
      error429Count: kiteDiagnostics.error429Count,
      endpoints: Object.fromEntries(kiteDiagnostics.endpoints),
    });
  });

  // ---- Proxy health: hardened check + 24/7 monitor with an outage log ----
  // Orders (incl. the auto SL/TP engine) MUST egress via the whitelisted
  // Bangalore proxy, so its health is trading-critical. The old check asked ONE
  // IP-echo service once with a 4s timeout — a hiccup at that service faked a
  // red light. Now: two independent services, tried in turn, and a server-side
  // monitor every 60s that records every RED<->GREEN transition with IST
  // timestamps, so an outage report is data instead of a mystery.
  const proxyBootAt = Date.now();
  const proxyHealth: {
    alive: boolean | null; lastCheck: number; egressIp: string | null; detail: string;
    transitions: Array<{ ts: number; alive: boolean; detail: string }>;
  } = { alive: null, lastCheck: 0, egressIp: null, detail: '', transitions: [] };

  async function checkProxyOnce(): Promise<{ alive: boolean; egressIp: string | null; expectedIp: string | null; detail: string }> {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
    let expectedIp: string | null = null;
    try { expectedIp = new URL(proxyUrl).hostname; } catch (e) {}
    const services = ['https://api.ipify.org', 'https://checkip.amazonaws.com'];
    let lastErr = '';
    for (const url of services) {
      try {
        // 12s, not 5s: the Railway(US) -> Bangalore round trip is ~250ms and
        // congests in bursts. A 5s ceiling reported a merely SLOW proxy as DEAD
        // (the logged ECONNABORTED was our own client aborting, and the proxy's
        // own log showed zero errors during those windows).
        const r = await axios.get(url, { timeout: 12000 });
        const egressIp = String(r.data || '').trim();
        if (egressIp) {
          const alive = !!expectedIp && egressIp === expectedIp;
          return { alive, egressIp, expectedIp, detail: alive ? 'ok' : `egress ${egressIp} ≠ expected ${expectedIp} — traffic is BYPASSING the proxy` };
        }
      } catch (e: any) {
        lastErr = `${url.replace('https://', '')}: ${String((e && (e.code || e.message)) || e)}`;
      }
    }
    return { alive: false, egressIp: null, expectedIp, detail: `proxy unreachable — both IP checks failed (${lastErr})` };
  }

  setInterval(async () => {
    try {
      const r = await checkProxyOnce();
      const prev = proxyHealth.alive;
      proxyHealth.alive = r.alive; proxyHealth.lastCheck = Date.now();
      proxyHealth.egressIp = r.egressIp; proxyHealth.detail = r.detail;
      if (prev === null || prev !== r.alive) {
        proxyHealth.transitions.push({ ts: Date.now(), alive: r.alive, detail: r.detail });
        if (proxyHealth.transitions.length > 100) proxyHealth.transitions.splice(0, proxyHealth.transitions.length - 100);
        console.log(`[proxy-monitor] ${r.alive ? 'GREEN' : 'RED'} — ${r.detail}`);
      }
    } catch (e) { /* the monitor must never crash the server */ }
  }, 60000);

  app.get('/api/diagnostics/proxy', async (_req, res) => {
    const r = await checkProxyOnce();
    res.json({
      ...r,
      monitor: {
        watchingSince: toISTString(proxyBootAt) + ' IST (server start — log resets on restart)',
        lastBackgroundCheck: proxyHealth.lastCheck ? toISTString(proxyHealth.lastCheck) + ' IST' : 'not yet',
        transitions: proxyHealth.transitions.slice(-20).map(t => ({
          at: toISTString(t.ts) + ' IST', became: t.alive ? 'GREEN' : 'RED', detail: t.detail,
        })),
      },
    });
  });

  app.get('/api/instruments/search', async (req, res) => {
    const query = req.query.q as string || '';
    if (query.length < 2) {
      return res.json([]);
    }
    const results = await searchInstruments(query);
    res.json(results);
  });

  app.get('/api/news/live', rateLimitMiddleware, async (req, res) => {
    try {
      const news = await getLiveNews();
      return res.json({ news, aiStatus: currentAIStatus });
    } catch (err: any) {
      console.error("Endpoint error in /api/news/live:", err);
      return res.status(500).json({ error: "Failed to fetch live NIFTY-relevant high-impact news." });
    }
  });

  app.get('/api/analytics', (req, res) => {
    res.json(latestAnalytics);
  });

  app.get('/api/delta', (req, res) => {
    try { res.json({ success: true, ...getDeltaSnapshot() }); }
    catch (e: any) { res.json({ success: false, error: e?.message || String(e) }); }
  });

  // Market-context sidebar: Indian indices (live from Kite) + US index futures
  // (near-real-time from Yahoo's free endpoint, with a graceful "unavailable"
  // fallback if the server can't reach it). Cached ~5s to stay light.
  // Approximate market open/closed check: minutes-of-day windows per weekday
  // (0=Sun..6=Sat) evaluated in the exchange's own timezone. Regular sessions
  // only — exchange holidays are not tracked.
  function marketOpenNow(tz: string, schedule: Record<number, Array<[number, number]>>): boolean {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date());
      const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
      const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const dow = dayMap[get('weekday')] ?? -1;
      const mins = (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
      return (schedule[dow] || []).some(([a, b]) => mins >= a && mins < b);
    } catch { return false; }
  }

  let marketContextCache: { at: number; data: any } | null = null;
  app.get('/api/market-context', async (_req, res) => {
    try {
      if (marketContextCache && Date.now() - marketContextCache.at < 5000) {
        return res.json(marketContextCache.data);
      }
      const indian: any[] = [];
      const us: any[] = [];
      const uk: any[] = [];
      const globalMkts: any[] = [];

      // --- Indian indices via Kite ---
      const kc = getKiteClient();
      // @ts-ignore
      const hasKite = kc && kc.access_token;
      // Symbols verified against the Kite instrument dump (exchange NSE, segment
      // INDICES) rather than guessed. Note NIFTY OIL AND GAS / NIFTY HEALTHCARE
      // do NOT exist there, so they're deliberately not listed.
      // All of these are fetched in ONE batched getQuote call, so extra rows cost
      // no additional broker API calls.
      // Regular-session windows (minutes-of-day, 0=Sun..6=Sat) in each exchange's
      // own timezone. Defined once and reused for both the per-row tags and the
      // section pills so the two can never disagree. Holidays aren't tracked.
      const NSE_SCHED: Record<number, Array<[number, number]>> = {
        1: [[555, 930]], 2: [[555, 930]], 3: [[555, 930]], 4: [[555, 930]], 5: [[555, 930]],
      };
      const LSE_SCHED: Record<number, Array<[number, number]>> = {
        1: [[480, 990]], 2: [[480, 990]], 3: [[480, 990]], 4: [[480, 990]], 5: [[480, 990]],
      };
      // CME Globex: Sun 18:00 -> Fri 17:00 ET with a daily 17:00-18:00 halt
      const CME_GLOBEX: Record<number, Array<[number, number]>> = {
        0: [[1080, 1440]],
        1: [[0, 1020], [1080, 1440]],
        2: [[0, 1020], [1080, 1440]],
        3: [[0, 1020], [1080, 1440]],
        4: [[0, 1020], [1080, 1440]],
        5: [[0, 1020]],
      };
      const indOpenNow = marketOpenNow('Asia/Kolkata', NSE_SCHED);
      const ukOpenNow = marketOpenNow('Europe/London', LSE_SCHED);
      const usOpenNow = marketOpenNow('America/New_York', CME_GLOBEX);

      const IND = [
        // Broad
        { key: 'BANKNIFTY', label: 'Bank Nifty', sym: 'NSE:NIFTY BANK' },
        { key: 'FINNIFTY', label: 'Fin Nifty', sym: 'NSE:NIFTY FIN SERVICE' },
        { key: 'MIDCAP100', label: 'Midcap 100', sym: 'NSE:NIFTY MIDCAP 100' },
        { key: 'SMLCAP100', label: 'Smallcap 100', sym: 'NSE:NIFTY SMLCAP 100' },
        { key: 'MICROCAP250', label: 'Microcap 250', sym: 'NSE:NIFTY MICROCAP250' },
        // Sectors
        { key: 'AUTO', label: 'Auto', sym: 'NSE:NIFTY AUTO' },
        { key: 'COMMODITIES', label: 'Commodities', sym: 'NSE:NIFTY COMMODITIES' },
        { key: 'CONSUMPTION', label: 'Consumption', sym: 'NSE:NIFTY CONSUMPTION' },
        { key: 'ENERGY', label: 'Energy', sym: 'NSE:NIFTY ENERGY' },
        { key: 'FMCG', label: 'FMCG', sym: 'NSE:NIFTY FMCG' },
        { key: 'INFRA', label: 'Infra', sym: 'NSE:NIFTY INFRA' },
        { key: 'IT', label: 'IT', sym: 'NSE:NIFTY IT' },
        { key: 'MEDIA', label: 'Media', sym: 'NSE:NIFTY MEDIA' },
        { key: 'METAL', label: 'Metal', sym: 'NSE:NIFTY METAL' },
        { key: 'PHARMA', label: 'Pharma', sym: 'NSE:NIFTY PHARMA' },
        { key: 'PSUBANK', label: 'PSU Bank', sym: 'NSE:NIFTY PSU BANK' },
        { key: 'PVTBANK', label: 'Private Bank', sym: 'NSE:NIFTY PVT BANK' },
        { key: 'REALTY', label: 'Realty', sym: 'NSE:NIFTY REALTY' },
        // Volatility / BSE
        { key: 'VIX', label: 'India VIX', sym: 'NSE:INDIA VIX' },
        { key: 'SENSEX', label: 'Sensex', sym: 'BSE:SENSEX' },
      ];
      if (hasKite) {
        try {
          const q = await kc.getQuote(IND.map(i => i.sym));
          for (const i of IND) {
            const d = q?.[i.sym];
            if (d && typeof d.last_price === 'number') {
              const prevClose = d.ohlc?.close ?? (d.last_price - (d.net_change || 0));
              const chg = d.net_change ?? (d.last_price - prevClose);
              const chgPct = prevClose ? (chg / prevClose) * 100 : 0;
              indian.push({
                key: i.key, label: i.label, price: d.last_price,
                change: +chg.toFixed(2), changePct: +chgPct.toFixed(2),
                available: true,
              });
            } else {
              indian.push({ key: i.key, label: i.label, available: false });
            }
          }
        } catch (e) {
          for (const i of IND) indian.push({ key: i.key, label: i.label, available: false });
        }
      } else {
        for (const i of IND) indian.push({ key: i.key, label: i.label, available: false, reason: 'no_kite_session' });
      }

      // --- US index futures via Yahoo (free, may be blocked from some IPs) ---
      // Futures trade nearly 24h and are what matters for tomorrow's Indian gap;
      // the CASH indices are frozen at last night's US close. Both are listed so
      // the two can never be mistaken for each other (they legitimately disagree
      // overnight: the index shows yesterday's move, futures show right now).
      const US = [
        { key: 'SPX', label: 'S&P 500 Fut', sym: 'ES=F' },
        { key: 'NDX', label: 'Nasdaq Fut', sym: 'NQ=F' },
        { key: 'DJI', label: 'Dow Fut', sym: 'YM=F' },
        { key: 'DJI_IDX', label: 'Dow Jones (index)', sym: '^DJI' },
      ];
      await Promise.all(US.map(async (u) => {
        try {
          const r = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(u.sym)}?interval=5m&range=1d`,
            { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          const result = r.data?.chart?.result?.[0];
          const meta = result?.meta;
          if (meta && typeof meta.regularMarketPrice === 'number') {
            const prev = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
            const chg = meta.regularMarketPrice - prev;
            const chgPct = prev ? (chg / prev) * 100 : 0;
            // sparkline: intraday closes (compact)
            const closesRaw: any[] = result?.indicators?.quote?.[0]?.close || [];
            const spark = closesRaw.filter((x) => typeof x === 'number');
            const sparkTrim = spark.length > 40 ? spark.filter((_, idx) => idx % Math.ceil(spark.length / 40) === 0) : spark;
            us.push({
              key: u.key, label: u.label, price: +meta.regularMarketPrice.toFixed(2),
              change: +chg.toFixed(2), changePct: +chgPct.toFixed(2),
              spark: sparkTrim.map((v) => +v.toFixed(2)),
              asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
              available: true, open: usOpenNow,
            });
          } else {
            us.push({ key: u.key, label: u.label, available: false, open: usOpenNow });
          }
        } catch (e) {
          us.push({ key: u.key, label: u.label, available: false, open: usOpenNow });
        }
      }));
      // keep US in declared order
      us.sort((a, b) => US.findIndex(x => x.key === a.key) - US.findIndex(x => x.key === b.key));

      // --- UK indices via Yahoo (same free feed as US) ---
      const UK = [
        { key: 'FTSE', label: 'FTSE 100', sym: '^FTSE' },
        { key: 'FTMC', label: 'FTSE 250', sym: '^FTMC' },
      ];
      await Promise.all(UK.map(async (u) => {
        try {
          const r = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(u.sym)}?interval=5m&range=1d`,
            { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          const result = r.data?.chart?.result?.[0];
          const meta = result?.meta;
          if (meta && typeof meta.regularMarketPrice === 'number') {
            const prev = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
            const chg = meta.regularMarketPrice - prev;
            const chgPct = prev ? (chg / prev) * 100 : 0;
            uk.push({
              key: u.key, label: u.label, price: +meta.regularMarketPrice.toFixed(2),
              change: +chg.toFixed(2), changePct: +chgPct.toFixed(2),
              asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
              available: true, open: ukOpenNow,
            });
          } else {
            uk.push({ key: u.key, label: u.label, available: false, open: ukOpenNow });
          }
        } catch (e) {
          uk.push({ key: u.key, label: u.label, available: false, open: ukOpenNow });
        }
      }));
      // keep UK in declared order
      uk.sort((a, b) => UK.findIndex(x => x.key === a.key) - UK.findIndex(x => x.key === b.key));

      // --- Global indices & commodities via Yahoo (same free feed) ---
      // Per-market sessions: these don't share one schedule (HK breaks for lunch,
      // KOSPI differs, metals/energy run nearly 24h on Globex), so each row
      // carries its own open/closed rather than a single section-level pill.
      const GLOBAL: Array<{ key: string; label: string; sym: string; tz: string; sched: Record<number, Array<[number, number]>> }> = [
        // HKEX 09:30-12:00 & 13:00-16:00 HKT, Mon-Fri
        { key: 'HSI', label: 'Hang Seng', sym: '^HSI', tz: 'Asia/Hong_Kong', sched: {
          1: [[570, 720], [780, 960]], 2: [[570, 720], [780, 960]], 3: [[570, 720], [780, 960]],
          4: [[570, 720], [780, 960]], 5: [[570, 720], [780, 960]],
        } },
        // KRX 09:00-15:30 KST, Mon-Fri
        { key: 'KOSPI', label: 'KOSPI', sym: '^KS11', tz: 'Asia/Seoul', sched: {
          1: [[540, 930]], 2: [[540, 930]], 3: [[540, 930]], 4: [[540, 930]], 5: [[540, 930]],
        } },
        { key: 'GOLD', label: 'Gold', sym: 'GC=F', tz: 'America/New_York', sched: CME_GLOBEX },
        { key: 'SILVER', label: 'Silver', sym: 'SI=F', tz: 'America/New_York', sched: CME_GLOBEX },
        { key: 'OIL', label: 'Crude Oil', sym: 'CL=F', tz: 'America/New_York', sched: CME_GLOBEX },
      ];
      await Promise.all(GLOBAL.map(async (g) => {
        // Session status comes from the clock, so it's still honest even if the
        // price feed is unreachable.
        const isOpen = marketOpenNow(g.tz, g.sched);
        try {
          const r = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(g.sym)}?interval=5m&range=1d`,
            { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          const result = r.data?.chart?.result?.[0];
          const meta = result?.meta;
          if (meta && typeof meta.regularMarketPrice === 'number') {
            const prev = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
            const chg = meta.regularMarketPrice - prev;
            const chgPct = prev ? (chg / prev) * 100 : 0;
            globalMkts.push({
              key: g.key, label: g.label, price: +meta.regularMarketPrice.toFixed(2),
              change: +chg.toFixed(2), changePct: +chgPct.toFixed(2),
              asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
              available: true, open: isOpen,
            });
          } else {
            globalMkts.push({ key: g.key, label: g.label, available: false, open: isOpen });
          }
        } catch (e) {
          globalMkts.push({ key: g.key, label: g.label, available: false, open: isOpen });
        }
      }));
      // keep GLOBAL in declared order
      globalMkts.sort((a, b) => GLOBAL.findIndex(x => x.key === a.key) - GLOBAL.findIndex(x => x.key === b.key));

      // Open/closed per market group (regular weekday sessions in each exchange's
      // timezone; holidays not tracked). Minutes-of-day windows, 0=Sun..6=Sat.
      const status = { indian: indOpenNow, uk: ukOpenNow, us: usOpenNow };

      const payload = { success: true, indian, us, uk, global: globalMkts, status, ts: Date.now() };
      marketContextCache = { at: Date.now(), data: payload };
      res.json(payload);
    } catch (e: any) {
      res.json({ success: false, error: e?.message || String(e), indian: [], us: [], uk: [], global: [] });
    }
  });

  app.get('/api/option-chain', async (req, res) => {
    const symbol = req.query.symbol as string || 'NIFTY 50';
    const spotParam = req.query.spot as string;
    const expiryParam = req.query.expiry as string;
    // withAnalytics=1 folds the chain analytics (PCR, max pain, zones…) into the
    // same response — lets the OI Data page serve any underlying with ONE query.
    const withAnalytics = req.query.withAnalytics === '1';
    const isSensex = symbol === 'SENSEX' || symbol === 'BSE:SENSEX';

    // Any SENSEX request keeps the server-side SENSEX loop alive for 2 minutes:
    // refreshData refreshes the SENSEX chain cache every 10s and streams its
    // option tokens while this window is open, then drops them when idle.
    if (isSensex) sensexActiveUntil = Date.now() + 2 * 60 * 1000;

    // SENSEX fast-path: the ticket polls this endpoint every 1.5s for the live
    // premium — serving the 10s server cache instead of a fresh Kite quote batch
    // per hit is what keeps that poll inside rate limits (mirrors NIFTY's path).
    if (isSensex && !expiryParam && !spotParam && latestSensexChainData && (Date.now() - latestSensexChainAt < 30 * 1000)) {
      return res.json(withAnalytics ? { ...latestSensexChainData, analytics: latestSensexAnalytics } : latestSensexChainData);
    }

    if (symbol !== 'NIFTY 50' || expiryParam || !latestChainData) {
      const forcedSpot = spotParam ? parseFloat(spotParam) : undefined;
      let spotSymbol = symbol;
      if (symbol === "NIFTY BANK" || symbol === "BANKNIFTY") {
        spotSymbol = "NSE:NIFTY BANK";
      } else if (isSensex) {
        spotSymbol = "BSE:SENSEX";
      } else if (symbol === "BANKEX" || symbol === "BSE:BANKEX") {
        spotSymbol = "BSE:BANKEX";
      } else if (!symbol.includes(":")) {
        spotSymbol = `NSE:${symbol}`;
      }
      try {
        const chain = await getLiveOptionChain(spotSymbol, forcedSpot, expiryParam);
        // Seed the SENSEX cache from a default-shaped request so the very next
        // hit (e.g. the ticket's 1.5s poll) is already served from cache.
        if (isSensex && !expiryParam && !spotParam && chain && !chain.isMock) {
          latestSensexChainData = chain;
          latestSensexAnalytics = computeAnalytics(chain);
          latestSensexChainAt = Date.now();
        }
        return res.json(withAnalytics ? { ...chain, analytics: computeAnalytics(chain) } : chain);
      } catch (e) {
        console.error(`Error fetching dynamic option chain for ${symbol}:`, e);
        return res.status(500).json({ error: "Failed to generate option chain" });
      }
    }

    res.json(withAnalytics ? { ...latestChainData, analytics: latestAnalytics } : latestChainData);
  });

  // Index instrument token for the chart switcher (e.g. ?symbol=SENSEX → BSE
  // index token from Zerodha's instrument dump — never hardcoded).
  app.get('/api/index-token', async (req, res) => {
    try {
      const symbol = String(req.query.symbol || '').toUpperCase();
      if (symbol === 'NIFTY 50' || symbol === 'NIFTY') return res.json({ symbol, token: 256265 });
      const token = await getBseIndexToken(symbol);
      return res.json({ symbol, token });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Overnight Gap Scorecard: direction prediction + strike advisor + accuracy
  // tracking (tables, endpoints and IST crons live in server/gap_scorecard.ts).
  // Official NSE trading-holiday calendar (auto-refreshed daily) — feeds the
  // H-levels prompt, the journal guard and the gap-scorecard crons.
  registerCalendar(app, db);

  registerGapScorecard(app, db);

  // Gap Risk Gauge: pre-close estimate of EXPECTED OVERNIGHT MAGNITUDE (not direction).
  // Combines India VIX with the nearest-expiry ATM straddle (the option market's own
  // expected-move number). Direction is deliberately not predicted.
  app.get('/api/gap-risk', async (req, res) => {
    try {
      const chain = latestChainData;
      let spot: number | null = chain?.spot ?? (latestSpot || null);
      let atmStrike: number | null = null;
      let straddle: number | null = null;
      let impliedMovePct: number | null = null;
      let expiry: string | null = chain?.expiryDate ?? null;

      if (chain && Array.isArray(chain.strikes) && chain.strikes.length && spot) {
        // ATM = strike nearest to spot
        atmStrike = chain.strikes.reduce((best: number, s: number) =>
          Math.abs(s - (spot as number)) < Math.abs(best - (spot as number)) ? s : best, chain.strikes[0]);
        const ce = chain.ceData?.[atmStrike as number];
        const pe = chain.peData?.[atmStrike as number];
        const ceLtp = (ce && ce.ltp > 0) ? ce.ltp : 0;
        const peLtp = (pe && pe.ltp > 0) ? pe.ltp : 0;
        if (ceLtp > 0 && peLtp > 0) {
          straddle = +(ceLtp + peLtp).toFixed(2);
          impliedMovePct = +((straddle / (spot as number)) * 100).toFixed(3);
        }
      }

      // India VIX (live quote via Kite, if logged in)
      let vix: number | null = null;
      try {
        const kc = getKiteClient();
        // @ts-ignore
        if (kc && kc.access_token) {
          const q = await kc.getQuote(['NSE:INDIA VIX']);
          const v = q?.['NSE:INDIA VIX']?.last_price;
          if (typeof v === 'number' && v > 0) vix = +v.toFixed(2);
        }
      } catch (e) { /* VIX optional */ }

      return res.json({ success: true, spot, atmStrike, straddle, impliedMovePct, expiry, vix, asOf: Date.now() });
    } catch (e: any) {
      console.error('[gap-risk]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // Premium responsiveness: realized ₹/point vs theoretical delta + intraday IV trend
  app.get('/api/premium-pulse', async (req, res) => {
    try {
      const side = String(req.query.side) === 'PE' ? 'PE' : 'CE';
      const w = parseInt(String(req.query.window));
      const result = await getPremiumPulse(latestChainData, { side, window: isNaN(w) ? undefined : w });
      return res.json(result);
    } catch (e: any) {
      console.error('[premium-pulse]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // Premium Pulse direction lean: CE vs PE premium behaviour → bullish/bearish bias
  app.get('/api/premium-pulse/bias', async (req, res) => {
    try {
      const result = await getPremiumPulseBias(latestChainData);
      return res.json(result);
    } catch (e: any) {
      console.error('[premium-pulse/bias]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // AI Market Read: Claude synthesises the already-computed indicators into a plain-English
  // read (bias label + reasoning + risks). Commentary only — never a trade signal. Requires
  // ANTHROPIC_API_KEY in the environment (set it in Railway). Uses Node's built-in fetch.
  app.post('/api/ai-read', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) {
        return res.status(503).json({ success: false, error: 'AI read not configured — add ANTHROPIC_API_KEY in your Railway variables.' });
      }
      const snapshot = req.body?.snapshot;
      if (!snapshot || typeof snapshot !== 'object') {
        return res.status(400).json({ success: false, error: 'No market snapshot provided.' });
      }
      // Whitelist models so the client can't request arbitrary ones.
      const requested = String(req.body?.model || '');
      const model = requested === 'claude-haiku-4-5' ? 'claude-haiku-4-5' : 'claude-sonnet-4-6';

      const system = [
        'You are a markets analyst embedded in a NIFTY options trading dashboard.',
        'You are given a snapshot of ALREADY-COMPUTED indicators (RSI, ADX, VWAP/EMA, recent candles, the OI chain with CE/PE buildup, and a premium-pulse bias). Your job is to INTERPRET and SYNTHESISE them into one coherent read.',
        'Hard rules:',
        '- Do NOT predict a price target or future price. Do NOT give buy/sell/entry/exit instructions, position sizing, or anything that reads as a trade recommendation. This is commentary, not financial advice.',
        '- Stay strictly grounded in the numbers provided. If the data is thin or conflicting, say so and lean towards NEUTRAL / low confidence.',
        '- Be concise and concrete. Tie every point to a specific value in the snapshot.',
        'Respond with ONLY a JSON object (no markdown, no backticks, no preamble) with exactly these keys:',
        '{"bias": one of "BULLISH"|"MILD BULLISH"|"NEUTRAL"|"MILD BEARISH"|"BEARISH", "confidence": one of "low"|"medium"|"high", "summary": a single plain-English sentence, "reasoning": array of 2-4 short strings, "risks": array of 1-3 short strings describing what would invalidate this read or what to watch}.',
      ].join('\n');

      const userContent = 'Current market snapshot (NIFTY options):\n\n' + JSON.stringify(snapshot) + '\n\nReturn the JSON read now.';

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      let apiResp: any;
      try {
        apiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 700,
            system,
            messages: [{ role: 'user', content: userContent }],
          }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!apiResp.ok) {
        const detail = await apiResp.text().catch(() => '');
        console.error('[ai-read] provider error', apiResp.status, detail.slice(0, 500));
        const msg = apiResp.status === 401
          ? 'AI provider rejected the API key (check ANTHROPIC_API_KEY).'
          : `AI provider error (${apiResp.status}).`;
        return res.status(502).json({ success: false, error: msg });
      }

      const data: any = await apiResp.json();
      const text = (data?.content || [])
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
        .trim();

      let parsed: any = null;
      try {
        parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch { /* fall through to raw */ }

      if (parsed && typeof parsed === 'object') {
        return res.json({ success: true, ...parsed, asOf: Date.now(), model });
      }
      return res.json({ success: true, raw: text, asOf: Date.now(), model });
    } catch (e: any) {
      const aborted = e?.name === 'AbortError';
      console.error('[ai-read]', e);
      return res.status(aborted ? 504 : 500).json({ success: false, error: aborted ? 'AI read timed out.' : (e?.message || String(e)) });
    }
  });

  // Gamma blast monitor: expiry-day convexity + directional catalyst
  app.get('/api/gamma-blast', async (req, res) => {
    try {
      const mp = parseFloat(String(req.query.movePct));
      const result = await getGammaBlast(latestChainData, { movePct: isNaN(mp) ? undefined : mp });
      return res.json(result);
    } catch (e: any) {
      console.error('[gamma-blast]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // Option value: decompose premium into intrinsic + time value across strikes around ATM
  app.get('/api/option-value', (req, res) => {
    try {
      const chain = latestChainData;
      if (!chain || !chain.spot || !Array.isArray(chain.strikes) || !chain.strikes.length) {
        return res.json({ success: false, error: 'Option chain not loaded yet (needs Kite login + market hours).' });
      }
      const spot: number = chain.spot;
      const strikes: number[] = [...chain.strikes].sort((a: number, b: number) => a - b);
      const atm = strikes.reduce((b, s) => (Math.abs(s - spot) < Math.abs(b - spot) ? s : b), strikes[0]);
      const ai = strikes.indexOf(atm);
      const step = ai + 1 < strikes.length ? strikes[ai + 1] - atm : (ai > 0 ? atm - strikes[ai - 1] : 50);
      const moneyness = (type: 'CE' | 'PE', strike: number) => {
        if (strike === atm) return 'ATM';
        if (type === 'CE') return spot > strike ? 'ITM' : 'OTM';
        return strike > spot ? 'ITM' : 'OTM';
      };
      // Time to expiry in years (NIFTY options expire 15:30 IST = 10:00 UTC)
      const r = 0.065;
      let T = 0;
      if (chain.expiryDate) {
        const exp = new Date(chain.expiryDate);
        const expMs = Date.UTC(exp.getUTCFullYear(), exp.getUTCMonth(), exp.getUTCDate(), 10, 0, 0);
        T = Math.max((expMs - Date.now()) / (365 * 24 * 3600 * 1000), 0.5 / (365 * 24));
      }
      const side = (ltp: any, intrinsic: number, type: 'CE' | 'PE', strike: number) => {
        if (ltp == null || ltp <= 0) return null;
        const tv = Math.max(0, ltp - intrinsic);
        const { iv, delta } = T > 0 ? ivAndDelta(type, spot, strike, T, r, ltp) : { iv: null, delta: null };
        return {
          ltp: +ltp.toFixed(2), intrinsic: +intrinsic.toFixed(2), timeValue: +tv.toFixed(2),
          tvPct: +((tv / ltp) * 100).toFixed(0), moneyness: moneyness(type, strike),
          iv: iv != null ? +(iv * 100).toFixed(1) : null,
          delta: delta != null ? +delta.toFixed(2) : null,
        };
      };
      const rows = strikes.filter((s) => Math.abs(s - atm) <= 3 * step).map((strike) => ({
        strike,
        atm: strike === atm,
        ce: side(chain.ceData?.[strike]?.ltp, Math.max(0, spot - strike), 'CE', strike),
        pe: side(chain.peData?.[strike]?.ltp, Math.max(0, strike - spot), 'PE', strike),
      }));
      return res.json({ success: true, spot: +spot.toFixed(2), atmStrike: atm, step, expiry: chain.expiryDate ?? null, rows, asOf: Date.now() });
    } catch (e: any) {
      console.error('[option-value]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // RSI zone-oscillator strategy backtest (signal tested on the NIFTY index, in points).
  app.get('/api/backtest/rsi', async (req, res) => {
    try {
      const q = req.query;
      const num = (v: any, d: number) => { const n = parseFloat(String(v)); return isNaN(n) ? d : n; };
      const result = await runRsiBacktest({
        days: num(q.days, 60),
        rsiPeriod: num(q.rsiPeriod, 14),
        obLow: num(q.obLow, 60), obHigh: num(q.obHigh, 65),
        osLow: num(q.osLow, 38), osHigh: num(q.osHigh, 40),
        deepOb: num(q.deepOb, 70), deepOs: num(q.deepOs, 30),
        useStop: q.useStop === 'true' || q.useStop === '1',
        slMode: typeof q.slMode === 'string' ? q.slMode : undefined,
        timeframe: typeof q.timeframe === 'string' ? q.timeframe : undefined,
        useDivergence: q.useDiv === 'true' || q.useDiv === '1',
        divWindow: num(q.divWindow, 7),
        noEntryAfter: typeof q.noEntryAfter === 'string' ? q.noEntryAfter : '',
        exitAtCutoff: q.exitAtCutoff === 'true' || q.exitAtCutoff === '1',
      });
      return res.json(result);
    } catch (e: any) {
      console.error('[backtest/rsi]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // LIVE: current index signal + ATM CE/PE RSI confirmation
  app.get('/api/signal/live', async (req, res) => {
    try {
      const t = parseFloat(String(req.query.threshold));
      const result = await getLiveSignal(isNaN(t) ? 40 : t);
      return res.json(result);
    } catch (e: any) {
      console.error('[signal/live]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // LIVE ALERT: crossover + RSI divergence (≤W candles) on the latest closed 5-min candle
  app.get('/api/signal/alert', async (req, res) => {
    try {
      const dw = parseInt(String(req.query.divWindow));
      const result = await getAlertSignal({ divWindow: isNaN(dw) ? 5 : dw });
      return res.json(result);
    } catch (e: any) {
      console.error('[signal/alert]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // BACKTEST (recent window): index signal + option-RSI confirmation + real option P&L
  app.get('/api/backtest/rsi-option', async (req, res) => {
    try {
      const q = req.query;
      const num = (v: any, d: number) => { const n = parseFloat(String(v)); return isNaN(n) ? d : n; };
      const result = await runOptionConfirmBacktest({
        optionDays: num(q.optionDays, 12),
        deepOb: num(q.deepOb, 70), deepOs: num(q.deepOs, 30),
        threshold: num(q.threshold, 40),
        useStop: q.useStop === 'true' || q.useStop === '1',
        slMode: typeof q.slMode === 'string' ? q.slMode : undefined,
        timeframe: typeof q.timeframe === 'string' ? q.timeframe : undefined,
        useDivergence: q.useDiv === 'true' || q.useDiv === '1',
        divWindow: num(q.divWindow, 7),
        noEntryAfter: typeof q.noEntryAfter === 'string' ? q.noEntryAfter : '',
        exitAtCutoff: q.exitAtCutoff === 'true' || q.exitAtCutoff === '1',
        requireOptionRsi: q.reqOptRsi !== 'false' && q.reqOptRsi !== '0',
      });
      return res.json(result);
    } catch (e: any) {
      console.error('[backtest/rsi-option]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  app.get('/api/historical-analytics', async (req, res) => {
    const data = await getHistoricalAnalytics();
    res.json(data);
  });

  app.get('/api/quant-engine', async (req, res) => {
    // Generate deterministic quant engine signals based on current analytics
    const rsi = latestAnalytics?.rsi ?? 52;
    const trend = latestAnalytics?.priceBias ?? "up";
    const pcr = latestAnalytics?.pcr ?? 1.05;
    
    // Calculate ATM IV based percentile
    const curIv = latestAnalytics?.atmIv ?? 14.2;
    const ivPercentile = Math.max(10, Math.min(95, parseFloat((((curIv - 10) / 10) * 100).toFixed(1)))) || 55.4;

    // FII factor: only included when REAL NSE data is available. When the fetch
    // fails or returns UNAVAILABLE, pass null — evaluateQuantSignals skips the
    // FII rules entirely rather than scoring a fabricated default ratio.
    let fiiLongRatio: number | null = null;
    try {
      const fiiResult = await getFiiData();
      if (fiiResult && fiiResult.status === "SUCCESS" && fiiResult.data && typeof fiiResult.data.fiiLongRatio === 'number') {
        fiiLongRatio = fiiResult.data.fiiLongRatio;
      }
    } catch (e) {}

    const inputs = { rsi, trend, pcr, ivPercentile, fiiLongRatio };
    const signals = evaluateQuantSignals(inputs);
    res.json(signals);
  });

  app.post('/api/generate-game-plan', express.json(), async (req, res) => {
    try {
      const { alerts } = req.body;
      if (!alerts || !Array.isArray(alerts)) {
        return res.status(400).json({ error: "Invalid alerts array" });
      }
      const plan = await generateGamePlan(alerts);
      res.json({ gamePlan: plan });
    } catch (err: any) {
      console.error("Error generating game plan:", err);
      res.status(500).json({ error: err.message || "Internal server error" });
    }
  });

  // ---- H-levels journal (manual daily entry; analysis comes later) ----
  app.post('/api/h-levels', express.json(), (req, res) => {
    try {
      const { date, levels, note } = req.body || {};
      const d = String(date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD' });
      // Never journal non-trading days: weekends + listed NSE holidays.
      const wd = new Date(d + 'T00:00:00Z').getUTCDay();
      if (wd === 0 || wd === 6) return res.json({ ok: false, skipped: true, error: 'weekend — market closed, not journaled' });
      if (calIsNseHoliday(d)) return res.json({ ok: false, skipped: true, error: `${holidayName(d) || 'NSE holiday'} — market closed, not journaled` });
      const arr = Array.isArray(levels) ? levels.map(Number).filter((v: number) => isFinite(v)) : [];
      if (!arr.length) return res.status(400).json({ ok: false, error: 'levels must be a non-empty number array' });
      // Symbol defaults to NIFTY so anything older that omits it keeps working.
      const sym = String((req.body && req.body.symbol) || 'NIFTY').toUpperCase().trim() || 'NIFTY';
      db.prepare(`INSERT INTO h_levels_v2 (symbol, date, levels, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, date) DO UPDATE SET levels = excluded.levels, note = excluded.note, updated_at = excluded.updated_at`)
        .run(sym, d, JSON.stringify(arr), String(note || ''), Date.now(), Date.now());
      res.json({ ok: true, symbol: sym, date: d, count: arr.length });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });
  app.get('/api/h-levels', (req, res) => {
    try {
      const limit = Math.min(500, parseInt(String(req.query.limit || '200'), 10) || 200);
      const symQ = req.query.symbol ? String(req.query.symbol).toUpperCase().trim() : null;
      const rows = ((symQ
        ? db.prepare('SELECT * FROM h_levels_v2 WHERE symbol = ? ORDER BY date DESC LIMIT ?').all(symQ, limit)
        : db.prepare('SELECT * FROM h_levels_v2 ORDER BY date DESC LIMIT ?').all(limit)) as any[])
        .map(r => ({ date: r.date, levels: JSON.parse(r.levels), note: r.note || '' }));
      res.json({ rows });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });
  app.delete('/api/h-levels/:date', (req, res) => {
    try {
      const sym = String((req.query.symbol as string) || 'NIFTY').toUpperCase().trim();
      db.prepare('DELETE FROM h_levels_v2 WHERE symbol = ? AND date = ?').run(sym, String(req.params.date));
      res.json({ ok: true, symbol: sym });
    }
    catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.get('/api/fii-cash', async (_req, res) => {
    try { res.json(await getCashFiiDii()); }
    catch (e: any) { res.status(500).json({ unavailable: true, error: e?.message || String(e) }); }
  });

  app.get('/api/fii-dii', async (req, res) => {
    const fiiData = await getFiiData();
    res.json(fiiData);
  });

  app.get('/api/reports', async (req, res) => {
    try {
      const reportData = await getKiteReportData();
      res.json(reportData);
    } catch (err: any) {
      console.error("Error in GET /api/reports:", err);
      res.status(500).json({ error: "Failed to fetch option report book data" });
    }
  });

  app.post('/api/orders', express.json(), async (req, res) => {
    try {
      const { 
        action, // BUY/SELL
        tradingsymbol,
        exchange,
        quantity,
        product, // MIS/NRML
        price,
        test_mode // boolean flag for testing
      } = req.body;
      const order_type = req.body.order_type || req.body.orderType || 'MARKET';

      if (!tradingsymbol || !quantity) {
        return res.status(400).json({ success: false, error: "Missing tradingsymbol or quantity" });
      }

      // Kite Connect rejects plain MARKET orders ("Market orders without market
      // protection are not allowed via API"). So we ALWAYS submit a LIMIT order,
      // priced at the live price with a small buffer (above market for a BUY,
      // below for a SELL) so it fills almost immediately, rounded to the NSE
      // option tick size of 0.05 which Kite also requires.
      const incomingType = String(order_type || "MARKET").toUpperCase();
      const isBuy = String(action).toUpperCase() === "BUY";
      const fullSymbol = `${exchange || "NFO"}:${tradingsymbol}`;

      // Base price: use the price the client sent if valid, otherwise fetch the
      // current live price from Kite so the user never has to type one.
      let basePrice = parseFloat(price);
      if (!basePrice || isNaN(basePrice) || basePrice <= 0) {
        try {
          const quoteClient = getKiteClient();
          // @ts-ignore
          if (quoteClient && quoteClient.access_token) {
            const q = await quoteClient.getQuote([fullSymbol]);
            basePrice = q?.[fullSymbol]?.last_price;
          }
        } catch (e) {
          console.error(`[Order API] Failed to fetch live price for ${fullSymbol}:`, e);
        }
      }

      if (!basePrice || isNaN(basePrice) || basePrice <= 0) {
        return res.status(400).json({ success: false, error: "Could not determine a live price to place the order. Please try again." });
      }

      // Explicit LIMIT order: use the user's price as-is. MARKET: buffer it 0.5%.
      const buffer = incomingType === "LIMIT" ? 1 : (isBuy ? 1.005 : 0.995);
      const limitPrice = parseFloat((Math.round((basePrice * buffer) / 0.05) * 0.05).toFixed(2));

      const payloadObj: any = {
        exchange: exchange || "NFO",
        tradingsymbol: tradingsymbol,
        transaction_type: action,
        quantity: parseInt(quantity, 10),
        product: product || "MIS",
        order_type: "LIMIT",
        price: limitPrice,
        validity: "DAY"
      };

      console.log(`[Order API] POST /api/orders request payload:`, JSON.stringify(req.body));
      console.log(`[Order API] Built Kite place_order payload:`, JSON.stringify(payloadObj));

      // Trade-journal entry capture (Phase 1). Only when the client explicitly flags this as an
      // opening trade (`journal: true`), so closing orders (e.g. "Exit All") are never mis-recorded
      // as new entries. Fully isolated in try/catch so it can never affect order placement.
      const recordJournalEntry = (simulated: boolean, testMode: boolean) => {
        try {
          if (!req.body || !req.body.journal) return;
          const ctx = req.body.context || {};
          const sym = String(tradingsymbol);
          const ot = ctx.optionType || (sym.endsWith('PE') ? 'PE' : sym.endsWith('CE') ? 'CE' : undefined);
          journalOpenTrade({
            tradingsymbol, exchange, side: action, qty: parseInt(String(quantity), 10), product,
            entryPrice: basePrice, entrySpot: (typeof ctx.spot === 'number' ? ctx.spot : latestSpot),
            optionType: ot, strike: (typeof ctx.strike === 'number' ? ctx.strike : undefined),
            context: ctx, testMode, simulated,
          });
        } catch (e) { console.error('[Journal] entry capture failed', e); }
      };

      if (test_mode) {
        const testResponse = {
          success: true,
          simulated: false,
          test_mode: true,
          message: "Test mode: Payload built successfully but not submitted to Kite.",
          orderId: "TEST-ORDER-ID",
          kitePayload: payloadObj,
          exchange_order_id: null,
          status: 'TEST_SUCCESS'
        };
        console.log(`[Order API] POST /api/orders response payload:`, JSON.stringify(testResponse));
        recordJournalEntry(false, true);
        return res.json(testResponse);
      }

      const kc = getKiteClient();
      // @ts-ignore
      if (kc && kc.access_token) {
        try {
          const orderResponse = await kc.placeOrder("regular", payloadObj);
          
          let orderId = typeof orderResponse === 'string' ? orderResponse : (orderResponse as any).order_id;
          let exchangeOrderId = typeof orderResponse === 'object' ? (orderResponse as any).exchange_order_id : null;
          let status = typeof orderResponse === 'object' ? (orderResponse as any).status : 'SUCCESS';

          const responsePayload = { 
            success: true, 
            orderId, 
            exchange_order_id: exchangeOrderId,
            status,
            rawResponse: orderResponse,
            message: `Placed order ${orderId} successfully on Kite.` 
          };
          console.log(`[Order API] POST /api/orders success response:`, JSON.stringify(responsePayload));
          recordJournalEntry(false, false);
          return res.json(responsePayload);
        } catch (kiteErr: any) {
          console.error("[Order API] Kite error placing order:", kiteErr);
          
          const errMsg = kiteErr.message || "";
          // Check if this is an IP restriction, permission exception, or other blocking error
          const isIPPermissionError = errMsg.includes("No IPs configured") || 
                                      errMsg.includes("PermissionException") || 
                                      (kiteErr.status === "error" && kiteErr.error_type === "PermissionException") ||
                                      (kiteErr.kiteDetails && kiteErr.kiteDetails.error_type === "PermissionException");
          
          const isMarketClosed = errMsg.includes("closed") || errMsg.includes("Market is closed");
          
          let serverIp = "unknown";
          try {
            const ipRes = await fetch("https://api.ipify.org?format=json");
            const ipObj = await ipRes.json() as any;
            if (ipObj && ipObj.ip) {
              serverIp = ipObj.ip;
            }
          } catch (ipErr) {
            console.warn("Could not fetch server public IP:", ipErr);
          }

          let enhancedError = errMsg;
          if (isIPPermissionError) {
            enhancedError = `No IPs configured: Please whitelist this server's public IP (${serverIp}) in your Kite Developer Console to place real trades. (Detail: ${errMsg})`;
          } else if (isMarketClosed) {
            enhancedError = `Market Closed: Could not place order on exchange. (Detail: ${errMsg})`;
          }

          const responsePayload = {
            success: false,
            error: enhancedError,
            publicIp: serverIp,
            message: enhancedError
          };
          console.log(`[Order API] POST /api/orders failed:`, JSON.stringify(responsePayload));
          return res.status(400).json(responsePayload);
        }
      } else {
        // Simulated execution
        const orderId = "SIM-ORD-" + Math.floor(100000 + Math.random() * 900000);
        const responsePayload = { 
          success: true, 
          orderId, 
          simulated: true,
          exchange_order_id: null,
          status: 'SIMULATED',
          message: `Order for ${quantity} qty of ${tradingsymbol} (${action}) placed successfully (Simulated mode).`
        };
        console.log(`[Order API] POST /api/orders response payload:`, JSON.stringify(responsePayload));
        recordJournalEntry(true, false);
        return res.json(responsePayload);
      }
    } catch (err: any) {
      console.error("[Order API] Error processing order request:", err);
      const errorResponse = { success: false, error: err.message || "Failed to process order" };
      console.log(`[Order API] POST /api/orders catch error response:`, JSON.stringify(errorResponse));
      res.status(500).json(errorResponse);
    }
  });

  app.get('/api/auth/status', (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM kite_tokens ORDER BY id DESC LIMIT 1').get() as any;
      if (row) {
        if (row.access_token === 'simulated_session_token') {
          return res.json({ status: 'connected', simulated: true });
        }
        const today = new Date().toISOString().split('T')[0];
        if (row.token_date === today) {
          return res.json({ status: 'connected', simulated: false });
        }
      }
      return res.json({ status: 'disconnected', loginUrl: getKiteLoginUrl() });
    } catch (e: any) {
      console.error("Error reading auth status:", e);
      return res.json({ status: 'disconnected', error: e.message, loginUrl: getKiteLoginUrl() });
    }
  });

  app.get('/api/margins', async (req, res) => {
    try {
      const kc = getKiteClient();
      // @ts-ignore
      if (kc && kc.access_token) {
        const margins = await kc.getMargins();
        const balance = margins?.equity?.net ?? margins?.equity?.available?.cash ?? 0;
        return res.json({
          success: true,
          live: true,
          balance: typeof balance === 'string' ? parseFloat(balance) : balance,
          margins
        });
      }
      return res.json({
        success: true,
        live: false,
        balance: 150000.00
      });
    } catch (err: any) {
      console.error("Error fetching Kite margins:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Failed to fetch margins",
        live: false
      });
    }
  });

  app.post('/api/instruments/refresh', async (req, res) => {
    try {
      clearInstrumentsCache();
      // rebuild/refetch latest option lookup table immediately
      await refreshData();
      return res.json({
        success: true,
        message: "Latest Kite instruments list refetched and rebuilt successfully."
      });
    } catch (err: any) {
      console.error("Error refreshing instruments:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Failed to refresh instruments"
      });
    }
  });

  app.get('/api/diagnostics/kite', (req, res) => {
    try {
      const apiKey = process.env.KITE_API_KEY;
      let hasAccessToken = false;
      try {
        const today = new Date().toISOString().split('T')[0];
        const row = db.prepare('SELECT access_token FROM kite_tokens WHERE token_date = ? ORDER BY id DESC LIMIT 1').get(today) as any;
        if (row && row.access_token) {
          hasAccessToken = true;
        }
      } catch (e) {}

      res.json({
        kiteApiKeysConfigured: !!apiKey,
        kiteAccessTokenPresent: hasAccessToken
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/orders/margins', express.json(), async (req, res) => {
    try {
      console.log("[Margin API Backend] Step 3: Backend receives request:", JSON.stringify(req.body));
      
      const client = getKiteClient();
      if (!client) {
        return res.status(500).json({ success: false, statusCode: 500, error: 'Kite Client failed to initialize', responseBody: null });
      }
      
      const orderParams = req.body;
      const params = [{
        exchange: orderParams.exchange || 'NFO',
        tradingsymbol: orderParams.tradingsymbol,
        transaction_type: orderParams.transaction_type,
        variety: orderParams.variety || 'regular',
        product: orderParams.product,
        order_type: orderParams.order_type,
        quantity: typeof orderParams.quantity === 'number' ? orderParams.quantity : parseInt(orderParams.quantity, 10),
        price: orderParams.price ? parseFloat(orderParams.price) : 0,
        trigger_price: orderParams.trigger_price ? parseFloat(orderParams.trigger_price) : 0,
      }];

      console.log("[Margin API Backend] Step 4: Backend calls Kite Margin API with payload:", JSON.stringify(params));
      
      const margins = await client.orderMargins(params);
      
      console.log("[Margin API Backend] Step 5: Kite response received:", JSON.stringify(margins));
      
      if (margins && margins.length > 0) {
        return res.json({ success: true, statusCode: 200, error: null, responseBody: margins[0] });
      } else {
        return res.status(500).json({ success: false, statusCode: 500, error: 'Empty response from Kite', responseBody: null });
      }
    } catch (err: any) {
      console.error("[Margin API] Error fetching margin:", err.message);
      let statusCode = 500;
      if (err.status) statusCode = err.status;
      else if (err.message?.includes('403') || err.message?.includes('Token is invalid')) statusCode = 403;
      else if (err.message?.includes('401')) statusCode = 401;
      else if (err.message?.includes('429')) statusCode = 429;
      
      return res.status(statusCode).json({ 
        success: false, 
        statusCode, 
        error: err.message || 'Failed to fetch margin', 
        responseBody: null 
      });
    }
  });



  app.get('/api/auth/callback', async (req, res) => {
    try {
      const { request_token } = req.query;
      if (typeof request_token === 'string') {
        const token = await generateSession(request_token);
        if (token) {
          connectTicker();
          return res.redirect('/kite-login?status=success');
        }
      }
      return res.redirect('/kite-login?status=error&message=No+token+received');
    } catch (err: any) {
      console.error("Error in GET /api/auth/callback:", err);
      return res.redirect(`/kite-login?status=error&message=${encodeURIComponent(err.message || "Failed to authenticate with Zerodha Kite API")}`);
    }
  });

  app.post('/api/auth/manual', express.json(), async (req, res) => {
    try {
      const { request_token } = req.body;
      if (!request_token || typeof request_token !== 'string') {
        return res.status(400).json({ success: false, error: "Request token is missing or invalid" });
      }
      
      const token = await generateSession(request_token);
      if (token) {
        connectTicker();
        return res.json({ success: true });
      } else {
        return res.status(400).json({ success: false, error: "Kite returned an empty session. Please verify your API key and secret are correct and valid." });
      }
    } catch (err: any) {
      console.error("Error in POST /api/auth/manual:", err);
      return res.status(400).json({ success: false, error: err.message || "Failed to authenticate with Zerodha Kite." });
    }
  });

  app.post('/api/auth/simulate', (req, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      // Clean up previous tokens
      db.prepare('DELETE FROM kite_tokens').run();
      db.prepare('INSERT INTO kite_tokens (access_token, token_date) VALUES (?, ?)').run('simulated_session_token', today);
      res.json({ success: true, message: "Simulated sandbox session activated." });
    } catch (err: any) {
      console.error("Error activating simulation:", err);
      res.status(500).json({ error: err.message || "Failed to activate simulated session" });
    }
  });

  app.post('/api/auth/disconnect', (req, res) => {
    try {
      db.prepare('DELETE FROM kite_tokens').run();
      res.json({ success: true, message: "Disconnected successfully." });
    } catch (err: any) {
      console.error("Error disconnecting:", err);
      res.status(500).json({ error: err.message || "Failed to disconnect session" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
