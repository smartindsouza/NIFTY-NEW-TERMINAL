// npx tsx server/instrument_search.test.ts
import assert from 'node:assert/strict';
import { rankInstruments, isWeeklySymbol, expiryParts, type SearchRow } from './instrument_search';

// ── a contract file shaped like Zerodha's, in its order: BSE, BFO, NSE, NFO ──
// (17 Nov 2026: NIFTY's weekly is that day, its November monthly the 23rd, the
// 24th being a holiday; SENSEX's weekly is the 19th and its monthly the 26th.)
const D = (s: string) => new Date(s + 'T00:00:00.000Z');
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
let tok = 1000;
const all: SearchRow[] = [];
const cash = (exchange: string, tradingsymbol: string, name: string, segment = exchange) =>
  all.push({ instrument_token: String(tok++), tradingsymbol, name, last_price: 0, expiry: '', strike: 0, lot_size: 0, instrument_type: 'EQ', segment, exchange });
const code = (name: string, e: string, weekly: boolean) => {
  const d = D(e), yy = String(d.getUTCFullYear()).slice(2);
  return name + yy + (weekly ? '123456789OND'[d.getUTCMonth()] + String(d.getUTCDate()).padStart(2, '0') : MON[d.getUTCMonth()]);
};
const fut = (exchange: string, name: string, e: string) =>
  all.push({ instrument_token: String(tok++), tradingsymbol: code(name, e, false) + 'FUT', name, last_price: 0, expiry: D(e), strike: 0, lot_size: 1, instrument_type: 'FUT', segment: exchange + '-FUT', exchange });
const options = (exchange: string, name: string, e: string, weekly: boolean, from: number, to: number, step: number) => {
  for (let k = from; k <= to; k += step) for (const t of ['CE', 'PE'])
    all.push({ instrument_token: String(tok++), tradingsymbol: code(name, e, weekly) + k + t, name, last_price: 0, expiry: D(e), strike: k, lot_size: 1, instrument_type: t, segment: exchange + '-OPT', exchange });
};

cash('BSE', 'SENSEX', 'SENSEX', 'INDICES');
cash('BSE', 'RELIANCE', 'RELIANCE INDUSTRIES');
cash('BSE', 'BANKNIFTY1', 'KOTAK NIFTY BANK ETF');
for (let n = 1; n <= 60; n++) cash('BSE', 'NIFTYF' + String(n).padStart(2, '0'), `FUND ${String(n).padStart(2, '0')} NIFTY 50 ETF`);
for (const e of ['2026-11-26', '2026-12-31', '2027-01-28']) { fut('BFO', 'SENSEX', e); }
for (const e of ['2026-11-26', '2026-12-31', '2027-01-28']) { fut('BFO', 'SENSEX50', e); }
for (const e of ['2026-11-26', '2026-12-31', '2027-01-28']) options('BFO', 'SENSEX50', e, false, 20000, 30000, 50);
for (const e of ['2026-11-26', '2026-12-31', '2027-01-28']) options('BFO', 'BANKEX', e, false, 50000, 70000, 100);
options('BFO', 'SENSEX', '2026-11-19', true, 70000, 95000, 100);
options('BFO', 'SENSEX', '2026-11-26', false, 70000, 95000, 100);
options('BFO', 'SENSEX', '2026-12-03', true, 70000, 95000, 100);
options('BFO', 'SENSEX', '2026-12-10', true, 70000, 95000, 100);
cash('NSE', 'NIFTY 50', 'NIFTY 50', 'INDICES');
cash('NSE', 'NIFTY BANK', 'NIFTY BANK', 'INDICES');
cash('NSE', 'NIFTY 500', 'NIFTY 500', 'INDICES');
cash('NSE', 'NIFTY IT', 'NIFTY IT', 'INDICES');
cash('NSE', 'RELIANCE', 'RELIANCE INDUSTRIES');
cash('NSE', 'SHREECEM', 'SHREE CEMENT');
cash('NSE', 'NIFTYBEES', 'NIPPON INDIA ETF NIFTY 50 BEES');
for (const e of ['2026-11-23', '2026-12-29', '2027-01-25']) { fut('NFO', 'NIFTY', e); fut('NFO', 'BANKNIFTY', e); fut('NFO', 'RELIANCE', e); }
options('NFO', 'NIFTY', '2026-11-17', true, 20000, 30000, 50);
options('NFO', 'NIFTY', '2026-11-23', false, 20000, 30000, 50);
options('NFO', 'NIFTY', '2026-12-01', true, 20000, 30000, 50);
options('NFO', 'NIFTY', '2026-12-08', true, 20000, 30000, 50);
options('NFO', 'NIFTY', '2026-12-29', false, 20000, 30000, 50);
options('NFO', 'NIFTY', '2027-01-25', false, 20000, 30000, 50);
for (const e of ['2026-11-23', '2026-12-29', '2027-01-25']) options('NFO', 'BANKNIFTY', e, false, 50000, 70000, 100);
for (const e of ['2026-11-23', '2026-12-29', '2027-01-25']) options('NFO', 'FINNIFTY', e, false, 22000, 29000, 50);
for (const e of ['2026-11-23', '2026-12-29']) options('NFO', 'NIFTYNXT50', e, false, 55000, 85000, 500);
for (const e of ['2026-11-23', '2026-12-29']) options('NFO', 'SHREECEM', e, false, 20000, 27000, 250);
for (const e of ['2026-11-23', '2026-12-29']) options('NFO', 'BOSCHLTD', e, false, 50000, 60000, 500);
options('NFO', 'RELIANCE', '2026-11-23', false, 1200, 1500, 10);

