import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { cn } from '@/lib/utils';
import { parseContract, orderName } from '../lib/optionName';
import {
  type Basis, type Period, type Tally, type Cell,
  istDay, sessionDay, addDays, dayMonth, dayTitle, periodRange, shiftPeriod, dayTallies, sumDays, valueOf, quality,
  monthGrid, weekCells, monthWeeks, yearMonths, profitAndLoss, compact,
} from '../lib/journalStats';
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Eye, EyeOff, Pencil, RefreshCw, Trash2, WalletMinimal, X } from 'lucide-react';

// THE TRADE JOURNAL IS LEMONN'S POSITIONS SCREEN (17 Nov 2026).
// Martin, with four pictures of Lemonn (Positions, the wallet, Orders and
// Historical P&L): "Change the trade journal to this layout with the positions
// card at the top", "Show the order screen below the positions card with the
// open and history separated", the wallet button "to show the fund details",
// "add the total trades, Win Rate and the charges to the positions card", and
// in each card of the list "the qty, entry and exit price and time etc as shown
// in my app trade journal". "The P&L analysis button in the positions card open
// the 4th screenshot." So this file is three screens:
//   /journal            the card of returns, then the trades: Open | History
//   /journal/funds      the wallet button: what Zerodha says the account holds
//   /journal/analysis   Historical P&L: day, week, month, year, each stepped
//
// EVERY SIZE HERE IS MEASURED OFF HIS PICTURES, not judged by eye. They are
// 1290px wide — a 430pt phone at 3 pixels a point — so a pixel count divided by
// three is a CSS pixel, and each text's size is the Manrope size whose width it
// has. That is why the numbers below are odd ones (a 239px card, text 19px
// down): they are where Lemonn's ink is. Every text's box is one line tall
// (leading-none), each "top" was set so that the ink in a picture of this page
// lands where the ink is in his — to within a third of a point, a phone's
// pixel — and the pictures were then measured again to check it.
// The surfaces and the text are the app's own theme, as on the chart's cards
// and on ScalpPro, so the light theme works and the page belongs to the app;
// the chips, the reds, greens and blues are Lemonn's.
//
// WHAT THE OLD PAGE KNEW, THIS ONE KNOWS. Charges and their breakdown, net,
// the balance after a trade, what the chart showed at the entry, correcting a
// price and deleting a row are one tap away, inside a trade's card. Import from
// Kite, Excel and the date range are behind "Filter". Nothing was taken out of
// the data.
//
// THE WHOLE JOURNAL IS LOADED ONCE and every period is cut from it here, so D,
// W, M and Y switch at once and the calendar can colour any day.

interface JournalTrade {
  id: number;
  tradingsymbol: string;
  exchange: string;
  option_type: string | null;
  strike: number | null;
  side: string;
  qty: number;
  product: string;
  entry_price: number | null;
  entry_time: number | null;
  entry_spot: number | null;
  context: any;
  test_mode: number;
  simulated: number;
  status: string;
  exit_price: number | null;
  exit_time: number | null;
  exit_reason: string | null;
  pnl: number | null;
  kite_user_id?: string | null;
  locked?: number;
  // Charges and capital — worked out by the server (server/trade_charges.ts) and
  // sent with each row. charges_src says where the figure came from: 'zerodha'
  // is Zerodha's own calculation for the trade's orders; anything else is the
  // formula at that day's rates, shown as "est.".
  charges?: number | null;
  charges_src?: 'zerodha' | 'rates' | 'builtin' | null;
  charges_breakdown?: { brokerage: number; stt: number; exchange: number; sebi: number; stamp: number; gst: number; total: number } | null;
  charges_orders?: number | null;
  net_pnl?: number | null;
  capital_after?: number | null;
}
// One trading day's capital: what Zerodha reported as the opening balance, what
// was added or withdrawn, and what was left once the day's closed trades and
// their charges are counted. Only present for days the balance was recorded.
interface DayCapital { opening: number; added: number; withdrawn: number; left: number; inOpen: number; openTrades: number; carriedIn: number; carriedTrades: number; complete: boolean }
interface ChargeRates {
  from: string; source: 'zerodha' | 'builtin'; checkedOn: string | null; changes: string[] | null;
  brokerage: number; sttSellPct: number; exchangePct: number; sebiPerCrore: number; stampBuyPct: number; gstPct: number;
}

// Money to the paisa.
const inr2 = (v: number | null | undefined) =>
  v === null || v === undefined || isNaN(v) ? '—' : `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Returns, with their sign in front as Lemonn writes them: +₹0.00, -₹211.25.
const signed = (v: number | null | undefined) =>
  v === null || v === undefined || isNaN(v) ? '—' : `${v < 0 ? '-' : '+'}₹${Math.abs(Number(v)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Lemonn's green and red (their +₹0.00 is green). The lighter pair is for a
// light surface, where theirs would be too pale to read.
const GREEN = 'text-[#1f8a57] dark:text-[#5baa79]';
const RED = 'text-[#c9364a] dark:text-[#d45a62]';
const tone = (v: number | null | undefined) => (v === null || v === undefined || isNaN(v) ? 'text-muted-foreground' : v < 0 ? RED : GREEN);
const timeOf = (ms: number | null) => {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).toUpperCase(); } catch { return '—'; }
};
const stored = (key: string, fallback: string) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const store = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* private mode */ } };

// Lemonn's chips: 18pt tall, 4pt corners, 10px words. Blue for what happened to
// it, green for a buy, red for a sell; amber is this app's own, for a row that
// is not what it seems (a test, a simulation, an estimated entry).
const CHIP = 'h-[18px] px-2 rounded-[4px] text-[10px] leading-[18px] font-medium whitespace-nowrap';
const CHIP_BLUE = 'bg-primary/15 text-primary';
const CHIP_RED = 'bg-[#fde8ea] text-[#c9364a] dark:bg-[#3f2124] dark:text-[#e5505f]';
const CHIP_GREEN = 'bg-[#dff5ea] text-[#1f8a57] dark:bg-[#143023] dark:text-[#37ad75]';
const CHIP_AMBER = 'bg-primary/15 text-primary';
const LINK = 'text-primary';
// Why a trade ended, in a word. KITE is a row built from Zerodha's own list of
// fills (Import from Kite), which does not say why.
const REASON: Record<string, string> = { MANUAL: 'Manual', TP: 'Target', TARGET: 'Target', SL: 'Stop', STOP: 'Stop', EOD: 'Day end', KITE: 'Kite' };
const reasonWord = (r: string | null) => {
  if (!r) return 'Closed';
  const k = String(r).trim().toUpperCase();
  return REASON[k] || (k.length <= 14 ? k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, ' ') : 'Closed');
};

// The two small arrowheads beside "Total Returns" (6.67 by 9pt in Lemonn).
const SortMark = () => (
  <svg width="7" height="9" viewBox="0 0 7 9" aria-hidden="true"><path d="M3.5 0 7 3.6H0zM3.5 9 0 5.4h7z" fill="currentColor" /></svg>
);

