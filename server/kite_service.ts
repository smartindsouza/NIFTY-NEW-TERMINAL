import { KiteConnect } from 'kiteconnect';
import Database from 'better-sqlite3';
import { generateSimulatedChain } from './simulate_data';

const KITE_DATA_DIR = process.env.KITE_DATA_DIR || '.';
const db = new Database(`${KITE_DATA_DIR}/kite_session.db`);
try { db.pragma('busy_timeout = 5000'); } catch (e) { console.error('DB pragma error', e); }
db.pragma('journal_mode = WAL');

db.prepare(`
  CREATE TABLE IF NOT EXISTS daily_oi (
    instrument_token INTEGER,
    date TEXT,
    oi REAL,
    PRIMARY KEY (instrument_token, date)
  )
`).run();

export function getKiteClient() {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) return null;
  
  const kc = new KiteConnect({ api_key: apiKey });
  
  try {
    const today = new Date().toISOString().split('T')[0];
    const row = db.prepare('SELECT access_token FROM kite_tokens WHERE token_date = ? ORDER BY id DESC LIMIT 1').get(today) as any;
    if (row && row.access_token) {
      kc.setAccessToken(row.access_token);
      return kc;
    }
  } catch (e) {
    console.error("DB error reading token", e);
  }
  
  // Return instance even without access token, so we can generate login URL
  return kc;
}

export function getKiteLoginUrl() {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) return null;
  return `https://kite.zerodha.com/connect/login?api_key=${apiKey}&v=3`;
}

export async function generateSession(requestToken: string) {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  
  if (!apiKey || !apiSecret) {
    throw new Error('Zerodha Kite API keys are not configured. Please define KITE_API_KEY and KITE_API_SECRET in your settings (such as the Secrets menu).');
  }

  const kc = new KiteConnect({ api_key: apiKey });
  try {
    const response = await kc.generateSession(requestToken, apiSecret);
    
    if (response && response.access_token) {
      const today = new Date().toISOString().split('T')[0];
      db.prepare('INSERT INTO kite_tokens (access_token, token_date) VALUES (?, ?)').run(response.access_token, today);
      return response.access_token;
    }
    throw new Error("No access token was returned by Zerodha Kite Connect.");
  } catch (e: any) {
    console.error("Error generating kite session:", e);
    throw new Error(e.message || "Failed to generate Kite session with Zerodha API.");
  }
}

let allInstrumentsCache: any[] | null = null;
let lastAllInstrumentsFetch = 0;

export async function searchInstruments(query: string) {
  const kc = getKiteClient();
  const q = query.toLowerCase();

  try {
    const now = Date.now();
    // Cache for 1 day
    if (!allInstrumentsCache || (now - lastAllInstrumentsFetch > 24 * 60 * 60 * 1000)) {
      if (kc) {
        allInstrumentsCache = await kc.getInstruments();
        lastAllInstrumentsFetch = now;
      } else {
        return simulatedInstrumentsFallback(q);
      }
    }

    if (!allInstrumentsCache) return simulatedInstrumentsFallback(q);

    // Filter instruments
    const results = allInstrumentsCache.filter((i: any) => {
      if (i.exchange !== 'NSE' && i.exchange !== 'NFO' && i.exchange !== 'BSE') return false;
      const ts = i.tradingsymbol?.toLowerCase() || '';
      const name = i.name?.toLowerCase() || '';
      return ts.includes(q) || name.includes(q);
    });

    // Sort: exact matches first, then startsWith, etc, limit to 50
    const sorted = results.sort((a, b) => {
       const aTs = (a.tradingsymbol||'').toLowerCase();
       const bTs = (b.tradingsymbol||'').toLowerCase();
       if (aTs === q) return -1;
       if (bTs === q) return 1;
       if (aTs.startsWith(q) && !bTs.startsWith(q)) return -1;
       if (bTs.startsWith(q) && !aTs.startsWith(q)) return 1;
       return 0;
    }).slice(0, 50);

    return sorted;
  } catch (e) {
    console.error("Error searching instruments:", e);
    return simulatedInstrumentsFallback(q);
  }
}