const SPOTS = { NIFTY: 25430, BANKNIFTY: 61500, SENSEX: 83200 };
const NOW = Date.UTC(2026, 10, 17, 5, 30, 0);          // 17 Nov 2026, 11:00 AM in India: NIFTY's weekly expires today
const find = (q: string, spots: any = SPOTS, now = NOW) => rankInstruments(all, q, spots, 50, now).map((i) => i.tradingsymbol);
const namesOf = (q: string, spots: any = SPOTS) => rankInstruments(all, q, spots, 50, NOW).map((i) => i.name);

// The order the search had, bucket by bucket: the symbol typed whole (NSE's
// before BSE's, as it came out), symbols that begin as typed, the rest; each
// in the file's order; fifty.
const before = (q: string) => {
  const hit = all.filter((i) => i.tradingsymbol.toLowerCase().includes(q) || String(i.name || '').toLowerCase().includes(q));
  const ex = ['NSE', 'NFO', 'BSE', 'BFO'];
  const exact = hit.filter((i) => i.tradingsymbol.toLowerCase() === q).sort((a, b) => ex.indexOf(a.exchange) - ex.indexOf(b.exchange));
  const starts = hit.filter((i) => i.tradingsymbol.toLowerCase() !== q && i.tradingsymbol.toLowerCase().startsWith(q));
  const rest = hit.filter((i) => !i.tradingsymbol.toLowerCase().startsWith(q));
  return [...exact, ...starts, ...rest].slice(0, 50).map((i) => i.tradingsymbol);
};

