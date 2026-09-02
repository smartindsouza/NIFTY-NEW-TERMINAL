import { useEffect, useState } from 'react';
import { AdvancedChart } from './AdvancedChart';

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

  useEffect(() => {
    const onOpen = () => setHasOption(true);
    const onEmpty = () => setHasOption(false);
    window.addEventListener('terminal:open-option', onOpen as any);
    window.addEventListener('terminal:options-empty', onEmpty as any);
    return () => {
      window.removeEventListener('terminal:open-option', onOpen as any);
      window.removeEventListener('terminal:options-empty', onEmpty as any);
    };
  }, []);

  // Phone and tablet: the original component, unchanged and unaware of panes.
  if (!isDesktop) return <AdvancedChart />;

  const split = hasOption;
  return (
    <div className="flex h-full w-full min-h-0 min-w-0">
      {/* LEFT — spot only. Keyed so it is never remounted when the right pane
          appears or disappears: a remount would rebuild the chart, drop the
          drawings and re-run every query. */}
      <div className={`${split ? 'w-1/2 border-r border-border/60' : 'w-full'} h-full min-w-0 min-h-0`}>
        <AdvancedChart key="pane-spot" paneRole="spot" />
      </div>

      {/* RIGHT — option charts in the tab strip they already use. Mounted only
          when there is something to show. */}
      {split && (
        <div className="w-1/2 h-full min-w-0 min-h-0">
          <AdvancedChart key="pane-option" paneRole="option" />
        </div>
      )}
    </div>
  );
}

export default ChartWorkspace;
