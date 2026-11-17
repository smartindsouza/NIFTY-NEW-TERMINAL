import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { istToday } from '../lib/bias';

// THE BIAS BUTTON AND ITS SHEET (17 Nov 2026). Martin, with two pictures of
// Lemonn's ScalpPro — its chart-line button beside the "≡+" one, and the sheet
// it opens ("Sideways / Since 2:30 PM / NIFTY 50 0.38%", three points, a
// disclaimer, Okay): "Remove the nifty bias card indicator for the indicator
// list and add it on the spot chart like shown in the screenshot. Once loaded
// the bias should appear as shown in the 2nd screenshot. Add the button to
// both spot charts in the charts screen as well as the scalper pro screen
// exactly as shown in the 1st screenshot".
//
// The button does what the card's "Check bias" did: it asks the server for a
// fresh read (POST /api/bias/run — Claude reads the day's numbers, 10 to 20
// seconds; the server hands back the last read at once if it is under a
// minute old or no new candle has closed). While it works the button turns.
// What comes back is shown in the sheet:
//   - the bias as its word, in its colour (green, red, or Lemonn's blue for
//     neutral), with its confidence and the time it was read;
//   - NIFTY 50 and its change on the day at that moment (the read's own price
//     against the previous close);
//   - the read's lines, one point each — and its closing line, "Directional
//     context only, not a trade signal…", in the disclaimer's box, where
//     Lemonn has its own.
// Lemonn's "Analyzed by Dash" line is theirs and is left out.
// A read that fails says why in a message; if today has an earlier read, the
// sheet shows that one.
//
// Every size, colour and distance here is measured off Martin's two pictures
// (430pt wide, 3 pixels a point).

export type BiasNote = {
  date?: string;
  status?: string;
  bias?: 'bullish' | 'bearish' | 'neutral' | null;
  confidence?: string | null;
  headline?: string | null;
  summary?: string | null;
  generated_at?: string | null;
  ltp?: number | null;
  levels?: { prev_close?: number | null } | null;
  error?: string | null;
  previous?: BiasNote | null;
  cached?: boolean;
};

const BLUE = '#7ba8f5', GREEN = '#5baa79', RED = '#e5505f';

/** Lemonn's chart-line: an axis down the left and along the foot, and a line
 *  that leaves the axis, rises, dips and rises again. 20 x 18 with its stroke. */
export function BiasIcon({ width = 16.3, color = 'currentColor' }: { width?: number; color?: string }) {
  return (
    <svg width={width} height={width * 0.9} viewBox="0 0 20 18" fill="none" stroke={color} strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 1V17H19" />
      <path d="M1 9.5L6 7.1L11.4 12.2L17.6 6.6" />
    </svg>
  );
}

const time12 = (iso?: string | null) => {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
};

