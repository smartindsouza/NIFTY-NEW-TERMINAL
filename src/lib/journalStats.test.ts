// The Trade Journal's periods and sums. Run: npx tsx src/lib/journalStats.test.ts
import assert from 'node:assert/strict';
import { istDay, sessionDay, ordinalDay, dayTitle, addDays, weekday, periodRange, shiftPeriod, dayTallies, sumDays, valueOf, quality, monthGrid, weekCells, monthWeeks, yearMonths, profitAndLoss, compact, fyStart, dayLabel } from './journalStats';
import { orderName } from './optionName';

// ── days are IST days ──
const ist = (day: string, hhmm: string) => { const [y, m, d] = day.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return Date.UTC(y, m - 1, d, h, mi) - 5.5 * 3600e3; };
assert.equal(istDay(ist('2026-11-16', '09:15')), '2026-11-16');
assert.equal(istDay(ist('2026-11-16', '00:10')), '2026-11-16', 'ten past midnight IST is still the 16th (it is the 15th in UTC)');
assert.equal(istDay(ist('2026-11-16', '23:50')), '2026-11-16');
assert.equal(istDay(null), 'unknown');

// ── the day the card is on rolls over at 9:00 AM IST, not at midnight ──
assert.equal(sessionDay(ist('2026-11-17', '02:00')), '2026-11-16', '2 AM on Tuesday is still Monday\'s session');
assert.equal(sessionDay(ist('2026-11-17', '08:59')), '2026-11-16');
assert.equal(sessionDay(ist('2026-11-17', '09:00')), '2026-11-17', 'nine o\'clock is the new day');
assert.equal(sessionDay(ist('2026-11-16', '23:59')), '2026-11-16');
assert.equal(sessionDay(ist('2026-11-01', '03:00')), '2026-10-31', 'across a month\'s end');

// ── a day as the list writes it ──
assert.equal(ordinalDay('2026-10-08'), '8th Oct 2026');
assert.deepEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-21', '2026-11-22', '2026-11-23', '2026-10-31'].map((d) => ordinalDay(d).split(' ')[0]),
  ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
assert.equal(dayTitle('2026-11-17', '2026-11-17'), 'Today');
assert.equal(dayTitle('2026-11-16', '2026-11-17'), 'Yesterday');
assert.equal(dayTitle('2026-10-31', '2026-11-01'), 'Yesterday', 'yesterday across a month\'s end');
assert.equal(dayTitle('2026-10-08', '2026-11-17'), '8th Oct 2026');

// ── a contract as the list writes it ──
assert.equal(orderName('NIFTY26N1725250CE'), 'NIFTY 17 Nov 26 - 25250 CE');
assert.equal(orderName('SENSEX26O0872000PE'), 'SENSEX 08 Oct 26 - 72000 PE');
assert.equal(orderName('BANKNIFTY27MAR58500CE'), 'BANK NIFTY Mar 27 - 58500 CE', 'a monthly symbol has no day');
assert.equal(orderName('NIFTY2692223350PE'), 'NIFTY 22 Sep 26 - 23350 PE');
assert.equal(orderName('RELIANCE'), 'RELIANCE');
assert.equal(addDays('2026-02-28', 1), '2026-03-01'); assert.equal(addDays('2028-02-28', 1), '2028-02-29'); assert.equal(addDays('2026-01-01', -1), '2025-12-31');
assert.equal(weekday('2026-11-16'), 1, '16 Nov 2026 is a Monday'); assert.equal(weekday('2026-11-01'), 0, '1 Nov 2026 is a Sunday');
assert.equal(dayLabel('2026-11-06'), '6 Nov 2026');

