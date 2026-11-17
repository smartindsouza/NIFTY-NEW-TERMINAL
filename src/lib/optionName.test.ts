// npx tsx src/lib/optionName.test.ts
import assert from 'node:assert/strict';
import { searchLabel, ordinal, contractName, orderName } from './optionName';

const NOW = Date.UTC(2026, 10, 17, 9, 30, 0);     // 17 Nov 2026, 3:00 PM IST
const row = (tradingsymbol: string, name: string, instrument_type: string, strike: number, expiry: any) => ({ tradingsymbol, name, instrument_type, strike, expiry });

// ── the two lines he asked for, word for word ──
assert.deepEqual(searchLabel(row('NIFTY26N1723500CE', 'NIFTY', 'CE', 23500, '2026-11-17T00:00:00.000Z'), NOW),
  { title: 'NIFTY 17th (w) NOV 23500 CE', sub: '17 NOV WEEKLY' });

// ── a monthly: no (w), MONTHLY ──
assert.deepEqual(searchLabel(row('NIFTY26NOV23500PE', 'NIFTY', 'PE', 23500, '2026-11-23T00:00:00.000Z'), NOW),
  { title: 'NIFTY 23rd NOV 23500 PE', sub: '23 NOV MONTHLY' });
assert.deepEqual(searchLabel(row('BANKNIFTY26NOV57000CE', 'BANKNIFTY', 'CE', 57000, '2026-11-23T00:00:00.000Z'), NOW),
  { title: 'BANKNIFTY 23rd NOV 57000 CE', sub: '23 NOV MONTHLY' });

// ── SENSEX's weekly and monthly; a one-figure day ──
assert.deepEqual(searchLabel(row('SENSEX26N1983000CE', 'SENSEX', 'CE', 83000, '2026-11-19T00:00:00.000Z'), NOW),
  { title: 'SENSEX 19th (w) NOV 83000 CE', sub: '19 NOV WEEKLY' });
assert.deepEqual(searchLabel(row('SENSEX26D0383000PE', 'SENSEX', 'PE', 83000, '2026-12-03T00:00:00.000Z'), NOW),
  { title: 'SENSEX 3rd (w) DEC 83000 PE', sub: '3 DEC WEEKLY' });
assert.deepEqual(searchLabel(row('NIFTY26D0125000CE', 'NIFTY', 'CE', 25000, '2026-12-01T00:00:00.000Z'), NOW),
  { title: 'NIFTY 1st (w) DEC 25000 CE', sub: '1 DEC WEEKLY' });
assert.deepEqual(searchLabel(row('NIFTY26O0625000PE', 'NIFTY', 'PE', 25000, '2026-10-06'), NOW)?.title, 'NIFTY 6th (w) OCT 25000 PE', 'October is O in a weekly');

// ── a name that ends in digits is not a year ──
assert.deepEqual(searchLabel(row('SENSEX5026NOV23500CE', 'SENSEX50', 'CE', 23500, '2026-11-26T00:00:00.000Z'), NOW),
  { title: 'SENSEX50 26th NOV 23500 CE', sub: '26 NOV MONTHLY' });
assert.deepEqual(searchLabel(row('NIFTYNXT5026DEC83000PE', 'NIFTYNXT50', 'PE', 83000, '2026-12-29T00:00:00.000Z'), NOW),
  { title: 'NIFTYNXT50 29th DEC 83000 PE', sub: '29 DEC MONTHLY' });

// ── another year is said, on the second line ──
assert.deepEqual(searchLabel(row('NIFTY27JAN23500CE', 'NIFTY', 'CE', 23500, '2027-01-25T00:00:00.000Z'), NOW),
  { title: 'NIFTY 25th JAN 23500 CE', sub: '25 JAN 2027 MONTHLY' });
assert.equal(searchLabel(row('NIFTY2710525000CE', 'NIFTY', 'CE', 25000, '2027-01-05T00:00:00.000Z'), NOW)?.sub, '5 JAN 2027 WEEKLY');
// the year is India's: at 11 PM on 31 Dec in London it is already next year there
assert.equal(searchLabel(row('NIFTY27JAN23500CE', 'NIFTY', 'CE', 23500, '2027-01-25'), Date.UTC(2026, 11, 31, 23, 0, 0))?.sub, '25 JAN MONTHLY');

