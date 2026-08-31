// Market recorder — writes down what nobody is writing down.
//
// WHY THIS EXISTS. Five pre-registered strategies have now been tested on this
// account's own data and four have failed outright (the 1,728-rule search, ORB
// plus three variants, Confluence, Sweep & Reclaim); the fifth is still forward
// testing. Every one of them was built from 5-minute price candles. The two
// questions that remain genuinely open cannot be asked at all today:
//
//   1. Does POSITIONING lead price? (OI build-up, PCR, where the OI sits.)
//   2. Does buying options when VOLATILITY IS COMPRESSED pay?
//
// Neither can be backtested, because the history does not exist — Zerodha does
// not serve historical option chains or historical IV, and this app never wrote
// them down. So the blocker is not an idea; it is a dataset. This module starts
// the clock: from today, every few minutes, the state of the option chain is
// recorded. In roughly three months there is enough to ask question 1 honestly,
// and question 2 once the cost model grows a volatility term (it has none today,
// so a volatility strategy cannot yet be SCORED even with perfect data).
//
// DISCIPLINE. It records; it does not analyse, does not signal, and cannot place
// an order. It reuses getLiveOptionChain — the same call the option-chain screen
// already makes — so it adds no new class of broker load, runs on a 5-minute
// cadence inside market hours only, and skips weekends and NSE holidays. Rows
// are UNIQUE(symbol, ts) so a restart or an overlapping run cannot double-write.
//
// One honest limitation, recorded here so future-me does not trust a bad number:
// the option chain returns iv: 15.0 as a hardcoded placeholder for every strike.
// It is NOT real implied volatility. This module therefore computes IV itself
// from the premium via the existing bisection solver, and stores the chain's
// value nowhere.

import cron from 'node-cron';
import { getLiveOptionChain, getBseIndexToken } from './kite_service';
import { getLatestTick } from './ticker_service';
import { istDateStr } from './gap_scorecard';
import { isNseHoliday } from './calendar_service';
import { ivAndDelta } from './options_math';

const IST_MS = 5.5 * 3600 * 1000;
const INDIA_VIX_TOKEN = 264969;