// ── the days a period covers ──
assert.deepEqual(periodRange('D', '2026-11-16'), { from: '2026-11-16', to: '2026-11-16', label: '16 Nov 2026' });
assert.deepEqual(periodRange('W', '2026-11-16'), { from: '2026-11-16', to: '2026-11-22', label: '16 Nov – 22 Nov' }, 'a Monday starts its own week');
assert.deepEqual(periodRange('W', '2026-11-22'), { from: '2026-11-16', to: '2026-11-22', label: '16 Nov – 22 Nov' }, 'a Sunday ends it');
assert.equal(periodRange('W', '2026-12-31').label, '28 Dec – 3 Jan', 'a week across the new year');
assert.deepEqual(periodRange('M', '2026-11-16'), { from: '2026-11-01', to: '2026-11-30', label: 'November 2026' });
assert.equal(periodRange('M', '2028-02-10').to, '2028-02-29', 'a leap February');
assert.deepEqual(periodRange('Y', '2026-11-16'), { from: '2026-04-01', to: '2027-03-31', label: 'FY 2026-27' });
assert.deepEqual(periodRange('Y', '2027-03-31'), { from: '2026-04-01', to: '2027-03-31', label: 'FY 2026-27' }, '31 March is the last day of the year that began the April before');
assert.equal(periodRange('Y', '2027-04-01').label, 'FY 2027-28');
assert.equal(periodRange('Y', '2099-06-01').label, 'FY 2099-00');
assert.equal(fyStart('2026-01-15'), 2025);

// ── stepping ──
assert.equal(shiftPeriod('D', '2026-11-16', -1), '2026-11-15'); assert.equal(shiftPeriod('W', '2026-11-16', 1), '2026-11-23');
assert.equal(shiftPeriod('M', '2026-01-31', 1), '2026-02-28', 'the 31st stepped into a shorter month lands on its last day');
assert.equal(shiftPeriod('M', '2026-01-15', -1), '2025-12-15'); assert.equal(shiftPeriod('M', '2026-12-15', 1), '2027-01-15');
assert.equal(shiftPeriod('Y', '2028-02-29', 1), '2029-02-28'); assert.equal(periodRange('Y', shiftPeriod('Y', '2026-11-16', -1)).label, 'FY 2025-26');

// ── what the trades of a day add up to ──
const T = (day: string, pnl: number | null, charges: number | null = null, extra: any = {}) =>
  ({ status: pnl === null ? 'OPEN' : 'CLOSED', entry_time: ist(day, '11:00'), pnl, charges, net_pnl: pnl === null || charges === null ? null : +(pnl - charges).toFixed(2), ...extra });
const trades = [
  T('2026-11-16', 500, 60), T('2026-11-16', -300, 58), T('2026-11-16', 20, 57), T('2026-11-16', null, 30),      // Mon: +220 gross, 205 charges
  T('2026-11-13', -1000, 60), T('2026-11-13', -200, 60),                                                        // Fri of the week before
  T('2026-11-02', 800, 60),                                                                                     // Mon 2 Nov
  T('2026-10-20', 2000, 120), T('2026-10-21', -500, 60),                                                        // October
  T('2026-03-30', 99999, 0),                                                                                    // the financial year before
];
const by = dayTallies(trades);
const mon = by.get('2026-11-16')!;
assert.equal(mon.trades, 4); assert.equal(mon.closed, 3); assert.equal(mon.open, 1);
assert.equal(mon.gross, 220); assert.equal(mon.charges, 205, "an open trade's entry charges are the day's too");
assert.equal(mon.net, 15, 'net is the realised P&L less ALL the charges of the day');
assert.equal(mon.winsG, 2); assert.equal(mon.lossesG, 1);
assert.equal(mon.winsN, 1, '+20 before charges is -37 after them: a loser on the net basis'); assert.equal(mon.lossesN, 2);
let q = quality(mon, 'gross'); assert.equal(Math.round(q.winRate!), 67); assert.equal(q.avgProfit, 260); assert.equal(q.avgLoss, -300);
q = quality(mon, 'net'); assert.equal(Math.round(q.winRate!), 33); assert.equal(q.avgProfit, 440); assert.equal(q.avgLoss, (-358 - 37) / 2);
assert.equal(quality(dayTallies([T('2026-11-16', null)]).get('2026-11-16')!, 'gross').winRate, null, 'no closed trade: no win rate, not 0%');
// a trade the server sent no net for is worked out the same way
assert.equal(dayTallies([{ status: 'CLOSED', entry_time: ist('2026-11-16', '10:30'), pnl: 100, charges: 58 }]).get('2026-11-16')!.winSumN, 42);
assert.equal(dayTallies([{ status: 'CLOSED', entry_time: ist('2026-11-16', '10:30'), pnl: 100 }]).get('2026-11-16')!.net, 100, 'no charges known: net is the gross');

