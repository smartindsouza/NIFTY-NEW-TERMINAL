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
async function closePositionBySymbol(tradingsymbol: string): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  try {
    const kc = getKiteClient();
    // @ts-ignore
    if (!kc || !kc.access_token) return { ok: false, error: 'No active Kite session — please log in to Zerodha today.' };
    let positions: any;
    try { positions = await kc.getPositions(); } catch (e: any) { return { ok: false, error: 'Could not read positions: ' + (e?.message || e) }; }
    const net = (positions && positions.net) || [];
    const pos = net.find((p: any) => p.tradingsymbol === tradingsymbol && p.quantity !== 0);
    if (!pos) return { ok: false, error: `No open position found for ${tradingsymbol} on Zerodha (it may already be closed).` };
    const qty = Math.abs(pos.quantity);
    const side = pos.quantity > 0 ? 'SELL' : 'BUY'; // long -> sell to close; short -> buy to close
    return await placeKiteLimitExit({ exchange: pos.exchange || 'NFO', tradingsymbol, qty, product: pos.product || 'NRML', side });
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
    const result = await closePositionBySymbol(rule.tradingsymbol);
    if (result.ok) {
      db.prepare("UPDATE exit_rules SET status='TRIGGERED', detail=? WHERE id=?").run(`${reason} | exit order ${result.orderId}`, rule.id);
      console.log(`[ExitWatcher] EXITED ${rule.tradingsymbol}: ${reason} (order ${result.orderId})`);
    } else {
      db.prepare("UPDATE exit_rules SET status='ERROR', detail=? WHERE id=?").run(`${reason} | FAILED: ${result.error}`, rule.id);
      console.error(`[ExitWatcher] EXIT FAILED ${rule.tradingsymbol}: ${result.error}`);
    }
  }

  // Fast loop (2s): live spot TOUCH triggers
  setInterval(async () => {
    try {
      if (!latestSpot || latestSpot <= 0) return;
      const rules = db.prepare("SELECT * FROM exit_rules WHERE status='ACTIVE' AND spot_mode='TOUCH'").all() as any[];
      for (const r of rules) {
        let hit = '';
        if (r.spot_lower && latestSpot <= r.spot_lower) hit = `Spot ${latestSpot.toFixed(2)} hit lower ${r.spot_lower}`;
        else if (r.spot_upper && latestSpot >= r.spot_upper) hit = `Spot ${latestSpot.toFixed(2)} hit upper ${r.spot_upper}`;
        if (hit) await triggerRuleExit(r, hit);
      }
    } catch (e) { /* keep watcher alive */ }
  }, 2000);

  // Slow loop (15s): candle-close triggers — spot CLOSE mode + RSI — only on a newly-closed candle
  setInterval(async () => {
    try {
      const rules = db.prepare("SELECT * FROM exit_rules WHERE status='ACTIVE' AND (spot_mode='CLOSE' OR rsi_lower IS NOT NULL OR rsi_upper IS NOT NULL)").all() as any[];
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
          if (r.spot_mode === 'CLOSE') {
            if (r.spot_lower && closePrice <= r.spot_lower) hit = `Candle closed ${closePrice} below lower ${r.spot_lower}`;
            else if (r.spot_upper && closePrice >= r.spot_upper) hit = `Candle closed ${closePrice} above upper ${r.spot_upper}`;
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
  app.post('/api/exit-position', express.json(), async (req, res) => {
    try {
      const { tradingsymbol } = req.body || {};
      if (!tradingsymbol) return res.status(400).json({ success: false, error: 'Missing tradingsymbol' });
      const result = await closePositionBySymbol(tradingsymbol);
      if (result.ok) return res.json({ success: true, orderId: result.orderId });
      return res.json({ success: false, error: result.error }); // business error, not a crash
    } catch (e: any) {
      console.error('[exit-position]', e);
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  app.post('/api/exit-rules', express.json(), (req, res) => {
    try {
      const { tradingsymbol, exchange, qty, product, positionSide, spotLower, spotUpper, spotMode, rsiLower, rsiUpper, timeframe } = req.body;
      if (!tradingsymbol || !qty) return res.status(400).json({ success: false, error: 'Missing tradingsymbol or qty' });
      const exitSide = String(positionSide).toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
      db.prepare("UPDATE exit_rules SET status='CANCELLED' WHERE tradingsymbol=? AND status='ACTIVE'").run(tradingsymbol);
      const info = db.prepare(`INSERT INTO exit_rules
        (tradingsymbol, exchange, qty, product, exit_side, spot_lower, spot_upper, spot_mode, rsi_lower, rsi_upper, timeframe, underlying_token, status, detail, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', '', ?)`).run(
          tradingsymbol, exchange || 'NFO', parseInt(qty, 10), product || 'MIS', exitSide,
          spotLower || null, spotUpper || null, (spotMode === 'CLOSE' ? 'CLOSE' : 'TOUCH'),
          rsiLower || null, rsiUpper || null, String(timeframe || '5'), '256265', Math.floor(Date.now() / 1000)
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
