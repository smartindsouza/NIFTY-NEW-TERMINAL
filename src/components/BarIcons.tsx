import React from 'react';

// THE ROW OF FIVE'S ICONS (17 Nov 2026). Martin, with a picture of Lemonn's
// row (Range, Interval, Indicators, Drawings, Settings): "Use the same icons
// for my app as well." Lemonn's are its own drawings, not in the icon set the
// app uses, so these four are drawn here to the same idea: a dotted frame
// over a measured line for Range, a script fx for Indicators, a pencil
// leaving a line for Drawings, a cog with a solid hub for Settings. (Interval
// has no icon in either app — it shows the interval.) They take the colour of
// their text and the `size` the old icons took.
type P = { size?: number; className?: string };
const box = (size: number, className: string | undefined, kids: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
    strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{kids}</svg>
);

export const RangeIcon = ({ size = 18, className }: P) => box(size, className, <>
  {[4, 8, 12, 16, 20].map((x) => <circle key={`t${x}`} cx={x} cy={4.5} r={1} fill="currentColor" stroke="none" />)}
  {[8.5, 12.5].map((y) => [4, 20].map((x) => <circle key={`s${x}${y}`} cx={x} cy={y} r={1} fill="currentColor" stroke="none" />))}
  <path d="M4 19.5h16M4 17v5M20 17v5" />
</>);

// Strategy (27 Nov 2026). Martin: "Remove the range icon at the bottom of the
// chart screen and add a strategy icon." Drawn to the same weight as the
// others: two paths that start apart and cross on their way up — a plan with
// two legs, which is what the first strategy on its list (Jodi) is.
export const StrategyIcon = ({ size = 18, className }: P) => box(size, className, <>
  <path d="M4 19c5 0 6.5-14 16-14M4 5c5 0 6.5 14 16 14" />
  <path d="M17 3l3.2 2L17 7M17 17l3.2 2-3.2 2" />
</>);

export const IndicatorsIcon = ({ size = 18, className }: P) => box(size, className,
  <text x="12" y="18.5" textAnchor="middle" fill="currentColor" stroke="none"
    style={{ font: 'italic 700 20px Georgia, "Times New Roman", serif' }}>fx</text>);

export const DrawingsIcon = ({ size = 18, className }: P) => box(size, className, <>
  <path d="M21.6 5.9a2.05 2.05 0 0 0-2.9-2.9L9.2 12.5a1.6 1.6 0 0 0-.4.66l-.95 3.1a.4.4 0 0 0 .5.5l3.1-.94a1.6 1.6 0 0 0 .66-.4z" />
  <path d="M8.6 20.6c-2.6.9-6.1.3-6.1-1.9 0-2.5 4.3-1.7 4.3-4 0-1.5-1.9-2-3.5-1.4" />
</>);

export const SettingsIcon = ({ size = 18, className }: P) => box(size, className, <>
  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
  <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
</>);