// ── what he typed: a strike ──
{
  const r = find('23500');
  // NIFTY's, nearest expiry first, call before put: all six expiries before anything else
  assert.deepEqual(r.slice(0, 12), [
    'NIFTY26N1723500CE', 'NIFTY26N1723500PE', 'NIFTY26NOV23500CE', 'NIFTY26NOV23500PE',
    'NIFTY26D0123500CE', 'NIFTY26D0123500PE', 'NIFTY26D0823500CE', 'NIFTY26D0823500PE',
    'NIFTY26DEC23500CE', 'NIFTY26DEC23500PE', 'NIFTY27JAN23500CE', 'NIFTY27JAN23500PE',
  ], '23500 is a NIFTY strike: its contracts first, by expiry');
  // and the rest is still found, after them, in the file's order (SENSEX50 was first before)
  assert.deepEqual(r.slice(12, 18), ['SENSEX5026NOV23500CE', 'SENSEX5026NOV23500PE', 'SENSEX5026DEC23500CE', 'SENSEX5026DEC23500PE', 'SENSEX5027JAN23500CE', 'SENSEX5027JAN23500PE']);
  assert.ok(r.includes('FINNIFTY26NOV23500CE') && r.includes('SHREECEM26NOV23500PE'), 'nothing the search found is lost');
  assert.equal(before('23500')[0], 'SENSEX5026NOV23500CE', 'the file is in the order that put SENSEX50 first');
}
{
  const n = namesOf('57000');
  assert.deepEqual(n.slice(0, 6), Array(6).fill('BANKNIFTY'), '57000 is a Bank Nifty strike');
  assert.equal(n[6], 'BANKEX', 'then the rest, as the file has them');
  const s = find('83000');
  assert.deepEqual(s.slice(0, 8), ['SENSEX26N1983000CE', 'SENSEX26N1983000PE', 'SENSEX26NOV83000CE', 'SENSEX26NOV83000PE', 'SENSEX26D0383000CE', 'SENSEX26D0383000PE', 'SENSEX26D1083000CE', 'SENSEX26D1083000PE'], '83000 is a SENSEX strike');
  // after them, what the old search found, where it had it — the digits across the join of
  // a day and a strike (NIFTY 26 D 08 30000) among it, not lifted above a real 83000
  assert.deepEqual(s.slice(8), before('83000').filter((x) => !/^SENSEX26/.test(x)).slice(0, 42));
  assert.ok(s.indexOf('NIFTY26D0830000CE') > 7 && s.includes('NIFTYNXT5026NOV83000CE'));
}
// a strike two of them list goes to the one whose price is nearer it
{
  assert.equal(namesOf('70000')[0], 'BANKNIFTY', '70000: 14% from Bank Nifty at 61,500, 16% from SENSEX at 83,200');
  assert.equal(namesOf('70000', { NIFTY: 25430, BANKNIFTY: 52000, SENSEX: 72000 })[0], 'SENSEX', 'the prices decide, not the names');
  // with no price known, the middle strike of the nearest expiry stands in (60,000 and 82,500 here)
  assert.equal(namesOf('70000', {})[0], 'SENSEX');
  assert.equal(namesOf('23500', {})[0], 'NIFTY');
  assert.equal(namesOf('57000', {})[0], 'BANKNIFTY');
  assert.equal(namesOf('83000', { NIFTY: 0, SENSEX: NaN } as any)[0], 'SENSEX', 'a price that is not one is no price');
}
// part of a strike: the nearest expiry, the strike nearest the price first
{
  const r = find('254');
  assert.deepEqual(r.slice(0, 8), ['NIFTY26N1725450CE', 'NIFTY26N1725450PE', 'NIFTY26N1725400CE', 'NIFTY26N1725400PE', 'NIFTY26NOV25450CE', 'NIFTY26NOV25450PE', 'NIFTY26NOV25400CE', 'NIFTY26NOV25400PE']);
  assert.deepEqual(find('254', { NIFTY: 25410 }).slice(0, 4), ['NIFTY26N1725400CE', 'NIFTY26N1725400PE', 'NIFTY26N1725450CE', 'NIFTY26N1725450PE'], 'at 25,410 the 25400 is the nearer');
  assert.equal(namesOf('83')[0], 'SENSEX');
}

// ── the symbol typed whole is first: the chart finds an open position's contract by it ──
{
  for (const sym of ['NIFTY26N1725450CE', 'NIFTY26NOV25450PE', 'SENSEX26N1983000CE', 'BANKNIFTY26NOV61500PE', 'RELIANCE26NOV1340CE', 'NIFTY26NOVFUT']) {
    assert.equal(find(sym)[0], sym, `${sym} typed whole`);
    assert.equal(find(sym.toLowerCase())[0], sym);
    assert.equal(find('  ' + sym + ' ')[0], sym);
  }
  const r = rankInstruments(all, 'RELIANCE', SPOTS, 50, NOW);
  assert.deepEqual(r.slice(0, 2).map((i) => i.exchange), ['NSE', 'BSE'], "the share itself, NSE's first as before");
}

