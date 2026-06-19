import { getKiteClient } from './kite_service';
import { runRsiBacktest } from './rsi_backtest';

// Wilder's RSI (same as the index engine / the chart)
function wilderRSI(closes: number[], period = 14): (number | null)[] {
  const rsi: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

const fmtDate = (d: Date): string => d.toISOString().slice(0, 10);
const toDateStr = (d: any): string => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
const dayGap = (a: string, b: string) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);

// NFO instrument cache (current/active contracts only — expired weeklies are not present)
let nfoCache: any[] | null = null; let nfoAt = 0;
async function getNfo(kc: any): Promise<any[]> {
  const now = Date.now();
  if (!nfoCache || now - nfoAt > 6 * 60 * 60 * 1000) { nfoCache = await kc.getInstruments('NFO'); nfoAt = now; }
  return nfoCache || [];
}

// Resolve the ATM NIFTY option for a given strike/type, using the nearest weekly expiry on/after refDate.
// Returns null if that (same-week) expiry is no longer listed — i.e. it has expired.
function resolveOption(instruments: any[], strike: number, type: 'CE' | 'PE', refDateStr: string) {
  const list = instruments.filter((i: any) => i.name === 'NIFTY' && i.instrument_type === type);
  const expiries = Array.from(new Set(list.map((i: any) => toDateStr(i.expiry)))).sort() as string[];
  const expiry = expiries.find((e) => e >= refDateStr);
  if (!expiry) return null;
  // ATM weekly buys sit within ~a week; a far expiry means the real one already expired → treat as no data
  if (dayGap(expiry, refDateStr) > 9) return null;
  const inst = list.find((i: any) => toDateStr(i.expiry) === expiry && Math.round(Number(i.strike)) === strike);
  return inst ? { token: inst.instrument_token, tradingsymbol: inst.tradingsymbol, expiry } : null;
}

async function fetchOptCandles(kc: any, token: number, fromStr: string, toStr: string): Promise<any[]> {
  try { return (await kc.getHistoricalData(token, '5minute', fromStr, toStr)) || []; } catch { return []; }
}

// Lightweight current index-signal read (most recent entry trigger over recent candles)
function detectIndexSignal(candles: any[], period = 14, obLow = 60, osHigh = 40, deepOb = 70, deepOs = 30) {
  const closes = candles.map((c) => c.close);
  const rsi = wilderRSI(closes, period);
  const dayOf = (c: any) => String(c.date).slice(0, 10);
  let flatPeak = -Infinity, flatTrough = Infinity;
  let last: { dir: 'LONG' | 'SHORT'; idx: number; rsi: number } | null = null;
  for (let i = period + 1; i < candles.length; i++) {
    if (rsi[i] == null || rsi[i - 1] == null) continue;
    const r = rsi[i] as number, rp = rsi[i - 1] as number;
    if (dayOf(candles[i]) !== dayOf(candles[i - 1])) { flatPeak = r; flatTrough = r; }
    flatPeak = Math.max(flatPeak, r); flatTrough = Math.min(flatTrough, r);
    if (flatPeak >= deepOb && rp >= obLow && r < obLow) { last = { dir: 'SHORT', idx: i, rsi: r }; flatPeak = r; flatTrough = r; }
    else if (flatTrough <= deepOs && rp <= osHigh && r > osHigh) { last = { dir: 'LONG', idx: i, rsi: r }; flatPeak = r; flatTrough = r; }
  }
  const lastIdx = candles.length - 1;
  const cur = rsi[lastIdx];
  return {
    currentRsi: cur != null ? +cur.toFixed(1) : null,
    lastSignal: last ? { dir: last.dir, rsi: +last.rsi.toFixed(1), barsAgo: lastIdx - last.idx, time: String(candles[last.idx].date) } : null,
    firedOnLast: !!last && last.idx === lastIdx,
  };
}

// ---- LIVE: index signal + ATM CE & PE confirmation ----
export async function getLiveSignal(threshold = 40) {
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) return { success: false, error: 'Not logged in to Kite.' };

  // recent index candles
  const from = fmtDate(new Date(Date.now() - 4 * 86400000));
  const to = fmtDate(new Date(Date.now() + 86400000));
  let idxCandles: any[] = [];
  try { idxCandles = (await kc.getHistoricalData(256265, '5minute', from, to)) || []; } catch (e: any) { return { success: false, error: e?.message || 'Index history failed' }; }
  if (!idxCandles.length) return { success: false, error: 'No index candles (market hours?)' };
  const idx = detectIndexSignal(idxCandles);
  const spot = idxCandles[idxCandles.length - 1].close;
  const strike = Math.round(spot / 50) * 50;

  const instruments = await getNfo(kc);
  const today = fmtDate(new Date());

  const oneSide = async (type: 'CE' | 'PE') => {
    const res = resolveOption(instruments, strike, type, today);
    if (!res) return { type, available: false as const };
    const cs = await fetchOptCandles(kc, res.token, fmtDate(new Date(Date.now() - 5 * 86400000)), to);
    if (cs.length < 16) return { type, available: false as const, tradingsymbol: res.tradingsymbol };
    const r = wilderRSI(cs.map((c) => c.close), 14);
    const li = r.length - 1;
    const rv = r[li];
    return {
      type, available: true as const, tradingsymbol: res.tradingsymbol, expiry: res.expiry, strike,
      ltp: cs[li].close, time: String(cs[li].date),
      rsi: rv != null ? +rv.toFixed(1) : null,
      confirms: rv != null && rv > threshold,
    };
  };

  const [ce, pe] = await Promise.all([oneSide('CE'), oneSide('PE')]);
  return { success: true, asOf: Date.now(), spot, strike, threshold, index: idx, ce, pe };
}

