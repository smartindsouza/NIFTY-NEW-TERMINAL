// Leverage meter — WHY the option premium moves more (or less) than the index.
//
// The question it answers, live, on the option chart: "index moved X — what
// should my premium have done, and what did it actually do?" Three numbers:
//
//   lambda  — gearing. |delta| x spot / premium = % premium move per 1% index
//             move. THE measure of "more" or "less" leverage at this moment.
//   greeks  — delta (pts per index pt), gamma (how fast delta grows, shown as
//             delta change per 50 index pts), theta (the daily bleed).
//   window  — the last ~30 minutes REALIZED: index moved dIndex, delta said the
//             premium should move `expected`, it actually moved dOpt. Premium
//             outrunning delta = IV rising right now; lagging = IV falling or
//             theta draining you even while the index cooperates.
//
// Display only. Reads prices, computes, answers. No order path, no storage.
// Proxy discipline: results are cached ~55s per contract and concurrent calls
// share one in-flight fetch, so an open option chart costs at most two 1-min
// history pulls per minute — the same class of load as the TA poll.

import { getKiteClient, getContractInfo, getBseIndexToken } from './kite_service';
import { getLatestTick } from './ticker_service';
import { toISTString } from './gap_scorecard';
import { ivAndDelta, bsGamma, bsThetaPerDay } from './options_math';

type Px = { t: number; close: number };

// ---------------------------------------------------------------- pure logic
/** Latest common minute and a reference ~lookback minutes earlier, aligned so
 *  both series are read at the SAME clock minutes. Null when overlap < 10 min. */
export function alignWindow(idx: Px[], opt: Px[], lookbackMin = 30) {
  if (!idx?.length || !opt?.length) return null;
  const byMin = new Map<number, number>();
  for (const b of idx) byMin.set(Math.floor(b.t / 60000), b.close);
  let iNow = -1;
  for (let i = opt.length - 1; i >= 0; i--) {
    if (byMin.has(Math.floor(opt[i].t / 60000))) { iNow = i; break; }
  }
  if (iNow < 0) return null;
  const tNow = opt[iNow].t;
  const target = tNow - lookbackMin * 60000;
  let iRef = -1;
  for (let i = iNow - 1; i >= 0; i--) {
    if (!byMin.has(Math.floor(opt[i].t / 60000))) continue;
    iRef = i;
    if (opt[i].t <= target) break;   // first aligned candle at/older than the target
  }
  if (iRef < 0) return null;
  const minutes = (tNow - opt[iRef].t) / 60000;
  if (minutes < 10) return null;
  return {
    minutes: Math.round(minutes),
    dIndex: +(byMin.get(Math.floor(tNow / 60000))! - byMin.get(Math.floor(opt[iRef].t / 60000))!).toFixed(2),
    dOpt: +(opt[iNow].close - opt[iRef].close).toFixed(2),
  };
}

const sgn = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;

/** Compare what delta predicted with what actually happened, in plain words. */
export function classifyWindow(minutes: number, dIndex: number, dOpt: number, delta: number, spot: number, premium: number) {
  const expected = +(delta * dIndex).toFixed(2);
  const excess = dOpt - expected;
  // ORDER MATTERS. Ask "does delta explain what happened?" FIRST, and only blame
  // IV or decay when it genuinely does not. The original code asked "did the index
  // move much?" first, so a small index move on a highly geared contract was
  // reported as IV/decay even when delta predicted the premium almost exactly
  // (Martin's screenshot: index +7.4, delta said +3.4, premium did +3.3 — labelled
  // "moving on IV/decay, not the index", which contradicted its own numbers).
  const band = Math.max(1.2, 0.25 * Math.abs(expected));
  const quietIdx = Math.abs(dIndex) < spot * 0.0004;             // ~10 pts on a 25k index
  const quietOpt = Math.abs(dOpt) < Math.max(0.6, premium * 0.01);
  let tone: 'up' | 'down' | 'flat', label: string;
  if (Math.abs(excess) <= band) {
    // Delta accounts for it. True whether the index moved 7 points or 70.
    tone = 'flat';
    label = (quietIdx && quietOpt) ? 'quiet — nothing moving' : 'delta explains the move';
  } else if (quietIdx) {
    // Delta does NOT explain it and the index barely moved — so something other
    // than direction is driving the premium.
    tone = dOpt > 0 ? 'up' : 'down';
    label = 'premium moving on IV/decay, not the index';
  } else if (excess > 0) {
    tone = 'up'; label = 'premium OUTRUNNING delta — IV rising';
  } else {
    tone = 'down'; label = 'premium LAGGING delta — IV falling / theta bleed';
  }
  return { expected, tone, label, text: `${minutes}m: index ${sgn(dIndex)} → option ${sgn(dOpt)} (Δ said ${sgn(expected)}) — ${label}` };
}

