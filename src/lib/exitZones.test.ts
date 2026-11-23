import { computeExitZones, tradeDirOnChart, typicalRange, type XzCandle } from './exitZones';
let fails = 0; const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log('FAIL', m); } };

// 5-minute candles from 09:15 IST on consecutive days, built from a list of closes (each candle +/-2 around it).
const DAY0 = Date.UTC(2026, 10, 16, 3, 45) / 1000;   // 16 Nov 2026 09:15 IST
const mk = (days: number[][]): XzCandle[] => {
  const out: XzCandle[] = [];
  days.forEach((closes, d) => closes.forEach((c, i) => {
    const prev = i ? closes[i - 1] : c;
    out.push({ time: DAY0 + d * 86400 + i * 300, open: prev, high: Math.max(prev, c) + 2, low: Math.min(prev, c) - 2, close: c });
  }));
  return out;
};
const to15 = (c: XzCandle[]): XzCandle[] => { const o: XzCandle[] = []; for (const k of c) { const b = k.time - (k.time - DAY0) % 900; const l = o[o.length - 1]; if (l && l.time === b) { l.high = Math.max(l.high, k.high); l.low = Math.min(l.low, k.low); l.close = k.close; } else o.push({ ...k, time: b }); } return o; };
const ramp = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + (b - a) * (i + 1) / n);
const flat = (p: number, n: number) => Array.from({ length: n }, (_, i) => p + (i % 2 ? 1 : -1));

// Day 1: up to 200, a long consolidation at 200 (40 candles), down to 100. Day 2: 100, spike to 160 and back to 110, then drifting 110-120.
const d1 = [...ramp(100, 200, 15), ...flat(200, 40), ...ramp(200, 100, 15)];
const d2 = [...flat(100, 8), ...ramp(100, 160, 6), ...ramp(160, 110, 6), ...ramp(110, 120, 20)];
const c5 = mk([d1, d2]), c15 = to15(c5);
const price = c5[c5.length - 1].close;
ok(typicalRange(c5) > 0, 'typical range is positive');

const up = computeExitZones(c5, c15, { dir: 'up', price, entry: price, entryTime: c5[c5.length - 1].time });
ok(up.length >= 2, 'an up trade has zones above: ' + JSON.stringify(up));
ok(up.every(z => z.top > price && z.top > z.bottom && z.near === z.bottom), 'every zone is ahead of an up trade, near edge = bottom');
ok(up.every((z, i) => !i || z.bottom >= up[i - 1].bottom), 'nearest first');
ok(up.every((z, i) => !i || z.bottom >= up[i - 1].top), 'zones do not overlap one another');
const spike = up.find(z => z.top >= 158 && z.bottom <= 164);
ok(!!spike && /swing high/.test(spike!.reasons.join(',')), "today's 160 spike is a swing-high zone: " + JSON.stringify(up));
const box = up.find(z => z.bottom <= 204 && z.top >= 196);
ok(!!box && /consolidation/.test(box!.reasons.join(',')), "yesterday's long range at 200 is a consolidation zone");
ok(!!box && box!.strength !== 'weak', 'a 40-candle range plus the previous day high is not weak');
ok(!!box && /previous day high/.test(box!.reasons.join(',')), 'the previous day high sits in it and is named');

// price that has closed above the spike no longer sees it
const c5b = mk([d1, [...d2, ...ramp(120, 175, 6)]]);
const upB = computeExitZones(c5b, to15(c5b), { dir: 'up', price: 175, entry: 120 });
ok(!upB.some(z => z.top <= 164), 'a zone closed through is gone');

// the mirror image gives the mirror zones
const inv = (c: XzCandle[]) => c.map(k => ({ time: k.time, open: 400 - k.open, high: 400 - k.low, low: 400 - k.high, close: 400 - k.close }));
const dn = computeExitZones(inv(c5), inv(c15), { dir: 'down', price: 400 - price, entry: 400 - price, entryTime: c5[c5.length - 1].time });
ok(dn.length === up.length, 'down trade on the mirrored chart: same number of zones');
ok(dn.every((z, i) => Math.abs(z.top - (400 - up[i].bottom)) < 1e-6 && Math.abs(z.bottom - (400 - up[i].top)) < 1e-6 && z.near === z.top), 'and they are the mirror of the up zones, near edge = top');
ok(dn.some(z => /swing low/.test(z.reasons.join(','))) && dn.some(z => /previous day low/.test(z.reasons.join(','))), 'named as lows');

// the base the trade was entered from is not a zone; nor is anything with too little history
const d3 = [...flat(100, 30), ...ramp(100, 104, 2)];
const c5c = mk([d1, d3]);
const upC = computeExitZones(c5c, to15(c5c), { dir: 'up', price: 101, entry: 100, entryTime: c5c[c5c.length - 3].time });
ok(!upC.some(z => z.bottom <= 100 && z.top >= 100), 'the range the trade came out of is not offered as an exit');
ok(computeExitZones(c5.slice(0, 10), [], { dir: 'up', price: 120 }).length === 0, 'too few candles: nothing');
ok(computeExitZones(c5, c15, { dir: 'up', price, max: 1 }).length === 1, 'max is respected');

ok(tradeDirOnChart('NIFTY26N2425200CE', 'BUY', true) === 'up' && tradeDirOnChart('NIFTY26N2425200PE', 'BUY', true) === 'up', 'on its own chart a bought option gains as the chart rises');
ok(tradeDirOnChart('NIFTY26N2425200CE', 'BUY', false) === 'up' && tradeDirOnChart('NIFTY26N2425200PE', 'BUY', false) === 'down', 'on the index chart a put gains as the index falls');
ok(tradeDirOnChart('NIFTY26N2425200PE', 'SELL', false) === 'up' && tradeDirOnChart('NIFTY26N2425200CE', 'SELL', true) === 'down', 'a sold option is the other way round');
if (fails) { console.log(fails + ' failed'); process.exit(1); } else console.log('exitZones: all checks passed');
