// Dhan live feed shaped like Zerodha's KiteTicker (11 Nov 2026), so
// ticker_service.ts drives it unchanged: connect/disconnect/connected,
// subscribe/unsubscribe/setMode, autoReconnect, on('connect'|'ticks'|'error'|'close').
//
// Dhan: wss://api-feed.dhan.co?version=2&token=…&clientId=…&authType=2, JSON
// subscribe messages of ≤100 instruments, binary little-endian replies with an
// 8-byte header (code u8, length i16, segment u8, security id i32).
// Index tokens are subscribed in Quote mode (17) — LTP + day OHLC; derivatives in
// Full mode (21) for OI as well. Previous close arrives in its own packet (6) and
// is kept so ticks carry Zerodha's ohlc.close (= previous close) and % change.
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { dhanToken } from './dhan_service';
import { SEG, SEG_NAME, decodeToken, encodeToken } from './dhan_kite_adapter';

const SIZE: Record<number, number> = { 2: 16, 4: 50, 5: 12, 6: 16, 8: 162, 50: 10 };

export function parsePackets(buf: Buffer): any[] {
  const out: any[] = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const code = buf.readUInt8(o), seg = buf.readUInt8(o + 3), id = buf.readInt32LE(o + 4);
    const size = SIZE[code] || buf.length - o;
    const p = buf.subarray(o, o + size);
    const base = { code, seg, id };
    if (code === 2 && p.length >= 16) out.push({ ...base, ltp: p.readFloatLE(8), ltt: p.readInt32LE(12) });
    else if (code === 4 && p.length >= 50) out.push({ ...base, ltp: p.readFloatLE(8), ltt: p.readInt32LE(14), volume: p.readInt32LE(22),
      open: p.readFloatLE(34), high: p.readFloatLE(42), low: p.readFloatLE(46) });
    else if (code === 8 && p.length >= 62) out.push({ ...base, ltp: p.readFloatLE(8), ltt: p.readInt32LE(14), volume: p.readInt32LE(22), oi: p.readInt32LE(34),
      open: p.readFloatLE(46), high: p.readFloatLE(54), low: p.readFloatLE(58) });
    else if (code === 5 && p.length >= 12) out.push({ ...base, oi: p.readInt32LE(8) });
    else if (code === 6 && p.length >= 16) out.push({ ...base, prevClose: p.readFloatLE(8) });
    else if (code === 50 && p.length >= 10) out.push({ ...base, disconnectCode: p.readInt16LE(8) });
    o += size;
  }
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export class DhanTicker {
  modeFull = 'full'; modeQuote = 'quote'; modeLTP = 'ltp';
  private ws: WebSocket | null = null;
  private handlers: Record<string, ((...a: any[]) => void)[]> = {};
  private subs = new Set<number>();
  private reconnect = true; private retryMs = 3000; private stopped = false;
  private prev = new Map<number, number>(); private lastOi = new Map<number, number>();
  constructor(_opts?: any) { }
  autoReconnect(on: boolean) { this.reconnect = on; }
  on(ev: string, fn: (...a: any[]) => void) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  private emit(ev: string, ...a: any[]) { for (const f of this.handlers[ev] || []) { try { f(...a); } catch (e) { console.error('[DhanTicker] handler', e); } } }
  connected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  async connect() {
    this.stopped = false;
    let token: string;
    try { token = await dhanToken(); } catch (e: any) { this.emit('error', e); return this.retry(); }
    const url = `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(process.env.DHAN_CLIENT_ID || '')}&authType=2`;
    // Dhan's feed servers only accept the whitelisted IP: a direct connection from
    // Railway timed out (11 Nov 2026), so the socket goes through the same fixed-IP
    // proxy (HTTPS_PROXY, 64.227.131.47) as every other Dhan call.
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
    const ws = new WebSocket(url, proxy ? { agent: new HttpsProxyAgent(proxy) } : undefined); this.ws = ws;
    ws.on('open', () => { this.retryMs = 3000; this.send(15 + 2, [...this.subs]); this.emit('connect'); });
    ws.on('message', (data: Buffer) => this.onData(data));
    ws.on('error', (e) => this.emit('error', e));
    ws.on('close', () => { this.emit('close'); if (this.ws === ws) this.ws = null; if (!this.stopped) this.retry(); });
  }
  private retry() { if (!this.reconnect || this.stopped) return; setTimeout(() => { if (!this.stopped) this.connect(); }, this.retryMs); this.retryMs = Math.min(this.retryMs * 2, 60000); }
  disconnect() { this.stopped = true; try { this.ws?.send(JSON.stringify({ RequestCode: 12 })); } catch { } try { this.ws?.close(); } catch { } this.ws = null; }

  private send(_code: number, tokens: number[], unsub = false) {
    if (!this.connected() || !tokens.length) return;
    const list = tokens.map(t => ({ t, d: decodeToken(t) })).filter(x => x.d);
    // indices: Quote (17/18); derivatives & everything else: Full (21/22)
    const groups: Record<number, any[]> = {};
    for (const { d } of list) {
      const code = d!.seg === SEG.IDX_I ? (unsub ? 18 : 17) : (unsub ? 22 : 21);
      (groups[code] = groups[code] || []).push({ ExchangeSegment: SEG_NAME[d!.seg], SecurityId: String(d!.id) });
    }
    for (const [code, items] of Object.entries(groups))
      for (let i = 0; i < items.length; i += 100) {
        const part = items.slice(i, i + 100);
        this.ws!.send(JSON.stringify({ RequestCode: Number(code), InstrumentCount: part.length, InstrumentList: part }));
      }
  }
  subscribe(tokens: number[]) { tokens.forEach(t => this.subs.add(t)); this.send(17, tokens); }
  unsubscribe(tokens: number[]) { tokens.forEach(t => this.subs.delete(t)); this.send(18, tokens, true); }
  setMode(_mode: string, _tokens: number[]) { /* mode is chosen per segment in send() */ }

  private onData(data: Buffer) {
    const ticks: any[] = [];
    for (const p of parsePackets(Buffer.isBuffer(data) ? data : Buffer.from(data as any))) {
      const token = p.seg === SEG.IDX_I ? (decodeIndex(p.id) ?? encodeToken(p.seg, p.id)) : encodeToken(p.seg, p.id);
      if (p.code === 6) { this.prev.set(token, p.prevClose); continue; }
      if (p.code === 5) { this.lastOi.set(token, p.oi); continue; }
      if (p.code === 50) { console.warn('[DhanTicker] server disconnect code', p.disconnectCode); continue; }
      if (!(p.ltp > 0)) continue;
      if (p.oi != null) this.lastOi.set(token, p.oi);
      const prev = this.prev.get(token);
      ticks.push({ instrument_token: token, last_price: r2(p.ltp), oi: this.lastOi.get(token), volume_traded: p.volume,
        change: prev ? ((p.ltp - prev) / prev) * 100 : undefined,
        ohlc: p.open != null ? { open: r2(p.open), high: r2(p.high), low: r2(p.low), close: prev != null ? r2(prev) : undefined } : undefined,
        exchange_timestamp: p.ltt ? new Date(p.ltt * 1000) : undefined });
    }
    if (ticks.length) this.emit('ticks', ticks);
  }
}
const IDX_ALIAS: Record<number, number> = { 13: 256265, 25: 260105, 27: 257801, 21: 264969, 442: 288009, 51: 265, 69: 274441 };
const decodeIndex = (id: number) => IDX_ALIAS[id];
