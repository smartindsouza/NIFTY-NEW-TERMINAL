// DHAN AS A STAND-IN FOR ZERODHA (11 Nov 2026) — step 2 of the broker move.
//
// The app calls ~15 Zerodha client functions from dozens of places (charts,
// indicators, bias note, guard, watchers, auto-trader). Rewriting each caller
// would touch everything at once. Instead this object answers those SAME calls
// from Dhan, in Zerodha's shapes, so callers do not change:
//   getInstruments  — Dhan's instrument list, rows shaped like Kite's, with
//                     Kite-style trading symbols (NIFTY26N1725300CE weekly,
//                     NIFTY26NOV25300CE monthly, NIFTY26NOVFUT) so the journal,
//                     symbol parsing and history stay continuous.
//   getQuote/getLTP — Dhan market quote, keyed exactly as asked ("NSE:NIFTY 50",
//                     "NFO:<symbol>" or a token).
//   getHistoricalData — Dhan intraday/daily candles; 3/10/30-min built from 1/5/15.
//   getPositions/getOrders/getOrderHistory/getTrades/getMargins — read-only maps.
//   placeOrder/cancelOrder/orderMargins — step 3, OFF until tested with Martin
//                     (setting `orders_enabled` in dhan_kv).
//
// TOKENS. Zerodha's well-known index tokens are kept (256265 NIFTY 50, 260105
// NIFTY BANK, …) because the code hardcodes them. Every other Dhan instrument
// gets token = (segment code + 1) × 100,000,000 + Dhan security id — above any
// Zerodha token, so the two can never collide, and reversible.
//
// NOT ON DHAN: GIFT NIFTY (NSE IX) and Kite's GLOBAL indices (US30, HANGSENG…).
// Those return nothing here; callers already treat them as optional.

import axios from 'axios';
import { dhanCall, dhanConfigured } from './dhan_service';

export const SEG: Record<string, number> = { IDX_I: 0, NSE_EQ: 1, NSE_FNO: 2, NSE_CURRENCY: 3, BSE_EQ: 4, MCX_COMM: 5, BSE_CURRENCY: 7, BSE_FNO: 8 };
export const SEG_NAME: Record<number, string> = Object.fromEntries(Object.entries(SEG).map(([k, v]) => [v, k]));

// Zerodha index tokens the app hardcodes ↔ Dhan IDX_I security ids.
const KITE_INDEX: Record<string, { token: number; sym: string; exch: 'NSE' | 'BSE' }> = {
  '13': { token: 256265, sym: 'NIFTY 50', exch: 'NSE' },
  '25': { token: 260105, sym: 'NIFTY BANK', exch: 'NSE' },
  '27': { token: 257801, sym: 'NIFTY FIN SERVICE', exch: 'NSE' },
  '21': { token: 264969, sym: 'INDIA VIX', exch: 'NSE' },
  '442': { token: 288009, sym: 'NIFTY MID SELECT', exch: 'NSE' },
  '51': { token: 265, sym: 'SENSEX', exch: 'BSE' },
  '69': { token: 274441, sym: 'BANKEX', exch: 'BSE' },
};
// Dhan index names → the names Zerodha uses (sidebar, chart list, quotes).
const KITE_INDEX_NAME: Record<string, string> = {
  NIFTYIT: 'NIFTY IT', NIFTYINFRA: 'NIFTY INFRA', NIFTYNXT50: 'NIFTY NEXT 50', 'NIFTY MID100 FREE': 'NIFTY MIDCAP 100',
  'NIFTY SMALLCAP 100': 'NIFTY SMLCAP 100', NIFTYPSE: 'NIFTY PSE', NIFTYCPSE: 'NIFTY CPSE', NIFTYMCAP50: 'NIFTY MIDCAP 50',
};
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WK = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'O', 'N', 'D'];

export const encodeToken = (seg: number, id: number) => (seg + 1) * 100_000_000 + id;
export function decodeToken(token: number): { seg: number; id: number } | null {
  const k = Object.entries(KITE_INDEX).find(([, v]) => v.token === token);
  if (k) return { seg: 0, id: Number(k[0]) };
  if (token < 100_000_000) return null;
  return { seg: Math.floor(token / 100_000_000) - 1, id: token % 100_000_000 };
}

