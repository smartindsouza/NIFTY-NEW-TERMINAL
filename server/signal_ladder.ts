// The stop-loss ladder for Telegram-signal trades. PURE: price in, decisions out.
//
// Martin's rule (23 Oct 2026), for a long option bought on a channel call:
//   • the SL is exactly the one in the message;
//   • TP1 hit  → SL to the entry price (the actual fill);
//   • TP2 hit  → SL to TP1;
//   • TP3 hit  → SL to TP2, and trailing switches ON by itself (30 Oct 2026,
//                Martin: "enable trailing SL by default after TP3"). Until then
//                he was asked Exit / Keep at TP3 and, with no answer, the SL sat
//                at TP2 however far the price ran — a move he had to catch by
//                hand. Now the alert only offers Exit; doing nothing trails.
//   • trailing → the ladder carries on above TP3 in steps of (TP3 − TP2):
//                each new step reached lifts the SL to the previous one.
// There is NO target exit. Exits happen only through the SL (the existing
// premium-exit engine, which this ladder feeds), the Exit button, his "exit"
// answer at TP3, or the square-off.
//
// The SL only ever moves UP. A price that gaps through several targets in one
// tick moves the ladder through all of them at once.

// RULE SET "double" (4 Nov 2026, Martin — Telegram channel trades):
//   • TP1 hit  → SL to the entry (and, when the trade holds 2 or more lots, half
//                of them are sold — in signal_trader.ts; one lot sells nothing)
//   • TP2 hit  → nothing moves: the SL stays at the entry
//   • TP3 hit  → SL to TP1
//   • price reaches 2 × entry (the capital used has doubled) → everything left is sold
// No trailing above TP3 and no question at TP3. "classic" (above) is kept for
// My Order trades and for any trade saved before this change.
export type LadderRules = 'classic' | 'double';

export interface LadderState {
  rules?: LadderRules;
  // TRAILING SL OFF (27 Nov 2026, Martin: "Add an option to disable trailing SL
  // in Telegram Auto trade so that I can disable it and move the SL line
  // manually. Keep the TP lines as it is."). While true the ladder still tracks
  // which targets were reached — TP1's half-booking, the TP lines on the chart
  // and the 2 × entry exit carry on — but it never moves the stop: the SL stays
  // wherever it is (the message's, or wherever he drags it). Absent = on, so
  // every trade saved before this keeps trailing.
  trailOff?: boolean;           // absent = classic (states saved before 4 Nov)
  target?: number;               // double: 2 × entry
  targetHit?: boolean;
  entry: number;                 // actual average fill price
  sl: number;                    // current stop
  tps: [number, number, number];
  stage: 0 | 1 | 2 | 3;          // how many TPs have been reached
  decision: 'PENDING' | 'KEEP' | 'EXIT' | null; // null until TP3
  stepsAbove: number;            // KEEP only: how many (TP3−TP2) steps above TP3 reached
  peak: number;                  // highest price seen since entry
}

export type LadderAction =
  | { type: 'SET_SL'; sl: number; reason: string }
  | { type: 'TP3_TRAILING' }
  | { type: 'NOTE'; reason: string }
  | { type: 'TARGET'; target: number };

