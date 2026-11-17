import React, { useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';

// PULL DOWN TO REFRESH (phone chart screen, 17 Nov 2026). Martin, with a picture
// of Lemonn's spinner at the top of its chart screen: "enable the pull down to
// refresh chart in the main chart screen instead of taping reload in the
// settings. Remove the reload option from settings once it's added."
//
// The app runs from the home screen, where there is no browser to pull on, so
// the pull is made here. It begins only with the page at its very top, one
// finger, and NOT on a chart: the chart takes every drag made on it (that is
// how it is moved), so a pull begun there moves the chart as it always did.
// Nor in a field, or in a list that scrolls by itself (the search's results,
// a menu). Everywhere else on the first screen — the header, the price, the
// row of five — a drag down brings a round arrow down from the top at half the
// finger's pace; past the mark it turns solid, and letting go there refreshes.
// Let go short of it, or push back up, and it goes away with nothing done.
// While the pull is on, the page under it is held still (the touch is not
// passed to the browser's own bounce), which is why the move listener is not
// passive; it does nothing at all unless a pull has begun.
// It listens on the page's own element, so sheets (which are drawn on the
// body) never start one. It is its own small component so that a moving finger
// redraws this arrow and not the chart page.
const TRIGGER = 56;      // px the arrow must come down (112px of finger)
const MAX = 84;

export function PullRefresh({ rootRef, enabled, onRefresh }: {
  rootRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  onRefresh: () => void;
}) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const live = useRef({ on: false, y0: 0, x0: 0, pull: 0, busy: false });
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !enabled) return;
    const s = live.current;
    const scrollsItself = (t: Element | null) => {
      for (let n: Element | null = t; n && n !== el; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return true;
      }
      return false;
    };
    const start = (e: TouchEvent) => {
      s.on = false;
      if (s.busy || e.touches.length !== 1 || window.innerWidth >= 768 || window.scrollY > 0) return;
      const t = e.target as Element | null;
      if (!t || !t.closest) return;
      if (t.closest('.tv-lightweight-charts, canvas, input, textarea, select, [data-no-pull]') || scrollsItself(t)) return;
      s.on = true; s.y0 = e.touches[0].clientY; s.x0 = e.touches[0].clientX; s.pull = 0;
    };
    const move = (e: TouchEvent) => {
      if (!s.on) return;
      if (e.touches.length !== 1) { s.on = false; s.pull = 0; setPull(0); return; }
      const dy = e.touches[0].clientY - s.y0, dx = e.touches[0].clientX - s.x0;
      // Sideways, or upward before anything showed: not a pull — let it go.
      if (s.pull === 0 && (dy <= 0 || Math.abs(dx) > dy)) { if (dy < -6 || Math.abs(dx) > 12) s.on = false; return; }
      const p = Math.max(0, Math.min(MAX, dy * 0.5));
      if (p > 0 && e.cancelable) e.preventDefault();
      s.pull = p; setPull(p);
    };
    const end = () => {
      if (!s.on) return;
      s.on = false;
      if (s.pull >= TRIGGER) {
        s.busy = true; setBusy(true); setPull(TRIGGER);
        try { refresh.current(); } catch (err) { /* the page is about to go */ }
        // Should the page not go (a refresh that failed to start), put it away.
        setTimeout(() => { s.busy = false; s.pull = 0; setBusy(false); setPull(0); }, 6000);
      } else { s.pull = 0; setPull(0); }
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end, { passive: true });
    el.addEventListener('touchcancel', end, { passive: true });
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [enabled, rootRef]);

  if (!enabled || (pull <= 0 && !busy)) return null;
  const ready = pull >= TRIGGER;
  return (
    <div data-pull-refresh={busy ? 'busy' : ready ? 'ready' : 'pulling'} aria-hidden="true"
      className="md:hidden fixed left-0 right-0 z-[95] flex justify-center pointer-events-none"
      style={{ top: 'calc(max(env(safe-area-inset-top), 12px) - 44px)', transform: `translateY(${pull}px)`, transition: live.current.on ? 'none' : 'transform 160ms ease-out' }}>
      <div className={`h-9 w-9 rounded-full bg-card border border-white/10 shadow-xl flex items-center justify-center ${ready || busy ? 'text-primary' : 'text-muted-foreground'}`}>
        <RotateCw size={18} className={busy ? 'animate-spin' : ''} style={busy ? undefined : { transform: `rotate(${Math.round(pull * 4)}deg)`, opacity: 0.4 + 0.6 * Math.min(1, pull / TRIGGER) }} />
      </div>
    </div>
  );
}
