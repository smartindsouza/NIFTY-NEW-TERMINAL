// Test for /api/market-snapshot. No network, no Kite: a fake read-only client.
//   npx tsx server/market_snapshot.test.ts           (runs the checks)
//   npx tsx server/market_snapshot.test.ts --print   (also prints the sample JSON)
//
// Scenario: Wed 21 Oct 2026, 09:32 IST, the day after the Dussehra holiday
// (Tue 20 Oct), so "previous day" must be Mon 19 Oct.

import assert from 'node:assert/strict';
import os from 'node:os';
import http from 'node:http';

process.env.KITE_DATA_DIR = os.tmpdir();          // kite_service opens its sqlite file here, not in the repo
delete process.env.KITE_API_KEY;                  // the real client must be "not ready" for the HTTP check

const IST = 5.5 * 3600 * 1000;
const at = (day: string, hhmm: string) => { const [y, m, d] = day.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return Date.UTC(y, m - 1, d, h, mi) - IST; };
const NOW = at('2026-10-21', '09:32');
const SECRET_TOKEN = 'tok_SHOULD_NEVER_LEAK_123456';

function fakeKite() {
  const calls: string[] = [];
  const day = (d: string, o: number, h: number, l: number, c: number) => ({ date: new Date(at(d, '00:00')), open: o, high: h, low: l, close: c, volume: 0 });
  const kc: any = {
    access_token: SECRET_TOKEN,
    async getQuote(syms: string[]) {
      calls.push(`quote:${syms.length}`);
      const out: any = {};
      for (const s of syms) {
        if (s === 'NSE:NIFTY 50') out[s] = { instrument_token: 256265, last_price: 25108.4, ohlc: { close: 25062.1 } };
        else if (s === 'NSE:NIFTY BANK') out[s] = { instrument_token: 260105, last_price: 56420.75, ohlc: { close: 56310.2 } };
        else if (s === 'NSE:INDIA VIX') out[s] = { instrument_token: 264969, last_price: 11.42, ohlc: { close: 11.88 } };
        else if (s.startsWith('NSEIX:')) out[s] = { instrument_token: 900001, last_price: 25131.5, ohlc: { close: 25088 } };
        else if (s.startsWith('NFO:')) {
          const m = s.match(/(\d+)(CE|PE)$/)!; const k = +m[1].slice(-5);
          const dist = Math.abs(k - 25100) / 50;
          out[s] = { oi: Math.round((m[2] === 'CE' ? 9e6 : 1.1e7) / (1 + dist) + (m[2] === 'CE' && k > 25100 ? 2e6 : 0)) };
        }
      }
      return out;
    },
    async getHistoricalData(token: number, interval: string, from: string, to: string) {
      calls.push(`hist:${token}:${interval}`);
      if (interval === 'day') {
        // 19 Oct is the last session: 20 Oct (Dussehra) has no candle.
        const base = token === 260105 ? 56000 : 25000;
        return [day('2026-10-15', base - 40, base + 60, base - 90, base + 10), day('2026-10-16', base + 10, base + 95, base - 30, base + 70),
                day('2026-10-19', base + 70, base + 140, base - 5, base + 62)];
      }
      if (interval === '5minute') {
        const base = token === 260105 ? 56350 : 25070;
        const out: any[] = [];
        for (let i = 0; i < 4; i++) {                            // 09:15, 09:20, 09:25 done; 09:30 still forming at 09:32
          const t = at('2026-10-21', '09:15') + i * 300000; const o = base + i * 12;
          out.push({ date: new Date(t), open: o, high: o + 25, low: o - 8, close: o + 14, volume: 0 });
        }
        return out;
      }
      if (interval === 'minute') {                                // GIFT: 19 Oct 15:30 → 21 Oct 09:32, quiet overnight gap
        const out: any[] = [];
        for (let t = at('2026-10-19', '15:30'); t < NOW; t += 60000) {
          const h = new Date(t + IST).getUTCHours();
          if (h >= 2 && h < 6) continue;
          const x = 25080 + 40 * Math.sin((t - at('2026-10-19', '15:30')) / 3.6e6);
          out.push({ date: new Date(t), open: x, high: x + 3, low: x - 3, close: x + 1, volume: 0 });
        }
        return out;
      }
      return [];
    },
    // These must never be called — the endpoint is read-only.
    getOrders() { throw new Error('orders touched'); }, getPositions() { throw new Error('positions touched'); },
    getMargins() { throw new Error('funds touched'); }, placeOrder() { throw new Error('order placed'); },
  };
  return { kc, calls };
}

const nfo = (() => {
  const rows: any[] = [];
  for (const exp of ['2026-10-20', '2026-10-27', '2026-11-03']) {
    for (let k = 24500; k <= 25700; k += 50) for (const t of ['CE', 'PE']) {
      rows.push({ name: 'NIFTY', instrument_type: t, strike: k, expiry: new Date(`${exp}T00:00:00Z`), tradingsymbol: `NIFTY${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8)}${k}${t}` });
    }
  }
  return rows;
})();

