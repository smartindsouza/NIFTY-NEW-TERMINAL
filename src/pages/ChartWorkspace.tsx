import { useEffect, useState } from 'react';
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

  // The bias card's × hides it; Indicators → NIFTY Bias card brings it back.
  // Above the phone early-return below: hooks must run on every render.
  const [biasCardHidden] = useBiasCardHidden();
  // Phone and tablet: the original component, unchanged and unaware of panes.
  if (!isDesktop) return <AdvancedChart />;

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
        pr-20 keeps the "Check bias" button clear of the floating Diag button. */}
    <div data-layout="below-charts" className="relative z-[25] bg-background shrink-0 pl-2 pr-20 py-1.5 border-t border-white/10 max-h-[40vh] overflow-y-auto">
      <bias-panel compact="" />
    </div>
    </>
    )}
    </div>
  );
}

export default ChartWorkspace;
