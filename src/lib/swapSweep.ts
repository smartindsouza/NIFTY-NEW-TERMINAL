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
// costPts: brokerage + slippage per round trip, in index points, deducted from
//   every trade as a fraction of its risk.
export function backtestSwapSweep(candles: any[], signals: SsSignal[], opts: { rr: number; sessionExit?: boolean; costPts?: number }): SsTrade[] {
  const rr = opts.rr, sessionExit = opts.sessionExit !== false;
  const cost = Math.max(0, Number(opts.costPts) || 0);
  const out: SsTrade[] = [];
  for (const s of signals) {
    const c3 = candles[s.idx];
    const entry = c3.close;
    const bear = s.kind === 'bear';
    const stop = bear ? c3.high : c3.low;
    const risk = bear ? stop - entry : entry - stop;
    if (!(risk > 0)) continue;                       // closed at its own extreme: no defined risk
    const target = bear ? entry - rr * risk : entry + rr * risk;
    const day = ssIstDay(s.time);
    let done: SsTrade | null = null;
    let lastClose = entry, lastTime = s.time;
    for (let j = s.idx + 1; j < candles.length; j++) {
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