// ---- BACKTEST: recent window only, add option-RSI confirmation + real option P&L ----
export async function runOptionConfirmBacktest(opts: { optionDays?: number; deepOb?: number; deepOs?: number; threshold?: number }) {
  const optionDays = Math.min(Math.max(opts.optionDays || 12, 3), 25);
  const threshold = opts.threshold ?? 40;
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) return { success: false, error: 'Not logged in to Kite.' };

  const base = await runRsiBacktest({ days: optionDays, deepOb: opts.deepOb ?? 70, deepOs: opts.deepOs ?? 30 });
  if (!('success' in base) || !base.success) return base;
  const allTrades = (base as any).trades as any[];
  const instruments = await getNfo(kc);
  const cache = new Map<number, any[]>();

  const findAt = (cs: any[], iso: string) => {
    const t = new Date(iso).getTime();
    let best: any = null;
    for (const c of cs) { const ct = new Date(c.date).getTime(); if (ct <= t) best = c; else break; }
    return best;
  };

  const signals: any[] = [];
  for (const tr of allTrades) {
    const type: 'CE' | 'PE' = tr.dir === 'LONG' ? 'CE' : 'PE';
    const strike = Math.round(tr.entryPrice / 50) * 50;
    const refDate = toDateStr(tr.entryTime);
    const res = resolveOption(instruments, strike, type, refDate);
    if (!res) { signals.push({ ...sigBase(tr, type, strike), available: false }); continue; }

    let cs = cache.get(res.token) || null;
    if (!cs) {
      cs = await fetchOptCandles(kc, res.token, fmtDate(new Date(Date.now() - (optionDays + 6) * 86400000)), fmtDate(new Date(Date.now() + 86400000)));
      cache.set(res.token, cs);
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!cs.length) { signals.push({ ...sigBase(tr, type, strike), tradingsymbol: res.tradingsymbol, available: false }); continue; }

    const rsiArr = wilderRSI(cs.map((c) => c.close), 14);
    const idxByTime = (iso: string) => { const t = new Date(iso).getTime(); let bi = -1; for (let i = 0; i < cs!.length; i++) { if (new Date(cs![i].date).getTime() <= t) bi = i; else break; } return bi; };
    const eIdx = idxByTime(tr.entryTime);
    const xIdx = idxByTime(tr.exitTime);
    if (eIdx < 0 || xIdx < 0) { signals.push({ ...sigBase(tr, type, strike), tradingsymbol: res.tradingsymbol, available: false }); continue; }
    const optRsi = rsiArr[eIdx];
    const optEntry = cs[eIdx].close;
    const optExit = cs[xIdx].close;
    const optPnl = +(optExit - optEntry).toFixed(2); // we BUY the option
    signals.push({
      ...sigBase(tr, type, strike), tradingsymbol: res.tradingsymbol, expiry: res.expiry, available: true,
      optRsi: optRsi != null ? +optRsi.toFixed(1) : null,
      confirms: optRsi != null && optRsi > threshold,
      optEntry: +optEntry.toFixed(2), optExit: +optExit.toFixed(2), optPnl,
    });
  }

  // aggregate over confirmed (and option data available)
  const withData = signals.filter((s) => s.available);
  const confirmed = withData.filter((s) => s.confirms);
  const rejected = withData.filter((s) => !s.confirms);
  const cp = confirmed.map((s) => s.optPnl);
  const wins = cp.filter((p) => p > 0).length;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

  return {
    success: true,
    optionDays, threshold,
    period: { from: (base as any).from, to: (base as any).to },
    totals: {
      indexSignals: signals.length,
      withOptionData: withData.length,
      noOptionData: signals.length - withData.length,
      confirmed: confirmed.length,
      rejected: rejected.length,
    },
    confirmedOptionStats: confirmed.length ? {
      trades: confirmed.length,
      winRate: +((wins / confirmed.length) * 100).toFixed(1),
      totalOptionPts: +sum(cp).toFixed(2),
      avgOptionPts: +(sum(cp) / confirmed.length).toFixed(2),
      best: +Math.max(...cp).toFixed(2),
      worst: +Math.min(...cp).toFixed(2),
    } : null,
    signals: signals.slice(-120),
  };
}

function sigBase(tr: any, type: 'CE' | 'PE', strike: number) {
  return { entryTime: tr.entryTime, exitTime: tr.exitTime, dir: tr.dir, type, strike, indexPnl: tr.pnl, indexReason: tr.reason };
}
