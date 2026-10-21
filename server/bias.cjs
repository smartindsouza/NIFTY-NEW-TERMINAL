/**
 * NIFTY bias — on-demand Claude note for the terminal (time-aware).
 *
 * Routes (mounted on your existing Express app):
 *   GET  /api/bias        latest note + today's history
 *   POST /api/bias        store a note (used by the 09:35 scheduled Claude task)
 *   POST /api/bias/run    build a fresh note now (the button)
 *
 * What a tap analyses depends on the time:
 *   opening   (until ~09:45)   gap vs GIFT, first candle, 15-min range, closed breaks
 *   morning / midday / afternoon / post_close
 *                              the day's market structure: 15-min & 5-min swings, trend
 *                              (HH/HL vs LH/LL), breaks of structure, last-hour momentum,
 *                              position vs day range / prev-day levels / CPR, Bank Nifty
 *                              relative strength, VIX, OI, GIFT Nifty and live US futures.
 *
 * All numbers are computed here in code; Claude only judges and writes the note.
 * Works from CommonJS (require) and ESM (import) projects. Node 18+ (global fetch).
 */
const express = require("express");
const fs = require("fs");
const path = require("path");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5-5";
const IST_OFFSET_MIN = 330;

// ---------- helpers ----------
const r = (x) => (x == null || Number.isNaN(x) || !Number.isFinite(x) ? null : Math.round(x));
const r2 = (x) => (x == null || Number.isNaN(x) || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const pct = (a, b) => (a == null || !b ? null : r2(((a - b) / b) * 100));
const toIst = (ms) => new Date(ms + IST_OFFSET_MIN * 60000).toISOString().replace("Z", "+05:30").replace(/\.\d{3}/, "");
const istNow = () => toIst(Date.now());
const istDate = () => istNow().slice(0, 10);
const hhmm = (t) => (t ? String(t).slice(11, 16) : null);
const minsOfDay = (t) => { const s = hhmm(t); return s ? +s.slice(0, 2) * 60 + +s.slice(3) : null; };

function completed(candles, asOf) {
  if (!Array.isArray(candles)) return [];
  const cutoff = asOf ? Date.parse(asOf) : Date.now();
  return candles.filter((c) => Date.parse(c.t) + 5 * 60000 <= cutoff + 1000);
}
function firstClose(candles, test) {
  const c = candles.find((k) => test(k.c));
  return c ? { time: hhmm(c.t), close: r(c.c) } : null;
}
function tradingDaysBetween(a, b) {
  let n = 0;
  const d = new Date(a + "T00:00:00Z"), end = new Date(b + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  while (d < end) { const wd = d.getUTCDay(); if (wd && wd !== 6) n++; d.setUTCDate(d.getUTCDate() + 1); }
  return n;
}

/** 5-min → 15-min bars aligned to 09:15. Last bar may be partial. */
function to15m(c5) {
  const out = [];
  for (const c of c5) {
    const m = minsOfDay(c.t);
    const bucket = Math.floor((m - 555) / 15); // 555 = 09:15
    const last = out[out.length - 1];
    if (last && last.bucket === bucket) {
      last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.n++;
    } else out.push({ bucket, t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, n: 1 });
  }
  return out.map((b) => ({ ...b, partial: b.n < 3 }));
}

/** Fractal swings: bar is a swing high if its high beats k bars each side. */
function swings(bars, k) {
  const out = [];
  for (let i = k; i < bars.length - k; i++) {
    const b = bars[i];
    let H = true, L = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      const after = j > i;
      if (after ? bars[j].h >= b.h : bars[j].h > b.h) H = false;
      if (after ? bars[j].l <= b.l : bars[j].l < b.l) L = false;
    }
    if (H) out.push({ type: "H", time: hhmm(b.t), price: r(b.h), i });
    if (L) out.push({ type: "L", time: hhmm(b.t), price: r(b.l), i });
  }
  return out;
}

/** Trend from the last two swing highs and lows (+ a fresh unconfirmed day extreme). */
function structure(bars, k, lastClose) {
  const sw = swings(bars, k);
  const highs = sw.filter((s) => s.type === "H");
  const lows = sw.filter((s) => s.type === "L");
  // a new day extreme made after the last confirmed swing counts as provisional
  const hiBar = bars.reduce((a, b, i) => (b.h > bars[a].h ? i : a), 0);
  const loBar = bars.reduce((a, b, i) => (b.l < bars[a].l ? i : a), 0);
  const lastH = highs[highs.length - 1], lastL = lows[lows.length - 1];
  const hSeq = [...highs], lSeq = [...lows];
  if (!lastH || (hiBar > lastH.i && bars[hiBar].h > lastH.price)) hSeq.push({ type: "H", time: hhmm(bars[hiBar].t), price: r(bars[hiBar].h), i: hiBar, provisional: true });
  if (!lastL || (loBar > lastL.i && bars[loBar].l < lastL.price)) lSeq.push({ type: "L", time: hhmm(bars[loBar].t), price: r(bars[loBar].l), i: loBar, provisional: true });
  const uniq = (a) => a.filter((s, i) => i === 0 || s.i !== a[i - 1].i);
  const H = uniq(hSeq), L = uniq(lSeq);

  let trend = "unclear";
  if (H.length >= 2 && L.length >= 2) {
    const hh = H.at(-1).price > H.at(-2).price, hl = L.at(-1).price > L.at(-2).price;
    trend = hh && hl ? "up (higher highs & higher lows)" : !hh && !hl ? "down (lower highs & lower lows)" : hh ? "mixed (higher high, lower low — expanding)" : "mixed (lower high, higher low — contracting)";
  }
  const lastSwingHigh = highs.at(-1) || null, lastSwingLow = lows.at(-1) || null;
  return {
    trend,
    swing_highs: H.slice(-4).map(({ time, price, provisional }) => ({ time, price, ...(provisional && { provisional }) })),
    swing_lows: L.slice(-4).map(({ time, price, provisional }) => ({ time, price, ...(provisional && { provisional }) })),
    last_confirmed_swing_high: lastSwingHigh && { time: lastSwingHigh.time, price: lastSwingHigh.price },
    last_confirmed_swing_low: lastSwingLow && { time: lastSwingLow.time, price: lastSwingLow.price },
    close_vs_last_swing_high: lastSwingHigh ? (lastClose > lastSwingHigh.price ? "above (bullish break)" : "below") : null,
    close_vs_last_swing_low: lastSwingLow ? (lastClose < lastSwingLow.price ? "below (bearish break)" : "above") : null,
  };
}

function phaseFor(lastCandleT, n) {
  const m = minsOfDay(lastCandleT) + 5; // end of last completed candle
  if (n <= 6 || m <= 585) return "opening"; // through 09:45
  if (m <= 660) return "morning";            // to 11:00
  if (m <= 810) return "midday";             // to 13:30
  if (m < 930) return "afternoon";           // to 15:30
  return "post_close";
}

/** Level crossings: open side, current side, first 5-min close across. */
function levelMap(levels, c5, ltp) {
  const openPx = c5[0].o;
  return Object.entries(levels)
    .filter(([, v]) => v != null)
    .map(([name, v]) => {
      const openSide = openPx >= v ? "above" : "below";
      const cross = firstClose(c5, (c) => (openSide === "above" ? c < v : c > v));
      return { name, level: r(v), at_open: openSide, now: ltp >= v ? "above" : "below", first_close_across: cross?.time || null, distance_pts: r(ltp - v) };
    })
    .sort((a, b) => Math.abs(a.distance_pts) - Math.abs(b.distance_pts));
}

// ---------- US futures + Dow cash (Yahoo Finance chart API, no key) ----------
const US_SYMBOLS = { dow_fut: "YM=F", sp_fut: "ES=F", nasdaq_fut: "NQ=F" };
let usCache = { at: 0, data: null };

async function yahoo(sym, interval, range, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`, {
      headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${sym} ${res.status}`);
    const j = await res.json();
    const d = j?.chart?.result?.[0];
    if (!d) throw new Error(`${sym} empty`);
    return d;
  } finally { clearTimeout(t); }
}

