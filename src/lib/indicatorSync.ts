// THE INDEX CHART'S INDICATORS ARE THE SAME ON EVERY DEVICE (17 Nov 2026).
// Martin: "Anywhere I change or add an indicator to the spot chart should sync
// in all devices". Every indicator's switch and every one of its settings is a
// value in the browser's own storage, so the phone and the desktop each had
// their own: an indicator turned on at the desk was not on in the hand.
//
// WHAT IS SHARED is listed below: the index chart's switches, each indicator's
// settings (colours, widths, periods, levels), the three alert switches that
// sit in the same list, and the stars. NOT shared, on purpose:
//   - an option chart's switches ("opt:" + name) — he asked for the spot chart;
//   - the SL & TP defaults that sit in the list as a gear — they shape orders,
//     and a setting that shapes an order is changed where it is changed;
//   - what is a matter of one screen: the RSI pane's height, the bias card's ×;
//   - a device's own bookkeeping, such as the mark that its saved line styles
//     were once reset to thin ("indicatorLinesThin") — that says what was done
//     to this device's storage, and is true or not of each device by itself.
//
// HOW. Each value is shared ON ITS OWN, newest change wins — not the whole set
// at once. So the first thing changed after this shipped carried that one
// value across, and left whatever else differed between two devices alone
// until that, too, is changed somewhere. (Sending a device's whole set would
// have had the first phone opened overwrite the desktop's chart, or the other
// way about, with no one having asked.)
//
// THE PHONE'S SET, ONCE. He had asked, in the same message: "I also want the
// indicators I have used in the mobile app in iOS to be synced to all devices
// including laptops and pc's." Sharing changes alone never does that: what
// already differed between his phone and his desk stayed different until each
// thing was changed again by hand. So, one time only, his iPhone sends its
// whole set — every name, as it stands there, stamped newer than anything in
// the document — and every other device takes it like any other change. A mark
// on the server (SYNC_SEED_SETTING) says it has been done, so no phone does it
// twice and nothing a device changes afterwards is ever written over by it.
// Before a device takes a set that size, what it held is kept under
// "indSync:before" on that device, so it can be put back.
// The shared copy is one small document on the server, under the same settings
// store the H levels already use: { name: { v: value or null, at: time } }.
//   - A CHANGE HERE is noticed by looking — the values are read every two
//     seconds and compared with what was there last time — not by being told:
//     they are written from some eighty places, and a place added later would
//     have had to remember to say so. A changed value is stamped with the time
//     and merged into the document.
//   - A CHANGE ELSEWHERE is found by reading the document (when the chart page
//     opens, when the app comes back to the front, and every twenty seconds).
//     A value there that is newer than this device's own record of it is
//     written into storage, and the chart is told to read its storage again.
// A value changed here in the last two seconds, and not yet sent, is never
// overwritten by what arrives: it is the newer of the two.
//
// The arithmetic is in pure functions over a storage-shaped object, so it is
// tested without a browser (indicatorSync.test.ts). The part that needs one —
// the timers and the two requests — is startIndicatorSync, at the foot.

