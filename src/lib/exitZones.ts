// EXIT ZONES (23 Nov 2026). Martin: "After I take an entry I’m finding it difficult
// to take proper exit. Can you mark probable reversal zones once the trade is taken
// based on the previous chart structure and historical strong consolidation zones
// that would help in taking an exit decision."
//
// Shown only while a trade is open, only AHEAD of the trade (above the price for a
// trade that gains as the chart rises, below it for one that gains as it falls).
// A zone is where the chart has turned or stalled before:
//   * swing highs that price has not closed above since, and that were followed by
//     a real fall (not every wiggle);
//   * consolidations: 30 minutes or more inside a tight range on 5-minute candles,
//     an hour or more on 15-minute candles. The longer it lasted the stronger;
//   * the previous day's high and today's high.
// Things that sit at the same price are merged into one zone and their weights
// add up, so two old highs under an hour-long range read "strong" and a lone
// minor high reads "weak". Recent structure counts for more than old.
//
// Always computed from 5-minute and 15-minute candles, whatever timeframe the
// chart shows, so the zones do not move when the timeframe is changed.
//
// REFERENCE LEVELS, NOT A PREDICTION. Tested the same day on 4 years of NIFTY
// (project doc exit-zones-check-nov-2026): once price reached the nearest zone it
// turned back about as often as at a random level the same distance away (28.5%
// against 27.4% for a 36-point pull-back, 6,671 cases each; strong no better).
// Martin was shown that and asked for the zones anyway ("deploy the zone feature
// queued"), so the chart labels them "Zone", never "reversal", and nothing here
// places or exits an order.
//
// "down" trades are handled by flipping the prices (high <-> low, negated) and
// running the same "up" logic, so there is one code path to get right.

export type XzCandle = { time: number; open: number; high: number; low: number; close: number };
export type ExitZoneStrength = 'strong' | 'medium' | 'weak';
export type ExitZone = {
  top: number; bottom: number;
  /** the edge the trade reaches first */
  near: number;
  score: number; strength: ExitZoneStrength;
  reasons: string[];
  /** when the oldest thing in the zone formed (unix seconds): where the box starts */
  since: number;
};
export type ExitZoneOpts = {
  dir: 'up' | 'down';
  /** the latest price on the chart */
  price: number;
  /** where the trade was entered ON THIS CHART's scale, if known */
  entry?: number | null;
  /** when it was entered (unix seconds, same clock as the candles), if known */
  entryTime?: number | null;
  /** at most this many zones, nearest first (default 4) */
  max?: number;
};

type Band = { lo: number; hi: number; w: number; why: string; t: number };

// Where "strong" and "medium" start. Set from 4 years of NIFTY so the words mean
// something: about the top quarter of zones by weight are strong, the bottom
// quarter weak. (The first cut had them at 3.2 and 1.8 and called 7 zones in 10
// strong.) They rank how much structure sits at a price, nothing more.
const STRONG = 8.5, MEDIUM = 4.2;

const istDay = (t: number) => Math.floor((t + 19800) / 86400);
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Typical size of one candle: the median true range of the last `n` candles. */
export function typicalRange(c: XzCandle[], n = 80): number {
  const out: number[] = [];
  for (let i = Math.max(1, c.length - n); i < c.length; i++) {
    out.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  }
  return median(out);
}

const flip = (c: XzCandle[]): XzCandle[] => c.map(k => ({ time: k.time, open: -k.open, high: -k.low, low: -k.high, close: -k.close }));

// How much a thing still counts, by how many trading days old it is.
function ageWeight(day: number, days: number[]): number {
  const back = days.length - 1 - days.indexOf(day);
  return back <= 0 ? 1 : back === 1 ? 0.9 : back <= 4 ? 0.75 : 0.6;
}

