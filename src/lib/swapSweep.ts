// ============================================================================
// SWAP-SWEEP REVERSAL — Martin's three-candle reversal pattern.
// One definition, shared by the chart indicator and the backtest, so the two
// can never disagree about what a signal is.
//
// For three consecutive CLOSED candles C1, C2, C3 (signal at C3's close):
//   BEARISH: C2 closes ABOVE C1's high          (swap: takes C1's liquidity)
//            C3 makes a high ABOVE C2's high    (sweep)
//            C3 closes BELOW C1's high          (reclaim; C3 any colour)
//   BULLISH: C2 closes BELOW C1's low
//            C3 makes a low BELOW C2's low
//            C3 closes ABOVE C1's low
// The two cannot both fire on the same three candles: one needs C2 to close
// above C1's high, the other below C1's low.
//
// sameSession (default on): all three candles must be in the same IST trading
// day. Across the overnight gap, "C2 closed above C1's high" is usually just the
// gap, not a liquidity swap, so those are excluded unless switched off.
// ============================================================================

export type SsCandle = { time: number; open: number; high: number; low: number; close: number };
export type SsSignal = { idx: number; time: number; kind: 'bull' | 'bear' };

/** Unix seconds from whatever the candle carries (seconds, ms or a date string). */
export function ssTime(t: any): number {
  if (typeof t === 'number') return t > 1e12 ? Math.floor(t / 1000) : t;
  const ms = new Date(String(t).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}
/** IST calendar day as yyyymmdd. */
export function ssIstDay(sec: number): number {
  const d = new Date((sec + 19800) * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export function detectSwapSweep(candles: any[], opts: { sameSession?: boolean } = {}): SsSignal[] {
  const sameSession = opts.sameSession !== false;
  const out: SsSignal[] = [];
  for (let i = 2; i < (candles?.length || 0); i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    if (!c1 || !c2 || !c3) continue;
    const t3 = ssTime(c3.time);
    if (sameSession) {
      const d = ssIstDay(t3);
      if (ssIstDay(ssTime(c1.time)) !== d || ssIstDay(ssTime(c2.time)) !== d) continue;
    }
    if (c2.close > c1.high && c3.high > c2.high && c3.close < c1.high) out.push({ idx: i, time: t3, kind: 'bear' });
    else if (c2.close < c1.low && c3.low < c2.low && c3.close > c1.low) out.push({ idx: i, time: t3, kind: 'bull' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// FILTERS — candidate improvements, each a switch, so the backtest can show
// which ones actually earn their place. Baseline results on real NIFTY were
// indistinguishable from random entries, and the chart study suggested the edge,
// if any, is in WHERE the pattern forms. All are defined here once so the chart
// can adopt exactly the ones that survive testing.
//
//   LIQUIDITY (any ticked level counts — real stops sit at these, not at one
//   candle's high):
//     extremeN   C3's sweep wick goes beyond the highest high (bearish) / lowest
//                low (bullish) of the N candles before it
//     dayExtreme C3 makes a new high / low of the day so far
//     prevDay    C3 sweeps yesterday's high (and closes back below it) /
//                yesterday's low (and closes back above it)
//   decisiveClose  C3 closes in the far third of its own range
//   skipOpening    no signal whose C3 starts before 09:30 IST
//   trendGuard     skip signals against a STRONG trend: the 20-EMA has moved more
//                  than one ATR(14) in the last 10 candles
// ---------------------------------------------------------------------------
export type SsFilters = {
  extremeN?: number; dayExtreme?: boolean; prevDay?: boolean;
  decisiveClose?: boolean; skipOpening?: boolean; trendGuard?: boolean;
};
export function filterSwapSweep(candles: any[], signals: SsSignal[], f: SsFilters): SsSignal[] {
  const anyLevel = !!(f.extremeN && f.extremeN > 0) || !!f.dayExtreme || !!f.prevDay;
  if (!anyLevel && !f.decisiveClose && !f.skipOpening && !f.trendGuard) return signals;
  const n = candles.length;
  const day = candles.map((c: any) => ssIstDay(ssTime(c.time)));
  // previous trading day's high/low, per candle
  const prevHi = new Array(n).fill(NaN), prevLo = new Array(n).fill(NaN);
  { let curD = -1, curH = -Infinity, curL = Infinity, pH = NaN, pL = NaN;
    for (let i = 0; i < n; i++) {
      if (day[i] !== curD) { if (curD !== -1) { pH = curH; pL = curL; } curD = day[i]; curH = -Infinity; curL = Infinity; }
      prevHi[i] = pH; prevLo[i] = pL;
      curH = Math.max(curH, candles[i].high); curL = Math.min(curL, candles[i].low);
    } }
  // trend: EMA20 and ATR14, computed only if needed
  let ema: number[] = [], atr: number[] = [];
  if (f.trendGuard) {
    const k = 2 / 21; ema = new Array(n);
    for (let i = 0; i < n; i++) ema[i] = i === 0 ? candles[0].close : candles[i].close * k + ema[i - 1] * (1 - k);
    atr = new Array(n).fill(NaN); let sum = 0; const tr: number[] = [];
    for (let i = 0; i < n; i++) {
      const pc = i > 0 ? candles[i - 1].close : candles[i].close;
      tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - pc), Math.abs(candles[i].low - pc));
      sum += tr[i]; if (i >= 14) sum -= tr[i - 14];
      if (i >= 13) atr[i] = sum / 14;
    }
  }
  return signals.filter((s) => {
    const i = s.idx, c3 = candles[i], bear = s.kind === 'bear';
    if (anyLevel) {
      let hit = false;
      if (f.extremeN && f.extremeN > 0 && i - f.extremeN >= 0) {
        let ext = bear ? -Infinity : Infinity;
        for (let j = i - f.extremeN; j < i; j++) ext = bear ? Math.max(ext, candles[j].high) : Math.min(ext, candles[j].low);
        if (bear ? c3.high > ext : c3.low < ext) hit = true;
      }
      if (!hit && f.dayExtreme) {
        let ext = bear ? -Infinity : Infinity, seen = false;
        for (let j = i - 1; j >= 0 && day[j] === day[i]; j--) { seen = true; ext = bear ? Math.max(ext, candles[j].high) : Math.min(ext, candles[j].low); }
        if (seen && (bear ? c3.high > ext : c3.low < ext)) hit = true;
      }
      if (!hit && f.prevDay && Number.isFinite(prevHi[i])) {
        if (bear ? (c3.high > prevHi[i] && c3.close < prevHi[i]) : (c3.low < prevLo[i] && c3.close > prevLo[i])) hit = true;
      }
      if (!hit) return false;
    }
    if (f.decisiveClose) {
      const r = c3.high - c3.low;
      if (!(r > 0)) return false;
      if (bear ? c3.close > c3.low + r / 3 : c3.close < c3.high - r / 3) return false;
    }
    if (f.skipOpening) {
      const m = Math.floor(((ssTime(c3.time) + 19800) % 86400) / 60);
      if (m < 9 * 60 + 30) return false;
    }
    if (f.trendGuard && i >= 10 && Number.isFinite(atr[i])) {
      const slope = ema[i] - ema[i - 10];
      if (bear && slope > atr[i]) return false;        // strong uptrend: no shorts
      if (!bear && slope < -atr[i]) return false;      // strong downtrend: no longs
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// BACKTEST. Each signal is measured on its own, on the INDEX in points:
//   entry  = C3's close (the signal is only known at the close)
//   stop   = beyond the sweep: C3's high (bearish) / C3's low (bullish) — the
//            level whose break proves the reversal wrong
//   target = entry -/+ rr x risk
// Scanning forward candle by candle: stop or target, whichever is touched
// first. If BOTH fall inside the same candle the order inside it is unknown,
// so it is counted as a LOSS — conservative on purpose. With sessionExit, a
// trade still open at the end of its trading day is closed at that day's last
// close (intraday), scored at its actual R.
// Not modelled, and said so on screen: brokerage, slippage, and option premium
// behaviour (theta, IV). Expired contracts' history is not available from Kite,
// so this tests the PATTERN on the index, not an options P&L.
// ---------------------------------------------------------------------------
export type SsTrade = {
  time: number; kind: 'bull' | 'bear'; entry: number; stop: number; target: number;
  exit: number; exitTime: number; outcome: 'WIN' | 'LOSS' | 'TIME'; r: number;
};
// confirm: instead of entering at C3's close, wait for the NEXT candle to break
//   C3's low (bearish) / high (bullish) and enter there — a stop-entry, filled at
//   the break or at that candle's open if it gapped through. No break, no trade.
//   The stop stays beyond the sweep, so the risk is the whole of C3's range.
// costPts: brokerage + slippage per round trip, in index points, deducted from
//   every trade as a fraction of its risk.
export function backtestSwapSweep(candles: any[], signals: SsSignal[],
  opts: { rr: number; sessionExit?: boolean; confirm?: boolean; costPts?: number }): SsTrade[] {
  const rr = opts.rr, sessionExit = opts.sessionExit !== false;
  const cost = Math.max(0, Number(opts.costPts) || 0);
  const out: SsTrade[] = [];
  for (const s of signals) {
    const c3 = candles[s.idx];
    const bear = s.kind === 'bear';
    const day = ssIstDay(s.time);
    let entry = c3.close, startJ = s.idx + 1;
    if (opts.confirm) {
      const c4 = candles[s.idx + 1];
      if (!c4 || (sessionExit && ssIstDay(ssTime(c4.time)) !== day)) continue;
      const trig = bear ? c3.low : c3.high;
      if (!(bear ? c4.low < trig : c4.high > trig)) continue;      // no break, no trade
      entry = bear ? Math.min(trig, c4.open) : Math.max(trig, c4.open);
      startJ = s.idx + 1;                                           // the entry candle itself is checked too
    }
    const stop = bear ? c3.high : c3.low;
    const risk = bear ? stop - entry : entry - stop;
    if (!(risk > 0)) continue;                       // closed at its own extreme: no defined risk
    const target = bear ? entry - rr * risk : entry + rr * risk;
    let done: SsTrade | null = null;
    let lastClose = entry, lastTime = s.time;
    for (let j = startJ; j < candles.length; j++) {
      const b = candles[j];
      const bt = ssTime(b.time);
      if (sessionExit && ssIstDay(bt) !== day) break; // session over: exit at its last close
      const hitStop = bear ? b.high >= stop : b.low <= stop;
      const hitTgt = bear ? b.low <= target : b.high >= target;
      if (hitStop) { done = { time: s.time, kind: s.kind, entry, stop, target, exit: stop, exitTime: bt, outcome: 'LOSS', r: -1 }; break; }
      if (hitTgt) { done = { time: s.time, kind: s.kind, entry, stop, target, exit: target, exitTime: bt, outcome: 'WIN', r: rr }; break; }
      lastClose = b.close; lastTime = bt;
    }
    if (!done) {
      const move = bear ? entry - lastClose : lastClose - entry;
      done = { time: s.time, kind: s.kind, entry, stop, target, exit: lastClose, exitTime: lastTime, outcome: 'TIME', r: move / risk };
    }
    if (cost > 0) done.r -= cost / risk;
    out.push(done);
  }
  return out;
}

export type SsStats = {
  trades: number; bull: number; bear: number; wins: number; losses: number; timeExits: number;
  winRate: number; avgR: number; totalR: number; profitFactor: number | null; maxLossStreak: number;
};
export function ssStats(trades: SsTrade[]): SsStats {
  let wins = 0, losses = 0, timeExits = 0, gain = 0, loss = 0, streak = 0, maxStreak = 0, totalR = 0, bull = 0, bear = 0;
  for (const t of trades) {
    totalR += t.r;
    if (t.kind === 'bull') bull++; else bear++;
    if (t.outcome === 'WIN') wins++; else if (t.outcome === 'LOSS') losses++; else timeExits++;
    if (t.r > 0) { gain += t.r; streak = 0; } else { loss += -t.r; if (t.r < 0) { streak++; maxStreak = Math.max(maxStreak, streak); } }
  }
  const n = trades.length;
  return { trades: n, bull, bear, wins, losses, timeExits,
    winRate: n ? (trades.filter(t => t.r > 0).length / n) : 0,
    avgR: n ? totalR / n : 0, totalR, profitFactor: loss > 0 ? gain / loss : (gain > 0 ? null : 0), maxLossStreak: maxStreak };
}
