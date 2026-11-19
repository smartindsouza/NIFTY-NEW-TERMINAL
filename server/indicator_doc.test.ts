// npx tsx server/indicator_doc.test.ts
import assert from 'node:assert/strict';
import { guardIndicatorDoc, withHistory, REPLACE_LIMIT, type Doc } from './indicator_doc';

const names = Array.from({ length: 75 }, (_, i) => `n${i}`);
const his: Doc = {}; for (const k of names) his[k] = { v: `his:${k}`, at: 1000 };

// 5:14 PM: every value replaced by a default in one send -> refused whole, his set stays
{
  const inc: Doc = {}; for (const k of names) inc[k] = { v: `default:${k}`, at: 5000 };
  const r = guardIndicatorDoc(his, inc, false);
  assert.equal(r.refused, true); assert.equal(r.replaced, 75); assert.deepEqual(r.doc, his);
}
// 5:40 PM: every value unset in one send -> each unset dropped, his set stays (not even "refused": nothing was replaced)
{
  const inc: Doc = {}; for (const k of names) inc[k] = { v: null, at: 6000 };
  const r = guardIndicatorDoc(his, inc, false);
  assert.equal(r.refused, false); assert.equal(r.unsetDropped, 75); assert.deepEqual(r.doc, his);
}
// one switch changed: accepted, the rest untouched
{
  const inc: Doc = { ...his, n3: { v: 'false', at: 7000 } };
  const r = guardIndicatorDoc(his, inc, false);
  assert.equal(r.refused, false); assert.equal(r.replaced, 1); assert.equal(r.doc.n3.v, 'false'); assert.equal(r.doc.n4.v, 'his:n4');
}
// 19 changed at once is still a person (a sheet's Ok); 20 is not
{
  const mk = (n: number) => { const inc: Doc = { ...his }; for (let i = 0; i < n; i++) inc[`n${i}`] = { v: 'x', at: 8000 }; return inc; };
  assert.equal(guardIndicatorDoc(his, mk(REPLACE_LIMIT - 1), false).refused, false);
  assert.equal(guardIndicatorDoc(his, mk(REPLACE_LIMIT), false).refused, true);
  // the deliberate whole set goes through
  const s = guardIndicatorDoc(his, mk(75), true);
  assert.equal(s.refused, false); assert.equal(s.doc.n70.v, 'x');
}
// a name left out of the send is kept; a name with no value is filled in without counting as replaced
{
  const empty: Doc = {}; for (const k of names) empty[k] = { v: null, at: 6000 };
  const inc: Doc = {}; for (const k of names.slice(0, 60)) inc[k] = { v: `phone:${k}`, at: 9000 };
  const r = guardIndicatorDoc(empty, inc, false);
  assert.equal(r.refused, false); assert.equal(r.replaced, 0); assert.equal(r.doc.n0.v, 'phone:n0'); assert.equal(r.doc.n70.v, null);
  const r2 = guardIndicatorDoc(his, { n1: { v: 'a', at: 9000 } }, false);
  assert.equal(Object.keys(r2.doc).length, 75); assert.equal(r2.doc.n1.v, 'a');
}
// the same value sent again with a newer time is taken as the newer time; junk is ignored
{
  const r = guardIndicatorDoc(his, { n1: { v: 'his:n1', at: 9999 }, bad: 5 as any, worse: { v: 'x' } as any }, false);
  assert.equal(r.doc.n1.at, 9999); assert.equal(r.replaced, 0); assert.ok(!('bad' in r.doc)); assert.ok(!('worse' in r.doc));
  assert.deepEqual(guardIndicatorDoc(his, 'nonsense', false).doc, his);
}
// history: kept at most once in ten minutes, always when forced, never an all-unset document, thirty deep
{
  assert.equal(withHistory([], his, 1e6, false)!.length, 1);
  assert.equal(withHistory([{ at: 1e6, doc: his }], his, 1e6 + 5 * 60000, false), null);
  assert.equal(withHistory([{ at: 1e6, doc: his }], his, 1e6 + 5 * 60000, true)!.length, 2);
  assert.equal(withHistory([{ at: 1e6, doc: his }], his, 1e6 + 11 * 60000, false)!.length, 2);
  const empty: Doc = { a: { v: null, at: 1 } };
  assert.equal(withHistory([], empty, 1e6, true), null);
  const many = Array.from({ length: 40 }, (_, i) => ({ at: i, doc: his }));
  assert.equal(withHistory(many, his, 1e9, true)!.length, 30);
}
console.log('indicator_doc: all checks passed');
