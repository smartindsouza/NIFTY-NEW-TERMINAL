// The one-time full backup: PIN, the archive really unpacks, the databases in it are whole.   npx tsx server/data_backup.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import Database from 'better-sqlite3';
import { registerDataBackup, listDataFiles, tarHeader } from './data_backup';

let n = 0; const ok = (name: string) => { n++; console.log('ok', name); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-data-'));
// a database in WAL mode with rows that are still only in the -wal file, as the live one is
const live = new Database(path.join(dir, 'kite_session.db')); live.pragma('journal_mode = WAL'); live.pragma('wal_autocheckpoint = 0');
live.exec('CREATE TABLE trade_journal (id INTEGER PRIMARY KEY, sym TEXT, pnl REAL)');
const ins = live.prepare('INSERT INTO trade_journal (sym, pnl) VALUES (?, ?)');
for (let i = 0; i < 500; i++) ins.run('NIFTY26D0125800PE', i * 1.25);
assert.ok(fs.existsSync(path.join(dir, 'kite_session.db-wal')) && fs.statSync(path.join(dir, 'kite_session.db-wal')).size > 0);
const big = new Database(path.join(dir, 'fut_ticks.db')); big.exec('CREATE TABLE t (x BLOB)'); const bi = big.prepare('INSERT INTO t VALUES (?)');
for (let i = 0; i < 300; i++) bi.run(Buffer.alloc(8192, i % 251)); big.close();
fs.writeFileSync(path.join(dir, 'notes.txt'), 'plain file, 1234567 bytes follow\n' + 'x'.repeat(1234567));
fs.mkdirSync(path.join(dir, 'sub/deeper'), { recursive: true }); fs.writeFileSync(path.join(dir, 'sub/deeper/inner.json'), '{"a":1}');
fs.writeFileSync(path.join(dir, 'empty.bin'), '');
// 80 MB that does not compress, so a download is still under way when it is cut off
const rnd = crypto.randomBytes(80 << 20); fs.writeFileSync(path.join(dir, 'random.bin'), rnd);

assert.deepEqual(listDataFiles(dir), ['empty.bin', 'fut_ticks.db', 'kite_session.db', 'notes.txt', 'random.bin', 'sub/deeper/inner.json']); ok('lists every file, without the -wal / -shm side files');
assert.equal(tarHeader('a/b.txt', 5, 0).length, 512); assert.throws(() => tarHeader('x'.repeat(300), 1, 0)); ok('a header is one 512-byte block; an impossible name is refused, not cut short');

const logs: string[] = [];
const mk = () => { const app = express(); registerDataBackup(app, { dataDir: dir, pinOk: (g) => String(g ?? '') === '654321', pinConfigured: () => true, log: (s) => logs.push(s) }); const srv = app.listen(0); return { srv, url: `http://127.0.0.1:${(srv.address() as any).port}/api/admin/backup` }; };
const form = (pin: string) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `pin=${encodeURIComponent(pin)}` });
let { srv, url } = mk();
assert.deepEqual(await (await fetch(url)).json(), { ok: true, available: true, done: false, busy: false, ready: false, locked: false }); ok('status: available');
let r = await fetch(url, form('000000')); assert.equal(r.status, 401); ok('wrong PIN: 401, nothing sent');
r = await fetch(url, { method: 'POST' }); assert.equal(r.status, 401); ok('no PIN: 401');
assert.equal((await fetch(url + '?pin=654321', { method: 'POST' })).status, 401); ok('a PIN in the link is not accepted');

