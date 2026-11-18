import { useEffect, type RefObject } from 'react';

// A CARD UP, THE PAGE STILL (19 Nov 2026). Martin, of the horizontal line's
// settings card: "disable the screen scrolling behind it". While a card is open
// the page under it cannot be scrolled: the page and the body are told not to
// scroll, and a drag is cancelled unless it is inside the card, on something in
// it that scrolls by itself. Mount it with the card (it holds for as long as the
// card is there). The bottom row's cards on the chart page have their own,
// longer version of this: see THE PAGE STAYS STILL in AdvancedChart.
export function usePageScrollLock(card?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const html = document.documentElement, body = document.body;
    const prev = [html.style.overflow, body.style.overflow];
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
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
      html.style.overflow = prev[0];
      body.style.overflow = prev[1];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
