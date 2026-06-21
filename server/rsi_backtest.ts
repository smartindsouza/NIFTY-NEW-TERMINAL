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
  deepOb?: number; deepOs?: number; useStop?: boolean; useDivergence?: boolean;
  divWindow?: number; noEntryAfter?: string; exitAtCutoff?: boolean;
}

export async function runRsiBacktest(opts: RsiBacktestOpts) {
  const days = Math.min(Math.max(opts.days || 60, 5), 180);
  const period = opts.rsiPeriod || 14;
  const obLow = opts.obLow ?? 60, obHigh = opts.obHigh ?? 65;
  const osLow = opts.osLow ?? 38, osHigh = opts.osHigh ?? 40;
  // "Deep" penetration required to qualify a setup — filters out shallow bounces off the zone edge.
  const deepOb = opts.deepOb ?? 70; // short only if RSI first reached at least this (deep overbought)
  const deepOs = opts.deepOs ?? 30; // long only if RSI first reached at most this (deep oversold)
  const useStop = !!opts.useStop;   // optional: stop at the pre-entry candle's low/high, on a CLOSING basis
  const useDivergence = !!opts.useDivergence; // optional: require matching RSI divergence
  const DIVW = Math.min(Math.max(Math.round(opts.divWindow ?? 7), 1), 7); // divergence lookback window (1-7 candles)
  const noEntryAfter = (opts.noEntryAfter || '').trim(); // 'HH:MM' IST; '' = no cutoff
  const exitAtCutoff = !!opts.exitAtCutoff; // also square off open trades at the cutoff time

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
  // Slow EMA → simple trend/range regime per entry (with-trend vs counter-trend vs range)
  const emaSlow: number[] = new Array(closes.length).fill(0);
  { const k = 2 / (50 + 1); let prev = closes[0]; for (let i = 0; i < closes.length; i++) { prev = i === 0 ? closes[0] : closes[i] * k + prev * (1 - k); emaSlow[i] = prev; } }
  const regimeAt = (i: number, dir: 'LONG' | 'SHORT'): 'withTrend' | 'counterTrend' | 'range' => {
    const slope = emaSlow[i] - emaSlow[Math.max(0, i - 6)]; // ~30-min EMA slope
    const thr = closes[i] * 0.0005; // 0.05% of price
    const tdir = slope > thr ? 'up' : slope < -thr ? 'down' : 'flat';
    if (tdir === 'flat') return 'range';
    if ((dir === 'LONG' && tdir === 'up') || (dir === 'SHORT' && tdir === 'down')) return 'withTrend';
    return 'counterTrend';
  };
  const dayOf = (c: any) => String(c.date).slice(0, 10);
  const timeOf = (c: any) => String(c.date).slice(11, 16); // 'HH:MM' in IST (candle stamps carry +0530)

  // RSI divergence over a ≤DIVW-candle window, using RSI swing highs/lows (1-bar pivots) vs price
  const swingsInWindow = (i: number, kind: 'low' | 'high'): number[] => {
    const out: number[] = [];
    const start = Math.max(period + 1, i - DIVW);
    for (let j = start; j <= i - 1; j++) {
      const a = rsi[j], pv = rsi[j - 1], nx = rsi[j + 1];
      if (a == null || pv == null || nx == null) continue;
      if (kind === 'low' && a < pv && a <= nx) out.push(j);
      if (kind === 'high' && a > pv && a >= nx) out.push(j);
    }
    return out;
  };
  const hasBullishDiv = (i: number): boolean => {
    const s = swingsInWindow(i, 'low');
    if (s.length < 2) return false;
    const a = s[s.length - 2], b = s[s.length - 1];
    return lows[b] < lows[a] && (rsi[b] as number) > (rsi[a] as number); // price lower-low, RSI higher-low
  };
  const hasBearishDiv = (i: number): boolean => {
    const s = swingsInWindow(i, 'high');
    if (s.length < 2) return false;
    const a = s[s.length - 2], b = s[s.length - 1];
    return highs[b] > highs[a] && (rsi[b] as number) < (rsi[a] as number); // price higher-high, RSI lower-high
  };

  interface Trade {
    dir: 'LONG' | 'SHORT'; entryTime: string; entryPrice: number; entryRsi: number;
    exitTime: string; exitPrice: number; exitRsi: number; reason: string;
    pnl: number; bars: number; mae: number; mfe: number; regime: 'withTrend' | 'counterTrend' | 'range'; stop: number | null;
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
      let exit = false, reason = '';
      // Optional stop-loss: pre-entry candle's low/high, triggered only when a candle CLOSES past it
      if (useStop && pos.stop != null && pos.dir === 'LONG' && closes[i] < pos.stop) { exit = true; reason = 'STOP'; }
      else if (useStop && pos.stop != null && pos.dir === 'SHORT' && closes[i] > pos.stop) { exit = true; reason = 'STOP'; }
      // Target = opposite RSI zone (on close)
      else if (pos.dir === 'SHORT' && r <= osHigh) { exit = true; reason = 'TARGET'; }
      else if (pos.dir === 'LONG' && r >= obLow) { exit = true; reason = 'TARGET'; }
      // Time cutoff: optionally square off open trades at the chosen time
      else if (exitAtCutoff && noEntryAfter && timeOf(candles[i]) >= noEntryAfter) { exit = true; reason = 'CUTOFF'; }
      // Intraday only — square off at day end
      else if (lastOfDay) { exit = true; reason = 'EOD'; }
      if (exit) {
        const exitPrice = closes[i];
        const pnl = pos.dir === 'SHORT' ? pos.entryPrice - exitPrice : exitPrice - pos.entryPrice;
        trades.push({
          dir: pos.dir, entryTime: pos.entryTime, entryPrice: pos.entryPrice, entryRsi: +pos.entryRsi.toFixed(1),
          exitTime: String(candles[i].date), exitPrice: +exitPrice.toFixed(2), exitRsi: +r.toFixed(1), reason,
          pnl: +pnl.toFixed(2), bars: i - pos.entryIdx, mae: +pos.mae.toFixed(2), mfe: +pos.mfe.toFixed(2), regime: pos.regime, stop: pos.stop != null ? +pos.stop.toFixed(2) : null,
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
    if (noEntryAfter && timeOf(candles[i]) >= noEntryAfter) continue; // no new entries after the cutoff time

    // SHORT: RSI went DEEP into overbought (peak >= deepOb), then a candle closes back below obLow
    if (flatPeak >= deepOb && rPrev >= obLow && r < obLow && (!useDivergence || hasBearishDiv(i))) {
      pos = { dir: 'SHORT', entryIdx: i, entryTime: String(candles[i].date), entryPrice: closes[i], entryRsi: r, mae: 0, mfe: 0, regime: regimeAt(i, 'SHORT'), stop: useStop ? highs[i - 1] : null };
      flatPeak = r; flatTrough = r;
    }
    // LONG: RSI went DEEP into oversold (trough <= deepOs), then a candle closes back above osHigh
    else if (flatTrough <= deepOs && rPrev <= osHigh && r > osHigh && (!useDivergence || hasBullishDiv(i))) {
      pos = { dir: 'LONG', entryIdx: i, entryTime: String(candles[i].date), entryPrice: closes[i], entryRsi: r, mae: 0, mfe: 0, regime: regimeAt(i, 'LONG'), stop: useStop ? lows[i - 1] : null };
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
    cutoffExits: trades.filter((t) => t.reason === 'CUTOFF').length,
    eodExits: trades.filter((t) => t.reason === 'EOD').length,
    avgMae: n ? +(sum(trades.map((t) => t.mae)) / n).toFixed(1) : 0,
    maxMae: n ? +Math.max(...trades.map((t) => t.mae)).toFixed(1) : 0,
  };

  // ---- loss / performance breakdown (computed over ALL trades) ----
  const agg = (list: Trade[]) => {
    const m = list.length; const net = sum(list.map((t) => t.pnl)); const w = list.filter((t) => t.pnl > 0).length;
    return { n: m, net: +net.toFixed(1), winRate: m ? +((w / m) * 100).toFixed(0) : 0, avg: m ? +(net / m).toFixed(1) : 0 };
  };
  const hourOf = (iso: string) => iso.slice(11, 13); // IST hour (candle stamps carry +0530)
  const hoursPresent = Array.from(new Set(trades.map((t) => hourOf(t.entryTime)))).sort();
  const winT = trades.filter((t) => t.pnl > 0); const lossT = trades.filter((t) => t.pnl <= 0);
  const breakdown = {
    byReason: ['TARGET', 'STOP', 'CUTOFF', 'EOD'].map((k) => ({ key: k, ...agg(trades.filter((t) => t.reason === k)) })),
    byDir: ['LONG', 'SHORT'].map((k) => ({ key: k, ...agg(trades.filter((t) => t.dir === k)) })),
    byRegime: ['withTrend', 'counterTrend', 'range'].map((k) => ({ key: k, ...agg(trades.filter((t) => t.regime === k)) })),
    byHour: hoursPresent.map((h) => ({ key: h, ...agg(trades.filter((t) => hourOf(t.entryTime) === h)) })),
    holding: {
      avgBarsWin: winT.length ? +(sum(winT.map((t) => t.bars)) / winT.length).toFixed(1) : 0,
      avgBarsLoss: lossT.length ? +(sum(lossT.map((t) => t.bars)) / lossT.length).toFixed(1) : 0,
    },
    worst: [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, 5).map((t) => ({ entryTime: t.entryTime, dir: t.dir, reason: t.reason, pnl: t.pnl, mae: t.mae, regime: t.regime })),
  };

  return {
    success: true,
    params: { days, rsiPeriod: period, obLow, obHigh, osLow, osHigh, deepOb, deepOs, useStop, useDivergence, divWindow: DIVW, noEntryAfter, exitAtCutoff },
    from: candles[0]?.date || null,
    to: candles[candles.length - 1]?.date || null,
    candles: candles.length,
    stats,
    breakdown,
    equity,
    trades: trades.slice(-300), // cap payload; stats are over all trades
  };
}
