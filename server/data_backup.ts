// A FULL COPY OF THE APP'S STORED DATA, DOWNLOADED ONCE (27 Nov 2026).
//
// Martin, before the server is moved from San Francisco to Singapore: "Let's go
// for option 2. Full copy first." Railway's plan here has no volume backups, so
// the copy is made by the app itself: every file in the data folder (the
// volume, KITE_DATA_DIR), packed into one .tar.gz and sent to his browser.
//
//   POST /api/admin/backup      body: pin=<SIGNALS_PIN>   (a form post, so the
//                               browser saves it straight to disk; the PIN is
//                               never in a link)
//   GET  /api/admin/backup      { available, done, files? }  (no PIN: says only
//                               whether a copy can still be taken)
//
// WHAT IS IN IT. The databases are copied with SQLite's own backup, so each is
// a consistent file even while the app is writing to it (their -wal / -shm /
// -journal side files are left out: the backup already holds what they hold).
// Any other file is copied as it is. A MANIFEST.txt lists names and sizes.
//
// IT HOLDS LOGINS. kite_session.db carries the day's Zerodha session and the
// Telegram login. So: the PIN is required and compared in constant time; five
// wrong PINs lock the route until the server restarts; only one copy can be
// under way at a time; and once ONE copy has been sent in full the route
// refuses until the next restart. It is to be taken out again in the release
// after the move.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import Database from 'better-sqlite3';

const SIDE = /-(wal|shm|journal)$/i;
const isDb = (name: string) => /\.(db|sqlite|sqlite3)$/i.test(name);

/** Every regular file under `dir`, relative paths, side files left out. */
export function listDataFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  let names: fs.Dirent[] = [];
  try { names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) { if (d.name !== 'lost+found') out.push(...listDataFiles(dir, r)); continue; }
    if (!d.isFile() || SIDE.test(d.name)) continue;
    out.push(r);
  }
  return out.sort();
}