function simulatedInstrumentsFallback(q: string) {
  const fallback = [
    { tradingsymbol: 'RELIANCE', name: 'RELIANCE INDUSTRIES', exchange: 'NSE', instrument_type: 'EQ', instrument_token: 738561 },
    { tradingsymbol: 'INFY', name: 'INFOSYS', exchange: 'NSE', instrument_type: 'EQ', instrument_token: 408065 },
    { tradingsymbol: 'TCS', name: 'TATA CONSULTANCY SERV LT', exchange: 'NSE', instrument_type: 'EQ', instrument_token: 2953217 },
    { tradingsymbol: 'HDFCBANK', name: 'HDFC BANK', exchange: 'NSE', instrument_type: 'EQ', instrument_token: 341249 },
    { tradingsymbol: 'NIFTY 50', name: 'NIFTY 50', exchange: 'NSE', instrument_type: 'INDEX', instrument_token: 256265 },
    { tradingsymbol: 'BANKNIFTY', name: 'NIFTY BANK', exchange: 'NSE', instrument_type: 'INDEX', instrument_token: 260105 },
    { tradingsymbol: 'NIFTY 25000 CE 29 MAY 2025', name: 'NIFTY', exchange: 'NFO', instrument_type: 'CE', expiry: '2025-05-29T00:00:00.000Z', strike: 25000, instrument_token: 123456 },
  ];
  return fallback.filter(i => i.tradingsymbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
}

let nfoInstrumentsCache: any[] | null = null;
let lastInstrumentsFetch = 0;

export function clearInstrumentsCache() {
  allInstrumentsCache = null;
  lastAllInstrumentsFetch = 0;
  nfoInstrumentsCache = null;
  lastInstrumentsFetch = 0;
}

// Returns the nearest index-futures contracts (front month + next month) for an index
// like NIFTY / BANKNIFTY / FINNIFTY. The spot index itself has no traded volume, so we
// borrow volume from the actual futures contract. Returning the two nearest expiries lets
// the caller pick the MOST-ACTIVE one, which matters near expiry when volume rolls to the
// next month. Reuses the shared NFO instruments cache. Nearest expiry first.
export async function getIndexFuturesTokens(name: string = 'NIFTY'): Promise<{ token: number; expiry: string }[]> {
  const kc = getKiteClient();
  if (!kc || !(kc as any).access_token) return [];
  const now = Date.now();
  if (!nfoInstrumentsCache || (now - lastInstrumentsFetch > 24 * 60 * 60 * 1000)) {
    nfoInstrumentsCache = await kc.getInstruments('NFO');
    lastInstrumentsFetch = now;
  }
  const toDateStr = (d: any): string => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
  const today = new Date().toISOString().split('T')[0];
  const futs = (nfoInstrumentsCache || [])
    .filter((i: any) => i.name === name && i.instrument_type === 'FUT' && toDateStr(i.expiry) >= today)
    .map((i: any) => ({ token: Number(i.instrument_token), expiry: toDateStr(i.expiry) }))
    .sort((a: { expiry: string }, b: { expiry: string }) => a.expiry.localeCompare(b.expiry));
  const seen = new Set<string>();
  const out: { token: number; expiry: string }[] = [];
  for (const f of futs) {
    if (!seen.has(f.expiry)) { seen.add(f.expiry); out.push(f); }
    if (out.length >= 2) break;
  }
  return out;
}

let cachedSimulatedChain: any = null;

export async function getLiveOptionChain(spotSymbol = 'NSE:NIFTY 50', forcedSpot?: number, expiry?: string) {
  const kc = getKiteClient();
  
  // Try to determine a default spot if we need one
  let defaultSpot = 22000;
  if (spotSymbol.includes("BANK") || spotSymbol.includes("BANKNIFTY")) {
    defaultSpot = 47500;
  } else if (spotSymbol.includes("RELIANCE")) {
    defaultSpot = 2450;
  } else if (spotSymbol.includes("TCS")) {
    defaultSpot = 3850;
  } else if (spotSymbol.includes("INFY")) {
    defaultSpot = 1450;
  } else if (spotSymbol.includes("NIFTY 50") || spotSymbol.includes("NIFTY")) {
    defaultSpot = 22000;
  } else {
    defaultSpot = forcedSpot || 1000;
  }
  
  const targetSpot = forcedSpot || defaultSpot;

  // Determine the strike spacing/interval
  let strikeInterval = 50;
  if (spotSymbol.includes("BANK") || spotSymbol.includes("BANKNIFTY")) {
    strikeInterval = 100;
  } else if (targetSpot > 10000) {
    strikeInterval = 100;
  } else if (targetSpot > 5000) {
    strikeInterval = 50;
  } else if (targetSpot > 2000) {
    strikeInterval = 20;
  } else if (targetSpot > 1000) {
    strikeInterval = 10;
  } else if (targetSpot > 500) {
    strikeInterval = 5;
  } else if (targetSpot > 100) {
    strikeInterval = 2.5;
  } else {
    strikeInterval = 1;
  }

  // if no client or no access token, we can't fetch real data
  // Using simulated data fallback
  // @ts-ignore
  if (!kc || !kc.access_token) {
    return generateSimulatedChain(targetSpot, 2, strikeInterval, expiry);
  }

  try {
    // 1. Fetch spot price
    const quotes = await kc.getQuote([spotSymbol]);
    const spotPrice = quotes[spotSymbol]?.last_price || targetSpot;
    if (!spotPrice) throw new Error("Could not fetch spot price");

    // 2. Fetch instruments if needed (cache for 1 day)
    const now = Date.now();
    if (!nfoInstrumentsCache || (now - lastInstrumentsFetch > 24 * 60 * 60 * 1000)) {
        nfoInstrumentsCache = await kc.getInstruments('NFO');
        lastInstrumentsFetch = now;
    }

    // Filter for correct symbol options
    const cleanSymbol = spotSymbol.replace("NSE:", "").replace("NFO:", "").trim();
    let nameFilter = cleanSymbol;
    if (cleanSymbol === "NIFTY 50" || cleanSymbol === "NIFTY") {
      nameFilter = "NIFTY";
    } else if (cleanSymbol === "NIFTY BANK" || cleanSymbol === "BANKNIFTY") {
      nameFilter = "BANKNIFTY";
    } else if (cleanSymbol === "FINNIFTY" || cleanSymbol === "NIFTY FIN SERVICE") {
      nameFilter = "FINNIFTY";
    }

    const niftyInstruments = nfoInstrumentsCache!.filter((i: any) => 
        i.name === nameFilter && i.instrument_type !== 'FUT'
    );
    
    const toDateStr = (d: any): string => d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];

    // Sort expiries
    const expiries = Array.from(new Set(niftyInstruments.map((i: any) => toDateStr(i.expiry)))).sort() as string[];
    if (expiries.length === 0) throw new Error(`No expiries found for ${nameFilter}`);
    
    let targetExpiry = expiries[0];
    if (expiry && expiries.includes(expiry)) {
      targetExpiry = expiry;
    }
    
    // Filter for selected expiry and strikes near spot
    const relevantOptions = niftyInstruments.filter((i: any) => 
        toDateStr(i.expiry) === targetExpiry && 
        Math.abs(i.strike - spotPrice) < (nameFilter === 'NIFTY' ? 1500 : nameFilter === 'BANKNIFTY' ? 3000 : spotPrice * 0.1)
    );

    const tradingsymbols = relevantOptions.map((i: any) => `NFO:${i.tradingsymbol}`);
    
    if (tradingsymbols.length === 0) throw new Error("No option symbols found");

    // Fetch quotes in chunks of 500
    let optionQuotes: any = {};
    for (let i = 0; i < tradingsymbols.length; i += 500) {
        const chunk = tradingsymbols.slice(i, i + 500);
        const chunkQuotes = await kc.getQuote(chunk);
        optionQuotes = { ...optionQuotes, ...chunkQuotes };
    }

    const today = new Date().toISOString().split('T')[0];
    const prevOiMap: Record<number, number> = {};
    try {
        const tokens = Object.values(optionQuotes).map((q: any) => q.instrument_token);
        if (tokens.length > 0) {
            // Get previous day OI
            const prevRows = db.prepare(`
                SELECT instrument_token, oi FROM daily_oi 
                WHERE instrument_token IN (${tokens.join(',')}) AND date < ?
                ORDER BY date DESC
            `).all(today) as any[];
            
            const seen = new Set();
            for (let r of prevRows) {
               if (!seen.has(r.instrument_token)) {
                  prevOiMap[r.instrument_token] = r.oi;
                  seen.add(r.instrument_token);
               }
            }

            // Save currently fetched OI
            const insertStmt = db.prepare('INSERT INTO daily_oi (instrument_token, date, oi) VALUES (?, ?, ?) ON CONFLICT(instrument_token, date) DO UPDATE SET oi=excluded.oi');
            const insertMany = db.transaction((items: any[]) => {
                for (const item of items) {
                    if (item.instrument_token && item.oi) {
                        insertStmt.run(item.instrument_token, today, item.oi);
                    }
                }
            });
            insertMany(Object.values(optionQuotes));
        }
    } catch(e) { console.error("OI tracking error", e); }

    // Process and format data
    const strikes = Array.from(new Set(relevantOptions.map((i: any) => Math.round(Number(i.strike))))).sort((a: any, b: any) => a - b);
    
    const ceData: any = {};
    const peData: any = {};

    strikes.forEach((strike: any) => {
        const ceInst = relevantOptions.find((i: any) => Math.round(Number(i.strike)) === strike && i.instrument_type === 'CE');
        const peInst = relevantOptions.find((i: any) => Math.round(Number(i.strike)) === strike && i.instrument_type === 'PE');

        if (ceInst && optionQuotes[`NFO:${ceInst.tradingsymbol}`]) {
            const q = optionQuotes[`NFO:${ceInst.tradingsymbol}`];
            // Only compute OI change against a REAL previous-day baseline. The old
            // fallback (oi_day_low/current oi) fabricated a positive chgOi for every
            // strike, mislabeling the whole chain as SHORT BUILDUP after login.
            const hasOiBaseline = prevOiMap[q.instrument_token] !== undefined;
            const prevOi = hasOiBaseline ? prevOiMap[q.instrument_token] : null;
            ceData[strike] = {
                strikePrice: strike,
                type: 'CE',
                ltp: q.last_price,
                chgLtp: ((q.net_change !== undefined && q.net_change !== 0) ? q.net_change : ((q.ohlc && q.ohlc.close > 0) ? (q.last_price - q.ohlc.close) : 0)),
                oi: q.oi / 100000, // in lakhs
                chgOi: hasOiBaseline ? (q.oi - (prevOi as number)) / 100000 : null, 
                volume: q.volume,
                iv: 15.0, // require black_scholes for real IV
                tradingsymbol: ceInst.tradingsymbol,
                instrument_token: ceInst.instrument_token,
                lot_size: ceInst.lot_size != null ? Number(ceInst.lot_size) : undefined,
                exchange: ceInst.exchange,
                segment: ceInst.segment,
                expiry: ceInst.expiry,
                strike: ceInst.strike,
                option_type: ceInst.instrument_type,
                source_of_lot_size: 'Kite Live Instrument Master'
            };
        }
        if (peInst && optionQuotes[`NFO:${peInst.tradingsymbol}`]) {
            const q = optionQuotes[`NFO:${peInst.tradingsymbol}`];
            const hasOiBaseline = prevOiMap[q.instrument_token] !== undefined;
            const prevOi = hasOiBaseline ? prevOiMap[q.instrument_token] : null;
            peData[strike] = {
                strikePrice: strike,
                type: 'PE',
                ltp: q.last_price,
                chgLtp: ((q.net_change !== undefined && q.net_change !== 0) ? q.net_change : ((q.ohlc && q.ohlc.close > 0) ? (q.last_price - q.ohlc.close) : 0)),
                oi: q.oi / 100000,
                chgOi: hasOiBaseline ? (q.oi - (prevOi as number)) / 100000 : null,
                volume: q.volume,
                iv: 15.0,
                tradingsymbol: peInst.tradingsymbol,
                instrument_token: peInst.instrument_token,
                lot_size: peInst.lot_size != null ? Number(peInst.lot_size) : undefined,
                exchange: peInst.exchange,
                segment: peInst.segment,
                expiry: peInst.expiry,
                strike: peInst.strike,
                option_type: peInst.instrument_type,
                source_of_lot_size: 'Kite Live Instrument Master'
            };
        }
    });

    return { 
        spot: spotPrice, 
        strikes, 
        ceData, 
        peData, 
        expiryDate: targetExpiry,
        expiryDays: Math.max(1, Math.ceil((new Date(targetExpiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24))),
        expiries
    };
  } catch (e) {
    console.error("Error fetching live option chain:", e);
    // Fallback to simulated
    return generateSimulatedChain(targetSpot, 2, strikeInterval, expiry);
  }
}

export async function getKiteReportData() {
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) {
    return {
      live: false,
      trades: [
        { id: "TX-901", symbol: "NIFTY2650722200CE", date: "2026-05-30", type: "SELL", qty: 150, avgPrice: 125, closePrice: 45, pnl: "₹12,000", isProfit: true },
        { id: "TX-902", symbol: "NIFTY2650722100PE", date: "2026-05-29", type: "SELL", qty: 150, avgPrice: 88, closePrice: 102, pnl: "₹-2,100", isProfit: false },
        { id: "TX-903", symbol: "NIFTY2653122300CE", date: "2026-05-28", type: "BUY", qty: 75, avgPrice: 210, closePrice: 285, pnl: "₹5,625", isProfit: true },
        { id: "TX-904", symbol: "NIFTY2653121800PE", date: "2026-05-25", type: "SELL", qty: 150, avgPrice: 62, closePrice: 15, pnl: "₹7,050", isProfit: true },
      ],
      summary: {
        realizedPnl: 22575,
        charges: 1850.50,
        fundAllocation: 450000,
        marginMultiplier: 4.2
      }
    };
  }

  try {
    // Fetch live trades
    const rawTrades = await kc.getTrades();
    const positionsData = await kc.getPositions();
    
    // Default margin checks
    let fundAllocation = 450000;
    try {
      const margins = await kc.getMargins();
      const rawNet = margins?.equity?.net ?? margins?.equity?.available?.cash;
      if (rawNet !== undefined && rawNet !== null) {
        fundAllocation = typeof rawNet === 'number' ? rawNet : parseFloat(String(rawNet));
      }
    } catch (e) {
      console.warn("Could not fetch margins for audit:", e);
    }

    // Map raw trades format from Kite Connect
    const formattedTrades = (rawTrades || []).map((t: any) => {
      const isSell = t.transaction_type === 'SELL';
      return {
        id: t.trade_id || `TX-${Math.floor(100 + Math.random() * 900)}`,
        symbol: t.tradingsymbol,
        date: t.trade_time ? t.trade_time.split(' ')[0] : new Date().toISOString().split('T')[0],
        type: t.transaction_type,
        qty: t.quantity,
        avgPrice: t.price,
        closePrice: t.price, // Same fill price for raw entries
        pnl: "₹0", // Handled downstream or showing single execution value
        isProfit: true
      };
    });

    let realizedPnl = 0;
    if (positionsData && positionsData.net) {
      positionsData.net.forEach((p: any) => {
        realizedPnl += parseFloat(p.realised || "0");
      });
    }

    // Estimate professional transactional brokerages (₹20 per executed order + STT)
    const charges = (rawTrades || []).length * 28.50;

    return {
      live: true,
      trades: formattedTrades.length > 0 ? formattedTrades : [
        { id: "TX-LIVE-EMPTY", symbol: "NO TRADES EXECUTED TODAY", date: new Date().toISOString().split('T')[0], type: "BUY", qty: 0, avgPrice: 0, closePrice: 0, pnl: "₹0", isProfit: true }
      ],
      summary: {
        realizedPnl: realizedPnl || 0,
        charges: charges || 0,
        fundAllocation,
        marginMultiplier: (rawTrades || []).length > 0 ? 3.5 : 1.0
      }
    };
  } catch (error: any) {
    console.error("Error making reports data from authenticated Kite Client:", error);
    // Fallback on error (e.g. invalid session token)
    return {
      live: false,
      error: error.message || "Session error",
      trades: [],
      summary: { realizedPnl: 0, charges: 0, fundAllocation: 450000, marginMultiplier: 1.0 }
    };
  }
}