async function main() {
  const { buildMarketSnapshot, snapshotKeyOk, registerMarketSnapshot } = await import('./market_snapshot');
  const { kc, calls } = fakeKite();
  const out = await buildMarketSnapshot({
    kc, nowMs: NOW, sleep: async () => {},
    getGift: async () => ({ token: 900001, symbol: 'GIFTNIFTY26OCTFUT' }),
    getNfo: async () => nfo,
  });

  assert.equal(out.status, 200);
  const b = out.body;
  assert.equal(b.as_of, '2026-10-21T09:32:00+05:30');
  assert.equal(b.session_valid, true);
  assert.equal(b.nifty.prev_day.date, '2026-10-19', 'previous day skips the Dussehra holiday');
  assert.deepEqual(b.nifty.today_5m.map((c: any) => c.t), ['2026-10-21T09:15:00+05:30', '2026-10-21T09:20:00+05:30', '2026-10-21T09:25:00+05:30'], 'only completed 5-min candles');
  assert.equal(b.banknifty.prev_day.date, '2026-10-19');
  assert.equal(b.india_vix.prev_close, 11.88);
  assert.equal(b.gift_nifty.overnight_window.from, '2026-10-19T15:30:00+05:30');
  assert.equal(b.gift_nifty.overnight_window.to, '2026-10-21T09:15:00+05:30');
  assert.equal(b.gift_nifty.price_at_0915_time, '2026-10-21T09:15:00+05:30');
  assert.ok(b.gift_nifty.overnight_high > b.gift_nifty.overnight_low);
  assert.equal(b.options.expiry, '2026-10-27', 'expired weekly (20 Oct) is skipped');
  assert.equal(b.options.atm_strike, 25100);
  assert.ok(b.options.pcr_total > 0);
  assert.deepEqual(b.errors, []);
  assert.ok(!JSON.stringify(b).includes(SECRET_TOKEN), 'access token never in the response');
  assert.ok(calls.every((c) => c.startsWith('quote:') || c.startsWith('hist:')), 'only quote/historical calls');

  // A failing section is reported, the rest still returned.
  const broken = fakeKite();
  broken.kc.getHistoricalData = async (token: number, interval: string, ...rest: any[]) => {
    if (interval === 'minute') throw new Error(`NSEIX not enabled (token=${SECRET_TOKEN})`);
    return fakeKite().kc.getHistoricalData(token, interval, ...rest);
  };
  const part = await buildMarketSnapshot({ kc: broken.kc, nowMs: NOW, sleep: async () => {}, getGift: async () => ({ token: 900001, symbol: 'GIFTNIFTY26OCTFUT' }), getNfo: async () => { throw new Error('instruments down'); } });
  assert.equal(part.status, 200);
  assert.equal(part.body.nifty.today_5m.length, 3);
  assert.equal(part.body.options, null);
  assert.ok(part.body.errors.some((e: string) => e.startsWith('gift_nifty.overnight:')));
  assert.ok(part.body.errors.some((e: string) => e.startsWith('options:')));
  assert.ok(!JSON.stringify(part.body).includes(SECRET_TOKEN), 'secret redacted from error text');

  // Session not ready / rejected → 503, never a crash.
  assert.equal((await buildMarketSnapshot({ kc: { access_token: null }, nowMs: NOW, getGift: async () => null, getNfo: async () => [] })).status, 503);
  const rejected = { access_token: SECRET_TOKEN, getQuote: async () => { const e: any = new Error('Incorrect `api_key` or `access_token`.'); e.error_type = 'TokenException'; throw e; } };
  const r503 = await buildMarketSnapshot({ kc: rejected, nowMs: NOW, getGift: async () => null, getNfo: async () => [] });
  assert.equal(r503.status, 503); assert.equal(r503.body.session_valid, false);

  // Key check.
  assert.equal(snapshotKeyOk('abc', undefined), false, 'no env var → always 401');
  assert.equal(snapshotKeyOk('abc', 'abc'), true);
  assert.equal(snapshotKeyOk('abd', 'abc'), false);
  assert.equal(snapshotKeyOk(undefined, 'abc'), false);

  // The real route over HTTP: 401 without/with a wrong key, 503 when Kite is not set up.
  process.env.SNAPSHOT_API_KEY = 'test-key-123';
  const express = (await import('express')).default;
  const app = express(); registerMarketSnapshot(app);
  const srv = http.createServer(app); await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;
  const get = async (q: string) => { const r = await fetch(`http://127.0.0.1:${port}/api/market-snapshot${q}`); return { s: r.status, j: await r.json() }; };
  assert.equal((await get('')).s, 401);
  assert.equal((await get('?key=wrong')).s, 401);
  const live = await get('?key=test-key-123');
  assert.equal(live.s, 503); assert.equal(live.j.session_valid, false);
  srv.close();

  console.log('market_snapshot: all checks passed');
  if (process.argv.includes('--print')) console.log(JSON.stringify(out.body, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