// A DOWNLOAD THAT BREAKS IS CARRIED ON, AND LEAVES NOTHING STUCK (what happened on
// the live app: the connection closed half a second in). The page's own way:
// the PIN as JSON, read some, lose the connection, ask again from that byte.
const json = (body: any, signal?: AbortSignal) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
const ac = new AbortController();
r = await fetch(url, json({ pin: '654321' }, ac.signal));
assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition') || '', /attachment; filename="nifty-terminal-backup-\d{4}-\d{2}-\d{2}\.tar\.gz"/);
const total = Number(r.headers.get('x-backup-size')); assert.ok(total > 1000); assert.equal(Number(r.headers.get('content-length')), total);
for (let i = 0; i < 50; i++) ins.run('LATE', 1);                        // rows written after the copy was made
const reader = r.body!.getReader(); const first = Buffer.from((await reader.read()).value!).subarray(0, 700);
ac.abort(); await new Promise((res) => setTimeout(res, 150));
let st: any = await (await fetch(url)).json(); assert.equal(st.done, false); assert.equal(st.available, true); assert.equal(st.ready, true); assert.equal(st.busy, false);
ok('a download cut off after 700 bytes: not counted as taken, nothing left busy, the archive is kept');
r = await fetch(url, json({ pin: '654321', offset: 700 }));
assert.equal(r.status, 200); assert.equal(Number(r.headers.get('content-length')), total - 700);
const buf = Buffer.concat([first, Buffer.from(await r.arrayBuffer())]); assert.equal(buf.length, total);
ok('carried on from byte 700: the two parts make the whole file');
await new Promise((res) => setTimeout(res, 100));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-out-')); const tgz = path.join(outDir, 'b.tar.gz'); fs.writeFileSync(tgz, buf);
execFileSync('tar', ['-xzf', tgz, '-C', outDir]);                       // the system's own tar unpacks it
const root = path.join(outDir, fs.readdirSync(outDir).find((x) => x.startsWith('nifty-terminal-backup-'))!);
assert.deepEqual(listDataFiles(root), ['MANIFEST.txt', 'empty.bin', 'fut_ticks.db', 'kite_session.db', 'notes.txt', 'random.bin', 'sub/deeper/inner.json']); ok(`the archive (${buf.length} bytes) unpacks with tar to the same files plus a manifest`);
const got = new Database(path.join(root, 'kite_session.db'), { readonly: true });
assert.equal(got.pragma('integrity_check', { simple: true }), 'ok');
const c = (got.prepare("SELECT COUNT(*) n, SUM(pnl) s FROM trade_journal WHERE sym != 'LATE'").get() as any);
assert.equal(c.n, 500); assert.equal(c.s, 500 * 499 / 2 * 1.25); got.close(); ok('the journal database in it is whole: all 500 rows that were only in the -wal file, integrity ok');
const g2 = new Database(path.join(root, 'fut_ticks.db'), { readonly: true }); assert.equal((g2.prepare('SELECT COUNT(*) n FROM t').get() as any).n, 300); assert.equal(g2.pragma('integrity_check', { simple: true }), 'ok'); g2.close(); ok('the second database too');
assert.equal(fs.readFileSync(path.join(root, 'notes.txt')).length, 33 + 1234567); assert.equal(fs.readFileSync(path.join(root, 'sub/deeper/inner.json'), 'utf8'), '{"a":1}'); assert.equal(fs.statSync(path.join(root, 'empty.bin')).size, 0); assert.ok(fs.readFileSync(path.join(root, 'random.bin')).equals(rnd)); ok('plain files byte for byte, a nested one and an empty one included');
assert.match(fs.readFileSync(path.join(root, 'MANIFEST.txt'), 'utf8'), /kite_session\.db {2}\(sqlite backup\)/); ok('the manifest names each file and how it was copied');
assert.equal(fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('nifty-backup-')).length, 0); ok('the server\'s own temporary copy is removed once the last byte has gone');
assert.ok(!logs.join('\n').includes('654321')); ok('the PIN is never logged');

r = await fetch(url, form('654321')); assert.equal(r.status, 410); assert.equal((await (await fetch(url)).json()).available, false); ok('a second copy is refused (410): once per server start');
srv.close();
// an archive nobody collects is removed
{ const app = express(); registerDataBackup(app, { dataDir: dir, pinOk: (g) => String(g ?? '') === '654321', pinConfigured: () => true, log: () => {}, keepMs: 300 }); const s2 = app.listen(0); const u2 = `http://127.0.0.1:${(s2.address() as any).port}/api/admin/backup`;
  const a2 = new AbortController(); const r2 = await fetch(u2, json({ pin: '654321' }, a2.signal)); await r2.body!.getReader().read(); a2.abort();
  assert.equal((await fetch(u2, json({ pin: '654321', offset: 10 ** 9 }))).status, 416);
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('nifty-backup-')).length, 0); assert.equal((await (await fetch(u2)).json()).ready, false); s2.close(); ok('an archive left uncollected is removed after its time; an offset past the end is refused'); }
({ srv, url } = mk());
for (let i = 0; i < 5; i++) assert.equal((await fetch(url, form('1'))).status, 401);
assert.equal((await fetch(url, form('654321'))).status, 423); ok('five wrong PINs lock it, even for the right one');
srv.close(); live.close();
for (const d of [dir, outDir]) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${n} passed`);
process.exit(0);
