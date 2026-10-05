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
  exit: number; exitTime: number; outcome: 'WIN' | 'LOSS' | 'TIME' | 'SIGNAL'; r: number;
};
// An entry to be simulated: which candle's close triggers it, the side, the entry
// price and the stop. For a single timeframe this is C3's close and C3's own
// extreme (the wrapper below builds exactly that); the confluence test supplies
// its own. 'time' is the start of the candle whose close triggers the entry.
// amb (break entries only): the fill candle ALSO reached the stop and did not open
// beyond the order level, so whether price dipped to the stop before or after the
// fill is unknown from candle data. The default scan counts it a loss; an
// optimistic bound is obtained by scanning from the NEXT candle instead.
export type SsEntry = { idx: number; time: number; kind: 'bull' | 'bear'; entry: number; stop: number; amb?: boolean };

// costPts: brokerage + slippage per round trip, in index points, deducted from
//   every trade as a fraction of its risk.
export function backtestEntries(candles: any[], entries: SsEntry[], opts: { rr: number; sessionExit?: boolean; costPts?: number }): SsTrade[] {
  const rr = opts.rr, sessionExit = opts.sessionExit !== false;
  const cost = Math.max(0, Number(opts.costPts) || 0);
  const out: SsTrade[] = [];
  for (const s of entries) {
    const entry = s.entry, stop = s.stop;
    const bear = s.kind === 'bear';
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

// Single timeframe: enter at C3's close, stop beyond C3's own sweep.
export function backtestSwapSweep(candles: any[], signals: SsSignal[], opts: { rr: number; sessionExit?: boolean; costPts?: number }): SsTrade[] {
  const entries: SsEntry[] = signals.map((s) => {
    const c3 = candles[s.idx];
    return { idx: s.idx, time: s.time, kind: s.kind, entry: c3.close, stop: s.kind === 'bear' ? c3.high : c3.low };
  });
  return backtestEntries(candles, entries, opts);
}

// ---------------------------------------------------------------------------
// 5-MIN + 15-MIN CONFLUENCE. The trade is taken only when BOTH timeframes show a
// Swap-Sweep signal in the same direction at the same time.
//
// "At the same time": a 15-min signal's C3 candle spans exactly three 5-min
// candles (starts S, S+5m, S+10m). The 5-min signal must have its own C3 among
// those three, so both signals are known when the 15-min candle closes — at the
// close of the last of those 5-min candles, which is the entry. A 5-min signal
// from before that 15-min candle began, or after it ended, does not count.
//
// Everything is simulated on the 5-MIN candles, so a stop and a target inside one
// 15-min bar are ordered properly instead of being counted as a loss by default.
// stop '15': beyond the 15-min C3's sweep (the wider structure, the default);
// stop '5' : beyond the 5-min sweep — the highest high / lowest low of the
//            matching 5-min C3s (tighter, so costs weigh more).
// Returns three entry lists measured the same way, for a fair comparison:
//   five     every 5-min signal, entered at its C3's close, stopped at its C3's extreme
//   fifteen  every 15-min signal, entered at the close of its last 5-min candle,
//            stopped beyond the 15-min sweep
//   both     the 15-min signals that a same-direction 5-min signal confirms
// ---------------------------------------------------------------------------
export function confluenceSwapSweep(c5: any[], c15: any[], opts: { sameSession?: boolean; stop?: '15' | '5' } = {}): { five: SsEntry[]; fifteen: SsEntry[]; both: SsEntry[] } {
  const sig5 = detectSwapSweep(c5, { sameSession: opts.sameSession });
  const sig15 = detectSwapSweep(c15, { sameSession: opts.sameSession });
  const five: SsEntry[] = sig5.map((s) => {
    const c3 = c5[s.idx];
    return { idx: s.idx, time: s.time, kind: s.kind, entry: c3.close, stop: s.kind === 'bear' ? c3.high : c3.low };
  });
  const at5 = new Map<number, number>();                      // 5-min candle start -> index
  c5.forEach((c: any, i: number) => at5.set(ssTime(c.time), i));
  const sigAt5 = new Map<string, SsSignal>();                 // `${kind}|${start}` -> 5-min signal
  for (const s of sig5) sigAt5.set(`${s.kind}|${s.time}`, s);
  const fifteen: SsEntry[] = [], both: SsEntry[] = [];
  for (const s of sig15) {
    const i5 = at5.get(s.time + 600);                          // the last 5-min candle of the 15-min C3
    if (i5 === undefined) continue;                            // 5-min data missing there
    const bear = s.kind === 'bear';
    const k = c15[s.idx];
    const stop15 = bear ? k.high : k.low;
    const base = { idx: i5, time: ssTime(c5[i5].time), kind: s.kind, entry: c5[i5].close };
    fifteen.push({ ...base, stop: stop15 });
    const matched = [0, 300, 600].map((d) => sigAt5.get(`${s.kind}|${s.time + d}`)).filter(Boolean) as SsSignal[];
    if (!matched.length) continue;
    let stop = stop15;
    if (opts.stop === '5') {
      const ex = matched.map((m) => (bear ? c5[m.idx].high : c5[m.idx].low));
      stop = bear ? Math.max(...ex) : Math.min(...ex);
    }
    both.push({ ...base, stop });
  }
  return { five, fifteen, both };
}

// ---------------------------------------------------------------------------
// BREAK ENTRY — an alternative way to enter the same signals. Instead of entering
// at the signal candle's close, a pending STOP order is placed when it closes:
//   bullish: buy at the signal candle's HIGH      bearish: sell at its LOW
//   stop   : the signal candle's far extreme — its LOW for a long, its HIGH for a
//            short — so the risk is the candle's full range, measured from the
//            actual fill (the order level, or the open if it gapped through).
// The order fills on the first candle after the signal that trades through the
// level, within 'validFor' candles (Infinity = the rest of that trading day; an
// unfilled order never carries overnight). It fills AT the level, or at that
// candle's open when it gapped through — the worse price, as in real trading. No
// fill, no trade.
//
// The fill candle is itself checked for the stop and the target. The order inside
// a candle is unknown, so a fill candle that touches the stop too is counted as a
// LOSS — the same conservative rule the rest of the backtest uses. (If price first
// dipped to the stop and only then rose to the order level, that really would
// have filled and survived; counting it a loss is the cautious side.) With the
// stop at the candle's far extreme this is rarer than it was with a midpoint stop.
//
// Returns entries for backtestEntries: idx is the candle BEFORE the fill, so the
// engine's forward scan starts on the fill candle itself; 'time' stays the signal
// candle's start, as it does for every other mode.
// ---------------------------------------------------------------------------
export function breakEntries(candles: any[], signals: SsSignal[], opts: { validFor: number }): SsEntry[] {
  const out: SsEntry[] = [];
  for (const s of signals) {
    const c3 = candles[s.idx];
    if (!c3 || !(c3.high > c3.low)) continue;               // a zero-range candle has no range to put a stop beyond
    const bull = s.kind === 'bull';
    const trig = bull ? c3.high : c3.low;
    const stop = bull ? c3.low : c3.high;                   // the far extreme: low for a long, high for a short
    const day = ssIstDay(s.time);
    for (let j = s.idx + 1; j < candles.length && j - s.idx <= opts.validFor; j++) {
      const b = candles[j];
      if (ssIstDay(ssTime(b.time)) !== day) break;           // the order does not survive the session
      if (bull ? b.high >= trig : b.low <= trig) {
        // Opened beyond the level: filled at the open, so any move to the stop came
        // AFTER the fill — a certain loss, not an unknown order.
        const gapped = bull ? b.open >= trig : b.open <= trig;
        const reachedStop = bull ? b.low <= stop : b.high >= stop;
        out.push({ idx: j - 1, time: s.time, kind: s.kind, entry: bull ? Math.max(trig, b.open) : Math.min(trig, b.open), stop,
                   ...(reachedStop && !gapped ? { amb: true } : {}) });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SIGNAL EXIT — hold the trade until the next OPPOSITE signal, but only once that
// signal is CONFIRMED. A signal can be fake and the trend can simply continue, so
// an opposite signal does not close the trade by itself: the candle right after
// it must break its extreme — below the opposite (bearish) signal candle's LOW for
// a long, above the opposite (bullish) signal candle's HIGH for a short — the
// mirror of the entry rule. If that next candle does not break it, the signal is
// treated as fake and the trade carries on.
//
// The stop stays active throughout. Where one candle reaches both the stop and the
// exit level they lie on the same side of price, so the NEARER one is reached
// first (the higher of the two for a long, the lower for a short); a tie goes to
// the stop. An exit fills at the level, or at the candle's open if it gapped
// through — but never worse than the stop, the same simplification stops already
// carry in every other mode. With sessionExit a trade still open at the end of its
// trading day closes at that day's last close.
//
// 'signals' are ALL the signals on the series (they are the exit triggers),
// whatever period the entries were filtered to. Entries are scanned from idx + 1,
// as in backtestEntries, so the optimistic bound (idx + 1) also works here; an
// opposite signal on the candle just before the first scanned one is honoured.
// ---------------------------------------------------------------------------
export function backtestSignalExit(candles: any[], entries: SsEntry[], signals: SsSignal[], opts: { sessionExit?: boolean; costPts?: number }): SsTrade[] {
  const sessionExit = opts.sessionExit !== false;
  const cost = Math.max(0, Number(opts.costPts) || 0);
  const sigAt = new Map<number, 'bull' | 'bear'>();
  for (const g of signals) sigAt.set(g.idx, g.kind);
  const out: SsTrade[] = [];
  for (const e of entries) {
    const short = e.kind === 'bear';
    const opp = short ? 'bull' : 'bear';
    const risk = short ? e.stop - e.entry : e.entry - e.stop;
    if (!(risk > 0)) continue;
    const day = ssIstDay(e.time);
    const j0 = e.idx + 1;
    // The exit level carried by an opposite signal on the previous candle, waiting
    // for THIS candle to confirm it. A short exits above a bullish candle's high.
    let pending: number | null = sigAt.get(j0 - 1) === opp ? (short ? candles[j0 - 1].high : candles[j0 - 1].low) : null;
    let done: SsTrade | null = null;
    let lastClose = e.entry, lastTime = e.time;
    for (let j = j0; j < candles.length; j++) {
      const b = candles[j];
      const bt = ssTime(b.time);
      if (sessionExit && ssIstDay(bt) !== day) break;        // session over: exit at its last close
      const stopHit = short ? b.high >= e.stop : b.low <= e.stop;
      const sigHit = pending !== null && (short ? b.high >= pending : b.low <= pending);
      if (stopHit || sigHit) {
        const stopFirst = stopHit && (!sigHit || (short ? e.stop <= (pending as number) : e.stop >= (pending as number)));
        if (stopFirst) {
          done = { time: e.time, kind: e.kind, entry: e.entry, stop: e.stop, target: NaN, exit: e.stop, exitTime: bt, outcome: 'LOSS', r: -1 };
        } else {
          const lvl = pending as number;
          // at the level, or the open if it gapped through; never worse than the stop
          const px = short ? Math.min(e.stop, Math.max(lvl, b.open)) : Math.max(e.stop, Math.min(lvl, b.open));
          done = { time: e.time, kind: e.kind, entry: e.entry, stop: e.stop, target: NaN, exit: px, exitTime: bt, outcome: 'SIGNAL',
                   r: (short ? e.entry - px : px - e.entry) / risk };
        }
        break;
      }
      pending = null;                                        // an unconfirmed signal does not carry over
      if (sigAt.get(j) === opp) pending = short ? b.high : b.low;
      lastClose = b.close; lastTime = bt;
    }
    if (!done) {
      const move = short ? e.entry - lastClose : lastClose - e.entry;
      done = { time: e.time, kind: e.kind, entry: e.entry, stop: e.stop, target: NaN, exit: lastClose, exitTime: lastTime, outcome: 'TIME', r: move / risk };
    }
    if (cost > 0) done.r -= cost / risk;
    out.push(done);
  }
  return out;
}

export type SsStats = {
  trades: number; bull: number; bear: number; wins: number; losses: number; timeExits: number; signalExits: number;
  winRate: number; avgR: number; totalR: number; profitFactor: number | null; maxLossStreak: number;
};
export function ssStats(trades: SsTrade[]): SsStats {
  let wins = 0, losses = 0, timeExits = 0, signalExits = 0, gain = 0, loss = 0, streak = 0, maxStreak = 0, totalR = 0, bull = 0, bear = 0;
  for (const t of trades) {
    totalR += t.r;
    if (t.kind === 'bull') bull++; else bear++;
    if (t.outcome === 'WIN') wins++; else if (t.outcome === 'LOSS') losses++; else if (t.outcome === 'SIGNAL') signalExits++; else timeExits++;
    if (t.r > 0) { gain += t.r; streak = 0; } else { loss += -t.r; if (t.r < 0) { streak++; maxStreak = Math.max(maxStreak, streak); } }
  }
  const n = trades.length;
  return { trades: n, bull, bear, wins, losses, timeExits, signalExits,
    winRate: n ? (trades.filter(t => t.r > 0).length / n) : 0,
    avgR: n ? totalR / n : 0, totalR, profitFactor: loss > 0 ? gain / loss : (gain > 0 ? null : 0), maxLossStreak: maxStreak };
}