/** The index chart's indicator switches. */
export const SWITCH_KEYS = [
  'showPdhPdl', 'showOpeningRange', 'showBos', 'showInstLevels', 'showBreakers', 'showStructure', 'showOrderBlocks',
  'showFvg', 'showDsZones', 'showSnR', 'showOiBars', 'showRsi', 'showBB', 'showHLevels', 'showFiftyPercentLevels',
  'showVolume', 'showConfSignals', 'showPinBars', 'showSwapSweep', 'showGiftDivergence', 'sessionBreaks', 'showBiasLevels',
  // the three alerts that are rows of the same list
  'levelAlertsOn', 'zoneTapAlertsOn', 'breakoutAlertsOn',
] as const;
/** Each indicator's settings, and the stars. */
export const SETTING_KEYS = [
  'pdhColor', 'pdlColor', 'pdhPdlWidth', 'pdhPdlStyle',
  'orHighColor', 'orLowColor',
  'structDays', 'structBullColor', 'structBearColor',
  'instLevelsSettings', 'breakerSettings',
  'fvgBullColor', 'fvgBearColor', 'fvgOpacity',
  'dsZoneOpacity', 'dzStyle', 'dzFvg',
  'supportColor', 'resistanceColor', 'snrWidth', 'snrStyle',
  'oiCallColor', 'oiPutColor', 'oiBarThickness', 'oiBarGap', 'oiMaxBarWidth',
  'rsiColor', 'rsiLineWidth', 'rsiLineStyle', 'rsiSmaColor', 'rsiSmaLineWidth', 'rsiSmaLineStyle',
  'rsiOverbought1', 'rsiOverbought2', 'rsiOverboughtColor', 'rsiOversold1', 'rsiOversold2', 'rsiOversoldColor',
  'bbPeriod', 'bbStdDev', 'bbColor',
  'hLevelsWidth', 'hLevelsStyle', 'fiftyPercentColor',
  'swapSweepMode',
  'levelAlertRearm', 'levelAlertCooldown', 'zoneTapMinSize', 'breakoutAlertMode',
  'favIndicators',
] as const;
export const SYNC_KEYS: readonly string[] = [...SWITCH_KEYS, ...SETTING_KEYS];

/** The server's settings name for the shared document. */
export const SYNC_SETTING = 'chart_indicators';
/**
 * THE SHARING CAN BE SWITCHED OFF FOR EVERY DEVICE WITHOUT A DEPLOY: the value
 * `true` under this name in the same settings store. The app is not deployed
 * between 9:15 AM and 3:40 PM, so something wrong with the sharing found during
 * market hours could otherwise not be stopped until the close. While it is
 * `true` no device sends, takes or rebuilds anything; each keeps its own
 * storage as it is, and what he changes meanwhile is sent when it is switched
 * back on (the value removed).
 *   curl -X PUT -H 'Content-Type: application/json' -d '{"value":true}' <app>/api/settings/chart_indicators_off
 */
export const SYNC_OFF_SETTING = 'chart_indicators_off';
/**
 * The mark that the phone's whole set has been sent once (see THE PHONE'S SET,
 * ONCE, at the top). Unset: not yet. To have a phone send its set again, clear
 * it:  curl -X PUT -H 'Content-Type: application/json' -d '{"value":null}' <app>/api/settings/chart_indicators_seed
 */
export const SYNC_SEED_SETTING = 'chart_indicators_seed';
/** What this device last saw in its own storage, to tell a change made here. */
export const SEEN_KEY = 'indSync:seen';
/** What this device held before it took a whole set from another: { at, was: { name: value } }. Written once, never sent. */
export const BEFORE_KEY = 'indSync:before';
/** A change of this many values at once is another device's whole set, not something switched in a list. */
export const WHOLE_SET = 5;
/** When each value was last changed here or taken from the server. */
export const AT_KEY = 'indSync:at';

export type SyncDoc = Record<string, { v: string | null; at: number }>;
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
type Values = Record<string, string | null>;

const readJson = <T,>(store: KV, key: string): T | null => {
  try { const v = JSON.parse(store.getItem(key) || 'null'); return v && typeof v === 'object' ? v as T : null; } catch { return null; }
};
const writeJson = (store: KV, key: string, v: unknown) => { try { store.setItem(key, JSON.stringify(v)); } catch { /* storage full or closed */ } };

/** Every shared value as it stands in storage now (null: not set). */
export function snapshot(store: KV): Values {
  const out: Values = {};
  for (const k of SYNC_KEYS) { try { out[k] = store.getItem(k); } catch { out[k] = null; } }
  return out;
}

/**
 * The first time a device runs this, what it has is taken as read: nothing in
 * it is a "change", so nothing is sent. Without this a device's whole set would
 * look new to it and be sent over everyone else's.
 */
export function ensureBaseline(store: KV): Values {
  const seen = readJson<Values>(store, SEEN_KEY);
  const now = snapshot(store);
  if (!seen) { writeJson(store, SEEN_KEY, now); return now; }
  // A name added to the list in a later version is new to this record, not a
  // change made on this device: it starts as read, like the rest did.
  let added = false;
  for (const k of SYNC_KEYS) { if (!(k in seen)) { seen[k] = now[k] ?? null; added = true; } }
  if (added) writeJson(store, SEEN_KEY, seen);
  return seen;
}