/** One tar header block (ustar) for a regular file. */
export function tarHeader(name: string, size: number, mtimeSec: number): Buffer {
  const b = Buffer.alloc(512, 0);
  let n = name, prefix = '';
  if (Buffer.byteLength(n) > 100) {            // long path: split at a slash into prefix + name
    const cut = n.lastIndexOf('/', n.length - 1);
    if (cut > 0 && Buffer.byteLength(n.slice(cut + 1)) <= 100 && Buffer.byteLength(n.slice(0, cut)) <= 155) { prefix = n.slice(0, cut); n = n.slice(cut + 1); }
    else throw new Error(`file name too long for the archive: ${name}`);
  }
  const oct = (v: number, len: number) => v.toString(8).padStart(len - 1, '0') + '\0';
  b.write(n, 0, 100, 'utf8');
  b.write(oct(0o600, 8), 100, 8, 'ascii');
  b.write(oct(0, 8), 108, 8, 'ascii');
  b.write(oct(0, 8), 116, 8, 'ascii');
  b.write(oct(size, 12), 124, 12, 'ascii');
  b.write(oct(mtimeSec, 12), 136, 12, 'ascii');
  b.write('        ', 148, 8, 'ascii');          // checksum field counts as spaces while summing
  b.write('0', 156, 1, 'ascii');                 // a regular file
  b.write('ustar\0', 257, 6, 'ascii');
  b.write('00', 263, 2, 'ascii');
  if (prefix) b.write(prefix, 345, 155, 'utf8');
  let sum = 0; for (let i = 0; i < 512; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return b;
}

/** Copies the data folder into `tmp`: databases by SQLite backup, the rest as they are. */
export async function snapshotDataDir(dataDir: string, tmp: string): Promise<{ name: string; size: number; how: string }[]> {
  const done: { name: string; size: number; how: string }[] = [];
  for (const rel of listDataFiles(dataDir)) {
    const src = path.join(dataDir, rel), dst = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let how = 'copied';
    if (isDb(rel)) {
      try {
        const d = new Database(src, { readonly: true, fileMustExist: true });
        try { await d.backup(dst); how = 'sqlite backup'; } finally { d.close(); }
      } catch (e: any) {
        // Not a database after all, or it could not be opened: the file itself is still worth having.
        try { fs.rmSync(dst, { force: true }); } catch { }
        fs.copyFileSync(src, dst); how = `copied (sqlite backup failed: ${String(e?.message || e).slice(0, 80)})`;
      }
    } else fs.copyFileSync(src, dst);
    done.push({ name: rel, size: fs.statSync(dst).size, how });
  }
  return done;
}

export function registerDataBackup(app: any, deps: { dataDir: string; pinOk: (given: any) => boolean; pinConfigured: () => boolean; log?: (s: string) => void }) {
  const log = deps.log || ((s: string) => console.log(s));
  let wrong = 0, busy = false, done = false;

  app.get('/api/admin/backup', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, available: deps.pinConfigured() && !done && !busy && wrong < 5, done, busy, locked: wrong >= 5 });
  });

  app.post('/api/admin/backup', express.urlencoded({ extended: false, limit: '2kb' }), express.json({ limit: '2kb' }), async (req: any, res: any) => {
    const refuse = (code: number, error: string) => res.status(code).type('text/plain').send(error);
    if (!deps.pinConfigured()) return refuse(403, 'Set SIGNALS_PIN in Railway first.');
    if (wrong >= 5) return refuse(423, 'Too many wrong PINs. The backup is locked until the server restarts.');
    if (!deps.pinOk(req.body?.pin)) { wrong++; log(`[backup] wrong PIN (${wrong} of 5)`); return refuse(401, 'Wrong PIN.'); }
    if (done) return refuse(410, 'A full copy has already been downloaded. It can be taken once per server start.');
    if (busy) return refuse(409, 'A copy is already being made.');
    busy = true;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nifty-backup-'));
    const clean = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { } };
    try {
      const t0 = Date.now();
      const files = await snapshotDataDir(deps.dataDir, tmp);
      const day = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
      const manifest = [`NIFTY terminal: full copy of the data folder, ${new Date().toISOString()}`, `id ${crypto.randomBytes(4).toString('hex')}`, '',
        ...files.map((f) => `${String(f.size).padStart(12)}  ${f.name}  (${f.how})`), ''].join('\n');
      fs.writeFileSync(path.join(tmp, 'MANIFEST.txt'), manifest);
      const all = [{ name: 'MANIFEST.txt', size: Buffer.byteLength(manifest), how: '' }, ...files];
      log(`[backup] snapshot of ${files.length} files, ${Math.round(files.reduce((a, f) => a + f.size, 0) / 1048576)} MB, made in ${Date.now() - t0} ms: ${files.map((f) => `${f.name} ${f.size}`).join(', ')}`);

      res.status(200);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="nifty-terminal-backup-${day}.tar.gz"`);
      res.setHeader('Cache-Control', 'no-store');
      const gz = zlib.createGzip({ level: 1 });
      gz.pipe(res);
      let aborted = false;
      res.on('close', () => { if (!res.writableFinished) { aborted = true; try { gz.destroy(); } catch { } } });
      const write = (buf: Buffer) => new Promise<void>((resolve, reject) => {
        if (aborted) return reject(new Error('download stopped'));
        if (gz.write(buf)) resolve(); else gz.once('drain', () => resolve());
      });
      const mtime = Math.floor(Date.now() / 1000);
      for (const f of all) {
        await write(tarHeader(`nifty-terminal-backup-${day}/${f.name}`, f.size, mtime));
        let sent = 0;
        for await (const chunk of fs.createReadStream(path.join(tmp, f.name), { highWaterMark: 1 << 20 })) { await write(chunk as Buffer); sent += (chunk as Buffer).length; }
        if (sent !== f.size) throw new Error(`${f.name} changed size while being sent`);
        const pad = (512 - (f.size % 512)) % 512;
        if (pad) await write(Buffer.alloc(pad, 0));
      }
      await write(Buffer.alloc(1024, 0));          // the archive's end
      await new Promise<void>((resolve, reject) => { res.once('finish', () => resolve()); res.once('close', () => (res.writableFinished ? resolve() : reject(new Error('download stopped')))); gz.end(); });
      done = true;
      log(`[backup] full copy sent in ${Date.now() - t0} ms. The route is closed until the next restart.`);
    } catch (e: any) {
      log(`[backup] failed: ${e?.message || e}`);
      if (!res.headersSent) refuse(500, `Backup failed: ${e?.message || e}`);
      else { try { res.destroy(); } catch { } }
    } finally { busy = false; clean(); }
  });
}
