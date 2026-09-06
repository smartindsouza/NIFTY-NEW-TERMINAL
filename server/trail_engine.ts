// ============================================================================
// TRAILING EXIT ENGINE — Martin's pullback method. Specified 6 Sep 2026.
//
// Pure state machine: no I/O, no clock, no broker. The server feeds it premium
// ticks and closed spot candles; it returns ACTIONS (set SL, set TP, exit half,
// exit all) which the server executes through the existing one-shot exit path.
// Keeping it pure is what lets it be replayed against recorded sessions before
// it is ever trusted with a live position.
//
// THE RULES, restated exactly as agreed (example: buy Call at 100, SL 90, TP 120):
//   Booking     Half the quantity exits at TP1 (120). TP1 never moves.
//   70% rule    Premium reaches 70% of the reward (114) → SL to entry (100).
//               One time only; a pullback trail that already lifted the SL above
//               entry is never lowered by it.
//   Pullback    Judged on the SPOT chart. Swing high and pullback low come from
//   trail       5-minute CLOSES; the break is confirmed by a 1-minute CLOSE above
//               the swing high. A pullback must be at least a quarter of the
//               original risk in spot terms to count, so noise cannot trail you.
//               On the break, the SL moves to the PREMIUM's low during that
//               pullback — except the first trail: if that premium low stayed
//               above entry, the SL goes to entry (cost to cost) instead. Every
//               later trail goes to the actual premium low, however high.
//   Target      Multiplies by 1.2 on every trail (120 → 144 → 172.8). TP1 stays.
//   Runner      The remaining half exits at the trailing SL or trailing TP.
//   Sequence    One swing at a time: after a trail, the NEXT swing high is the
//               one that must break. Earlier highs are done with.
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
  trailCount: number;
  phase: 'rising' | 'pulling';
  swingHigh: number | null;         // favourable spot extreme since the last trail
  pbLowSpot: number | null;         // adverse spot extreme during the current pullback
  premLowSincePeak: number | null;  // adverse PREMIUM extreme since swingHigh was set
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
    tp1Done: false, costMoved: false, trailCount: 0,
    phase: 'rising',
    swingHigh: input.spotNow ?? null,
    pbLowSpot: null, premLowSincePeak: null, lastPrem: null,
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
  if (s.premLowSincePeak === null || fav(s.premDir, ltp, s.premLowSincePeak) < 0) s.premLowSincePeak = ltp;

  // 1. Stop.
  if (fav(s.premDir, ltp, s.sl) <= 0) {
    out.push({ type: 'EXIT_ALL', reason: s.trailCount > 0 || s.costMoved ? 'TRAIL_SL' : 'SL' });
    return out;
  }

  // 2. TP1 — book half, exactly once.
  if (!s.tp1Done && fav(s.premDir, ltp, s.tp1) >= 0) {
    s.tp1Done = true;
    const half = halfQty(s);
    if (half <= 0) {
      // One lot cannot be halved: TP1 is a full exit. Stated to the user.
      out.push({ type: 'EXIT_ALL', reason: 'TARGET' });
      return out;
    }
    s.qtyRemaining = s.qtyTotal - half;
    out.push({ type: 'EXIT_PARTIAL', qty: half, reason: 'TP1_HALF' });
    // If nothing has trailed yet the runner's target is still TP1 itself, and
    // the very next tick would close the runner at the same price — defeating
    // the point of a runner. Lift it by the same 1.2 a trail would apply.
    if (fav(s.premDir, s.tp, s.tp1) <= 0) {
      s.tp = r2(s.premDir === 1 ? s.tp * 1.2 : s.tp * 0.8);
      out.push({ type: 'SET_TP', tp: s.tp, reason: 'TP1_RUNNER_LIFT' });
    }
    return out;
  }

  // 3. Trailing target for the runner.
  if (s.tp1Done && fav(s.premDir, ltp, s.tp) >= 0) {
    out.push({ type: 'EXIT_ALL', reason: 'TRAIL_TP' });
    return out;
  }

  // 4. 70% rule — once.
  if (!s.costMoved) {
    const threshold = s.entry + s.premDir * 0.7 * s.origReward;
    if (fav(s.premDir, ltp, threshold) >= 0) {
      s.costMoved = true;
      if (fav(s.premDir, s.entry, s.sl) > 0) {          // never lower a trailed SL
        s.sl = r2(s.entry);
        out.push({ type: 'SET_SL', sl: s.sl, reason: 'COST_70PCT' });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5-minute spot close: identifies the swing high and the pullback low.
// ---------------------------------------------------------------------------
export function onSpotClose5m(s: TrailState, close: number): TrailAction[] {
  if (!(close > 0)) return [];
  if (s.swingHigh === null) { s.swingHigh = close; s.phase = 'rising'; s.premLowSincePeak = s.lastPrem; return []; }
  if (s.phase === 'rising') {
    if (fav(s.spotDir, close, s.swingHigh) > 0) {
      s.swingHigh = close;
      s.premLowSincePeak = s.lastPrem;   // the pullback's premium low is measured from the peak
    } else if (fav(s.spotDir, s.swingHigh, close) >= s.minPullbackSpot) {
      s.phase = 'pulling';
      s.pbLowSpot = close;
    }
    return [];
  }
  // pulling: deepen the low if it goes further
  if (s.pbLowSpot === null || fav(s.spotDir, s.pbLowSpot, close) > 0) s.pbLowSpot = close;
  return [];
}

// ---------------------------------------------------------------------------
// 1-minute spot close: confirms the break of the swing high and trails.
// ---------------------------------------------------------------------------
export function onSpotClose1m(s: TrailState, close: number): TrailAction[] {
  const out: TrailAction[] = [];
  if (!(close > 0) || s.phase !== 'pulling' || s.swingHigh === null) return out;
  if (fav(s.spotDir, close, s.swingHigh) <= 0) return out;

  // Break confirmed. Where did the premium bottom during this pullback?
  const low = s.premLowSincePeak ?? s.lastPrem;
  if (low !== null) {
    let newSl = low;
    if (s.trailCount === 0 && fav(s.premDir, low, s.entry) > 0) newSl = s.entry;   // first trail: cost to cost
    newSl = r2(newSl);
    if (fav(s.premDir, newSl, s.sl) > 0) {                                        // only ever tighten
      s.sl = newSl;
      out.push({ type: 'SET_SL', sl: s.sl, reason: `TRAIL_${s.trailCount + 1}` });
    }
  }
  s.tp = r2(s.premDir === 1 ? s.tp * 1.2 : s.tp * 0.8);
  out.push({ type: 'SET_TP', tp: s.tp, reason: `TRAIL_${s.trailCount + 1}` });
  s.trailCount += 1;

  // Next swing starts here.
  s.phase = 'rising';
  s.swingHigh = close;
  s.pbLowSpot = null;
  s.premLowSincePeak = s.lastPrem;
  return out;
}