export function createLadder(entry: number, sl: number, tps: [number, number, number], rules: LadderRules = 'classic'): LadderState {
  const st: LadderState = { entry, sl, tps, stage: 0, decision: null, stepsAbove: 0, peak: entry };
  if (rules === 'double') { st.rules = 'double'; st.target = Math.round(entry * 2 * 20) / 20; st.targetHit = false; }
  return st;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function raise(st: LadderState, to: number, reason: string, out: LadderAction[]) {
  const v = r2(to);
  if (st.trailOff) {
    // The step is still reported (once per target, not per trail step above TP3),
    // so he knows a target was reached and that the stop was left where he put it.
    if (v > st.sl && !/^trail step/.test(reason)) out.push({ type: 'NOTE', reason: `${reason.split(' — ')[0]} — trailing SL is off, SL stays` });
    return;
  }
  if (v > st.sl) { st.sl = v; out.push({ type: 'SET_SL', sl: v, reason }); }
}

/** Steps above TP3, applied only once Martin has said KEEP. Uses the PEAK, so a
 *  "keep" pressed after the price has already run up catches the ladder up at
 *  once instead of waiting for the next new high. */
function applyKeepSteps(st: LadderState, out: LadderAction[]) {
  if (st.decision !== 'KEEP') return;
  const [, t2, t3] = st.tps;
  const step = t3 - t2;
  if (!(step > 0)) return;
  const reached = Math.floor((st.peak - t3) / step + 1e-9);
  while (st.stepsAbove < reached) {
    st.stepsAbove++;
    // reaching level k lifts the SL to level k−1 (level 0 is TP3 itself)
    raise(st, t3 + (st.stepsAbove - 1) * step, `trail step ${st.stepsAbove} above TP3`, out);
  }
}

export function onLadderPrice(st: LadderState, ltp: number): LadderAction[] {
  const out: LadderAction[] = [];
  if (!(ltp > 0)) return out;
  if (ltp > st.peak) st.peak = ltp;
  const [t1, t2, t3] = st.tps;
  if (st.rules === 'double') {
    if (st.stage < 1 && ltp >= t1) { st.stage = 1; raise(st, st.entry, 'TP1 hit — SL to entry', out); }
    if (st.stage < 2 && ltp >= t2) { st.stage = 2; out.push({ type: 'NOTE', reason: 'TP2 hit — SL stays at entry' }); }
    if (st.stage < 3 && ltp >= t3) { st.stage = 3; raise(st, t1, 'TP3 hit — SL to TP1', out); }
    if (!st.targetHit && st.target && ltp >= st.target) { st.targetHit = true; out.push({ type: 'TARGET', target: st.target }); }
    return out;
  }
  if (st.stage < 1 && ltp >= t1) { st.stage = 1; raise(st, st.entry, 'TP1 hit — SL to entry', out); }
  if (st.stage < 2 && ltp >= t2) { st.stage = 2; raise(st, t1, 'TP2 hit — SL to TP1', out); }
  if (st.stage < 3 && ltp >= t3) {
    st.stage = 3; raise(st, t2, 'TP3 hit — SL to TP2', out);
    if (st.decision === null || st.decision === 'PENDING') { st.decision = 'KEEP'; out.push({ type: 'TP3_TRAILING' }); }
  }
  // A trade saved by the old version while it waited for an answer at TP3
  // (stage 3, PENDING) trails from its next price too, without a second alert.
  if (st.stage >= 3 && st.decision === 'PENDING') st.decision = 'KEEP';
  applyKeepSteps(st, out);
  return out;
}

/** The trailing SL switch, on an open trade. OFF: the stop stays where it is.
 *  ON again: the stop catches up at once with the targets already reached, as if
 *  it had been on all along — but only ever upwards, so a stop he dragged above
 *  that level is kept. */
export function setTrailing(st: LadderState, on: boolean): LadderAction[] {
  const out: LadderAction[] = [];
  st.trailOff = !on;
  if (!on) return out;
  const [t1, t2] = st.tps;
  if (st.rules === 'double') {
    if (st.stage >= 3) raise(st, t1, 'trailing SL back on — SL to TP1', out);
    else if (st.stage >= 1) raise(st, st.entry, 'trailing SL back on — SL to entry', out);
    return out;
  }
  if (st.stage >= 3) raise(st, t2, 'trailing SL back on — SL to TP2', out);
  else if (st.stage >= 2) raise(st, t1, 'trailing SL back on — SL to TP1', out);
  else if (st.stage >= 1) raise(st, st.entry, 'trailing SL back on — SL to entry', out);
  // The steps above TP3 were counted while off without moving the stop; count
  // them again from the peak so the stop catches up (raise only ever lifts it).
  st.stepsAbove = 0;
  applyKeepSteps(st, out);
  return out;
}

/** Martin pressed "Keep trailing". */
export function keepTrailing(st: LadderState): LadderAction[] {
  const out: LadderAction[] = [];
  if (st.stage < 3 || st.rules === 'double') return out;
  st.decision = 'KEEP';
  applyKeepSteps(st, out);
  return out;
}
