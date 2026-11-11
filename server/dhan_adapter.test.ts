// Dhan stand-in: symbols, tokens, packets. Run: npx tsx server/dhan_adapter.test.ts [path to Dhan detailed scrip master CSV]
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { kiteSymbol, encodeToken, decodeToken, buildRows, SEG } from './dhan_kite_adapter';
import { parsePackets } from './dhan_ticker';

// Kite symbol format — checked against real symbols from Martin's Zerodha journal
assert.equal(kiteSymbol('NIFTY', '2026-11-17', 25400, 'CE', false), 'NIFTY26N1725400CE');   // journal: NIFTY26N1725400CE
assert.equal(kiteSymbol('NIFTY', '2026-11-23', 25300, 'PE', true), 'NIFTY26NOV25300PE');
assert.equal(kiteSymbol('NIFTY', '2026-12-01', 25000, 'CE', false), 'NIFTY26D0125000CE');
assert.equal(kiteSymbol('NIFTY', '2027-01-06', 25000, 'PE', false), 'NIFTY2710625000PE');
assert.equal(kiteSymbol('NIFTY', '2026-11-23', 0, 'FUT', true), 'NIFTY26NOVFUT');
assert.equal(kiteSymbol('SENSEX', '2026-11-26', 75200, 'CE', false), 'SENSEX26N2675200CE');
// tokens
assert.deepEqual(decodeToken(256265), { seg: 0, id: 13 });
assert.deepEqual(decodeToken(260105), { seg: 0, id: 25 });
assert.deepEqual(decodeToken(encodeToken(SEG.NSE_FNO, 35028)), { seg: 2, id: 35028 });
assert.equal(decodeToken(12345678), null, 'an old Zerodha token is not mistaken for a Dhan one');
assert.ok(encodeToken(SEG.IDX_I, 1) > 30_000_000, 'Dhan tokens sit above every Zerodha token');
// packets (little-endian): Quote for NIFTY index, Full for an option, prev close, OI
const quote = Buffer.alloc(50); quote.writeUInt8(4, 0); quote.writeInt16LE(50, 1); quote.writeUInt8(0, 3); quote.writeInt32LE(13, 4);
quote.writeFloatLE(25255.05, 8); quote.writeInt32LE(1794394800, 14); quote.writeInt32LE(0, 22); quote.writeFloatLE(25100, 34); quote.writeFloatLE(25300, 42); quote.writeFloatLE(25050, 46);
const prev = Buffer.alloc(16); prev.writeUInt8(6, 0); prev.writeUInt8(0, 3); prev.writeInt32LE(13, 4); prev.writeFloatLE(25045.5, 8);
const full = Buffer.alloc(162); full.writeUInt8(8, 0); full.writeUInt8(2, 3); full.writeInt32LE(35028, 4); full.writeFloatLE(142.35, 8); full.writeInt32LE(98765, 22); full.writeInt32LE(1234500, 34);
const pk = parsePackets(Buffer.concat([prev, quote, full]));
assert.equal(pk.length, 3);
assert.equal(pk[0].prevClose.toFixed(1), '25045.5');
assert.equal(pk[1].id, 13); assert.equal(Math.round(pk[1].ltp * 100) / 100, 25255.05); assert.equal(pk[1].high, 25300);
assert.equal(pk[2].seg, 2); assert.equal(pk[2].oi, 1234500); assert.equal(pk[2].volume, 98765);
console.log('dhan adapter: symbols, tokens, packets ok');

const f = process.argv[2] || '/tmp/claude-0/dhan/master.csv';
if (existsSync(f)) {
  const rows = buildRows(readFileSync(f, 'utf8'));
  const n = rows.find((r: any) => r.instrument_token === 256265); assert.equal(n.tradingsymbol, 'NIFTY 50'); assert.equal(n.exchange, 'NSE');
  assert.equal(rows.find((r: any) => r.instrument_token === 260105).tradingsymbol, 'NIFTY BANK');
  assert.equal(rows.find((r: any) => r.instrument_token === 265).exchange, 'BSE');
  const opt = rows.filter((r: any) => r.exchange === 'NFO' && r.name === 'NIFTY' && r.instrument_type === 'CE');
  const futs = rows.filter((r: any) => r.exchange === 'NFO' && r.name === 'NIFTY' && r.instrument_type === 'FUT').map((r: any) => r.tradingsymbol);
  const keys = new Set(rows.map((r: any) => `${r.exchange}:${r.tradingsymbol}`));
  console.log('rows', rows.length, '| unique exch:symbol', keys.size, '| NIFTY CE', opt.length, '| futs', futs, '| sample', opt.slice(0, 2).map((r: any) => [r.tradingsymbol, r.lot_size, r.tick_size, r.strike]));
  console.log('MCX', rows.filter((r: any) => r.exchange === 'MCX' && ['GOLD', 'SILVER', 'CRUDEOIL'].includes(r.name)).slice(0, 4).map((r: any) => r.tradingsymbol));
  const dupes = rows.length - keys.size; console.log('duplicate exch:symbol keys', dupes);
  assert.ok(opt.some((r: any) => r.tradingsymbol === 'NIFTY26N1725400CE'), 'the journal symbol exists in Dhan form');
}