// Kite-style derivative symbol from the contract's fields.
export function kiteSymbol(under: string, expiry: string, strike: number, type: string, monthly: boolean): string {
  const [y, m, d] = expiry.split('-').map(Number);
  const yy = String(y).slice(2);
  if (type === 'FUT') return `${under}${yy}${MON[m - 1]}FUT`;
  const k = Number.isInteger(strike) ? String(strike) : String(strike);
  return monthly ? `${under}${yy}${MON[m - 1]}${k}${type}` : `${under}${yy}${WK[m - 1]}${String(d).padStart(2, '0')}${k}${type}`;
}

// ---------------------------------------------------------------- instruments
type Row = any;
let rows: Row[] = [];
let byKey = new Map<string, Row>();      // "NFO:NIFTY26N1725300CE" → row
let byToken = new Map<number, Row>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}

export function buildRows(csv: string): Row[] {
  const lines = csv.split(/\r?\n/);
  const H = parseCsvLine(lines[0]); const ix = (n: string) => H.indexOf(n);
  const c = { ex: ix('EXCH_ID'), seg: ix('SEGMENT'), id: ix('SECURITY_ID'), inst: ix('INSTRUMENT'), under: ix('UNDERLYING_SYMBOL'), sym: ix('SYMBOL_NAME'),
    disp: ix('DISPLAY_NAME'), lot: ix('LOT_SIZE'), exp: ix('SM_EXPIRY_DATE'), strike: ix('STRIKE_PRICE'), opt: ix('OPTION_TYPE'), tick: ix('TICK_SIZE'), flag: ix('EXPIRY_FLAG'), series: ix('SERIES') };
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = parseCsvLine(lines[i]);
    const ex = f[c.ex], sg = f[c.seg], inst = f[c.inst], id = Number(f[c.id]);
    const exp = (f[c.exp] || '').slice(0, 10);
    let seg: number, kexch: string, ksegment: string, itype: string, tsym: string, name: string;
    const tick = (Number(f[c.tick]) || 5) / 100;          // Dhan states tick size in paise
    const lot = Number(f[c.lot]) || 1;
    if (sg === 'I' && inst === 'INDEX' && (ex === 'NSE' || ex === 'BSE')) {
      seg = SEG.IDX_I; const k = KITE_INDEX[String(id)];
      tsym = k ? k.sym : (KITE_INDEX_NAME[f[c.sym]] || f[c.sym]); kexch = k ? k.exch : ex; ksegment = 'INDICES'; itype = 'EQ'; name = tsym;
      out.push({ instrument_token: k ? k.token : encodeToken(seg, id), exchange_token: id, tradingsymbol: tsym, name, last_price: 0, expiry: '', strike: 0,
        tick_size: 0.05, lot_size: 0, instrument_type: itype, segment: ksegment, exchange: kexch, _seg: seg, _id: id });
      continue;
    }
    if (exp && exp < today) continue;                                   // expired contracts are not tradeable
    if (sg === 'D' && (inst === 'OPTIDX' || inst === 'FUTIDX') && (ex === 'NSE' || ex === 'BSE')) {
      seg = ex === 'NSE' ? SEG.NSE_FNO : SEG.BSE_FNO; kexch = ex === 'NSE' ? 'NFO' : 'BFO';
      const under = f[c.under]; const fut = inst === 'FUTIDX';
      itype = fut ? 'FUT' : f[c.opt]; if (!fut && itype !== 'CE' && itype !== 'PE') continue;
      const strike = fut ? 0 : Number(f[c.strike]);
      tsym = kiteSymbol(under, exp, strike, itype, f[c.flag] === 'M');
      ksegment = `${kexch}-${fut ? 'FUT' : 'OPT'}`; name = under;
    } else if (sg === 'M' && inst === 'FUTCOM' && ex === 'MCX') {
      seg = SEG.MCX_COMM; kexch = 'MCX'; itype = 'FUT'; name = f[c.under] || f[c.sym];
      tsym = kiteSymbol(name, exp, 0, 'FUT', true); ksegment = 'MCX-FUT';
    } else if (sg === 'E' && inst === 'EQUITY' && ex === 'NSE' && f[c.series] === 'EQ') {   // shares only — not NCDs/warrants
      seg = SEG.NSE_EQ; kexch = 'NSE'; itype = 'EQ'; ksegment = 'NSE'; tsym = f[c.under] || f[c.sym]; name = f[c.disp] || tsym;
    } else continue;
    out.push({ instrument_token: encodeToken(seg, id), exchange_token: id, tradingsymbol: tsym, name, last_price: 0,
      expiry: exp ? new Date(exp) : '', strike: Number(f[c.strike]) > 0 ? Number(f[c.strike]) : 0, tick_size: tick, lot_size: lot,
      instrument_type: itype, segment: ksegment, exchange: kexch, _seg: seg, _id: id });
  }
  return out;
}

