// The Trade Journal's arithmetic: which days a period covers, and what the
// trades of those days add up to. Pure, so it is tested directly
// (journalStats.test.ts) and the page only draws.
//
// EVERY DAY HERE IS AN IST CALENDAR DAY, written 'YYYY-MM-DD'. The journal is
// organised by trading day and the phone may not be in IST (Dubai is UTC+4), so
// nothing in this file asks the device what day it is: a timestamp is turned
// into its IST day once, and from there days are only ever counted on, as
// dates with no time zone at all.
//
// A TRADE BELONGS TO THE DAY IT WAS ENTERED — the rule the journal, its Excel
// export and the day's capital line already use.

export type Period = 'D' | 'W' | 'M' | 'Y';
/** Returns as the broker shows them, or what is left once the charges are paid. */
export type Basis = 'gross' | 'net';

export interface StatTrade {
  status: string;
  entry_time: number | null;
  pnl: number | null;
  charges?: number | null;
  net_pnl?: number | null;
}

const IST_MS = 5.5 * 3600000;
export const istDay = (ms: number | null | undefined): string =>
  (!ms ? 'unknown' : new Date(ms + IST_MS).toISOString().slice(0, 10));

/**
 * THE DAY THE JOURNAL'S CARD IS ON. A trading day does not end at midnight for
 * the person reading it: Martin is in Dubai, where midnight in India is 10:30 PM,
 * and the evening is when a day's trades are looked at. So "today's" figures stay
 * on the session that has just ended until 9:00 AM IST, a quarter of an hour
 * before the next one opens — the way a broker's own positions page (and
 * Lemonn's) keeps showing the last session through the night. Labels that name
 * a calendar date ("Today", "Yesterday", the calendar's own Today cell) still go
 * by istDay.
 */
export const SESSION_ROLLS_AT_HOUR = 9;
export const sessionDay = (ms: number): string => istDay(ms - SESSION_ROLLS_AT_HOUR * 3600000);

const parts = (day: string) => day.split('-').map(Number) as [number, number, number];
const utc = (day: string) => { const [y, m, d] = parts(day); return Date.UTC(y, m - 1, d); };
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => fromUtc(utc(day) + n * 86400000);
/** 0 = Sunday … 6 = Saturday. */
export const weekday = (day: string) => new Date(utc(day)).getUTCDay();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "16 Nov" */
export const dayMonth = (day: string) => { const [, m, d] = parts(day); return `${d} ${MONTHS[m - 1]}`; };
/** "16 Nov 2026" */
export const dayLabel = (day: string) => { const [y] = parts(day); return `${dayMonth(day)} ${y}`; };
/** "8th Oct 2026" — a day as Lemonn's order list writes it. */
export const ordinalDay = (day: string) => {
  const [y, m, d] = parts(day);
  const th = d % 100 >= 11 && d % 100 <= 13 ? 'th' : d % 10 === 1 ? 'st' : d % 10 === 2 ? 'nd' : d % 10 === 3 ? 'rd' : 'th';
  return `${d}${th} ${MONTHS[m - 1]} ${y}`;
};
/** A day's heading in a list: "Today", "Yesterday", else "8th Oct 2026". */
export const dayTitle = (day: string, today: string) =>
  (day === today ? 'Today' : day === addDays(today, -1) ? 'Yesterday' : day === 'unknown' ? 'No date' : ordinalDay(day));
const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1-12
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The first year of the financial year (April to March) a day falls in. */
export const fyStart = (day: string) => { const [y, m] = parts(day); return m >= 4 ? y : y - 1; };

/**
 * The days a period covers, around the day it is anchored on.
 *   D — that day.            W — its week, Monday to Sunday.
 *   M — its calendar month.  Y — its financial year, 1 April to 31 March.
 */