// A cell of a breakdown — a day of the calendar, a day of the week, a week, a
// month. 58pt tall with 8pt corners; the number sits where Lemonn's does and a
// second line under it carries what the cell made (or "Today").
function BreakdownCell({ cell, basis, isToday, selected, onPick }: { cell: Cell; basis: Basis; isToday: boolean; selected?: boolean; onPick?: () => void }) {
  const v = valueOf(cell.tally, basis);
  const traded = cell.tally.closed > 0;
  const state = !traded ? (isToday ? 'today' : 'none') : v > 0 ? 'profit' : v < 0 ? 'loss' : 'flat';
  const second = traded ? `${v < 0 ? '-' : ''}${compact(v)}` : isToday ? 'Today' : cell.sub || '';
  return (
    <button type="button" onClick={onPick} data-cell={cell.from} data-cell-state={state}
      className={cn('relative h-[58px] rounded-[8px] border border-transparent text-[10px] leading-none font-medium',
        state === 'profit' ? 'bg-[#cdeedd] text-[#1f6f49] dark:bg-[#285a38] dark:text-[#d2f2df]'
          : state === 'loss' ? 'bg-[#fbdfe2] text-[#a82d3e] dark:bg-[#5a2529] dark:text-[#f8d0d4]'
          : state === 'today' ? 'bg-primary/15 text-primary dark:text-foreground/75 border-primary/40'
          : 'bg-foreground/[0.1] text-muted-foreground',
        selected && 'ring-1 ring-foreground/70')}>
      <span className={cn('absolute inset-x-0', second ? 'top-[15.3px]' : 'top-[23px]')}>{cell.label}</span>
      {second && <span className={cn('absolute inset-x-0 top-[31.3px] truncate px-0.5', state === 'today' && 'dark:text-primary', traded && 'font-semibold')}>{second}</span>}
    </button>
  );
}

const LEGEND: [string, string][] = [
  ['Profit', 'bg-[#3fa76a] dark:bg-[#285a38]'], ['Loss', 'bg-[#d9596a] dark:bg-[#5a2529]'],
  ['No trades', 'bg-foreground/30 dark:bg-[#494949]'], ['Today', 'bg-primary/40'],
];

type RangeKey = 'ALL' | 'TODAY' | '7' | '30' | 'CUSTOM';
const RANGES: [RangeKey, string][] = [['ALL', 'All'], ['TODAY', 'Today'], ['7', '7 days'], ['30', '30 days'], ['CUSTOM', 'Custom']];
const DAYS_A_PAGE = 10;

