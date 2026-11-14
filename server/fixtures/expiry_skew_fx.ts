// Shared by expiry_skew.test.ts and expiry_skew.e2e.ts: the recorded day and the
// 62 days of research readings before it, in the shapes the real feeds use.
import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { DayBuilder, addDhanLeg, DhanLeg, DayData } from '../expiry_skew_calc';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f: string) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, f))).toString());
export const FX = load('expiry_skew_day.json.gz'), HIST = load('expiry_skew_hist.json.gz');
export const num = (v: any) => (v === null || v === undefined ? NaN : Number(v));

/** The day as Dhan's API returns it (the file stores one shared clock and one spot series to stay small). */
export function dhanLegs(fx: any = FX): { side: 'CE' | 'PE'; offset: string; leg: DhanLeg }[] {
  const spot = fx.legs[0].spot;
  return fx.legs.map((l: any) => ({ side: l.side, offset: l.offset, leg: { timestamp: Array.from({ length: l.n }, (_, i) => fx.t0 + 60 * i), open: l.open, close: l.close, volume: l.volume, oi: l.oi, strike: l.strike, spot } }));
}
/** The day through the vendor path. zerodhaIndex = score it on the Zerodha index, as the research did. */
export function vendorDay(fx: any = FX, zerodhaIndex = true): DayData {
  const m = new Map<string, DayBuilder>();
  for (const l of dhanLegs(fx)) addDhanLeg(m, l.side, l.leg, () => fx.expiry);
  const d = m.get(fx.day)!.finish();
  if (zerodhaIndex) d.spotClose = Float64Array.from(fx.spotClose.map(num));
  return d;
}