export function periodRange(p: Period, anchor: string): { from: string; to: string; label: string } {
  if (p === 'D') return { from: anchor, to: anchor, label: dayLabel(anchor) };
  if (p === 'W') {
    const from = addDays(anchor, -((weekday(anchor) + 6) % 7));
    const to = addDays(from, 6);
    return { from, to, label: `${dayMonth(from)} – ${dayMonth(to)}` };
  }
  const [y, m] = parts(anchor);
  if (p === 'M') return { from: ymd(y, m, 1), to: ymd(y, m, lastOfMonth(y, m)), label: `${MONTHS_LONG[m - 1]} ${y}` };
  const fy = fyStart(anchor);
  return { from: ymd(fy, 4, 1), to: ymd(fy + 1, 3, 31), label: `FY ${fy}-${String((fy + 1) % 100).padStart(2, '0')}` };
}

/** The anchor of the period before (-1) or after (+1) this one. */
export function shiftPeriod(p: Period, anchor: string, dir: -1 | 1): string {
  if (p === 'D') return addDays(anchor, dir);
  if (p === 'W') return addDays(anchor, 7 * dir);
  const [y, m, d] = parts(anchor);
  if (p === 'M') {
    const nm = m + dir, ny = nm < 1 ? y - 1 : nm > 12 ? y + 1 : y, mm = ((nm + 11) % 12) + 1;
    return ymd(ny, mm, Math.min(d, lastOfMonth(ny, mm)));
  }
  return ymd(y + dir, m, Math.min(d, lastOfMonth(y + dir, m)));
}

export interface Tally {
  /** Trades entered (open ones included). */
  trades: number;
  open: number;
  closed: number;
  gross: number;
  /** Every charge run up, open trades' entries included — as the journal counts them. */
  charges: number;
  net: number;
  winsG: number; lossesG: number; winSumG: number; lossSumG: number;
  winsN: number; lossesN: number; winSumN: number; lossSumN: number;
}
const empty = (): Tally => ({ trades: 0, open: 0, closed: 0, gross: 0, charges: 0, net: 0,
  winsG: 0, lossesG: 0, winSumG: 0, lossSumG: 0, winsN: 0, lossesN: 0, winSumN: 0, lossSumN: 0 });
const add = (a: Tally, b: Tally): Tally => {
  const o = empty();
  for (const k of Object.keys(o) as (keyof Tally)[]) o[k] = a[k] + b[k];
  return o;
};

/** Each day's trades added up, keyed by the IST day they were entered. */
export function dayTallies(trades: StatTrade[]): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const t of trades) {
    const day = istDay(t.entry_time);
    let s = out.get(day);
    if (!s) { s = empty(); out.set(day, s); }
    s.trades++;
    const ch = Number(t.charges) || 0;
    s.charges += ch;
    if (t.status !== 'CLOSED') { s.open++; continue; }
    s.closed++;
    const g = Number(t.pnl) || 0;
    // What the trade made after its own charges: the server's figure when it
    // sent one, otherwise the same subtraction.
    const n = t.net_pnl === null || t.net_pnl === undefined ? g - ch : Number(t.net_pnl);
    s.gross += g;
    if (g > 0) { s.winsG++; s.winSumG += g; } else if (g < 0) { s.lossesG++; s.lossSumG += g; }
    if (n > 0) { s.winsN++; s.winSumN += n; } else if (n < 0) { s.lossesN++; s.lossSumN += n; }
  }
  // Net is the day's realised P&L less ALL of the day's charges (an open trade
  // has already paid for its entry) — the journal's own definition, so that
  // "opened with + net = left" holds for each day.
  for (const s of out.values()) s.net = s.gross - s.charges;
  return out;
}

/** The tallies of every day from `from` to `to`, both included, added up. */
export function sumDays(byDay: Map<string, Tally>, from: string, to: string): Tally {
  let o = empty();
  for (const [day, s] of byDay) if (day >= from && day <= to) o = add(o, s);
  return o;
}

