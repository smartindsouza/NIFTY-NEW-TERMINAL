// The stop-loss ladder for Telegram-signal trades. PURE: price in, decisions out.
//
// Martin's rule (23 Oct 2026), for a long option bought on a channel call:
//   • the SL is exactly the one in the message;
//   • TP1 hit  → SL to the entry price (the actual fill);
//   • TP2 hit  → SL to TP1;
//   • TP3 hit  → SL to TP2, and ASK him: exit now, or keep trailing?
//   • KEEP     → the ladder carries on above TP3 in steps of (TP3 − TP2):
//                each new step reached lifts the SL to the previous one.
//   • no answer → SL stays at TP2 until the 15:15 square-off.
// There is NO target exit. Exits happen only through the SL (the existing
// premium-exit engine, which this ladder feeds), the Exit button, his "exit"
// answer at TP3, or the square-off.
//
// The SL only ever moves UP. A price that gaps through several targets in one
// tick moves the ladder through all of them at once.

export interface LadderState {
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
  | { type: 'ASK_TP3' };

export function createLadder(entry: number, sl: number, tps: [number, number, number]): LadderState {
  return { entry, sl, tps, stage: 0, decision: null, stepsAbove: 0, peak: entry };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function raise(st: LadderState, to: number, reason: string, out: LadderAction[]) {
  const v = r2(to);
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
  if (st.stage < 1 && ltp >= t1) { st.stage = 1; raise(st, st.entry, 'TP1 hit — SL to entry', out); }
  if (st.stage < 2 && ltp >= t2) { st.stage = 2; raise(st, t1, 'TP2 hit — SL to TP1', out); }
  if (st.stage < 3 && ltp >= t3) {
    st.stage = 3; raise(st, t2, 'TP3 hit — SL to TP2', out);
    if (st.decision === null) { st.decision = 'PENDING'; out.push({ type: 'ASK_TP3' }); }
  }
  applyKeepSteps(st, out);
  return out;
}

/** Martin pressed "Keep trailing". */
export function keepTrailing(st: LadderState): LadderAction[] {
  const out: LadderAction[] = [];
  if (st.stage < 3) return out;
  st.decision = 'KEEP';
  applyKeepSteps(st, out);
  return out;
}