// ── an index's name: the index, its futures, its options from the money outward ──
{
  const r = find('nifty');
  assert.deepEqual(r.slice(0, 10), ['NIFTY 50', 'NIFTY26NOVFUT', 'NIFTY26DECFUT', 'NIFTY27JANFUT', 'NIFTY26N1725450CE', 'NIFTY26N1725450PE', 'NIFTY26N1725400CE', 'NIFTY26N1725400PE', 'NIFTY26N1725500CE', 'NIFTY26N1725500PE']);
  assert.equal(r.length, 50);
  assert.equal(before('nifty')[0], 'NIFTYF01', 'where the file gave fifty funds');
  for (const q of ['banknifty', 'bank nifty', 'nifty bank', 'BankNifty']) {
    assert.deepEqual(find(q).slice(0, 8), ['NIFTY BANK', 'BANKNIFTY26NOVFUT', 'BANKNIFTY26DECFUT', 'BANKNIFTY27JANFUT', 'BANKNIFTY26NOV61500CE', 'BANKNIFTY26NOV61500PE', 'BANKNIFTY26NOV61400CE', 'BANKNIFTY26NOV61400PE'], q);
  }
  // every way of writing the name gives the one list
  assert.deepEqual(find('nifty 50'), r);
  assert.deepEqual(find('Nifty50'), r);
  assert.deepEqual(find('nifty bank'), find('banknifty'));
  const s = find('sensex');
  assert.deepEqual(s.slice(0, 6), ['SENSEX', 'SENSEX26NOVFUT', 'SENSEX26DECFUT', 'SENSEX27JANFUT', 'SENSEX26N1983200CE', 'SENSEX26N1983200PE']);
  assert.ok(!namesOf('sensex').includes('SENSEX50'), 'SENSEX50 is not SENSEX');
}

// ── what the change must leave alone: searches with no index and no strike in them ──
for (const q of ['reliance', 'nifty 5', 'shree', 'fund 0', 'etf', 'nifty it', 'nif', 'bosch', 'relianc', 'bank', 'ce', 'nifty 500', 'kotak nifty', 'nifty 50 etf']) {
  const was = before(q), now = find(q);
  assert.ok(was.length > 0, `"${q}" found something before`);
  assert.deepEqual(now.slice(0, was.length), was, `"${q}" is as it was`);
  // one word finds no more than it did; several may find more, after what they found before
  if (!q.includes(' ')) assert.equal(now.length, was.length, `"${q}" finds what it found`);
}
assert.deepEqual(find('fund 0').slice(9, 11), ['NIFTYF10', 'NIFTYF11'], 'words found apart (a 0 elsewhere in the name) come after the words found together');