export default function TradeJournal() {
  const [location, navigate] = useLocation();
  const view: 'main' | 'analysis' | 'funds' = location.startsWith('/journal/analysis') ? 'analysis' : location.startsWith('/journal/funds') ? 'funds' : 'main';
  useEffect(() => { try { window.scrollTo(0, 0); } catch { /* no window */ } }, [view]);

  // The clock, read once a minute, so the day turns over on a page left open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(iv); }, []);
  // Two days. `today` is the date in India and names things ("Today",
  // "Yesterday", the calendar's Today cell). `session` is the day the card's
  // figures are for: it stays on the session that has just ended until 9:00 AM
  // IST, so the day's trades are still "D" in the evening and through the night
  // (see sessionDay).
  const today = istDay(now);
  const session = sessionDay(now);

  // Returns as Zerodha shows them, or after the charges. One switch for all
  // three screens (the arrowheads beside "Total Returns"), remembered.
  const [basis, setBasis] = useState<Basis>(() => (stored('journalBasis', 'gross') === 'net' ? 'net' : 'gross'));
  const flipBasis = () => setBasis((b) => { const n = b === 'gross' ? 'net' : 'gross'; store('journalBasis', n); return n; });
  // The card is always NOW: this session, this week, this month, this year.
  const [period, setPeriod] = useState<Period>('D');
  // Historical P&L can be stepped back and forth, so it has a day of its own.
  const [aPeriod, setAPeriod] = useState<Period>('D');
  const [aAnchor, setAAnchor] = useState<string>(session);
  const [dots, setDots] = useState(() => stored('journalDots', '1') !== '0');
  // Open | History. Until one is tapped it is Open when a trade is open and
  // History otherwise: an empty "Open" list is a wasted first screen.
  const [tabPick, setTabPick] = useState<'OPEN' | 'HISTORY' | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['trade-journal', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/journal?limit=20000');
      if (!res.ok) throw new Error('Failed to load journal');
      const j = await res.json();
      return j as { trades: JournalTrade[]; note?: string; accountId?: string; days?: Record<string, DayCapital>; rates?: ChargeRates | null };
    },
    refetchOnWindowFocus: false,
  });
  const trades = useMemo(() => data?.trades || [], [data]);
  const byDay = useMemo(() => dayTallies(trades), [trades]);
  const days = data?.days || {};
  const rates = data?.rates || null;

  // What is open right now, from the broker: the same answer (and the same
  // cached question) as the chart page's "Your Positions" card. openPnl is the
  // card's Unrealised Returns; each position's pnl is its open trade's.
  const { data: pos } = useQuery({
    queryKey: ['chart-cards-positions'],
    queryFn: async () => { const r = await fetch('/api/positions-live'); if (!r.ok) throw new Error('positions'); return r.json(); },
    enabled: view !== 'funds', refetchInterval: 5000, staleTime: 4000, placeholderData: (p: any) => p,
  });
  const live = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of Array.isArray(pos?.positions) ? pos.positions : []) {
      const sym = String(p?.tradingsymbol || '').toUpperCase();
      if (sym && Number.isFinite(Number(p.pnl))) m.set(sym, Number(p.pnl));
    }
    return m;
  }, [pos]);
  const unrealised = Number.isFinite(Number(pos?.openPnl)) ? Number(pos.openPnl) : 0;
  // A position opened or closed is a row the journal has to show: ask again.
  // Only on a CHANGE — the first answer from the broker is not one (the page
  // has just loaded the journal, and each load has the server check its book
  // against the broker's).
  const openCount = live.size;
  const posKnown = pos !== undefined;
  const openSeen = useRef(false);
  useEffect(() => {
    if (!posKnown) return;
    if (!openSeen.current) { openSeen.current = true; return; }
    const t = setTimeout(() => { refetch(); }, 1500);
    return () => clearTimeout(t);
  }, [openCount, posKnown]);   // eslint-disable-line react-hooks/exhaustive-deps

  const { data: funds, isLoading: fundsLoading } = useQuery({
    queryKey: ['journal-funds'],
    queryFn: async () => { const r = await fetch('/api/margins'); if (!r.ok) throw new Error('margins'); return r.json(); },
    enabled: view === 'funds', refetchInterval: 15000,
  });
  const [fundsMore, setFundsMore] = useState(false);

  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);   // the header's sync button, while it turns
  const importKite = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const res = await fetch('/api/journal/import-kite', { method: 'POST' });
      const d = await res.json().catch(() => ({ success: false, error: 'Bad response' }));
      if (!d.success) { toast.error(d.error || 'Import failed'); return; }
      if (d.imported === 0) toast.info((d.skipped || 0) > 0 ? 'Up to date' : (d.note || 'No fills today'));
      else toast.success(`Imported ${d.imported}`);
      refetch();
    } catch { toast.error('Import failed'); }
    finally { setImporting(false); }
  };
  // The export wants both ends; without them it answers for today only.
  // THE FILE IS FETCHED, NOT GONE TO (18 Nov 2026). Martin, with the phone on a
  // black page showing the .xlsx and "Open in Excel": "Once the trade journal is
  // downloaded as excel sheet, this screen appears and I'm not able to go back
  // to the app". The button sent the whole app to the file's address. In a
  // browser tab that is a download; in the app on an iPhone's home screen there
  // are no tabs and no back button, so the file's preview REPLACED the app and
  // the only way back was to close it. The app now stays where it is: it reads
  // the file itself and hands it to the phone's share sheet (Save to Files,
  // Excel…), or, where there is no such sheet — a desktop — saves it as a
  // download. The sheet must follow a tap; if the file took too long for the
  // first tap to still count, a toast offers the tap again.
  const xlsxBusy = useRef(false);
  const downloadExcel = async (from: string, to: string) => {
    if (xlsxBusy.current) return;
    xlsxBusy.current = true;
    try {
      const r = await fetch(`/api/journal/export.xlsx?from=${from}&to=${to}`);
      if (!r.ok) throw new Error(String(r.status));
      const name = /filename="?([^";]+)"?/i.exec(r.headers.get('Content-Disposition') || '')?.[1] || `trades_${from}_to_${to}.xlsx`;
      const blob = await r.blob();
      const file = new File([blob], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const nav: any = navigator;
      const phone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (phone && nav.share && nav.canShare?.({ files: [file] })) {
        const share = () => nav.share({ files: [file] });
        try { await share(); }
        catch (e: any) {
          if (e?.name === 'AbortError') return;                       // he closed the sheet
          toast('Excel file ready', { duration: 15000, action: { label: 'Save', onClick: () => { share().catch(() => {}); } } });
        }
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { toast.error('Could not make the Excel file'); }
    finally { xlsxBusy.current = false; }
  };

  // ----- Filter: which of the history is listed -----
  const [filterOpen, setFilterOpen] = useState(false);
  const [range, setRange] = useState<RangeKey>('ALL');
  const [customFrom, setCustomFrom] = useState<string>(() => addDays(istDay(Date.now()), -6));
  const [customTo, setCustomTo] = useState<string>(() => istDay(Date.now()));
  const [kind, setKind] = useState<'ALL' | 'CE' | 'PE'>('ALL');
  const [result, setResult] = useState<'ALL' | 'WIN' | 'LOSS'>('ALL');
  // A backwards pair (From after To) is read the sensible way round.
  const [cFrom, cTo] = customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom];
  const listFrom = range === 'CUSTOM' ? cFrom : range === 'TODAY' ? today : range === '7' ? addDays(today, -6) : range === '30' ? addDays(today, -29) : null;
  const listTo = range === 'CUSTOM' ? cTo : range === 'ALL' ? null : today;
  const filtered = range !== 'ALL' || kind !== 'ALL' || result !== 'ALL';
  const [pages, setPages] = useState(1);
  useEffect(() => { setPages(1); }, [range, cFrom, cTo, kind, result, tabPick]);

  // ----- the open card: what the old rows spelled out -----
  const [openId, setOpenId] = useState<number | null>(null);
  const [costOpen, setCostOpen] = useState<number | null>(null);
  // Correcting a price by hand. Zerodha's trade list only covers today, so a
  // position carried in from a previous day has no entry price the import can
  // read — it has to come from the user, and it has to survive the next rebuild.
  const [editId, setEditId] = useState<number | null>(null);
  const [editEntry, setEditEntry] = useState('');
  const [editExit, setEditExit] = useState('');
  const startEdit = (t: JournalTrade) => {
    setEditId(t.id);
    setEditEntry(t.entry_price == null ? '' : String(t.entry_price));
    setEditExit(t.exit_price == null ? '' : String(t.exit_price));
  };
  const saveEdit = async (t: JournalTrade) => {
    try {
      const res = await fetch(`/api/journal/${t.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_price: editEntry === '' ? null : Number(editEntry), exit_price: editExit === '' ? null : Number(editExit) }),
      });
      const d = await res.json().catch(() => ({ success: false }));
      if (!d.success) { toast.error(d.error || 'Not saved'); return; }
      toast.success('Saved');
      setEditId(null);
      refetch();
    } catch { toast.error('Not saved'); }
  };
  // Deleting a row takes two taps, like the chart's Exit: the first arms it for
  // three seconds. It used to go on one, from a bin beside the P&L of every row.
  const [delArm, setDelArm] = useState<number | null>(null);
  useEffect(() => { if (delArm === null) return; const t = setTimeout(() => setDelArm(null), 3000); return () => clearTimeout(t); }, [delArm]);
  const handleDelete = async (id: number) => {
    if (delArm !== id) { setDelArm(id); return; }
    setDelArm(null);
    try { await fetch(`/api/journal/${id}`, { method: 'DELETE' }); refetch(); } catch { /* the row stays */ }
  };

  // What a trade made, on the page's basis; an open one, what it is making now.
  const returnsOf = (t: JournalTrade): number | null => {
    if (t.status !== 'CLOSED') { const l = live.get(String(t.tradingsymbol || '').toUpperCase()); return l === undefined ? null : l; }
    if (basis === 'net') return t.net_pnl ?? (t.pnl == null ? null : t.pnl - (t.charges || 0));
    return t.pnl;
  };

  // A TRADE'S CARD: Lemonn's order card (90pt, 12pt corners, three lines) with
  // this journal's own facts on it — when it was in and out, what and how many,
  // the two prices and what it made. A tap opens the rest.
  // (This and the other pieces below are plain functions called while the page
  // renders, not components of their own. A component declared inside this one
  // would be a new type on every render and be thrown away and rebuilt each
  // time: the correction fields would lose the cursor at every keystroke.)
  const tradeCard = (t: JournalTrade) => {
    const open = t.status !== 'CLOSED';
    const ctx = t.context || {};
    const r = returnsOf(t);
    const expanded = openId === t.id;
    const inDay = istDay(t.entry_time), outDay = istDay(t.exit_time);
    const out = open ? '' : ` → ${outDay !== inDay && t.exit_time ? `${dayMonth(outDay)} ` : ''}${timeOf(t.exit_time)}`;
    const details = 'text-[12px] leading-4 font-medium text-muted-foreground';
    return (
      <div key={t.id} data-trade={t.id} data-trade-state={open ? 'open' : 'closed'} className="rounded-[12px] bg-card border border-border">
        <button type="button" onClick={() => { setOpenId(expanded ? null : t.id); setEditId(null); setCostOpen(null); }}
          className="relative block w-full text-left pl-[12.5px] pr-3 pt-[16px] pb-[13px] text-[12px] leading-none">
          <div data-trade-line="when" className="font-medium text-muted-foreground/80 pr-[150px] truncate">{t.product || 'NRML'} • {timeOf(t.entry_time)}{out}</div>
          <div className="absolute right-3 top-3 flex items-center gap-2">
            {t.test_mode ? <span className={cn(CHIP, CHIP_AMBER)}>Test</span> : null}
            {t.simulated ? <span className={cn(CHIP, CHIP_AMBER)}>Sim</span> : null}
            {/* Entry is Kite's previous close, not a price this account paid: the
                returns under it are only as good as that. Correct it inside. */}
            {ctx.basisIsClose ? <span className={cn(CHIP, CHIP_AMBER)}>Est.</span> : null}
            <span data-trade-chip="state" className={cn(CHIP, CHIP_BLUE)}>{open ? 'Open' : reasonWord(t.exit_reason)}</span>
            <span data-trade-chip="side" className={cn(CHIP, t.side === 'SELL' ? CHIP_RED : CHIP_GREEN)}>{t.side === 'SELL' ? 'Sell' : 'Buy'}</span>
          </div>
          <div className="mt-[13px] flex items-center justify-between gap-3">
            <span data-trade-line="name" className="font-semibold text-foreground truncate" title={t.tradingsymbol}>{orderName(t.tradingsymbol)}</span>
            <span data-trade-line="qty" className="shrink-0 font-medium text-foreground">Qty {t.qty}</span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span data-trade-line="prices" className="font-semibold text-muted-foreground/80 truncate">Entry {inr2(t.entry_price)}{open ? '' : ` • Exit ${inr2(t.exit_price)}`}</span>
            <span data-trade-returns="" className={cn('shrink-0 font-semibold', tone(r))}>{signed(r)}</span>
          </div>
        </button>
        {expanded && (
          <div data-trade-more="" className={cn('mx-[12.5px] mr-3 pt-3 pb-3 border-t border-border space-y-2', details)}>
            <div className="flex items-center gap-x-4 gap-y-1 flex-wrap">
              <span>In <span className="text-foreground">{dayMonth(inDay)}, {timeOf(t.entry_time)}</span></span>
              {!open && <span>Out <span className="text-foreground">{dayMonth(outDay)}, {timeOf(t.exit_time)}</span></span>}
              {/* Carried in from the previous day: entry is Kite's previous close,
                  the same basis Kite uses for the day's P&L on that position. */}
              {ctx.carried ? <span className={cn(CHIP, CHIP_BLUE)}>Carried</span> : null}
              {t.locked ? <span className={cn(CHIP, CHIP_GREEN)}>Edited</span> : null}
            </div>
            {/* Charges, what the trade made after them, and the account balance
                once it was closed. "est." means the figure is the formula at
                that day's rates rather than Zerodha's own for the trade's orders. */}
            {t.charges != null && (
              <div className="flex items-center gap-x-4 gap-y-1 flex-wrap">
                <button type="button" data-trade-act="charges" onClick={() => setCostOpen(costOpen === t.id ? null : t.id)} className="flex items-center gap-1">
                  Charges <span className="text-foreground">{inr2(t.charges)}</span>
                  {t.charges_src !== 'zerodha' && <span className={cn(CHIP, CHIP_AMBER)}>est.</span>}
                  <ChevronDown className={cn('w-3 h-3 transition-transform', costOpen === t.id && 'rotate-180')} />
                </button>
                {t.pnl != null && <span>Gross <span className={tone(t.pnl)}>{signed(t.pnl)}</span></span>}
                {t.net_pnl != null && <span>Net <span className={tone(t.net_pnl)}>{signed(t.net_pnl)}</span></span>}
                {t.capital_after != null && <span>Balance <span className="text-foreground">{inr2(t.capital_after)}</span></span>}
              </div>
            )}
            {costOpen === t.id && t.charges_breakdown && (
              <div data-trade-costs="" className="flex items-center gap-x-3 gap-y-1 flex-wrap">
                {([['Brokerage', t.charges_breakdown.brokerage], ['STT', t.charges_breakdown.stt], ['Exchange', t.charges_breakdown.exchange], ['SEBI', t.charges_breakdown.sebi], ['Stamp', t.charges_breakdown.stamp], ['GST', t.charges_breakdown.gst]] as const)
                  .map(([k, v]) => <span key={k}>{k} <span className="text-foreground">{Number(v).toFixed(2)}</span></span>)}
                {t.charges_orders != null && <span>Orders <span className="text-foreground">{t.charges_orders}</span></span>}
              </div>
            )}
            {/* What the chart showed when the trade was taken. */}
            {(['spot', 'rsi', 'oiBias', 'timeframe', 'support', 'resistance', 'pdh', 'pdl'] as const).some((k) => ctx[k] !== null && ctx[k] !== undefined && ctx[k] !== '') && (
              <div data-trade-context="" className="flex items-center gap-x-3 gap-y-1 flex-wrap">
                {([['Spot', ctx.spot], ['RSI', ctx.rsi], ['OI', ctx.oiBias], ['TF', ctx.timeframe], ['S', ctx.support], ['R', ctx.resistance], ['PDH', ctx.pdh], ['PDL', ctx.pdl]] as const)
                  .filter(([, v]) => v !== null && v !== undefined && v !== '')
                  .map(([k, v]) => <span key={k}>{k} <span className="text-foreground">{typeof v === 'number' ? v.toFixed(2) : String(v)}</span></span>)}
              </div>
            )}
            {editId === t.id ? (
              <div className="flex items-center gap-2 flex-wrap pt-0.5">
                <label className="flex items-center gap-1.5">Entry
                  <input value={editEntry} onChange={(e) => setEditEntry(e.target.value)} inputMode="decimal" data-edit="entry"
                    className="w-20 h-8 bg-background border border-border rounded-[8px] px-2 text-foreground text-center focus:outline-none focus:ring-1 focus:ring-foreground/40" />
                </label>
                {!open && (
                  <label className="flex items-center gap-1.5">Exit
                    <input value={editExit} onChange={(e) => setEditExit(e.target.value)} inputMode="decimal" data-edit="exit"
                      className="w-20 h-8 bg-background border border-border rounded-[8px] px-2 text-foreground text-center focus:outline-none focus:ring-1 focus:ring-foreground/40" />
                  </label>
                )}
                <button type="button" data-edit="save" onClick={() => saveEdit(t)} aria-label="Save" className={cn('h-8 w-8 rounded-[8px] flex items-center justify-center bg-foreground/[0.08]', GREEN)}><Check className="w-4 h-4" /></button>
                <button type="button" onClick={() => setEditId(null)} aria-label="Cancel" className="h-8 w-8 rounded-[8px] flex items-center justify-center bg-foreground/[0.08]"><X className="w-4 h-4" /></button>
              </div>
            ) : (
              <div className="flex items-center gap-2 pt-0.5">
                <button type="button" data-trade-act="edit" onClick={() => startEdit(t)} className="h-8 px-2.5 rounded-[8px] flex items-center gap-1.5 bg-foreground/[0.08] text-foreground/90"><Pencil className="w-3.5 h-3.5" />Correct price</button>
                <button type="button" data-trade-act="delete" onClick={() => handleDelete(t.id)}
                  className={cn('h-8 px-2.5 rounded-[8px] flex items-center gap-1.5', delArm === t.id ? 'bg-[#d43f52] text-white' : cn('bg-foreground/[0.08]', RED))}>
                  <Trash2 className="w-3.5 h-3.5" />{delArm === t.id ? 'Confirm' : 'Delete'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // The day's money, under a day's trades: what the account opened with and what
  // was left, and — a tap away — what was added or withdrawn, the day's charges
  // and net, and what is tied up in open trades. The opening balance is
  // Zerodha's own figure for the day; days from before it was being recorded
  // have no line.
  const [capOpen, setCapOpen] = useState<string | null>(null);
  const dayCapitalLine = (day: string) => {
    const cap = days[day];
    const s = byDay.get(day);
    if (!cap) return null;
    const more = capOpen === day;
    return (
      <div data-day-capital={day} className="pt-0.5 text-[12px] leading-4 font-medium text-muted-foreground">
        <button type="button" onClick={() => setCapOpen(more ? null : day)} className="flex items-center gap-1.5">
          Opened <span className="text-foreground">{inr2(cap.opening)}</span>
          <ChevronRight className="w-3 h-3 opacity-60" />
          Left <span className="text-foreground">{cap.complete ? '' : '≈ '}{inr2(cap.left)}</span>
          <ChevronDown className={cn('w-3 h-3 transition-transform', more && 'rotate-180')} />
        </button>
        {more && (
          <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap mt-1">
            {cap.added > 0 && <span>Added <span className="text-foreground">{inr2(cap.added)}</span></span>}
            {cap.withdrawn > 0 && <span>Withdrawn <span className="text-foreground">{inr2(cap.withdrawn)}</span></span>}
            {s && <span>Charges <span className="text-foreground">{inr2(s.charges)}</span></span>}
            {s && s.closed > 0 && <span>Net <span className={tone(s.net)}>{signed(s.net)}</span></span>}
            {cap.openTrades > 0 && <span>In open trades <span className="text-foreground">{inr2(cap.inOpen)}</span></span>}
            {/* A position bought on an earlier day and sold today is listed under
                the day it was bought, but its money came back today. Named here,
                or opened + net would not reach "left". */}
            {cap.carriedTrades > 0 && <span>Carried in <span className="text-foreground">{inr2(cap.carriedIn)}</span></span>}
          </div>
        )}
      </div>
    );
  };

  // THE LIST: days, newest first, each a row that opens (the newest starts
  // open), ten days at a time. Lemonn's distances: 22pt from a line to the next
  // day's name, 18 from the name to its first card, 12 between cards and from
  // the last card to the line.
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});
  const tradeList = (rows: JournalTrade[], scope: string, empty: string, paged: boolean) => {
    if (isLoading) return <div className="text-center text-muted-foreground py-12 text-[12px]">Loading…</div>;
    if (data?.note) return <div data-journal-empty="" className="text-center text-muted-foreground py-12 text-[12px]">{data.note}</div>;
    if (!rows.length) {
      return (
        <div data-journal-empty="" className="flex flex-col items-center gap-4 py-12 text-muted-foreground">
          <span className="text-[12px] font-medium">{empty}</span>
          <button type="button" onClick={importKite} disabled={importing} className="h-9 px-4 rounded-[8px] border border-foreground/80 text-[12px] font-semibold text-foreground disabled:opacity-50">
            {importing ? 'Importing…' : 'Import from Kite'}
          </button>
        </div>
      );
    }
    const groups: { day: string; rows: JournalTrade[] }[] = [];
    for (const t of rows) {
      const day = istDay(t.entry_time);
      let g = groups.find((x) => x.day === day);
      if (!g) { g = { day, rows: [] }; groups.push(g); }
      g.rows.push(t);
    }
    groups.sort((a, b) => (a.day < b.day ? 1 : -1));
    const shown = paged ? groups.slice(0, pages * DAYS_A_PAGE) : groups;
    return (
      <div>
        {shown.map((g, i) => {
          const key = `${scope}:${g.day}`;
          const isOpen = openDays[key] ?? i === 0;
          return (
            <div key={g.day} data-day={g.day} data-day-open={isOpen ? '1' : '0'} className="border-b border-border">
              <button type="button" onClick={() => setOpenDays((o) => ({ ...o, [key]: !isOpen }))} className="relative block w-full text-left pt-[23px] pb-[17px]">
                <span className="block text-[12px] leading-none font-semibold text-foreground/90">{dayTitle(g.day, today)}</span>
                {/* Lemonn's arrowhead is 12pt across, its stroke included — this
                    one in a 20.5px box — and it is hung on the row, not set in
                    it, so the row is as tall as the day's name and no taller. */}
                <span className="absolute right-[1.7px] top-[17.8px] text-muted-foreground/80">{isOpen ? <ChevronUp size={20.5} strokeWidth={2} /> : <ChevronDown size={20.5} strokeWidth={2} />}</span>
              </button>
              {isOpen && <div className="space-y-3 pb-3">{g.rows.map((t) => tradeCard(t))}{dayCapitalLine(g.day)}</div>}
            </div>
          );
        })}
        {paged && groups.length > shown.length && (
          <button type="button" data-journal="more" onClick={() => setPages((p) => p + 1)}
            className="block mx-auto mt-4 h-9 w-24 rounded-[8px] border border-foreground text-[12px] font-semibold text-foreground active:bg-foreground/10">Load more</button>
        )}
      </div>
    );
  };

  // ================================ THE WALLET ================================
  // "Keep the wallet button to show the fund details as shown in the 2nd
  // screenshot." Lemonn's has Deposit, Withdraw and All Transactions; Zerodha
  // gives an app none of the three, so they are not here. What it does give is
  // the margin statement, in its own words.
  if (view === 'funds') {
    const eq = funds?.live ? funds?.margins?.equity : null;
    const av = eq?.available || {}, ut = eq?.utilised || {};
    const num = (v: any) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
    const rows: [string, number | null][] = [
      ['Opening balance', num(av.opening_balance)], ['Available cash', num(av.cash)], ['Payin', num(av.intraday_payin)], ['Payout', num(ut.payout)],
      ['Option premium', num(ut.option_premium)], ['SPAN', num(ut.span)], ['Exposure', num(ut.exposure)], ['Collateral', num(av.collateral)],
    ];
    return (
      <div data-journal-page="funds" className="w-full md:max-w-[560px] mx-auto min-h-screen">
        <div className="relative h-[224px] rounded-b-[16px] border-b border-foreground/[0.2] overflow-hidden text-center text-foreground"
          style={{ backgroundImage: 'radial-gradient(60% 75% at 50% 38%, color-mix(in srgb, var(--foreground) 7%, transparent), transparent)' }}>
          <button type="button" data-journal="back" aria-label="Back" onClick={() => navigate('/journal')} className="absolute left-[14px] top-[22px] h-10 w-10 flex items-center justify-center active:opacity-60"><ArrowLeft size={24} strokeWidth={1.8} /></button>
          {data?.accountId && <span data-funds="account" className={cn('absolute right-4 top-[36px] text-[12px] leading-none font-semibold', LINK)}>{data.accountId}</span>}
          <div className="absolute inset-x-0 top-[82px] text-[12px] leading-none font-semibold">Available Margin</div>
          <div data-funds="balance" className="absolute inset-x-0 top-[110px] text-[32px] leading-none font-bold">{eq ? inr2(num(eq.net)) : fundsLoading ? '…' : '—'}</div>
          <div data-funds="used" className="absolute inset-x-0 top-[166px] text-[12px] leading-none font-bold">{eq ? `Used Margin ${inr2(num(ut.debits))}` : funds && !funds.live ? 'Log in to Zerodha' : ''}</div>
          {eq && (
            <button type="button" data-funds="more" onClick={() => setFundsMore((m) => !m)} className="absolute left-1/2 -translate-x-1/2 top-[178px] h-7 px-3 text-[12px] leading-none font-medium text-primary">
              {fundsMore ? 'Hide details' : 'View details'}
            </button>
          )}
        </div>
        {eq && fundsMore && (
          <div data-funds="rows" className="mx-4 mt-6 rounded-[12px] bg-card border border-border px-3 text-[12px] leading-none font-medium">
            {rows.filter(([, v]) => v !== null).map(([k, v], i) => (
              <div key={k} className={cn('flex items-center justify-between h-11', i > 0 && 'border-t border-border')}>
                <span className="text-muted-foreground">{k}</span><span className="font-semibold text-foreground">{inr2(v)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // The returns of a period: Lemonn's green card (red for a loss).
  const returnsCard = (tally: Tally, withLive: boolean, extra?: ReactNode) => {
    const realised = valueOf(tally, basis);
    const total = realised + (withLive ? unrealised : 0);
    return (
      <div data-journal-card="total" data-tone={total < 0 ? 'loss' : 'profit'} className={cn('rounded-[12px] border text-center',
        total < 0
          ? 'border-[#eeb5bc] dark:border-[#6b2f36] bg-[linear-gradient(180deg,#fdecee_0%,var(--card)_62%)] dark:bg-[linear-gradient(180deg,#2c1418_0%,var(--card)_62%)]'
          : 'border-[#a9dcc0] dark:border-[#2f6b45] bg-[linear-gradient(180deg,#e6f7ee_0%,var(--card)_62%)] dark:bg-[linear-gradient(180deg,#0d291d_0%,var(--card)_62%)]')}>
        <button type="button" data-journal="basis" onClick={flipBasis} className="mt-[18.5px] mx-auto flex items-center text-[12px] leading-none font-medium text-muted-foreground">
          {basis === 'net' ? 'Net returns' : 'Total returns'}
        </button>
        <div data-journal="total" className={cn('mt-[14.5px] text-[24px] leading-none font-extrabold', tone(total))}>{signed(total)}</div>
        <div className="mt-[20.5px] mx-3 h-px bg-border" />
        <div className="mt-[18px] mx-3 flex items-center justify-between text-[12px] leading-none font-[550] text-muted-foreground"><span>Unrealised Returns</span><span>Realised Returns</span></div>
        <div className="mt-[8.5px] mx-3 pb-[19px] flex items-center justify-between text-[16px] leading-none font-[650] text-foreground/75">
          <span data-journal="unrealised">{withLive ? signed(unrealised) : '—'}</span><span data-journal="realised">{signed(realised)}</span>
        </div>
        {extra}
      </div>
    );
  };

  // ============================== HISTORICAL P&L ==============================
  if (view === 'analysis') {
    const r = periodRange(aPeriod, aAnchor);
    const tally = sumDays(byDay, r.from, r.to);
    const q = quality(tally, basis);
    const prevR = periodRange(aPeriod, shiftPeriod(aPeriod, aAnchor, -1));
    const prev = sumDays(byDay, prevR.from, prevR.to);
    const diff = valueOf(tally, basis) - valueOf(prev, basis);
    const inRange = trades.filter((t) => { const d = istDay(t.entry_time); return d >= r.from && d <= r.to; });
    const side = (type: 'CE' | 'PE') => {
      const rows = inRange.filter((t) => (parseContract(t.tradingsymbol)?.optionType || t.option_type) === type);
      return sumDays(dayTallies(rows), r.from, r.to);
    };
    const calls = side('CE'), puts = side('PE');
    const cells: (Cell | null)[] = aPeriod === 'D' ? monthGrid(byDay, aAnchor).flat() : aPeriod === 'W' ? weekCells(byDay, aAnchor) : aPeriod === 'M' ? monthWeeks(byDay, aAnchor) : yearMonths(byDay, aAnchor);
    const pl = profitAndLoss(cells, basis);
    const hasToday = (c: Cell) => c.from <= today && c.to >= today;
    // A tap on a cell goes one step closer: a month to its weeks, a week to its
    // days, a day to that day's trades.
    const drill = (c: Cell) => {
      if (aPeriod === 'D') { setAAnchor(c.from); return; }
      setAPeriod(aPeriod === 'Y' ? 'M' : aPeriod === 'M' ? 'W' : 'D');
      // A week cut off by the month's edge is still that week: anchor inside it.
      setAAnchor(c.from <= today && c.to >= today ? today : c.from);
    };
    const what = aPeriod === 'D' ? 'Daily' : aPeriod === 'W' ? 'Weekly' : aPeriod === 'M' ? 'Monthly' : 'Yearly';
    const round = 'h-7 w-7 rounded-full border border-foreground/[0.2] flex items-center justify-center text-foreground active:bg-foreground/10';
    return (
      <div data-journal-page="analysis" className="w-full md:max-w-[560px] mx-auto min-h-screen">
        <div className="h-12 pl-5 pr-4 flex items-center">
          <button type="button" data-journal="back" aria-label="Back" onClick={() => navigate('/journal')} className="h-10 w-10 -ml-3 flex items-center justify-center text-foreground active:opacity-60"><ArrowLeft size={24} strokeWidth={1.8} /></button>
          <h1 className="ml-[8px] flex-1 text-[18px] leading-none font-semibold text-foreground">Historical P&L</h1>
          {/* The calendar button is a date field with the picture of a button over
              it: a tap opens the phone's own date picker. */}
          <label data-journal="jump" aria-label="Go to a date" className={cn(round, 'relative overflow-hidden')}>
            <CalendarDays size={13} strokeWidth={2} />
            <input type="date" value={aAnchor} max={today} onChange={(e) => { if (e.target.value) { setAPeriod('D'); setAAnchor(e.target.value); } }}
              className="absolute inset-0 opacity-0 w-full h-full" />
          </label>
          <button type="button" data-journal="excel" aria-label="Excel" title="Excel" onClick={() => downloadExcel(r.from, r.to > today ? today : r.to)} className={cn(round, 'ml-[6px]')}><Download size={13} strokeWidth={2} /></button>
        </div>
        <div data-journal-tabs="" className="h-12 grid grid-cols-4 text-[12px] leading-none">
          {([['D', "Today's"], ['W', 'Week'], ['M', 'Month'], ['Y', 'Year']] as const).map(([k, label]) => (
            <button key={k} type="button" data-tab={k} aria-pressed={aPeriod === k} onClick={() => setAPeriod(k)}
              className={cn('pt-[2px] border-b-2', aPeriod === k ? 'border-foreground text-foreground font-semibold' : 'border-transparent text-muted-foreground font-medium')}>{label}</button>
          ))}
        </div>
        <div className="bg-card pt-[30px] pb-[26px] flex items-center justify-center gap-[9px]">
          <button type="button" data-journal="prev" aria-label="Earlier" onClick={() => setAAnchor(shiftPeriod(aPeriod, aAnchor, -1))} className="h-6 w-6 rounded-full border border-foreground/[0.25] flex items-center justify-center text-foreground"><ChevronLeft size={11} strokeWidth={2.2} /></button>
          <span data-journal="period" className="text-[14px] leading-none font-semibold text-foreground">{r.label}</span>
          <button type="button" data-journal="next" aria-label="Later" disabled={r.to >= today} onClick={() => setAAnchor(shiftPeriod(aPeriod, aAnchor, 1))} className="h-6 w-6 rounded-full bg-foreground/[0.2] flex items-center justify-center text-foreground disabled:text-foreground/40"><ChevronRight size={11} strokeWidth={2.2} /></button>
        </div>
        <div className="bg-card">
          <div className="rounded-t-[24px] bg-background px-4 pt-1 pb-8">
            {returnsCard(tally, r.from <= session && r.to >= session, aPeriod !== 'D' && (
              <div className="mx-3 mb-3 px-3 py-[11px] rounded-[8px] bg-foreground/[0.06] grid grid-cols-2 gap-y-[9px] text-[12px] leading-none font-medium text-muted-foreground text-left">
                <span>Win rate <span data-journal="winrate" className="text-foreground font-semibold">{q.winRate === null ? '—' : `${Math.round(q.winRate)}%`}</span></span>
                <span className="text-right">Avg profit <span className={GREEN}>{signed(q.avgProfit)}</span></span>
                <span>Trades <span data-journal="trades" className="text-foreground font-semibold">{tally.trades}</span></span>
                <span className="text-right">Avg loss <span className={RED}>{signed(q.avgLoss)}</span></span>
              </div>
            ))}

            <div data-journal-card="breakdown" className="mt-[32px] rounded-[16px] border border-border bg-card">
              <div className="flex items-center justify-between pl-3 pr-[13px] h-[52px] border-b border-border">
                <span className="text-[14px] leading-none font-semibold text-foreground">{what} breakdown</span>
                {aPeriod !== 'D' && (
                  <span className="flex items-center gap-2">
                    <span className={cn(CHIP, CHIP_GREEN)}>₹{compact(pl.profit)}</span><span className={cn(CHIP, CHIP_RED)}>₹{compact(pl.loss)}</span>
                  </span>
                )}
              </div>
              {aPeriod === 'D' && (
                <div className="grid grid-cols-7 gap-[6px] px-[14px] pt-[14px] text-center text-[10px] leading-none font-medium text-muted-foreground">
                  {['S', 'M', 'T', 'W', 'TH', 'F', 'S'].map((d, i) => <span key={i}>{d}</span>)}
                </div>
              )}
              <div className={cn('grid gap-[6px] px-[14px]', aPeriod === 'D' ? 'grid-cols-7 pt-[16px]' : aPeriod === 'W' ? 'grid-cols-5 pt-[16px]' : aPeriod === 'M' ? 'grid-cols-3 pt-[16px]' : 'grid-cols-4 pt-[16px]')}>
                {cells.map((c, i) => c
                  ? <BreakdownCell key={c.from} cell={c} basis={basis} isToday={hasToday(c)} selected={aPeriod === 'D' && c.from === aAnchor && c.from !== today} onPick={() => drill(c)} />
                  : <span key={`blank${i}`} />)}
              </div>
              <div className="flex items-center gap-[22px] pl-3 pt-[19.5px] pb-[18.5px] text-[10px] leading-none font-medium text-muted-foreground">
                {LEGEND.map(([name, dot]) => <span key={name} className="flex items-center gap-[6px]"><i className={cn('w-[7.3px] h-[7.3px] rounded-full', dot)} />{name}</span>)}
              </div>
            </div>

            {aPeriod !== 'D' && (
              <div data-journal-card="compare" className="mt-4 rounded-[16px] border border-border bg-card px-[13px] py-4 text-[12px] leading-none font-medium">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[14px] font-semibold text-foreground">P&L comparison</div>
                    <span className={cn(CHIP, 'inline-block mt-[10px]', !tally.closed && !prev.closed ? 'bg-foreground/[0.1] text-muted-foreground' : diff >= 0 ? CHIP_GREEN : CHIP_RED)}>
                      {!tally.closed && !prev.closed ? 'No trades' : `₹${compact(diff)} ${diff >= 0 ? 'up' : 'down'}`} · vs {aPeriod === 'W' ? 'last week' : aPeriod === 'M' ? 'last month' : 'last year'}
                    </span>
                  </div>
                  <div className="text-right"><div className="text-[14px] font-semibold text-foreground">{tally.trades}</div><div className="mt-[8px] text-[10px] text-muted-foreground">Trades</div></div>
                </div>
                <div className="grid grid-cols-2 gap-3 mt-4">
                  {([['Calls', calls], ['Puts', puts]] as const).map(([name, s]) => (
                    <div key={name} className={cn(name === 'Puts' && 'text-right')}>
                      <div className="text-muted-foreground">{name}: {s.trades}</div>
                      <div className={cn('mt-[8px] text-[14px] font-semibold', s.closed ? tone(valueOf(s, basis)) : 'text-muted-foreground')}>{s.closed ? signed(valueOf(s, basis)) : '—'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {aPeriod === 'D' && <div data-journal-list="day" className="mt-1">{tradeList(inRange, 'a', 'No trades', false)}</div>}
          </div>
        </div>
      </div>
    );
  }

  // ================================ THE JOURNAL ================================
  const r = periodRange(period, session);
  const tally = sumDays(byDay, r.from, r.to);
  const q = quality(tally, basis);
  const realised = valueOf(tally, basis);
  const total = realised + unrealised;
  const week = weekCells(byDay, today);
  const anyEstimate = trades.some((t) => t.charges != null && t.charges_src !== 'zerodha');
  const openTrades = trades.filter((t) => t.status !== 'CLOSED');
  const tab = tabPick ?? (openTrades.length ? 'OPEN' : 'HISTORY');
  const history = trades.filter((t) => {
    if (t.status !== 'CLOSED') return false;
    const d = istDay(t.entry_time);
    if (listFrom && d < listFrom) return false;
    if (listTo && d > listTo) return false;
    if (kind !== 'ALL' && (parseContract(t.tradingsymbol)?.optionType || t.option_type) !== kind) return false;
    if (result !== 'ALL') { const v = returnsOf(t) || 0; if (result === 'WIN' ? v <= 0 : v >= 0) return false; }
    return true;
  });
  const firstDay = trades.reduce((m, t) => { const d = istDay(t.entry_time); return d !== 'unknown' && d < m ? d : m; }, today);
  const label = 'absolute text-[12px] leading-none font-[550] text-muted-foreground';
  const figure = 'absolute text-[16px] leading-none font-[650] text-foreground/90';
  const dotClass = (c: Cell) => {
    if (!dots) return 'bg-foreground/[0.09] text-muted-foreground';
    const v = valueOf(c.tally, basis);
    if (c.tally.closed > 0 && v > 0) return 'bg-[#cdeedd] text-[#1f6f49] dark:bg-[#285a38] dark:text-[#d2f2df]';
    if (c.tally.closed > 0 && v < 0) return 'bg-[#fbdfe2] text-[#a82d3e] dark:bg-[#5a2529] dark:text-[#f8d0d4]';
    if (c.from === today) return 'bg-primary/15 text-primary';
    return c.from < today ? 'bg-foreground/[0.09] text-muted-foreground' : 'bg-foreground/[0.18] text-muted-foreground';
  };
  const option = (on: boolean) => cn('h-8 px-3.5 rounded-full text-[12px] leading-none font-medium', on ? 'bg-primary text-primary-foreground' : 'border border-foreground/[0.2] text-foreground/90');
  const act = 'h-9 flex-1 rounded-[8px] border border-foreground/80 text-[12px] font-semibold text-foreground disabled:opacity-50 active:bg-foreground/10';
  return (
    <div data-journal-page="main" className="w-full md:max-w-[560px] mx-auto min-h-screen">
      <div className="flex items-center justify-between px-[17px] pt-4 pb-[17px]">
        <h1 className="text-[18px] leading-none font-[650] text-foreground">Journal</h1>
        {/* SYNC POSITIONS, BESIDE THE WALLET (17 Nov 2026). Martin: "Move the
            refresh positions button to the journal screen beside the wallet icon
            at the top right of the screen". It was in the chart's Settings. A
            circle like the wallet's, 14pt from it, as Lemonn's two header
            buttons are. It asks the open-positions card (mounted for the whole
            app) to read the positions from Zerodha again, which says what it
            found; the arrows turn while it does. */}
        <div className="flex items-center gap-[14px]">
          <button type="button" data-journal="sync" aria-label="Sync positions from Zerodha" title="Sync positions from Zerodha"
            onClick={() => { setSyncing(true); try { window.dispatchEvent(new CustomEvent('sync_positions_request')); } catch (e) {} window.setTimeout(() => setSyncing(false), 1200); }}
            className="h-[38px] w-[38px] rounded-full border border-foreground/[0.15] flex items-center justify-center text-foreground active:bg-foreground/10"><RefreshCw size={17} strokeWidth={1.9} className={syncing ? 'animate-spin' : ''} /></button>
          <button type="button" data-journal="wallet" aria-label="Funds" title="Funds" onClick={() => navigate('/journal/funds')}
            className="h-[38px] w-[38px] rounded-full border border-foreground/[0.15] flex items-center justify-center text-foreground active:bg-foreground/10"><WalletMinimal size={18} strokeWidth={1.9} /></button>
        </div>
      </div>

      {/* THE CARD. 239pt tall: Lemonn's 180 and one more row of the same rhythm
          (label, 21pt, figure, 38pt) for the three things it does not have —
          trades, win rate, charges. Everything in it is placed by where
          Lemonn's ink is, measured from the card's own top edge. */}
      {/* THE APP'S OWN TWO COLOURS (18 Nov 2026). Martin: "maintain the same
          colors for dark/light backgrounds in all the screens. I think the
          background colors in the trade journal is different compared to other
          screens". The journal's bands were a wash of the text colour over the
          page (a neutral grey no other screen has) and its trade rows the
          same; they are the theme's card colour now, as the chart's bars and
          the home page's cards are, on the theme's background. */}
      <div className="bg-card px-3 pt-[25px] pb-[14px]">
        <div data-journal-card="returns" className="relative h-[239px] rounded-[16px] border border-foreground/[0.18] bg-card">
          <button type="button" data-journal="basis" onClick={flipBasis} className="absolute left-3 top-[19px] flex items-center gap-[6px] text-[12px] leading-none font-semibold text-muted-foreground">
            {basis === 'net' ? 'Net Returns' : 'Total Returns'}<span className="text-foreground/90"><SortMark /></span>
          </button>
          <div data-journal="total" className={cn('absolute left-3 top-[40px] text-[20px] leading-none font-extrabold', tone(total))}>{signed(total)}</div>
          <div data-journal-seg="period" className="absolute right-3 top-4 h-[34px] rounded-full border border-foreground/[0.2] p-1 flex">
            {(['D', 'W', 'M', 'Y'] as const).map((k) => (
              <button key={k} type="button" data-seg={k} aria-pressed={period === k} onClick={() => setPeriod(k)}
                className={cn('h-6 w-6 rounded-full text-[9.5px] leading-none font-semibold', period === k ? 'bg-primary text-primary-foreground' : 'text-foreground/90')}>{k}</button>
            ))}
          </div>
          <div className={cn(label, 'left-3 top-[82px]')}>Unrealised Returns</div>
          <div className={cn(label, 'right-3 top-[82px]')}>Realised Returns</div>
          <div data-journal="unrealised" className={cn(figure, 'left-3 top-[101.5px]')}>{signed(unrealised)}</div>
          <div data-journal="realised" className={cn(figure, 'right-3 top-[101.5px]')}>{signed(realised)}</div>
          <div className={cn(label, 'left-3 top-[141px]')}>Total Trades</div>
          <div className={cn(label, 'left-1/2 -translate-x-1/2 top-[141px]')}>Win Rate</div>
          <div className={cn(label, 'right-3 top-[141px]')}>Charges</div>
          <div data-journal="trades" className={cn(figure, 'left-3 top-[160.5px]')}>{tally.trades}</div>
          <div data-journal="winrate" className={cn(figure, 'left-1/2 -translate-x-1/2 top-[160.5px]')}>{q.winRate === null ? '—' : `${Math.round(q.winRate)}%`}</div>
          <div data-journal="charges" className={cn(figure, 'right-3 top-[160.5px]')}>{inr2(tally.charges)}</div>
          <div className="absolute left-3 right-3 top-[192px] h-px bg-border" />
          <div className="absolute left-3 top-[205px] h-4 flex items-center">
            <div className="flex items-center gap-2">
              {week.map((c, i) => (
                <span key={c.from} data-dot={c.from} title={c.sub} className={cn('h-4 w-4 rounded-full flex items-center justify-center text-[8.5px] leading-none font-semibold', dotClass(c))}>{'MTWTF'[i]}</span>
              ))}
            </div>
            <button type="button" data-journal="dots" aria-label={dots ? 'Hide the days' : 'Show the days'} onClick={() => setDots((d) => { store('journalDots', d ? '0' : '1'); return !d; })}
              className="ml-[8px] h-8 w-8 -my-2 flex items-center justify-center text-foreground/70">
              {dots ? <Eye size={15} strokeWidth={1.8} /> : <EyeOff size={15} strokeWidth={1.8} />}
            </button>
          </div>
          <button type="button" data-journal="analysis" onClick={() => { setAPeriod(period); setAAnchor(session); navigate('/journal/analysis'); }}
            className="absolute right-[12.5px] top-[198px] h-8 pl-3 flex items-center gap-px text-[12px] leading-none font-medium text-muted-foreground">
            P&L Analysis <ChevronRight size={15} strokeWidth={2.4} />
          </button>
        </div>
      </div>

      {/* THE TRADES, on Lemonn's black sheet with its rounded shoulders. */}
      <div className="bg-card">
        <div className="rounded-t-[24px] bg-background px-4 pt-6 pb-8">
          <div data-journal-tabs="" className="grid grid-cols-2 gap-4">
            {(['OPEN', 'HISTORY'] as const).map((k) => (
              <button key={k} type="button" data-tab={k} aria-pressed={tab === k} onClick={() => setTabPick(k)}
                className={cn('h-8 rounded-full text-[12px] leading-none font-medium', tab === k ? 'bg-primary text-primary-foreground' : 'border border-foreground/[0.2] text-foreground/90')}>{k === 'OPEN' ? 'Open' : 'History'}</button>
            ))}
          </div>
          <div className="mt-[24px] mb-[4px] flex items-center justify-between">
            <h2 className="text-[16px] leading-none font-[650] text-foreground/90">{tab === 'OPEN' ? 'Open Trades' : filtered ? 'Trades' : 'All Trades'}</h2>
            <button type="button" data-journal="filter" data-filtered={filtered ? '1' : '0'} onClick={() => setFilterOpen(true)} className={cn('relative top-px h-8 -my-2 pl-3 pr-2 text-[12px] leading-none font-medium', LINK)}>Filter{filtered ? ' •' : ''}</button>
          </div>
          <div data-journal-list={tab === 'OPEN' ? 'open' : 'history'}>
            {tab === 'OPEN' ? tradeList(openTrades, 'o', 'No open trades', false) : tradeList(history, 'h', 'No trades', true)}
          </div>

          {/* Where the charges come from and which rates are in force — said once,
              at the bottom, and only when asked for. A change of rate still says
              so by itself. */}
          {rates && (
            <details data-journal="rates" className="mt-6 text-[11px] leading-relaxed text-muted-foreground">
              <summary className="cursor-pointer select-none">Charges{anyEstimate ? ' · some estimated' : ''}
                {rates.changes && rates.changes.length > 0 && <span className="ml-1.5 text-primary">Rates changed {dayMonth(rates.from)}</span>}</summary>
              <div className="mt-1.5">
                Zerodha's own figure for each order; "est." is worked out from the rates instead.{' '}
                {rates.checkedOn ? `Rates checked ${dayMonth(rates.checkedOn)}: ` : 'Rates not yet checked: '}
                brokerage ₹{rates.brokerage} an order · STT {rates.sttSellPct}% of sell value · exchange {rates.exchangePct}% · SEBI ₹{rates.sebiPerCrore} a crore · stamp {rates.stampBuyPct}% of buy value · GST {rates.gstPct}%.
                {rates.changes && rates.changes.length > 0 && <div className="mt-1 text-primary">{rates.changes.join(' · ')}</div>}
              </div>
            </details>
          )}
        </div>
      </div>

      {/* FILTER: which of the history is listed, and the three things the old
          page kept in its header — Import from Kite, Refresh, Excel. */}
      {filterOpen && (
        <div data-journal-sheet="filter" className="fixed inset-0 z-[80]">
          <div className="absolute inset-0 bg-black/50" onClick={() => setFilterOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 md:left-[80px] md:right-6 md:max-w-[560px] md:mx-auto rounded-t-[24px] bg-card border-t border-foreground/[0.12] px-4 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
            <div className="flex items-center justify-between">
              <span className="text-[16px] leading-none font-[650] text-foreground">Filter</span>
              <button type="button" data-filter="clear" onClick={() => { setRange('ALL'); setKind('ALL'); setResult('ALL'); }} className={cn('h-8 px-2 text-[12px] font-medium', filtered ? LINK : 'text-muted-foreground/60')}>Clear</button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {RANGES.map(([k, name]) => <button key={k} type="button" data-filter-range={k} aria-pressed={range === k} onClick={() => setRange(k)} className={option(range === k)}>{name}</button>)}
            </div>
            {range === 'CUSTOM' && (
              <div className="mt-3 flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
                <input type="date" aria-label="From" data-filter="from" value={customFrom} max={today} onChange={(e) => e.target.value && setCustomFrom(e.target.value)}
                  className="h-9 flex-1 min-w-0 px-2 rounded-[8px] bg-background border border-border text-foreground focus:outline-none" />
                <span>to</span>
                <input type="date" aria-label="To" data-filter="to" value={customTo} max={today} onChange={(e) => e.target.value && setCustomTo(e.target.value)}
                  className="h-9 flex-1 min-w-0 px-2 rounded-[8px] bg-background border border-border text-foreground focus:outline-none" />
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {([['ALL', 'Calls & Puts'], ['CE', 'Calls'], ['PE', 'Puts']] as const).map(([k, name]) => <button key={k} type="button" data-filter-kind={k} aria-pressed={kind === k} onClick={() => setKind(k)} className={option(kind === k)}>{name}</button>)}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {([['ALL', 'Profit & Loss'], ['WIN', 'Profit'], ['LOSS', 'Loss']] as const).map(([k, name]) => <button key={k} type="button" data-filter-result={k} aria-pressed={result === k} onClick={() => setResult(k)} className={option(result === k)}>{name}</button>)}
            </div>
            <div className="mt-5 pt-4 border-t border-border flex items-center gap-2">
              {/* Today's real fills from Zerodha — including trades placed in the
                  Kite app, which this journal would otherwise never see. Safe to
                  press repeatedly: each leg carries a unique fingerprint, so
                  nothing doubles. */}
              <button type="button" data-journal="import" onClick={importKite} disabled={importing} className={act}>{importing ? 'Importing…' : 'Import from Kite'}</button>
              <button type="button" data-journal="refresh" onClick={() => refetch()} disabled={isFetching} className={act}>{isFetching ? 'Refreshing…' : 'Refresh'}</button>
              <button type="button" data-journal="excel" onClick={() => downloadExcel(listFrom || firstDay, listTo || today)} className={act}>Excel</button>
            </div>
            <button type="button" data-filter="done" onClick={() => setFilterOpen(false)} className="mt-3 h-10 w-full rounded-[10px] bg-primary text-primary-foreground text-[13px] font-semibold">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
