// Overnight Gap Scorecard — signal engine, outcome recorder, endpoints, crons.
// Predicts next-day opening gap DIRECTION from signals available before the
// 15:30 close, scores its own accuracy every morning, and (Part 5) recommends a
// deep-ITM strike to express a fired bias. Advisory only — nothing here ever
// places an order.

import axios from 'axios';
import cron from 'node-cron';
import express from 'express';
import { getKiteClient, getLiveOptionChain, getIndexFuturesTokens } from './kite_service';
import { impliedVol, bsDelta } from './options_math';
import { GAP_CONFIG } from './config/gapScorecard';
import { registerGapBacktest } from './gap_backtest';
import { registerSweepReclaim } from './sweep_reclaim';

type AnyDb = any; // better-sqlite3 Database (typed loosely to avoid a hard dep here)

// ---------------------------------------------------------------- IST helpers
// IST is UTC+5:30 with no DST, so a fixed shift is exact.
const IST_MS = 5.5 * 60 * 60 * 1000;
export const istNow = () => new Date(Date.now() + IST_MS); // UTC fields = IST wall clock
export const istDateStr = (d?: Date) => {
  const x = d || istNow();
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};
// Kite's historical API expects IST-formatted 'YYYY-MM-DD HH:mm:ss' strings
// (same convention technical_analysis.ts already uses).
export const toISTString = (epochMs: number) => {
  const x = new Date(epochMs + IST_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}:${p(x.getUTCSeconds())}`;
};
const isWeekendIST = (d?: Date) => { const day = (d || istNow()).getUTCDay(); return day === 0 || day === 6; };
const isNseHoliday = (dateStr: string) => GAP_CONFIG.nseHolidays.includes(dateStr);
const addDaysIST = (dateStr: string, days: number) => {
  const [y, m, dd] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, dd) + days * 86400000;
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- Black-76
// Black-76 is Black-Scholes with S replaced by the discounted forward:
// price = e^(-rT)[F·N(d1) − K·N(d2)], d1 = (ln(F/K) + σ²T/2)/(σ√T).
// Setting S = F·e^(-rT) in the repo's existing BS solver reproduces this
// EXACTLY (both the price and d1), so we reuse the tested bisection rather
// than duplicating math. Delta returned is ∂premium/∂F = e^(-rT)·N(d1).
export function black76IvDelta(type: 'CE' | 'PE', F: number, K: number, T: number, r: number, price: number): { iv: number | null; delta: number | null } {
  if (!(F > 0) || !(K > 0) || !(T > 0) || !(price > 0)) return { iv: null, delta: null };
  const S = F * Math.exp(-r * T);
  const iv = impliedVol(type, S, K, T, r, price);
  if (iv === null) return { iv: null, delta: null };
  const delta = Math.exp(-r * T) * bsDelta(type, S, K, T, r, iv);
  return { iv, delta };
}

// ---------------------------------------------------------------- Yahoo fetch
// Reuses the app's existing axios pattern for Yahoo (same host the watchlist
// uses). Unofficial source → retry once, then fail soft (caller scores 0 and
// records a dataGap).
async function yahooChart(sym: string, range: string, interval: string): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`,
        { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const result = r.data?.chart?.result?.[0];
      if (result) return result;
    } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 400));
  }
  return null;
}
async function yahooPctVsPrevClose(sym: string): Promise<number | null> {
  const res = await yahooChart(sym, '1d', '5m');
  const meta = res?.meta;
  const price = meta?.regularMarketPrice;
  const prev = meta?.chartPreviousClose ?? meta?.previousClose;
  if (typeof price !== 'number' || typeof prev !== 'number' || prev === 0) return null;
  return ((price - prev) / prev) * 100;
}
async function yahooPctVsOwnOpen(sym: string): Promise<number | null> {
  const res = await yahooChart(sym, '1d', '5m');
  const meta = res?.meta;
  const price = meta?.regularMarketPrice;
  const opens = res?.indicators?.quote?.[0]?.open;
  const todayOpen = Array.isArray(opens) ? opens.find((v: any) => typeof v === 'number' && v > 0) : null;
  if (typeof price !== 'number' || !todayOpen) return null;
  return ((price - todayOpen) / todayOpen) * 100;
}

// ---------------------------------------------------------------- Snapshot
type Sig = { raw: any; score: number };
const W = GAP_CONFIG.weights;

