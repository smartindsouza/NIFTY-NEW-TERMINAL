// Parser + ladder tests. Pure, no network.   npx tsx server/signal_parser.test.ts
import assert from 'node:assert/strict';
import { parseSignalMessage, validateSetup } from './signal_parser';
import { createLadder, onLadderPrice, keepTrailing } from './signal_ladder';

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log('ok', name); };

// ---- the two messages exactly as the channel posts them (screenshot 23 Oct) ----
const CALL = `🟢 BUY NIFTY 22650 CE\n💰 Entry : ₹145 - ₹149\n📊 Intraday Trade ⭐ ⭐`;
const LEVELS = `🎯 TP 1: ₹164\n🎯 TP 2: ₹179\n🎯 TP 3: ₹199\n🛑 Stop Loss: ₹130\n📝 Rationale: Retest\n⏳ Valid for: Intraday Only\n⚠️ Terms, Conditions, Disclaimer: Read everything here to avoid any future conflict.`;

ok('call message', () => {
  const p = parseSignalMessage(CALL);
  assert.equal(p?.kind, 'CALL');
  if (p?.kind !== 'CALL') return;
  assert.deepEqual(p.call, { underlying: 'NIFTY', strike: 22650, optionType: 'CE', entryLow: 145, entryHigh: 149 });
  assert.equal(p.levels, null);
});
ok('levels message', () => {
  const p = parseSignalMessage(LEVELS);
  assert.deepEqual(p, { kind: 'LEVELS', levels: { tps: [164, 179, 199], sl: 130 } });
});
ok('both in one message', () => {
  const p = parseSignalMessage(CALL + '\n' + LEVELS);
  assert.equal(p?.kind, 'CALL');
  if (p?.kind === 'CALL') assert.deepEqual(p.levels, { tps: [164, 179, 199], sl: 130 });
});
ok('sensex PE with en-dash, decimals and no rupee sign', () => {
  const p = parseSignalMessage('BUY SENSEX 81500 PE\nEntry: 210.5 – 216');
  assert.equal(p?.kind, 'CALL');
  if (p?.kind === 'CALL') assert.deepEqual(p.call, { underlying: 'SENSEX', strike: 81500, optionType: 'PE', entryLow: 210.5, entryHigh: 216 });
});
ok('BANKNIFTY / FINNIFTY are not NIFTY', () => {
  assert.equal(parseSignalMessage('BUY BANKNIFTY 52000 CE\nEntry : ₹300 - ₹305'), null);
  assert.equal(parseSignalMessage('BUY FINNIFTY 24000 CE\nEntry : ₹100 - ₹105'), null);
});
ok('other messages are ignored', () => {
  for (const m of ['Good morning traders 🌞', 'TP 1 done ✅ 164 hit', 'Book profits now!', 'SL hit ❌',
    'Join VIP for ₹999', 'NIFTY looking bullish above 22600', 'SELL NIFTY 22650 CE Entry 145-149', '']) {
    assert.equal(parseSignalMessage(m), null, m);
  }
});
ok('validate the screenshot setup', () => {
  const c = parseSignalMessage(CALL), l = parseSignalMessage(LEVELS);
  if (c?.kind !== 'CALL' || l?.kind !== 'LEVELS') throw new Error('parse');
  assert.equal(validateSetup(c.call, l.levels), null);
});
ok('validate rejects nonsense', () => {
  const call = { underlying: 'NIFTY' as const, strike: 22650, optionType: 'CE' as const, entryLow: 145, entryHigh: 149 };
  assert.match(validateSetup(call, { tps: [164, 179, 199], sl: 150 })!, /not below/);
  assert.match(validateSetup(call, { tps: [148, 179, 199], sl: 130 })!, /TP1/);
  assert.match(validateSetup(call, { tps: [164, 160, 199], sl: 130 })!, /rising/);
});

// ---- ladder ----
ok('ladder: TP1 → entry, TP2 → TP1, TP3 → TP2 + trailing on by itself', () => {
  const st = createLadder(147.5, 130, [164, 179, 199]);
  assert.deepEqual(onLadderPrice(st, 150), []);
  assert.deepEqual(onLadderPrice(st, 164), [{ type: 'SET_SL', sl: 147.5, reason: 'TP1 hit — SL to entry' }]);
  assert.deepEqual(onLadderPrice(st, 170), []);
  assert.deepEqual(onLadderPrice(st, 179.05), [{ type: 'SET_SL', sl: 164, reason: 'TP2 hit — SL to TP1' }]);
  const a = onLadderPrice(st, 199);
  assert.deepEqual(a, [{ type: 'SET_SL', sl: 179, reason: 'TP3 hit — SL to TP2' }, { type: 'TP3_TRAILING' }]);
  assert.equal(st.decision, 'KEEP');
  // nobody taps anything: the SL still trails in steps of 20 (219 → 199, 239 → 219)
  assert.deepEqual(onLadderPrice(st, 218), []);
  assert.deepEqual(onLadderPrice(st, 219).map(x => x.type === 'SET_SL' && x.sl), [199]);
  assert.deepEqual(onLadderPrice(st, 260).map(x => x.type === 'SET_SL' && x.sl), [219, 239]);
  assert.deepEqual(onLadderPrice(st, 200), []);          // never lowers
  assert.equal(st.sl, 239);
});
ok('ladder: gap through all three targets in one tick', () => {
  const st = createLadder(147, 130, [164, 179, 199]);
  const a = onLadderPrice(st, 205);
  assert.deepEqual(a.map(x => x.type === 'SET_SL' ? x.sl : x.type), [147, 164, 179, 'TP3_TRAILING']);
});
ok('ladder: gap straight past TP3 and the first step trails at once', () => {
  const st = createLadder(147, 130, [164, 179, 199]);
  assert.deepEqual(onLadderPrice(st, 241).map(x => x.type === 'SET_SL' ? x.sl : x.type), [147, 164, 179, 'TP3_TRAILING', 199, 219]);
});
ok('ladder: an old Keep press changes nothing', () => {
  const st = createLadder(147, 130, [164, 179, 199]);
  onLadderPrice(st, 230);
  assert.deepEqual(keepTrailing(st), []);
  assert.equal(st.sl, 199);
});
ok('ladder: a trade saved mid-question (PENDING, before this change) starts trailing on its next tick', () => {
  const st = createLadder(147, 130, [164, 179, 199]);
  onLadderPrice(st, 205); st.decision = 'PENDING';     // exactly as the old version stored it
  assert.equal(st.stage, 3);
  assert.deepEqual(onLadderPrice(st, 221).map(x => x.type === 'SET_SL' && x.sl), [199]);
  assert.equal(st.decision, 'KEEP');
});
ok('ladder: entry above TP1 never lowers the SL', () => {
  const st = createLadder(150, 140, [149.5, 160, 170]);   // pathological, but SL must not drop
  onLadderPrice(st, 150);
  assert.ok(st.sl >= 140);
});

console.log(`\n${n} passed`);
