// npx tsx src/lib/indicatorSync.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SYNC_KEYS, SEEN_KEY, AT_KEY, SPOT_HALF_COPY, type KV, type SyncDoc, snapshot, ensureBaseline, pendingChanges, mergeForPush, commitPushed, applyRemote, adoptSpotHalfCopy, halfCopyStorageName, serverBehind, mergeForMend } from './indicatorSync';

// A device: storage, and the two steps the browser part performs.
class Device implements KV {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  /** What the timer does every two seconds. Returns the names sent. */
  push(server: { doc: SyncDoc | null }, at: number): string[] {
    const keys = pendingChanges(this);
    if (!keys.length) return [];
    applyRemote(this, server.doc);
    const next = mergeForPush(server.doc, this, keys, at);
    server.doc = next;
    commitPushed(this, keys, next);
    return keys;
  }
  pull(server: { doc: SyncDoc | null }): string[] { return applyRemote(this, server.doc); }
}

// ── the list ──
assert.equal(new Set(SYNC_KEYS).size, SYNC_KEYS.length, 'no name twice');
assert.ok(SYNC_KEYS.includes('showRsi') && SYNC_KEYS.includes('rsiColor') && SYNC_KEYS.includes('favIndicators'));
assert.ok(!SYNC_KEYS.some((k) => k.startsWith('opt:')), 'an option chart\'s switches are not shared');
assert.ok(!SYNC_KEYS.includes('tpSlDefaults'), 'what shapes an order is not shared');
assert.ok(!SYNC_KEYS.includes('rsiPaneHeight'), 'one screen\'s layout is not shared');
assert.ok(!SYNC_KEYS.includes('indicatorLinesThin'), 'a device\'s own bookkeeping is not shared');

// ── a device's first run sends nothing: what it has is taken as read ──
{
  const phone = new Device(); const server = { doc: null as SyncDoc | null };
  phone.setItem('showRsi', 'true'); phone.setItem('showBB', 'false'); phone.setItem('rsiColor', '#ff0000');
  ensureBaseline(phone);
  assert.deepEqual(pendingChanges(phone), []);
  assert.deepEqual(phone.push(server, 1000), []);
  assert.equal(server.doc, null, 'nothing was sent');
  assert.equal(snapshot(phone).showRsi, 'true');
}

// ── a change on one device arrives on the other, and only that change ──
{
  const phone = new Device(), desk = new Device(); const server = { doc: null as SyncDoc | null };
  phone.setItem('showRsi', 'false'); phone.setItem('showBB', 'false');
  desk.setItem('showRsi', 'false'); desk.setItem('showBB', 'true');        // the desk has Bollinger Bands on; the phone does not
  ensureBaseline(phone); ensureBaseline(desk);
  phone.setItem('showRsi', 'true');                                        // RSI switched on, on the phone
  assert.deepEqual(phone.push(server, 5000), ['showRsi']);
  assert.deepEqual(server.doc, { showRsi: { v: 'true', at: 5000 } });
  assert.deepEqual(desk.pull(server), ['showRsi'], 'the desk takes the one value');
  assert.equal(desk.getItem('showRsi'), 'true');
  assert.equal(desk.getItem('showBB'), 'true', 'what else differed is left alone');
  assert.deepEqual(desk.pull(server), [], 'and takes it once');
  assert.deepEqual(desk.push(server, 6000), [], 'a value taken from the server is not a change made here');
  assert.deepEqual(phone.pull(server), [], 'nor does the sender take its own back');
}

// ── the newer change wins, whichever device it came from ──
{
  const phone = new Device(), desk = new Device(); const server = { doc: null as SyncDoc | null };
  ensureBaseline(phone); ensureBaseline(desk);
  phone.setItem('rsiColor', '#111111'); phone.push(server, 1000);
  desk.pull(server); assert.equal(desk.getItem('rsiColor'), '#111111');
  desk.setItem('rsiColor', '#222222'); desk.push(server, 2000);
  assert.deepEqual(phone.pull(server), ['rsiColor']); assert.equal(phone.getItem('rsiColor'), '#222222');
  // a document that is older than what a device knows changes nothing
  assert.deepEqual(phone.pull({ doc: { rsiColor: { v: '#111111', at: 1000 } } }), []);
  assert.equal(phone.getItem('rsiColor'), '#222222');
}

