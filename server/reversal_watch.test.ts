// Reversal watch: pure rules + a replay of real 5-min candles. Run: npx tsx server/reversal_watch.test.ts [snapshot.json]
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { tradeDir, swings, structureLevel, reversalHit, time12 } from './reversal_watch';

assert.equal(tradeDir('NIFTY25N1825200PE', 65), 'bear');
assert.equal(tradeDir('NIFTY25N1825200CE', 65), 'bull');
assert.equal(tradeDir('NIFTY25N1825200PE', -65), 'bull');
assert.equal(tradeDir('NIFTY25N1825200CE', -65), 'bear');
assert.equal(tradeDir('NIFTY25NOVFUT', 65), null);
assert.equal(time12(Date.parse('2026-11-11T14:55:00+05:30')), '2:55 PM');
assert.equal(time12(Date.parse('2026-11-11T09:15:00+05:30')), '9:15 AM');
assert.equal(time12(Date.parse('2026-11-11T12:05:00+05:30')), '12:05 PM');

const T0 = Date.parse('2026-11-11T09:15:00+05:30');
const mk = (rows: number[][]) => rows.map(([h, l, c], i) => ({ t: T0 + i * 300000, o: c, h, l, c }));
// a clean swing low at index 3 (95), then a candle closing below it
const up = mk([[110, 100, 105], [108, 98, 100], [104, 97, 99], [100, 95, 97], [103, 96, 101], [106, 99, 104], [107, 100, 105], [105, 92, 93]]);
assert.equal(swings(up.slice(0, -1)).lows.at(-1)!.p, 95);
assert.equal(structureLevel(up, 'bull', T0), 95);
assert.deepEqual(reversalHit(up, 'bull', T0), { level: 95, close: 93, at: up.at(-1)!.t });
// a wick through without a close is not a reversal
const wick = up.slice(0, -1).concat([{ ...up.at(-1)!, c: 96 }]);
assert.equal(reversalHit(wick, 'bull', T0), null);
// a candle that closed before the trade started never alerts
assert.equal(reversalHit(up, 'bull', up.at(-1)!.t + 300000), null);
console.log('reversal_watch: rules ok');

// ── replay today's real NIFTY candles ──
const f = process.argv[2] || '/tmp/claude-0/snapnow.json';
if (existsSync(f)) {
  const s = JSON.parse(readFileSync(f, 'utf8'));
  const n = s.nifty.today_5m.map((x: any) => ({ t: Date.parse(x.t), o: x.o, h: x.h, l: x.l, c: x.c }));
  const replay = (dir: 'bull' | 'bear', entryHHMM: string) => {
    const entry = Date.parse(`${s.nifty.today_5m[0].t.slice(0, 10)}T${entryHHMM}:00+05:30`);
    for (let k = 1; k <= n.length; k++) {
      const c = n.slice(0, k); if (c.at(-1).t + 300000 <= entry) continue;
      const h = reversalHit(c, dir, entry);
      if (h) return `${dir} from ${entryHHMM}: alert at ${time12(h.at + 300000)} — close ${h.close} vs swing ${h.level}`;
    }
    return `${dir} from ${entryHHMM}: no alert`;
  };
  for (const [d, t] of [['bull', '09:40'], ['bull', '12:45'], ['bear', '12:10'], ['bear', '13:35'], ['bear', '14:50']] as const) console.log('  ', replay(d, t));
}
