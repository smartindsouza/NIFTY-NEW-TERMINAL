import express from "express";
import path from "path";
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

import { getLiveNews, rateLimitMiddleware, currentAIStatus } from './server/news_service';

const PORT = 3000;

const db = new Database('kite_session.db');
db.pragma('journal_mode = WAL');

// Simple Token Table
db.prepare(`
  CREATE TABLE IF NOT EXISTS kite_tokens (
    id INTEGER PRIMARY KEY,
    access_token TEXT,
    token_date TEXT
  )
`).run();

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
      latestSpot = latestChainData.spot;
      latestAnalytics = computeAnalytics(latestChainData);
    }
  } catch (e) {
    console.error("Error refreshing data:", e);
  }
}

refreshData();

  // Broadcast function
  const broadcast = (data: any) => {
    wss.clients.forEach((client) => {
      if (client.readyState === 1) { // OPEN
        client.send(JSON.stringify(data));
      }
    });
  };

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

      const payloadObj = {
        exchange: exchange || "NFO",
        tradingsymbol: tradingsymbol,
        transaction_type: action,
        quantity: parseInt(quantity, 10),
        product: product || "MIS",
        order_type: order_type || "MARKET",
        price: price ? parseFloat(price) : undefined
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
          const errorResponse = { success: false, error: kiteErr.message || "Kite failed to place order", isKiteError: true, kiteDetails: kiteErr };
          console.log(`[Order API] POST /api/orders error response:`, JSON.stringify(errorResponse));
          return res.status(500).json(errorResponse);
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
    const row = db.prepare('SELECT * FROM kite_tokens ORDER BY id DESC LIMIT 1').get() as any;
    if (row && row.token_date === new Date().toISOString().split('T')[0]) {
      res.json({ status: 'connected' });
    } else {
      res.json({ status: 'disconnected', loginUrl: getKiteLoginUrl() });
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
    const { request_token } = req.query;
    if (typeof request_token === 'string') {
      const token = await generateSession(request_token);
      if (token) {
        return res.redirect('/kite-login?status=success');
      }
    }
    res.status(400).send("Login failed or missing request_token");
  });

  app.post('/api/auth/manual', express.json(), async (req, res) => {
    const { request_token } = req.body;
    if (typeof request_token === 'string') {
      const token = await generateSession(request_token);
      if (token) {
        return res.json({ success: true });
      }
    }
    res.status(400).json({ success: false, error: "Invalid request token or keys missing" });
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