export async function ensureInstruments(): Promise<void> {
  if (rows.length && Date.now() - loadedAt < 12 * 3600e3) return;
  if (!loading) loading = (async () => {
    const r = await axios.get('https://images.dhan.co/api-data/api-scrip-master-detailed.csv', { timeout: 120000, responseType: 'text', maxContentLength: 200e6 });
    const built = buildRows(String(r.data));
    if (built.length < 1000) throw new Error(`Dhan instrument list looks wrong (${built.length} rows)`);
    rows = built; loadedAt = Date.now();
    byKey = new Map(rows.map(x => [`${x.exchange}:${x.tradingsymbol}`, x]));
    byToken = new Map(rows.map(x => [x.instrument_token, x]));
    console.log(`[dhan] instruments loaded: ${rows.length}`);
  })().finally(() => { loading = null; });
  return loading;
}
export const instrumentByToken = (t: number) => byToken.get(t);
export const instrumentByKey = (k: string) => byKey.get(k);

function resolve(key: string | number): Row | null {
  if (typeof key === 'number' || /^\d+$/.test(String(key))) return byToken.get(Number(key)) || null;
  return byKey.get(String(key)) || null;
}

// ---------------------------------------------------------------- pacing
// Dhan market-quote APIs allow 1 request/second; history a few per second.
function pacer(gapMs: number) {
  let last = 0, chain: Promise<any> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => { const w = last + gapMs - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); last = Date.now(); return fn(); });
    chain = run.catch(() => { }); return run;
  };
}
const quotePace = pacer(1050);
const histPace = pacer(260);

async function marketfeed(kind: 'quote' | 'ltp', keys: (string | number)[]) {
  await ensureInstruments();
  const want: Record<string, number[]> = {}; const back = new Map<string, string>();
  for (const k of keys) {
    const r = resolve(k); if (!r) continue;
    const s = SEG_NAME[r._seg]; (want[s] = want[s] || []).push(r._id); back.set(`${s}:${r._id}`, String(k));
  }
  const out: Record<string, any> = {};
  if (!Object.keys(want).length) return out;
  const res = await quotePace(() => dhanCall('POST', `/marketfeed/${kind}`, want));
  const data = res?.data || {};
  for (const [s, m] of Object.entries<any>(data)) for (const [id, q] of Object.entries<any>(m || {})) {
    const key = back.get(`${s}:${id}`); if (!key) continue;
    const row = resolve(key)!;
    out[key] = kind === 'ltp' ? { instrument_token: row.instrument_token, last_price: q.last_price }
      : { instrument_token: row.instrument_token, last_price: q.last_price, ohlc: q.ohlc, volume: q.volume, oi: q.oi, oi_day_high: q.oi_day_high, oi_day_low: q.oi_day_low,
          net_change: q.net_change, average_price: q.average_price, buy_quantity: q.buy_quantity, sell_quantity: q.sell_quantity, last_quantity: q.last_quantity,
          lower_circuit_limit: q.lower_circuit_limit, upper_circuit_limit: q.upper_circuit_limit, depth: q.depth, timestamp: new Date(), last_trade_time: q.last_trade_time };
  }
  return out;
}

