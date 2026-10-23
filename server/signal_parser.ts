// Telegram trade calls → structured orders. PURE: no I/O, no clock, no Kite.
//
// The channel Martin follows ("Nifty Sensex VIP setups") posts a call in TWO
// messages, seconds apart:
//
//   🟢 BUY NIFTY 22650 CE                       ← the CALL
//   💰 Entry : ₹145 - ₹149
//   📊 Intraday Trade ⭐⭐
//
//   (reply to the call)                         ← the LEVELS
//   🎯 TP 1: ₹164
//   🎯 TP 2: ₹179
//   🎯 TP 3: ₹199
//   🛑 Stop Loss: ₹130
//   📝 Rationale: Retest
//   ⏳ Valid for: Intraday Only
//
// Martin's instruction is to IGNORE every other message, so this parser is
// deliberately strict: a message is either a call, a levels message, or
// nothing. Anything ambiguous returns null and is never traded. A single
// message that carries both halves is accepted too, in case the channel ever
// posts them together.
//
// Only BUY calls on NIFTY and SENSEX are recognised. "BANKNIFTY" / "FINNIFTY"
// must not be read as NIFTY, which is why NIFTY is anchored on a word boundary.

export type Underlying = 'NIFTY' | 'SENSEX';

export interface ParsedCall {
  underlying: Underlying;
  strike: number;
  optionType: 'CE' | 'PE';
  entryLow: number;
  entryHigh: number;
}
export interface ParsedLevels {
  tps: [number, number, number];
  sl: number;
}
export type ParsedMessage =
  | { kind: 'CALL'; call: ParsedCall; levels: ParsedLevels | null }
  | { kind: 'LEVELS'; levels: ParsedLevels }
  | null;

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`;
const toNum = (whole: string, frac?: string) => Number(whole.replace(/,/g, '') + (frac ? '.' + frac : ''));

/** Normalise what the channel's formatting does to text: unicode dashes, the
 *  rupee sign, non-breaking and zero-width spaces, fancy colons. Emojis are left
 *  alone — the patterns below never depend on them. */
export function normaliseText(raw: string): string {
  return String(raw || '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/[：﹕]/g, ':')
    .replace(/₹|Rs\.?|INR/gi, ' ')
    .replace(/[ \t]+/g, ' ');
}

function parseCall(t: string): ParsedCall | null {
  // BUY NIFTY 22650 CE  (also "BUY SENSEX 81500 PE"). SELL calls are not traded.
  const m = t.match(/\bBUY\s+(NIFTY|SENSEX)\b\s*(\d{4,6})\s*(CE|PE)\b/i);
  if (!m) return null;
  if (/\bSELL\b/i.test(t)) return null;                 // a message that says both is not a clean call
  const underlying = m[1].toUpperCase() as Underlying;
  const strike = Number(m[2]);
  const optionType = m[3].toUpperCase() as 'CE' | 'PE';
  // Entry : 145 - 149   |   Entry: 145-149   |   Entry 145 to 149   |   Entry: 147
  const range = t.match(new RegExp(String.raw`\bEntry\b[^\d\n]{0,6}` + NUM + String.raw`\s*(?:-|to|/)\s*` + NUM, 'i'));
  let entryLow: number, entryHigh: number;
  if (range) {
    entryLow = toNum(range[1], range[2]);
    entryHigh = toNum(range[3], range[4]);
  } else {
    const single = t.match(new RegExp(String.raw`\bEntry\b[^\d\n]{0,6}` + NUM, 'i'));
    if (!single) return null;
    entryLow = entryHigh = toNum(single[1], single[2]);
  }
  if (entryLow > entryHigh) [entryLow, entryHigh] = [entryHigh, entryLow];
  if (!(entryLow > 0)) return null;
  return { underlying, strike, optionType, entryLow, entryHigh };
}

function parseLevels(t: string): ParsedLevels | null {
  const tp = (n: number) => {
    const m = t.match(new RegExp(String.raw`\b(?:TP|Target|TGT)\s*-?\s*${n}\b[^\d\n]{0,6}` + NUM, 'i'));
    return m ? toNum(m[1], m[2]) : null;
  };
  const slm = t.match(new RegExp(String.raw`\b(?:Stop\s*-?\s*Loss|SL)\b[^\d\n]{0,6}` + NUM, 'i'));
  const t1 = tp(1), t2 = tp(2), t3 = tp(3);
  if (t1 == null || t2 == null || t3 == null || !slm) return null;
  return { tps: [t1, t2, t3], sl: toNum(slm[1], slm[2]) };
}

export function parseSignalMessage(raw: string): ParsedMessage {
  const t = normaliseText(raw);
  if (!t.trim()) return null;
  const call = parseCall(t);
  const levels = parseLevels(t);
  if (call) return { kind: 'CALL', call, levels };
  if (levels) return { kind: 'LEVELS', levels };
  return null;
}

/** The two halves must make sense together before a rupee is risked:
 *  SL below the entry range, and the three targets above it, rising. A call
 *  that fails this is skipped with the reason, never "fixed". */
export function validateSetup(call: ParsedCall, lv: ParsedLevels): string | null {
  const [t1, t2, t3] = lv.tps;
  if (!(lv.sl > 0)) return 'stop loss is missing or zero';
  if (!(lv.sl < call.entryLow)) return `stop loss ${lv.sl} is not below the entry ${call.entryLow}`;
  if (!(t1 > call.entryHigh)) return `TP1 ${t1} is not above the entry ${call.entryHigh}`;
  if (!(t2 > t1 && t3 > t2)) return `targets are not rising (${t1}, ${t2}, ${t3})`;
  // A range wider than a third of its own price is not a range, it's a typo.
  if (call.entryHigh - call.entryLow > call.entryLow / 3) return `entry range ${call.entryLow}-${call.entryHigh} is implausibly wide`;
  return null;
}
