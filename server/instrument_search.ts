// THE ORDER OF THE SEARCH BOX'S RESULTS (17 Nov 2026).
//
// WHAT WAS WRONG. The search matched the typed text anywhere in a symbol or a
// name and returned the first fifty in the order of Zerodha's contract file,
// which begins with BSE. Martin typed a strike, 23500, and the list opened
// with six SENSEX50 contracts (a small BSE index near NIFTY's level, read as
// SENSEX) with NIFTY's own under them: "The search shows strikes for SENSEX
// first even though SENSEX is not in the range of types strike price. Show the
// Nifty, bank nifty or SENSEX options in the search based on the nearest
// strike price."
//
// THE ORDER NOW. The contracts of the three indices this terminal trades come
// first, and among them:
//   - the index the typed strike belongs to: the one whose price is nearest
//     that strike (23500 is 8% from NIFTY, and not a strike of the other two);
//   - then the nearest expiry;
//   - then the strike nearest the index's price (for a part-typed strike:
//     "254" gives 25450 and 25400 with NIFTY at 25,430, in that order);
//   - then the call before the put.
// An index's price is its last tick; with none (a restart at night), the middle
// strike of its nearest expiry, which is near enough to tell three indices
// apart. Everything else the old search found is still found, after these, in
// the old order.
//
// AN INDEX'S NAME does the same: "nifty", "banknifty" or "sensex" — however
// written: "nifty 50", "bank nifty", "nifty bank" — gives the index, its
// futures, then its options from the money outward, where "nifty" used to give
// fifty funds with the word in their name.
//
// SEVERAL WORDS. The results read "NIFTY 17th (w) NOV 23500 CE", and typing
// that, or part of it ("nifty 23500", "23500 ce"), found nothing: the words
// were looked for as one run of letters. Each word is now matched on its own
// — the name, the strike, CE / PE / FUT, the month, the day, weekly / monthly.
//
// WHAT IS AS IT WAS. A search with none of the three names and no strike in it
// ("reliance", "nifty it", "tata motors", "bank") finds what it found, in the
// order it had: the symbol typed whole, symbols that begin as typed, the rest,
// each as the file has them. Words found only apart are added after those.
//
// WHAT MUST NOT CHANGE. A symbol typed whole is the first result. The chart
// finds the contract of an open position that way (AdvancedChart asks this
// search for the position's symbol and takes the row that is exactly it), and
// the exit button and the premium rule hang off what it finds.
//
// Pure functions; instrument_search.test.ts runs them on a file shaped like
// Zerodha's.

export type Major = 'NIFTY' | 'BANKNIFTY' | 'SENSEX';
export const MAJORS: readonly Major[] = ['NIFTY', 'BANKNIFTY', 'SENSEX'];

export interface SearchRow {
  tradingsymbol: string;
  name?: string;
  exchange: string;
  instrument_type?: string;
  expiry?: string | Date | null;
  strike?: number | string;
  [k: string]: any;
}

const EXCHANGE_ORDER = ['NSE', 'NFO', 'BSE', 'BFO'];
const SEARCHED = new Set(EXCHANGE_ORDER);
const INDEX_ROW: Record<Major, { exchange: string; tradingsymbol: string }> = {
  NIFTY: { exchange: 'NSE', tradingsymbol: 'NIFTY 50' },
  BANKNIFTY: { exchange: 'NSE', tradingsymbol: 'NIFTY BANK' },
  SENSEX: { exchange: 'BSE', tradingsymbol: 'SENSEX' },
};
const DERIVATIVES_ON: Record<Major, string> = { NIFTY: 'NFO', BANKNIFTY: 'NFO', SENSEX: 'BFO' };
// What he may type for each, with or without the space.
const ALIASES: Record<Major, string[]> = { NIFTY: ['nifty', 'nifty50'], BANKNIFTY: ['banknifty', 'niftybank'], SENSEX: ['sensex'] };
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const TYPE_WORDS: Record<string, 'CE' | 'PE' | 'FUT'> = { ce: 'CE', call: 'CE', calls: 'CE', pe: 'PE', put: 'PE', puts: 'PE', fut: 'FUT', future: 'FUT', futures: 'FUT' };

const lc = (s: any) => (typeof s === 'string' ? s.toLowerCase() : '');
const isOption = (i: SearchRow) => i.instrument_type === 'CE' || i.instrument_type === 'PE';
const isFuture = (i: SearchRow) => i.instrument_type === 'FUT';

