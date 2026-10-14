// Candles for candle-based chart indicators (Swap-Sweep, Directional Zones).
//
// The chart holds two sources: the HISTORY it fetched (whose last bar was still
// forming at fetch time) and an ARCHIVE of candles that closed live afterwards,
// which the 15s closed-bar audit also REPAIRS in place (a wick the ticks missed).
// Indicators must see one series: the history overlaid BY TIME with the archive,
// so a later, finished or repaired version of a candle always wins. And they must
// recompute when any recent archived candle CHANGES, not only when one is added —
// archiveFingerprint covers the newest entries' values for exactly that.

import { ssTime } from './swapSweep';

export function mergeLiveCandles(base: any[], arc: any[]): any[] {
  if (!arc || !arc.length) return (base || []).slice();
  const m = new Map<number, any>();
  for (const c of base || []) m.set(ssTime(c.time), c);
  for (const c of arc) {
    const t = ssTime(c.time);
    m.set(t, c.time === t ? c : { ...c, time: t });
  }
  return [...m.values()].sort((a: any, b: any) => a.time - b.time);
}

export function archiveFingerprint(arc: any[], depth = 8): string {
  let fp = String(arc.length);
  for (let i = Math.max(0, arc.length - depth); i < arc.length; i++) {
    const k = arc[i];
    fp += `|${k.time}:${k.open}:${k.high}:${k.low}:${k.close}`;
  }
  return fp;
}