async function defaultGetUsMarkets({ niftyOpenIso }) {
  if (Date.now() - usCache.at < 120000 && usCache.data) return usCache.data;
  const openMs = niftyOpenIso ? Date.parse(niftyOpenIso) : null;
  const out = {};
  const futs = await Promise.allSettled(Object.entries(US_SYMBOLS).map(async ([k, s]) => {
    const d = await yahoo(s, "15m", "2d", 6000);
    const m = d.meta, ts = d.timestamp || [], q = d.indicators?.quote?.[0] || {};
    const bars = ts.map((t, i) => ({ t: t * 1000, h: q.high?.[i], l: q.low?.[i], c: q.close?.[i] })).filter((b) => b.c != null);
    const last = m.regularMarketPrice ?? bars.at(-1)?.c;
    const settle = m.chartPreviousClose ?? m.previousClose;
    const atOpen = openMs ? bars.filter((b) => b.t <= openMs).at(-1)?.c : null;
    const hourAgo = bars.filter((b) => b.t <= Date.now() - 3600000).at(-1)?.c;
    const sinceIndiaOpen = bars.filter((b) => openMs && b.t >= openMs);
    out[k] = {
      symbol: s, last: r2(last), prev_settle: r2(settle), change_pct: pct(last, settle),
      change_since_nifty_open_pct: pct(last, atOpen), change_last_hour_pct: pct(last, hourAgo),
      high_since_nifty_open: sinceIndiaOpen.length ? r2(Math.max(...sinceIndiaOpen.map((b) => b.h))) : null,
      low_since_nifty_open: sinceIndiaOpen.length ? r2(Math.min(...sinceIndiaOpen.map((b) => b.l))) : null,
      quote_time_ist: m.regularMarketTime ? toIst(m.regularMarketTime * 1000).slice(11, 16) : null,
    };
  }));
  const dow = await Promise.allSettled([yahoo("^DJI", "1d", "5d", 6000)]);
  if (dow[0].status === "fulfilled") {
    const d = dow[0].value, ts = d.timestamp || [], c = d.indicators?.quote?.[0]?.close || [];
    const closes = ts.map((t, i) => ({ date: toIst(t * 1000).slice(0, 10), c: c[i] })).filter((x) => x.c != null);
    const last = closes.at(-1), prev = closes.at(-2);
    if (last && prev) out.dow_cash_last_close = { session_date_ist: last.date, close: r2(last.c), change_pts: r2(last.c - prev.c), change_pct: pct(last.c, prev.c) };
  }
  const failed = futs.filter((f) => f.status === "rejected").map((f) => f.reason?.message);
  if (dow[0].status === "rejected") failed.push("Dow cash close: " + dow[0].reason?.message);
  if (failed.length) out.errors = failed;
  usCache = { at: Date.now(), data: out };
  return out;
}

