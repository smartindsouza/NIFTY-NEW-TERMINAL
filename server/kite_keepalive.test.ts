// The shared open lines to Zerodha: a real KiteConnect client, a stand-in proxy that counts tunnels,
// and a stand-in "Zerodha" over TLS behind it.   npx tsx server/kite_keepalive.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { KiteConnect } from 'kiteconnect';
import { makeKeepAliveAgent, withKeepAlive, keepAliveStats, startKiteWarmer } from './kite_keepalive';

let n = 0; const ok = (name: string) => { n++; console.log('ok', name); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });

// "Zerodha": answers like the API, and remembers what it was sent and on which connection
const seen: { method: string; url: string; auth: string; body: string; conn: number }[] = []; let conns = 0;
const origin = https.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization || ''), body, conn: (req.socket as any).__id });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/user/margins') return res.end(JSON.stringify({ status: 'success', data: { equity: { net: 12345.5 } } }));
    if (req.url === '/user/profile') return res.end(JSON.stringify({ status: 'success', data: { user_id: 'AB1234' } }));
    if (req.url === '/orders/regular' && req.method === 'POST') return res.end(JSON.stringify({ status: 'success', data: { order_id: 'ORD' + seen.length } }));
    res.statusCode = 404; res.end(JSON.stringify({ status: 'error', message: 'no such route', error_type: 'GeneralException' }));
  });
});
origin.on('secureConnection', (s) => { (s as any).__id = ++conns; });
await new Promise<void>((r) => origin.listen(0, r)); const oport = (origin.address() as any).port;

// the proxy: counts CONNECT tunnels, checks the password, and can drop its tunnels
let tunnels = 0; const live = new Set<any>(); const proxyAuthSeen: string[] = [];
const proxy = http.createServer((_q, s) => { s.statusCode = 405; s.end(); });
proxy.on('connect', (req, client) => {
  tunnels++; proxyAuthSeen.push(String(req.headers['proxy-authorization'] || ''));
  const [h, p] = String(req.url).split(':');
  const up = net.connect(Number(p), h, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(client); client.pipe(up); });
  live.add(client); live.add(up);
  const end = () => { try { client.destroy(); } catch { } try { up.destroy(); } catch { } live.delete(client); live.delete(up); };
  up.on('error', end); client.on('error', end); up.on('close', end); client.on('close', end);
});
await new Promise<void>((r) => proxy.listen(0, r)); const pport = (proxy.address() as any).port;
const proxyUrl = `http://puser:ppass@127.0.0.1:${pport}`;
const mk = (agent?: https.Agent) => { const kc: any = new KiteConnect({ api_key: 'key', root: `https://localhost:${oport}` }); kc.setAccessToken('tok'); return agent ? withKeepAlive(kc, agent) : kc; };

// AS IT WAS: the library by itself, through the proxy named in the environment -> a new tunnel for every call
process.env.HTTPS_PROXY = proxyUrl; process.env.https_proxy = proxyUrl; process.env.NO_PROXY = ''; process.env.no_proxy = ''; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
for (let i = 0; i < 4; i++) assert.equal((await mk().getMargins()).equity.net, 12345.5);
assert.equal(tunnels, 4); assert.equal(conns, 4); ok('as it was: 4 calls opened 4 tunnels and 4 encrypted connections');

