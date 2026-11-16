import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { AdvancedChart } from './AdvancedChart';
import { useBiasCardHidden } from '../lib/bias';

/**
 * Desktop chart workspace: spot on the LEFT, option charts on the RIGHT.
 *
 * MOBILE IS DELIBERATELY UNTOUCHED. Below the md breakpoint this renders
 * <AdvancedChart /> with NO props, which is the exact component and code path
 * that shipped before the split existed — every pane-specific branch inside
 * AdvancedChart is gated on a paneRole that mobile never passes. That is the
 * whole reason the role is a prop rather than a global or a media query read
 * inside the chart itself.
 *
 * The right pane is only MOUNTED once an option is actually open. An empty half
 * would otherwise run a second copy of ~14 queries and a second chart instance
 * for nothing, and the terminal has already had one round of trouble with
 * duplicate polling. No option => the spot pane simply occupies the full width.
 *
 * Panes talk through two window events rather than shared state, so neither pane
 * needs a reference to the other and the plain single-chart path keeps working
 * with no coordinator present:
 *   terminal:open-option  — spot pane re-routing a contract it refuses to show
 *                           (a trade being taken, a search result, a signal).
 *   terminal:options-empty — option pane reporting its last tab was closed.
 */

const DESKTOP_QUERY = '(min-width: 768px)';   // matches Tailwind's md, which the rest of the page uses

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(DESKTOP_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    // addEventListener is unavailable on older Safari's MediaQueryList.
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange as any);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange as any);
    };
  }, []);
  return isDesktop;
}

/** Is there an option chart to show? Seeded from the session so a reload lands
 *  back in the split rather than collapsing and losing the layout. */
function initialHasOption(): boolean {
  try {
    const tabs = sessionStorage.getItem('openOptionCharts');
    if (tabs) {
      const parsed = JSON.parse(tabs);
      if (Array.isArray(parsed) && parsed.length > 0) return true;
    }
    if (sessionStorage.getItem('selectedInstrument')) return true;
  } catch (e) {}
  return false;
}

/**
 * THE SCALPPRO SCREEN (phone, 16 Nov 2026). Martin, with recordings of Lemonn's:
 * the spot chart on top, the option chart under it, a handle between the two,
 * and a bar at the bottom that buys or sells the option on one tap. It opens
 * from the ScalpPro button on the chart page ("When I tap on scalping pro
 * button as shown in the video") and its back arrow returns there.
 *
 * It is the desktop split turned on its side: the same two panes — 'spot' and
 * 'option' — one above the other, each told it is on this screen (`scalp`), which
 * strips the chart page's own header, tool bar and RSI pane from it and gives
 * the option pane the Buy / Sell bar. Everything about a chart that matters —
 * his indicators, an open trade's entry line and its SL and TP chips — is that
 * component's, unchanged.
 */
const isOptionLike = (i: any) => !!i && /\d(CE|PE)$/.test(String(i.tradingsymbol || '').toUpperCase());

