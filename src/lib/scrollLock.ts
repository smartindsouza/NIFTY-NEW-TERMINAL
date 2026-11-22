import { useEffect, type RefObject } from 'react';

// A CARD UP, THE PAGE STILL (19 Nov 2026). Martin, of the horizontal line's
// settings card: "disable the screen scrolling behind it". While a card is open
// the page under it cannot be scrolled: the page and the body are told not to
// scroll, and a drag is cancelled unless it is inside the card, on something in
// it that scrolls by itself. Mount it with the card (it holds for as long as the
// card is there). The bottom row's cards on the chart page have their own,
// longer version of this: see THE PAGE STAYS STILL in AdvancedChart.
// ONE LOCK, COUNTED (22 Nov 2026). Martin: "the vertical scrolling gets stuck most
// of the time and I need to reload the app to fix it." Five things hold the page
// still while they are up (this card, the chart's bottom-row cards, the Option
// Chain, the Market Context sidebar, ScalperX) and each used to remember how the
// page was when IT opened and put that back when it closed. Two up at once, closed
// in the order they opened, left the page locked for good: the chain opens (page
// was free), a strike is tapped and ScalperX opens over it (page was "locked", so
// that is what it remembers), the chain closes and frees the page, and ScalperX,
// closed later, puts back "locked". Nothing was left to undo it but a reload.
// Now they all take the lock here. How the page was is remembered once, when the
// first of them takes it, and put back only when the last of them lets go.
let holders = 0, bounceHolders = 0;
let before: { ho: string; bo: string } | null = null;
let beforeBounce: { hb: string; bb: string } | null = null;
/** Holds the page still until the function it returns is called (once). `noBounce` also stops the bounce at its ends. */
export function lockPageScroll(noBounce = false): () => void {
  const html = document.documentElement, body = document.body;
  if (holders++ === 0) before = { ho: html.style.overflow, bo: body.style.overflow };
  html.style.overflow = 'hidden'; body.style.overflow = 'hidden';
  if (noBounce) {
    if (bounceHolders++ === 0) beforeBounce = { hb: html.style.overscrollBehavior, bb: body.style.overscrollBehavior };
    html.style.overscrollBehavior = 'none'; body.style.overscrollBehavior = 'none';
  }
  let done = false;
  return () => {
    if (done) return; done = true;
    if (noBounce && --bounceHolders === 0 && beforeBounce) { html.style.overscrollBehavior = beforeBounce.hb; body.style.overscrollBehavior = beforeBounce.bb; beforeBounce = null; }
    if (--holders === 0 && before) { html.style.overflow = before.ho; body.style.overflow = before.bo; before = null; }
  };
}

export function usePageScrollLock(card?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const unlock = lockPageScroll();
    const onMove = (e: TouchEvent) => {
      const box = card?.current;
      let el = e.target as HTMLElement | null;
      if (box && el && box.contains(el)) {
        for (; el && el !== box.parentElement; el = el.parentElement) {
          if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return;
        }
      }
      if (e.cancelable) e.preventDefault();
    };
    document.addEventListener('touchmove', onMove, { passive: false });
    return () => {
      document.removeEventListener('touchmove', onMove);
      unlock();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