/** The expiry's day, as numbers. Zerodha's file gives a date at midnight UTC; a saved row gives its text. */
export function expiryParts(e: any): { y: number; m: number; d: number; n: number } | null {
  let y = 0, m = 0, d = 0;
  if (e instanceof Date) {
    if (Number.isNaN(e.getTime())) return null;
    y = e.getUTCFullYear(); m = e.getUTCMonth() + 1; d = e.getUTCDate();
  } else {
    const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(e || ''));
    if (!x) return null;
    y = Number(x[1]); m = Number(x[2]); d = Number(x[3]);
  }
  return { y, m, d, n: y * 10000 + m * 100 + d };
}

/**
 * A weekly contract, by its symbol: after the name and the year a weekly has
 * one character for the month and two digits for the day (NIFTY 26 N 17 ...),
 * a monthly the month's three letters (NIFTY 26 NOV ...).
 */
export function isWeeklySymbol(tradingsymbol: string, name?: string): boolean {
  const ts = String(tradingsymbol || '');
  const rest = name && ts.startsWith(name) ? ts.slice(name.length) : ts.replace(/^.*?(?=\d{2}(?:[A-Z]{3}|[1-9OND]\d{2})\d*(?:\.\d+)?(?:CE|PE|FUT)$)/, '');
  return /^\d{2}[1-9OND]\d{2}/.test(rest) && !/^\d{2}[A-Z]{3}/.test(rest);
}

const majorOf = (i: SearchRow): Major | null => {
  if (!isOption(i) && !isFuture(i)) return null;
  for (const m of MAJORS) if (i.name === m && i.exchange === DERIVATIVES_ON[m]) return m;
  return null;
};
const indexOf = (i: SearchRow): Major | null => {
  for (const m of MAJORS) if (i.exchange === INDEX_ROW[m].exchange && i.tradingsymbol === INDEX_ROW[m].tradingsymbol) return m;
  return null;
};

type Word =
  | { kind: 'major'; major: Major; raw: string }
  | { kind: 'type'; type: 'CE' | 'PE' | 'FUT' }
  | { kind: 'month'; m: number }
  | { kind: 'day'; d: number }
  | { kind: 'weekly'; weekly: boolean }
  | { kind: 'number'; raw: string }
  | { kind: 'text'; raw: string };

const monthOf = (w: string): number => {
  if (w.length < 3 || !/^[a-z]+$/.test(w)) return 0;
  const at = MONTH_NAMES.findIndex((n) => n.startsWith(w));
  return at < 0 ? 0 : at + 1;
};
const majorNamed = (w: string): Major | null => MAJORS.find((m) => ALIASES[m].includes(w)) || null;

/** The typed words, each as what it is. "bank nifty" and "nifty 50" are one name. */
function wordsOf(parts: string[]): Word[] {
  const hasMonth = parts.some((p) => monthOf(p) > 0);
  const out: Word[] = [];
  for (let k = 0; k < parts.length; k++) {
    const w = parts[k];
    const pair = k + 1 < parts.length ? majorNamed(w + parts[k + 1]) : null;
    if (pair) { out.push({ kind: 'major', major: pair, raw: w + parts[k + 1] }); k++; continue; }
    const major = majorNamed(w);
    if (major) { out.push({ kind: 'major', major, raw: w }); continue; }
    if (TYPE_WORDS[w]) { out.push({ kind: 'type', type: TYPE_WORDS[w] }); continue; }
    if (w === 'w' || w === '(w)' || w === 'weekly') { out.push({ kind: 'weekly', weekly: true }); continue; }
    if (w === 'monthly') { out.push({ kind: 'weekly', weekly: false }); continue; }
    const ord = /^(\d{1,2})(st|nd|rd|th)$/.exec(w);
    if (ord) { out.push({ kind: 'day', d: Number(ord[1]) }); continue; }
    if (/^\d+(\.\d+)?$/.test(w)) {
      // "17" beside a month is the day; on its own it is the start of a strike.
      const n = Number(w);
      if (hasMonth && w.length <= 2 && n >= 1 && n <= 31) out.push({ kind: 'day', d: n });
      else out.push({ kind: 'number', raw: w });
      continue;
    }
    const m = monthOf(w);
    if (m) { out.push({ kind: 'month', m }); continue; }
    out.push({ kind: 'text', raw: w });
  }
  return out;
}

const strikeText = (i: SearchRow) => String(Number(i.strike) || 0);

