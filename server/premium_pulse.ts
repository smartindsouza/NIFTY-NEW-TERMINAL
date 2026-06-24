import { getKiteClient } from './kite_service';
import { impliedVol, bsDelta } from './options_math';

const R = 0.065;
const NIFTY_TOKEN = 256265;
const YEAR_MS = 365 * 24 * 3600 * 1000;

const istDate = (d: any) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const istHM = (d: any) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

// Regression-through-origin slope: how many ₹ of premium move per index point. Σ(ds·dp)/Σ(ds²).
function slope(ds: number[], dp: number[]): number | null {
  let sxy = 0, sxx = 0;
  for (let i = 0; i < ds.length; i++) { sxy += ds[i] * dp[i]; sxx += ds[i] * ds[i]; }
  return sxx > 1e-6 ? sxy / sxx : null;
}

/**
 * Premium Pulse: how responsive the ATM option premium is to index moves *right now*,
 * measured from live 5-min candles, vs theoretical delta — with the intraday IV trend that explains it.
 */
export async function getPremiumPulse(chain: any, opts?: { side?: 'CE' | 'PE'; window?: number }) {
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) return { success: false, error: 'Not logged in to Kite.' };
  if (!chain || !chain.spot || !Array.isArray(chain.strikes) || !chain.strikes.length) {
    return { success: false, error: 'Option chain not loaded yet (needs Kite login + market hours).' };
  }
  const spot: number = chain.spot;
  const strikes: number[] = [...chain.strikes].sort((a, b) => a - b);
  const atm = strikes.reduce((b, s) => (Math.abs(s - spot) < Math.abs(b - spot) ? s : b), strikes[0]);
  const side: 'CE' | 'PE' = opts?.side === 'PE' ? 'PE' : 'CE';
  const win = Math.min(Math.max(Math.round(opts?.window ?? 10), 4), 30);
  const od = side === 'CE' ? chain.ceData?.[atm] : chain.peData?.[atm];
  const token = od?.instrument_token;
  if (!token) return { success: false, error: `No ATM ${side} contract in the chain yet.` };

  // expiry → time to expiry (years)
  let expMs = Date.now() + YEAR_MS * (0.5 / (365 * 24));
  if (chain.expiryDate) {
    const exp = new Date(chain.expiryDate);
    expMs = Date.UTC(exp.getUTCFullYear(), exp.getUTCMonth(), exp.getUTCDate(), 10, 0, 0);
  }
  const Tnow = Math.max((expMs - Date.now()) / YEAR_MS, 0.5 / (365 * 24));

  const from = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  let idx: any[] = [], opt: any[] = [];
  try {
    idx = (await kc.getHistoricalData(NIFTY_TOKEN, '5minute', from, to)) || [];
    opt = (await kc.getHistoricalData(token, '5minute', from, to)) || [];
  } catch (e: any) { return { success: false, error: e?.message || 'History fetch failed' }; }

  const today = istDate(Date.now());
  const optMap = new Map<number, number>();
  for (const c of opt) optMap.set(new Date(c.date).getTime(), c.close);

  // Aligned today series: index close + matching option close
  const rows: { t: number; hm: string; idx: number; prem: number }[] = [];
  for (const c of idx) {
    if (istDate(c.date) !== today) continue;
    const ms = new Date(c.date).getTime();
    const prem = optMap.get(ms);
    if (prem == null || prem <= 0) continue;
    rows.push({ t: ms, hm: istHM(c.date), idx: c.close, prem });
  }
  if (rows.length < win + 1) {
    return { success: false, error: 'Not enough intraday candles yet (needs market hours; thin early in the session).' };
  }

  // Per-candle deltas + IV, plus rolling realized sensitivity series
  const dS: number[] = [], dP: number[] = [];
  const series: { hm: string; realized: number | null; iv: number | null; prem: number }[] = [];
  const ivList: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    dS.push(rows[i].idx - rows[i - 1].idx);
    dP.push(rows[i].prem - rows[i - 1].prem);
    const Ti = Math.max((expMs - rows[i].t) / YEAR_MS, 0.5 / (365 * 24));
    const intr = side === 'CE' ? Math.max(0, rows[i].idx - atm) : Math.max(0, atm - rows[i].idx);
    let iv: number | null = null;
    if (rows[i].prem > intr + 0.05) iv = impliedVol(side, rows[i].idx, atm, Ti, R, rows[i].prem);
    if (iv != null) ivList.push(iv);
    // rolling realized slope over last `win` pairs ending at this candle
    const a = Math.max(0, dS.length - win);
    const realized = slope(dS.slice(a), dP.slice(a));
    series.push({ hm: rows[i].hm, realized: realized != null ? +realized.toFixed(3) : null, iv: iv != null ? +(iv * 100).toFixed(1) : null, prem: +rows[i].prem.toFixed(2) });
  }

  const realizedNow = slope(dS.slice(-win), dP.slice(-win));
  const ivNow = ivList.length ? ivList[ivList.length - 1] : null;
  const ivOpen = ivList.length ? ivList[0] : null;
  const ivTrend = ivNow != null && ivOpen != null ? +((ivNow - ivOpen) * 100).toFixed(1) : null; // IV points over the session

  // theoretical delta at current spot/IV
  const ivForDelta = ivNow ?? (chain.vix ? chain.vix / 100 : 0.12);
  const theoDelta = bsDelta(side, spot, atm, Tnow, R, ivForDelta);
  const capture = theoDelta !== 0 && realizedNow != null ? +(Math.abs(realizedNow) / Math.abs(theoDelta) * 100).toFixed(0) : null;

  // day-level effective sensitivity
  const idxNet = +(rows[rows.length - 1].idx - rows[0].idx).toFixed(1);
  const premNet = +(rows[rows.length - 1].prem - rows[0].prem).toFixed(2);
  const dayEff = Math.abs(idxNet) >= 5 ? +(premNet / idxNet).toFixed(3) : null;

  // verdict
  let level: 'RESPONSIVE' | 'MODERATE' | 'SLUGGISH' = 'MODERATE';
  if (capture != null) {
    if (capture >= 85) level = 'RESPONSIVE';
    else if (capture < 55) level = 'SLUGGISH';
  }
  const ivWord = ivTrend == null ? '' : ivTrend <= -0.4 ? ` IV is bleeding (${ivTrend} pts today) — a vega headwind.` : ivTrend >= 0.4 ? ` IV is rising (+${ivTrend} pts today) — a vega tailwind amplifying moves.` : ' IV is roughly flat today.';
  let verdict = '';
  if (level === 'RESPONSIVE') verdict = `${side} premiums are tracking the index well — about \u20b9${Math.abs(realizedNow ?? 0).toFixed(2)} per point vs \u20b9${Math.abs(theoDelta).toFixed(2)} theoretical (${capture}% capture).${ivWord}`;
  else if (level === 'SLUGGISH') verdict = `Sluggish: ${side} premiums are moving only ~\u20b9${Math.abs(realizedNow ?? 0).toFixed(2)} per point vs \u20b9${Math.abs(theoDelta).toFixed(2)} theoretical (${capture}% capture).${ivWord} A favourable index move pays less than usual — directional buys are fighting decay.`;
  else verdict = `Moderate: ${side} premiums move ~\u20b9${Math.abs(realizedNow ?? 0).toFixed(2)} per point (${capture ?? '—'}% of theoretical \u20b9${Math.abs(theoDelta).toFixed(2)}).${ivWord}`;

  return {
    success: true, asOf: Date.now(),
    side, atmStrike: atm, spot: +spot.toFixed(2), premium: od?.ltp != null ? +od.ltp.toFixed(2) : null,
    realizedDelta: realizedNow != null ? +realizedNow.toFixed(3) : null,
    theoDelta: +theoDelta.toFixed(3),
    capture, window: win,
    ivNow: ivNow != null ? +(ivNow * 100).toFixed(1) : null,
    ivOpen: ivOpen != null ? +(ivOpen * 100).toFixed(1) : null,
    ivTrend,
    dayEff, idxNet, premNet,
    level, verdict,
    series: series.slice(-60),
  };
}
