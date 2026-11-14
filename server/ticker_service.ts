import { KiteTicker } from 'kiteconnect';
import { DhanTicker } from './dhan_ticker';
// Broker move (11 Nov 2026): startTicker('dhan', …) drives Dhan's feed through the
// same KiteTicker-shaped interface; everything below is unchanged.
let tickerKind: 'kite' | 'dhan' | null = null;
export const currentTickerKind = () => tickerKind;

export interface LiveTick {
  token: number; ltp: number; oi?: number; volume?: number; change?: number;
  ohlc?: { open: number; high: number; low: number; close: number }; ts: number;
  exTs?: number | null;   // Zerodha's exchange_timestamp (ms, whole seconds) — for the price-age measurement
}
type Broadcaster = (tick: LiveTick) => void;

let ticker: any = null;
let subscribedTokens = new Set<number>();
const latest = new Map<number, LiveTick>();
let broadcaster: Broadcaster | null = null;
// RAW TAP (14 Nov 2026). LiveTick above keeps price, volume and OI only. The
// futures recorder (server/fut_recorder.ts) needs what a footprint is made of —
// the last trade's quantity and the best bid and ask at that moment — which
// arrive on Zerodha's full-mode tick and were being dropped here. Rather than
// widen LiveTick (kept for every instrument in `latest`, read by the exit engine)
// one optional listener sees the untouched tick first. It must never throw into
// this loop: the next line after it is the one that drives stops and exits.
let rawTap: ((t: any) => void) | null = null;
export function setRawTickTap(fn: ((t: any) => void) | null) { rawTap = fn; }

export function getLatestTick(token: number): LiveTick | undefined { return latest.get(token); }
export function isTickerConnected(): boolean {
  return !!ticker && typeof ticker.connected === 'function' && ticker.connected();
}

export function startTicker(apiKey: string, accessToken: string, onTick: Broadcaster) {
  broadcaster = onTick;
  // Turn auto-reconnect OFF before disconnecting. kiteconnect's KiteTicker, on the
  // close that follows disconnect(), calls attemptReconnection(), which — because
  // disconnect() set should_reconnect=false — runs process.exit(1). That silently
  // killed the server every time the live feed was restarted with a Zerodha
  // ticker running (found 11 Nov 2026 when switching the feed to Dhan: three
  // restarts, no error logged). With auto_reconnect off, the close is ignored.
  if (ticker) { try { ticker.autoReconnect?.(false); } catch {} try { ticker.disconnect(); } catch {} ticker = null; }
  latest.clear();
  ticker = apiKey === 'dhan' ? new DhanTicker() : new KiteTicker({ api_key: apiKey, access_token: accessToken });
  tickerKind = apiKey === 'dhan' ? 'dhan' : 'kite';
  ticker.autoReconnect(true, 50, 5);
  ticker.on('connect', () => {
    const tokens = Array.from(subscribedTokens);
    if (tokens.length) { ticker.subscribe(tokens); ticker.setMode(ticker.modeFull, tokens); }
  });
  ticker.on('ticks', (ticks: any[]) => {
    for (const t of ticks) {
      if (rawTap) { try { rawTap(t); } catch {} }
      const tick: LiveTick = { token: t.instrument_token, ltp: t.last_price, oi: t.oi,
        volume: t.volume_traded, change: t.change, ohlc: t.ohlc, ts: Date.now(),
        exTs: (() => { const v = t.exchange_timestamp || t.last_trade_time; const ms = v instanceof Date ? v.getTime() : v ? new Date(v).getTime() : NaN; return Number.isFinite(ms) ? ms : null; })() };
      latest.set(tick.token, tick);
      if (broadcaster) broadcaster(tick);
    }
  });
  ticker.on('error', (e: any) => console.error('[Ticker] error:', e?.message || e));
  ticker.on('close', () => console.log('[Ticker] closed'));
  ticker.connect();
}

export function setSubscriptions(tokens: number[]) {
  const next = new Set<number>(tokens.filter((t) => typeof t === 'number' && !Number.isNaN(t)));
  if (ticker && ticker.connected && ticker.connected()) {
    const toAdd = [...next].filter((t) => !subscribedTokens.has(t));
    const toRemove = [...subscribedTokens].filter((t) => !next.has(t));
    if (toAdd.length) { ticker.subscribe(toAdd); ticker.setMode(ticker.modeFull, toAdd); }
    if (toRemove.length) ticker.unsubscribe(toRemove);
  }
  subscribedTokens = next;
}
