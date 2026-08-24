// Confluence buy/sell signals — FORWARD TEST. Records, grades, and draws its
// signals. Never trades.
//
// WHAT IT IS. The one rule Martin asked for, built from the three structure
// tools already on his chart, with definitions IDENTICAL to what the chart
// draws (ported from AdvancedChart.tsx — if the chart shows a live bullish
// order block, this engine sees the same block):
//
//   BUY  when  (1) market structure says trend is UP (last BOS/CHoCH bullish)
//         and  (2) price pulls back INTO a live bullish Order Block or FVG
//         and  (3) the candle CLOSES back above that zone.
//   SELL is the exact mirror.
//
// WHY IT SHIPS WITH A SCORECARD AND NOT A PROMISE. The 1,728-rule search
// showed ~85% of price-action rules lose after option-level costs, and this
// confluence rule was never part of a pre-registered test. So it must EARN
// trust: every signal is logged the moment its candle closes, graded at the
// day's end in option terms, and no verdict is offered before 30 signals.
// A backtest over ~2 years runs automatically AFTER market close (never
// during hours — history pulls go through the same proxy as orders) and its
// number is reported as context only, because that history has already been
// examined once by the search. The live tally is the evidence.
//
// THE RULE IS FROZEN as of 2026-08-24. Nothing here may be tuned while the
// forward test runs. Signals only ever come from CLOSED candles, so an arrow,
// once drawn, can never repaint. No order path is touched from this module.

import cron from 'node-cron';
import { getKiteClient, getBseIndexToken } from './kite_service';
import { istDateStr, toISTString } from './gap_scorecard';
import { isNseHoliday } from './calendar_service';
import { optionPnl, PA_COST } from './pa_search';
import { atr14, Bar } from './inside_bar';
import { kiteFiveMin } from './sweep_reclaim';