// ---------- deterministic facts ----------
function computeFacts(snap, us) {
  const missing = [];
  const n = snap.nifty || {};
  const prev = n.prev_day || {};
  const c5 = completed(n.today_5m, snap.as_of);
  if (!c5.length) return { noSession: true };

  const first = c5[0];
  const orBars = c5.slice(0, 3);
  const orHigh = Math.max(...orBars.map((c) => c.h));
  const orLow = Math.min(...orBars.map((c) => c.l));
  const last = c5.at(-1);
  const ltp = n.ltp ?? last.c;
  const phase = phaseFor(last.t, c5.length);

  let cpr = null;
  if (prev.high != null && prev.low != null && prev.close != null) {
    const pivot = (prev.high + prev.low + prev.close) / 3, bc = (prev.high + prev.low) / 2, tc = 2 * pivot - bc;
    cpr = { pivot: r(pivot), tc: r(tc), bc: r(bc), top: r(Math.max(tc, bc)), bottom: r(Math.min(tc, bc)) };
  } else missing.push("previous-day OHLC");

  // GIFT
  const g = snap.gift_nifty || {};
  const giftAt915 = g.price_at_0915 ?? null;
  const gift = g.ltp != null ? {
    ltp: r2(g.ltp), prev_close: g.prev_close, change_pts: r(g.ltp - g.prev_close), change_pct: pct(g.ltp, g.prev_close),
    premium_now: r(g.ltp - ltp),
    premium_at_open: giftAt915 != null ? r(giftAt915 - first.o) : null,
    overnight_high: g.overnight_high, overnight_low: g.overnight_low,
    ...(Array.isArray(g.today_5m) && g.today_5m.length > 3 && { structure_15m: structure(to15m(completed(g.today_5m, snap.as_of)), 1, g.ltp) }),
  } : (missing.push("GIFT Nifty"), null);

  const gapActual = prev.close != null ? first.o - prev.close : null;
  const giftImplied = giftAt915 != null && prev.close != null ? giftAt915 - prev.close : null;

  // Opening facts (always computed; the headline focus only in the opening phase)
  const fBody = Math.abs(first.c - first.o), fRange = first.h - first.l || 1;
  const opening = {
    gap: { actual_open_pts: r(gapActual), gift_implied_pts: r(giftImplied) },
    first_candle: {
      o: r2(first.o), h: r2(first.h), l: r2(first.l), c: r2(first.c),
      colour: first.c > first.o ? "green" : first.c < first.o ? "red" : "doji",
      body_pct_of_range: Math.round((fBody / fRange) * 100),
      upper_wick_pts: r(first.h - Math.max(first.o, first.c)), lower_wick_pts: r(Math.min(first.o, first.c) - first.l),
    },
    opening_range: { high: r(orHigh), low: r(orLow), complete: c5.length >= 3 },
    breaks: {
      closed_above_first_candle_high: firstClose(c5.slice(1), (c) => c > first.h),
      closed_below_first_candle_low: firstClose(c5.slice(1), (c) => c < first.l),
      closed_above_or_high: c5.length > 3 ? firstClose(c5.slice(3), (c) => c > orHigh) : null,
      closed_below_or_low: c5.length > 3 ? firstClose(c5.slice(3), (c) => c < orLow) : null,
      last_close_vs_or: last.c > orHigh ? "above" : last.c < orLow ? "below" : "inside",
    },
  };

  // Day structure
  const dayHigh = Math.max(...c5.map((c) => c.h)), dayLow = Math.min(...c5.map((c) => c.l));
  const hiT = c5.find((c) => c.h === dayHigh).t, loT = c5.find((c) => c.l === dayLow).t;
  const ago = (k) => (c5.length > k ? c5.at(-1 - k).c : first.o);
  const lastN = (k) => c5.slice(-k);
  const lastHour = lastN(12);
  const b15 = to15m(c5);
  const day = {
    open: r(first.o), high: r(dayHigh), high_time: hhmm(hiT), low: r(dayLow), low_time: hhmm(loT),
    change_vs_prev_close_pts: r(ltp - prev.close), change_vs_prev_close_pct: pct(ltp, prev.close),
    change_from_open_pts: r(ltp - first.o),
    range_pts: r(dayHigh - dayLow),
    position_in_day_range_pct: Math.round(((ltp - dayLow) / (dayHigh - dayLow || 1)) * 100),
    off_high_pts: r(dayHigh - ltp), off_low_pts: r(ltp - dayLow),
  };
  const momentum = {
    last_hour: { change_pts: r(last.c - ago(12)), high: r(Math.max(...lastHour.map((c) => c.h))), low: r(Math.min(...lastHour.map((c) => c.l))), green: lastHour.filter((c) => c.c > c.o).length, red: lastHour.filter((c) => c.c < c.o).length },
    last_30m_change_pts: r(last.c - ago(6)),
    last_15m_change_pts: r(last.c - ago(3)),
    avg_5m_range_today: r(c5.reduce((s, c) => s + (c.h - c.l), 0) / c5.length),
    avg_5m_range_last_hour: r(lastHour.reduce((s, c) => s + (c.h - c.l), 0) / lastHour.length),
  };
  const struct = {
    tf_15m: structure(b15, 1, last.c),
    tf_5m: structure(c5, 2, last.c),
  };

  const levels = levelMap({
    prev_day_high: prev.high, prev_day_low: prev.low, prev_day_close: prev.close,
    cpr_top: cpr?.top, cpr_bottom: cpr?.bottom,
    opening_range_high: orHigh, opening_range_low: orLow,
    day_high: dayHigh, day_low: dayLow,
    round_above: Math.ceil(ltp / 100) * 100, round_below: Math.floor(ltp / 100) * 100,
  }, c5, ltp);

  // Bank Nifty
  let bank = null;
  const b = snap.banknifty || {};
  const bc5 = completed(b.today_5m, snap.as_of);
  if (bc5.length) {
    const bLtp = b.ltp ?? bc5.at(-1).c;
    const bH = Math.max(...bc5.map((c) => c.h)), bL = Math.min(...bc5.map((c) => c.l));
    bank = {
      ltp: r(bLtp), change_pct: pct(bLtp, b.prev_day?.close),
      relative_to_nifty_pct: r2((pct(bLtp, b.prev_day?.close) ?? 0) - (pct(ltp, prev.close) ?? 0)),
      day_high: r(bH), day_low: r(bL), position_in_day_range_pct: Math.round(((bLtp - bL) / (bH - bL || 1)) * 100),
      vs_prev_day: b.prev_day ? (bLtp > b.prev_day.high ? "above prev high" : bLtp < b.prev_day.low ? "below prev low" : "inside prev range") : null,
      structure_15m: bc5.length > 3 ? structure(to15m(bc5), 1, bc5.at(-1).c).trend : null,
      ...(phase === "opening" && {
        first_candle_high: r(bc5[0].h), first_candle_low: r(bc5[0].l),
        closed_below_first_candle_low: firstClose(bc5.slice(1), (c) => c < bc5[0].l),
        closed_above_first_candle_high: firstClose(bc5.slice(1), (c) => c > bc5[0].h),
      }),
    };
  } else missing.push("Bank Nifty");

  const v = snap.india_vix || {};
  const vix = v.ltp != null && v.prev_close != null ? { ltp: v.ltp, prev_close: v.prev_close, change_pct: pct(v.ltp, v.prev_close) } : (missing.push("India VIX"), null);

  const o = snap.options || {};
  const options = o.atm_strike != null
    ? { expiry: o.expiry, atm_strike: o.atm_strike, atm_ce_oi: o.atm_ce_oi, atm_pe_oi: o.atm_pe_oi, atm_pe_to_ce: o.atm_ce_oi ? r2(o.atm_pe_oi / o.atm_ce_oi) : null, pcr_total: o.pcr_total }
    : (missing.push("options OI"), null);

  if (!us || (!us.dow_fut && !us.sp_fut)) missing.push("US futures");
  if (us?.errors) missing.push(...us.errors.map((e) => "US: " + e));

  const today = (snap.as_of || istNow()).slice(0, 10);
  for (const e of snap.errors || []) missing.push(typeof e === "string" ? e : JSON.stringify(e));

  return {
    noSession: false,
    as_of: snap.as_of,
    phase,
    candles_completed: c5.length,
    ltp: r2(ltp),
    prev_day: { date: prev.date, high: r(prev.high), low: r(prev.low), close: r(prev.close) },
    cpr,
    opening,
    day,
    momentum,
    structure: struct,
    key_levels_nearest_first: levels,
    banknifty: bank,
    vix,
    options,
    gift,
    us: us || null,
    context: {
      expiry_day: o.expiry === today,
      first_session_after_break: prev.date ? tradingDaysBetween(prev.date, today) > 0 : null,
      minutes_to_close: Math.max(0, 930 - (minsOfDay(last.t) + 5)),
    },
    missing,
    candles_15m: b15.map((c) => [hhmm(c.t), r(c.o), r(c.h), r(c.l), r(c.c), ...(c.partial ? ["partial"] : [])]),
    last_5m: lastN(12).map((c) => [hhmm(c.t), r(c.o), r(c.h), r(c.l), r(c.c)]),
  };
}