/** The read's lines as points, and its closing caveat on its own. */
export function notePoints(n: BiasNote): { points: string[]; caveat: string | null } {
  const isCaveat = (s: string) => /not a trade signal|directional context only|trading signals/i.test(s);
  let lines = String(n.summary || '').split(/\n+/).map((s) => s.replace(/^\s*(?:[-•*]\s+)/, '').trim()).filter(Boolean);
  // One paragraph: its sentences are the points.
  if (lines.length === 1) lines = lines[0].split(/(?<=[.!?])\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
  const caveat = lines.find(isCaveat) || null;
  const points = lines.filter((s) => !isCaveat(s));
  if (!points.length && n.headline) points.push(String(n.headline));
  return { points, caveat };
}

function BiasSheet({ note, onClose }: { note: BiasNote; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const word = note.bias === 'bullish' ? 'Bullish' : note.bias === 'bearish' ? 'Bearish' : note.bias === 'neutral' ? 'Neutral' : 'No read';
  const tone = note.bias === 'bullish' ? GREEN : note.bias === 'bearish' ? RED : note.bias === 'neutral' ? BLUE : '#a6a6a6';
  const conf = note.confidence ? note.confidence[0].toUpperCase() + note.confidence.slice(1) : '';
  const sub = [conf, time12(note.generated_at)].filter(Boolean).join(' · ');
  const ltp = Number(note.ltp), pc = Number(note.levels?.prev_close);
  const pct = ltp > 0 && pc > 0 ? (ltp / pc - 1) * 100 : null;
  const { points, caveat } = notePoints(note);
  return (
    <div data-bias-sheet="" className="fixed inset-0 z-[200] text-left" onPointerDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/70" aria-hidden="true" onClick={onClose} />
      <div role="dialog" aria-label="NIFTY bias"
        className="bias-sheet absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-[24px] md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-[430px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-[24px]"
        style={{
          border: '1px solid transparent',
          // The glow at the top left and the blue edge that fades down the sides.
          background: 'radial-gradient(190px 80px at 0 0, rgba(17,48,94,1), rgba(17,48,94,0)) padding-box, linear-gradient(#161616, #161616) padding-box, linear-gradient(180deg, #25489b 0px, rgba(37,72,155,0) 240px) border-box',
          paddingBottom: 'calc(15.7px + env(safe-area-inset-bottom))',
        }}>
        {/* Header: 81 tall, then a 1pt line the width of the sheet. */}
        <div className="relative h-[81px]">
          <span className="absolute left-[18.3px] top-[34px]"><BiasIcon width={19.7} color={tone} /></span>
          {/* Lemonn sets nearly all of this sheet in Manrope SemiBold: its
              lines are as wide as 600 sets them, not 400 (checked by setting
              its own words at each weight and measuring). */}
          <div data-bias="title" className="absolute left-[47.7px] top-[23.8px] text-[14px] leading-5 font-semibold" style={{ color: tone }}>{word}</div>
          {sub && <div data-bias="sub" className="absolute left-[47.7px] top-[47.5px] text-[12px] leading-4 font-semibold" style={{ color: '#a6a6a6' }}>{sub}</div>}
          <div className="absolute right-[16px] top-[23.8px] text-[14px] leading-5 font-semibold" style={{ color: '#e8e8e8' }}>NIFTY 50</div>
          {pct !== null && (
            <div data-bias="pct" className="absolute right-[16px] top-[47.5px] text-[12px] leading-4 font-semibold tabular-nums" style={{ color: pct < 0 ? RED : GREEN }}>
              {pct < 0 ? '-' : ''}{Math.abs(pct).toFixed(2)}%
            </div>
          )}
        </div>
        <div className="h-px" style={{ background: '#262626' }} />
        {/* The points: 12px, 16.2 a line, 15.6 between them, a 6pt dot
            centred on each. */}
        <ul className="pt-[16.37px] pr-[17px] flex flex-col gap-[15.6px]">
          {points.map((p, i) => (
            <li key={i} data-bias="point" className="flex items-center">
              <span className="shrink-0 ml-[16px] h-[6px] w-[6px] rounded-full" style={{ background: '#e8e8e8' }} aria-hidden="true" />
              <span className="ml-[12px] text-[12px] leading-[16.2px] font-semibold" style={{ color: '#bbbbbb' }}>{p}</span>
            </li>
          ))}
        </ul>
        {caveat && (
          <div data-bias="caveat" className="mx-[16px] mt-[19.3px] rounded-[12px] px-[12px] pt-[12px] pb-[12px]" style={{ background: '#262626' }}>
            <div className="flex items-center h-[14px] text-[10px] leading-[14px] font-semibold" style={{ color: '#dbdbdb' }}>
              <svg width="9.3" height="8.4" viewBox="0 0 24 21.6" className="shrink-0 ml-[1.3px] mr-[5.4px]" aria-hidden="true">
                <path d="M12 0 24 21.6H0Z" fill="#dbdbdb" />
                <path d="M12 7.6V14" stroke="#262626" strokeWidth="2.6" strokeLinecap="round" />
                <circle cx="12" cy="17.6" r="1.5" fill="#262626" />
              </svg>
              Disclaimer:
            </div>
            <div className="mt-[8px] text-[10px] leading-[14px] font-semibold" style={{ color: '#bbbbbb' }}>{caveat}</div>
          </div>
        )}
        <div className="mt-[20px] h-px" aria-hidden="true"
          style={{ backgroundImage: 'linear-gradient(90deg, #262626 0 4px, transparent 4px 8px)', backgroundSize: '8px 1px' }} />
        <button type="button" data-bias="okay" onClick={() => onClose()}
          className="mx-[16px] mt-[20px] h-[54px] w-[calc(100%-32px)] rounded-[12px] bg-white text-black text-[16px] font-bold active:opacity-80">
          Okay
        </button>
      </div>
    </div>
  );
}

/** The button: Lemonn's 33pt square, dark navy going lighter to the right, a
 *  blue-grey edge, the chart-line in blue. `className` places and sizes it. */
export function BiasButton({ className = '' }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<BiasNote | null>(null);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/bias/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j: BiasNote = await r.json().catch(() => ({}));
      if (!r.ok || j.status === 'error') {
        // 429 (the day's cap) comes back as the last read with the reason; an
        // error as the reason with the read before it.
        const prev = r.ok ? j.previous : j;
        toast.error(j.error ? `Bias check failed: ${j.error}` : `Bias check failed (${r.status})`);
        if (prev && prev.status === 'ok' && prev.date === istToday()) setNote(prev);
      } else {
        setNote(j);
      }
    } catch (e) {
      toast.error('Bias check failed: no connection');
    }
    setBusy(false);
  };
  return (
    <>
      <button type="button" data-bias="button" aria-label="Check bias" title="Check bias" aria-busy={busy}
        onClick={() => { void run(); }}
        className={`flex items-center justify-center rounded-[6px] border active:opacity-80 ${className}`}
        style={{
          background: 'linear-gradient(90deg, #04060f 0%, #11141c 8%, #1a2232 15%, #222d40 25%, #2b3a54 50%, #2e3d53 75%, #283142 100%)',
          borderColor: '#4a5d80', borderLeftColor: '#303a4b',
        }}>
        {busy
          ? <span className="block h-[15px] w-[15px] rounded-full border-2 animate-spin" style={{ borderColor: 'rgba(126,169,240,0.3)', borderTopColor: '#7ea9f0' }} />
          : <BiasIcon width={16.3} color="#7ea9f0" />}
      </button>
      {note && createPortal(<BiasSheet note={note} onClose={() => setNote(null)} />, document.body)}
    </>
  );
}
