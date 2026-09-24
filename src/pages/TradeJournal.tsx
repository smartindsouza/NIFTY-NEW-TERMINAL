import { useState } from 'react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { contractName } from '../lib/optionName';
import { BookOpen, RefreshCw, TrendingUp, TrendingDown, Trash2, Sparkles, Download, FileSpreadsheet, Pencil, Check, X } from 'lucide-react';

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
}

// IST calendar day for a timestamp — the journal is organised by trading day, and
// the browser may not be in IST (Dubai is UTC+4).
const istDay = (ms: number | null | undefined): string => {
  if (!ms) return 'unknown';
  return new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);
};
const istDayLabel = (day: string): string => {
  if (day === 'unknown') return 'Undated';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN',
    { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
// Days back from today, as an IST YYYY-MM-DD.
const istDaysAgo = (n: number): string => istDay(Date.now() - n * 86400000);

const RANGES = [
  { key: 'TODAY', label: 'Today', days: 0 },
  { key: 'WEEK', label: '7 days', days: 6 },
  { key: 'MONTH', label: '30 days', days: 29 },
  { key: 'ALL', label: 'All', days: null as number | null },
] as const;
// 'CUSTOM' sits outside the preset list: it has no day count, only the two dates
// the user picks.
type RangeKey = typeof RANGES[number]['key'] | 'CUSTOM';

const inr = (v: number | null | undefined) =>
  v === null || v === undefined || isNaN(v) ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const fmtTime = (ms: number | null) => {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  } catch { return '—'; }
};

function StatCard({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' | 'neutral' }) {
  return (
    <div className="bg-card rounded-xl p-4 flex flex-col gap-1 min-w-0">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn('text-lg font-bold font-mono truncate',
        tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-foreground')}>
        {value}
      </span>
    </div>
  );
}

function Chip({ label, value }: { label: string; value: any }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-md bg-popover text-muted-foreground whitespace-nowrap">
      <span className="opacity-60">{label}</span>
      <span className="text-foreground">{typeof value === 'number' ? value.toFixed(2) : String(value)}</span>
    </span>
  );
}

export default function TradeJournal() {
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');
  // The journal keeps every day now, so a range has to be chosen rather than
  // assumed. Today first, because that is the usual question.
  const [range, setRange] = useState<RangeKey>('TODAY');
  // Custom period, as IST YYYY-MM-DD — the same form the presets use, so the
  // server filter, the summary cards and the Excel export all work unchanged.
  // Defaults to the last 7 days so opening Custom shows something useful.
  const [customFrom, setCustomFrom] = useState<string>(() => istDaysAgo(6));
  const [customTo, setCustomTo] = useState<string>(() => istDay(Date.now()));
  const today = istDay(Date.now());
  const preset = range === 'CUSTOM' ? null : RANGES.find((r) => r.key === range)!;
  const rangeDays = preset ? preset.days : null;
  // A backwards pair (From after To) is read the sensible way round rather than
  // returning nothing.
  const [cFrom, cTo] = customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom];
  const from = range === 'CUSTOM' ? cFrom : (rangeDays === null ? null : istDaysAgo(rangeDays));
  const to = range === 'CUSTOM' ? cTo : (rangeDays === null ? null : istDay(Date.now()));

  const downloadExcel = () => {
    const qs = from && to ? `?from=${from}&to=${to}` : '';
    window.location.href = `/api/journal/export.xlsx${qs}`;
  };

  const [importing, setImporting] = useState(false);
  const importKite = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const res = await fetch('/api/journal/import-kite', { method: 'POST' });
      const d = await res.json().catch(() => ({ success: false, error: 'Bad response' }));
      if (!d.success) { toast.error(d.error || 'Import failed.'); return; }
      if (d.imported === 0 && (d.skipped || 0) > 0) toast.success('Already up to date — nothing new to import.');
      else if (d.imported === 0) toast.info(d.note || 'Zerodha reported no fills today.');
      else toast.success(`Imported ${d.imported} trade${d.imported === 1 ? '' : 's'} from Zerodha.`);
      refetch();
    } catch (e: any) {
      toast.error('Network error importing from Zerodha.');
    } finally { setImporting(false); }
  };

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['trade-journal', from, to],
    queryFn: async () => {
      const qs = from && to ? `?from=${from}&to=${to}` : '';
      const res = await fetch(`/api/journal${qs}`);
      if (!res.ok) throw new Error('Failed to load journal');
      const j = await res.json();
      return j as { trades: JournalTrade[]; note?: string; accountId?: string };
    },
    refetchOnWindowFocus: false,
  });

  const trades = data?.trades || [];
  const shown = trades.filter((t) => filter === 'ALL' ? true : t.status === filter);

  // Every figure below is for the SELECTED RANGE and the logged-in account only.
  // It used to total every closed row in the table regardless of whose it was,
  // which is what made Realised P&L wrong after a second account signed in.
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const wins = closed.filter((t) => (t.pnl || 0) > 0).length;
  const winRate = closed.length ? Math.round((wins / closed.length) * 100) : 0;
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);

  // Grouped by trading day, newest first, each with its own realised total.
  const byDay: { day: string; rows: JournalTrade[]; pnl: number }[] = [];
  for (const t of shown) {
    const day = istDay(t.entry_time);
    let g = byDay.find((x) => x.day === day);
    if (!g) { g = { day, rows: [], pnl: 0 }; byDay.push(g); }
    g.rows.push(t);
    if (t.status === 'CLOSED') g.pnl += t.pnl || 0;
  }
  byDay.sort((a, b) => (a.day < b.day ? 1 : -1));

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
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entry_price: editEntry === '' ? null : Number(editEntry),
          exit_price: editExit === '' ? null : Number(editExit),
        }),
      });
      const d = await res.json().catch(() => ({ success: false }));
      if (!d.success) { toast.error(d.error || 'Could not save the correction.'); return; }
      toast.success('Corrected — this row is now locked against re-imports.');
      setEditId(null);
      refetch();
    } catch { toast.error('Network error saving the correction.'); }
  };

  const handleDelete = async (id: number) => {
    try {
      await fetch(`/api/journal/${id}`, { method: 'DELETE' });
      refetch();
    } catch { /* ignore */ }
  };

  return (
    <div className="px-2 py-3 md:p-8 max-w-[1200px] w-full mx-auto pb-24 min-h-screen">
      <div className="relative bg-card border border-border rounded-xl p-4 flex items-center justify-between gap-3 mb-4 flex-wrap overflow-hidden before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-primary/40 before:to-transparent">
        <div className="flex items-center gap-2.5">
          <BookOpen className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-lg md:text-2xl font-bold tracking-tight whitespace-nowrap">Trade Journal</h1>
            
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Pull today's real fills from Zerodha — including trades placed in the
              Kite app, which this journal would otherwise never see. Safe to press
              repeatedly: each leg carries a unique fingerprint, so nothing doubles. */}
          <button
            onClick={importKite}
            disabled={importing}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl bg-card hover:bg-popover transition-colors text-muted-foreground disabled:opacity-50"
          >
            <Download className={cn('w-3.5 h-3.5', importing && 'animate-pulse')} />
            {importing ? 'Importing…' : 'Import from Kite'}
          </button>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl bg-card hover:bg-popover transition-colors text-muted-foreground"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
          </button>
          <button
            onClick={downloadExcel}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 transition-colors text-emerald-300"
            title="Download these trades as an Excel workbook"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
          </button>
        </div>
      </div>

      {/* Summary. The caption names the exact period the figures cover, so a
          screenshot or a shared report is self-explanatory. */}
      <div className="text-[11px] text-muted-foreground mb-1.5">
        {from && to
          ? (from === to ? `Report for ${istDayLabel(from)}` : `Report: ${istDayLabel(from)} – ${istDayLabel(to)}`)
          : 'Report: all trades'}
        <span className="opacity-60"> · by entry date, IST</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-2.5 md:gap-3 mb-4">
        <StatCard label="Total Trades" value={String(trades.length)} />
        <StatCard label="Closed" value={String(closed.length)} />
        <StatCard label="Win Rate" value={closed.length ? `${winRate}%` : '—'} tone={winRate >= 50 ? 'pos' : closed.length ? 'neg' : 'neutral'} />
        <StatCard label="Realized P&L" value={inr(totalPnl)} tone={totalPnl > 0 ? 'pos' : totalPnl < 0 ? 'neg' : 'neutral'} />
      </div>

      {/* Range — the record is permanent now, so the window is explicit. */}
      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setRange(r.key)}
            className={cn('text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-colors',
              range === r.key ? 'bg-emerald-500/15 text-emerald-300' : 'bg-card text-muted-foreground hover:text-foreground')}
          >
            {r.label}
          </button>
        ))}
        <button
          onClick={() => setRange('CUSTOM')}
          className={cn('text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-colors',
            range === 'CUSTOM' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-card text-muted-foreground hover:text-foreground')}
        >
          Custom
        </button>
        {range === 'CUSTOM' && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              From
              <input type="date" value={customFrom} max={today}
                onChange={(e) => e.target.value && setCustomFrom(e.target.value)}
                className="h-7 px-2 rounded-md bg-card border border-border text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              To
              <input type="date" value={customTo} max={today}
                onChange={(e) => e.target.value && setCustomTo(e.target.value)}
                className="h-7 px-2 rounded-md bg-card border border-border text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
            </label>
          </div>
        )}
        {data?.accountId && (
          <span className="ml-auto text-[10px] font-mono text-muted-foreground">Account {data.accountId}</span>
        )}
      </div>

      {/* Filter */}
      <div className="flex items-center gap-1.5 mb-3">
        {(['ALL', 'OPEN', 'CLOSED'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn('text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-colors',
              filter === f ? 'bg-primary/15 text-primary' : 'bg-card text-muted-foreground hover:text-foreground')}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Phase 2 hint */}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground bg-card/60 border border-dashed border-border rounded-xl px-3 py-2 mb-4">
        <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
        <span>Once a few trades are logged here, the next step adds a "Review with Claude" button that finds patterns across them.</span>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="text-center text-muted-foreground py-16 text-sm">Loading journal…</div>
      ) : data?.note ? (
        <div className="text-center text-muted-foreground py-16 text-sm">{data.note}</div>
      ) : shown.length === 0 ? (
        <div className="text-center text-muted-foreground py-16 text-sm">
          No trades in this range. Widen it above, or press "Import from Kite" to pull today's fills.
        </div>
      ) : (
        <div className="space-y-5">
          {byDay.map((g) => (
          <div key={g.day} className="space-y-2.5">
            {/* Day header with that day's realised total — the journal spans many
                days now, so rows need a date they belong to. */}
            <div className="flex items-center justify-between gap-3 px-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{istDayLabel(g.day)}</span>
              <span className={cn('text-[11px] font-mono font-bold',
                g.pnl > 0 ? 'text-emerald-400' : g.pnl < 0 ? 'text-rose-400' : 'text-muted-foreground')}>
                {g.rows.some((r) => r.status === 'CLOSED') ? inr(g.pnl) : '—'}
              </span>
            </div>
          {g.rows.map((t) => {
            const isBuy = t.side === 'BUY';
            const pnlPos = (t.pnl || 0) >= 0;
            const ctx = t.context || {};
            return (
              <div key={t.id} className="bg-card rounded-xl p-3.5 md:p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded', isBuy ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400')}>
                      {t.side}
                    </span>
                    {/* Readable contract, not the raw Zerodha symbol. The symbol
                        itself is on the tooltip for cross-checking against Kite. */}
                    <span className="font-mono text-sm font-semibold truncate" title={t.tradingsymbol}>{contractName(t.tradingsymbol)}</span>
                    {t.test_mode ? <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400">TEST</span> : null}
                    {t.simulated ? <span className="text-[9px] px-1 py-0.5 rounded bg-sky-500/15 text-sky-400">SIM</span> : null}
                    {/* Carried in from the previous day: entry is Kite's previous close,
                        the same basis Kite uses for the day's P&L on that position. */}
                    {ctx.carried ? <span className="text-[9px] px-1 py-0.5 rounded bg-violet-500/15 text-violet-300" title="Position carried in from a previous day">CARRIED</span> : null}
                    {ctx.basisIsClose ? <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-300" title="Entry is Kite's previous close, not a price this account paid — correct it with the pencil">EST. ENTRY</span> : null}
                    {t.locked ? <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300" title="Corrected by hand — re-imports will not overwrite it">EDITED</span> : null}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {t.status === 'CLOSED' ? (
                      <span className={cn('flex items-center gap-1 font-mono text-sm font-bold', pnlPos ? 'text-emerald-400' : 'text-rose-400')}>
                        {pnlPos ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                        {inr(t.pnl)}
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-primary/15 text-primary">OPEN</span>
                    )}
                    {editId === t.id ? (
                      <>
                        <button onClick={() => saveEdit(t)} className="text-emerald-400 hover:text-emerald-300 transition-colors p-1" title="Save correction">
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setEditId(null)} className="text-muted-foreground/60 hover:text-foreground transition-colors p-1" title="Cancel">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </>
                    ) : (
                      <button onClick={() => startEdit(t)} className="text-muted-foreground/50 hover:text-primary transition-colors p-1" title="Correct entry / exit price">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button onClick={() => handleDelete(t.id)} className="text-muted-foreground/50 hover:text-rose-400 transition-colors p-1" title="Delete entry">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {editId === t.id ? (
                  <div className="flex items-center gap-2 flex-wrap mt-2 text-[11px] font-mono">
                    <label className="flex items-center gap-1.5">
                      <span className="text-muted-foreground">Entry</span>
                      <input value={editEntry} onChange={(e) => setEditEntry(e.target.value)} inputMode="decimal"
                        className="w-24 h-8 bg-muted/40 border border-border rounded-md px-2 text-foreground text-center focus:outline-none focus:ring-1 focus:ring-primary" />
                    </label>
                    {t.status === 'CLOSED' && (
                      <label className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">Exit</span>
                        <input value={editExit} onChange={(e) => setEditExit(e.target.value)} inputMode="decimal"
                          className="w-24 h-8 bg-muted/40 border border-border rounded-md px-2 text-foreground text-center focus:outline-none focus:ring-1 focus:ring-primary" />
                      </label>
                    )}
                    <span className="text-[10px] text-muted-foreground">P&L recalculates on save</span>
                  </div>
                ) : null}

                <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-2 text-[11px] font-mono text-muted-foreground">
                  <span>Qty <span className="text-foreground">{t.qty}</span></span>
                  <span>Entry <span className="text-foreground">{inr(t.entry_price)}</span></span>
                  {t.status === 'CLOSED' && <span>Exit <span className="text-foreground">{inr(t.exit_price)}</span></span>}
                  <span className="opacity-70">{fmtTime(t.entry_time)}{t.status === 'CLOSED' ? ` → ${fmtTime(t.exit_time)}` : ''}</span>
                  {t.exit_reason && <span className="opacity-70">· {t.exit_reason}</span>}
                </div>

                {/* Context chips */}
                <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
                  <Chip label="spot" value={ctx.spot} />
                  <Chip label="RSI" value={ctx.rsi} />
                  <Chip label="OI" value={ctx.oiBias} />
                  <Chip label="tf" value={ctx.timeframe} />
                  <Chip label="S" value={ctx.support} />
                  <Chip label="R" value={ctx.resistance} />
                  <Chip label="PDH" value={ctx.pdh} />
                  <Chip label="PDL" value={ctx.pdl} />
                </div>
              </div>
            );
          })}
          </div>
          ))}
        </div>
      )}
    </div>
  );
}
