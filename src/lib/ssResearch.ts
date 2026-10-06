// SWAP-SWEEP FILTER RESEARCH — can a simple filter remove the signals that fail?
//
// Signals: the chart's own 5-min + 15-min agreement (confluenceSwapSweep, same-day
// candles), entered at the close of the 15-min candle that completes the signal,
// stop beyond the 5-min sweep, 2R target, exit at the day's close, costs charged.
// Simulated on 5-min candles by the same engine as the Backtesting screen.
//
// EVERYTHING BELOW WAS FIXED BEFORE ANY RESULT WAS SEEN, and must not be tuned
// after looking at results — that is what keeps the answer honest:
//   * The filter list and each filter's exact rule.
//   * The split: the first 70% of trading days are for choosing; the last 30% (the
//     hold-out) are looked at ONCE, only for the baseline and the chosen filter.
//   * The choice: on the first 70%, the filter with the best average R that keeps
//     at least MIN_N trades. If the best two can be combined and the combination
//     still keeps MIN_N trades and does better, the combination is chosen.
//   * The verdict (hold-out): the chosen filter must beat the unfiltered baseline on
//     BOTH win rate and average R, have a positive average R after costs, and keep
//     at least 20 trades. Anything less is reported as "not proven".
// Every filter uses only what was known at the moment of entry.

import { confluenceSwapSweep, backtestEntries, ssStats, ssTime, ssIstDay, type SsEntry, type SsTrade } from './swapSweep';

export const SS_RESEARCH = { rr: 2, costPts: 2, holdoutFrac: 0.3, minN: 40, minHoldN: 20 } as const;

type C = { time: number; open: number; high: number; low: number; close: number };
type Feat = { inWindow: boolean; dayExtreme: boolean; strongClose: boolean; bigC3: boolean; withTrend: boolean; counterTrend: boolean };
type Sig = SsEntry & { day: number; f: Feat; c15: C };

export const SS_FILTERS: { key: string; label: string; rule: string }[] = [
  { key: 'baseline',     label: 'No filter (as now)',          rule: 'Every 5m + 15m signal.' },
  { key: 'inWindow',     label: 'Time 10:00 – 14:30 only',     rule: 'Skip signals known before 10:00 or after 14:30 IST (the opening rush and the last hour).' },
  { key: 'dayExtreme',   label: 'Sweep makes the day\'s high/low', rule: 'The 15-min sweep candle sets a new high of the day (bearish) or a new low of the day (bullish).' },
  { key: 'strongClose',  label: 'Strong rejection close',      rule: 'The 15-min sweep candle closes in the bottom third of its range (bearish) or the top third (bullish).' },
  { key: 'bigC3',        label: 'Big sweep candle',            rule: 'The 15-min sweep candle\'s range is at least the average range of the 14 candles before it.' },
  { key: 'withTrend',    label: 'With the trend',              rule: 'Before the pattern (at C1), price was already below the 15-min 20 EMA for a bearish signal / above it for a bullish one.' },
  { key: 'counterTrend', label: 'Against the trend',           rule: 'Before the pattern (at C1), price was above the 15-min 20 EMA for a bearish signal / below it for a bullish one.' },
  { key: 'confirm',      label: 'Next 5-min candle confirms',  rule: 'Enter only if the next 5-min candle closes beyond the entry in the signal\'s direction; entry moves to that close. Otherwise no trade.' },
  { key: 'inverted',     label: 'Opposite direction',          rule: 'Take the OPPOSITE side of every signal (tests your "bearish is really a continuation" question). Same risk distance, same 2R target.' },
];
const COMBINABLE = ['inWindow', 'dayExtreme', 'strongClose', 'bigC3', 'withTrend', 'counterTrend'];

const norm = (c: any): C => ({ time: ssTime(c.time ?? c.t), open: +c.open, high: +c.high, low: +c.low, close: +c.close });
const istMin = (sec: number) => Math.floor(((sec + 19800) % 86400) / 60);