// ---------------------------------------------------------------- data + route
async function underlyingTokenFor(sym: string): Promise<number | null> {
  if (sym.startsWith('SENSEX')) {
    try { const t = await getBseIndexToken('SENSEX'); return t ? Number(t) : null; } catch (e) { return null; }
  }
  if (sym.startsWith('BANKNIFTY')) return 260105;
  if (sym.startsWith('FINNIFTY') || sym.startsWith('MIDCPNIFTY')) return null;   // honestly unsupported
  if (sym.startsWith('NIFTY')) return 256265;
  return null;
}

const cache = new Map<string, { at: number; p: Promise<any> }>();

async function buildMeter(sym: string): Promise<any> {
  const c = await getContractInfo(sym);
  if (!c) return { error: `contract ${sym} not found` };
  const strike = Number(c.strike), expiry = String(c.expiry || '');
  if (!(strike > 0) || !expiry) return { error: 'not an option contract' };
  const type: 'CE' | 'PE' = c.instrument_type === 'PE' ? 'PE' : 'CE';
  const uTok = await underlyingTokenFor(sym);
  if (!uTok) return { error: 'underlying not supported by the meter' };
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) return { error: 'no Kite session' };

  const now = Date.now(), from = now - 50 * 60000;
  const idxRaw = await kc.getHistoricalData(uTok, 'minute', toISTString(from), toISTString(now));
  await new Promise(r => setTimeout(r, 250));
  const optRaw = await kc.getHistoricalData(Number(c.instrument_token), 'minute', toISTString(from), toISTString(now));
  const px = (raw: any[]): Px[] => (raw || [])
    .map((b: any) => ({ t: new Date(b.date).getTime(), close: b.close }))
    .sort((a, b) => a.t - b.t);
  const idx = px(idxRaw), opt = px(optRaw);

  const spot = getLatestTick(uTok)?.ltp || (idx.length ? idx[idx.length - 1].close : 0);
  const premium = getLatestTick(Number(c.instrument_token))?.ltp || (opt.length ? opt[opt.length - 1].close : 0);
  if (!(spot > 0) || !(premium > 0)) return { error: 'no prices for this contract yet' };

  const expMs = new Date(expiry + 'T15:30:00+05:30').getTime();
  const daysLeft = Math.max(0.15, (expMs - now) / 86400000);
  const T = daysLeft / 365, r = 0.065;
  const { iv, delta } = ivAndDelta(type, spot, strike, T, r, premium);
  const gamma = iv ? bsGamma(spot, strike, T, r, iv) : null;
  const theta = iv ? bsThetaPerDay(type, spot, strike, T, r, iv) : null;
  const lambda = delta != null && premium > 0 ? +((Math.abs(delta) * spot) / premium).toFixed(1) : null;

  const win = alignWindow(idx, opt, 30);
  const window = win && delta != null
    ? { ...classifyWindow(win.minutes, win.dIndex, win.dOpt, delta, spot, premium), dIndex: win.dIndex, dOpt: win.dOpt, minutes: win.minutes }
    : { tone: 'flat', text: 'warming up — not enough overlapping candles yet' };

  const stale = opt.length ? now - opt[opt.length - 1].t > 12 * 60000 : true;
  return {
    sym, type, strike, expiry,
    spot: +spot.toFixed(2), premium: +premium.toFixed(2),
    iv: iv ? +(iv * 100).toFixed(1) : null,
    delta: delta != null ? +delta.toFixed(2) : null,
    gammaPer50: gamma != null ? +(gamma * 50).toFixed(2) : null,   // delta gained per 50 index pts
    thetaPerDay: theta != null ? +theta.toFixed(1) : null,
    lambda,                                                        // % premium per 1% index
    window,
    stale,                                                         // last candle > 12 min old (market likely closed)
    at: now,
  };
}

export function registerLeverage(app: any) {
  app.get('/api/leverage', async (req: any, res: any) => {
    try {
      const sym = String(req.query.sym || '').trim().toUpperCase();
      if (!sym) return res.status(400).json({ error: 'sym required' });
      const hit = cache.get(sym);
      if (hit && Date.now() - hit.at < 55000) return res.json(await hit.p);
      const p = buildMeter(sym);
      cache.set(sym, { at: Date.now(), p });
      const out = await p.catch((e: any) => ({ error: e?.message || String(e) }));
      if (out?.error) cache.delete(sym);        // errors are not worth caching
      res.json(out);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  console.log('[leverage] meter registered — reads, computes, answers; never trades');
}