// ── several words: the result's own wording finds it ──
{
  assert.deepEqual(find('nifty 17th (w) nov 23500 ce'), ['NIFTY26N1723500CE'], 'the line as it is shown');
  // (FINNIFTY has the letters in its name and a 23500 put that day: found, after NIFTY's)
  assert.deepEqual(find('NIFTY 23rd NOV 23500 PE'), ['NIFTY26NOV23500PE', 'FINNIFTY26NOV23500PE']);
  assert.deepEqual(find('nifty 23500 ce').slice(0, 6), ['NIFTY26N1723500CE', 'NIFTY26NOV23500CE', 'NIFTY26D0123500CE', 'NIFTY26D0823500CE', 'NIFTY26DEC23500CE', 'NIFTY27JAN23500CE']);
  assert.ok(rankInstruments(all, 'nifty 23500 ce', SPOTS, 50, NOW).every((i) => i.instrument_type === 'CE'));
  assert.deepEqual(find('nifty nov 23500').slice(0, 4), ['NIFTY26N1723500CE', 'NIFTY26N1723500PE', 'NIFTY26NOV23500CE', 'NIFTY26NOV23500PE']);
  assert.deepEqual(find('nifty 23500 weekly').slice(0, 6), ['NIFTY26N1723500CE', 'NIFTY26N1723500PE', 'NIFTY26D0123500CE', 'NIFTY26D0123500PE', 'NIFTY26D0823500CE', 'NIFTY26D0823500PE']);
  assert.deepEqual(find('nifty 23500 monthly').slice(0, 2), ['NIFTY26NOV23500CE', 'NIFTY26NOV23500PE']);
  assert.deepEqual(find('sensex 83000 pe').slice(0, 4), ['SENSEX26N1983000PE', 'SENSEX26NOV83000PE', 'SENSEX26D0383000PE', 'SENSEX26D1083000PE']);
  assert.deepEqual(find('23500 ce').slice(0, 7), ['NIFTY26N1723500CE', 'NIFTY26NOV23500CE', 'NIFTY26D0123500CE', 'NIFTY26D0823500CE', 'NIFTY26DEC23500CE', 'NIFTY27JAN23500CE', 'SENSEX5026NOV23500CE']);
  assert.deepEqual(find('nifty fut'), ['NIFTY26NOVFUT', 'NIFTY26DECFUT', 'NIFTY27JANFUT'], "the index named, not another whose name holds the letters");
  assert.deepEqual(namesOf('nifty 57000').filter((n) => n === 'BANKNIFTY' || n === 'NIFTY'), []);
  assert.deepEqual(find('nifty 25').slice(0, 4), ['NIFTY26N1725450CE', 'NIFTY26N1725450PE', 'NIFTY26N1725400CE', 'NIFTY26N1725400PE'], 'a number with no month beside it starts a strike');
  const day = rankInstruments(all, 'nifty 17 nov', SPOTS, 50, NOW);
  assert.equal(day[0].tradingsymbol, 'NIFTY26N1725450CE');
  assert.ok(day.every((i) => i.name === 'NIFTY' && expiryParts(i.expiry)?.d === 17), 'a number beside a month is the day');
  assert.deepEqual(find('nifty 50 23500').slice(0, 2), ['NIFTY26N1723500CE', 'NIFTY26N1723500PE'], '"nifty 50" is the index\'s name, not a strike');
  assert.deepEqual(find('reliance 1340 ce'), ['RELIANCE26NOV1340CE']);
  assert.deepEqual(find('nifty 99999'), []);
}

// ── the day after an expiry, with the file read the day before still in hand ──
{
  const lateOnTheDay = Date.UTC(2026, 10, 17, 18, 0, 0);       // 17 Nov, 11:30 PM in India
  const nextMorning = Date.UTC(2026, 10, 18, 4, 30, 0);        // 18 Nov, 10:00 AM in India
  const justAfterMidnight = Date.UTC(2026, 10, 17, 18, 40, 0); // 18 Nov, 12:10 AM in India
  assert.equal(find('23500', SPOTS, lateOnTheDay)[0], 'NIFTY26N1723500CE', 'kept all of its last day');
  assert.deepEqual(find('23500', SPOTS, nextMorning).slice(0, 4), ['NIFTY26NOV23500CE', 'NIFTY26NOV23500PE', 'NIFTY26D0123500CE', 'NIFTY26D0123500PE'], "yesterday's weekly is not the top of the list: it is not in it");
  assert.equal(find('23500', SPOTS, justAfterMidnight)[0], 'NIFTY26NOV23500CE', "the day is India's");
  assert.ok(!find('nifty', SPOTS, nextMorning).some((x) => /^NIFTY26N17/.test(x)));
  assert.equal(find('nifty', SPOTS, nextMorning)[4], 'NIFTY26NOV25450CE', 'the money row of the expiry that is now nearest');
  assert.deepEqual(find('NIFTY26N1723500CE', SPOTS, nextMorning), [], 'nor found by its symbol');
  assert.deepEqual(find('nifty 17th (w) nov 23500 ce', SPOTS, nextMorning), []);
  // what has no expiry is never dropped, and a row whose expiry cannot be read is kept
  assert.equal(find('reliance', SPOTS, Date.UTC(2030, 0, 1))[0], 'RELIANCE');
  assert.deepEqual(rankInstruments([{ exchange: 'NFO', tradingsymbol: 'NIFTY26N1723500CE', name: 'NIFTY', instrument_type: 'CE', strike: 23500, expiry: 'soon' }], '23500', {}, 50, nextMorning).length, 1);
}