/** The names whose value in storage is not what was last seen: changed here, not yet sent. */
export function pendingChanges(store: KV): string[] {
  const seen = ensureBaseline(store);
  const now = snapshot(store);
  return SYNC_KEYS.filter((k) => (now[k] ?? null) !== (seen[k] ?? null));
}

/** The document to send: the server's, with this device's changed values stamped `at`. */
export function mergeForPush(doc: SyncDoc | null, store: KV, keys: string[], at: number): SyncDoc {
  const next: SyncDoc = {};
  for (const [k, e] of Object.entries(doc || {})) {
    if (SYNC_KEYS.includes(k) && e && typeof e === 'object' && Number.isFinite(Number(e.at))) next[k] = { v: e.v === null || e.v === undefined ? null : String(e.v), at: Number(e.at) };
  }
  const now = snapshot(store);
  for (const k of keys) {
    // Never older than what is already there: a device whose clock runs behind
    // would otherwise send a change that every other device then ignores.
    const floor = next[k] ? next[k].at + 1 : 0;
    next[k] = { v: now[k] ?? null, at: Math.max(at, floor) };
  }
  return next;
}

/** After the document was accepted: those values are seen, and theirs is the time recorded. */
export function commitPushed(store: KV, keys: string[], sent: SyncDoc) {
  const seen = ensureBaseline(store);
  const at = readJson<Record<string, number>>(store, AT_KEY) || {};
  for (const k of keys) { if (sent[k]) { seen[k] = sent[k].v; at[k] = sent[k].at; } }
  writeJson(store, SEEN_KEY, seen);
  writeJson(store, AT_KEY, at);
}

/**
 * Takes from the server's document every value that is newer than this device's
 * record of it. Returns the names whose value in storage actually changed —
 * the ones a chart has to read again.
 */
export function applyRemote(store: KV, doc: SyncDoc | null): string[] {
  if (!doc || typeof doc !== 'object') return [];
  const seen = ensureBaseline(store);
  const at = readJson<Record<string, number>>(store, AT_KEY) || {};
  const now = snapshot(store);
  const changed: string[] = [];
  let touched = false;
  for (const k of SYNC_KEYS) {
    const e = doc[k];
    if (!e || typeof e !== 'object' || !Number.isFinite(Number(e.at))) continue;
    if (Number(e.at) <= (at[k] || 0)) continue;                      // nothing newer than what is known here
    if ((now[k] ?? null) !== (seen[k] ?? null)) continue;            // changed here and not yet sent: that is the newer one
    const v = e.v === null || e.v === undefined ? null : String(e.v);
    if ((now[k] ?? null) !== v) {
      try { if (v === null) store.removeItem(k); else store.setItem(k, v); } catch { continue; }
      changed.push(k);
    }
    seen[k] = v; at[k] = Number(e.at); touched = true;
  }
  if (touched) { writeJson(store, SEEN_KEY, seen); writeJson(store, AT_KEY, at); }
  return changed;
}

/**
 * The names of which this device holds a NEWER value than the server's
 * document does. There should be none: a value gets its time here only by
 * being sent or by being received. One appears when a send was lost — two
 * devices each read the document, each added its own change and each wrote the
 * whole document back, so the second one's write left the first one's change
 * out; the first device had been told "saved", and would never have sent it
 * again. Whoever still holds the newer value puts it back (see `mend` in
 * startIndicatorSync). A value changed here and not yet sent is not listed: the
 * ordinary send takes it, with a newer time.
 */
export function serverBehind(store: KV, doc: SyncDoc | null): string[] {
  const at = readJson<Record<string, number>>(store, AT_KEY) || {};
  const seen = ensureBaseline(store);
  const now = snapshot(store);
  return SYNC_KEYS.filter((k) => {
    const mine = Number(at[k] || 0), theirs = Number(doc && doc[k] && Number.isFinite(Number(doc[k].at)) ? doc[k].at : 0);
    return mine > theirs && (now[k] ?? null) === (seen[k] ?? null);
  });
}