// Signals + features. Exported for the test harness.
export function ssResearchSignals(c5in: any[], c15in: any[]): { c5: C[]; sigs: Sig[] } {
  const c5 = (c5in || []).map(norm).filter((c) => Number.isFinite(c.time)).sort((a, b) => a.time - b.time);
  const c15 = (c15in || []).map(norm).filter((c) => Number.isFinite(c.time)).sort((a, b) => a.time - b.time);
  const { both } = confluenceSwapSweep(c5, c15, { sameSession: true, stop: '5' });
  const at15 = new Map<number, number>(); c15.forEach((c, i) => at15.set(c.time, i));
  // 15-min EMA20 of closes (value AT each candle, using that candle's close)
  const ema: number[] = []; const k = 2 / 21;
  c15.forEach((c, i) => { ema[i] = i === 0 ? c.close : c.close * k + ema[i - 1] * (1 - k); });
  const sigs: Sig[] = [];
  for (const e of both) {
    const j = at15.get(e.time - 600); if (j === undefined || j < 2) continue;
    const c3 = c15[j], c1 = c15[j - 2], bear = e.kind === 'bear';
    const day = ssIstDay(c3.time);
    let dayHi = -Infinity, dayLo = Infinity;                 // the day's candles BEFORE c3
    for (let i = j - 1; i >= 0 && ssIstDay(c15[i].time) === day; i--) { dayHi = Math.max(dayHi, c15[i].high); dayLo = Math.min(dayLo, c15[i].low); }
    const rng = c3.high - c3.low;
    let avg = 0, n = 0; for (let i = Math.max(0, j - 14); i < j; i++) { avg += c15[i].high - c15[i].low; n++; }
    avg = n ? avg / n : 0;
    const known = istMin(c3.time + 900);
    const above = c1.close > ema[j - 2], below = c1.close < ema[j - 2];
    const f: Feat = {
      inWindow: known >= 600 && known <= 870,
      dayExtreme: bear ? c3.high > dayHi : c3.low < dayLo,
      strongClose: rng > 0 && (bear ? (c3.close - c3.low) / rng <= 1 / 3 : (c3.high - c3.close) / rng <= 1 / 3),
      bigC3: n === 14 && rng >= avg,
      withTrend: bear ? below : above,
      counterTrend: bear ? above : below,
    };
    sigs.push({ ...e, day, f, c15: c3 });
  }
  return { c5, sigs };
}

function entriesFor(key: string, c5: C[], sigs: Sig[], keys?: string[]): SsEntry[] {
  const out: SsEntry[] = [];
  for (const s of sigs) {
    const base: SsEntry = { idx: s.idx, time: s.time, kind: s.kind, entry: s.entry, stop: s.stop };
    if (keys) { if (keys.every((kk) => (s.f as any)[kk])) out.push(base); continue; }
    if (key === 'baseline') out.push(base);
    else if (key === 'confirm') {
      const n = c5[s.idx + 1];
      if (!n || ssIstDay(n.time) !== s.day) continue;
      const ok = s.kind === 'bear' ? n.close < s.entry : n.close > s.entry;
      if (ok) out.push({ idx: s.idx + 1, time: n.time, kind: s.kind, entry: n.close, stop: s.stop });
    } else if (key === 'inverted') {
      const risk = Math.abs(s.stop - s.entry);
      const kind = s.kind === 'bear' ? 'bull' : 'bear';
      out.push({ ...base, kind, stop: kind === 'bull' ? s.entry - risk : s.entry + risk });
    } else if ((s.f as any)[key]) out.push(base);
  }
  return out;
}

export type SsRow = { trades: number; winRate: number; avgR: number; totalR: number; profitFactor: number | null; luck: number; maxLossStreak: number };
function row(tr: SsTrade[]): SsRow {
  const s = ssStats(tr); const n = tr.length;
  const mean = n ? s.avgR : 0;
  const sd = n > 1 ? Math.sqrt(tr.reduce((a, t) => a + (t.r - mean) ** 2, 0) / (n - 1)) : 0;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { trades: n, winRate: Math.round(s.winRate * 1000) / 10, avgR: r2(s.avgR), totalR: Math.round(s.totalR * 10) / 10,
    profitFactor: s.profitFactor === null ? null : r2(s.profitFactor), luck: n > 1 ? r2(1.96 * sd / Math.sqrt(n)) : 0, maxLossStreak: s.maxLossStreak };
}