export async function runSnapshot(db: AnyDb, opts: { dryRun?: boolean } = {}): Promise<any> {
  const dateStr = istDateStr();
  const dataGaps: string[] = [];
  const sig = (raw: any, score: number): Sig => ({ raw, score });
  const signals: Record<string, Sig> = {
    usFutures: sig(null, 0), europe: sig(null, 0), basis: sig(null, 0), clv: sig(null, 0),
    lastHour: sig(null, 0), vix: sig(null, 0), macro: sig(null, 0), breadth: sig(null, 0),
  };
  let cautionFlag = false;
  let staleData = false;

  const kc = getKiteClient();
  // @ts-ignore
  const kiteOk = !!(kc && kc.access_token);
  if (!kiteOk) dataGaps.push('kite: no active session — all Kite signals scored 0');

  // --- market-closed self-detection (holiday not in the list, weekend, etc.)
  let todayCandles: any[] = [];
  if (kiteOk) {
    try {
      const from = toISTString(Date.now() - 26 * 3600 * 1000);
      const to = toISTString(Date.now());
      const hist = await kc.getHistoricalData(256265, '15minute', from, to);
      todayCandles = (hist || []).filter((c: any) => {
        const d = new Date(c.date);
        return istDateStr(new Date(d.getTime() + 0)) === dateStr || String(c.date).slice(0, 10) === dateStr;
      });
    } catch (e: any) { dataGaps.push('kite historical: ' + (e?.message || e)); }
    if (!todayCandles.length) {
      if (!opts.dryRun) {
        console.log(`[gap] ${dateStr}: no NIFTY candles for today — market closed, snapshot skipped`);
        return { skipped: true, reason: 'market closed (no candles today)', date: dateStr };
      }
      staleData = true; dataGaps.push('no candles for today — dry run on stale/off-hours data');
    }
  }

  // --- 1. US futures (weight 2)
  try {
    const es = await yahooPctVsPrevClose(GAP_CONFIG.yahooSymbols.es);
    const nq = await yahooPctVsPrevClose(GAP_CONFIG.yahooSymbols.nq);
    if (es === null && nq === null) throw new Error('ES & NQ unavailable');
    const vals = [es, nq].filter((v): v is number => v !== null);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    signals.usFutures = sig(+avg.toFixed(3), avg > GAP_CONFIG.usFuturesPct ? 1 : avg < -GAP_CONFIG.usFuturesPct ? -1 : 0);
  } catch (e: any) { dataGaps.push('usFutures: ' + (e?.message || e)); }

  // --- 2. Europe (weight 1) — since their OWN open
  try {
    const dax = await yahooPctVsOwnOpen(GAP_CONFIG.yahooSymbols.dax);
    const ftse = await yahooPctVsOwnOpen(GAP_CONFIG.yahooSymbols.ftse);
    if (dax === null || ftse === null) throw new Error('DAX/FTSE unavailable');
    const score = dax > 0 && ftse > 0 ? 1 : dax < 0 && ftse < 0 ? -1 : 0;
    signals.europe = sig({ dax: +dax.toFixed(3), ftse: +ftse.toFixed(3) }, score);
  } catch (e: any) { dataGaps.push('europe: ' + (e?.message || e)); }

  // --- 7. Macro (weight 1)
  try {
    const brent = await yahooPctVsPrevClose(GAP_CONFIG.yahooSymbols.brent);
    const inr = await yahooPctVsPrevClose(GAP_CONFIG.yahooSymbols.usdinr); // USDINR up = rupee weaker
    if (brent === null || inr === null) throw new Error('Brent/USDINR unavailable');
    let score = 0;
    if (brent < -GAP_CONFIG.brentPct && inr <= 0) score = 1;
    else if (brent > GAP_CONFIG.brentPct || inr > GAP_CONFIG.rupeeWeakPct) score = -1;
    signals.macro = sig({ brent: +brent.toFixed(3), usdinr: +inr.toFixed(3) }, score);
  } catch (e: any) { dataGaps.push('macro: ' + (e?.message || e)); }

  // --- Kite-driven signals
  let spot: number | null = null;
  if (kiteOk) {
    try {
      const q = await kc.getQuote(['NSE:NIFTY 50', 'NSE:INDIA VIX']);
      const n = q?.['NSE:NIFTY 50'];
      const v = q?.['NSE:INDIA VIX'];

      // --- 4. Close location value (weight 1)
      if (n && n.last_price > 0 && n.ohlc) {
        spot = n.last_price;
        const { high, low } = n.ohlc;
        if (high > low) {
          const clv = (n.last_price - low) / (high - low);
          signals.clv = sig(+clv.toFixed(3), clv > GAP_CONFIG.clvHigh ? 1 : clv < GAP_CONFIG.clvLow ? -1 : 0);
        } else signals.clv = sig(null, 0);
      } else dataGaps.push('clv: NIFTY quote unavailable');

      // --- 6. India VIX (weight 1)
      if (v && v.last_price > 0 && v.ohlc && v.ohlc.close > 0) {
        const chg = ((v.last_price - v.ohlc.close) / v.ohlc.close) * 100;
        let score = 0;
        if (chg <= -GAP_CONFIG.vixDownPct) score = 1;
        else if (chg >= GAP_CONFIG.vixUpPct) score = -1;
        if (chg >= GAP_CONFIG.vixCautionPct) cautionFlag = true;
        signals.vix = sig(+chg.toFixed(3), score);
      } else dataGaps.push('vix: quote unavailable');
    } catch (e: any) { dataGaps.push('kite quote: ' + (e?.message || e)); }

    // --- 5. Last-hour momentum 14:15 → 15:15 (weight 1)
    try {
      const at = (hh: number, mm: number) => todayCandles.find((c: any) => {
        const s = String(c.date);
        return s.includes(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
      });
      const c1400 = at(14, 0);  // closes at 14:15
      const c1500 = at(15, 0);  // closes at 15:15
      if (c1400 && c1500 && c1400.close > 0) {
        const pct = ((c1500.close - c1400.close) / c1400.close) * 100;
        signals.lastHour = sig(+pct.toFixed(3), pct > GAP_CONFIG.lastHourPct ? 1 : pct < -GAP_CONFIG.lastHourPct ? -1 : 0);
      } else if (!staleData) dataGaps.push('lastHour: 14:00/15:00 candles missing');
    } catch (e: any) { dataGaps.push('lastHour: ' + (e?.message || e)); }

    // --- 3. Futures basis vs yesterday's snapshot (weight 1)
    try {
      const futs = await getIndexFuturesTokens('NIFTY');
      const cur = (futs || []).slice().sort((a, b) => a.expiry.localeCompare(b.expiry))[0];
      if (cur && spot) {
        // Quote by instrument token — getIndexFuturesTokens returns {token, expiry}.
        const lq = await kc.getLTP([String(cur.token)]).catch(() => null);
        const f: any = lq ? Object.values(lq)[0] : null;
        const futLtp: number | null = (f && f.last_price > 0) ? f.last_price : null;
        if (futLtp && futLtp > 0) {
          const basis = +(futLtp - spot).toFixed(2);
          const prevRow: any = db.prepare('SELECT json FROM gap_scorecard WHERE date < ? ORDER BY date DESC LIMIT 1').get(dateStr);
          const prevBasis = prevRow ? (JSON.parse(prevRow.json)?.signals?.basis?.raw ?? null) : null;
          let score = 0;
          if (typeof prevBasis === 'number') score = basis > prevBasis ? 1 : basis < prevBasis || basis < 0 ? -1 : 0;
          else if (basis < 0) { score = -1; dataGaps.push('basis: no prior snapshot — scored -1 on negative premium alone'); }
          else dataGaps.push('basis: no prior snapshot to compare — scored 0');
          signals.basis = sig(basis, score);
        } else dataGaps.push('basis: future LTP unavailable');
      } else if (!spot) dataGaps.push('basis: no spot');
      else dataGaps.push('basis: current-month future not found');
    } catch (e: any) { dataGaps.push('basis: ' + (e?.message || e)); }

    // --- 8. Breadth (weight 1) — one bulk quote, zero extra rate-limit cost
    try {
      const keys = GAP_CONFIG.nifty50.map(s => `NSE:${s}`);
      const bq = await kc.getQuote(keys);
      let adv = 0, dec = 0, counted = 0;
      for (const k of Object.keys(bq || {})) {
        const q: any = bq[k];
        if (q && q.last_price > 0 && q.ohlc && q.ohlc.close > 0) {
          counted++;
          if (q.last_price > q.ohlc.close) adv++; else if (q.last_price < q.ohlc.close) dec++;
        }
      }
      if (counted >= 30) {
        signals.breadth = sig({ advancers: adv, decliners: dec, counted },
          adv >= GAP_CONFIG.breadthUp ? 1 : adv <= GAP_CONFIG.breadthDown ? -1 : 0);
      } else dataGaps.push(`breadth: only ${counted}/50 constituents quoted — scored 0`);
    } catch (e: any) { dataGaps.push('breadth: ' + (e?.message || e)); }
  }

  // --- Event flag: any listed event today or tomorrow (covers tonight's US
  // events and tomorrow-morning events before the 09:15 open).
  const tomorrow = addDaysIST(dateStr, 1);
  const events = db.prepare('SELECT * FROM gap_events WHERE dateIST IN (?, ?)').all(dateStr, tomorrow) as any[];
  const eventFlag = events.length > 0;

  // --- Straddle-implied overnight move (reuses the Gap Risk page's source)
  let impliedMovePts: number | null = null;
  let lowMagnitude = false;
  try {
    const chain: any = await getLiveOptionChain('NSE:NIFTY 50');
    const cSpot = chain?.spot || spot;
    if (chain && Array.isArray(chain.strikes) && chain.strikes.length && cSpot) {
      const atm = chain.strikes.reduce((b: number, s: number) => Math.abs(s - cSpot) < Math.abs(b - cSpot) ? s : b, chain.strikes[0]);
      const ce = chain.ceData?.[atm]; const pe = chain.peData?.[atm];
      if (ce?.ltp > 0 && pe?.ltp > 0) {
        impliedMovePts = +(ce.ltp + pe.ltp).toFixed(1);
        lowMagnitude = (impliedMovePts / cSpot) * 100 < GAP_CONFIG.lowMagnitudePct;
      }
    }
    if (impliedMovePts === null) dataGaps.push('impliedMove: ATM straddle unavailable');
  } catch (e: any) { dataGaps.push('impliedMove: ' + (e?.message || e)); }

  // --- Composite + decision
  const score = Object.keys(signals).reduce((acc, k) => acc + signals[k].score * (W[k] || 0), 0);
  let decision: 'GAP-UP BIAS' | 'GAP-DOWN BIAS' | 'NO-TRADE' = 'NO-TRADE';
  if (score >= GAP_CONFIG.decisionThreshold && !eventFlag && !cautionFlag) decision = 'GAP-UP BIAS';
  else if (score <= -GAP_CONFIG.decisionThreshold && !eventFlag && !cautionFlag) decision = 'GAP-DOWN BIAS';

  const snapshot: any = {
    ts: Date.now(), date: dateStr, signals, weights: W, score, decision,
    eventFlag, cautionFlag, lowMagnitude, dataGaps, impliedMovePts,
    events: events.map(e => ({ label: e.label, type: e.type, dateIST: e.dateIST })),
    staleData: staleData || undefined,
    spot,
  };

  // --- Part 5: strike advisor (fires only on a bias)
  if (decision !== 'NO-TRADE') {
    try { snapshot.recommendation = await buildRecommendation(decision, spot, db); }
    catch (e: any) { dataGaps.push('advisor: ' + (e?.message || e)); }
  }

  if (!opts.dryRun) {
    db.prepare('INSERT INTO gap_scorecard (date, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(dateStr, JSON.stringify(snapshot), Date.now());
    console.log(`[gap] ${dateStr}: score=${score} decision=${decision}${eventFlag ? ' [EVENT]' : ''}${cautionFlag ? ' [CAUTION]' : ''} gaps=${dataGaps.length}`);
  }
  return snapshot;
}

// ---------------------------------------------------------------- Part 5 stub
// Implemented in the strike-advisor stage; kept compiling until then.
async function buildRecommendation(_decision: string, _spot: number | null, _db: AnyDb): Promise<any | null> {
  return null;
}

// ---------------------------------------------------------------- Outcome
export async function runOutcome(db: AnyDb, opts: { dryRun?: boolean; date?: string } = {}): Promise<any> {
  const today = opts.date || istDateStr();
  const prevRow: any = db.prepare('SELECT date, json FROM gap_scorecard WHERE date < ? ORDER BY date DESC LIMIT 1').get(today);
  if (!prevRow) return { error: 'no prior snapshot to score' };
  const snap = JSON.parse(prevRow.json);
  if (snap.outcome && !opts.dryRun) return { alreadyRecorded: true, date: prevRow.date };

  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) return { error: 'no Kite session' };
  const q = await kc.getQuote(['NSE:NIFTY 50']);
  const n = q?.['NSE:NIFTY 50'];
  const open = n?.ohlc?.open, prevClose = n?.ohlc?.close;
  if (!(open > 0) || !(prevClose > 0)) return { error: 'open/prevClose unavailable' };

  const actualGapPct = +(((open - prevClose) / prevClose) * 100).toFixed(3);
  const th = GAP_CONFIG.gapClassThresholdPct;
  const cls = actualGapPct >= th ? 'gap-up' : actualGapPct <= -th ? 'gap-down' : 'flat';
  const hit = snap.decision === 'GAP-UP BIAS' ? cls === 'gap-up' : snap.decision === 'GAP-DOWN BIAS' ? cls === 'gap-down' : null;

  snap.outcome = { recordedAt: Date.now(), forOpenOf: today, open, prevClose, actualGapPct, class: cls, hit };
  if (!opts.dryRun) {
    db.prepare('UPDATE gap_scorecard SET json = ?, updated_at = ? WHERE date = ?').run(JSON.stringify(snap), Date.now(), prevRow.date);
    computeStats(db);
    console.log(`[gap] outcome for ${prevRow.date}: gap=${actualGapPct}% class=${cls} hit=${hit}`);
  }
  return { date: prevRow.date, outcome: snap.outcome };
}

// Record the recommended option's early price (~09:21) so recommendations are
// validated alongside the signal.
export async function runRecoPrice(db: AnyDb): Promise<any> {
  const today = istDateStr();
  const prevRow: any = db.prepare('SELECT date, json FROM gap_scorecard WHERE date < ? ORDER BY date DESC LIMIT 1').get(today);
  if (!prevRow) return { error: 'no snapshot' };
  const snap = JSON.parse(prevRow.json);
  const reco = snap.recommendation;
  if (!reco || !reco.tradingsymbol || (snap.outcome && snap.outcome.recoOpenPrice)) return { skipped: true };
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) return { error: 'no Kite session' };
  try {
    const lq = await kc.getLTP([`NFO:${reco.tradingsymbol}`]);
    const first: any = Object.values(lq || {})[0];
    if (first?.last_price > 0) {
      snap.outcome = snap.outcome || {};
      snap.outcome.recoOpenPrice = first.last_price;
      snap.outcome.recoPnlPerLot = +(((first.last_price - reco.premium) * (reco.lotSize || 0))).toFixed(0);
      db.prepare('UPDATE gap_scorecard SET json = ?, updated_at = ? WHERE date = ?').run(JSON.stringify(snap), Date.now(), prevRow.date);
      return { date: prevRow.date, recoOpenPrice: first.last_price };
    }
  } catch (e: any) { return { error: e?.message || String(e) }; }
  return { skipped: true };
}

