// The day's history, fetched in full once and then only today's part. Run: npx tsx server/history_tail.test.ts
import assert from 'node:assert/strict';
import { historyWithTail, __historyTail } from './history_tail';

// An imitation broker: 5-minute candles, 09:15-15:25 IST on weekdays, whose prices are a pure function of the
// candle's time EXCEPT the one still forming, whose close depends on the clock — as a real one's does.
const STEP = 5 * 60000, IST = 5.5 * 3600000;
const parseIst = (s: string) => Date.parse(s.replace(' ', 'T') + '+05:30');
const istStr = (ms: number) => new Date(ms + IST).toISOString().slice(0, 19).replace('T', ' ');
let clock = 0;                                      // the broker's "now"
const calls: { from: string; to: string; n: number }[] = [];
let fail: null | 'throw' | 'empty' = null;
const broker = async (fromIst: string, toIst: string) => {
  if (fail === 'throw') throw new Error('broker down');
  const out: any[] = [];
  if (fail !== 'empty') {
    const end = Math.min(parseIst(toIst), clock);
    for (let t = Math.ceil(parseIst(fromIst) / STEP) * STEP; t <= end; t += STEP) {
      const ist = new Date(t + IST), wd = ist.getUTCDay(), m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
      if (wd === 0 || wd === 6 || m < 555 || m >= 930) continue;
      const base = 25000 + Math.sin(t / 3.7e6) * 120;
      const forming = clock < t + STEP;
      out.push({ date: new Date(t), open: +base.toFixed(2), high: +(base + 9).toFixed(2), low: +(base - 9).toFixed(2),
                 close: forming ? +(base + ((clock - t) / STEP) * 5).toFixed(2) : +(base + 5).toFixed(2), volume: 0 });
    }
  }
  calls.push({ from: fromIst, to: toIst, n: out.length });
  return out;
};
const DAYS = 100;
const ask = (key = 'N_5minute', interval = '5minute') => historyWithTail(key, interval, istStr(clock - DAYS * 86400e3), istStr(clock), broker, clock);
const fresh = () => broker(istStr(clock - DAYS * 86400e3), istStr(clock));   // what a full fetch gives right now
const plain = (rows: any[]) => rows.map((r) => ({ ...r, date: new Date(r.date).getTime() }));
let n = 0; const ok = (name: string) => { n++; console.log('ok', name); };

// Monday 16 Nov 2026, 10:02 IST
clock = Date.parse('2026-11-16T10:02:00+05:30'); __historyTail.clear();
let a = await ask();
assert.equal(calls.length, 1); assert.equal(calls[0].from, istStr(clock - DAYS * 86400e3)); assert.ok(a.length > 5000);
ok(`first request of the day: one full fetch (${a.length} candles)`);

// 10:09: only today's candles are asked for, and the list is exactly a full fetch's
clock = Date.parse('2026-11-16T10:09:30+05:30'); calls.length = 0;
a = await ask();
assert.equal(calls.length, 1); assert.equal(calls[0].from, '2026-11-16 00:00:00'); assert.ok(calls[0].n <= 12);
const want = await fresh();
assert.deepEqual(plain(a), plain(want));
ok(`a refresh asks for today only (${calls[0].n} candles instead of ${want.length}) and returns the same list as a full fetch`);

// the candle that was forming at 10:02 is now the finished one, and the new forming one is there
const at1000 = a.find((r) => new Date(r.date).getTime() === Date.parse('2026-11-16T10:00:00+05:30'))!;
const at1005 = a[a.length - 1];
assert.equal(new Date(at1005.date).getTime(), Date.parse('2026-11-16T10:05:00+05:30'));
assert.equal(at1000.close, want[want.length - 2].close); assert.notEqual(at1005.close, +(at1005.open + 5).toFixed(2));
ok('the candle that was still forming last time is replaced by its finished self; the new forming candle is on the end');

// what is handed out is a copy: writing on it (as the volume merge does) leaves the kept history alone
for (const r of a) r.volume = 999;
calls.length = 0; const b = await ask();
assert.ok(b.every((r) => r.volume === 0)); ok('rows handed out are copies: a caller writing volumes onto them does not change what is kept');