// Swing highs nothing has closed above since, each followed by a fall of at least
// 0.8 of a typical candle. A bigger fall is a stronger high.
function swingHighs(c: XzCandle[], L: number, a: number, base: number, days: number[], label: string): Band[] {
  const out: Band[] = [];
  const n = c.length;
  for (let i = L; i < n - L; i++) {
    const h = c[i].high;
    let ok = true;
    for (let j = i - L; j < i && ok; j++) if (c[j].high >= h) ok = false;
    for (let j = i + 1; j <= i + L && ok; j++) if (c[j].high > h) ok = false;
    if (!ok) continue;
    let broken = false;
    for (let j = i + 1; j < n; j++) if (c[j].close > h) { broken = true; break; }
    if (broken) continue;
    let lo = Infinity;
    for (let j = i + 1; j < Math.min(n, i + 1 + L * 4); j++) lo = Math.min(lo, c[j].low);
    const fall = h - lo;
    if (!(fall >= 0.8 * a)) continue;
    out.push({ lo: h - 0.25 * a, hi: h, w: base * (0.6 + Math.min(1.4, fall / (2 * a))) * ageWeight(istDay(c[i].time), days), why: label, t: c[i].time });
  }
  return out;
}

// Stretches of at least `minBars` candles, inside one day, whose whole range fits
// in `maxRange`. Greedy from the left; a stretch is used once.
function consolidations(c: XzCandle[], minBars: number, maxRange: number, barMin: number, base: number, days: number[]): (Band & { end: number })[] {
  const out: (Band & { end: number })[] = [];
  let i = 0;
  while (i < c.length) {
    let hi = c[i].high, lo = c[i].low, j = i;
    const d = istDay(c[i].time);
    while (j + 1 < c.length && istDay(c[j + 1].time) === d) {
      const h2 = Math.max(hi, c[j + 1].high), l2 = Math.min(lo, c[j + 1].low);
      if (h2 - l2 > maxRange) break;
      hi = h2; lo = l2; j++;
    }
    const bars = j - i + 1;
    if (bars >= minBars) {
      const mins = bars * barMin;
      const dur = mins >= 120 ? `${Math.round(mins / 30) / 2} h` : `${mins} min`;
      out.push({ lo, hi, w: base * (0.8 + Math.min(1.7, 0.5 * bars / minBars)) * ageWeight(d, days), why: `${dur} consolidation`, t: c[i].time, end: c[j].time });
      i = j + 1;
    } else i++;
  }
  return out;
}