// WITH THE SHARED LINES: a NEW client for every call, as the app makes them
const agent = makeKeepAliveAgent({ proxyUrl, tls: { rejectUnauthorized: false } });
tunnels = 0; conns = 0; seen.length = 0;
for (let i = 0; i < 6; i++) assert.equal((await mk(agent).getMargins()).equity.net, 12345.5);
assert.equal(tunnels, 1); assert.equal(conns, 1); ok('6 calls from 6 fresh clients: 1 tunnel, 1 encrypted connection');
const o: any = await mk(agent).placeOrder('regular', { exchange: 'NFO', tradingsymbol: 'NIFTY26D0125800PE', transaction_type: 'BUY', quantity: 65, product: 'MIS', order_type: 'LIMIT', price: 158.5, validity: 'DAY' });
assert.equal(tunnels, 1); assert.match(o.order_id, /^ORD/);
const sent = seen.at(-1)!; assert.equal(sent.method, 'POST'); assert.equal(sent.url, '/orders/regular'); assert.equal(sent.auth, 'token key:tok');
assert.match(sent.body, /tradingsymbol=NIFTY26D0125800PE/); assert.match(sent.body, /quantity=65/); assert.match(sent.body, /price=158\.5/); assert.equal(sent.conn, 1);
ok('an order goes down the same open line, and arrives exactly as the library sends it (path, login header, fields)');
assert.ok(proxyAuthSeen.every((a) => a === 'Basic ' + Buffer.from('puser:ppass').toString('base64'))); ok('the proxy still gets its user name and password, on the tunnel only');
assert.ok(seen.every((s) => !/puser|ppass/.test(JSON.stringify(s)))); ok('and they never reach Zerodha');

// several at once: each waits for nobody, extra lines are opened and then kept
tunnels = 0;
await Promise.all([0, 1, 2].map(() => mk(agent).getMargins())); const afterBurst = tunnels;
await Promise.all([0, 1, 2].map(() => mk(agent).getMargins()));
assert.ok(afterBurst >= 2 && afterBurst <= 3); assert.equal(tunnels, afterBurst); ok(`three at once opened ${afterBurst} more line(s); the next three at once opened none`);

// an error from Zerodha is still the library's own error, and the line survives it
await assert.rejects(() => mk(agent).getQuote(['NFO:X']), (e: any) => /no such route/.test(e.message));
const t1 = tunnels; await mk(agent).getMargins(); assert.equal(tunnels, t1); ok('a refused request is reported as before and does not cost the line');

// THE LINE IS LOST (the proxy restarts): the call in hand fails or goes on a new line, and NOTHING is sent twice
for (const s of live) s.destroy(); await new Promise((r) => setTimeout(r, 120));
seen.length = 0; tunnels = 0;
let failed = 0; try { await mk(agent).placeOrder('regular', { exchange: 'NFO', tradingsymbol: 'ONCE', transaction_type: 'BUY', quantity: 65, product: 'MIS', order_type: 'LIMIT', price: 10, validity: 'DAY' }); } catch (e) { failed = 1; }
assert.ok(seen.filter((s) => /ONCE/.test(s.body)).length <= 1); assert.equal(seen.filter((s) => /ONCE/.test(s.body)).length, failed ? 0 : 1);
ok(`after the lines were cut, the order ${failed ? 'failed and reached Zerodha zero times' : 'went on a new line and reached Zerodha once'}: never twice`);
assert.equal((await mk(agent).getMargins()).equity.net, 12345.5); ok('and the next call works');

// the switch, and the things that are not the library's client
process.env.KITE_KEEPALIVE = '0'; const plain: any = new KiteConnect({ api_key: 'key' }); const before = plain.requestInstance.defaults.httpsAgent;
withKeepAlive(plain); assert.equal(plain.requestInstance.defaults.httpsAgent, before); assert.equal(keepAliveStats().on, false); delete process.env.KITE_KEEPALIVE; ok('KITE_KEEPALIVE=0 leaves a client exactly as the library made it');
const dbl = { getMargins: async () => 1 }; assert.equal(withKeepAlive(dbl), dbl); assert.equal(withKeepAlive(null as any), null); ok('a stand-in client (Dhan, a test double) or none is passed through untouched');

// the warmer: only in market hours, only when logged in
let market = false, calls = 0; const wkc: any = { access_token: 't', requestInstance: {}, getProfile: async () => { calls++; } };
const stop = startKiteWarmer(() => wkc, () => market, 30);
await new Promise((r) => setTimeout(r, 120)); assert.equal(calls, 0);
market = true; await new Promise((r) => setTimeout(r, 150)); assert.ok(calls >= 2);
wkc.access_token = null; const c0 = calls; await new Promise((r) => setTimeout(r, 120)); assert.equal(calls, c0); stop();
ok('the warmer reads only in market hours and only with a login');

agent.destroy(); for (const s of live) s.destroy(); proxy.close(); origin.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} passed`);
process.exit(0);