function wordFits(i: SearchRow, ts: string, name: string, w: Word): boolean {
  const dated = isOption(i) || isFuture(i);
  switch (w.kind) {
    case 'major': {
      // The index named, and not another of the three because its name holds
      // the letters ("nifty 5", on the way to "nifty 50", is not Bank Nifty's 5xxxx strikes).
      const own = majorOf(i) || indexOf(i);
      return own ? own === w.major : (ts.includes(w.raw) || name.includes(w.raw));
    }
    case 'type': return i.instrument_type === w.type;
    case 'weekly': return dated && (isOption(i) && isWeeklySymbol(i.tradingsymbol, i.name)) === w.weekly;
    case 'month': { const e = dated ? expiryParts(i.expiry) : null; return e ? e.m === w.m : false; }
    case 'day': { const e = dated ? expiryParts(i.expiry) : null; return e ? e.d === w.d : false; }
    case 'number': return isOption(i) ? strikeText(i).startsWith(w.raw) : (!dated && (ts.includes(w.raw) || name.includes(w.raw)));
    default: return ts.includes(w.raw) || name.includes(w.raw);
  }
}

// The middle strike of each index's nearest expiry, once per contract file.
const centres = new WeakMap<object, Partial<Record<Major, number>>>();
function ladderCentres(all: SearchRow[]): Partial<Record<Major, number>> {
  const hit = centres.get(all);
  if (hit) return hit;
  const near: Partial<Record<Major, { n: number; strikes: number[] }>> = {};
  for (const i of all) {
    if (!i || !isOption(i)) continue;
    const m = majorOf(i); if (!m) continue;
    const e = expiryParts(i.expiry); const k = Number(i.strike);
    if (!e || !(k > 0)) continue;
    const cur = near[m];
    if (!cur || e.n < cur.n) near[m] = { n: e.n, strikes: [k] };
    else if (e.n === cur.n) cur.strikes.push(k);
  }
  const out: Partial<Record<Major, number>> = {};
  for (const m of MAJORS) {
    const s = near[m]?.strikes; if (!s || !s.length) continue;
    s.sort((a, b) => a - b);
    out[m] = s[Math.floor(s.length / 2)];
  }
  centres.set(all, out);
  return out;
}

/**
 * The search's results, best first, at most `limit`. `spots` is each index's
 * last price where one is known.
 *
 * It runs on the server's one thread, between ticks, on a file of some hundred
 * thousand rows and on every pause in typing — so it keeps only what can be
 * shown. Three of its six groups are in the file's own order (symbols that
 * begin as typed, the rest that hold the words as typed, what holds them only
 * apart): of those the first `limit` are all that can reach the list, and no
 * more are kept. Only the symbol typed whole, the index named and the three
 * indices' contracts are sorted, and those are few.
 */
