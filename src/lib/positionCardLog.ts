// WHO PUT THE TRADE BACK (19 Nov 2026). Martin, minutes after version 402, which
// was meant to clear a sold trade from the chart: "It was showing me this again
// and again after updating to 402." The server's log agrees — his phone asked to
// arm a stop for the closed SENSEX trade every four seconds — which means the
// saved copy of his open trades was being cleared and then written back, over
// and over, and nothing run here (a phone-sized page against an imitation
// broker, the same leftover saved) would do it. So the phone now says so itself:
// each time a real trade appears in the saved copy that was not there before, or
// the copy is emptied, one short line goes to the server's log — which trade,
// its entry, the time on its card, and where in the code the write came from.
// Nothing is changed by this: the write goes through exactly as it was asked.
// At most one line every two seconds and sixty in a session.
declare const __APP_VERSION__: string;
let sent = 0, lastAt = 0;
export function initPositionCardLog() {
  try {
    const proto = Storage.prototype as any;
    if (proto.__cardLog) return;
    proto.__cardLog = true;
    const orig = proto.setItem;
    proto.setItem = function (k: string, v: string) {
      if (k === 'active_positions' && this === window.localStorage) {
        try {
          const list = (s: string | null) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a.filter((c: any) => c && !c.testMode) : []; } catch (e) { return []; } };
          const was = list(window.localStorage.getItem(k)), now = list(v);
          const key = (c: any) => `${c.id}|${c.symbol}|${c.entryPrice}|${c.timestamp}`;
          const had = new Set(was.map(key));
          const added = now.filter((c: any) => !had.has(key(c)));
          const what = added.length ? 'added' : (was.length && !now.length ? 'cleared' : '');
          const t = Date.now();
          if (what && sent < 60 && t - lastAt > 2000) {
            sent++; lastAt = t;
            const c = added[0] || was[0];
            const ageS = Math.round((t - new Date(c.timestamp).getTime()) / 1000);
            const stack = String(new Error().stack || '').split('\n').slice(2, 6).map((l) => l.trim().replace(/https?:\/\/[^/]+/g, '')).join(' < ').slice(0, 420);
            let version = ''; try { version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''; } catch (e) {}
            void fetch('/api/diag/card-note', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ what, symbol: c.symbol, id: String(c.id), entry: c.entryPrice, cardAgeS: ageS, cards: now.length, stack, version }) }).catch(() => {});
          }
        } catch (e) { /* the note is lost; the write below is not */ }
      }
      return orig.apply(this, arguments as any);
    };
  } catch (e) { /* no note-taking on this browser */ }
}