// ── a change made here and not yet sent is not overwritten by what arrives ──
{
  const phone = new Device(), desk = new Device(); const server = { doc: null as SyncDoc | null };
  ensureBaseline(phone); ensureBaseline(desk);
  desk.setItem('showFvg', 'false'); desk.push(server, 1000);
  phone.setItem('showFvg', 'true');                                        // changed on the phone a moment ago, not sent yet
  assert.deepEqual(phone.pull(server), [], 'the phone keeps its own');
  assert.equal(phone.getItem('showFvg'), 'true');
  assert.deepEqual(phone.push(server, 1500), ['showFvg']);
  assert.equal(server.doc!.showFvg.v, 'true');
  assert.deepEqual(desk.pull(server), ['showFvg']); assert.equal(desk.getItem('showFvg'), 'true');
}

// ── a device whose clock runs behind still gets its change across ──
{
  const phone = new Device(), desk = new Device(); const server = { doc: null as SyncDoc | null };
  ensureBaseline(phone); ensureBaseline(desk);
  desk.setItem('showVolume', 'false'); desk.push(server, 9000);
  phone.pull(server);
  phone.setItem('showVolume', 'true'); phone.push(server, 4000);           // the phone's clock says an earlier time
  assert.equal(server.doc!.showVolume.at, 9001, 'stamped just after what was there');
  assert.deepEqual(desk.pull(server), ['showVolume']); assert.equal(desk.getItem('showVolume'), 'true');
}

// ── a value taken away travels too, and two names changed at once go together ──
{
  const phone = new Device(), desk = new Device(); const server = { doc: null as SyncDoc | null };
  phone.setItem('favIndicators', '["RSI"]'); desk.setItem('favIndicators', '["RSI"]');
  ensureBaseline(phone); ensureBaseline(desk);
  phone.removeItem('favIndicators'); phone.setItem('bbPeriod', '34');
  assert.deepEqual(phone.push(server, 3000).sort(), ['bbPeriod', 'favIndicators']);
  assert.deepEqual(desk.pull(server).sort(), ['bbPeriod', 'favIndicators']);
  assert.equal(desk.getItem('favIndicators'), null); assert.equal(desk.getItem('bbPeriod'), '34');
}

// ── names that are not shared never travel, whatever the document says ──
{
  const phone = new Device(); ensureBaseline(phone);
  phone.setItem('opt:showRsi', 'true'); phone.setItem('tpSlDefaults', '{"sl":10}'); phone.setItem('timeframe', '5');
  assert.deepEqual(pendingChanges(phone), []);
  const evil = { 'opt:showRsi': { v: 'false', at: 99 }, tpSlDefaults: { v: '{}', at: 99 }, kite_token: { v: 'x', at: 99 }, showRsi: { v: 'true', at: 99 } } as SyncDoc;
  assert.deepEqual(applyRemote(phone, evil), ['showRsi']);
  assert.equal(phone.getItem('opt:showRsi'), 'true'); assert.equal(phone.getItem('tpSlDefaults'), '{"sl":10}'); assert.equal(phone.getItem('kite_token'), null);
  // and what is sent carries only shared names, even if the server's copy had others
  const sent = mergeForPush(evil, phone, [], 100);
  assert.deepEqual(Object.keys(sent), ['showRsi']);
}

// ── a broken document or broken records do no harm ──
{
  const phone = new Device(); phone.setItem('showRsi', 'true'); ensureBaseline(phone);
  assert.deepEqual(applyRemote(phone, null), []);
  assert.deepEqual(applyRemote(phone, { showRsi: null as any, showBB: { v: 'true' } as any, showFvg: 'x' as any }), []);
  phone.setItem(AT_KEY, 'not json'); phone.setItem(SEEN_KEY, '{"showRsi":"true"}');
  assert.deepEqual(applyRemote(phone, { showRsi: { v: 'false', at: 5 } }), ['showRsi']);
  assert.equal(phone.getItem('showRsi'), 'false');
}

// ── a name added to the list later starts as read on a device that already has a record ──
{
  const phone = new Device(); phone.setItem('showRsi', 'true'); phone.setItem('bbColor', '#abcdef');
  phone.setItem(SEEN_KEY, JSON.stringify({ showRsi: 'true' }));           // a record from before bbColor was shared
  assert.deepEqual(pendingChanges(phone), [], 'bbColor is not a change made here');
  phone.setItem('bbColor', '#000000');
  assert.deepEqual(pendingChanges(phone), ['bbColor'], 'but a change to it afterwards is');
}