function ScalpScreen({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // How much of the height the spot chart has. Kept on this phone.
  const [frac, setFrac] = useState<number>(() => {
    try { const v = parseFloat(localStorage.getItem('scalpSplit') || ''); return v >= 0.05 && v <= 0.95 ? v : 0.5; } catch (e) { return 0.5; }
  });
  const fracRef = useRef(frac);
  fracRef.current = frac;

  // THE SCREEN ENDS WHERE THE BOTTOM BAR BEGINS, wherever it starts. Its top is
  // not a constant: the positions banner sits above it whenever a trade is on,
  // and comes and goes. So the top is measured — on mount, on a resize, and
  // twice a second as a net — and the height is what is left above the bar.
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const el = rootRef.current;
      if (!el) return;
      const t = Math.max(0, Math.round(el.getBoundingClientRect().top));
      setTop((prev) => (prev === t ? prev : t));
    };
    fit();
    const iv = setInterval(fit, 500);
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    return () => { clearInterval(iv); window.removeEventListener('resize', fit); window.removeEventListener('orientationchange', fit); };
  }, []);

  // AN OPTION TO SHOW. The lower chart takes the option that was last on screen
  // in this session. With none, it opens the at-the-money Call of the nearest
  // expiry — from the app's own option chain, handed over exactly as the spot
  // chart hands an option to the option chart (written to the session first,
  // then announced; see openOptionChart in AdvancedChart).
  useEffect(() => {
    let has = false;
    try {
      const sel = JSON.parse(sessionStorage.getItem('selectedInstrument') || 'null');
      const tabs = JSON.parse(sessionStorage.getItem('openOptionCharts') || '[]');
      has = isOptionLike(sel) || (Array.isArray(tabs) && tabs.some(isOptionLike));
    } catch (e) {}
    if (has) return;
    let dead = false;
    fetch('/api/option-chain').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (dead || !d) return;
      const strikes: number[] = Array.isArray(d.strikes) ? d.strikes : [];
      const spot = Number(d.spot);
      if (!strikes.length || !(spot > 0)) return;
      const atm = strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), strikes[0]);
      const c = d.ceData?.[atm];
      if (!c?.tradingsymbol || !c?.instrument_token) return;
      const instr = { tradingsymbol: c.tradingsymbol, instrument_token: String(c.instrument_token), exchange: c.exchange || 'NFO', lot_size: c.lot_size, instrument_type: 'CE', strike: atm, expiry: c.expiry };
      try { sessionStorage.setItem('selectedInstrument', JSON.stringify(instr)); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('terminal:open-option', { detail: instr })); } catch (e) {}
    }).catch(() => {});
    return () => { dead = true; };
  }, []);

  // THE HANDLE. Dragged, it moves the line between the charts; dragged all the
  // way it leaves one chart its two lines of name and price and gives the other
  // the screen — that is how Lemonn makes a chart "full screen" here.
  const startDrag = (e: React.PointerEvent) => {
    const body = bodyRef.current;
    if (!body) return;
    e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch (err) {}
    const move = (ev: PointerEvent) => {
      const r = body.getBoundingClientRect();
      if (!(r.height > 0)) return;
      setFrac(Math.min(0.95, Math.max(0.05, (ev.clientY - r.top) / r.height)));
    };
    const end = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      try { localStorage.setItem('scalpSplit', String(Math.round(fracRef.current * 1000) / 1000)); } catch (err) {}
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  };

  return (
    <div ref={rootRef} data-scalp-screen="" className="flex flex-col w-full min-h-0 bg-background"
      style={{ height: top === null ? '70dvh' : `calc(100dvh - ${top}px - 4rem - env(safe-area-inset-bottom))` }}>
      <div className="shrink-0 flex items-center gap-1 h-10 px-1 border-b border-white/10">
        <button type="button" data-scalp="back" aria-label="Back" onClick={onClose}
          className="h-9 w-9 flex items-center justify-center rounded-full text-foreground/90 active:bg-foreground/10">
          <ArrowLeft size={20} />
        </button>
        <span className="text-[13px] font-semibold text-foreground">ScalpPro</span>
      </div>
      <div ref={bodyRef} className="flex flex-col flex-1 min-h-0">
        {/* Neither pane is ever squeezed below what it must keep: its two lines
            of name and price (46px), and for the option pane the Buy / Sell bar
            under them as well — dragged all the way down, the handle stops there. */}
        <div data-scalp-pane="spot" className="overflow-hidden" style={{ flex: `${frac} 1 0%`, minHeight: 46 }}>
          <AdvancedChart key="scalp-spot" paneRole="spot" split scalp />
        </div>
        <div data-scalp="handle" onPointerDown={startDrag} title="Drag to resize the charts"
          className="shrink-0 h-4 flex items-center justify-center cursor-row-resize select-none bg-background border-y border-white/10 active:bg-white/10"
          style={{ touchAction: 'none' }}>
          <div className="w-10 h-1 rounded-full bg-foreground/30" />
        </div>
        <div data-scalp-pane="option" className="overflow-hidden" style={{ flex: `${1 - frac} 1 0%`, minHeight: 126 }}>
          <AdvancedChart key="scalp-option" paneRole="option" split scalp />
        </div>
      </div>
    </div>
  );
}

