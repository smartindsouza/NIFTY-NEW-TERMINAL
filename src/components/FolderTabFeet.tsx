// THE FEET OF A FOLDER TAB (19 Nov 2026). Martin, with Lemonn's "All" tab beside
// the chart page's: "The lemon shows perfectly curved tabs (1st screenshot) but my
// app has those curves missing (2nd screenshot). Kindly fix it and match it 100%".
//
// Measured off his two pictures (3 pixels to a point). Lemonn's tab has its top
// corners rounded at 12pt, and its sides flare out into the line under the row on
// a curve of 11pt — the outline runs on round the curve, from the side into the
// line, with no break. Ours had 13pt corners and 10pt feet, and the feet were
// quarter-circles of the tab's colour with no outline at all; worse, they sat one
// point too far in, over the bottom of the tab's own side line (an absolutely
// placed child is measured from inside the border), so the side stopped ten
// points short of the line and the corner read as a notch.
//
// Each foot is now drawn whole: the tab's colour inside the curve, and the curve
// itself in the outline's colour, starting where the side line is and ending on
// the line under the row. The tab must be position: relative, with a 1px side
// border, no bottom border, and its bottom row lying on the 1px line under the
// row (the chart page's header line, ScalperX's top row's line).
export const TAB_CORNER = 12;
export const TAB_FOOT = 11;

const STROKE = 'color-mix(in oklab, var(--foreground) 15%, transparent)';

export function FolderTabFeet({ className = '' }: { className?: string }) {
  const R = TAB_FOOT, W = R + 1, H = R + 1;
  const box = `absolute bottom-0 pointer-events-none ${className}`;
  return (
    <>
      {/* left: the side line's middle is at x = R + 0.5, the line under the row's at y = R + 0.5 */}
      <svg aria-hidden="true" data-tab-foot="left" className={box} width={W} height={H} viewBox={`0 0 ${W} ${H}`}
        style={{ left: -(R + 1), overflow: 'visible' }}>
        <path d={`M0.5 ${R + 0.5} A${R} ${R} 0 0 0 ${R + 0.5} 0.5 L${W} 0.5 L${W} ${H} L0.5 ${H} Z`} style={{ fill: 'var(--card)' }} />
        <path d={`M0.5 ${R + 0.5} A${R} ${R} 0 0 0 ${R + 0.5} 0.5`} style={{ fill: 'none', stroke: STROKE, strokeWidth: 1 }} />
      </svg>
      {/* right: the same, mirrored — the side line's middle at x = 0.5 */}
      <svg aria-hidden="true" data-tab-foot="right" className={box} width={W} height={H} viewBox={`0 0 ${W} ${H}`}
        style={{ right: -(R + 1), overflow: 'visible' }}>
        <path d={`M${R + 0.5} ${R + 0.5} A${R} ${R} 0 0 1 0.5 0.5 L0 0.5 L0 ${H} L${R + 0.5} ${H} Z`} style={{ fill: 'var(--card)' }} />
        <path d={`M${R + 0.5} ${R + 0.5} A${R} ${R} 0 0 1 0.5 0.5`} style={{ fill: 'none', stroke: STROKE, strokeWidth: 1 }} />
      </svg>
    </>
  );
}
