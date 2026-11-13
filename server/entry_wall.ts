// THE ENTRY IS A WALL UNTIL TP1 (30 Oct 2026, Martin). Before a trade's first
// target is reached, its target may not be set below the entry (mirrored for a
// short). Pure, so it can be tested on its own; used by POST /api/premium-exit/set.
// The chart stops the lines in the same places.
//
// THE STOP MAY NOW CROSS THE ENTRY TO LOCK PROFIT (13 Nov 2026, Martin). The wall
// used to hold the stop too, so with a trade well in profit but short of TP1 the
// SL line stopped dead at the entry and a drag above it was refused — on the day,
// a PE bought at 172 could not have its stop lifted past 172. The reason for the
// wall was that a stop above the entry "is not a stop"; that is only true while
// the premium is below it. So the stop may sit above the entry whenever the live
// premium is still beyond it. What stays refused is a stop at or past the live
// premium, which would sell the position the instant it was armed, and a stop
// above the entry when the live premium is not known.
export function entryWallError(o: { long: boolean; entry: number; sl: number; tp: number; slOn: boolean; tpOn: boolean; tp1Hit: boolean; ltp?: number | null }): string | null {
  const { long, entry, sl, tp, slOn, tpOn, tp1Hit } = o;
  if (!(entry > 0) || tp1Hit) return null;
  if (slOn && (long ? sl > entry + 0.001 : sl < entry - 0.001)) {
    const ltp = Number(o.ltp);
    if (!(ltp > 0)) return `SL can't be ${long ? 'above' : 'below'} the entry (${entry}) until the live price is known.`;
    if (long ? sl >= ltp - 0.001 : sl <= ltp + 0.001) return `SL (${sl}) must stay ${long ? 'below' : 'above'} the current price (${ltp}), or it would exit at once.`;
  }
  if (tpOn && (long ? tp < entry - 0.001 : tp > entry + 0.001)) return `Target can't be ${long ? 'below' : 'above'} the entry (${entry}) until TP1 is hit.`;
  return null;
}
