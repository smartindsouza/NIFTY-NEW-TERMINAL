// The all-strike OI totals carried through the chain analytics. Run: npx tsx server/analytics_engine.test.ts
import assert from 'node:assert/strict';
import { computeAnalytics } from './analytics_engine';

const leg = (k: number, type: 'CE' | 'PE', oi: number): any => ({ strikePrice: k, type, oi, ltp: 10, chgLtp: 0, chgOi: null, volume: 0, iv: 15 });
const strikes = [25000, 25050, 25100];
const chain = {
  spot: 25060, strikes,
  ceData: { 25000: leg(25000, 'CE', 10), 25050: leg(25050, 'CE', 30), 25100: leg(25100, 'CE', 60) } as any,
  peData: { 25000: leg(25000, 'PE', 50), 25050: leg(25050, 'PE', 20), 25100: leg(25100, 'PE', 10) } as any,
};
// no all-strike figures (simulated chain, or the first seconds after start): the near-strike totals, labelled as such
let a = computeAnalytics(chain);
assert.equal(a.totalCeOi, 100); assert.equal(a.totalPeOi, 80); assert.equal(a.pcr, 0.8);
assert.equal(a.totalCeOiAll, 100); assert.equal(a.totalPeOiAll, 80); assert.equal(a.pcrAll, 0.8); assert.equal(a.oiScope, 'near'); assert.equal(a.oiStrikes, 3);
// with them: shown beside, and NOTHING the decision uses moves
const b = computeAnalytics({ ...chain, oiAll: { ce: 126.5, pe: 120.4, strikes: 201, asOf: 1 } });
assert.equal(b.totalCeOiAll, 126.5); assert.equal(b.totalPeOiAll, 120.4); assert.equal(b.pcrAll, 0.95); assert.equal(b.oiScope, 'all'); assert.equal(b.oiStrikes, 201);
for (const k of ['totalCeOi', 'totalPeOi', 'pcr', 'maxPain', 'marketBias', 'confidence'] as const) assert.deepEqual(b[k], a[k], `${k} is unchanged by the all-strike totals`);
assert.deepEqual(b.tradeSignal, a.tradeSignal); assert.deepEqual(b.supportZone, a.supportZone); assert.deepEqual(b.resistanceZone, a.resistanceZone);
// a total smaller than the strikes it contains is a bad read: not shown
a = computeAnalytics({ ...chain, oiAll: { ce: 90, pe: 200, strikes: 201, asOf: 1 } });
assert.equal(a.oiScope, 'near'); assert.equal(a.totalCeOiAll, 100); assert.equal(a.totalPeOiAll, 80);
a = computeAnalytics({ ...chain, oiAll: { ce: NaN, pe: 200, strikes: 201, asOf: 1 } }); assert.equal(a.oiScope, 'near');
a = computeAnalytics({ ...chain, oiAll: null }); assert.equal(a.oiScope, 'near');
console.log('analytics_engine: all checks passed');