// ── the edges ──
{
  assert.deepEqual(rankInstruments(all, '', SPOTS, 50, NOW), []);
  assert.deepEqual(rankInstruments(all, 'n', SPOTS, 50, NOW), []);
  assert.deepEqual(rankInstruments(all, '   ', SPOTS, 50, NOW), []);
  assert.deepEqual(rankInstruments(null as any, 'nifty', SPOTS), []);
  assert.equal(rankInstruments(all, 'nifty', SPOTS, 7, NOW).length, 7);
  assert.deepEqual(rankInstruments(all, '23500', undefined, 50, NOW), rankInstruments(all, '23500', {}, 50, NOW), 'prices are optional');
  // other exchanges are not searched (US30 and the like are found another way)
  const withMcx = [{ instrument_token: '1', tradingsymbol: 'NIFTY26N1723500CE', name: 'NIFTY', exchange: 'MCX', instrument_type: 'CE', strike: 23500, expiry: D('2026-11-17') }, ...all];
  assert.equal(rankInstruments(withMcx, '23500', SPOTS, 50, NOW)[0].exchange, 'NFO');
  // the file as it is after being sent as text (expiry a string) gives the same answers
  const asText: SearchRow[] = JSON.parse(JSON.stringify(all));
  for (const q of ['23500', 'nifty', '254', 'nifty 17th (w) nov 23500 ce', 'sensex 83000 pe', 'reliance']) {
    assert.deepEqual(rankInstruments(asText, q, SPOTS, 50, NOW).map((i) => i.tradingsymbol), find(q), `${q}, expiry as text`);
  }
  // rows that are missing things do not stop it
  const ragged: any[] = [null, { exchange: 'NSE' }, { exchange: 'NFO', tradingsymbol: 'NIFTY26N1723500CE', name: 'NIFTY', instrument_type: 'CE', strike: '23500', expiry: 'soon' }, { exchange: 'NFO', tradingsymbol: 'X23500', name: null }];
  assert.deepEqual(rankInstruments(ragged, '23500', {}, 50, NOW).map((i) => i.tradingsymbol), ['NIFTY26N1723500CE', 'X23500']);
}

// ── weekly or monthly, from the symbol ──
{
  assert.equal(isWeeklySymbol('NIFTY26N1723500CE', 'NIFTY'), true);
  assert.equal(isWeeklySymbol('NIFTY26NOV23500CE', 'NIFTY'), false);
  assert.equal(isWeeklySymbol('NIFTY26O0625000PE', 'NIFTY'), true, 'October is O');
  assert.equal(isWeeklySymbol('NIFTY26OCT25000PE', 'NIFTY'), false);
  assert.equal(isWeeklySymbol('NIFTY2710525000CE', 'NIFTY'), true, 'January is 1');
  assert.equal(isWeeklySymbol('SENSEX26D0383000CE', 'SENSEX'), true);
  assert.equal(isWeeklySymbol('SENSEX5026NOV23500CE', 'SENSEX50'), false, 'a name that ends in digits');
  assert.equal(isWeeklySymbol('NIFTY26NOVFUT', 'NIFTY'), false);
  assert.equal(isWeeklySymbol('RELIANCE26NOV1340CE', 'RELIANCE'), false);
  // with no name to go by
  assert.equal(isWeeklySymbol('NIFTY26N1723500CE'), true);
  assert.equal(isWeeklySymbol('SENSEX5026NOV23500CE'), false);
  assert.equal(isWeeklySymbol('SENSEX26D0383000CE'), true);
  assert.equal(isWeeklySymbol('RELIANCE'), false);
  assert.equal(isWeeklySymbol(''), false);
  assert.deepEqual(expiryParts('2026-11-17T00:00:00.000Z'), { y: 2026, m: 11, d: 17, n: 20261117 });
  assert.deepEqual(expiryParts(D('2026-12-03')), { y: 2026, m: 12, d: 3, n: 20261203 });
  assert.equal(expiryParts(''), null); assert.equal(expiryParts(new Date('x')), null);
}

console.log('instrument_search: all checks passed');
