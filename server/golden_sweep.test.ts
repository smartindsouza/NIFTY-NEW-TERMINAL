// Replays 2 years of NIFTY 15-min candles through the LIVE detector and checks it
// finds exactly the signals the research found, with the same graded result.
//   GZ_DATA=<hist15.json> GZ_REF=<gz_ref.json> npx tsx server/golden_sweep.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { atrSeries, detectAt, grade, type Bar } from './golden_sweep';
const rows: number[][] = JSON.parse(fs.readFileSync(process.env.GZ_DATA!, 'utf8')).rows;
const ref: [number, number][] = JSON.parse(fs.readFileSync(process.env.GZ_REF!, 'utf8'));
const IST = 5.5 * 3600000, day = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const b: Bar[] = rows.map(r => ({ t: r[0], open: r[1], high: r[2], low: r[3], close: r[4] }));
const atr = atrSeries(b);
const found: [number, number][] = []; const pts: number[] = [];
for (let t = 0; t < b.length - 1; t++) {
  if (day(b[t + 1].t) !== day(b[t].t)) continue;          // C3 must not be the day's last candle
  const s = detectAt(b, t, atr);
  if (!s) continue;
  found.push([s.c3, s.dir]);
  const g = grade(b, s, true); if (g && g.pts != null) pts.push(g.pts);
}
const key = (x: [number, number]) => `${x[0]}:${x[1]}`;
const A = new Set(found.map(key)), B = new Set(ref.map(key));
const missing = [...B].filter(k => !A.has(k)), extra = [...A].filter(k => !B.has(k));
console.log(`live detector: ${found.length} signals | research: ${ref.length} | missing ${missing.length} | extra ${extra.length}`);
assert.equal(missing.length, 0, 'signals the research found that the live detector misses: ' + missing.slice(0, 5));
assert.equal(extra.length, 0, 'signals only the live detector finds: ' + extra.slice(0, 5));
const avg = pts.reduce((a, v) => a + v, 0) / pts.length;
console.log(`graded ${pts.length}: avg ${avg.toFixed(2)} pts after costs, wins ${pts.filter(p => p > 0).length}`);
assert.equal(pts.length, 74); assert.ok(Math.abs(avg - 12.28) < 0.05, `avg ${avg} vs research 12.28`);
console.log('ok — the live rule is the tested rule');