// ---------------------------------------------------------------- candles
const IST = 5.5 * 3600e3;
const istStr = (ms: number) => new Date(ms + IST).toISOString().slice(0, 19).replace('T', ' ');
const parseWhen = (v: any): number => v instanceof Date ? v.getTime() : /^\d{4}-\d{2}-\d{2}( |T)\d{2}:\d{2}/.test(String(v)) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(v)) ? Date.parse(String(v).replace(' ', 'T') + '+05:30') : Date.parse(String(v));

// Dhan's epoch is checked once against the session open: NSE candles must start
// at 09:15 IST. If they start at "09:15 UTC" the feed is IST-shifted and we
// correct it. (Measured, not assumed — see /api/dhan/test.)
let epochShift: number | null = null;
function fixShift(ts: number[], seg: number) {
  if (epochShift !== null || !ts.length || seg === SEG.MCX_COMM) return;
  const first = new Date(ts[0] * 1000); const m = first.getUTCHours() * 60 + first.getUTCMinutes();
  if (m === 9 * 60 + 15) epochShift = -IST; else if (m === 3 * 60 + 45) epochShift = 0;
}

function instrumentFor(row: Row): string {
  if (row._seg === SEG.IDX_I) return 'INDEX';
  if (row._seg === SEG.NSE_EQ) return 'EQUITY';
  if (row._seg === SEG.MCX_COMM) return 'FUTCOM';
  return row.instrument_type === 'FUT' ? 'FUTIDX' : 'OPTIDX';
}

function agg(c: any[], minutes: number, anchorMin: number) {
  const out: any[] = []; let cur: any = null, key = -1;
  for (const k of c) {
    const t = k.date.getTime(); const dayStart = Math.floor((t + IST) / 86400e3) * 86400e3 - IST;
    const b = Math.floor((t - dayStart - anchorMin * 60e3) / (minutes * 60e3));
    const kk = dayStart + b;
    if (!cur || kk !== key) { if (cur) out.push(cur); cur = { ...k, date: new Date(dayStart + anchorMin * 60e3 + b * minutes * 60e3) }; key = kk; }
    else { cur.high = Math.max(cur.high, k.high); cur.low = Math.min(cur.low, k.low); cur.close = k.close; cur.volume += k.volume; cur.oi = k.oi; }
  }
  if (cur) out.push(cur); return out;
}

async function historical(token: number, interval: string, from: any, to: any, _continuous?: boolean, oi?: boolean) {
  await ensureInstruments();
  const row = byToken.get(Number(token));
  if (!row) throw new Error(`Dhan: no instrument for token ${token}`);
  const base: Record<string, [number, number]> = { minute: [1, 1], '3minute': [1, 3], '5minute': [5, 5], '10minute': [5, 10], '15minute': [15, 15], '30minute': [15, 30], '60minute': [60, 60] };
  const f = parseWhen(from), t = parseWhen(to);
  const req = { securityId: String(row._id), exchangeSegment: SEG_NAME[row._seg], instrument: instrumentFor(row), oi: !!oi && row._seg !== SEG.IDX_I };
  const cand: any[] = [];
  const push = (d: any) => {
    const ts: number[] = d?.timestamp || [];
    fixShift(ts, row._seg);
    for (let i = 0; i < ts.length; i++) cand.push({ date: new Date(ts[i] * 1000 + (epochShift || 0)), open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i], volume: d.volume?.[i] || 0, oi: d.open_interest?.[i] || 0 });
  };
  if (interval === 'day') {
    const d = await histPace(() => dhanCall('POST', '/charts/historical', { ...req, expiryCode: 0, fromDate: istStr(f).slice(0, 10), toDate: istStr(t + 86400e3).slice(0, 10) }));
    push(d);
  } else {
    const [bi, want] = base[interval] || [5, 5];
    for (let s = f; s < t; s += 89 * 86400e3) {
      const e = Math.min(t, s + 89 * 86400e3);
      const d = await histPace(() => dhanCall('POST', '/charts/intraday', { ...req, interval: String(bi), fromDate: istStr(s), toDate: istStr(e + 60e3) }));
      push(d);
    }
    cand.sort((a, b) => a.date - b.date);
    const uniq = cand.filter((x, i) => i === 0 || x.date.getTime() !== cand[i - 1].date.getTime());
    // Dhan prints a post-close value (seen at 19:50 IST on 11 Nov) as an extra
    // candle; Zerodha never did. Index/equity candles outside 09:00–15:30 are
    // dropped. F&O now trades until 15:40 (the closing auction runs in cash), so
    // derivative candles are kept to 15:40. MCX keeps its evening session.
    const endMin = row._seg === SEG.NSE_FNO || row._seg === SEG.BSE_FNO ? 15 * 60 + 40 : 15 * 60 + 30;
    const inSession = (x: any) => { if (row._seg === SEG.MCX_COMM) return true; const m = Math.floor(((x.date.getTime() + IST) % 86400e3) / 60e3); return m >= 9 * 60 && m < endMin; };
    const inRange = uniq.filter(x => x.date.getTime() >= f && x.date.getTime() <= t && inSession(x));
    return want === bi ? inRange : agg(inRange, want, row._seg === SEG.MCX_COMM ? 9 * 60 : 9 * 60 + 15);
  }
  return cand.sort((a, b) => a.date - b.date);
}