export const valueOf = (t: Tally, basis: Basis) => (basis === 'net' ? t.net : t.gross);
/** Win rate, average winner and average loser of a tally, on the chosen basis. */
export function quality(t: Tally, basis: Basis): { winRate: number | null; avgProfit: number; avgLoss: number } {
  const wins = basis === 'net' ? t.winsN : t.winsG, losses = basis === 'net' ? t.lossesN : t.lossesG;
  const winSum = basis === 'net' ? t.winSumN : t.winSumG, lossSum = basis === 'net' ? t.lossSumN : t.lossSumG;
  return {
    winRate: t.closed ? (wins / t.closed) * 100 : null,
    avgProfit: wins ? winSum / wins : 0,
    avgLoss: losses ? lossSum / losses : 0,
  };
}

export interface Cell {
  /** What the cell says: "16", "Mon", "W3", "Apr". */
  label: string;
  /** A second line where the period has one: "9–15 Nov". */
  sub?: string;
  from: string;
  to: string;
  tally: Tally;
}

/** A month as a calendar: rows of seven, Sunday first, null where the month has no day. */
export function monthGrid(byDay: Map<string, Tally>, anchor: string): (Cell | null)[][] {
  const [y, m] = parts(anchor);
  const n = lastOfMonth(y, m);
  const rows: (Cell | null)[][] = [];
  let row: (Cell | null)[] = new Array(weekday(ymd(y, m, 1))).fill(null);
  for (let d = 1; d <= n; d++) {
    const day = ymd(y, m, d);
    row.push({ label: String(d), from: day, to: day, tally: byDay.get(day) || empty() });
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length) { while (row.length < 7) row.push(null); rows.push(row); }
  return rows;
}

/** A week's trading days, Monday to Friday. */
export function weekCells(byDay: Map<string, Tally>, anchor: string): Cell[] {
  const { from } = periodRange('W', anchor);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((label, i) => {
    const day = addDays(from, i);
    return { label, sub: dayMonth(day), from: day, to: day, tally: byDay.get(day) || empty() };
  });
}

/** A month's weeks, Monday to Sunday, cut off at the month's own first and last day. */
export function monthWeeks(byDay: Map<string, Tally>, anchor: string): Cell[] {
  const { from, to } = periodRange('M', anchor);
  const out: Cell[] = [];
  let start = from;
  while (start <= to) {
    const endOfWeek = addDays(start, (7 - weekday(start)) % 7);       // the Sunday that ends this week
    const end = endOfWeek > to ? to : endOfWeek;
    const [, mon, d1] = parts(start); const [, , d2] = parts(end);
    out.push({ label: `W${out.length + 1}`, sub: `${d1}–${d2} ${MONTHS[mon - 1]}`, from: start, to: end, tally: sumDays(byDay, start, end) });
    start = addDays(end, 1);
  }
  return out;
}

/** A financial year's months, April to March. */
export function yearMonths(byDay: Map<string, Tally>, anchor: string): Cell[] {
  const fy = fyStart(anchor);
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((i + 3) % 12) + 1, y = m >= 4 ? fy : fy + 1;
    const from = ymd(y, m, 1), to = ymd(y, m, lastOfMonth(y, m));
    return { label: MONTHS[m - 1], from, to, tally: sumDays(byDay, from, to) };
  });
}

/** The profit of the cells that made money, and the loss of those that lost it. */
export function profitAndLoss(cells: (Cell | null)[], basis: Basis): { profit: number; loss: number } {
  let profit = 0, loss = 0;
  for (const c of cells) { if (!c) continue; const v = valueOf(c.tally, basis); if (v > 0) profit += v; else loss += v; }
  return { profit, loss };
}

/** An amount short enough for a calendar cell, without its sign: 520 → "520", 1 250 → "1.3K", 1 25 000 → "1.3L". */
export function compact(v: number): string {
  const a = Math.abs(v);
  if (a < 1000) return String(Math.round(a));
  if (a < 100000) return `${(a / 1000).toFixed(1)}K`;
  return `${(a / 100000).toFixed(1)}L`;
}
