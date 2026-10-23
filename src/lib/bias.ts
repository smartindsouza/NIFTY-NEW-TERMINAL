// Today's Bias — client side. One shared query (['bias-today']) feeds the Home
// card, the chart lines and the app-wide alert, so they can never disagree and
// the server is polled once, not three times.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

export type BiasRead = 'bullish' | 'bearish' | 'neutral';
export type BiasRecord = {
  date: string; generated_at: string; status: 'ok' | 'error' | 'no_session';
  bias: BiasRead | null; confidence: 'low' | 'moderate' | 'high' | null;
  headline: string; summary: string;
  levels: Partial<Record<'trigger' | 'invalidation' | 'next_reference' | 'or_high' | 'or_low' | 'first_candle_high' | 'first_candle_low'
    | 'prev_high' | 'prev_low' | 'prev_close' | 'cpr_pivot' | 'cpr_tc' | 'cpr_bc', number | null>> | null;
  gap: { actual_open_pts?: number | null; gift_implied_pts?: number | null } | null;
  factors: { name: string; read: BiasRead; note: string }[];
  us30: { close: number | null; change_pts: number | null; change_pct: number | null; driver: string | null } | null;
  error: string | null;
  received_at: string; outcome: string | null; outcome_note: string | null;
};
export type BiasToday = BiasRecord | { status: 'pending'; date: string };

/** IST calendar date, YYYY-MM-DD. */
export function istToday(ms = Date.now()): string {
  return new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
/** IST minute of day and weekday (0 = Sunday). */
function istClock(ms = Date.now()) {
  const d = new Date(ms + 5.5 * 3600 * 1000);
  return { mins: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.getUTCDay() };
}
/** 09:25–10:00 IST on a weekday: when the note is expected. */
export function inBiasWindow(ms = Date.now()) {
  const { mins, day } = istClock(ms);
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 25 && mins <= 10 * 60;
}

export const isRecord = (b: BiasToday | undefined | null): b is BiasRecord => !!b && b.status !== 'pending';

/** Today's note. Every 30 s inside the 09:25–10:00 window, every 5 min otherwise
 *  (so a late or re-posted note still shows up), and on focus. */
export function useTodayBias() {
  return useQuery<BiasToday>({
    queryKey: ['bias-today'],
    queryFn: async () => {
      const r = await fetch('/api/bias/today');
      if (!r.ok) throw new Error(`bias ${r.status}`);
      return r.json();
    },
    refetchInterval: () => (inBiasWindow() ? 30_000 : 5 * 60_000),
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
}

export function useBiasHistory(enabled: boolean, days = 30) {
  return useQuery<{ records: BiasRecord[] }>({
    queryKey: ['bias-history', days],
    queryFn: async () => (await fetch(`/api/bias/history?days=${days}`)).json(),
    enabled,
    staleTime: 60_000,
  });
}

/** IST HH:MM of an ISO time. */
export function hhmmIST(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
}

export const fmtLevel = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Short tone used by the alert. Browsers may block audio until the page has had
 *  a tap; that is fine — the toast and the notification still show. */
export function biasChime() {
  try {
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const a = new AC();
    [660, 880].forEach((f, i) => {
      const o = a.createOscillator(), g = a.createGain();
      o.connect(g); g.connect(a.destination);
      o.type = 'sine'; o.frequency.value = f;
      const t0 = a.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      o.start(t0); o.stop(t0 + 0.21);
    });
    setTimeout(() => { try { a.close(); } catch (e) {} }, 900);
  } catch (e) {}
}

export const BIAS_ALERTED_KEY = 'biasAlertedFor';      // chime + notification fired for this date
export const BIAS_DISMISSED_KEY = 'biasDismissedFor';  // popup dismissed for this date
export const BIAS_LINES_KEY = 'showBiasLevels';

// The "Check bias" card under the chart can be hidden (its × button) and shown
// again from the Indicators menu ("NIFTY Bias card"). One flag in localStorage,
// changed only through setBiasCardHidden so every mounted chart hears it at once
// (phone chart and desktop workspace each mount their own card).
export const BIAS_CARD_HIDDEN_KEY = 'biasCardHidden';
const readHidden = () => { try { return localStorage.getItem(BIAS_CARD_HIDDEN_KEY) === 'true'; } catch (e) { return false; } };
export function setBiasCardHidden(hidden: boolean, from = 'menu') {
  try { localStorage.setItem(BIAS_CARD_HIDDEN_KEY, String(hidden)); } catch (e) { }
  window.dispatchEvent(new CustomEvent('terminal:bias-card', { detail: { hidden, from, applied: true } }));
}
// The card's × only ANNOUNCES (it is plain JS inside a shadow root); this applies
// it once for the whole app and says where to get the card back.
if (typeof window !== 'undefined' && !(window as any).__biasCardHideHooked) {
  (window as any).__biasCardHideHooked = true;
  window.addEventListener('terminal:bias-card', (e: any) => {
    if (e?.detail?.from === 'card' && !e.detail.applied) {
      setBiasCardHidden(true, 'card');
      try { toast('Bias card hidden', { description: 'Bring it back from Indicators → NIFTY Bias card.' }); } catch (err) { }
    }
  });
}
export function useBiasCardHidden(): [boolean, (h: boolean) => void] {
  const [hidden, setHidden] = useState<boolean>(readHidden);
  useEffect(() => {
    const on = (e: any) => { if (e?.detail?.applied) setHidden(!!e.detail.hidden); };
    window.addEventListener('terminal:bias-card', on);
    return () => window.removeEventListener('terminal:bias-card', on);
  }, []);
  return [hidden, (h: boolean) => setBiasCardHidden(h)];
}