// ---------------------------------------------------------------- account (read-only)
const PROD_IN: Record<string, string> = { INTRADAY: 'MIS', MARGIN: 'NRML', CNC: 'CNC', CO: 'CO', BO: 'BO', MTF: 'MTF' };
const STATUS_IN: Record<string, string> = { TRADED: 'COMPLETE', PENDING: 'OPEN', TRANSIT: 'OPEN', PART_TRADED: 'OPEN', CANCELLED: 'CANCELLED', REJECTED: 'REJECTED', EXPIRED: 'CANCELLED', TRIGGERED: 'OPEN' };
const symFor = (seg: string, id: any, fallback: string) => byToken.get(encodeToken(SEG[seg], Number(id)))?.tradingsymbol
  || (seg === 'IDX_I' && KITE_INDEX[String(id)]?.sym) || fallback;
const exchFor = (seg: string) => ({ NSE_FNO: 'NFO', BSE_FNO: 'BFO', NSE_EQ: 'NSE', BSE_EQ: 'BSE', MCX_COMM: 'MCX', IDX_I: 'NSE' } as any)[seg] || seg;

async function positions() {
  await ensureInstruments();
  const list: any[] = (await dhanCall('GET', '/positions')) || [];
  const net = list.map(p => {
    const qty = Number(p.netQty) || 0;
    const buyV = Number(p.dayBuyValue ?? (p.buyAvg * p.buyQty)) || 0, sellV = Number(p.daySellValue ?? (p.sellAvg * p.sellQty)) || 0;
    const unreal = Number(p.unrealizedProfit) || 0, real = Number(p.realizedProfit) || 0;
    const ltp = qty ? (Number(p.costPrice) || 0) + unreal / qty : 0;
    return { tradingsymbol: symFor(p.exchangeSegment, p.securityId, p.tradingSymbol), exchange: exchFor(p.exchangeSegment),
      instrument_token: encodeToken(SEG[p.exchangeSegment], Number(p.securityId)), product: PROD_IN[p.productType] || p.productType,
      quantity: qty, average_price: qty >= 0 ? Number(p.buyAvg) || 0 : Number(p.sellAvg) || 0, last_price: Math.round(ltp * 100) / 100,
      pnl: real + unreal, realised: real, unrealised: unreal, buy_quantity: Number(p.buyQty) || 0, sell_quantity: Number(p.sellQty) || 0,
      buy_price: Number(p.buyAvg) || 0, sell_price: Number(p.sellAvg) || 0, buy_value: buyV, sell_value: sellV, multiplier: Number(p.multiplier) || 1,
      day_buy_quantity: Number(p.dayBuyQty) || 0, day_sell_quantity: Number(p.daySellQty) || 0, day_buy_value: buyV, day_sell_value: sellV, _dhan: { securityId: p.securityId, exchangeSegment: p.exchangeSegment } };
  });
  return { net, day: net };
}
function orderOut(o: any) {
  return { order_id: String(o.orderId), status: STATUS_IN[o.orderStatus] || o.orderStatus, status_message: o.omsErrorDescription || null,
    tradingsymbol: symFor(o.exchangeSegment, o.securityId, o.tradingSymbol), exchange: exchFor(o.exchangeSegment),
    instrument_token: encodeToken(SEG[o.exchangeSegment], Number(o.securityId)), transaction_type: o.transactionType,
    order_type: ({ STOP_LOSS: 'SL', STOP_LOSS_MARKET: 'SL-M' } as any)[o.orderType] || o.orderType, product: PROD_IN[o.productType] || o.productType,
    quantity: Number(o.quantity) || 0, filled_quantity: Number(o.filledQty) || 0, pending_quantity: Number(o.remainingQuantity) || 0,
    price: Number(o.price) || 0, trigger_price: Number(o.triggerPrice) || 0, average_price: Number(o.averageTradedPrice) || 0,
    order_timestamp: o.createTime, exchange_timestamp: o.exchangeTime, tag: o.correlationId || null };
}
async function orders() { await ensureInstruments(); return ((await dhanCall('GET', '/orders')) || []).map(orderOut); }
async function orderHistory(id: string) { await ensureInstruments(); const o = await dhanCall('GET', `/orders/${encodeURIComponent(id)}`); return (Array.isArray(o) ? o : [o]).map(orderOut); }
async function trades() {
  await ensureInstruments();
  return ((await dhanCall('GET', '/trades')) || []).map((t: any) => ({ order_id: String(t.orderId), trade_id: String(t.exchangeTradeId || ''),
    tradingsymbol: symFor(t.exchangeSegment, t.securityId, t.tradingSymbol), exchange: exchFor(t.exchangeSegment), transaction_type: t.transactionType,
    product: PROD_IN[t.productType] || t.productType, quantity: Number(t.tradedQuantity) || 0, average_price: Number(t.tradedPrice) || 0,
    fill_timestamp: t.exchangeTime, order_timestamp: t.createTime }));
}
async function margins() {
  const f = await dhanCall('GET', '/fundlimit');
  const avail = Number(f.availabelBalance ?? f.availableBalance) || 0;
  return { equity: { enabled: true, net: avail, available: { cash: Number(f.sodLimit) || avail, live_balance: avail, opening_balance: Number(f.sodLimit) || 0, collateral: Number(f.collateralAmount) || 0 },
    utilised: { debits: Number(f.utilizedAmount) || 0 } }, commodity: { enabled: false, net: 0 }, _dhan: f };
}