export function runSsResearch(c5in: any[], c15in: any[], opts: { costPts?: number } = {}) {
  const cfg = { ...SS_RESEARCH, costPts: opts.costPts ?? SS_RESEARCH.costPts };
  const { c5, sigs } = ssResearchSignals(c5in, c15in);
  const days = [...new Set(c5.map((c) => ssIstDay(c.time)))].sort((a, b) => a - b);
  const cutDay = days[Math.floor(days.length * (1 - cfg.holdoutFrac))] ?? Infinity;
  const isIn = (t: SsTrade) => ssIstDay(t.time) < cutDay;
  const sim = (entries: SsEntry[]) => backtestEntries(c5, entries, { rr: cfg.rr, sessionExit: true, costPts: cfg.costPts });
  const trades: Record<string, SsTrade[]> = {};
  for (const f of SS_FILTERS) trades[f.key] = sim(entriesFor(f.key, c5, sigs));
  const inRows: Record<string, SsRow> = {};
  for (const f of SS_FILTERS) inRows[f.key] = row(trades[f.key].filter(isIn));
  const base = inRows.baseline;

  // choose on the first 70% only
  const cands = SS_FILTERS.filter((f) => f.key !== 'baseline' && inRows[f.key].trades >= cfg.minN)
    .sort((a, b) => inRows[b.key].avgR - inRows[a.key].avgR);
  let chosen: { key: string; label: string; keys?: string[] } | null = null;
  let chosenIn: SsRow | null = null;
  if (cands.length && inRows[cands[0].key].avgR > base.avgR) { chosen = { key: cands[0].key, label: cands[0].label }; chosenIn = inRows[cands[0].key]; }
  let combo: { label: string; row: SsRow } | null = null;
  const top2 = cands.filter((f) => COMBINABLE.includes(f.key)).slice(0, 2);
  if (top2.length === 2 && !(top2.some((f) => f.key === 'withTrend') && top2.some((f) => f.key === 'counterTrend'))) {
    const keys = top2.map((f) => f.key);
    const ct = sim(entriesFor('', c5, sigs, keys));
    trades.combo = ct;
    const cr = row(ct.filter(isIn));
    combo = { label: top2.map((f) => f.label).join(' + '), row: cr };
    if (cr.trades >= cfg.minN && cr.avgR > (chosenIn ? chosenIn.avgR : base.avgR)) { chosen = { key: 'combo', label: combo.label, keys }; chosenIn = cr; }
  }

  // hold-out: baseline and the chosen filter only, looked at once
  const hold = (k: string) => row(trades[k].filter((t) => !isIn(t)));
  const baseHold = hold('baseline');
  const chosenHold = chosen ? hold(chosen.key) : null;
  const pass = !!(chosenHold && chosenHold.trades >= cfg.minHoldN && chosenHold.avgR > baseHold.avgR
    && chosenHold.avgR > 0 && chosenHold.winRate > baseHold.winRate);
  const fmtDay = (d: number) => { const s = String(d); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
  return {
    config: cfg,
    period: { from: days.length ? fmtDay(days[0]) : null, to: days.length ? fmtDay(days[days.length - 1]) : null,
      days: days.length, holdoutFrom: Number.isFinite(cutDay) ? fmtDay(cutDay) : null, signals: sigs.length },
    filters: SS_FILTERS.map((f) => ({ ...f, inSample: inRows[f.key], eligible: f.key !== 'baseline' && inRows[f.key].trades >= cfg.minN })),
    combo,
    chosen: chosen ? { key: chosen.key, label: chosen.label, inSample: chosenIn } : null,
    holdout: { baseline: baseHold, chosen: chosenHold },
    verdict: !chosen ? 'NONE_BETTER' : pass ? 'PASS' : 'NOT_PROVEN',
  };
}
