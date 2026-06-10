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
db.pragma('journal_mode = WAL');

// Simple Token Table
db.prepare(`
  CREATE TABLE IF NOT EXISTS kite_tokens (
    id INTEGER PRIMARY KEY,
    access_token TEXT,
    token_date TEXT
  )
`).run();

function getTodayAccessToken(): string | null {
  try {
    const today = new Date().toISOString().split('T')[0];
    const row = db.prepare('SELECT access_token FROM kite_tokens WHERE token_date = ? ORDER BY id DESC LIMIT 1').get(today) as any;
    return row?.access_token || null;
  } catch { return null; }
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

  app.get('/api/quant-engine', (req, res) => {
    // Generate deterministic quant engine signals based on current analytics
    const rsi = latestAnalytics?.rsi ?? 50;
    const trend = latestAnalytics?.priceBias ?? "neutral";
    const pcr = latestAnalytics?.pcr ?? 1.0;
    const inputs = { rsi, trend, pcr, ivPercentile: null };
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

      const payloadObj: any = {
        exchange: exchange || "NFO",
        tradingsymbol: tradingsymbol,
        transaction_type: action,
        quantity: parseInt(quantity, 10),
        product: product || "MIS",
        order_type: order_type || "MARKET",
        validity: "DAY"
      };

      if (payloadObj.order_type === "LIMIT" && price) {
          payloadObj.price = parseFloat(price);
      }

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
