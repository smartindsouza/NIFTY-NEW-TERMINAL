// npx tsx src/lib/optionGreeks.test.ts
import assert from 'node:assert/strict';
import { yearsToExpiry, bsPrice, impliedVol, optionGreeks, greeksAt } from './optionGreeks';

// ── the time left ──
{
  // 16 Nov 2026, 5:44 PM IST (12:14 UTC) to 17 Nov 3:30 PM IST: 21 h 46 min.
  const now = Date.UTC(2026, 10, 16, 12, 14, 0);
  const y = yearsToExpiry('2026-11-17', now);
  assert.ok(Math.abs(y * 365 * 24 - (21 + 46 / 60)) < 1e-9, 'clock time to 3:30 PM IST on the expiry day');
  assert.equal(yearsToExpiry('2026-11-17T00:00:00.000Z', now), y, 'a date with a time after it is the same day');
  assert.ok(yearsToExpiry('2026-11-17', Date.UTC(2026, 10, 17, 12, 0, 0)) > 0, 'never nothing, even after the close');
  assert.ok(Number.isNaN(yearsToExpiry('soon', now)));
}

// ── Lemonn's own figures, off Martin's recording of 16 Nov 2026, 5:44 PM ──
{
  const S = 25291.10, T = yearsToExpiry('2026-11-17', Date.UTC(2026, 10, 16, 12, 14, 0));
  const K = [25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450, 25500];
  const C = [260.70, 218.25, 178.60, 142.00, 108.90, 82.00, 61.10, 45.20, 32.50, 23.85];
  const P = [15.85, 22.10, 31.75, 44.90, 63.05, 85.90, 114.00, 147.60, 184.70, 224.65];
  const IVC = [17.08, 17.06, 16.98, 16.78, 16.47, 16.50, 16.79, 17.21, 17.52, 18.09];
  const IVP = [18.02, 17.43, 17.11, 16.85, 16.79, 16.76, 16.86, 17.18, 17.43, 17.58];
  K.forEach((k, i) => {
    const c = impliedVol(S, k, T, C[i], true)!, p = impliedVol(S, k, T, P[i], false)!;
    assert.ok(Math.abs(c * 100 - IVC[i]) < 0.15, `${k} call IV ${(c * 100).toFixed(2)} against their ${IVC[i]}`);
    assert.ok(Math.abs(p * 100 - IVP[i]) < 0.15, `${k} put IV ${(p * 100).toFixed(2)} against their ${IVP[i]}`);
  });
  const near = (mine: number, theirs: number, name: string) => assert.ok(Math.abs(mine - theirs) <= Math.abs(theirs) * 0.02 + 0.002, `${name}: ${mine.toFixed(4)} against their ${theirs}`);
  const c = optionGreeks(S, 25050, T, 260.70, true)!, p = optionGreeks(S, 25050, T, 15.85, false)!;
  near(c.vega, 2.5903, 'call vega'); near(c.theta, -30.2241, 'call theta'); near(c.rho, 0.5477, 'call rho');
  near(p.vega, 2.7703, 'put vega'); near(p.theta, -26.3810, 'put theta'); near(p.rho, -0.0869, 'put rho');
  assert.ok(c.delta > 0.8 && c.delta < 0.95 && p.delta < -0.05 && p.delta > -0.2, 'deltas of an in-the-money call and its put');
  assert.ok(c.gamma > 0 && p.gamma > 0);
}

// ── the solver ──
{
  const T = 5 / 365;
  for (const vol of [0.08, 0.15, 0.4, 1.2]) for (const k of [24800, 25300, 25800]) for (const isCall of [true, false]) {
    const price = bsPrice(25300, k, T, vol, isCall);
    if (price < 0.05) continue;                      // too little premium to carry a volatility
    const back = impliedVol(25300, k, T, price, isCall)!;
    assert.ok(Math.abs(back - vol) < 1e-3, `a price made at ${vol} is solved back to it (${k} ${isCall ? 'call' : 'put'}: ${back})`);
  }
  assert.equal(impliedVol(25300, 25000, T, 250, true), null, 'a call priced under what it is worth exercised implies nothing');
  assert.equal(impliedVol(25300, 25000, T, 0, true), null);
  assert.equal(optionGreeks(25300, 25000, T, 0, false), null);
  assert.equal(impliedVol(0, 25000, T, 10, true), null);
  // call delta less put delta is one, at one volatility
  const a = greeksAt(25300, 25300, T, 0.15, true), b = greeksAt(25300, 25300, T, 0.15, false);
  assert.ok(Math.abs(a.delta - b.delta - 1) < 1e-6 && Math.abs(a.gamma - b.gamma) < 1e-12 && Math.abs(a.vega - b.vega) < 1e-9);
}

console.log('optionGreeks: all checks passed');
