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
//   1. Half the quantity exits at TP1. TP1 NEVER MOVES — it is the level armed
//      on the chart, and dragging the line redefines it.
//   2. At 70% of the way from entry to TP1, the stop moves to entry. Once.
//
// Then a LADDER for the runner, added 8 Sep, gated by the trailTp switch:
//   TP1 hit  -> half exits, stop STAYS at cost, target becomes TP2 = TP1 x 1.2
//   TP2 hit  -> stop to the 70% level of TP1, target becomes TP3 = TP2 x 1.2
//   TP3 hit  -> stop to the 70% level of TP2, target becomes TP4 ... and so on
// The stop deliberately LAGS one rung behind the target: when the target is TPn,
// the stop sits at the 70% level of TP(n-1). That is what makes Martin's "when
// the TP moves to TP2, the SL would be at 70% of TP1" and "and so on" consistent
// with each other, and it is why prevTp is tracked separately from tp.
//
// "70% level of X" means the same thing throughout: entry + 0.7 x (X - entry),
// the price the premium must reach, not 70% of X's face value.
//
// trailTp OFF: the ladder stops after the first rung — TP2 is set and hitting it
// exits the remaining half. ON: it keeps climbing until the stop is hit.
//
// The pullback/structure trailing removed earlier stays removed; this ladder is
// driven purely by the premium reaching a target, nothing else.
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
  trailTp: boolean;       // the switch beside Quick Trade
  rung: number;           // 0 before TP1, 1 after TP1, 2 after TP2 ...
  prevTp: number | null;  // the target hit BEFORE the current one — the stop lags to its 70% level
};

export type TrailAction =
  | { type: 'SET_SL'; sl: number; reason: string }
  | { type: 'SET_TP'; tp: number; reason: string }
  | { type: 'EXIT_PARTIAL'; qty: number; reason: string }
  | { type: 'EXIT_ALL'; reason: string };

const fav = (dir: 1 | -1, a: number, b: number) => dir * (a - b);
const r2 = (x: number) => +x.toFixed(2);
/** The price 70% of the way from entry to a target — the same meaning the cost
 *  move uses, so the ladder and the 70% rule cannot drift apart. */
const seventyLevel = (s: TrailState, target: number) =>
  s.entry + s.premDir * 0.7 * Math.abs(target - s.entry);
/** The next rung: the target PRICE lifted by 20%, which is what "move the TP up
 *  by 20% more" meant — 25.50 became 30.60 on Martin's chart, not 25.50 plus 20%
 *  of the distance from entry. Mirrored for a short, where 20% further from
 *  entry means 20% LOWER. */
const stepTp = (s: TrailState, target: number) =>
  r2(s.premDir === 1 ? target * 1.2 : target * 0.8);

export function createTrailState(input: {
  side: 'BUY' | 'SELL';
  optionType: 'CE' | 'PE';
  entry: number; sl: number; tp: number;
  qty: number; lotSize: number;
  minPullbackSpot: number;
  spotNow: number | null;
  trailTp?: boolean;
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
    trailTp: input.trailTp !== false, rung: 0, prevTp: null,
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
    // The runner's target steps up; the stop STAYS at cost for this rung.
    s.rung = 1;
    s.prevTp = s.tp1;
    s.tp = stepTp(s, s.tp1);
    out.push({ type: 'SET_TP', tp: s.tp, reason: 'TP2' });
    return out;
  }

  // 3. A later target hit — the ladder, or the exit when trailing is off.
  if (s.tp1Done && fav(s.premDir, ltp, s.tp) >= 0) {
    if (!s.trailTp) {
      out.push({ type: 'EXIT_ALL', reason: 'TARGET_TP2' });
      return out;
    }
    // Stop lags one rung: it goes to the 70% level of the target hit BEFORE
    // this one, never above the stop it already has.
    const lagged = s.prevTp !== null ? seventyLevel(s, s.prevTp) : s.entry;
    if (fav(s.premDir, lagged, s.sl) > 0) {
      s.sl = r2(lagged);
      out.push({ type: 'SET_SL', sl: s.sl, reason: `TRAIL_SL_R${s.rung}` });
    }
    s.prevTp = s.tp;
    s.tp = stepTp(s, s.tp);
    s.rung += 1;
    out.push({ type: 'SET_TP', tp: s.tp, reason: `TP${s.rung + 1}` });
    return out;
  }

  // 4. 70% of the way from entry to TP1 -> stop to entry. Once.
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