const IST_MS = 5.5 * 3600 * 1000;
const minOfDay = (t: number) => { const x = new Date(t + IST_MS); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const dayKey = (t: number) => { const x = new Date(t + IST_MS); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`; };

export const CONF_RULE = {
  timeframe: '5minute',
  windowFrom: 570, windowTo: 870,   // candle START 09:30 - 14:30 IST
  contextBars: 400,                 // ~5 sessions of 5-min bars behind each decision
  minZoneAgeBars: 3,                // a zone may not trigger on the candle that created it
  stop: 'atr14',
  exitFromMin: 900,                 // hold to the 15:00 candle's close
  maxPerDay: 3,                     // per index
  minGapMin: 15,                    // per index, between signals
  oncePerZone: true,                // a zone fires once, ever
  frozenOn: '2026-08-24',
};

// ------------------------------------------------------------------ detectors
// Ported from the chart so the engine and the screen can never disagree.
// Field name is `t` here (server bars) where the chart uses `time`.

function fvgZones(bars: Bar[]): any[] {
  const tail = bars.slice(-20);
  const avgRange = tail.length ? tail.reduce((a, c) => a + (c.high - c.low), 0) / tail.length : 0;
  const minGap = Math.max(4, +(0.3 * avgRange).toFixed(1));
  const zones: any[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const a = bars[i - 1], c = bars[i + 1];
    if (c.low > a.high && c.low - a.high >= minGap) {
      zones.push({ type: 'bull', top: c.low, bottom: a.high, t: bars[i].t, born: i });
    } else if (c.high < a.low && a.low - c.high >= minGap) {
      zones.push({ type: 'bear', top: a.low, bottom: c.high, t: bars[i].t, born: i });
    }
  }
  const live: any[] = [];
  for (const z of zones) {
    let top = z.top, bottom = z.bottom, dead = false;
    for (let k = z.born + 2; k < bars.length && !dead; k++) {
      if (z.type === 'bull') {
        if (bars[k].low <= bottom) dead = true;
        else if (bars[k].low < top) top = bars[k].low;
      } else {
        if (bars[k].high >= top) dead = true;
        else if (bars[k].high > bottom) bottom = bars[k].high;
      }
    }
    if (!dead && top - bottom >= minGap * 0.5) live.push({ ...z, top, bottom });
  }
  return live.slice(-8);
}

function orderBlocks(bars: Bar[]): any[] {
  if (!bars || bars.length < 3) return [];
  const tail = bars.slice(-20);
  const avgRange = tail.length ? tail.reduce((a, c) => a + (c.high - c.low), 0) / tail.length : 0;
  const minDisp = Math.max(10, +(1.2 * avgRange).toFixed(1));
  const found: any[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const c = bars[i], n = bars[i + 1];
    if (!c || !n) continue;
    const bull = c.close < c.open && n.close > c.high && (n.close - c.low) >= minDisp;
    const bear = c.close > c.open && n.close < c.low && (c.high - n.close) >= minDisp;
    if (!bull && !bear) continue;
    if (found.length && i - found[found.length - 1].born <= 1) continue;
    found.push({ type: bull ? 'bull' : 'bear', top: c.high, bottom: c.low, t: c.t, born: i });
  }
  for (let k = 0; k < found.length; k++) {
    const z = found[k];
    const supersededAt = k + 1 < found.length ? found[k + 1].born : Infinity;
    let ended = false;
    for (let m = z.born + 2; m < bars.length; m++) {
      if (m >= supersededAt) { ended = true; break; }
      const cc = bars[m];
      if (z.type === 'bull' ? cc.close < z.bottom : cc.close > z.top) { ended = true; break; }
    }
    z.live = !ended;
  }
  return found.slice(-6);
}

function marketStructure(bars: Bar[]): any[] {
  const n = 2;
  if (!bars || bars.length < n * 2 + 3) return [];
  const swings: { i: number; price: number; kind: 'H' | 'L' }[] = [];
  for (let i = n; i < bars.length - n; i++) {
    let isHigh = true, isLow = true;
    for (let k = i - n; k <= i + n; k++) {
      if (k === i) continue;
      if (bars[k].high >= bars[i].high) isHigh = false;
      if (bars[k].low <= bars[i].low) isLow = false;
    }
    if (isHigh) swings.push({ i, price: bars[i].high, kind: 'H' });
    else if (isLow) swings.push({ i, price: bars[i].low, kind: 'L' });
  }
  if (!swings.length) return [];
  const events: any[] = [];
  let trend: 'UP' | 'DOWN' | null = null;
  let lastHigh: { i: number; price: number } | null = null;
  let lastLow: { i: number; price: number } | null = null;
  let si = 0;
  for (let i = 0; i < bars.length; i++) {
    while (si < swings.length && swings[si].i + n <= i) {
      const sw = swings[si++];
      if (sw.kind === 'H') lastHigh = { i: sw.i, price: sw.price };
      else lastLow = { i: sw.i, price: sw.price };
    }
    const c = bars[i];
    if (lastHigh && c.close > lastHigh.price) {
      events.push({ type: trend === 'DOWN' ? 'CHOCH' : 'BOS', dir: 'bull', level: lastHigh.price, born: i });
      trend = 'UP'; lastHigh = null;
    } else if (lastLow && c.close < lastLow.price) {
      events.push({ type: trend === 'UP' ? 'CHOCH' : 'BOS', dir: 'bear', level: lastLow.price, born: i });
      trend = 'DOWN'; lastLow = null;
    }
  }
  return events;
}

// ------------------------------------------------------------------ the rule
export type ConfSignal = {
  symbol: string; date: string; firedAtMin: number; firedT: number;
  dir: 'LONG' | 'SHORT'; zoneSrc: 'OB' | 'FVG'; zoneTop: number; zoneBottom: number; zoneT: number;
  entry: number; stop: number; atr: number;
};

/** Evaluates ONLY the last bar of `bars`. Bars must be closed and chronological. */
export function detectConfluence(symbol: string, bars: Bar[]): ConfSignal | null {
  const R = CONF_RULE;
  if (!bars || bars.length < 60) return null;
  const w = bars.slice(-R.contextBars);
  const b = w[w.length - 1];
  const m = minOfDay(b.t);
  if (m < R.windowFrom || m > R.windowTo) return null;

  const ev = marketStructure(w);
  if (!ev.length) return null;
  const trend = ev[ev.length - 1].dir as 'bull' | 'bear';

  const maxBorn = w.length - 1 - R.minZoneAgeBars;
  const zones: any[] = [
    ...orderBlocks(w).filter(z => z.live).map(z => ({ ...z, src: 'OB' })),
    ...fvgZones(w).map(z => ({ ...z, src: 'FVG' })),
  ].filter(z => z.born <= maxBorn);

  let best: any = null;
  if (trend === 'bull') {
    for (const z of zones) {
      if (z.type !== 'bull') continue;
      if (b.low <= z.top && b.close > z.top) {
        if (!best || z.t > best.t) best = { ...z, dir: 'LONG' };
      }
    }
  } else {
    for (const z of zones) {
      if (z.type !== 'bear') continue;
      if (b.high >= z.bottom && b.close < z.bottom) {
        if (!best || z.t > best.t) best = { ...z, dir: 'SHORT' };
      }
    }
  }
  if (!best) return null;

  const a = atr14(w, w.length - 1);
  if (!(a > 0)) return null;
  const entry = b.close;
  const stop = best.dir === 'LONG' ? entry - a : entry + a;
  return {
    symbol, date: dayKey(b.t), firedAtMin: m, firedT: b.t,
    dir: best.dir, zoneSrc: best.src, zoneTop: +best.top.toFixed(2), zoneBottom: +best.bottom.toFixed(2), zoneT: best.t,
    entry: +entry.toFixed(2), stop: +stop.toFixed(2), atr: +a.toFixed(2),
  };
}

/** Grade against the bars AFTER the signal (same day). Stop assumed first when ambiguous. */
export function gradeConfSignal(sig: { firedAtMin: number; dir: string; entry: number; stop: number }, bars: Bar[]) {
  const long = sig.dir === 'LONG';
  let exit: number | null = null, reason = '', exitMin = sig.firedAtMin;
  for (const b of bars) {
    const m = minOfDay(b.t);
    if (m <= sig.firedAtMin) continue;
    exitMin = m;
    const stopHit = long ? b.low <= sig.stop : b.high >= sig.stop;
    if (stopHit) { exit = sig.stop; reason = 'STOP'; break; }
    if (m >= CONF_RULE.exitFromMin) { exit = b.close; reason = 'EOD'; break; }
  }
  if (exit === null) {
    const last = bars[bars.length - 1];
    if (!last) return null;
    exit = last.close; reason = 'EOD'; exitMin = minOfDay(last.t);
  }
  const indexPts = +(long ? exit - sig.entry : sig.entry - exit).toFixed(2);
  return {
    exit: +exit.toFixed(2), exitReason: reason, heldMin: exitMin - sig.firedAtMin,
    indexPts, optionPts: optionPnl(indexPts, exitMin - sig.firedAtMin),
  };
}

// ------------------------------------------------------------------ live data
async function recentBars(token: number): Promise<Bar[]> {
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) throw new Error('no Kite session');
  const raw = await kc.getHistoricalData(token, '5minute', toISTString(Date.now() - 9 * 86400000), toISTString(Date.now()));
  return (raw || [])
    .map((c: any) => ({ t: new Date(c.date).getTime(), open: c.open, high: c.high, low: c.low, close: c.close }))
    .sort((a: Bar, b: Bar) => a.t - b.t);
}

async function liveSymbols(): Promise<Array<{ sym: string; token: number }>> {
  const out = [{ sym: 'NIFTY', token: 256265 }, { sym: 'BANKNIFTY', token: 260105 }];
  try {
    const t = await getBseIndexToken('SENSEX');
    if (t) out.push({ sym: 'SENSEX', token: Number(t) });
  } catch (e) { /* SENSEX simply skipped this cycle */ }
  return out;
}

// ------------------------------------------------------------------ jobs
export async function scanConfluence(db: any): Promise<any> {
  const date = istDateStr();
  const results: any[] = [];
  for (const { sym, token } of await liveSymbols()) {
    try {
      const dayRows: any[] = db.prepare('SELECT fired_at_min FROM conf_signals WHERE symbol = ? AND date = ? ORDER BY fired_at_min').all(sym, date);
      if (dayRows.length >= CONF_RULE.maxPerDay) { results.push({ sym, skipped: 'maxPerDay' }); continue; }
      const bars = await recentBars(token);
      // Only CLOSED bars — the forming one is dropped, so nothing is ever
      // detected from a candle the market had not finished printing.
      const closed = bars.filter(b => b.t + 5 * 60000 <= Date.now());
      // Check the last few closed bars, not just the newest, so a restart or a
      // slow cycle cannot silently skip a bar. Dedupe below makes this safe.
      const from = Math.max(60, closed.length - 3);
      for (let k = from; k <= closed.length; k++) {
        const sig = detectConfluence(sym, closed.slice(0, k));
        if (!sig || sig.date !== date) continue;
        const lastMin = dayRows.length ? dayRows[dayRows.length - 1].fired_at_min : null;
        if (lastMin !== null && sig.firedAtMin - lastMin < CONF_RULE.minGapMin) continue;
        const r = db.prepare(`INSERT OR IGNORE INTO conf_signals
          (symbol, date, fired_at_min, fired_t, dir, zone_src, zone_top, zone_bottom, zone_t, entry, stop, atr, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`)
          .run(sym, sig.date, sig.firedAtMin, sig.firedT, sig.dir, sig.zoneSrc, sig.zoneTop, sig.zoneBottom, sig.zoneT, sig.entry, sig.stop, sig.atr, Date.now());
        if (r.changes) {
          dayRows.push({ fired_at_min: sig.firedAtMin });
          console.log(`[confluence] ${sym} ${sig.dir} @ ${sig.entry} off ${sig.zoneSrc} — logged, NOT traded`);
          results.push({ sym, signal: sig });
        }
      }
    } catch (e: any) { results.push({ sym, error: e?.message || String(e) }); }
    await new Promise(r => setTimeout(r, 1200));   // never burst the proxy
  }
  return { date, results };
}

export async function gradeConfluence(db: any): Promise<any> {
  const date = istDateStr();
  const open: any[] = db.prepare('SELECT * FROM conf_signals WHERE date = ? AND status = ?').all(date, 'OPEN');
  if (!open.length) return { skipped: 'nothing open to grade', date };
  const graded: any[] = [];
  for (const { sym, token } of await liveSymbols()) {
    const mine = open.filter(r => r.symbol === sym);
    if (!mine.length) continue;
    try {
      const bars = (await recentBars(token)).filter(b => dayKey(b.t) === date);
      for (const row of mine) {
        const g = gradeConfSignal({ firedAtMin: row.fired_at_min, dir: row.dir, entry: row.entry, stop: row.stop }, bars);
        if (!g) continue;
        db.prepare(`UPDATE conf_signals SET status='GRADED', exit_px=?, exit_reason=?, held_min=?, index_pts=?, option_pts=?, graded_at=? WHERE id=?`)
          .run(g.exit, g.exitReason, g.heldMin, g.indexPts, g.optionPts, Date.now(), row.id);
        graded.push({ sym, id: row.id, ...g });
        console.log(`[confluence] graded ${sym} ${row.dir}: ${g.indexPts} index pts → ${g.optionPts} after option costs`);
      }
    } catch (e: any) { graded.push({ sym, error: e?.message || String(e) }); }
    await new Promise(r => setTimeout(r, 1200));
  }
  return { date, graded };
}

// ------------------------------------------------------------------ scorecard
function bucket(rows: any[]) {
  const n = rows.length;
  if (!n) return { n: 0 };
  const tot = rows.reduce((a, r) => a + (r.option_pts || 0), 0);
  const avg = tot / n;
  const sd = Math.sqrt(rows.reduce((a, r) => a + ((r.option_pts || 0) - avg) ** 2, 0) / Math.max(1, n - 1));
  let eq = 0, peak = 0, mdd = 0;
  for (const r of rows) { eq += r.option_pts || 0; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak); }
  return {
    n,
    winRate: +(rows.filter(r => (r.option_pts || 0) > 0).length / n * 100).toFixed(1),
    totalOptionPts: +tot.toFixed(1), avgOptionPts: +avg.toFixed(2),
    maxDrawdownPts: +mdd.toFixed(1),
    tStat: sd > 0 ? +(avg / (sd / Math.sqrt(n))).toFixed(2) : null,
  };
}

export function confScorecard(db: any) {
  const rows: any[] = db.prepare('SELECT * FROM conf_signals WHERE status = ? ORDER BY date, fired_at_min').all('GRADED');
  const per: any = {};
  for (const s of ['NIFTY', 'BANKNIFTY', 'SENSEX']) {
    const b = bucket(rows.filter(r => r.symbol === s));
    if (b.n) per[s] = b;
  }
  const all = bucket(rows) as any;
  const n = all.n || 0;
  return {
    ...all,
    perSymbol: per,
    byDirection: { long: rows.filter(r => r.dir === 'LONG').length, short: rows.filter(r => r.dir === 'SHORT').length },
    byZone: { OB: rows.filter(r => r.zone_src === 'OB').length, FVG: rows.filter(r => r.zone_src === 'FVG').length },
    verdict: n < 30
      ? `${n}/30 signals — too early to judge`
      : (all.avgOptionPts || 0) > 0
        ? 'positive on live data nobody mined — discuss sizing ONE small lot; still not proof'
        : 'negative on live data — the confluence idea has not survived contact with reality',
  };
}

// ------------------------------------------------------------------ backtest
const btJob: { status: string; progress: string; error: string | null } = { status: 'idle', progress: '', error: null };

export async function runConfBacktest(db: any, days = 730): Promise<any> {
  if (btJob.status === 'running') return { skipped: 'already running', ...btJob };
  btJob.status = 'running'; btJob.error = null;
  try {
    const perSymbol: any = {};
    const everything: any[] = [];
    for (const { sym, token } of [{ sym: 'NIFTY', token: 256265 }, { sym: 'BANKNIFTY', token: 260105 }]) {
      btJob.progress = `fetching ${sym} 5-min history…`;
      const bars: Bar[] = await kiteFiveMin(token, days);
      if (bars.length < 2000) { perSymbol[sym] = { error: `only ${bars.length} bars` }; continue; }
      btJob.progress = `walking ${sym}: ${bars.length} bars…`;
      const dayEnd: number[] = new Array(bars.length);
      for (let i = bars.length - 1, e = bars.length; i >= 0; i--) {
        if (i < bars.length - 1 && dayKey(bars[i].t) !== dayKey(bars[i + 1].t)) e = i + 1;
        dayEnd[i] = e;
      }
      const usedZones = new Set<string>();
      const perDay: Record<string, number[]> = {};
      const trades: any[] = [];
      for (let i = 60; i < bars.length; i++) {
        const m = minOfDay(bars[i].t);
        if (m < CONF_RULE.windowFrom || m > CONF_RULE.windowTo) continue;
        const d = dayKey(bars[i].t);
        const fired = perDay[d] || [];
        if (fired.length >= CONF_RULE.maxPerDay) continue;
        if (fired.length && m - fired[fired.length - 1] < CONF_RULE.minGapMin) continue;
        const sig = detectConfluence(sym, bars.slice(Math.max(0, i - CONF_RULE.contextBars + 1), i + 1));
        if (!sig) continue;
        const zk = `${sig.zoneSrc}|${sig.zoneT}`;
        if (usedZones.has(zk)) continue;
        usedZones.add(zk);
        const g = gradeConfSignal(sig, bars.slice(i + 1, dayEnd[i]));
        if (!g) continue;
        fired.push(m); perDay[d] = fired;
        const row = { symbol: sym, date: d, dir: sig.dir, zone_src: sig.zoneSrc, option_pts: g.optionPts, index_pts: g.indexPts, exit_reason: g.exitReason };
        trades.push(row); everything.push(row);
      }
      perSymbol[sym] = {
        ...bucket(trades),
        byDirection: { long: trades.filter(r => r.dir === 'LONG').length, short: trades.filter(r => r.dir === 'SHORT').length },
        byZone: { OB: trades.filter(r => r.zone_src === 'OB').length, FVG: trades.filter(r => r.zone_src === 'FVG').length },
        stoppedOut: trades.filter(r => r.exit_reason === 'STOP').length,
        firstDay: trades[0]?.date, lastDay: trades[trades.length - 1]?.date,
      };
    }
    const result = {
      generatedAt: Date.now(),
      rule: CONF_RULE,
      costModel: { ...PA_COST, note: 'NIFTY-calibrated option costs applied to all symbols — deliberately pessimistic' },
      combined: bucket(everything),
      perSymbol,
      honesty: 'this history was already examined once by the 1,728-rule search, so this number is CONTEXT, not proof. The forward scorecard on fresh data is the evidence.',
    };
    db.prepare('INSERT INTO gap_stats (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run('confluence_backtest', JSON.stringify(result), Date.now());
    btJob.status = 'done'; btJob.progress = `done: ${everything.length} historical signals`;
    console.log(`[confluence] backtest done — ${everything.length} signals over ~${days} days`);
    return result;
  } catch (e: any) {
    btJob.status = 'error'; btJob.error = e?.message || String(e);
    console.error('[confluence] backtest failed:', e);
    return { error: btJob.error };
  }
}

// ------------------------------------------------------------------ register
export function registerConfluence(app: any, db: any, guard: any) {
  db.exec(`CREATE TABLE IF NOT EXISTS conf_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT, date TEXT, fired_at_min INTEGER, fired_t INTEGER, dir TEXT,
    zone_src TEXT, zone_top REAL, zone_bottom REAL, zone_t INTEGER,
    entry REAL, stop REAL, atr REAL, status TEXT DEFAULT 'OPEN',
    exit_px REAL, exit_reason TEXT, held_min INTEGER, index_pts REAL, option_pts REAL,
    created_at INTEGER, graded_at INTEGER,
    UNIQUE(symbol, zone_src, zone_t)
  );`);

  // Watch for the frozen rule every 5 minutes through the trading day. Writes a
  // row and nothing else — no order path is reachable from this module.
  cron.schedule('*/5 9-14 * * 1-5', async () => {
    if (isNseHoliday(istDateStr())) return;
    try { await scanConfluence(db); } catch (e) { console.error('[confluence] scan failed', e); }
  }, { timezone: 'Asia/Kolkata' });

  // Grade after the 15:00 exit bar has closed (staggered after inside-bar's 15:20).
  cron.schedule('22 15 * * 1-5', async () => {
    if (isNseHoliday(istDateStr())) return;
    try { await gradeConfluence(db); } catch (e) { console.error('[confluence] grading failed', e); }
  }, { timezone: 'Asia/Kolkata' });

  // The backtest runs ITSELF, once, the first time the market is closed — never
  // during hours, because its history pulls ride the same proxy as live orders.
  const tryBacktest = async () => {
    try {
      if (btJob.status === 'running') return;
      const have = db.prepare('SELECT key FROM gap_stats WHERE key = ?').get('confluence_backtest');
      if (have) return;
      const now = Date.now();
      const x = new Date(now + IST_MS);
      const dow = x.getUTCDay();                       // 0 Sun … 6 Sat, in IST
      const m = minOfDay(now);
      const marketOpen = dow >= 1 && dow <= 5 && !isNseHoliday(istDateStr()) && m >= 555 && m <= 935;
      if (marketOpen) return;
      await runConfBacktest(db, 730);
    } catch (e) { console.error('[confluence] auto-backtest check failed', e); }
  };
  setTimeout(tryBacktest, 90_000);
  cron.schedule('45 * * * *', tryBacktest, { timezone: 'Asia/Kolkata' });

  app.get('/api/confluence', (_req: any, res: any) => {
    try {
      const rows = db.prepare('SELECT * FROM conf_signals ORDER BY date DESC, fired_at_min DESC LIMIT 200').all();
      const bt: any = db.prepare('SELECT json FROM gap_stats WHERE key = ?').get('confluence_backtest');
      res.json({
        rule: CONF_RULE,
        costModel: PA_COST,
        status: 'FORWARD TEST — signals are logged, graded and drawn on the chart; nothing is ever traded from here',
        scorecard: confScorecard(db),
        backtest: bt ? JSON.parse(bt.json) : { status: btJob.status === 'running' ? `running: ${btJob.progress}` : 'pending — runs automatically after market close', error: btJob.error },
        signals: rows.map((r: any) => ({
          ...r,
          firedAt: `${String(Math.floor(r.fired_at_min / 60)).padStart(2, '0')}:${String(r.fired_at_min % 60).padStart(2, '0')} IST`,
        })),
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Manual triggers for testing the plumbing.
  app.get('/api/confluence/scan', guard, async (_req: any, res: any) => {
    try { res.json(await scanConfluence(db)); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.get('/api/confluence/grade', guard, async (_req: any, res: any) => {
    try { res.json(await gradeConfluence(db)); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.get('/api/confluence/backtest', guard, (_req: any, res: any) => {
    runConfBacktest(db, 730);           // fire and report the job; result lands in /api/confluence
    res.json({ started: true, ...btJob });
  });

  console.log('[confluence] forward test registered — logs, grades, draws; never trades');
}
