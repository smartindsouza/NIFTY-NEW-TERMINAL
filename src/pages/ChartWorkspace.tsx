import { FolderTabFeet } from "../components/FolderTabFeet";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft } from 'lucide-react';
import { AdvancedChart, type ScalpAt, type ScalpShared } from './AdvancedChart';
import { startIndicatorSync, indicatorEpoch, onIndicatorEpoch, anyChartBusy, adoptSpotHalfCopy, noteStorageOnce } from '../lib/indicatorSync';

// THE INDEX CHART IS PUT ON THE PAGE AGAIN WHEN ITS INDICATORS CHANGE ELSEWHERE.
// The number this returns goes up each time a switch or a setting has arrived
// from another device (see lib/indicatorSync). The index chart is keyed by it,
// so it is built afresh and reads its switches and settings as it does when
// the page is opened. Only the index chart: an option's chart has switches of
// its own, which are not shared, and on ScalpPro it is the chart a trade is
// worked from.
const useIndicatorEpoch = () => useSyncExternalStore(onIndicatorEpoch, indicatorEpoch, indicatorEpoch);

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

// THE SCALPPRO SCREEN IS SET IN MANROPE, LEMONN'S OWN FACE (16 Nov 2026). The app
// is set in a fixed-width code face; Lemonn's ScalpPro, which Martin asked this
// screen to match "100%" down to "the text size and the button sizes", is not,
// and a fixed-width "NIFTY 17NOV 25350" is a tenth wider and a different shape
// at any size. v307 used the phone's system face, with sizes worked out for it.
// He then asked to "copy the same fonts as in the screenshot", and the face
// could be named: the widths of Lemonn's texts, measured off his screenshot,
// are Manrope's at whole-pixel sizes to within a point (names, prices and
// buttons 12px, "Req" 10px, "Funds" 8px, the chart's own scale 10px) — "Funds:
// ₹8,645.89" is 65.33pt wide in both — where its two nearest look-alikes, DM
// Sans and Plus Jakarta Sans, are 8 to 11% wide on the chart's figures.
// Manrope is free (Open Font Licence) and is asked for in index.html (the
// <link> there says why not in the stylesheet). The system face is what shows
// until it arrives, or if it never does.
// Everything inside the screen inherits it; the two charts are told it
// separately (see SCALP_CHART_FONT in AdvancedChart).
const SCALP_FONT = "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function ScalpScreen({ onClose }: { onClose: () => void }) {
  const indEpoch = useIndicatorEpoch();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // How much of the height the spot chart has. Kept on this phone.
  const [frac, setFrac] = useState<number>(() => {
    try { const v = parseFloat(localStorage.getItem('scalpSplit') || ''); return v >= 0.05 && v <= 0.95 ? v : 0.5; } catch (e) { return 0.5; }
  });
  const fracRef = useRef(frac);
  fracRef.current = frac;
  // LIMIT / TRIGGER belongs to the screen, not to one chart: its line is on
  // both, and the bar that places the order is under the lower one. So the
  // mode, each chart's line and which line is the lit one are kept here and
  // handed to both; what the charts tell each other without a render (the
  // index's live price for the bar, the option's name for the index's chip)
  // goes through the ref. Not remembered: a reload comes back on Market.
  const [at, setAt] = useState<ScalpAt>({ on: false, src: 'option', optPx: null, spotPx: null });
  const shared = useRef<ScalpShared>({ spotNow: 0, spotToken: null, spotName: '', optShort: '' });

  // THE SCREEN ENDS WHERE THE BOTTOM BAR BEGINS, wherever it starts. Its top is
  // not a constant: the positions banner sits above it whenever a trade is on,
  // and comes and goes. So the top is measured — on mount, on a resize, and
  // twice a second as a net — and the height is what is left above the bar.
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const el = rootRef.current;
      if (!el) return;
      // Where the screen starts ON THE PAGE, not in the window: measured in
      // the window, a page that had slid up 25px made the screen 25px taller,
      // which is exactly what kept it slid up (see THE SCREEN DOES NOT SCROLL).
      const slid = window.scrollY || 0;
      if (slid > 0) { try { window.scrollTo(0, 0); } catch (e) {} }
      const t = Math.max(0, Math.round(el.getBoundingClientRect().top + (window.scrollY || 0)));
      setTop((prev) => (prev === t ? prev : t));
    };
    fit();
    const iv = setInterval(fit, 500);
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    return () => { clearInterval(iv); window.removeEventListener('resize', fit); window.removeEventListener('orientationchange', fit); };
  }, []);

  // THE SCREEN DOES NOT SCROLL (17 Nov 2026). Martin, with a picture of it
  // slid up under the clock: "sometimes the scalp pro screen moves up making
  // the top heading hidden. Disable screen vertical scrolling in the scalp pro
  // screen". The chart page is a page that scrolls (its cards are under the
  // chart), and this screen stands in for it, sized to fill the window exactly
  // — so there should be nothing to scroll. But for a moment there can be: a
  // trade opens and the positions line pushes the screen down before it is
  // measured again. A finger on the heading or on the Buy / Sell bar then moved
  // the page, and the measuring kept it moved (see `fit`, above). Three things,
  // each enough on most phones and none of them on all:
  //   - the page itself cannot scroll while this screen is up, and is put back
  //     at its top when the screen opens and whenever it is found moved;
  //   - a finger on this screen is not the browser's to scroll with
  //     (touch-action, on the root): the charts read their own touches, and a
  //     list inside a menu still scrolls, being a scroller of its own;
  //   - nothing bounces at the ends (overscroll-behavior).
  useLayoutEffect(() => {
    const html = document.documentElement, body = document.body;
    const was = { ho: html.style.overflow, bo: body.style.overflow, hb: html.style.overscrollBehavior, bb: body.style.overscrollBehavior };
    try { window.scrollTo(0, 0); } catch (e) {}
    html.style.overflow = 'hidden'; body.style.overflow = 'hidden';
    html.style.overscrollBehavior = 'none'; body.style.overscrollBehavior = 'none';
    return () => {
      html.style.overflow = was.ho; body.style.overflow = was.bo;
      html.style.overscrollBehavior = was.hb; body.style.overscrollBehavior = was.bb;
    };
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
    // Down to the bottom of the screen: the app's own bottom bar is not shown
    // while this screen is up (see scalpOpen in Header.tsx), as Lemonn's is not
    // on its ScalpPro. The Buy / Sell bar keeps clear of the home indicator
    // itself.
    <div ref={rootRef} data-scalp-screen="" className="flex flex-col w-full min-h-0 bg-background"
      style={{ height: top === null ? '80dvh' : `calc(100dvh - ${top}px)`, fontFamily: SCALP_FONT, touchAction: 'none' }}>
      {/* THE TOP ROW IS LEMONN'S (16 Nov 2026). Martin, with a picture of theirs:
          "add this design on the top and instead of All -211 text show the scalp
          pro text" — and of the button beside their tab, "No need of add more
          strategies button". Measured off the picture: a back arrow 16pt wide,
          10pt in from the edge; then a tab cut like a folder's — 37pt tall, its
          top corners rounded at 12pt, its feet flaring out at 11pt into the
          surface below — in the charts' own colour, so the tab and the chart
          under it are one piece, with a hairline under the rest of the row. */}
      <div data-scalp-top="" className="relative shrink-0 h-11 flex items-end bg-background">
        <div className="absolute inset-x-0 bottom-0 h-px bg-foreground/10" aria-hidden="true" />
        <button type="button" data-scalp="back" aria-label="Back" onClick={onClose}
          className="relative h-11 w-9 flex items-center justify-center text-foreground active:opacity-60">
          {/* Smaller, and in the middle of its corner, as the chart page's
              search icon is (18 Nov 2026; Martin: "Reduce the size of the back
              button and center it like the search icon in the scalperX screen").
              The corner is 47 wide to the tab and the box 36, so the arrow is
              shifted 5.5 right, and 3.5 down to the tab's middle. */}
          <ArrowLeft size={18} strokeWidth={2} className="translate-x-[5.5px] translate-y-[3.5px]" />
        </button>
        <div data-scalp="tab" className="relative ml-[11px] h-[37px] px-[17px] flex items-center rounded-t-[12px] border border-b-0 border-foreground/15 bg-card text-[12px] font-[650] text-foreground">
          {/* Its feet, with their outline (19 Nov 2026): see FolderTabFeet. */}
          <FolderTabFeet />
          {/* SCALPERX (17 Nov 2026). Martin: "Also change the ScalpPro name to
              ScaperX everywhere in my app", and asked which he meant, ScalperX. The
              name on the screen is changed wherever it is shown; the code's own
              names for it (scalp, ScalpScreen, openInScalpPro) are not. */}
          ScalperX
        </div>
        {/* THE OTHER OPTIONS ON THE LIST, BESIDE THE TAB (19 Nov 2026). Martin,
            with this stretch of the row marked: "display all the other options
            that are listed in chart screen but not the one open in scalperX
            screen in a pill shaped outline button with an x button to close it
            as well. I want horizontal swiping to swipe through the list".
            Only the place is made here. The pills are drawn into it by the
            option chart below (see THE PILLS BESIDE THE SCALPERX TAB in
            AdvancedChart), which owns the list. It is the one part of this
            screen a finger may scroll: sideways only (the root is
            touch-action none; see THE SCREEN DOES NOT SCROLL). */}
        {/* IN THE MIDDLE OF THE ROW, NOT OF THE TAB (19 Nov 2026). Martin, with a
            picture: "move the pill shaped options a little upward because it's
            not centered between the line above and below it". The place was
            the tab's height (37 of the row's 44, at its foot), so the pills sat
            3.5pt low between the row's two lines. It is the row's height now. */}
        <div data-scalp-pills="" className="relative flex-1 min-w-0 h-11 ml-[19px] flex items-center gap-[6px] pr-3 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ touchAction: 'pan-x', overscrollBehaviorX: 'contain' }} />
      </div>
      <div ref={bodyRef} className="flex flex-col flex-1 min-h-0">
        {/* Neither pane is ever squeezed below what it must keep: its two lines
            of name and price (58px), and for the option pane the Buy / Sell bar
            under them as well (98px with its Market | Limit/Trigger switch, and
            the home indicator's strip below it now that the app's bottom bar is
            not under this screen) — dragged all the way down, the handle stops
            there. */}
        <div data-scalp-pane="spot" className="overflow-hidden" style={{ flex: `${frac} 1 0%`, minHeight: 58 }}>
          <AdvancedChart key={`scalp-spot-${indEpoch}`} paneRole="spot" split scalp scalpAt={at} onScalpAt={setAt} scalpShared={shared} />
        </div>
        {/* The strip between the charts is Lemonn's, off Martin's screenshot: 16pt
            of the page's own background with a 42 x 4pt bar in it, and no lines
            of its own — the two panes are a lighter surface and end where it
            begins. (The light theme's page and panes are the same white, so
            there, and only there, it keeps a hairline above and below.) */}
        <div data-scalp="handle" onPointerDown={startDrag} title="Drag to resize the charts"
          className="shrink-0 h-4 flex items-center justify-center cursor-row-resize select-none bg-background border-y border-border dark:border-y-0 active:bg-foreground/10"
          style={{ touchAction: 'none' }}>
          <div className="w-[42px] h-1 rounded-full bg-foreground/65" />
        </div>
        <div data-scalp-pane="option" className="overflow-hidden" style={{ flex: `${1 - frac} 1 0%`, minHeight: 'calc(156px + env(safe-area-inset-bottom))' }}>
          <AdvancedChart key="scalp-option" paneRole="option" split scalp scalpAt={at} onScalpAt={setAt} scalpShared={shared} />
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
  // Announced, not just set: the app's bottom bar listens too (it steps aside
  // while this screen is up) and must hear that it has closed.
  const closeScalp = () => {
    // Back to the chart page with the option IT had chosen (its own copy, which
    // ScalperX never writes: see THE CHART PAGE'S OWN CHOICE in AdvancedChart),
    // or the index if it had none — not whatever ScalperX last showed.
    try {
      const own = sessionStorage.getItem('chartPageInstrument');
      if (own) sessionStorage.setItem('selectedInstrument', own); else sessionStorage.removeItem('selectedInstrument');
    } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('terminal:scalp', { detail: false })); } catch (e) { setScalp(false); }
  };

  // INDICATORS SHARED BETWEEN DEVICES run for as long as the chart page is up,
  // on a phone, on ScalpPro and on the desktop alike. What arrives from another
  // device is written to this one's storage at once; the chart is only built
  // afresh to show it at a quiet moment — nothing touched for four seconds, no
  // sheet or list open on any chart, the app in front. (A chart rebuilt under
  // a finger, or with its indicators list open, would be worse than a chart
  // four seconds late.)
  const indEpoch = useIndicatorEpoch();
  // The desktop's index half used to keep a copy of its own indicators; that
  // copy is dealt with here, once, AS THIS IS DRAWN — before the charts below
  // read their settings and before the sharing takes its first look at them
  // (the effect under this). Later would be too late for both: the index chart
  // would open on the plain names as they stood, and what the copy then wrote
  // would be sent to the other devices as changes made here.
  // Never on a phone, even one held sideways (which is wide enough to be shown
  // the two halves): a copy found there is from another day it was sideways.
  useState(() => { try { adoptSpotHalfCopy(window.localStorage, isDesktop && !/iPhone|Android/i.test(navigator.userAgent)); } catch (e) { /* storage closed */ } return 0; });
  useEffect(() => {
    let last = Date.now();
    const touched = () => { last = Date.now(); };
    const evs = ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'keydown', 'wheel'] as const;
    evs.forEach((e) => window.addEventListener(e, touched, { capture: true, passive: true }));
    noteStorageOnce();
    const stop = startIndicatorSync(() => Date.now() - last > 4000 && !anyChartBusy() && !document.hidden);
    return () => { stop(); evs.forEach((e) => window.removeEventListener(e, touched, { capture: true } as any)); };
  }, []);
  // Phone and tablet: the original component, unchanged and unaware of panes —
  // or, while ScalpPro is open, the two-chart screen in its place.
  if (!isDesktop) return scalp ? <ScalpScreen onClose={closeScalp} /> : <AdvancedChart key={`one-${indEpoch}`} />;

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
          drawings and re-run every query. The one thing that does rebuild it is
          its indicators changing on another device (indEpoch, above) — and
          then only at a quiet moment, never with a position box on it. */}
      <div className={`${hasOption && spotHidden ? 'hidden' : split ? 'w-1/2 border-r border-white/10' : 'w-full'} h-full min-w-0 min-h-0`}>
        <AdvancedChart key={`pane-spot-${indEpoch}`} paneRole="spot" split={split} onClosePane={() => setSpotHidden(true)} />
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
    {/* The "Check bias" card that stood under both panes is the bias button on
        the index half's tool bar now (BiasCheck.tsx), 17 Nov 2026. */}
    </div>
  );
}

export default ChartWorkspace;
