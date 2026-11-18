import React from 'react';

// THE PILL-AND-CHIPS BAR (17 Nov 2026). Martin, with a picture of it ("NIFTY 50 ⇕
// | Bullish  Bearish  Volatile  Neu…"): "change the news categories and the filter
// button to exactly this design shown in the screenshot" — the same bar his
// futures-heatmap recording has ("Index ⇕ | Nifty 50  Sensex  Nifty Bank …").
// Measured off his pictures (3 pixels a point):
//   - the pill on the left: 34 tall, round ends, a 1pt white edge, no fill;
//     its word 12px SemiBold white, 14 in from the left; the up-and-down
//     arrows 8 x 11.3, 10 after the word, 16 from the right. A tap switches
//     what the chips are (the caller says what to);
//   - a 1pt line 32 tall, #373737, 8.5 either side;
//   - the chips: 32 tall, round ends, 16.5 either side of the word, 8.6
//     apart; the chosen one white with black words, the rest a 1pt #373737
//     edge with #e8e8e8 words, 12px Medium. They slide sideways under the
//     pill's edge when there are more than fit; the pill stays put.
export function UpDownArrows({ className = '', scale = 1 }: { className?: string; scale?: number }) {
  return (
    <svg width={8 * scale} height={11.3 * scale} viewBox="0 0 8 11.3" className={`shrink-0 ${className}`} aria-hidden="true"
      fill="currentColor" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round">
      <path d="M4 1 7.1 4.5H0.9Z" />
      <path d="M4 10.3 0.9 6.8H7.1Z" />
    </svg>
  );
}

// The futures heatmap's recording has the same bar drawn a touch differently
// (measured the same way): the pill's word 12 in and its arrows 1.15 times as
// big, 8.5 apart, 15 to the end; the line 8 after the pill and the chips 16
// after the line; the chips 16 either side of the word and 8.2 apart; the
// line and the chips' edges #323232.
const LOOK = {
  news: { toggle: 'pl-[14px] pr-[16px] gap-[10px]', arrows: 1, line: 'mx-[8.5px] bg-[#373737]', edge: 'border-[#373737]', chip: 'px-[16.5px]', gap: 'gap-[8.6px]' },
  heatmap: { toggle: 'pl-[12px] pr-[15px] gap-[8.5px]', arrows: 1.15, line: 'ml-2 mr-4 bg-[#323232]', edge: 'border-[#323232]', chip: 'px-4', gap: 'gap-[8.2px]' },
} as const;

export function ChipBar<T extends string>({ toggleLabel, onToggle, chips, active, onPick, name, look = 'news' }: {
  toggleLabel: string;
  onToggle: () => void;
  chips: readonly T[];
  active: T;
  onPick: (chip: T) => void;
  /** For tests and the screen reader: what the bar picks ("news", "heatmap"). */
  name: string;
  look?: keyof typeof LOOK;
}) {
  const L = LOOK[look];
  return (
    <div className="flex items-center min-w-0" data-chipbar={name}>
      <button type="button" onClick={() => onToggle()} data-chipbar-toggle={toggleLabel}
        className={`shrink-0 h-[34px] rounded-full border border-primary ${L.toggle} flex items-center text-[12px] font-semibold text-white whitespace-nowrap active:bg-white/10`}>
        {toggleLabel}
        <UpDownArrows scale={L.arrows} />
      </button>
      <span className={`shrink-0 h-8 w-px ${L.line}`} aria-hidden="true" />
      <div className={`flex-1 min-w-0 flex ${L.gap} overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`} role="tablist" aria-label={name}>
        {chips.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={c === active} data-chip={c}
            onClick={() => onPick(c)}
            className={`shrink-0 h-8 rounded-full ${L.chip} text-[12px] font-medium whitespace-nowrap border transition-colors ${
              c === active ? 'bg-primary text-primary-foreground border-primary' : `${L.edge} text-[#e8e8e8] active:bg-white/10`
            }`}>
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}
