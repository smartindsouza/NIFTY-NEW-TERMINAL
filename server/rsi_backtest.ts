import { getKiteClient } from './kite_service';

// Wilder's RSI (matches the chart's live RSI), returns one value per candle (null until warmed up)
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

const fmtDate = (d: Date): string => d.toISOString().slice(0, 10); // yyyy-mm-dd

// Fetch historical 5-minute NIFTY index candles, chunked to respect Kite's ~100-day/request limit.
async function fetchCandles(days: number): Promise<any[]> {
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) throw new Error('NOT_LOGGED_IN');
  const token = 256265; // NIFTY 50 index
  const all: any[] = [];
  let remaining = days;
  let to = new Date(Date.now() + 24 * 60 * 60 * 1000); // include today
  const CHUNK = 90;
  while (remaining > 0) {
    const span = Math.min(remaining, CHUNK);
    const from = new Date(to.getTime() - span * 24 * 60 * 60 * 1000);
    try {
      const hist = await kc.getHistoricalData(token, '5minute' as any, fmtDate(from), fmtDate(to));
      if (hist && hist.length) all.push(...hist);
    } catch (e) { /* skip a failed chunk, keep going */ }
    to = new Date(from.getTime() - 24 * 60 * 60 * 1000);
    remaining -= span;
    await new Promise((r) => setTimeout(r, 350)); // be gentle on the API
  }
  // de-dupe by timestamp and sort ascending
  const map = new Map<string, any>();
  for (const c of all) map.set(String(c.date), c);
  return Array.from(map.values()).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

export interface RsiBacktestOpts {
  days?: number; rsiPeriod?: number;
  obLow?: number; obHigh?: number; osLow?: number; osHigh?: number;
  deepOb?: number; deepOs?: number;
}

