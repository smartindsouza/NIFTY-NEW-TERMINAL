import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { TrendingUp, TrendingDown, MoveHorizontal, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTodayBias, isRecord, istToday, fmtLevel, biasChime, BIAS_ALERTED_KEY, BIAS_DISMISSED_KEY, type BiasRecord } from '../lib/bias';

// App-wide alert for Today's Bias. Mounted once in the app shell, so it fires on
// whichever screen is open. The note is polled every 30 s from 09:25 to 10:00 IST
// (src/lib/bias.ts). When today's note first appears: a popup that stays until
// dismissed, a short chime, and a browser notification if permission was granted
// (asked for only from the button on the card, never on page load).
// Once per date: the chime and notification fire once (BIAS_ALERTED_KEY); the
// popup stays until it is dismissed (BIAS_DISMISSED_KEY), so a reload or a
// re-mount before dismissing shows it again rather than losing it.

const STYLE = {
  bullish: { Icon: TrendingUp, word: 'BULLISH', ring: 'border-emerald-500/60', head: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  bearish: { Icon: TrendingDown, word: 'BEARISH', ring: 'border-rose-500/60', head: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' },
  neutral: { Icon: MoveHorizontal, word: 'NEUTRAL', ring: 'border-amber-500/60', head: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
} as const;

export function BiasAlert() {
  const { data } = useTodayBias();
  const [shown, setShown] = useState<BiasRecord | null>(null);
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isRecord(data) || data.date !== istToday()) return;
    const read = (k: string) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
    if (read(BIAS_DISMISSED_KEY) !== data.date) setShown(data);
    if (read(BIAS_ALERTED_KEY) === data.date) return;          // sound + notification: once per date
    try { localStorage.setItem(BIAS_ALERTED_KEY, data.date); } catch (e) {}
    biasChime();
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const word = data.status === 'ok' && data.bias ? `${data.bias.toUpperCase()} · ` : '';
        new Notification(`Today's bias: ${word}${data.confidence ?? ''}`.trim(), { body: data.headline, tag: `bias-${data.date}` });
      }
    } catch (e) {}
  }, [data]);

  const dismiss = () => {
    if (shown) { try { localStorage.setItem(BIAS_DISMISSED_KEY, shown.date); } catch (e) {} }
    setShown(null);
  };
  if (!shown) return null;
  const ok = shown.status === 'ok' && !!shown.bias;
  const st = ok ? STYLE[shown.bias!] : null;
  const L = shown.levels || {};
  return (
    <div className="fixed inset-0 z-[120] flex items-start md:items-center justify-center bg-black/40 px-3 pt-24 md:pt-0" role="dialog" aria-modal="true" aria-label="Today's bias">
      <div className={cn('w-full max-w-md rounded-xl border-2 bg-card text-card-foreground shadow-2xl overflow-hidden', st ? st.ring : 'border-amber-500/40')}>
        <div className={cn('flex items-center gap-2 px-4 py-2.5', st ? st.head : 'bg-amber-500/10 text-amber-800 dark:text-amber-200')}>
          {st ? <st.Icon size={16} /> : <TriangleAlert size={16} />}
          <span className="text-xs font-bold tracking-wider">
            TODAY'S BIAS · {st ? st.word : shown.status === 'no_session' ? 'NO SESSION' : 'ERROR'}{ok && shown.confidence ? ` · ${shown.confidence.toUpperCase()}` : ''}
          </span>
          <button onClick={dismiss} aria-label="Dismiss" className="ml-auto p-1 rounded hover:bg-black/10"><X size={16} /></button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <p className="text-base font-semibold leading-snug">{shown.headline}</p>
          {ok && (
            <div className="grid grid-cols-3 gap-2 text-center">
              {([['Trigger', L.trigger], ['Invalidation', L.invalidation], ['Next ref', L.next_reference]] as const).map(([k, v]) => (
                <div key={k} className="rounded-lg bg-muted/50 py-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</div>
                  <div className="text-sm font-mono font-semibold">{fmtLevel(v as any)}</div>
                </div>
              ))}
            </div>
          )}
          {!ok && shown.error && <p className="text-xs text-muted-foreground">{shown.error}</p>}
          <div className="flex gap-2">
            <button onClick={() => { dismiss(); setLocation('/'); }}
              className="flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-semibold">Open full note</button>
            <button onClick={dismiss} className="flex-1 h-9 rounded-md border border-border text-sm font-medium">Dismiss</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BiasAlert;
