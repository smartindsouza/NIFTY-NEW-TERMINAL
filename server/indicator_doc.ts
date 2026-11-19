// THE SHARED INDICATOR SETTINGS ARE GUARDED WHERE THEY ARE KEPT (19 Nov 2026).
// Twice in one evening Martin's shared indicator settings (the document the
// devices share, app_settings 'chart_indicators') were replaced whole by one
// send from his iPhone: at 5:14 PM with the app's defaults ("My app settings
// somehow got reset to how it was couple of months ago"), and at 5:40 PM, as
// he reopened the app, with every one of 74 values UNSET ("it had only 4 out
// all the indicators on. I had to add the remaining again"). Both times the
// phone's storage did not hold his values as the page started, and the page
// sent what it found. The rule that stops it was first put in the page
// (v410) — but a page already open, or one the phone serves from its cache,
// runs the code it has: the 5:40 send was made that way. So the rule is here
// too, at the one door every device's send comes through:
//   - UNSET NEVER REPLACES A VALUE. An incoming "unset" for a name that has a
//     value is dropped; the value stays.
//   - A SEND THAT WOULD REPLACE 20 VALUES OR MORE AT ONCE IS REFUSED WHOLE,
//     unless it says it is the deliberate one (a phone's whole set, sent once:
//     header X-Indicator-Seed). Filling in names that have no value is not
//     replacing, and is not counted.
//   - A name the incoming document leaves out is kept.
//   - Before a send is accepted the document as it was is kept, at most once
//     in ten minutes and always before a deliberate whole set, thirty deep
//     ('chart_indicators_hist') — so that what was there can be put back.
// Pure, so it is tested without a server (indicator_doc.test.ts).
export type Entry = { v: string | null; at: number };
export type Doc = Record<string, Entry>;
export const REPLACE_LIMIT = 20;

const tidy = (x: any): Doc => {
  const out: Doc = {};
  if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
  for (const [k, e] of Object.entries(x as Record<string, any>)) {
    if (!e || typeof e !== 'object' || !Number.isFinite(Number(e.at))) continue;
    out[k] = { v: e.v === null || e.v === undefined ? null : String(e.v), at: Number(e.at) };
  }
  return out;
};

export function guardIndicatorDoc(currentRaw: any, incomingRaw: any, seed: boolean):
  { doc: Doc; refused: boolean; replaced: number; unsetDropped: number } {
  const current = tidy(currentRaw), incoming = tidy(incomingRaw);
  const next: Doc = { ...current };
  let replaced = 0, unsetDropped = 0;
  for (const [k, e] of Object.entries(incoming)) {
    const cur = current[k];
    if (e.v === null) { if (cur && cur.v !== null) { unsetDropped++; continue; } if (!cur) next[k] = e; continue; }
    if (cur && cur.v !== null && cur.v !== e.v) replaced++;
    if (!cur || cur.v !== e.v || e.at > cur.at) next[k] = e;
  }
  if (replaced >= REPLACE_LIMIT && !seed) return { doc: current, refused: true, replaced, unsetDropped };
  return { doc: next, refused: false, replaced, unsetDropped };
}

/** The history with the document as it was added in front, if one is due. */
export function withHistory(histRaw: any, current: Doc, now: number, force: boolean): { at: number; doc: Doc }[] | null {
  const hist: { at: number; doc: Doc }[] = Array.isArray(histRaw) ? histRaw.filter((h: any) => h && Number.isFinite(Number(h.at)) && h.doc) : [];
  if (!Object.values(current).some((e) => e.v !== null)) return null;          // nothing worth keeping
  if (!force && hist.length && now - hist[0].at < 10 * 60000) return null;
  return [{ at: now, doc: current }, ...hist].slice(0, 30);
}