// ---------- Claude ----------
const SYSTEM = `You write Martin's NIFTY 50 intraday bias note. Martin is an experienced NIFTY options trader.
You get pre-computed FACTS (exact numbers from his terminal plus live US futures). Use them; never invent data. If something is in "missing", say it was missing.
FACTS.phase tells you what kind of note to write.

== phase "opening" (until ~09:45): the first-15-minutes read ==
1. Gap vs GIFT: did the cash open honour the GIFT-implied gap? Positive cue + flat/weak open = sellers absorbing (bearish tell); weak cue + firm open = buyers absorbing (bullish). Roughly honoured = neutral.
2. First candle: open≈high and red (bearish), open≈low and green (bullish), doji/long wicks = indecision.
3. Opening range: a CLOSED 5-min break of the first candle's / range's high or low is the trigger; a wick alone isn't. A break that closed back inside is a failed break.
4. Location vs CPR and prev-day high/low/close.
5. Confirmation: Bank Nifty, VIX, ATM OI / PCR. 6. Context: expiry, post-holiday, big gap.
Summary lines: "Gap:", "First 15 min:", "Levels:", "Confirmation:", "US:".

== phases "morning", "midday", "afternoon", "post_close": read the market AS IT IS NOW ==
Do NOT build the note around the first 15 minutes; the opening range is just one reference level by now.
Judge, in this order:
1. Market structure: 15-min trend from swing highs/lows (HH/HL up, LH/LL down, mixed = range/transition); any break of structure (close beyond the last confirmed swing) or change of character (in a downtrend, a close above the last lower high; in an uptrend, a close below the last higher low). Use the 5-min structure for the most recent leg.
2. Momentum: last hour and last 30 min — trending, stalling, or bouncing off an extreme; are 5-min ranges expanding or contracting?
3. Location: where price sits in the day's range and against prev-day high/low/close, CPR, day high/low, round numbers; which key levels were broken or reclaimed and when (first_close_across), and whether price is stretched far from them.
4. Bank Nifty: same direction or diverging; relative strength.
5. VIX and options: VIX rising with a falling market = fear confirming; ATM PE/CE OI skew and PCR.
6. GIFT Nifty: its change vs prev close and premium to spot now vs at the open (premium shrinking/turning negative while spot falls = offshore selling leading).
7. US futures (Dow/S&P/Nasdaq) live change, change since the NIFTY open and in the last hour; plus the Dow's last cash close. A supportive or hostile US tape matters most into the afternoon and for overnight holds.
8. Context: time of day (midday is often choppy; last 90 minutes can trend or reverse; minutes_to_close), expiry day, post-holiday.
Summary lines: "Structure:", "Last hour:", "Levels:", "Bank Nifty / VIX / OI:", "GIFT & US:".

== Both ==
Bias: count the factors — 2–3 agreeing = moderate, 4+ = high, conflicting = neutral/low. Don't force a directional call. A strong trend that is stretched into a key level with momentum fading is a lower-confidence continuation, say so.
- headline: one line with the bias and confidence, e.g. "Bearish (moderate) — lower highs all day, prev-day low lost at 11:35, bounce stalling under 22,780."
- summary: at most 150 words, plain English, short lines with the labels above, then the closing line "Directional context only, not a trade signal — a lean, not a certainty." Round to whole points.
- trigger: the level whose 5-min close would confirm/continue the lean (for neutral, the more likely break side).
- invalidation: the level that would prove the lean wrong — normally the last opposing swing (opening phase: opposite end of the first candle or range).
- next_reference: the next key level in the lean's direction.
- factors: one entry per factor you judged, using the listed names.`;