function zonesUp(c5: XzCandle[], c15: XzCandle[], o: ExitZoneOpts, names: { swing: string; pd: string; day: string }): ExitZone[] {
  if (c5.length < 30 || !(o.price > 0 || o.price < 0)) return [];
  const a = typicalRange(c5), a15 = c15.length > 10 ? typicalRange(c15) : a * 1.8;
  if (!(a > 0)) return [];
  const days5 = [...new Set(c5.map(k => istDay(k.time)))];
  const days15 = [...new Set(c15.map(k => istDay(k.time)))];
  const bands: Band[] = [];

  bands.push(...swingHighs(c5, 3, a, 1, days5, names.swing));
  bands.push(...swingHighs(c15, 2, a, 1.4, days15, names.swing));

  const lastT = c5[c5.length - 1].time;
  const boxes = [...consolidations(c5, 6, 1.5 * a, 5, 1, days5), ...consolidations(c15, 4, 1.3 * a15, 15, 1.25, days15)];
  for (const b of boxes) {
    // the range the price is still building right now is not somewhere to exit INTO
    if (b.end >= lastT - 15 * 60 && o.price >= b.lo && o.price <= b.hi) continue;
    // nor is the base the trade was entered from
    if (o.entry != null && o.entryTime != null && o.entry >= b.lo && o.entry <= b.hi && b.end >= o.entryTime - 20 * 60 && b.t <= o.entryTime) continue;
    bands.push(b);
  }

  // previous day's high, and today's high once it is at least 30 minutes old
  const today = days5[days5.length - 1], prev = days5.length > 1 ? days5[days5.length - 2] : null;
  let pdh = -Infinity, pdT = 0, dh = -Infinity, dhT = 0;
  for (const k of c5) {
    const d = istDay(k.time);
    if (d === prev && k.high > pdh) { pdh = k.high; pdT = k.time; }
    if (d === today && k.high > dh) { dh = k.high; dhT = k.time; }
  }
  if (Number.isFinite(pdh)) bands.push({ lo: pdh - 0.2 * a, hi: pdh, w: 1.5, why: names.pd, t: pdT });
  if (Number.isFinite(dh) && lastT - dhT >= 30 * 60) bands.push({ lo: dh - 0.2 * a, hi: dh, w: 1.2, why: names.day, t: dhT });

  // only what is still ahead: not yet closed through, and not the entry itself
  const lastClose = c5[c5.length - 1].close;
  const ref = Math.max(o.price, lastClose);
  // ...and not something the price was already inside when the trade was taken: a
  // band has to START beyond the entry (or, with no entry known, be no more than
  // just touched). Without this the first thing drawn on NIFTY was the range the
  // price was sitting in: a band across the whole chart, "price is in it", that
  // said nothing about where to get out. A zone the trade has since moved INTO
  // stays, until a candle closes through it.
  const behind = o.entry != null ? o.entry + 0.3 * a : ref - 0.3 * a;
  const ahead = bands.filter(b => b.hi > ref && b.lo > behind);
  ahead.sort((x, y) => x.lo - y.lo);

  // Merge what overlaps or nearly touches; a merged zone is never wider than 2
  // candles. ZONES NEVER OVERLAP EACH OTHER: a band that reaches back into a full
  // zone either belongs to it (half or more of it is inside: its weight is added,
  // the zone is not stretched) or starts the next zone from where that one ends.
  // The first cut started a new zone from the band's own bottom and drew three
  // bands on top of one another.
  const groups: { lo: number; hi: number; items: Band[] }[] = [];
  for (const b of ahead) {
    const g = groups[groups.length - 1];
    if (g && b.lo <= g.hi + 0.1 * a && Math.max(g.hi, b.hi) - g.lo <= 2 * a) { g.items.push(b); g.hi = Math.max(g.hi, b.hi); }
    else if (g && b.lo < g.hi && (Math.min(g.hi, b.hi) - b.lo) >= 0.5 * (b.hi - b.lo)) g.items.push(b);
    else groups.push({ lo: g ? Math.max(b.lo, g.hi) : b.lo, hi: b.hi, items: [b] });
  }
  const zones: ExitZone[] = groups.filter(G => G.hi > G.lo).map(G => {
    const g = G.items, lo = G.lo, hi = G.hi;
    // the same high seen on both 5m and 15m is one high, counted once in the words
    const swings: number[] = [];
    for (const b of g) if (b.why === names.swing && !swings.some(p => Math.abs(p - b.hi) < 0.1 * a)) swings.push(b.hi);
    const reasons: string[] = [];
    if (swings.length) reasons.push(swings.length > 1 ? `${swings.length} ${names.swing}s` : names.swing);
    const cons = g.filter(b => / consolidation$/.test(b.why)).sort((x, y) => y.w - x.w)[0];
    if (cons) reasons.push(cons.why);
    if (g.some(b => b.why === names.pd)) reasons.push(names.pd);
    if (g.some(b => b.why === names.day)) reasons.push(names.day);
    const score = g.reduce((s, b) => s + b.w, 0);
    return { bottom: lo, top: hi, near: lo, score: +score.toFixed(2), strength: score >= STRONG ? 'strong' : score >= MEDIUM ? 'medium' : 'weak', reasons, since: Math.min(...g.map(b => b.t)) };
  });
  // nearest first. Weak ones are kept only to make up the first two.
  const max = o.max ?? 4;
  const solid = zones.filter(z => z.strength !== 'weak');
  const pick = solid.length >= 2 ? solid : zones.filter(z => z.strength !== 'weak' || zones.indexOf(z) < 2);
  return pick.slice(0, max);
}

export function computeExitZones(c5: XzCandle[], c15: XzCandle[], o: ExitZoneOpts): ExitZone[] {
  if (o.dir === 'up') return zonesUp(c5, c15, o, { swing: 'swing high', pd: 'previous day high', day: 'day high' });
  const z = zonesUp(flip(c5), flip(c15), { ...o, price: -o.price, entry: o.entry == null ? o.entry : -o.entry },
    { swing: 'swing low', pd: 'previous day low', day: 'day low' });
  return z.map(k => ({ ...k, top: -k.bottom, bottom: -k.top, near: -k.near }));
}

/** Which way a position gains on the chart it is drawn on. */
export function tradeDirOnChart(symbol: string, side: string, chartIsTheContract: boolean): 'up' | 'down' {
  const buy = String(side).toUpperCase() !== 'SELL';
  if (chartIsTheContract) return buy ? 'up' : 'down';
  const put = /PE$/.test(String(symbol).toUpperCase());
  return buy !== put ? 'up' : 'down';
}