export function rankInstruments(all: SearchRow[], query: string, spots: Partial<Record<Major, number>> = {}, limit = 50, nowMs: number = Date.now()): SearchRow[] {
  const q = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (q.length < 2 || !Array.isArray(all)) return [];
  // A CONTRACT THAT HAS EXPIRED IS NOT LISTED. The server keeps Zerodha's file
  // for a day from when it was read, so on the morning after an expiry the
  // file in hand still holds yesterday's contracts — and with the nearest
  // expiry first they would be the top of the list, where the old order had
  // them somewhere in the middle. Today's (India's today) are kept all day.
  const india = new Date(nowMs + 5.5 * 3600 * 1000);
  const today = india.getUTCFullYear() * 10000 + (india.getUTCMonth() + 1) * 100 + india.getUTCDate();
  const parts = q.split(' ');
  const words = wordsOf(parts);
  const one = parts.length === 1 ? words[0] : null;
  const named = new Set<Major>();
  for (const w of words) if (w.kind === 'major') named.add(w.major);
  const numbers = words.filter((w): w is { kind: 'number'; raw: string } => w.kind === 'number').map((w) => w.raw);
  // The quickest words to try go first: most rows fail one of them.
  const cost: Record<Word['kind'], number> = { type: 0, number: 1, major: 2, text: 3, month: 4, day: 4, weekly: 5 };
  const tests = one ? [] : words.slice().sort((a, b) => cost[a.kind] - cost[b.kind]);

  interface Theirs { i: SearchRow; at: number; major: Major; future: boolean; e: number; strike: number; typed: boolean }
  const whole: { i: SearchRow; at: number }[] = [];        // the symbol typed whole
  const index: SearchRow[] = [];                            // the index he named
  const theirs: Theirs[] = [];                              // the three indices' contracts
  const begins: SearchRow[] = [], holds: SearchRow[] = [], apart: SearchRow[] = [];   // the old order, the file's
  for (let at = 0; at < all.length; at++) {
    const i = all[at];
    if (!i || !SEARCHED.has(i.exchange)) continue;
    const ts = lc(i.tradingsymbol), name = lc(i.name);
    const phrase = ts.includes(q) || name.includes(q);
    if (!phrase) {
      // One word finds what it always found, and an index and its contracts by
      // its name however written ("banknifty" is NIFTY BANK, "nifty50" is NIFTY).
      if (one) { if (!(one.kind === 'major' && (indexOf(i) === one.major || majorOf(i) === one.major))) continue; }
      else if (!tests.every((w) => wordFits(i, ts, name, w))) continue;
    }
    const e = isOption(i) || isFuture(i) ? (expiryParts(i.expiry)?.n || 0) : 0;
    if (e && e < today) continue;
    if (ts === q) { whole.push({ i, at }); continue; }
    const major = majorOf(i), named1 = major ? null : indexOf(i);
    if (named1 && named.has(named1)) { index.push(i); continue; }
    if (major) {
      // The strike begins as typed. Digits that are only found across the join
      // of the day and the strike (83000 in NIFTY 26 D 08 30000 CE) are a match
      // the old way and stay where the old order had them.
      const typed = isOption(i) && numbers.some((n) => strikeText(i).startsWith(n));
      if (named.has(major) || typed) {
        theirs.push({ i, at, major, future: isFuture(i), e, strike: Number(i.strike) || 0, typed });
        continue;
      }
    }
    const to = !phrase ? apart : ts.startsWith(q) ? begins : holds;
    if (to.length < limit) to.push(i);
  }

  // A share is on both exchanges under one symbol: NSE's first, which is how
  // the old sort left them (it put the later of two such rows first, and
  // Zerodha's file has BSE before NSE).
  whole.sort((a, b) => (EXCHANGE_ORDER.indexOf(a.i.exchange) - EXCHANGE_ORDER.indexOf(b.i.exchange)) || (a.at - b.at));

  if (theirs.length > 1) {
    const mid = ladderCentres(all);
    const price: Partial<Record<Major, number>> = {};
    for (const m of MAJORS) { const p = Number(spots[m]); price[m] = p > 0 ? p : (mid[m] || 0); }
    // Which index a typed strike belongs to: the one whose price is nearest a strike that begins as typed.
    const away: Partial<Record<Major, number>> = {};
    if (numbers.length) {
      for (const h of theirs) {
        if (!h.typed) continue;
        const p = price[h.major] || 0;
        const far = p > 0 ? Math.abs(h.strike - p) / p : Number.MAX_VALUE;
        if (away[h.major] === undefined || far < (away[h.major] as number)) away[h.major] = far;
      }
    }
    const place: Partial<Record<Major, number>> = {};
    MAJORS.slice().sort((a, b) => {
      const an = named.has(a) ? 0 : 1, bn = named.has(b) ? 0 : 1;
      if (an !== bn) return an - bn;                                    // the one he named
      if (numbers.length) {
        const af = away[a] === undefined ? Number.MAX_VALUE : (away[a] as number), bf = away[b] === undefined ? Number.MAX_VALUE : (away[b] as number);
        if (af !== bf) return af - bf;                                  // the one the strike is nearest
      }
      return MAJORS.indexOf(a) - MAJORS.indexOf(b);
    }).forEach((m, k) => { place[m] = k; });
    theirs.sort((a, b) => {
      if (a.major !== b.major) return (place[a.major] as number) - (place[b.major] as number);
      if (a.future !== b.future) return a.future ? -1 : 1;               // futures, then options
      if (a.typed !== b.typed) return a.typed ? -1 : 1;
      if (a.e !== b.e) return a.e - b.e;                                 // the nearest expiry
      const p = price[a.major] || 0;
      const da = p > 0 ? Math.abs(a.strike - p) : a.strike, db = p > 0 ? Math.abs(b.strike - p) : b.strike;
      if (da !== db) return da - db;                                     // the strike nearest the price
      if (a.strike !== b.strike) return a.strike - b.strike;
      if (a.i.instrument_type !== b.i.instrument_type) return a.i.instrument_type === 'CE' ? -1 : 1;   // call, then put
      return a.at - b.at;
    });
  }

  const out: SearchRow[] = [];
  for (const h of whole) out.push(h.i);
  for (const i of index) out.push(i);
  for (const h of theirs) { if (out.length >= limit) break; out.push(h.i); }
  for (const list of [begins, holds, apart]) for (const i of list) { if (out.length >= limit) break; out.push(i); }
  return out.slice(0, limit);
}
