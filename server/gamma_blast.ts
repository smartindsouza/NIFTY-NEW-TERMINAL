import { getKiteClient } from './kite_service';
import { bsPrice, bsGamma, impliedVol } from './options_math';

const R = 0.065;
const NIFTY_TOKEN = 256265;

// Current IST wall-clock parts
function istNow() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value || '';
  return { weekday: g('weekday'), date: `${g('year')}-${g('month')}-${g('day')}`, hh: parseInt(g('hour')) || 0, mm: parseInt(g('minute')) || 0 };
}

/**
 * Gamma-blast monitor. Flags the expiry-day setup where tiny time-to-expiry makes ATM gamma
 * explosive, so a small directional index move can multiply a near-dead ATM option.
 * Combines: (1) is it expiry day, (2) is gamma "loaded" (convexity high), (3) is a directional catalyst present.
 */
export async function getGammaBlast(chain: any, opts?: { movePct?: number }) {
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) return { success: false, error: 'Not logged in to Kite.' };
  if (!chain || !chain.spot || !Array.isArray(chain.strikes) || !chain.strikes.length) {
    return { success: false, error: 'Option chain not loaded yet (needs Kite login + market hours).' };
  }

  const spot: number = chain.spot;
  const strikes: number[] = [...chain.strikes].sort((a, b) => a - b);
  const atm = strikes.reduce((b, s) => (Math.abs(s - spot) < Math.abs(b - spot) ? s : b), strikes[0]);
  const ceLtp: number | null = chain.ceData?.[atm]?.ltp ?? null;
  const peLtp: number | null = chain.peData?.[atm]?.ltp ?? null;

  // Time to expiry in years (NIFTY options settle 15:30 IST = 10:00 UTC)
  const now = istNow();
  let expiryDateStr: string | null = null;
  let T = 0.5 / (365 * 24);
  let isExpiryDay = false;
  if (chain.expiryDate) {
    const exp = new Date(chain.expiryDate);
    expiryDateStr = exp.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const expMs = Date.UTC(exp.getUTCFullYear(), exp.getUTCMonth(), exp.getUTCDate(), 10, 0, 0);
    T = Math.max((expMs - Date.now()) / (365 * 24 * 3600 * 1000), 0.5 / (365 * 24));
    isExpiryDay = expiryDateStr === now.date;
  }
  const minutesToClose = 15 * 60 + 30 - (now.hh * 60 + now.mm);

  // India VIX (optional fallback for IV)
  let vix: number | null = null;
  try {
    const q = await kc.getQuote(['NSE:INDIA VIX']);
    const v = q?.['NSE:INDIA VIX']?.last_price;
    if (typeof v === 'number' && v > 0) vix = +v.toFixed(2);
  } catch { /* optional */ }

  // Implied vol from the ATM premium that still has time value; fallback to VIX, then a floor
  const ceIntr = Math.max(0, spot - atm), peIntr = Math.max(0, atm - spot);
  let iv: number | null = null;
  if (ceLtp && ceLtp > ceIntr + 0.05) iv = impliedVol('CE', spot, atm, T, R, ceLtp);
  if (iv == null && peLtp && peLtp > peIntr + 0.05) iv = impliedVol('PE', spot, atm, T, R, peLtp);
  if (iv == null && vix != null) iv = vix / 100;
  const ivUsed = iv ?? 0.12;

  const gamma = bsGamma(spot, atm, T, R, ivUsed);

  // BLAST POTENTIAL: reprice the ATM CE (up move) and PE (down move) for a standard move.
  // On expiry afternoon this is dominated by intrinsic value catching up — we floor at intrinsic.
  const movePct = Math.min(Math.max(opts?.movePct ?? 0.3, 0.1), 1.0);
  const movePts = Math.max(5, Math.round((spot * movePct) / 100));
  const ceAfter = Math.max(bsPrice('CE', spot + movePts, atm, T, R, ivUsed), Math.max(0, spot + movePts - atm));
  const peAfter = Math.max(bsPrice('PE', spot - movePts, atm, T, R, ivUsed), Math.max(0, atm - (spot - movePts)));
  const ceGainPct = ceLtp && ceLtp > 0 ? ((ceAfter - ceLtp) / ceLtp) * 100 : null;
  const peGainPct = peLtp && peLtp > 0 ? ((peAfter - peLtp) / peLtp) * 100 : null;
  const blastPct = Math.max(ceGainPct ?? 0, peGainPct ?? 0);

  let gammaRegime: 'LOADED' | 'ELEVATED' | 'LOW' = 'LOW';
  if (blastPct >= 120) gammaRegime = 'LOADED';
  else if (blastPct >= 60) gammaRegime = 'ELEVATED';

  // CATALYST: directional break on recent 5-min index candles
  let catalyst: 'UP' | 'DOWN' | 'NONE' = 'NONE';
  let catalystStrength = 0, rangePts = 0;
  try {
    const from = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const candles = (await kc.getHistoricalData(NIFTY_TOKEN, '5minute', from, to)) || [];
    const today = candles.filter((c: any) => new Date(c.date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === now.date);
    const use = today.length >= 6 ? today : candles.slice(-14);
    if (use.length >= 6) {
      const last = use[use.length - 1];
      const prev = use.slice(Math.max(0, use.length - 13), use.length - 1);
      const hi = Math.max(...prev.map((c: any) => c.high));
      const lo = Math.min(...prev.map((c: any) => c.low));
      rangePts = +(hi - lo).toFixed(1);
      const mom = use.slice(-3).reduce((s: number, c: any) => s + (c.close - c.open), 0);
      if (last.close > hi && mom > 0) { catalyst = 'UP'; catalystStrength = +(last.close - hi).toFixed(1); }
      else if (last.close < lo && mom < 0) { catalyst = 'DOWN'; catalystStrength = +(lo - last.close).toFixed(1); }
    }
  } catch { /* candles optional */ }

  const inWindow = isExpiryDay && minutesToClose > 0 && minutesToClose <= 150;

  // ---- OI: max pain, walls, pinning ----
  const strikeStep = (() => {
    const diffs: number[] = [];
    for (let k = 1; k < strikes.length; k++) diffs.push(strikes[k] - strikes[k - 1]);
    diffs.sort((a, b) => a - b);
    return diffs.length ? diffs[Math.floor(diffs.length / 2)] : 50;
  })();
  const ceOi: Record<number, number> = {}, peOi: Record<number, number> = {};
  let totCeOi = 0, totPeOi = 0;
  for (const k of strikes) {
    const c = chain.ceData?.[k]?.oi ?? 0, p = chain.peData?.[k]?.oi ?? 0;
    ceOi[k] = c > 0 ? c : 0; peOi[k] = p > 0 ? p : 0;
    totCeOi += ceOi[k]; totPeOi += peOi[k];
  }
  const haveOi = totCeOi + totPeOi > 0;
  let maxPain: number | null = null, pinDistPts: number | null = null, pinned = false;
  let callWall: number | null = null, putWall: number | null = null;
  if (haveOi) {
    let best = Infinity;
    const pays: { k: number; pay: number }[] = [];
    for (const P of strikes) {
      let pay = 0;
      for (const k of strikes) {
        if (ceOi[k]) pay += ceOi[k] * Math.max(0, P - k);
        if (peOi[k]) pay += peOi[k] * Math.max(0, k - P);
      }
      pays.push({ k: P, pay });
      if (pay < best) best = pay;
    }
    // Among (near-)minimum-payout strikes, the meaningful max-pain is the one nearest spot
    const minimizers = pays.filter((x) => x.pay <= best * 1.0001 + 1e-6).map((x) => x.k);
    maxPain = minimizers.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), minimizers[0]);
    if (maxPain != null) {
      pinDistPts = +(spot - maxPain).toFixed(1);
      pinned = Math.abs(pinDistPts) <= Math.max(spot * 0.0015, strikeStep * 0.6);
    }
    let cw = -1, pw = -1;
    for (const k of strikes) {
      if (ceOi[k] > cw) { cw = ceOi[k]; callWall = k; }
      if (peOi[k] > pw) { pw = peOi[k]; putWall = k; }
    }
  }

  let verdict = '', level: 'SETUP' | 'WATCH' | 'OFF' = 'OFF';
  const breakingAway = maxPain != null && ((catalyst === 'UP' && spot >= maxPain) || (catalyst === 'DOWN' && spot <= maxPain));
  const pinNote = maxPain != null ? (pinned ? ` Index is pinned near max-pain ${maxPain}.` : ` Max-pain sits at ${maxPain} (${pinDistPts! > 0 ? '+' : ''}${pinDistPts} pts away).`) : '';
  if (!isExpiryDay) { verdict = 'Not an expiry day — gamma-blast setups need expiry-day time decay. Monitor goes live on the weekly expiry.'; level = 'OFF'; }
  else if (minutesToClose <= 0) { verdict = 'Market closed for the day.'; level = 'OFF'; }
  else if (gammaRegime !== 'LOADED') { verdict = `Expiry day, but gamma isn\u2019t loaded yet — ATM options still hold too much time value. The window sharpens in the last 1\u20132 hours as theta drains.${pinNote}`; level = 'WATCH'; }
  else if (catalyst === 'UP') { verdict = `Gamma LOADED + upside break \u2192 CE-side blast conditions. A ${movePts}-pt move \u2248 +${Math.round(ceGainPct ?? 0)}% on the ${atm} CE.${breakingAway ? ' Move is breaking AWAY from max-pain — supportive.' : maxPain != null ? ' But it\u2019s heading back toward max-pain, which can cap it.' : ''} Theta is brutal if it stalls.`; level = 'SETUP'; }
  else if (catalyst === 'DOWN') { verdict = `Gamma LOADED + downside break \u2192 PE-side blast conditions. A ${movePts}-pt move \u2248 +${Math.round(peGainPct ?? 0)}% on the ${atm} PE.${breakingAway ? ' Move is breaking AWAY from max-pain — supportive.' : maxPain != null ? ' But it\u2019s heading back toward max-pain, which can cap it.' : ''} Theta is brutal if it stalls.`; level = 'SETUP'; }
  else { verdict = `Gamma LOADED but no directional break — the theta-bleed trap. Premiums decay unless the index breaks its range.${pinned ? ` A break away from max-pain ${maxPain} is the trigger.` : pinNote}`; level = 'WATCH'; }

  return {
    success: true, asOf: Date.now(),
    expiry: { isExpiryDay, expiryDate: expiryDateStr, minutesToClose, inWindow },
    spot: +spot.toFixed(2), atmStrike: atm,
    ce: ceLtp != null ? +ceLtp.toFixed(2) : null, pe: peLtp != null ? +peLtp.toFixed(2) : null,
    iv: iv != null ? +(iv * 100).toFixed(1) : null, vix, gamma: +gamma.toFixed(5),
    blast: {
      movePts, movePct,
      ceAfter: +ceAfter.toFixed(2), peAfter: +peAfter.toFixed(2),
      ceGainPct: ceGainPct != null ? +ceGainPct.toFixed(0) : null,
      peGainPct: peGainPct != null ? +peGainPct.toFixed(0) : null,
      blastPct: +blastPct.toFixed(0),
    },
    pinning: {
      haveOi, maxPain, pinDistPts, pinned, callWall, putWall, breakingAway,
      ceOiLakh: +totCeOi.toFixed(1), peOiLakh: +totPeOi.toFixed(1),
      pcr: totCeOi > 0 ? +(totPeOi / totCeOi).toFixed(2) : null,
    },
    gammaRegime, catalyst, catalystStrength, rangePts, verdict, level,
  };
}