const FACTOR_NAMES = [
  "Gap vs GIFT", "First candle", "Opening range", "Market structure", "Momentum", "Location vs levels",
  "Bank Nifty", "VIX & options", "GIFT Nifty", "US futures", "Context",
];
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    bias: { type: "string", enum: ["bullish", "bearish", "neutral"] },
    confidence: { type: "string", enum: ["low", "moderate", "high"] },
    headline: { type: "string" },
    summary: { type: "string" },
    trigger: { type: "number" },
    invalidation: { type: "number" },
    next_reference: { type: "number" },
    factors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", enum: FACTOR_NAMES },
          read: { type: "string", enum: ["bullish", "bearish", "neutral"] },
          note: { type: "string" },
        },
        required: ["name", "read", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["bias", "confidence", "headline", "summary", "trigger", "invalidation", "next_reference", "factors"],
  additionalProperties: false,
};

async function askClaude(facts, { apiKey, model, effort, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 6000,
        system: SYSTEM,
        output_config: { effort, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        messages: [{ role: "user", content: `Time now (IST): ${istNow()}\nFACTS:\n${JSON.stringify(facts)}` }],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${body?.error?.message || res.statusText}`);
    if (body.stop_reason === "refusal" || body.stop_reason === "max_tokens") throw new Error(`Claude stopped early (${body.stop_reason})`);
    const text = (body.content || []).find((b) => b.type === "text")?.text;
    if (!text) throw new Error("Claude returned no text");
    return { out: JSON.parse(text), usage: body.usage };
  } finally { clearTimeout(timer); }
}

function buildPayload({ status, facts, out, error, source, model }) {
  const f = facts || {};
  const s15 = f.structure?.tf_15m;
  const us = f.us || {};
  return {
    date: istDate(),
    generated_at: istNow(),
    status,
    source,
    phase: f.phase || null,
    model: model || null,
    bias: out?.bias ?? null,
    confidence: out?.confidence ?? null,
    headline: out?.headline ?? (status === "no_session" ? "No session data yet — holiday or pre-open" : error ? "Bias check failed" : null),
    summary: out?.summary ?? (error || null),
    levels: {
      trigger: r(out?.trigger), invalidation: r(out?.invalidation), next_reference: r(out?.next_reference),
      day_high: f.day?.high ?? null, day_low: f.day?.low ?? null,
      swing_high_15m: s15?.last_confirmed_swing_high?.price ?? null, swing_low_15m: s15?.last_confirmed_swing_low?.price ?? null,
      or_high: f.opening?.opening_range?.high ?? null, or_low: f.opening?.opening_range?.low ?? null,
      first_candle_high: r(f.opening?.first_candle?.h), first_candle_low: r(f.opening?.first_candle?.l),
      prev_high: f.prev_day?.high ?? null, prev_low: f.prev_day?.low ?? null, prev_close: f.prev_day?.close ?? null,
      cpr_pivot: f.cpr?.pivot ?? null, cpr_tc: f.cpr?.tc ?? null, cpr_bc: f.cpr?.bc ?? null,
    },
    gap: f.opening?.gap ?? { actual_open_pts: null, gift_implied_pts: null },
    factors: out?.factors ?? [],
    gift: f.gift ? { ltp: f.gift.ltp, change_pct: f.gift.change_pct, premium_now: f.gift.premium_now } : null,
    us30: us.dow_cash_last_close
      ? { close: us.dow_cash_last_close.close, change_pts: us.dow_cash_last_close.change_pts, change_pct: us.dow_cash_last_close.change_pct, driver: null }
      : { close: null, change_pts: null, change_pct: null, driver: null },
    us_futures: ["dow_fut", "sp_fut", "nasdaq_fut"].reduce((a, k) => (us[k] && (a[k] = { last: us[k].last, change_pct: us[k].change_pct }), a), {}),
    ltp: f.ltp ?? null,
    data_as_of: f.as_of ?? null,
    missing: f.missing ?? [],
    error: error || null,
  };
}

// ---------- router ----------
/**
 * @param {object} opts
 * @param {() => Promise<object>} [opts.getSnapshot]   same JSON as /api/market-snapshot (default: calls it over localhost)
 * @param {(ctx) => Promise<object>} [opts.getUsMarkets] override the US data source (default: Yahoo Finance chart API)
 * @param {string} [opts.apiKey]   terminal key (default env TERMINAL_API_KEY / API_KEY)
 * @param {(req, res, next) => void} [opts.auth]  your own auth middleware
 * @param {boolean} [opts.handlePost=true]  register POST /api/bias here. Set false when the app
 *        already stores the scheduled note itself (NIFTY terminal: server/bias.ts → sqlite).
 * @param {() => object|null} [opts.getScheduled]  today's scheduled note from the app's own store;
 *        GET /api/bias shows it when it is newer than the last on-demand note.
 */
function createBiasRouter(opts = {}) {
  const terminalKey = opts.apiKey || process.env.TERMINAL_API_KEY || process.env.API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.BIAS_MODEL || DEFAULT_MODEL;
  const effort = process.env.BIAS_EFFORT || "medium";
  const cooldownMs = Number(process.env.BIAS_COOLDOWN_S || 60) * 1000;
  const dailyCap = Number(process.env.BIAS_DAILY_CAP || 60);
  const timeoutMs = Number(process.env.BIAS_TIMEOUT_S || 60) * 1000;
  const storeFile = process.env.BIAS_STORE_FILE || path.join(process.cwd(), "data", "bias-latest.json");
  const usEnabled = process.env.BIAS_US !== "off";

  const getSnapshot = opts.getSnapshot || (async () => {
    const port = process.env.PORT || 3000;
    const res = await fetch(`http://127.0.0.1:${port}/api/market-snapshot?key=${encodeURIComponent(terminalKey || "")}`);
    if (!res.ok) throw new Error(`market-snapshot ${res.status}`);
    return res.json();
  });
  const getUsMarkets = opts.getUsMarkets || defaultGetUsMarkets;

  let state = { latest: null, history: [], runsToday: 0, runsDate: istDate() };
  try { const saved = JSON.parse(fs.readFileSync(storeFile, "utf8")); if (saved?.latest) state = { ...state, ...saved }; } catch (_) {}
  const persist = () => { try { fs.mkdirSync(path.dirname(storeFile), { recursive: true }); fs.writeFileSync(storeFile, JSON.stringify(state)); } catch (_) {} };
  const save = (p) => {
    if (state.runsDate !== p.date) state = { ...state, history: [], runsToday: 0, runsDate: p.date };
    state.latest = p;
    state.history = [p, ...state.history.filter((h) => h.date === p.date)].slice(0, 30);
    persist();
  };

  const auth = opts.auth || ((req, res, next) => {
    if (!terminalKey) return next();
    const k = req.get("X-API-Key") || req.query.key;
    if (k === terminalKey) return next();
    res.status(401).json({ error: "bad or missing API key" });
  });

  const router = express.Router();
  router.use("/api/bias", express.json({ limit: "200kb" }));

  // Today's scheduled (09:35) note from the app's own store, if it provides one.
  const scheduled = () => {
    if (!opts.getScheduled) return null;
    try {
      const s = opts.getScheduled();
      return s && s.date === istDate() ? { phase: "opening", ...s, source: s.source || "scheduled" } : null;
    } catch (_) { return null; }
  };

  router.get("/api/bias", auth, (req, res) => {
    const sched = scheduled();
    let latest = state.latest, history = state.history;
    if (sched) {
      const newer = !latest || latest.date !== sched.date || Date.parse(sched.generated_at) >= Date.parse(latest.generated_at);
      if (newer) latest = sched;
      if (!history.some((h) => h.source === "scheduled" && h.generated_at === sched.generated_at)) {
        history = [...history, sched].sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at));
      }
    }
    res.json({ latest, history: history.map(({ generated_at, source, phase, bias, confidence, headline }) => ({ generated_at, source, phase, bias, confidence, headline })) });
  });

  if (opts.handlePost !== false) router.post("/api/bias", auth, (req, res) => {
    const p = req.body;
    if (!p || typeof p !== "object" || !p.date || !p.status) return res.status(400).json({ error: "expected bias JSON with date and status" });
    save({ phase: "opening", ...p, source: p.source || "scheduled" });
    res.json({ ok: true });
  });

  let inflight = null, lastKey = null;

  router.post("/api/bias/run", auth, async (req, res) => {
    const force = req.query.force === "1" || req.body?.force === true;
    if (inflight) return res.json(await inflight);

    const L = state.latest;
    const age = L?.source === "on_demand" ? Date.now() - Date.parse(L.generated_at) : Infinity;
    if (!force && age < cooldownMs) return res.json({ ...L, cached: true, cache_reason: "cooldown" });
    if (state.runsDate !== istDate()) { state.runsDate = istDate(); state.runsToday = 0; }
    if (state.runsToday >= dailyCap) return res.status(429).json({ ...(L || {}), cached: true, error: `Daily cap of ${dailyCap} on-demand runs reached` });

    inflight = (async () => {
      let facts;
      try {
        const snap = await getSnapshot();
        if (snap.session_valid === false) return buildPayload({ status: "error", error: "Kite session not valid (session_valid=false)", source: "on_demand" });
        const c5 = completed(snap.nifty?.today_5m, snap.as_of);
        if (!c5.length) { const p = buildPayload({ status: "no_session", source: "on_demand" }); save(p); return p; }

        const key = `${c5.at(-1).t}|${Math.round((snap.nifty.ltp ?? 0) / 5)}`;
        if (!force && key === lastKey && L?.source === "on_demand") return { ...L, cached: true, cache_reason: "no new candle" };

        let us = null;
        if (usEnabled) {
          try { us = await getUsMarkets({ niftyOpenIso: c5[0].t }); } catch (e) { us = { errors: [e.message] }; }
        }
        facts = computeFacts(snap, us);
        if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set on the server");
        state.runsToday++;
        const { out, usage } = await askClaude(facts, { apiKey: anthropicKey, model, effort, timeoutMs });
        const p = { ...buildPayload({ status: "ok", facts, out, source: "on_demand", model }), usage };
        lastKey = key;
        save(p);
        return p;
      } catch (e) {
        const msg = e.name === "AbortError" ? `Claude took longer than ${timeoutMs / 1000}s` : e.message;
        return { ...buildPayload({ status: "error", facts, error: msg, source: "on_demand" }), previous: state.latest };
      }
    })();

    try { res.json(await inflight); } finally { inflight = null; }
  });

  return router;
}

module.exports = { createBiasRouter, computeFacts, defaultGetUsMarkets, OUTPUT_SCHEMA, SYSTEM };