export async function runRsiBacktest(opts: RsiBacktestOpts) {
  const days = Math.min(Math.max(opts.days || 60, 5), 180);
  const period = opts.rsiPeriod || 14;
  const obLow = opts.obLow ?? 60, obHigh = opts.obHigh ?? 65;
  const osLow = opts.osLow ?? 38, osHigh = opts.osHigh ?? 40;
  // "Deep" penetration required to qualify a setup — filters out shallow bounces off the zone edge.
  const deepOb = opts.deepOb ?? 70; // short only if RSI first reached at least this (deep overbought)
  const deepOs = opts.deepOs ?? 30; // long only if RSI first reached at most this (deep oversold)

  let candles: any[];
  try {
    candles = await fetchCandles(days);
  } catch (e: any) {
    if (e?.message === 'NOT_LOGGED_IN') return { success: false, error: 'Not logged in to Kite — historical data needs an active Kite session.' };
    return { success: false, error: e?.message || String(e) };
  }
  if (!candles.length) return { success: false, error: 'No historical candles returned. Try again during/after market hours.' };

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const rsi = wilderRSI(closes, period);
  const dayOf = (c: any) => String(c.date).slice(0, 10);

  interface Trade {
    dir: 'LONG' | 'SHORT'; entryTime: string; entryPrice: number; entryRsi: number;
    exitTime: string; exitPrice: number; exitRsi: number; reason: string;
    pnl: number; bars: number; mae: number; mfe: number; stop: number;
  }
  const trades: Trade[] = [];
  let pos: any = null;
  let flatPeak = -Infinity, flatTrough = Infinity; // RSI extremes while flat (to confirm it was truly OB/OS)

  for (let i = period + 1; i < candles.length; i++) {
    if (rsi[i] == null || rsi[i - 1] == null) continue;
    const r = rsi[i] as number, rPrev = rsi[i - 1] as number;
    const firstOfDay = dayOf(candles[i]) !== dayOf(candles[i - 1]);
    const lastOfDay = (i === candles.length - 1) || (dayOf(candles[i + 1]) !== dayOf(candles[i]));
    if (firstOfDay) { flatPeak = r; flatTrough = r; } // no overnight carry-over of setups

    if (pos) {
      // track heat
      if (pos.dir === 'SHORT') {
        pos.mae = Math.max(pos.mae, highs[i] - pos.entryPrice);
        pos.mfe = Math.max(pos.mfe, pos.entryPrice - lows[i]);
      } else {
        pos.mae = Math.max(pos.mae, pos.entryPrice - lows[i]);
        pos.mfe = Math.max(pos.mfe, highs[i] - pos.entryPrice);
      }
      let exit = false, reason = '', exitPrice = closes[i];
      // Stop-loss = previous candle's low (long) / high (short), checked intrabar (worst-case first)
      if (pos.dir === 'LONG' && lows[i] <= pos.stop) { exit = true; reason = 'STOP'; exitPrice = pos.stop; }
      else if (pos.dir === 'SHORT' && highs[i] >= pos.stop) { exit = true; reason = 'STOP'; exitPrice = pos.stop; }
      // Target = opposite RSI zone (on close)
      else if (pos.dir === 'SHORT' && r <= osHigh) { exit = true; reason = 'TARGET'; }
      else if (pos.dir === 'LONG' && r >= obLow) { exit = true; reason = 'TARGET'; }
      // Intraday only — square off at day end
      else if (lastOfDay) { exit = true; reason = 'EOD'; }
      if (exit) {
        const pnl = pos.dir === 'SHORT' ? pos.entryPrice - exitPrice : exitPrice - pos.entryPrice;
        trades.push({
          dir: pos.dir, entryTime: pos.entryTime, entryPrice: pos.entryPrice, entryRsi: +pos.entryRsi.toFixed(1),
          exitTime: String(candles[i].date), exitPrice: +exitPrice.toFixed(2), exitRsi: +r.toFixed(1), reason,
          pnl: +pnl.toFixed(2), bars: i - pos.entryIdx, mae: +pos.mae.toFixed(2), mfe: +pos.mfe.toFixed(2), stop: +pos.stop.toFixed(2),
        });
        pos = null;
        flatPeak = r; flatTrough = r;
      }
      continue;
    }

    // flat — track extremes, then look for an entry (never enter on the last bar of a day)
    flatPeak = Math.max(flatPeak, r);
    flatTrough = Math.min(flatTrough, r);
    if (lastOfDay) continue;

    // SHORT: RSI went DEEP into overbought (peak >= deepOb), then a candle closes back below obLow
    if (flatPeak >= deepOb && rPrev >= obLow && r < obLow) {
      pos = { dir: 'SHORT', entryIdx: i, entryTime: String(candles[i].date), entryPrice: closes[i], entryRsi: r, mae: 0, mfe: 0, stop: highs[i - 1] };
      flatPeak = r; flatTrough = r;
    }
    // LONG: RSI went DEEP into oversold (trough <= deepOs), then a candle closes back above osHigh
    else if (flatTrough <= deepOs && rPrev <= osHigh && r > osHigh) {
      pos = { dir: 'LONG', entryIdx: i, entryTime: String(candles[i].date), entryPrice: closes[i], entryRsi: r, mae: 0, mfe: 0, stop: lows[i - 1] };
      flatPeak = r; flatTrough = r;
    }
  }

  // ---- stats ----
  const n = trades.length;
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const winsArr = trades.filter((t) => t.pnl > 0);
  const lossArr = trades.filter((t) => t.pnl <= 0);
  const totalPoints = sum(trades.map((t) => t.pnl));
  const grossWin = sum(winsArr.map((t) => t.pnl));
  const grossLoss = Math.abs(sum(lossArr.map((t) => t.pnl)));
  let cum = 0, peak = 0, maxDD = 0;
  const equity = trades.map((t, idx) => { cum += t.pnl; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); return { i: idx + 1, cum: +cum.toFixed(1) }; });

  const stats = {
    trades: n,
    wins: winsArr.length,
    losses: lossArr.length,
    winRate: n ? +((winsArr.length / n) * 100).toFixed(1) : 0,
    avgWin: winsArr.length ? +(grossWin / winsArr.length).toFixed(1) : 0,
    avgLoss: lossArr.length ? +(-grossLoss / lossArr.length).toFixed(1) : 0,
    expectancy: n ? +(totalPoints / n).toFixed(2) : 0,
    totalPoints: +totalPoints.toFixed(1),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? null : 0), // null => no losses (∞)
    maxDrawdown: +maxDD.toFixed(1),
    best: n ? +Math.max(...trades.map((t) => t.pnl)).toFixed(1) : 0,
    worst: n ? +Math.min(...trades.map((t) => t.pnl)).toFixed(1) : 0,
    targetExits: trades.filter((t) => t.reason === 'TARGET').length,
    stopExits: trades.filter((t) => t.reason === 'STOP').length,
    eodExits: trades.filter((t) => t.reason === 'EOD').length,
    avgMae: n ? +(sum(trades.map((t) => t.mae)) / n).toFixed(1) : 0,
    maxMae: n ? +Math.max(...trades.map((t) => t.mae)).toFixed(1) : 0,
  };

  return {
    success: true,
    params: { days, rsiPeriod: period, obLow, obHigh, osLow, osHigh, deepOb, deepOs },
    from: candles[0]?.date || null,
    to: candles[candles.length - 1]?.date || null,
    candles: candles.length,
    stats,
    equity,
    trades: trades.slice(-300), // cap payload; stats are over all trades
  };
}