const wk = sumDays(by, '2026-11-16', '2026-11-22'); assert.equal(wk.gross, 220); assert.equal(valueOf(wk, 'net'), 15);
const nov = sumDays(by, '2026-11-01', '2026-11-30'); assert.equal(nov.gross, 220 - 1200 + 800); assert.equal(nov.trades, 7);
const fy = periodRange('Y', '2026-11-16'); const yr = sumDays(by, fy.from, fy.to);
assert.equal(yr.gross, 220 - 1200 + 800 + 2000 - 500, 'March of the year before is not in it'); assert.equal(yr.closed, 8);

// ── the breakdowns ──
const grid = monthGrid(by, '2026-11-16');
assert.equal(grid.length, 5); assert.equal(grid[0][0]!.label, '1', 'November 2026 starts on a Sunday');
assert.equal(grid[4][1]!.label, '30'); assert.equal(grid[4][2], null);
assert.equal(grid[2][1]!.from, '2026-11-16'); assert.equal(grid[2][1]!.tally.gross, 220);
assert.equal(grid.flat().filter(Boolean).length, 30);
const oct = monthGrid(by, '2026-10-05'); assert.equal(oct[0][3], null); assert.equal(oct[0][4]!.label, '1', '1 Oct 2026 is a Thursday');
const feb = monthGrid(by, '2026-02-10'); assert.equal(feb.length, 4, 'February 2026 is exactly four Sunday-to-Saturday rows');

const w = weekCells(by, '2026-11-18');
assert.deepEqual(w.map(c => `${c.label} ${c.sub}`), ['Mon 16 Nov', 'Tue 17 Nov', 'Wed 18 Nov', 'Thu 19 Nov', 'Fri 20 Nov']);
assert.equal(w[0].tally.gross, 220); assert.equal(w[1].tally.trades, 0);

const mw = monthWeeks(by, '2026-11-16');
assert.deepEqual(mw.map(c => `${c.label} ${c.sub}`), ['W1 1–1 Nov', 'W2 2–8 Nov', 'W3 9–15 Nov', 'W4 16–22 Nov', 'W5 23–29 Nov', 'W6 30–30 Nov']);
assert.equal(mw[1].tally.gross, 800); assert.equal(mw[2].tally.gross, -1200); assert.equal(mw[3].tally.gross, 220);
assert.equal(mw.reduce((s, c) => s + c.tally.trades, 0), nov.trades, 'the weeks of a month hold every trade of it, once');
assert.deepEqual(monthWeeks(by, '2026-06-10').map(c => c.sub), ['1–7 Jun', '8–14 Jun', '15–21 Jun', '22–28 Jun', '29–30 Jun'], 'a month that starts on a Monday');

const ym = yearMonths(by, '2026-11-16');
assert.deepEqual(ym.map(c => c.label), ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar']);
assert.equal(ym[6].tally.gross, 1500); assert.equal(ym[7].tally.gross, -180); assert.equal(ym[11].from, '2027-03-01'); assert.equal(ym[11].tally.trades, 0);
assert.equal(ym.reduce((s, c) => s + c.tally.gross, 0), yr.gross);

assert.deepEqual(profitAndLoss(mw, 'gross'), { profit: 800 + 220, loss: -1200 });
assert.deepEqual(profitAndLoss(grid.flat(), 'gross'), { profit: 800 + 220, loss: -1200 });
assert.deepEqual(profitAndLoss(w, 'net'), { profit: 15, loss: 0 });

assert.equal(compact(520), '520'); assert.equal(compact(-999.4), '999'); assert.equal(compact(1250), '1.3K'); assert.equal(compact(-12000), '12.0K'); assert.equal(compact(125000), '1.3L');

console.log('journalStats: all checks passed');