// ── futures, shares' options, a strike with a fraction ──
assert.deepEqual(searchLabel(row('NIFTY26NOVFUT', 'NIFTY', 'FUT', 0, '2026-11-23T00:00:00.000Z'), NOW),
  { title: 'NIFTY 23rd NOV FUT', sub: '23 NOV MONTHLY' });
assert.deepEqual(searchLabel(row('RELIANCE26NOV1340CE', 'RELIANCE', 'CE', 1340, '2026-11-23T00:00:00.000Z'), NOW),
  { title: 'RELIANCE 23rd NOV 1340 CE', sub: '23 NOV MONTHLY' });
assert.equal(searchLabel(row('IDEA26NOV12.5PE', 'IDEA', 'PE', 12.5, '2026-11-23'), NOW)?.title, 'IDEA 23rd NOV 12.5 PE');

// ── a saved row with no name, a date object, lower case ──
assert.deepEqual(searchLabel({ tradingsymbol: 'NIFTY26N1723500CE', instrument_type: 'CE', strike: 23500, expiry: '2026-11-17' }, NOW),
  { title: 'NIFTY 17th (w) NOV 23500 CE', sub: '17 NOV WEEKLY' });
assert.equal(searchLabel({ tradingsymbol: 'SENSEX5026NOV23500CE', instrument_type: 'CE', strike: 23500, expiry: '2026-11-26' }, NOW)?.title, 'SENSEX50 26th NOV 23500 CE');
assert.equal(searchLabel(row('NIFTY26N1723500CE', 'NIFTY', 'CE', 23500, new Date('2026-11-17T00:00:00.000Z')), NOW)?.title, 'NIFTY 17th (w) NOV 23500 CE');
assert.equal(searchLabel(row('nifty26n1723500ce', 'nifty', 'ce', 23500, '2026-11-17'), NOW)?.title, 'NIFTY 17th (w) NOV 23500 CE');
// the name the row gives is used only when the symbol begins with it (a share's row names the company)
assert.equal(searchLabel(row('NIFTY26N1723500CE', 'NIFTY 50', 'CE', 23500, '2026-11-17'), NOW)?.title, 'NIFTY 17th (w) NOV 23500 CE');

// ── what is not a dated contract keeps its own lines ──
assert.equal(searchLabel(row('RELIANCE', 'RELIANCE INDUSTRIES', 'EQ', 0, ''), NOW), null);
assert.equal(searchLabel(row('NIFTY 50', 'NIFTY 50', 'EQ', 0, ''), NOW), null);
assert.equal(searchLabel(row('NIFTY26N1723500CE', 'NIFTY', 'CE', 23500, ''), NOW), null, 'no expiry, no label');
assert.equal(searchLabel(row('NIFTY26N1723500CE', 'NIFTY', 'CE', 23500, 'soon'), NOW), null);
assert.equal(searchLabel(row('NIFTY26N1723500CE', 'NIFTY', 'CE', 0, '2026-11-17'), NOW), null, 'an option with no strike');
assert.equal(searchLabel(null, NOW), null);
assert.equal(searchLabel(row('NIFTY26N1723500CE', 'NIFTY', 'CE', 23500, new Date('x')), NOW), null);

// ── the day's ending ──
assert.deepEqual([1, 2, 3, 4, 10, 11, 12, 13, 14, 20, 21, 22, 23, 24, 30, 31].map(ordinal),
  ['1st', '2nd', '3rd', '4th', '10th', '11th', '12th', '13th', '14th', '20th', '21st', '22nd', '23rd', '24th', '30th', '31st']);

// ── the names this file already made are what they were ──
assert.equal(contractName('NIFTY2692223350CE'), 'NIFTY 23350 CE 22 SEP');
assert.equal(orderName('NIFTY26N1725250CE'), 'NIFTY 17 Nov 26 - 25250 CE');

console.log('optionName: all checks passed');
