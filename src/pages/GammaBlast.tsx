import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Zap, TrendingUp, TrendingDown, RefreshCw, AlertTriangle, Clock } from 'lucide-react';

function Card({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'pos' | 'neg' | 'warn' | 'neutral' }) {
  const c = tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-400' : 'text-foreground';
  return (
    <div className="rounded-xl bg-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('text-base font-bold mt-0.5 font-mono', c)}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}


// Translate the screen's numbers into everyday language — no greeks needed.
// Answers: is today the day? how "dry" is the grass? where's the likely spark?
function plainWords(data: any, blast: any): { headline: string; tone: 'high' | 'mod' | 'low'; lines: string[] } {
  const lines: string[] = [];
  const isExp = !!data?.expiry?.isExpiryDay;
  const mins = data?.expiry?.minutesToClose;
  const regime = data?.gammaRegime;
  const spot = Number(data?.spot);
  const callWall = data?.pinning?.callWall;
  const putWall = data?.pinning?.putWall;
  const pinned = !!data?.pinning?.pinned;
  const maxPain = data?.pinning?.maxPain;
  const catalyst = data?.catalyst;

  // 1) Is today the day?
  if (!isExp) {
    lines.push('Today is NOT an expiry day, so a true gamma blast is unlikely — options still have time value cushioning them. Treat everything below as background reference.');
  } else if (typeof mins === 'number' && mins > 90) {
    lines.push(`Today IS expiry day. The blast window is the last ~90 minutes — still ${mins} minutes to close, so conditions can build but the spark usually comes later.`);
  } else if (typeof mins === 'number' && mins > 0) {
    lines.push(`Today IS expiry day and we are in the blast window (${mins} min to close) — this is when small index moves can violently reprice ATM options.`);
  } else {
    lines.push('Expiry session is over for today.');
  }

  // 2) How dry is the grass? (cheap + touchy options)
  const ce = data?.ce, pe = data?.pe;
  const cheapTxt = (ce != null && pe != null) ? `ATM options cost \u20b9${ce} (CE) / \u20b9${pe} (PE)` : 'ATM option prices unavailable';
  if (regime === 'LOADED') {
    lines.push(`The grass is dry: ${cheapTxt} — cheap and extremely touchy. A ~${blast?.movePts ?? '—'}-pt index move pays roughly +${blast?.ceGainPct ?? '—'}% on the CE or +${blast?.peGainPct ?? '—'}% on the PE.`);
  } else if (regime === 'ELEVATED') {
    lines.push(`Conditions are warming up: ${cheapTxt}. Sensitivity is elevated but not extreme — a ~${blast?.movePts ?? '—'}-pt move pays about +${blast?.ceGainPct ?? '—'}% (CE) / +${blast?.peGainPct ?? '—'}% (PE).`);
  } else {
    lines.push(`The grass is damp: options are not in blast condition right now (${cheapTxt}). Big percentage moves need much larger index swings today.`);
  }

  // 3) Where's the spark?
  const distCall = (Number.isFinite(spot) && callWall != null) ? Math.round(callWall - spot) : null;
  const distPut = (Number.isFinite(spot) && putWall != null) ? Math.round(spot - putWall) : null;
  if (catalyst === 'UP') {
    lines.push('A spark is already showing: price is breaking UP out of its recent range — if it keeps going, the CE side is the one that blasts.');
  } else if (catalyst === 'DOWN') {
    lines.push('A spark is already showing: price is breaking DOWN out of its recent range — if it keeps going, the PE side is the one that blasts.');
  } else if (pinned && maxPain != null) {
    lines.push(`No spark yet: sellers are holding price near ${maxPain} (max-pain pin). The blast only comes if price breaks decisively away from this level — until then expect stalling.`);
  } else if (distCall != null && distCall > 0 && distCall <= 40) {
    lines.push(`Watch the call wall at ${callWall}: price is only ${distCall} pts below it. Walls act like fences — they usually hold, but a clean break ABOVE turns trapped call sellers into fuel and favours the CE.`);
  } else if (distPut != null && distPut > 0 && distPut <= 40) {
    lines.push(`Watch the put wall at ${putWall}: price is only ${distPut} pts above it. If it breaks BELOW, trapped put sellers add fuel and the PE side is favoured.`);
  } else {
    lines.push('No spark yet: price is sitting inside its range, away from the big walls. Wait for a break of the range or a wall before expecting a blast.');
  }

  // Headline
  let tone: 'high' | 'mod' | 'low' = 'low';
  let headline = 'Blast possibility today: LOW';
  if (isExp && (typeof mins !== 'number' || mins > 0)) {
    const sparkNear = catalyst === 'UP' || catalyst === 'DOWN' || (distCall != null && distCall > 0 && distCall <= 40) || (distPut != null && distPut > 0 && distPut <= 40);
    if (regime === 'LOADED' && sparkNear) { tone = 'high'; headline = 'Blast possibility today: HIGH — dry grass and a spark nearby'; }
    else if (regime === 'LOADED' || (regime === 'ELEVATED' && sparkNear)) { tone = 'mod'; headline = 'Blast possibility today: MODERATE — conditions present, waiting on the spark'; }
    else { tone = 'low'; headline = 'Blast possibility today: LOW — expiry day, but options are not in blast condition'; }
  }
  return { headline, tone, lines };
}

export default function GammaBlast() {
  const [movePct, setMovePct] = useState(0.3);
  const { data, dataUpdatedAt, refetch, isFetching } = useQuery({
    queryKey: ['gamma-blast', movePct],
    queryFn: async () => { const r = await fetch(`/api/gamma-blast?movePct=${movePct}`); return await r.json(); },
    refetchInterval: 45000,
    refetchOnWindowFocus: true,
  });

  const ok = data?.success;
  const lvl = ok ? data.level : 'OFF';
  const banner = lvl === 'SETUP' ? 'bg-amber-500/15 border-amber-500/40' : lvl === 'WATCH' ? 'bg-sky-500/10 border-sky-500/30' : 'bg-card border-border';
  const bannerText = lvl === 'SETUP' ? 'text-amber-400' : lvl === 'WATCH' ? 'text-sky-400' : 'text-muted-foreground';
  const blast = ok ? data.blast : null;
  const plain = ok ? plainWords(data, blast) : null;

  return (
    <div className="max-w-3xl mx-auto px-4 py-5 pb-24">
      <div className="flex items-center gap-2 mb-1">
        <Zap className="w-5 h-5 text-amber-400" />
        <h1 className="text-lg font-bold text-foreground">Gamma Blast</h1>
      </div>
      <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
        On expiry day, tiny time-to-expiry makes near-ATM <span className="text-foreground">gamma</span> explosive — a small index move can multiply a near-dead ATM option. This flags when gamma is <span className="text-foreground">loaded</span> <span className="text-foreground">and</span> a directional break is appearing.
      </p>

      {/* Window + verdict banner */}
      <div className={cn('rounded-2xl border p-4 mb-4', banner)}>
        <div className="flex items-center gap-2 mb-1.5">
          <span className={cn('text-xs font-bold uppercase tracking-wider', bannerText)}>
            {lvl === 'SETUP' ? 'Blast setup' : lvl === 'WATCH' ? 'Watching' : 'Inactive'}
          </span>
          {ok && data.expiry?.isExpiryDay && data.expiry.minutesToClose > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Clock className="w-3 h-3" /> {data.expiry.minutesToClose} min to close</span>
          )}
        </div>
        <div className={cn('text-sm leading-relaxed', lvl === 'SETUP' ? 'text-foreground' : 'text-foreground/90')}>
          {ok ? data.verdict : (data?.error || 'Loading…')}
        </div>
      </div>

      {/* In plain words — no-greeks translation of the whole screen */}
      {plain && (
        <div className={cn('rounded-2xl border p-4 mb-4',
          plain.tone === 'high' ? 'bg-amber-500/10 border-amber-500/40' : plain.tone === 'mod' ? 'bg-sky-500/10 border-sky-500/30' : 'bg-card border-border')}>
          <div className={cn('text-xs font-bold uppercase tracking-wider mb-2',
            plain.tone === 'high' ? 'text-amber-400' : plain.tone === 'mod' ? 'text-sky-400' : 'text-muted-foreground')}>
            In plain words
          </div>
          <div className={cn('text-sm font-semibold mb-2', plain.tone === 'high' ? 'text-amber-300' : plain.tone === 'mod' ? 'text-sky-300' : 'text-foreground')}>
            {plain.headline}
          </div>
          <div className="space-y-1.5">
            {plain.lines.map((l, i) => (
              <p key={i} className="text-[12px] leading-relaxed text-foreground/85">{l}</p>
            ))}
          </div>
        </div>
      )}

      {ok && (
        <>
          {/* Core readouts */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2.5 mb-4">
            <Card label="Spot" value={String(data.spot)} />
            <Card label="ATM" value={String(data.atmStrike)} />
            <Card label="ATM CE" value={data.ce != null ? `\u20b9${data.ce}` : '—'} />
            <Card label="ATM PE" value={data.pe != null ? `\u20b9${data.pe}` : '—'} />
            <Card label="IV" value={data.iv != null ? `${data.iv}%` : (data.vix != null ? `${data.vix}*` : '—')} hint={data.iv == null && data.vix != null ? 'VIX fallback' : undefined} />
            <Card label="Gamma" value={String(data.gamma)} hint="per point" />
          </div>

          {/* Gamma regime */}
          <div className="rounded-2xl bg-card p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-bold uppercase tracking-wider text-foreground">Blast potential</div>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">on a</span>
                <select value={movePct} onChange={(e) => setMovePct(parseFloat(e.target.value))}
                  className="text-xs font-mono px-2 py-1 rounded-lg bg-popover text-foreground border border-border focus:border-primary outline-none">
                  {[0.2, 0.3, 0.5, 0.75].map((m) => <option key={m} value={m}>{m}%</option>)}
                </select>
                <span className="text-[11px] text-muted-foreground">move (~{blast?.movePts} pts)</span>
              </div>
            </div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Gamma regime</span>
              <span className={cn('text-xs font-bold px-2 py-0.5 rounded-md',
                data.gammaRegime === 'LOADED' ? 'bg-amber-500/20 text-amber-400' : data.gammaRegime === 'ELEVATED' ? 'bg-sky-500/15 text-sky-400' : 'bg-muted text-muted-foreground')}>
                {data.gammaRegime}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 mb-1"><TrendingUp className="w-3.5 h-3.5" /> CE (up move)</div>
                <div className="text-sm font-mono text-foreground">{'\u20b9'}{data.ce ?? '—'} → {'\u20b9'}{blast?.ceAfter ?? '—'}</div>
                <div className="text-lg font-bold font-mono text-emerald-400">{blast?.ceGainPct != null ? `+${blast.ceGainPct}%` : '—'}</div>
              </div>
              <div className="rounded-xl bg-rose-500/5 border border-rose-500/20 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-400 mb-1"><TrendingDown className="w-3.5 h-3.5" /> PE (down move)</div>
                <div className="text-sm font-mono text-foreground">{'\u20b9'}{data.pe ?? '—'} → {'\u20b9'}{blast?.peAfter ?? '—'}</div>
                <div className="text-lg font-bold font-mono text-rose-400">{blast?.peGainPct != null ? `+${blast.peGainPct}%` : '—'}</div>
              </div>
            </div>
          </div>

          {/* Catalyst */}
          <div className="rounded-2xl bg-card p-4 mb-4">
            <div className="text-sm font-bold uppercase tracking-wider text-foreground mb-2">Directional catalyst</div>
            <div className="flex items-center gap-2">
              {data.catalyst === 'UP' && <span className="flex items-center gap-1.5 text-sm font-semibold text-emerald-400"><TrendingUp className="w-4 h-4" /> Upside break (+{data.catalystStrength} pts past range)</span>}
              {data.catalyst === 'DOWN' && <span className="flex items-center gap-1.5 text-sm font-semibold text-rose-400"><TrendingDown className="w-4 h-4" /> Downside break ({data.catalystStrength} pts below range)</span>}
              {data.catalyst === 'NONE' && <span className="text-sm text-muted-foreground">No break — index inside its recent range ({data.rangePts} pts wide)</span>}
            </div>
          </div>

          {/* Pinning / OI */}
          {data.pinning?.haveOi && (
            <div className="rounded-2xl bg-card p-4 mb-4">
              <div className="text-sm font-bold uppercase tracking-wider text-foreground mb-3">Max-pain & OI walls</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-3">
                <Card label="Max pain" value={data.pinning.maxPain != null ? String(data.pinning.maxPain) : '—'} hint={data.pinning.pinDistPts != null ? `${data.pinning.pinDistPts > 0 ? '+' : ''}${data.pinning.pinDistPts} pts` : undefined} tone={data.pinning.pinned ? 'warn' : 'neutral'} />
                <Card label="Put wall (support)" value={data.pinning.putWall != null ? String(data.pinning.putWall) : '—'} tone="pos" />
                <Card label="Call wall (resist)" value={data.pinning.callWall != null ? String(data.pinning.callWall) : '—'} tone="neg" />
                <Card label="PCR (OI)" value={data.pinning.pcr != null ? String(data.pinning.pcr) : '—'} />
              </div>
              <div className="text-[11px] leading-relaxed text-muted-foreground">
                {data.pinning.pinned
                  ? <>Index is <span className="text-amber-400 font-semibold">pinned</span> near max-pain {data.pinning.maxPain} — OI is holding it here. The blast comes when price breaks <span className="text-foreground">away</span> from this level.</>
                  : data.pinning.breakingAway
                    ? <>Price is <span className="text-emerald-400 font-semibold">breaking away</span> from max-pain {data.pinning.maxPain} — momentum unopposed by the OI pin.</>
                    : <>Max-pain {data.pinning.maxPain} is {Math.abs(data.pinning.pinDistPts ?? 0)} pts away; watch whether price drifts back toward it (pin) or breaks the walls.</>}
              </div>
            </div>
          )}

          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-popover hover:bg-muted text-foreground disabled:opacity-50 transition-colors mb-4">
            <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} /> {dataUpdatedAt ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}` : 'Refresh'}
          </button>
        </>
      )}

      {/* Risk note */}
      <div className="rounded-xl bg-rose-500/5 border border-rose-500/20 p-3 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Gamma-blast buying is among the highest-risk option trades: most expiry-day ATM options decay to zero, and "loaded gamma" cuts <span className="text-foreground">both ways</span> — a move against you, or no move at all, destroys the premium just as fast. The blast % shown is a Black-Scholes estimate for a clean favourable move; spreads, slippage and a stalling index make real outcomes worse. Educational only, not advice — size tiny and define your loss before entering.
        </p>
      </div>
    </div>
  );
}