const minOfDayIST = (t: number) => { const d = new Date(t + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

const TARGETS = [
  { symbol: 'NIFTY', spotSymbol: 'NSE:NIFTY 50', step: 50 },
  { symbol: 'BANKNIFTY', spotSymbol: 'NSE:NIFTY BANK', step: 100 },
];

/** Strikes within `span` steps of the money — the only part of the chain that trades. */
export function nearMoney(strikes: number[], spot: number, step: number, span = 5): number[] {
  if (!strikes?.length || !(spot > 0)) return [];
  const atm = strikes.reduce((best, s) => Math.abs(s - spot) < Math.abs(best - spot) ? s : best, strikes[0]);
  return strikes.filter(s => Math.abs(s - atm) <= span * step).sort((a, b) => a - b);
}

/** Aggregate one chain into the row we keep. Pure, so it is testable. */
export function summarise(chain: any, step: number, expiryDays: number) {
  const spot = Number(chain?.spot) || 0;
  const strikes: number[] = Array.isArray(chain?.strikes) ? chain.strikes.map(Number) : [];
  const band = nearMoney(strikes, spot, step);
  if (!band.length || !(spot > 0)) return null;

  const atm = band.reduce((b, s) => Math.abs(s - spot) < Math.abs(b - spot) ? s : b, band[0]);
  const T = Math.max(0.15, expiryDays) / 365, r = 0.065;

  let ceOi = 0, peOi = 0, ceChg = 0, peChg = 0, ceVol = 0, peVol = 0;
  let maxCeOi = 0, maxCeStrike: number | null = null, maxPeOi = 0, maxPeStrike: number | null = null;
  const rows: any[] = [];

  for (const k of band) {
    const ce = chain?.ceData?.[k], pe = chain?.peData?.[k];
    const ceIv = ce?.ltp > 0 ? ivAndDelta('CE', spot, k, T, r, ce.ltp).iv : null;
    const peIv = pe?.ltp > 0 ? ivAndDelta('PE', spot, k, T, r, pe.ltp).iv : null;
    if (ce) {
      ceOi += Number(ce.oi) || 0; ceVol += Number(ce.volume) || 0;
      if (ce.chgOi != null) ceChg += Number(ce.chgOi) || 0;
      if ((Number(ce.oi) || 0) > maxCeOi) { maxCeOi = Number(ce.oi) || 0; maxCeStrike = k; }
    }
    if (pe) {
      peOi += Number(pe.oi) || 0; peVol += Number(pe.volume) || 0;
      if (pe.chgOi != null) peChg += Number(pe.chgOi) || 0;
      if ((Number(pe.oi) || 0) > maxPeOi) { maxPeOi = Number(pe.oi) || 0; maxPeStrike = k; }
    }
    rows.push({
      k,
      ce: ce ? { ltp: ce.ltp, oi: ce.oi, chgOi: ce.chgOi, vol: ce.volume, iv: ceIv ? +(ceIv * 100).toFixed(2) : null } : null,
      pe: pe ? { ltp: pe.ltp, oi: pe.oi, chgOi: pe.chgOi, vol: pe.volume, iv: peIv ? +(peIv * 100).toFixed(2) : null } : null,
    });
  }

  const atmRow = rows.find(x => x.k === atm);
  const atmIv = atmRow && atmRow.ce?.iv != null && atmRow.pe?.iv != null
    ? +(((atmRow.ce.iv + atmRow.pe.iv) / 2).toFixed(2))
    : (atmRow?.ce?.iv ?? atmRow?.pe?.iv ?? null);

  return {
    spot: +spot.toFixed(2),
    atm,
    expiryDays,
    // Both sides must be present. A one-sided chain (quote failure on the puts,
    // say) would otherwise record PCR 0 — a plausible-looking number that never
    // occurs in reality, and exactly the kind of silent poison that ruins a
    // dataset months later when nobody remembers why.
    pcr: (ceOi > 0 && peOi > 0) ? +(peOi / ceOi).toFixed(3) : null,
    ceOi: +ceOi.toFixed(2), peOi: +peOi.toFixed(2),
    ceChgOi: +ceChg.toFixed(2), peChgOi: +peChg.toFixed(2),
    ceVol, peVol,
    maxCeStrike, maxPeStrike,          // the walls: where positioning actually sits
    atmIv,
    strikes: rows,
  };
}

const state = { lastRunAt: 0, lastError: null as string | null, writes: 0 };

export async function recordOnce(db: any): Promise<any> {
  const out: any[] = [];
  const now = Date.now();
  for (const t of TARGETS) {
    try {
      const chain = await getLiveOptionChain(t.spotSymbol);
      if (!chain || !chain.strikes?.length) { out.push({ symbol: t.symbol, skipped: 'no chain' }); continue; }
      const row = summarise(chain, t.step, Number(chain.expiryDays) || 1);
      if (!row) { out.push({ symbol: t.symbol, skipped: 'no near-money strikes' }); continue; }
      const vix = getLatestTick(INDIA_VIX_TOKEN)?.ltp ?? null;
      const res = db.prepare(`INSERT OR IGNORE INTO market_snapshots
        (symbol, date, ts, min_of_day, spot, atm, expiry_days, pcr, ce_oi, pe_oi, ce_chg_oi, pe_chg_oi,
         ce_vol, pe_vol, max_ce_strike, max_pe_strike, atm_iv, vix, strikes_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(t.symbol, istDateStr(), now, minOfDayIST(now), row.spot, row.atm, row.expiryDays, row.pcr,
             row.ceOi, row.peOi, row.ceChgOi, row.peChgOi, row.ceVol, row.peVol,
             row.maxCeStrike, row.maxPeStrike, row.atmIv, vix, JSON.stringify(row.strikes));
      if (res.changes) state.writes++;
      out.push({ symbol: t.symbol, written: !!res.changes, spot: row.spot, pcr: row.pcr, atmIv: row.atmIv, vix });
    } catch (e: any) {
      out.push({ symbol: t.symbol, error: e?.message || String(e) });
    }
    await new Promise(r => setTimeout(r, 800));   // never burst the proxy
  }
  state.lastRunAt = now;
  state.lastError = out.find(o => o.error)?.error || null;
  return { at: now, results: out };
}

export function registerRecorder(app: any, db: any, guard: any) {
  db.exec(`CREATE TABLE IF NOT EXISTS market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT, date TEXT, ts INTEGER, min_of_day INTEGER,
    spot REAL, atm REAL, expiry_days INTEGER, pcr REAL,
    ce_oi REAL, pe_oi REAL, ce_chg_oi REAL, pe_chg_oi REAL,
    ce_vol INTEGER, pe_vol INTEGER,
    max_ce_strike REAL, max_pe_strike REAL,
    atm_iv REAL, vix REAL, strikes_json TEXT,
    UNIQUE(symbol, ts)
  );`);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_sym_ts ON market_snapshots(symbol, ts)`); } catch (e) {}

  // Every 5 minutes, market hours only, weekdays, not on NSE holidays.
  cron.schedule('*/5 9-15 * * 1-5', async () => {
    const m = minOfDayIST(Date.now());
    if (m < 555 || m > 940) return;                 // 09:15 - 15:40 IST (CAS-era close)
    if (isNseHoliday(istDateStr())) return;
    try { await recordOnce(db); } catch (e: any) { console.error('[recorder] failed', e); state.lastError = e?.message || String(e); }
  }, { timezone: 'Asia/Kolkata' });

  app.get('/api/recorder/status', (_req: any, res: any) => {
    try {
      const total: any = db.prepare('SELECT COUNT(*) c FROM market_snapshots').get();
      const days: any = db.prepare('SELECT COUNT(DISTINCT date) c FROM market_snapshots').get();
      const first: any = db.prepare('SELECT date FROM market_snapshots ORDER BY ts ASC LIMIT 1').get();
      const last: any = db.prepare('SELECT * FROM market_snapshots ORDER BY ts DESC LIMIT 1').get();
      const perDay: any[] = db.prepare('SELECT date, COUNT(*) n FROM market_snapshots GROUP BY date ORDER BY date DESC LIMIT 10').all();
      const d = days?.c || 0;
      res.json({
        purpose: 'Records option-chain state so the positioning and volatility questions become testable. It records only — it never signals or trades.',
        snapshots: total?.c || 0,
        tradingDays: d,
        firstDay: first?.date || null,
        perDay,
        latest: last ? { symbol: last.symbol, date: last.date, minOfDay: last.min_of_day, spot: last.spot, pcr: last.pcr, atmIv: last.atm_iv, vix: last.vix } : null,
        lastError: state.lastError,
        readiness: d >= 60
          ? `${d} trading days recorded — enough to test whether positioning leads price.`
          : `${d}/60 trading days. Not enough yet; a test now would be noise, not evidence.`,
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Manual trigger, for verifying the thing actually writes without waiting.
  app.get('/api/recorder/run', guard, async (_req: any, res: any) => {
    try { res.json(await recordOnce(db)); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  console.log('[recorder] market recorder registered — records only, never trades');
}
