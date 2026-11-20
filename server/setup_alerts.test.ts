// dueAlerts: an alert is due only for a breaker / Swap-Sweep that the last two closed
// candles made, at most twelve minutes after its candle closed — never an old one.
import { dueAlerts } from './setup_alerts';
import { computeBreakersAndGrabs, BL_DEFAULTS } from '../src/indicators/breakerLiquidity';
import { detectSwapSweep } from '../src/lib/swapSweep';
let fails = 0; const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log('FAIL', m); } };
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const tf = 5; const c: any[] = []; let p = 24000; const t0 = Date.UTC(2026, 10, 2, 3, 45) / 1000;
for (let i = 0; i < 1500; i++) { const o = p; const cl = o + (rnd() - 0.5) * 60; c.push({ time: t0 + i * tf * 60, open: o, high: Math.max(o, cl) + rnd() * 20, low: Math.min(o, cl) - rnd() * 20, close: cl }); p = cl; }
const idxOf = (t: number) => c.findIndex((k) => k.time === t);
const bb = computeBreakersAndGrabs(c, BL_DEFAULTS).breakers.filter((b) => idxOf(b.breakTime) > 300).slice(0, 5);
const ss = detectSwapSweep(c).filter((s) => s.idx > 300).slice(0, 5);
ok(bb.length > 0 && ss.length > 0, `synthetic data has breakers (${bb.length}) and swap-sweeps (${ss.length})`);
const check = (i: number, idPrefix: string) => {
  const closeMs = (c[i].time + tf * 60) * 1000;
  const due = (n: number, now: number) => dueAlerts(c.slice(0, n), tf, now).some((a) => a.id.startsWith(idPrefix));
  ok(due(i + 1, closeMs + 60000), `${idPrefix} due right after its candle closes`);
  ok(due(i + 2, closeMs + 6 * 60000), `${idPrefix} still due one candle later`);
  ok(!due(i + 3, closeMs + 11 * 60000), `${idPrefix} not due two candles later`);
  ok(!due(i + 1, closeMs + 13 * 60000), `${idPrefix} not due after twelve minutes`);
};
for (const b of bb) check(idxOf(b.breakTime), `bb|5|${b.dir}|${b.breakTime}`);
for (const s of ss) check(s.idx, `ss|5|${s.kind}|${c[s.idx].time}`);
const one = dueAlerts(c.slice(0, idxOf(bb[0].breakTime) + 1), tf, (bb[0].breakTime + 360) * 1000).find((a) => a.kind === 'breaker')!;
console.log('sample:', one.title, '|', one.body);
ok(/^🧱 NIFTY 5m · (Bullish|Bearish) breaker block$/.test(one.title), 'title format');
ok(dueAlerts(c.slice(0, 2), tf, Date.now()).length === 0, 'too few candles: nothing');
if (fails) { console.log(fails + ' failed'); process.exit(1); } else console.log('all checks passed');