// ---------------------------------------------------------------- the stand-in
export function makeDhanKite(opts: { ordersEnabled: () => boolean; placeOrder?: (p: any) => Promise<any>; cancelOrder?: (id: string) => Promise<any> }) {
  const notYet = (what: string) => async () => { throw new Error(`${what} through Dhan is not switched on yet (step 3 of the move — tested with you first).`); };
  return {
    broker: 'dhan',
    get access_token() { return dhanConfigured() ? 'dhan' : null; },
    setAccessToken() { }, generateSession: notYet('Zerodha login'),
    getInstruments: async (exchange?: string) => { await ensureInstruments(); return exchange ? rows.filter(r => r.exchange === exchange) : rows; },
    getQuote: (keys: any) => marketfeed('quote', ([] as any[]).concat(keys)),
    getLTP: (keys: any) => marketfeed('ltp', ([] as any[]).concat(keys)),
    getOHLC: (keys: any) => marketfeed('quote', ([] as any[]).concat(keys)),
    getHistoricalData: historical,
    getPositions: positions, getOrders: orders, getOrderHistory: orderHistory, getTrades: trades, getMargins: margins,
    placeOrder: async (variety: any, p: any) => { if (!opts.ordersEnabled() || !opts.placeOrder) return notYet('Placing orders')(); return opts.placeOrder({ variety, ...p }); },
    cancelOrder: async (_v: any, id: string) => { if (!opts.ordersEnabled() || !opts.cancelOrder) return notYet('Cancelling orders')(); return opts.cancelOrder(id); },
    orderMargins: async () => [],
  };
}