/** The document with those values put back, each under the time this device has for it. Never lowers a time. */
export function mergeForMend(doc: SyncDoc | null, store: KV, keys: string[]): SyncDoc {
  const next = mergeForPush(doc, store, [], 0);        // the server's document, tidied, nothing added
  const at = readJson<Record<string, number>>(store, AT_KEY) || {};
  const now = snapshot(store);
  for (const k of keys) {
    const mine = Number(at[k] || 0);
    if (mine > (next[k] ? next[k].at : 0)) next[k] = { v: now[k] ?? null, at: mine };
  }
  return next;
}

/** The device whose set is the one to copy: his phone, which is an iPhone. */
export const isSeedDevice = (userAgent: string) => /iPhone/i.test(userAgent || '');

/**
 * The document that makes this device's set everyone's: every shared name as
 * it stands here (unset ones included, as unset), each stamped newer than what
 * the document holds for it.
 */
export function mergeForSeed(doc: SyncDoc | null, store: KV, at: number): SyncDoc {
  return mergeForPush(doc, store, [...SYNC_KEYS], at);
}

/**
 * Keeps what this device held for the names another device's whole set has
 * just changed. Once only: the first such set is the one that replaced what he
 * had built up here; a later one would be replacing the phone's.
 */
export function keepBefore(store: KV, before: Record<string, string | null>, changed: string[], at: number): boolean {
  if (changed.length < WHOLE_SET) return false;
  try { if (store.getItem(BEFORE_KEY) !== null) return false; } catch { return false; }
  const was: Record<string, string | null> = {};
  for (const k of changed) was[k] = before[k] ?? null;
  writeJson(store, BEFORE_KEY, { at, was });
  return true;
}

// ───────────────────────── the desktop's two halves ─────────────────────────
//
// THE INDEX CHART'S VALUES ARE THE PLAIN NAMES ABOVE, ON EVERY LAYOUT. That was
// not so on the desktop, and it is what the sharing stands on, so it is told
// here once.
// The desktop shows two charts side by side, and each keeps its own indicators
// (Martin, 19 Oct). Both saved their settings under the same plain names, so
// each half also kept a copy of its own ("paneIndicators:spot" / ":option") and
// put it back when it loaded — and its saving then wrote the copy over the
// plain names. Two things followed that the sharing cannot live with:
//   - A value that arrived from another device was written to the plain name,
//     the index half was built again, read it — and then put its own copy back
//     over it, which this device then SENT as a change of its own. The phone's
//     RSI, turned off, came back on. (Found by running two devices.)
//   - Where the halves differ in a setting, the plain name ended as one half's
//     value on one load and the other's on the next: the half that changed
//     nothing on load wrote nothing, so the other's write stood. Every load of
//     the desktop would have sent "a change".
// So now: the INDEX half keeps no copy — it is the plain names, the same chart
// as the phone's and the single chart's; and the OPTION half never writes the
// plain names it keeps in its own copy (AdvancedChart gives that half a
// `localStorage` of its own that leaves those names alone). The option half's
// switches were already under "opt:" names.

/** A setting whose name in a half's own copy is not its storage name. */
const HALF_COPY_NAME: Record<string, string> = {
  swapSweepMode: 'ssMode', showGiftDivergence: 'showGiftDiv', sessionBreaks: 'sessionBreak',
  instLevelsSettings: 'ilSettings', breakerSettings: 'blSettings',
};
const STORAGE_NAME: Record<string, string> = Object.fromEntries(Object.entries(HALF_COPY_NAME).map(([k, v]) => [v, k]));
/** The storage name of a value a half keeps in its own copy under `copyName`. */
export const halfCopyStorageName = (copyName: string): string => STORAGE_NAME[copyName] || copyName;
/** Where the index half's own copy was kept, before it stopped keeping one. */
export const SPOT_HALF_COPY = 'paneIndicators:spot';