// ---------------------------------------------------------------- Stats
export function computeStats(db: AnyDb) {
  const rows: any[] = db.prepare('SELECT date, json FROM gap_scorecard ORDER BY date DESC LIMIT 400').all();
  const snaps = rows.map(r => JSON.parse(r.json)).filter(s => s.outcome && typeof s.score === 'number');
  const today = istDateStr();
  const windowStats = (days: number) => {
    const cutoff = addDaysIST(today, -days);
    const inWin = snaps.filter(s => s.date >= cutoff);
    const fired = inWin.filter(s => s.decision !== 'NO-TRADE');
    const hits = fired.filter(s => s.outcome.hit === true).length;
    return { days, total: inWin.length, fired: fired.length, hits, hitRate: fired.length ? +(hits / fired.length * 100).toFixed(1) : null };
  };
  const byBucket = (min: number) => {
    const b = snaps.filter(s => Math.abs(s.score) >= min && s.decision !== 'NO-TRADE');
    const hits = b.filter(s => s.outcome.hit === true).length;
    return { minScore: min, fired: b.length, hits, hitRate: b.length ? +(hits / b.length * 100).toFixed(1) : null };
  };
  const summary = {
    updatedAt: Date.now(),
    rolling: { d30: windowStats(30), d90: windowStats(90) },
    buckets: [byBucket(3), byBucket(5), byBucket(7)],
  };
  db.prepare('INSERT INTO gap_stats (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
    .run('summary', JSON.stringify(summary), Date.now());
  return summary;
}

// ---------------------------------------------------------------- Register
export function registerGapScorecard(app: any, db: AnyDb) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gap_scorecard (date TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS gap_events (id INTEGER PRIMARY KEY AUTOINCREMENT, dateIST TEXT NOT NULL, label TEXT NOT NULL, type TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS gap_stats (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER);
  `);

  // Admin guard: enforced only when GAP_ADMIN_KEY is set (single-user app).
  const guard = (req: any, res: any, next: any) => {
    const key = process.env.GAP_ADMIN_KEY;
    if (!key) return next();
    if (req.headers['x-admin-key'] === key || req.query.adminKey === key) return next();
    return res.status(403).json({ error: 'admin key required' });
  };

  app.get('/api/gap/scorecard', (req: any, res: any) => {
    try {
      const date = (req.query.date as string) || null;
      const row: any = date
        ? db.prepare('SELECT json FROM gap_scorecard WHERE date = ?').get(date)
        : db.prepare('SELECT json FROM gap_scorecard ORDER BY date DESC LIMIT 1').get();
      res.json({ snapshot: row ? JSON.parse(row.json) : null });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/gap/history', (req: any, res: any) => {
    try {
      const limit = Math.min(200, parseInt(String(req.query.limit || '60'), 10) || 60);
      const rows: any[] = db.prepare('SELECT json FROM gap_scorecard ORDER BY date DESC LIMIT ?').all(limit);
      res.json({ history: rows.map(r => JSON.parse(r.json)) });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/gap/stats', (req: any, res: any) => {
    try {
      const s: any = db.prepare('SELECT json FROM gap_stats WHERE key = ?').get('summary');
      const b: any = db.prepare('SELECT json FROM gap_stats WHERE key = ?').get('backtest');
      res.json({ summary: s ? JSON.parse(s.json) : null, backtest: b ? JSON.parse(b.json) : null });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/gap/events', (_req: any, res: any) => {
    try { res.json({ events: db.prepare('SELECT * FROM gap_events ORDER BY dateIST ASC').all() }); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.post('/api/gap/events', (req: any, res: any) => {
    try {
      const { dateIST, label, type } = req.body || {};
      if (!dateIST || !label) return res.status(400).json({ error: 'dateIST and label required' });
      const info = db.prepare('INSERT INTO gap_events (dateIST, label, type) VALUES (?, ?, ?)').run(String(dateIST), String(label), String(type || ''));
      res.json({ ok: true, id: Number(info.lastInsertRowid) });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.delete('/api/gap/events/:id', (req: any, res: any) => {
    try { db.prepare('DELETE FROM gap_events WHERE id = ?').run(parseInt(req.params.id, 10)); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post('/api/gap/run-snapshot', express.json(), guard, async (req: any, res: any) => {
    try { res.json(await runSnapshot(db, { dryRun: !!(req.body && req.body.dryRun) || req.query.dryRun === '1' })); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.post('/api/gap/run-outcome', express.json(), guard, async (req: any, res: any) => {
    try { res.json(await runOutcome(db, { dryRun: !!(req.body && req.body.dryRun) || req.query.dryRun === '1', date: req.body?.date })); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Crons (IST). Weekday filter in the expression; holiday + market-closed
  // guards inside the jobs. A failed run never throws out of the handler.
  cron.schedule('15 15 * * 1-5', async () => {
    const d = istDateStr();
    if (isWeekendIST() || isNseHoliday(d)) return;
    try { await runSnapshot(db); } catch (e) { console.error('[gap] snapshot job failed', e); }
  }, { timezone: 'Asia/Kolkata' });

  cron.schedule('16 9 * * 1-5', async () => {
    const d = istDateStr();
    if (isWeekendIST() || isNseHoliday(d)) return;
    try { await runOutcome(db); } catch (e) { console.error('[gap] outcome job failed', e); }
  }, { timezone: 'Asia/Kolkata' });

  cron.schedule('21 9 * * 1-5', async () => {
    const d = istDateStr();
    if (isWeekendIST() || isNseHoliday(d)) return;
    try { await runRecoPrice(db); } catch (e) { console.error('[gap] reco-price job failed', e); }
  }, { timezone: 'Asia/Kolkata' });

  registerGapBacktest(app, db, guard);
  registerSweepReclaim(app, db, guard);

  console.log('[gap] scorecard registered: snapshot 15:15 IST, outcome 09:16 IST, reco price 09:21 IST');
}