// the window slides: rows older than the new start are dropped, as a full fetch would not have them
clock = Date.parse('2026-11-16T15:20:00+05:30'); calls.length = 0;
a = await ask(); assert.deepEqual(plain(a), plain(await fresh())); assert.equal(calls[0].from, '2026-11-16 00:00:00');
ok('five hours later: still today only, still identical to a full fetch (the far end of the window has moved on)');

// the broker fails on the tail: the error is the caller's to handle, and nothing kept is damaged
fail = 'throw'; await assert.rejects(ask(), /broker down/); fail = null; calls.length = 0;
a = await ask(); assert.equal(calls.length, 1); assert.equal(calls[0].from, '2026-11-16 00:00:00'); assert.deepEqual(plain(a), plain(await fresh()));
ok('a failed refresh throws (as a failed full fetch did) and the next one works from the same kept history');

// an empty answer for today although today's candles were there before: not built on — a full fetch is made instead
fail = 'empty'; calls.length = 0;
a = await ask(); assert.equal(calls.length, 2); assert.equal(calls[1].from, istStr(clock - DAYS * 86400e3)); assert.equal(a.length, 0);
fail = null; ok('an empty answer for today, when today was there before, falls back to a full fetch and that answer stands');
// ...and an empty full answer is never kept: the next request is a full one again, not a tail on nothing
calls.length = 0; a = await ask(); assert.equal(calls[0].from, '2026-11-16 00:00:00'); assert.deepEqual(plain(a), plain(await fresh()));
ok('the history kept from before the empty answer is still used');

// before the open the next day: a new day means a full fetch; then tails with nothing for today are fine
clock = Date.parse('2026-11-17T08:40:00+05:30'); calls.length = 0;
a = await ask(); assert.equal(calls[0].from, istStr(clock - DAYS * 86400e3)); ok('next day: full fetch again');
clock = Date.parse('2026-11-17T08:55:00+05:30'); calls.length = 0;
a = await ask(); assert.equal(calls.length, 1); assert.equal(calls[0].from, '2026-11-17 00:00:00'); assert.equal(calls[0].n, 0); assert.deepEqual(plain(a), plain(await fresh()));
ok('before the open: nothing for today yet is a normal answer (no second fetch), list unchanged');
clock = Date.parse('2026-11-17T09:21:00+05:30'); calls.length = 0;
a = await ask(); assert.equal(calls[0].n, 2); assert.deepEqual(plain(a), plain(await fresh())); ok('after the open: today\'s first candles are put on the end');

// daily candles are never kept
calls.length = 0; await ask('N_day', 'day'); await ask('N_day', 'day');
assert.equal(calls.length, 2); assert.ok(calls.every((c) => c.from === istStr(clock - DAYS * 86400e3))); assert.equal(__historyTail.has('N_day'), false);
ok('daily candles: a full fetch every time, nothing kept');

// a broker that ignores the start and sends the whole window back: only today's rows are used, nothing twice
clock = Date.parse('2026-11-17T11:00:00+05:30'); calls.length = 0;
const sloppy = async (_from: string, to: string) => broker(istStr(clock - DAYS * 86400e3), to);
a = await historyWithTail('N_5minute', '5minute', istStr(clock - DAYS * 86400e3), istStr(clock), sloppy, clock);
assert.deepEqual(plain(a), plain(await fresh())); assert.equal(new Set(a.map((r) => new Date(r.date).getTime())).size, a.length);
ok('a broker that returns more than today is asked for: still the same list, no candle twice');

// each instrument and interval has its own history, and only so many are kept
__historyTail.clear(); calls.length = 0;
for (let i = 0; i < 60; i++) await ask(`K${i}_5minute`);
assert.equal(__historyTail.size(), 48); assert.equal(__historyTail.has('K0_5minute'), false); assert.equal(__historyTail.has('K59_5minute'), true);
ok('at most 48 histories are kept; the oldest go first');

console.log(`history_tail: ${n} checks passed`);