/**
 * The index half's old copy, dealt with once: it is removed, and — only on a
 * device that is showing the two halves the first time this runs there — its
 * values are first written to the plain names, as the half's own loading did on
 * every load until now. So the desktop's index chart opens exactly as he left
 * it, whichever half's value a plain name happened to hold.
 * NOT on a device that has run the sharing before (the plain names are what it
 * has been sharing; an old copy found then is stale), and NOT while the single
 * chart is what is shown (a phone turned sideways once has a copy from that
 * day; putting it back would undo what he has set on the phone since).
 * Must run before the first baseline is taken, or what it writes would be sent
 * as changes made here: ChartWorkspace calls it as it is drawn, ahead of the
 * charts and of startIndicatorSync. Returns the names it wrote.
 */
export function adoptSpotHalfCopy(store: KV, halvesShown: boolean): string[] {
  let raw: string | null = null;
  try { raw = store.getItem(SPOT_HALF_COPY); } catch { return []; }
  if (raw === null) return [];
  const wrote: string[] = [];
  let firstRun = false;
  try { firstRun = store.getItem(SEEN_KEY) === null; } catch { firstRun = false; }
  if (firstRun && halvesShown) {
    let copy: Record<string, unknown> | null = null;
    try { const v = JSON.parse(raw); copy = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { copy = null; }
    for (const k of copy ? SYNC_KEYS : []) {
      const name = HALF_COPY_NAME[k] || k;
      if (!copy || !(name in copy)) continue;
      const v = copy[name];
      if (v === null || v === undefined) continue;
      // As the chart saves each of them: text as it is, a list or an object as
      // JSON, a number or a yes / no as its text.
      const text = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
      try { if (store.getItem(k) !== text) { store.setItem(k, text); wrote.push(k); } } catch { /* storage full or closed */ }
    }
  }
  try { store.removeItem(SPOT_HALF_COPY); } catch { /* closed */ }
  return wrote;
}

// ───────────────────────── the part that needs a browser ─────────────────────────

const PUSH_EVERY_MS = 2000;
const PULL_EVERY_MS = 20000;

// "Read your storage again": a number a chart is keyed by. A chart reads its
// switches and settings once, as it is put on the page, so the way to have it
// read them again is to put it on the page again — the same thing that happens
// when he goes to Home and comes back. (Telling each of some eighty pieces of
// state its new value one by one would have been a second list to keep right.)
let epoch = 0;
const listeners = new Set<() => void>();
export const indicatorEpoch = () => epoch;
export const onIndicatorEpoch = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const bump = () => { epoch += 1; listeners.forEach((f) => { try { f(); } catch { /* a listener's own problem */ } }); };

// A chart with a sheet open, a list down or a drawing half made says so here,
// and is not put on the page again until it is done.
const busyCharts = new Set<string>();
export const setChartBusy = (id: string, on: boolean) => { if (on) busyCharts.add(id); else busyCharts.delete(id); };
export const anyChartBusy = () => busyCharts.size > 0;

// Whether this page has yet to ask the server if the phone's set has been sent (see seedOnce).
let seed: 'ask' | 'busy' | 'done' = 'ask';

async function readDoc(fresh: boolean): Promise<SyncDoc | null> {
  // `fresh` goes round the app's five-second cache of settings reads: a document
  // about to be merged into and sent back must be the one the server has now.
  const r = await fetch(`/api/settings/${SYNC_SETTING}${fresh ? `?_=${Date.now()}` : ''}`);
  if (!r.ok) throw new Error('settings read failed');
  const j = await r.json();
  return j && j.value && typeof j.value === 'object' ? j.value as SyncDoc : null;
}

/**
 * Starts the sharing for as long as the chart page is up. `idle` says whether
 * this is a moment the chart may be put on the page again (no finger on it, no
 * sheet open); a change that arrives while it is not waits for one. Returns the
 * function that stops it.
 */
export function startIndicatorSync(idle: () => boolean): () => void {
  if (typeof window === 'undefined') return () => {};
  const store: KV = window.localStorage;
  let stopped = false, busy = false, waiting = false;
  // Whether the sharing is switched off on the server (SYNC_OFF_SETTING). Not
  // known until it has been read once, and nothing is sent before it is known.
  let off: boolean | null = null;
  const readOff = async () => {
    try {
      const r = await fetch(`/api/settings/${SYNC_OFF_SETTING}`);
      if (r.ok) { const j = await r.json(); off = !!(j && j.value === true); }
    } catch { /* offline: as it was */ }
  };
  ensureBaseline(store);
  // Whatever is taken from the server goes through here, so that a whole set
  // arriving is noticed and what it replaces is kept (keepBefore).
  const take = (doc: SyncDoc | null): string[] => {
    const before = snapshot(store);
    const got = applyRemote(store, doc);
    if (got.length) keepBefore(store, before, got, Date.now());
    return got;
  };
  // THE PHONE'S SET, ONCE (see the top of this file). Asked on each pull until
  // the server has answered once; a phone that finds the mark already there
  // does nothing, now or later. `seed` is the page's, not this run's: the
  // sharing is started afresh whenever the chart page is, and two runs must
  // not both find the mark missing and both send.
  const seedOnce = async () => {
    if (seed !== 'ask' || off !== false || !isSeedDevice(window.navigator.userAgent)) return;
    seed = 'busy';
    let done = false;
    try {
      const r = await fetch(`/api/settings/${SYNC_SEED_SETTING}?_=${Date.now()}`);
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.value) { done = true; return; }
      const doc = await readDoc(true);
      // What another device changed since the sharing began is his choice too,
      // and is already on its way here: taken first, so the set sent includes it.
      if (take(doc).length) waiting = true;
      const keys = [...SYNC_KEYS];
      const next = mergeForSeed(doc, store, Date.now());
      const w = await fetch(`/api/settings/${SYNC_SETTING}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: next }) });
      if (!w.ok) return;                                 // asked again on the next pull
      commitPushed(store, keys, next);
      const m = await fetch(`/api/settings/${SYNC_SEED_SETTING}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: { at: Date.now(), names: keys.length } }) });
      // The mark not saved: the set is sent again next time, which changes nothing anywhere.
      done = m.ok;
    } finally { seed = done ? 'done' : 'ask'; }
  };

  const push = async () => {
    if (stopped || busy || off !== false) return;
    let keys: string[] = [];
    try { keys = pendingChanges(store); } catch { return; }
    if (!keys.length) return;
    busy = true;
    try {
      const doc = await readDoc(true);
      // Something newer may have arrived for other names: take it before sending.
      const got = take(doc);
      if (got.length) waiting = true;
      const next = mergeForPush(doc, store, keys, Date.now());
      const r = await fetch(`/api/settings/${SYNC_SETTING}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: next }) });
      if (r.ok) commitPushed(store, keys, next);          // not accepted: left as a change, and tried again in two seconds
    } catch { /* offline: tried again */ } finally { busy = false; }
  };
  const pull = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      await readOff();
      if (off !== false) return;
      const doc = await readDoc(false);
      if (take(doc).length) waiting = true;
      // A send of this device's that another device's send wrote over: put back.
      // Looked for again in the document as the server has it NOW before
      // anything is written — the one just read may be the app's five-second-old
      // copy, from before this device's own last send.
      if (serverBehind(store, doc).length) await mend();
      await seedOnce();
    } catch { /* offline: tried again */ } finally { busy = false; }
  };
  const mend = async () => {
    const doc = await readDoc(true);
    if (take(doc).length) waiting = true;
    const keys = serverBehind(store, doc);
    if (!keys.length) return;
    await fetch(`/api/settings/${SYNC_SETTING}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: mergeForMend(doc, store, keys) }) });
  };
  const settle = () => { if (!stopped && off === false && waiting && idle()) { waiting = false; bump(); } };

  const pushIv = window.setInterval(() => { push(); settle(); }, PUSH_EVERY_MS);
  const pullIv = window.setInterval(pull, PULL_EVERY_MS);
  const onFront = () => { if (!document.hidden) pull(); };
  document.addEventListener('visibilitychange', onFront);
  window.addEventListener('focus', onFront);
  pull();
  return () => {
    stopped = true;
    window.clearInterval(pushIv); window.clearInterval(pullIv);
    document.removeEventListener('visibilitychange', onFront);
    window.removeEventListener('focus', onFront);
  };
}
