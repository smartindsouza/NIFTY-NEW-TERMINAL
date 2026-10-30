// THE ENTRY IS A WALL UNTIL TP1 (30 Oct 2026, Martin). Before a trade's first
// target is reached, its stop may not be set above the entry and its target not
// below it (mirrored for a short). Pure, so it can be tested on its own; used by
// POST /api/premium-exit/set. The chart stops the lines at the entry too.
export function entryWallError(o: { long: boolean; entry: number; sl: number; tp: number; slOn: boolean; tpOn: boolean; tp1Hit: boolean }): string | null {
  const { long, entry, sl, tp, slOn, tpOn, tp1Hit } = o;
  if (!(entry > 0) || tp1Hit) return null;
  if (slOn && (long ? sl > entry + 0.001 : sl < entry - 0.001)) return `SL can't be ${long ? 'above' : 'below'} the entry (${entry}) until TP1 is hit.`;
  if (tpOn && (long ? tp < entry - 0.001 : tp > entry + 0.001)) return `Target can't be ${long ? 'below' : 'above'} the entry (${entry}) until TP1 is hit.`;
  return null;
}