// ── two devices send at the same moment: the second write leaves the first one's change out, and it is put back ──
{
  const server = { doc: null as SyncDoc | null };
  const phone = new Device(), desk = new Device(), tab = new Device();
  for (const d of [phone, desk, tab]) { d.setItem('showRsi', 'true'); d.setItem('showBB', 'false'); ensureBaseline(d); }
  // Both read the (empty) document, both add their own change, both write the whole document back.
  phone.setItem('showRsi', 'false'); desk.setItem('showBB', 'true');
  const read = server.doc;
  const fromPhone = mergeForPush(read, phone, pendingChanges(phone), 1000);
  const fromDesk = mergeForPush(read, desk, pendingChanges(desk), 1001);
  server.doc = fromPhone; commitPushed(phone, ['showRsi'], fromPhone);
  server.doc = fromDesk; commitPushed(desk, ['showBB'], fromDesk);          // the desk's write lands last: the phone's change is not in it
  assert.equal(server.doc!.showRsi, undefined);
  assert.deepEqual(pendingChanges(phone), [], 'the phone believes it was sent');
  // The phone's next read finds the document older than what it holds, and puts it back under the same time.
  assert.deepEqual(phone.pull(server), ['showBB'], 'it takes the desk\'s change');
  assert.deepEqual(serverBehind(phone, server.doc), ['showRsi']);
  assert.deepEqual(serverBehind(desk, server.doc), [], 'the desk has nothing the server lacks');
  server.doc = mergeForMend(server.doc, phone, serverBehind(phone, server.doc));
  assert.deepEqual(server.doc.showRsi, { v: 'false', at: 1000 }); assert.deepEqual(server.doc.showBB, { v: 'true', at: 1001 });
  assert.deepEqual(serverBehind(phone, server.doc), [], 'mended once, and not again');
  assert.deepEqual(desk.pull(server), ['showRsi']); assert.equal(desk.getItem('showRsi'), 'false');
  assert.deepEqual(tab.pull(server).sort(), ['showBB', 'showRsi']);
  for (const d of [phone, desk, tab]) { assert.deepEqual(serverBehind(d, server.doc), []); assert.deepEqual(pendingChanges(d), []); }
  // Mending never lowers a time: a newer value that reached the server meanwhile stays.
  const older = new Device(); older.setItem('showRsi', 'true'); ensureBaseline(older);
  older.setItem(AT_KEY, JSON.stringify({ showRsi: 500 }));
  assert.deepEqual(serverBehind(older, server.doc), []);
  assert.deepEqual(mergeForMend(server.doc, older, ['showRsi']).showRsi, { v: 'false', at: 1000 });
  // A value changed here and not yet sent is the ordinary send's, not a mend.
  phone.setItem('showRsi', 'true');
  assert.deepEqual(serverBehind(phone, { ...server.doc, showRsi: { v: 'false', at: 1 } }), []);
  assert.deepEqual(pendingChanges(phone), ['showRsi']);
  // The server's document lost altogether: every device that holds a time for a value puts it back.
  phone.push(server, 2000);
  const lost = { doc: null as SyncDoc | null };
  assert.deepEqual(serverBehind(desk, lost.doc).sort(), ['showBB', 'showRsi']);
  lost.doc = mergeForMend(lost.doc, desk, serverBehind(desk, lost.doc));     // the desk had not yet seen the phone's last change
  lost.doc = mergeForMend(lost.doc, phone, serverBehind(phone, lost.doc));
  assert.deepEqual(lost.doc.showRsi, { v: 'true', at: 2000 }, 'the newest of what the devices hold');
  assert.deepEqual(lost.doc.showBB, { v: 'true', at: 1001 });
}

