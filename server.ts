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
import { getTechnicalAnalysis, kiteDiagnostics } from './server/technical_analysis';
import { getKiteClient, generateSession, getLiveOptionChain, getKiteLoginUrl, searchInstruments, clearInstrumentsCache, getKiteReportData } from './server/kite_service';
import { getHistoricalAnalytics } from './server/analytics_service';
import { getFiiData } from './server/fii_service';
import { evaluateQuantSignals } from './server/quant_engine';
import { generateGamePlan } from './server/game_plan_service';

import { getLiveNews, rateLimitMiddleware, currentAIStatus } from './server/news_service';
import { startTicker, setSubscriptions, isTickerConnected } from './server/ticker_service';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const KITE_DATA_DIR = process.env.KITE_DATA_DIR || '.';
const db = new Database(`${KITE_DATA_DIR}/kite_session.db`);
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
] as [string, string][])) {
  try { db.prepare(`ALTER TABLE exit_rules ADD COLUMN ${col} ${def}`).run(); } catch (e) { /* column already exists */ }
}

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

async function refreshData() {
  try {
    latestChainData = await getLiveOptionChain('NSE:NIFTY 50');
    if (latestChainData) {
      const tokens: number[] = [256265];
      for (const k of (latestChainData.strikes || [])) {
        if (latestChainData.ceData?.[k]?.instrument_token) tokens.push(latestChainData.ceData[k].instrument_token);
        if (latestChainData.peData?.[k]?.instrument_token) tokens.push(latestChainData.peData[k].instrument_token);
      }
      setSubscriptions(tokens);

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
    } else {
      broadcast({ type: 'optionTick', token: tick.token, ltp: tick.ltp, oi: tick.oi, volume: tick.volume });
    }
  });
}

refreshData();
connectTicker();

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

  app.post('/api/exit-position', express.json(), async (req, res) => {
    try {
      const { tradingsymbol, reason } = req.body || {};
      if (!tradingsymbol) return res.status(400).json({ success: false, error: 'Missing tradingsymbol' });
      const result = await closePositionBySymbol(tradingsymbol, reason || 'MANUAL');
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
      const { trailEnabled, trailCandles, targetPrice, trailDir, stopMode, targetMode } = req.body || {};
      const exitSide = String(positionSide).toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
      const sMode = (stopMode === 'TOUCH' ? 'TOUCH' : 'CLOSE');
      const tMode = (targetMode === 'TOUCH' ? 'TOUCH' : 'CLOSE');
      db.prepare("UPDATE exit_rules SET status='CANCELLED' WHERE tradingsymbol=? AND status='ACTIVE'").run(tradingsymbol);
      const info = db.prepare(`INSERT INTO exit_rules
        (tradingsymbol, exchange, qty, product, exit_side, spot_lower, spot_upper, spot_mode, rsi_lower, rsi_upper, timeframe, underlying_token, status, detail, created_at, trail_enabled, trail_candles, target_price, trail_dir, trail_active, trail_stop, stop_mode, target_mode)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', '', ?, ?,?,?,?, 0, NULL, ?, ?)`).run(
          tradingsymbol, exchange || 'NFO', parseInt(qty, 10), product || 'MIS', exitSide,
          spotLower || null, spotUpper || null, sMode,
          rsiLower || null, rsiUpper || null, String(timeframe || '5'), '256265', Math.floor(Date.now() / 1000),
          trailEnabled ? 1 : 0, parseInt(trailCandles, 10) || 3, targetPrice || null, (trailDir === 'SHORT' ? 'SHORT' : (trailDir === 'LONG' ? 'LONG' : null)),
          sMode, tMode
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

  app.get('/api/diagnostics/proxy', async (req, res) => {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
    let expectedIp = null;
    try { expectedIp = new URL(proxyUrl).hostname; } catch {}
    try {
      const r = await axios.get('https://api.ipify.org', { timeout: 4000 });
      const egressIp = String(r.data || '').trim();
      res.json({ alive: !!expectedIp && egressIp === expectedIp, egressIp, expectedIp });
    } catch (e: any) {
      res.json({ alive: false, egressIp: null, expectedIp, error: String((e && e.message) || e) });
    }
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

  app.get('/api/option-chain', async (req, res) => {
    const symbol = req.query.symbol as string || 'NIFTY 50';
    const spotParam = req.query.spot as string;
    const expiryParam = req.query.expiry as string;

    if (symbol !== 'NIFTY 50' || expiryParam || !latestChainData) {
      const forcedSpot = spotParam ? parseFloat(spotParam) : undefined;
      let spotSymbol = symbol;
      if (symbol === "NIFTY BANK" || symbol === "BANKNIFTY") {
        spotSymbol = "NSE:NIFTY BANK";
      } else if (!symbol.includes(":")) {
        spotSymbol = `NSE:${symbol}`;
      }
      try {
        const chain = await getLiveOptionChain(spotSymbol, forcedSpot, expiryParam);
        return res.json(chain);
      } catch (e) {
        console.error(`Error fetching dynamic option chain for ${symbol}:`, e);
        return res.status(500).json({ error: "Failed to generate option chain" });
      }
    }

    res.json(latestChainData);
  });

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

    let fiiLongRatio = 54.3;
    try {
      const fiiResult = await getFiiData();
      if (fiiResult && fiiResult.data && fiiResult.data.fiiLongRatio) {
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
