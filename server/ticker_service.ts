import { KiteTicker } from 'kiteconnect';

export interface LiveTick {
  token: number; ltp: number; oi?: number; volume?: number; change?: number;
  ohlc?: { open: number; high: number; low: number; close: number }; ts: number;
}
type Broadcaster = (tick: LiveTick) => void;

let ticker: any = null;
let subscribedTokens = new Set<number>();
const latest = new Map<number, LiveTick>();
let broadcaster: Broadcaster | null = null;

export function getLatestTick(token: number): LiveTick | undefined { return latest.get(token); }
export function isTickerConnected(): boolean {
  return !!ticker && typeof ticker.connected === 'function' && ticker.connected();
}

export function startTicker(apiKey: string, accessToken: string, onTick: Broadcaster) {
  broadcaster = onTick;
  if (ticker) { try { ticker.disconnect(); } catch {} ticker = null; }
  latest.clear();
  ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });
  ticker.autoReconnect(true, 50, 5);
  ticker.on('connect', () => {
    const tokens = Array.from(subscribedTokens);
    if (tokens.length) { ticker.subscribe(tokens); ticker.setMode(ticker.modeFull, tokens); }
  });
  ticker.on('ticks', (ticks: any[]) => {
    for (const t of ticks) {
      const tick: LiveTick = { token: t.instrument_token, ltp: t.last_price, oi: t.oi,
        volume: t.volume_traded, change: t.change, ohlc: t.ohlc, ts: Date.now() };
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