// ── the desktop's index half: its old copy is put into the plain names once, and never sent ──
{
  // A desktop as v317 left it: the plain names hold whatever the last load left
  // (here the OPTION half's RSI colour and stars), the index half's copy holds
  // the index chart as he sees it.
  const desk = new Device();
  desk.setItem('showRsi', 'true'); desk.setItem('rsiColor', '#00ff00'); desk.setItem('structDays', '1');
  desk.setItem('favIndicators', '["OIBars"]'); desk.setItem('swapSweepMode', 'combined'); desk.setItem('pdhColor', '#111111');
  desk.setItem(SPOT_HALF_COPY, JSON.stringify({
    showRsi: false, rsiColor: '#a855f7', structDays: 3, favIndicators: ['RSI', 'Volume'], ssMode: 'single',
    sessionBreak: { on: true, color: '#333333' }, ilSettings: { rounds: true }, showGiftDiv: false, pdhColor: '#111111', fvgOpacity: 0.25, notAName: 1,
  }));
  desk.setItem('paneIndicators:option', '{"rsiColor":"#00ff00"}');
  const wrote = adoptSpotHalfCopy(desk, true);
  assert.equal(desk.getItem('showRsi'), 'false', 'a yes / no as its text');
  assert.equal(desk.getItem('rsiColor'), '#a855f7', 'text as it is');
  assert.equal(desk.getItem('structDays'), '3', 'a number as its text');
  assert.equal(desk.getItem('favIndicators'), '["RSI","Volume"]', 'a list as JSON');
  assert.equal(desk.getItem('swapSweepMode'), 'single', 'ssMode is swapSweepMode in storage');
  assert.equal(desk.getItem('sessionBreaks'), '{"on":true,"color":"#333333"}', 'sessionBreak is sessionBreaks in storage, an object as JSON');
  assert.equal(desk.getItem('instLevelsSettings'), '{"rounds":true}');
  assert.equal(desk.getItem('showGiftDivergence'), 'false');
  assert.equal(desk.getItem('fvgOpacity'), '0.25');
  assert.equal(desk.getItem('notAName'), null, 'only the shared names are written');
  assert.ok(!wrote.includes('pdhColor'), 'a value that was already the same is not written');
  assert.deepEqual([...wrote].sort(), ['favIndicators', 'fvgOpacity', 'instLevelsSettings', 'rsiColor', 'sessionBreaks', 'showGiftDivergence', 'showRsi', 'structDays', 'swapSweepMode'].sort());
  assert.equal(desk.getItem(SPOT_HALF_COPY), null, 'the copy is gone');
  assert.equal(desk.getItem('paneIndicators:option'), '{"rsiColor":"#00ff00"}', 'the option half\'s copy is not touched');
  // The sharing starts after it: what the copy wrote is the starting point, not a change made here.
  assert.deepEqual(pendingChanges(desk), [], 'nothing of it is sent');
  const server = { doc: null as SyncDoc | null };
  assert.deepEqual(desk.push(server, 1000), []); assert.equal(server.doc, null);
  // A second run finds nothing to do.
  assert.deepEqual(adoptSpotHalfCopy(desk, true), []);
}
{
  // A device that has run the sharing before: the plain names are what it shares. A copy found then is stale.
  const d = new Device(); d.setItem('showRsi', 'true'); ensureBaseline(d);
  d.setItem(SPOT_HALF_COPY, '{"showRsi":false}');
  assert.deepEqual(adoptSpotHalfCopy(d, true), []);
  assert.equal(d.getItem('showRsi'), 'true'); assert.equal(d.getItem(SPOT_HALF_COPY), null); assert.deepEqual(pendingChanges(d), []);
}
{
  // A phone showing its one chart, with a copy from a day it was turned sideways: not put back.
  const d = new Device(); d.setItem('showRsi', 'true'); d.setItem(SPOT_HALF_COPY, '{"showRsi":false}');
  assert.deepEqual(adoptSpotHalfCopy(d, false), []);
  assert.equal(d.getItem('showRsi'), 'true'); assert.equal(d.getItem(SPOT_HALF_COPY), null);
}
{
  // No copy, and a copy that is not an object: nothing written, nothing thrown.
  const d = new Device(); d.setItem('showRsi', 'true');
  assert.deepEqual(adoptSpotHalfCopy(d, true), []);
  for (const junk of ['not json', '[1,2]', 'null', '7']) { d.setItem(SPOT_HALF_COPY, junk); assert.deepEqual(adoptSpotHalfCopy(d, true), []); assert.equal(d.getItem(SPOT_HALF_COPY), null); }
  assert.equal(d.getItem('showRsi'), 'true');
}

// ── the two lists are in step: every value a desktop half keeps in its own copy is a shared name the chart saves ──
// Read off the chart's own source, so a setting added to a half's copy later
// without a storage name here fails this and not his chart.
{
  const src = readFileSync(new URL('../pages/AdvancedChart.tsx', import.meta.url), 'utf8');
  const from = src.indexOf('const paneInd: Record'), to = src.indexOf('const paneIndKey');
  assert.ok(from > 0 && to > from, 'the half\'s copy list is where it was');
  const copyNames = [...src.slice(from, to).matchAll(/(\w+): \[\w+, set\w+\]/g)].map((m) => m[1]);
  assert.ok(copyNames.length >= 60, 'the list was read');
  for (const name of copyNames) {
    const key = halfCopyStorageName(name);
    assert.ok(SYNC_KEYS.includes(key), `${name}: "${key}" is a shared name`);
    assert.ok(new RegExp(`(?:localStorage\\.setItem|indSet)\\('${key}',`).test(src), `${name}: the chart saves "${key}"`);
  }
  assert.equal(halfCopyStorageName('ssMode'), 'swapSweepMode'); assert.equal(halfCopyStorageName('rsiColor'), 'rsiColor');
}

console.log('indicatorSync: all checks passed');
