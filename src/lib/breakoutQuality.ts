// Breakout Authenticity ("fakeout filter").
//
// HONEST SCOPE: this is NOT true order-flow delta (Kite provides no aggressor-
// classified trade data). It reads a breakout candle's *structure* + volume —
// exactly what a tape reader uses without footprint — to judge whether a level
// break looks committed or like a trap. A separate live "pressure" proxy
// (uptick/downtick volume on the futures) can be passed in to add confirmation.

export interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume?: number;
}

export interface BreakoutLevel { name: string; price: number; }

export interface BreakoutResult {
  level: string;
  direction: 'up' | 'down';
  score: number;          // 0..100 authenticity
  verdict: 'STRONG' | 'MODERATE' | 'FAKEOUT_RISK';
  reasons: string[];
  brokeAt: number;        // candle time
  price: number;          // level price
}

const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

// ATR over the last `period` completed candles.
function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return avg(trs.slice(-period));
}

/**
 * Evaluate the most-recently-CLOSED candle for a breakout of any provided level.
 * Only the closed candle is judged (the caller must exclude the forming bar), so
 * a verdict never flickers on an in-progress candle.
 *
 * pressure (optional): signed live proxy in [-1, 1]; + = net buying, - = selling.
 */
export function evaluateBreakout(
  candles: Candle[],
  levels: BreakoutLevel[],
  opts?: { volLookback?: number; atrPeriod?: number; pressure?: number | null; minBreakAtrFrac?: number }
): BreakoutResult | null {
  const volLookback = opts?.volLookback ?? 20;
  const atrPeriod = opts?.atrPeriod ?? 14;
  const minBreakAtrFrac = opts?.minBreakAtrFrac ?? 0.05; // ignore trivial pokes
  if (!candles || candles.length < 5 || !levels || levels.length === 0) return null;

  const cur = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const a = atr(candles, atrPeriod) || (cur.high - cur.low) || 1;
  const range = Math.max(cur.high - cur.low, 1e-9);
  const body = Math.abs(cur.close - cur.open);

  // Find a level the current candle broke that the previous candle had NOT (fresh break).
  let best: BreakoutResult | null = null;

  for (const lv of levels) {
    if (!Number.isFinite(lv.price) || lv.price <= 0) continue;

    // Upside break: prev close at/below level, cur close above it by a real amount.
    const upBreak = prev.close <= lv.price && cur.close > lv.price && (cur.close - lv.price) >= a * minBreakAtrFrac;
    // Downside break: prev close at/above level, cur close below it.
    const downBreak = prev.close >= lv.price && cur.close < lv.price && (lv.price - cur.close) >= a * minBreakAtrFrac;
    if (!upBreak && !downBreak) continue;

    const direction: 'up' | 'down' = upBreak ? 'up' : 'down';
    const reasons: string[] = [];
    let score = 50; // neutral start

    // 1) CLOSE LOCATION within the candle range — the strongest tell.
    // Up-break wants a close near the high; down-break near the low.
    const closePos = (cur.close - cur.low) / range; // 0 = at low, 1 = at high
    const dirClosePos = direction === 'up' ? closePos : 1 - closePos;
    if (dirClosePos >= 0.7) { score += 18; reasons.push('closed near the extreme (conviction)'); }
    else if (dirClosePos <= 0.4) { score -= 22; reasons.push('closed back inside — rejection wick'); }

    // 2) REJECTION WICK poking past the level in the breakout direction.
    const wickBeyond = direction === 'up' ? (cur.high - cur.close) : (cur.close - cur.low);
    if (wickBeyond > body && wickBeyond > a * 0.3) { score -= 18; reasons.push('long wick beyond the level'); }

    // 3) BODY vs RANGE — decisive body = commitment.
    const bodyFrac = body / range;
    if (bodyFrac >= 0.6) { score += 12; reasons.push('strong body'); }
    else if (bodyFrac <= 0.3) { score -= 10; reasons.push('small body (indecision)'); }

    // 4) RANGE EXPANSION vs ATR.
    if (range >= a * 1.2) { score += 8; reasons.push('range expansion'); }
    else if (range <= a * 0.6) { score -= 6; reasons.push('tepid range'); }

    // 5) VOLUME expansion vs recent average (real volume from futures merge).
    const vols = candles.slice(-1 - volLookback, -1).map(c => c.volume || 0).filter(v => v > 0);
    const avgVol = avg(vols);
    const curVol = cur.volume || 0;
    if (avgVol > 0 && curVol > 0) {
      const rel = curVol / avgVol;
      if (rel >= 1.5) { score += 14; reasons.push(`volume ${rel.toFixed(1)}× avg`); }
      else if (rel <= 0.8) { score -= 12; reasons.push(`weak volume ${rel.toFixed(1)}× avg`); }
    }

    // 6) LIVE PRESSURE proxy agreement (optional; futures uptick/downtick).
    if (typeof opts?.pressure === 'number' && Number.isFinite(opts.pressure)) {
      const p = opts.pressure; // -1..1
      const agree = direction === 'up' ? p : -p;
      if (agree >= 0.25) { score += 10; reasons.push('order-flow pressure confirms'); }
      else if (agree <= -0.25) { score -= 14; reasons.push('order-flow pressure opposes (trap risk)'); }
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const verdict: BreakoutResult['verdict'] = score >= 68 ? 'STRONG' : score >= 45 ? 'MODERATE' : 'FAKEOUT_RISK';

    const res: BreakoutResult = { level: lv.name, direction, score, verdict, reasons, brokeAt: cur.time, price: lv.price };
    // Prefer the break with the most decisive (furthest-from-neutral) score.
    if (!best || Math.abs(score - 50) > Math.abs(best.score - 50)) best = res;
  }

  return best;
}
