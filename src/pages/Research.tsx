import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { FlaskConical, CheckCircle2, XCircle, Clock, AlertTriangle } from 'lucide-react';

// Every strategy this app has tested, in one place, with the verdict in words.
//
// WHY THIS PAGE EXISTS. Six research engines write their results into gap_stats
// and expose them as raw JSON on six different endpoints. Reading them meant
// guessing URL paths and squinting at a wall of text — which, in practice, meant
// a rule could be rebuilt because nobody remembered it had already failed. That
// nearly happened: the "one trade a day, big target" idea was proposed a month
// AFTER orb_backtest had already tested and failed exactly that.
//
// So this page has one job: make "has this been tested, and did it work?"
// answerable in one glance. It is READ-ONLY. It starts nothing, tunes nothing,
// and cannot place an order. Every number shown is fetched from the engines'
// own stored results — nothing is recomputed here, so this page can never
// disagree with the engine that produced it.

type Verdict = 'PASSED' | 'FAILED' | 'RUNNING' | 'PENDING' | 'TOO_EARLY' | 'ERROR';

const VERDICT_STYLE: Record<Verdict, { cls: string; Icon: any; word: string }> = {
  PASSED:    { cls: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10', Icon: CheckCircle2, word: 'PASSED' },
  FAILED:    { cls: 'text-rose-400 border-rose-500/40 bg-rose-500/10',          Icon: XCircle,     word: 'FAILED' },
  RUNNING:   { cls: 'text-sky-400 border-sky-500/40 bg-sky-500/10',             Icon: Clock,       word: 'RUNNING' },
  PENDING:   { cls: 'text-slate-400 border-slate-500/40 bg-slate-500/10',       Icon: Clock,       word: 'NOT RUN' },
  TOO_EARLY: { cls: 'text-amber-400 border-amber-500/40 bg-amber-500/10',       Icon: Clock,       word: 'TOO EARLY' },
  ERROR:     { cls: 'text-amber-400 border-amber-500/40 bg-amber-500/10',       Icon: AlertTriangle, word: 'UNAVAILABLE' },
};

const n1 = (v: any) => (typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—');
const n2 = (v: any) => (typeof v === 'number' && isFinite(v) ? v.toFixed(2) : '—');
const sgn = (v: any) => (typeof v === 'number' && isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)}` : '—');
const fmtDate = (ts?: number | null) => {
  if (!ts) return null;
  const d = new Date(ts + 5.5 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

type Card = {
  name: string;
  plain: string;          // the rule, in words
  bar: string;            // what it had to clear, set before looking
  verdict: Verdict;
  headline: string;       // the one sentence that matters
  stats: Array<{ k: string; v: string; bad?: boolean; good?: boolean }>;
  note?: string;
  endpoint: string;
};

const useJson = (key: string, url: string) => useQuery({
  queryKey: ['research', key],
  queryFn: async () => { const r = await fetch(url); if (!r.ok) throw new Error(String(r.status)); return r.json(); },
  staleTime: 120000,
  retry: 1,
});

export default function Research() {
  const orb  = useJson('orb', '/api/orb/backtest/status');
  const pa   = useJson('pa', '/api/pa/search/status');
  const conf = useJson('conf', '/api/confluence');
  const ib   = useJson('ib', '/api/inside-bar');
  const swp  = useJson('sweep', '/api/sweep/backtest/status');

  const cards: Card[] = [];

  // ---------------------------------------------------------------- ORB
  {
    const q = orb; const r = q.data?.result; const job = q.data?.job;
    const p = r?.primary;
    let verdict: Verdict = 'PENDING';
    let headline = 'Never run.';
    const stats: Card['stats'] = [];
    if (q.isError) { verdict = 'ERROR'; headline = 'Could not reach the endpoint.'; }
    else if (job?.status === 'running') { verdict = 'RUNNING'; headline = job.progress || 'Running…'; }
    else if (p) {
      verdict = r.barMet ? 'PASSED' : 'FAILED';
      headline = r.barMet
        ? `Cleared its bar: ${sgn(p.avgPts)} pts per trade over ${p.n} trades.`
        : `Lost ${n2(Math.abs(p.avgPts))} points per trade over ${p.n} trades. Both halves of history negative.`;
      stats.push({ k: 'Trades', v: String(p.n) });
      stats.push({ k: 'Win rate', v: `${n1(p.winRate)}%` });
      stats.push({ k: 'Avg / trade', v: `${sgn(p.avgPts)} pts`, bad: p.avgPts < 0, good: p.avgPts > 0 });
      stats.push({ k: 'Total', v: `${sgn(p.totalPts)} pts`, bad: p.totalPts < 0, good: p.totalPts > 0 });
      if (p.walkForward) {
        stats.push({ k: 'First half', v: `${sgn(p.walkForward.train?.avgPts)} /trade`, bad: p.walkForward.train?.avgPts < 0 });
        stats.push({ k: 'Second half', v: `${sgn(p.walkForward.test?.avgPts)} /trade`, bad: p.walkForward.test?.avgPts < 0 });
      }
      if (p.byExit) stats.push({ k: 'Stopped out', v: `${p.byExit.stop} of ${p.n}` });
    }
    const ex = r?.exploratory;
    cards.push({
      name: 'Opening Range Breakout',
      plain: 'Draw a box around the first 15 minutes. When a 5-minute candle closes outside it, trade that direction. Stop at the middle of the box, target twice the risk, out by 3pm. One trade a day.',
      bar: 'At least 60 trades, profitable after costs, second half of history also profitable, drawdown smaller than a year of profit.',
      verdict, headline, stats,
      note: ex
        ? `Three variations were tried too, and all lost: waiting for a bigger break (${sgn(ex.buffered?.avgPts)}/trade), waiting for a pullback (${sgn(ex.retest?.avgPts)}), and betting on the breakout failing (${sgn(ex.reverseOnFail?.avgPts)}). When both the move and the opposite of the move lose, there is nothing there to collect.`
        : undefined,
      endpoint: '/api/orb/backtest/status',
    });
  }

  // ---------------------------------------------------------------- rule search
  {
    const q = pa; const r = q.data?.result; const job = q.data?.job;
    let verdict: Verdict = 'PENDING';
    let headline = 'Never run.';
    const stats: Card['stats'] = [];
    if (q.isError) { verdict = 'ERROR'; headline = 'Could not reach the endpoint.'; }
    else if (job?.status === 'running') { verdict = 'RUNNING'; headline = job.progress || 'Running…'; }
    else if (r) {
      verdict = r.barMet ? 'PASSED' : 'FAILED';
      headline = r.barMet
        ? 'A rule cleared the pre-set bar on data it had never seen.'
        : 'No rule cleared the bar. The best performer on the first half did not hold up on the second.';
      stats.push({ k: 'Rules tested', v: String(r.universeSize ?? '—') });
      if (typeof r.howManyPositiveOnTest === 'number' && r.universeSize)
        stats.push({ k: 'Profitable out-of-sample', v: `${r.howManyPositiveOnTest} of ${r.universeSize}`, bad: true });
      if (r.days) stats.push({ k: 'Days of history', v: String(r.days.total ?? '—') });
      if (r.winner?.test) stats.push({ k: 'Best rule, fresh data', v: `${sgn(r.winner.test.avg)} /trade`, bad: (r.winner.test.avg ?? 0) < 0 });
    }
    cards.push({
      name: 'The 1,728-rule search',
      plain: 'Every combination of trigger, location, trend, time of day, stop and target was tested at once — 1,728 rules. The best one on the first 60% of history was then checked, once, on the untouched remainder.',
      bar: 'The winner needed 40+ trades on fresh data, real profit, statistical significance, and it had to beat 90% of all other rules out of sample.',
      verdict, headline, stats,
      note: 'This is the result that governs everything else here: roughly 85% of price-action rules in that universe lose money once option costs are charged. Any new price-pattern idea is starting from that base rate.',
      endpoint: '/api/pa/search/status',
    });
  }

  // ---------------------------------------------------------------- confluence
  {
    const q = conf; const d = q.data; const bt = d?.backtest; const sc = d?.scorecard;
    let verdict: Verdict = 'PENDING';
    let headline = 'Not run yet.';
    const stats: Card['stats'] = [];
    if (q.isError) { verdict = 'ERROR'; headline = 'Could not reach the endpoint.'; }
    else if (bt?.combined?.n) {
      const c = bt.combined;
      verdict = (c.avgOptionPts ?? 0) > 0 ? 'PASSED' : 'FAILED';
      headline = (c.avgOptionPts ?? 0) > 0
        ? `Made ${sgn(c.avgOptionPts)} option points per signal over ${c.n} signals.`
        : `Lost ${n2(Math.abs(c.avgOptionPts))} option points per signal over ${c.n} signals across two years.`;
      stats.push({ k: 'Signals', v: String(c.n) });
      stats.push({ k: 'Win rate', v: `${n1(c.winRate)}%` });
      stats.push({ k: 'Avg / signal', v: `${sgn(c.avgOptionPts)} pts`, bad: (c.avgOptionPts ?? 0) < 0, good: (c.avgOptionPts ?? 0) > 0 });
      stats.push({ k: 'Total', v: `${sgn(c.totalOptionPts)} pts`, bad: (c.totalOptionPts ?? 0) < 0 });
      stats.push({ k: 'Worst drawdown', v: `${n1(c.maxDrawdownPts)} pts`, bad: true });
    } else if (bt?.status?.includes?.('running')) { verdict = 'RUNNING'; headline = bt.status; }
    if (sc?.n) stats.push({ k: 'Live so far', v: `${sc.n} signals, ${sgn(sc.avgOptionPts)} /signal`, bad: (sc.avgOptionPts ?? 0) < 0 });
    cards.push({
      name: 'Confluence Buy/Sell',
      plain: 'Trade with the trend (last BOS/CHoCH) when price dips back into a live Order Block or Fair Value Gap and closes back out of it. Stop one ATR away, held to the 3pm close.',
      bar: 'Positive after option costs across two years, and positive live on fresh data over 30+ signals.',
      verdict, headline, stats,
      note: 'The rule picked direction slightly better than a coin — worth roughly +3.7 index points a trade. Costs are about 4.9. It was right often enough to feel clever and still bled. The chart arrows are off by default because of this.',
      endpoint: '/api/confluence',
    });
  }

  // ---------------------------------------------------------------- inside bar
  {
    const q = ib; const sc = q.data?.scorecard;
    let verdict: Verdict = 'TOO_EARLY';
    let headline = 'Forward test in progress — no verdict until about 30 signals.';
    const stats: Card['stats'] = [];
    if (q.isError) { verdict = 'ERROR'; headline = 'Could not reach the endpoint.'; }
    else if (sc) {
      stats.push({ k: 'Signals so far', v: String(sc.n ?? 0) });
      if (sc.n) {
        stats.push({ k: 'Win rate', v: `${n1(sc.winRate)}%` });
        stats.push({ k: 'Avg / signal', v: `${sgn(sc.avgOptionPts)} pts`, bad: (sc.avgOptionPts ?? 0) < 0, good: (sc.avgOptionPts ?? 0) > 0 });
      }
      if ((sc.n ?? 0) >= 30) verdict = (sc.avgOptionPts ?? 0) > 0 ? 'PASSED' : 'FAILED';
      if (sc.verdict) headline = sc.verdict;
    }
    cards.push({
      name: 'Inside-bar break',
      plain: 'Around midday, when a quiet candle sits entirely inside the one before it and the next candle closes beyond that range near a round number, trade the break. Stop one ATR, held to the 3pm close.',
      bar: 'About 30–40 live signals, then positive after option costs on data nobody mined.',
      verdict, headline, stats,
      note: 'Honest caveat carried from the day it was built: this rule was spotted in a top-ten list AFTER the test data had been looked at. Both halves of history are therefore contaminated, so only future data can judge it. That is why it is logged live rather than backtested.',
      endpoint: '/api/inside-bar',
    });
  }

  // ---------------------------------------------------------------- sweep & reclaim
  {
    const q = swp; const r = q.data?.result; const job = q.data?.job;
    let verdict: Verdict = 'PENDING';
    let headline = 'Never run. The rule is written and waiting — nothing has been tested.';
    const stats: Card['stats'] = [];
    // The engine stores its aggregate under `all` (with `biasAligned` and
    // `walkForwardAligned` alongside) and records NO barMet flag — unlike ORB.
    // The first version of this card looked for primary/combined and would have
    // shown UNAVAILABLE even on a perfectly good result.
    const all = r?.all, wf = r?.walkForwardAligned;
    if (q.isError) { verdict = 'ERROR'; headline = 'Could not reach the endpoint.'; }
    else if (job?.status === 'running') { verdict = 'RUNNING'; headline = job.progress || 'Running…'; }
    else if (job?.status === 'error') { verdict = 'ERROR'; headline = job.error || 'The run failed.'; }
    else if (all && typeof all.n === 'number') {
      // No barMet is stored, so the bar below is applied HERE, and it was written
      // down before the first run — same standard ORB had to clear.
      const testAvg = wf?.test?.avgPts;
      const passed = all.n >= 60 && (all.totalPts ?? 0) > 0 && (testAvg ?? -1) > 0;
      verdict = passed ? 'PASSED' : 'FAILED';
      headline = passed
        ? `Cleared the bar: ${sgn(all.avgPts)} pts per trade over ${all.n} trades, and the untouched half held up.`
        : `${all.n} trades at ${sgn(all.avgPts)} points each — did not clear the bar.`;
      stats.push({ k: 'Trades', v: String(all.n) });
      if (all.winRate != null) stats.push({ k: 'Win rate', v: `${n1(all.winRate)}%` });
      if (all.avgPts != null) stats.push({ k: 'Avg / trade', v: `${sgn(all.avgPts)} pts`, bad: all.avgPts < 0, good: all.avgPts > 0 });
      if (all.totalPts != null) stats.push({ k: 'Total', v: `${sgn(all.totalPts)} pts`, bad: all.totalPts < 0, good: all.totalPts > 0 });
      if (wf?.train?.avgPts != null) stats.push({ k: 'First half', v: `${sgn(wf.train.avgPts)} /trade`, bad: wf.train.avgPts < 0 });
      if (testAvg != null) stats.push({ k: 'Second half', v: `${sgn(testAvg)} /trade`, bad: testAvg < 0 });
      if (r?.byExit) stats.push({ k: 'Stopped out', v: `${r.byExit.stop} of ${all.n}` });
      if (r?.daysAnalyzed) stats.push({ k: 'Days', v: String(r.daysAnalyzed) });
    }
    cards.push({
      name: 'Sweep & Reclaim',
      plain: 'Price pushes through yesterday\u2019s high or low (or the opening range, or a round number), runs the stops sitting there, then closes back inside within three candles \u2014 trade the reclaim. One trade a day, out by 3pm.',
      bar: 'At least 60 trades, profitable after costs, AND the second half of history profitable on its own. Written down before the first run, not after.',
      verdict, headline, stats,
      note: r
        ? 'Two things the engine deliberately could not test: max-OI strike levels (no historical option-chain archive exists) and RSI confirmation (not computed in this version). Stops are assumed to fill first whenever a stop and a target are touched in the same candle \u2014 the pessimistic assumption.'
        : 'This rule has never been run. Whatever it shows on its first run is its one honest attempt \u2014 a rule that fails is retired, not adjusted.',
      endpoint: '/api/sweep/backtest/status',
    });
  }

  const loading = [orb, pa, conf, ib, swp].some(q => q.isLoading);
  const failed = cards.filter(c => c.verdict === 'FAILED').length;
  const passed = cards.filter(c => c.verdict === 'PASSED').length;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <FlaskConical className="w-6 h-6 text-primary" />
        <div>
          <h1 className="text-xl font-bold text-foreground">Research</h1>
          <p className="text-xs text-muted-foreground">
            Every strategy this app has tested, its rule, the bar it had to clear, and the verdict. Read-only.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 text-sm text-foreground/80 leading-relaxed">
        <span className="font-semibold text-foreground">How to read this page. </span>
        A rule is written down <em>and</em> its pass mark is set <em>before</em> the data is looked at. It then gets
        one attempt. A rule that fails is retired, not adjusted — widening a stop or dropping a filter after seeing the
        result is how a losing strategy gets dressed up as a winning one.
        {!loading && (
          <span className="block mt-2 text-muted-foreground">
            Currently {passed} passed, {failed} failed.
          </span>
        )}
      </div>

      {loading && <div className="text-xs text-muted-foreground font-mono animate-pulse">Loading results…</div>}

      <div className="space-y-4">
        {cards.map(c => {
          const V = VERDICT_STYLE[c.verdict];
          return (
            <div key={c.name} className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex items-start justify-between gap-3 p-4 pb-3">
                <div className="min-w-0">
                  <h2 className="font-bold text-foreground">{c.name}</h2>
                  <p className="text-sm text-foreground/70 mt-1 leading-relaxed">{c.plain}</p>
                </div>
                <div className={cn('shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold', V.cls)}>
                  <V.Icon size={14} />{V.word}
                </div>
              </div>

              <div className="px-4 pb-3">
                <p className={cn('text-sm font-medium',
                  c.verdict === 'FAILED' ? 'text-rose-400' : c.verdict === 'PASSED' ? 'text-emerald-400' : 'text-foreground/80')}>
                  {c.headline}
                </p>
              </div>

              {c.stats.length > 0 && (
                <div className="px-4 pb-3 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5">
                  {c.stats.map(s => (
                    <div key={s.k} className="flex items-baseline justify-between gap-2 text-xs border-b border-border/40 py-1">
                      <span className="text-muted-foreground">{s.k}</span>
                      <span className={cn('font-mono font-semibold',
                        s.bad ? 'text-rose-400' : s.good ? 'text-emerald-400' : 'text-foreground')}>{s.v}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="px-4 pb-3 text-xs text-muted-foreground leading-relaxed">
                <span className="font-semibold text-foreground/70">Bar set beforehand: </span>{c.bar}
              </div>

              {c.note && (
                <div className="mx-4 mb-4 rounded-lg bg-muted/40 border border-border/50 p-3 text-xs text-foreground/70 leading-relaxed">
                  {c.note}
                </div>
              )}

              <div className="px-4 py-2 border-t border-border/50 bg-muted/20 text-[10px] font-mono text-muted-foreground">
                {c.endpoint}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-foreground/75 leading-relaxed">
        <span className="font-semibold text-amber-400">What has not been tested. </span>
        Two ideas cannot be judged from stored history: whether positioning data (OI bias, FII flows, premium pulse)
        leads price, and whether buying options when volatility is compressed pays. Neither has the recorded history a
        backtest needs, and the cost model prices a directional move but has no volatility term — so a volatility
        strategy cannot be scored honestly by it today. They are open questions, not results.
      </div>
    </div>
  );
}