export function ChartWorkspace() {
  const isDesktop = useIsDesktop();
  const [hasOption, setHasOption] = useState(initialHasOption);
  // The index half closed with its ×. It stays MOUNTED (just not shown) so it
  // comes back instantly, drawings and all, and returns by itself once the
  // option charts are closed.
  const [spotHidden, setSpotHidden] = useState(false);

  useEffect(() => {
    const onOpen = () => setHasOption(true);
    const onEmpty = () => { setHasOption(false); setSpotHidden(false); };
    const onIndex = () => setSpotHidden(false);      // an index picked in the option half's search
    window.addEventListener('terminal:open-option', onOpen as any);
    window.addEventListener('terminal:options-empty', onEmpty as any);
    window.addEventListener('terminal:open-index', onIndex as any);
    return () => {
      window.removeEventListener('terminal:open-option', onOpen as any);
      window.removeEventListener('terminal:options-empty', onEmpty as any);
      window.removeEventListener('terminal:open-index', onIndex as any);
    };
  }, []);

  // SCALPPRO (phone). Open while the session lasts, so a reload in the middle
  // of a trade comes back to the screen he was trading from. Opened by the
  // chart page's button, which announces it; closed by the screen's own back
  // arrow — which also lets go of the option on screen, so the chart page comes
  // back on the index it was opened from (the option stays in its list).
  const [scalp, setScalp] = useState<boolean>(() => { try { return sessionStorage.getItem('scalpPro') === '1'; } catch (e) { return false; } });
  useEffect(() => {
    const onScalp = (e: any) => {
      const on = !!e?.detail;
      try { if (on) sessionStorage.setItem('scalpPro', '1'); else sessionStorage.removeItem('scalpPro'); } catch (err) {}
      setScalp(on);
    };
    window.addEventListener('terminal:scalp', onScalp as any);
    return () => window.removeEventListener('terminal:scalp', onScalp as any);
  }, []);
  const closeScalp = () => {
    try { sessionStorage.removeItem('scalpPro'); sessionStorage.removeItem('selectedInstrument'); } catch (e) {}
    setScalp(false);
  };

  // The bias card's × hides it; Indicators → NIFTY Bias card brings it back.
  // Above the phone early-return below: hooks must run on every render.
  const [biasCardHidden] = useBiasCardHidden();
  // Phone and tablet: the original component, unchanged and unaware of panes —
  // or, while ScalpPro is open, the two-chart screen in its place.
  if (!isDesktop) return scalp ? <ScalpScreen onClose={closeScalp} /> : <AdvancedChart />;

  const focusedTab = (() => { try { return new URLSearchParams(window.location.search).has('optToken'); } catch (e) { return false; } })();
  const split = hasOption && !spotHidden;     // both halves on screen
  // Height chain, desktop. main is a fixed-height flex COLUMN; this wrapper must
  // be a flex-1 CHILD of it (not h-full — a percentage that also overflowed by
  // the banner's height whenever a position was open). Each pane is h-full of
  // this wrapper, and the chart page inside is h-full of the pane. Every link is
  // a definite height, so the chart's flex-grow has something to grow into.
  // This was the break behind two failed attempts: the page root sat inside a
  // plain block using flex-1, which has no effect without a flex parent — its
  // height collapsed to content and the chart stopped at its 450px floor.
  return (
    // md:h-0 + flex-1 (not md:h-auto): the shell's <main> grows to fit its
    // content, so a content-sized workspace pushed the bias card below the screen.
    // A zero preferred height lets flex-1 hand it exactly the space that is left,
    // and the panes row then takes that space minus the card.
    <div className="flex flex-col h-full md:h-0 md:flex-1 w-full min-h-0 min-w-0">
    <div className="flex flex-1 w-full min-h-0 min-w-0">
      {/* LEFT — spot only. Keyed so it is never remounted when the right pane
          appears or disappears: a remount would rebuild the chart, drop the
          drawings and re-run every query. */}
      <div className={`${hasOption && spotHidden ? 'hidden' : split ? 'w-1/2 border-r border-white/10' : 'w-full'} h-full min-w-0 min-h-0`}>
        <AdvancedChart key="pane-spot" paneRole="spot" split={split} onClosePane={() => setSpotHidden(true)} />
      </div>

      {/* RIGHT — option charts in the tab strip they already use. Mounted only
          when there is something to show. */}
      {hasOption && (
        <div className={`${spotHidden ? 'w-full' : 'w-1/2'} h-full min-w-0 min-h-0`}>
          <AdvancedChart key="pane-option" paneRole="option" split={split} spotHidden={spotHidden}
            onShowSpot={() => setSpotHidden(false)} />
        </div>
      )}
    </div>
    {/* "Check bias" card (public/bias-panel.js): ONE card under both panes, so
        the two charts keep identical heights. Starts collapsed to its headline. */}
    {/* Not in a single-contract window (Strike Click tab, ?optToken=): that tab is
        about one option, and the bias card reads the index. */}
    {!focusedTab && !biasCardHidden && (
    <>
    {/* relative z + its own background: expanded, it sits ON TOP of the RSI pane
        (the chart keeps a 450px floor, so the panes cannot shrink further).
        pr-20 keeps the "Check bias" button clear of the floating Diag button.
        z-[32], not z-[25]: the chart's two overlay canvases (level lines and their
        pills, the R:R box) are z-30 and z-[31] and span the whole chart box, which
        on a short window runs under this card because of that 450px floor. At 25
        the card sat BELOW them, so 15M LOW / RED INNER / SUPPORT were drawn straight
        across its text. Kept under z-40 so the chart's own buttons and every
        dialog still open over it. */}
    <div data-layout="below-charts" className="relative z-[32] bg-background shrink-0 pl-2 pr-20 py-1.5 border-t border-white/10 max-h-[40vh] overflow-y-auto">
      <bias-panel compact="" />
    </div>
    </>
    )}
    </div>
  );
}

export default ChartWorkspace;
