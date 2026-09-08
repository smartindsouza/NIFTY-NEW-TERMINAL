// ============================================================================
// TRAILING EXIT ENGINE — Martin's pullback method. Specified 6 Sep 2026.
//
// Pure state machine: no I/O, no clock, no broker. The server feeds it premium
// ticks and closed spot candles; it returns ACTIONS (set SL, set TP, exit half,
// exit all) which the server executes through the existing one-shot exit path.
// Keeping it pure is what lets it be replayed against recorded sessions before
// it is ever trusted with a live position.
//
// THE RULES — reduced to two on Martin's instruction, 8 Sep, after the pullback
// trailing moved a target mid-trade and cost him profit:
//   1. Half the quantity exits at TP1. TP1 NEVER MOVES.
//   2. When the premium reaches 70% of the way from entry to TP1, the stop moves
//      to entry. Once only.
// Nothing else. The pullback/structure trailing, the x1.2 target multiplication
// and the trailing-TP exit are all GONE — not disabled behind a flag, removed,
// so there is no path by which they can fire again.
//
// The runner therefore has no target: after the half books at TP1 it rides until
// the stop is hit, which after the 70% move is entry. That is the direct
// consequence of keeping only these two rules and is stated here so it is a
// decision on the record rather than an omission.
//
// DIRECTIONS. Two independent signs make the same code serve every case:
//   premDir  +1 when a rising premium is good for us (long option), −1 short.
//   spotDir  +1 when a rising SPOT is good for us. Buying a Call: +1. Buying a
//            Put: −1 — the pullback structure for a long Put is spot going DOWN.
//   fav(dir, a, b) > 0 means a is more favourable than b in that direction.
// ============================================================================

export type TrailState = {
  v: 1;
  premDir: 1 | -1;
  spotDir: 1 | -1;
  entry: number;
  sl: number;
  tp: number;
  tp1: number;
  origRisk: number;          // |entry − original SL|, premium
  origReward: number;        // |TP1 − entry|, premium
  minPullbackSpot: number;   // spot points a pullback must be to count
  qtyTotal: number;
  qtyRemaining: number;
  lotSize: number;
  tp1Done: boolean;
  costMoved: boolean;
  lastPrem: number | null;
};

export type TrailAction =
  | { type: 'SET_SL'; sl: number; reason: string }
  | { type: 'SET_TP'; tp: number; reason: string }
  | { type: 'EXIT_PARTIAL'; qty: number; reason: string }
  | { type: 'EXIT_ALL'; reason: string };

const fav = (dir: 1 | -1, a: number, b: number) => dir * (a - b);
const r2 = (x: number) => +x.toFixed(2);

export function createTrailState(input: {
  side: 'BUY' | 'SELL';
  optionType: 'CE' | 'PE';
  entry: number; sl: number; tp: number;
  qty: number; lotSize: number;
  minPullbackSpot: number;
  spotNow: number | null;
}): TrailState {
  const premDir: 1 | -1 = input.side === 'BUY' ? 1 : -1;
  const callDir: 1 | -1 = input.optionType === 'CE' ? 1 : -1;
  const spotDir: 1 | -1 = (premDir * callDir) as 1 | -1;
  return {
    v: 1, premDir, spotDir,
    entry: input.entry, sl: input.sl, tp: input.tp, tp1: input.tp,
    origRisk: Math.abs(input.entry - input.sl),
    origReward: Math.abs(input.tp - input.entry),
    minPullbackSpot: Math.max(0, input.minPullbackSpot),
    qtyTotal: input.qty, qtyRemaining: input.qty, lotSize: Math.max(1, input.lotSize),
    tp1Done: false, costMoved: false, lastPrem: null,
  };
}

/** Half the position, rounded DOWN to whole lots. 0 means "cannot halve". */
export function halfQty(s: TrailState): number {
  const lots = Math.floor(s.qtyTotal / s.lotSize);
  const halfLots = Math.floor(lots / 2);
  return halfLots * s.lotSize;
}

// ---------------------------------------------------------------------------
// Premium tick. Order of checks matters and is deliberate:
//   1. SL first — protection beats everything.
//   2. TP1 booking before trailing-TP, so the half-exit at TP1 is never skipped
//      by a trailed TP that happens to be reached on the same tick.
//   3. Trailing TP for the runner.
//   4. The 70% rule.
// ---------------------------------------------------------------------------
export function onPremiumTick(s: TrailState, ltp: number): TrailAction[] {
  const out: TrailAction[] = [];
  if (!(ltp > 0)) return out;
  s.lastPrem = ltp;

  // 1. Stop first — protection before anything else.
  if (fav(s.premDir, ltp, s.sl) <= 0) {
    out.push({ type: 'EXIT_ALL', reason: s.costMoved ? 'SL_AT_COST' : 'SL' });
    return out;
  }

  // 2. TP1 — book half, exactly once. TP1 never moves, so this fires at the
  //    level that was armed and shown on the chart, not at a moved one.
  if (!s.tp1Done && fav(s.premDir, ltp, s.tp1) >= 0) {
    s.tp1Done = true;
    const half = halfQty(s);
    if (half <= 0) {
      out.push({ type: 'EXIT_ALL', reason: 'TARGET' });   // one lot cannot be halved
      return out;
    }
    s.qtyRemaining = s.qtyTotal - half;
    out.push({ type: 'EXIT_PARTIAL', qty: half, reason: 'TP1_HALF' });
    return out;
  }

  // 3. 70% of the way from entry to TP1 -> stop to entry. Once.
  if (!s.costMoved) {
    const threshold = s.entry + s.premDir * 0.7 * s.origReward;
    if (fav(s.premDir, ltp, threshold) >= 0) {
      s.costMoved = true;
      if (fav(s.premDir, s.entry, s.sl) > 0) {          // never loosen a stop
        s.sl = r2(s.entry);
        out.push({ type: 'SET_SL', sl: s.sl, reason: 'COST_70PCT' });
      }
    }
  }
  return out;
}

// Spot closes no longer affect anything: the structure rules are gone. Kept as
// inert exports so the server's candle feed does not need unwinding in the same
// commit as a money-affecting behaviour change — one thing at a time.
export function onSpotClose5m(_s: TrailState, _close: number): TrailAction[] { return []; }
export function onSpotClose1m(_s: TrailState, _close: number): TrailAction[] { return []; }
