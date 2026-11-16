// A CHART'S HISTORY IS FETCHED IN FULL ONCE A DAY, THEN ONLY TODAY'S PART AGAIN.
//
// Why (16 Nov 2026, Martin: candles should come up fast when the timeframe is
// changed). Every refresh of a chart's data asked the broker for the whole
// window again — 40 days of 1-minute candles, 100 days of 5-minute, 150 days
// of 15-minute — although everything before today is history and cannot
// change. Measured on the live server, a refresh took 1.4 s for 2,530 candles,
// 2.1 s for 4,900 and 3.6 s for 9,820: about 0.65 s plus 0.3 s per thousand
// candles, and for an index twice over, because its volume comes from a
// futures contract fetched the same way. That wait is what a change of
// timeframe feels like whenever the server has nothing fresh for the new one,
// which is nearly always.
//
// So the full window is kept for the day, and a refresh asks only for today's
// candles and puts them on the end. The result is the same list a full fetch
// would return — the tests check exactly that — for a fraction of the candles.
//
// What is NOT kept: daily candles (there are only a few hundred, and the
// window is long), and anything from a previous day (the first request each
// day is a full one, which also picks up any correction the broker has made).

export interface HistRow { date: any; open: number; high: number; low: number; close: number; volume?: number; oi?: number; [k: string]: any }
type Fetch = (fromIst: string, toIst: string) => Promise<HistRow[]>;

const IST_MS = 5.5 * 3600000;
const MAX_KEYS = 48;                       // about 1 MB each at most; the oldest full copy goes first
const store = new Map<string, { day: string; fullAt: number; rows: HistRow[] }>();
// How often each kind of fetch has been made since the server started, and how
// many candles each brought back — shown on /api/diagnostics.
const stats = { full: 0, fullRows: 0, tail: 0, tailRows: 0 };

const istDay = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00+05:30`);
const rowMs = (r: HistRow) => new Date(r.date).getTime();
/** "YYYY-MM-DD HH:MM:SS" in IST, as the broker's history call is given it. */
const parseIst = (s: string) => Date.parse(String(s).replace(' ', 'T') + '+05:30');
// Handed-out rows are copies: the caller writes volumes onto them, and what is
// kept here must stay as the broker gave it.
const copy = (rows: HistRow[]) => rows.map((r) => ({ ...r }));

/**
 * The candles between `fromIst` and `toIst` for `key` (one instrument at one
 * broker interval). `fetch` is the real call. `now` is injectable for tests.
 * Returns what a full fetch would, having fetched only today's part when it can.
 */
export async function historyWithTail(key: string, intervalName: string, fromIst: string, toIst: string, fetch: Fetch, now: number = Date.now()): Promise<HistRow[]> {
  const full = async () => {
    stats.full++;
    const rows = (await fetch(fromIst, toIst)) || [];
    stats.fullRows += rows.length;
    if (intervalName !== 'day' && rows.length) {
      store.delete(key);
      store.set(key, { day: istDay(now), fullAt: now, rows: copy(rows) });
      while (store.size > MAX_KEYS) store.delete(store.keys().next().value as string);
    }
    return rows;
  };
  if (intervalName === 'day') return full();
  const today = istDay(now);
  const kept = store.get(key);
  if (!kept || kept.day !== today || !kept.rows.length) return full();

  const todayStart = dayStartMs(today);
  stats.tail++;
  // Only today's rows are taken from the answer, whatever came back: a broker
  // adapter that ignored the start and returned a longer window would otherwise
  // put the earlier days into the list twice.
  const tail = ((await fetch(`${today} 00:00:00`, toIst)) || []).filter((r) => rowMs(r) >= todayStart);
  stats.tailRows += tail.length;
  const hadToday = kept.rows.some((r) => rowMs(r) >= todayStart);
  // Nothing for today although there was before: not a list to build on. Ask
  // for everything, as this always did, and let that answer stand.
  if (!tail.length && hadToday) return full();

  // The window slides with the clock; rows that have fallen off its far end go,
  // so the list is the one a full fetch made now would give.
  const fromMs = parseIst(fromIst);
  const before = kept.rows.filter((r) => { const t = rowMs(r); return t < todayStart && !(t < fromMs); });
  const merged = before.concat(copy(tail));
  kept.rows = merged;
  return copy(merged);
}

/** For tests and diagnostics. */
export const historyTailStats = () => ({ ...stats, kept: store.size });
export const __historyTail = {
  clear: () => store.clear(),
  size: () => store.size,
  has: (key: string) => store.has(key),
};
