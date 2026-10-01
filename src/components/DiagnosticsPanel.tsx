import { useEffect, useState } from "react";
import { Activity, ShieldAlert, Cpu, HardDrive, RefreshCw, Layers } from "lucide-react";
import { performanceTracker } from "../lib/performanceTracker";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Injected by the `define` block in vite.config.ts at build time.
declare const __BUILD_TIME__: string;
declare const __BUILD_ID__: string;
declare const __BUILD_SHA__: string;

// Is this running copy the deployed one? The bundle carries its build ID; the
// server's dist/version.json carries the deployed build's. Fetched uncached.
// Different = an older copy is still running (an app left open across a deploy,
// or a phone holding a cached copy).
function useDeployedVersion() {
  const [deployed, setDeployed] = useState<{ id: string; sha: string | null; builtAt: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        const d = await r.json();
        if (alive && d?.id) { setDeployed(d); setFailed(false); }
      } catch (e) { if (alive) setFailed(true); }
    };
    check();
    const t = setInterval(check, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { deployed, failed };
}

// FORCE UPDATE: drop the service worker's cached files and reload past every
// cache. Settings live in localStorage, which is deliberately not touched.
async function forceUpdate() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map((r) => r.update().catch(() => {})));
  } catch (e) {}
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) {}
  const u = new URL(window.location.href);
  u.searchParams.set('v', String(Date.now()));
  window.location.replace(u.toString());
}
import { lastFrequencyDecision, isFrequencyExempt } from '../lib/apiInterceptor';
import { zoomDiag } from '../lib/zoomDiag';

// Live layout readout. Every height in the chain from viewport to chart canvas,
// so a "gap under the chart" or "page scrolls" report can be read off a Diag
// screenshot in one glance instead of guessed at from theory.
function useLayoutReadout() {
  const [txt, setTxt] = useState('');
  useEffect(() => {
    const read = () => {
      try {
        const h = (sel: string) => { const el = document.querySelector(sel) as HTMLElement | null; return el ? Math.round(el.getBoundingClientRect().height) : null; };
        const canvas = document.querySelector('[data-layout="chart"] canvas') as HTMLCanvasElement | null;
        const parts = [
          `vp ${window.innerHeight}`,
          `main ${h('main') ?? '-'}`,
          `page ${h('[data-layout="page"]') ?? '-'}`,
          `chart ${h('[data-layout="chart"]') ?? '-'}`,
          `canvas ${canvas ? Math.round(canvas.getBoundingClientRect().height) : '-'}`,
          `doc ${document.documentElement.scrollHeight}${document.documentElement.scrollHeight > window.innerHeight ? ' SCROLLS' : ''}`,
          // Horizontal geometry of the two elements that overlap in the toolbar.
          // Source reading has failed twice on this; the rects say plainly whether
          // the selector runs past the icons, and which one is where.
          (() => {
            const r = (sel: string) => { const e = document.querySelector(sel) as HTMLElement | null; if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
            const s1 = r('[data-layout="selector"]'); const s2 = r('[data-layout="icons"]');
            if (!s1 || !s2) return `sel ${s1 ? s1.l + '-' + s1.r : '-'} icons ${s2 ? s2.l : '-'}`;
            const over = s1.r > s2.l;
            return `sel ${s1.l}-${s1.r} (w${s1.w}) · icon@${s2.l}${over ? ' OVERLAP ' + (s1.r - s2.l) + 'px' : ' ok'}`;
          })(),
        ];
        // Three lines: heights, toolbar geometry, and the frequency-warning
        // decision. The geometry and the decision are the two facts the source
        // could not settle; putting them on screen is what settles them.
        const heights = parts.slice(0, parts.length - 1).join(' · ');
        const geometry = String(parts[parts.length - 1]);
        const d = lastFrequencyDecision;
        const decision = d.at
          ? `last warned: ${d.endpoint} → ${d.exempt ? 'EXEMPT (toast suppressed)' : 'NOT exempt'} ${Math.round((Date.now() - d.at) / 1000)}s ago`
          : 'freq check: none yet';
        const z = zoomDiag.at
          ? `zoom: ${zoomDiag.decision} (${zoomDiag.reason}) saved ${zoomDiag.saved}${zoomDiag.applied ? ' → ' + zoomDiag.applied : ''} · ${zoomDiag.rebuilds} rebuilds`
          : 'zoom: no rebuild yet';
        setTxt(`${heights}\n${geometry}\n${decision}\n${z}`);
      } catch (e) {}
    };
    read();
    const id = setInterval(read, 1500);
    return () => clearInterval(id);
  }, []);
  return txt;
}

export function DiagnosticsPanel() {
  const useLayoutReadoutValue = useLayoutReadout();
  const { deployed, failed: versionCheckFailed } = useDeployedVersion();
  const [updating, setUpdating] = useState(false);
  const [metrics, setMetrics] = useState(performanceTracker.getMetrics());

  useEffect(() => {
    const handle = setInterval(() => {
      setMetrics(performanceTracker.getMetrics());
    }, 1000);
    return () => clearInterval(handle);
  }, []);

  return (
    <Card className="bg-card border-0 backdrop-blur-xl relative overflow-hidden">
      <CardHeader className="border-b border-0 pb-3">
        {/* Heading row: title, build stamp, status. The multi-line readout used
            to sit in here too, squeezed between the title and the badge — on a
            phone that left it a ~150px column and it wrapped into the jumble in
            Martin's screenshot. It now has its own full-width block below. */}
        <CardTitle className="text-xs font-bold tracking-widest uppercase text-foreground/80 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="flex items-center gap-1.5 min-w-0">
            <Activity className="w-4 h-4 text-emerald-400 animate-pulse shrink-0" /> App Diagnostics
          </span>
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-[9px] font-mono normal-case tracking-normal text-muted-foreground whitespace-nowrap" title="When this UI bundle was built (IST).">
              {new Date(__BUILD_TIME__).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} IST
            </span>
            <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-mono">
              SYS: OK
            </Badge>
          </span>
        </CardTitle>

        {/* VERSION. The build this copy of the app is running, against the build
            that is deployed — with a Force update for when they differ. */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5">
          <div className="flex items-center gap-2 min-w-0 text-[11px]">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono font-semibold text-foreground">{__BUILD_SHA__ || `build ${__BUILD_ID__}`}</span>
            {deployed && deployed.id === __BUILD_ID__ && (
              <span className="text-[10px] font-semibold text-emerald-500">✓ Latest</span>
            )}
            {deployed && deployed.id !== __BUILD_ID__ && (
              <span className="text-[10px] font-semibold text-amber-500">
                Update available{deployed.sha ? ` → ${deployed.sha}` : ''}
              </span>
            )}
            {!deployed && versionCheckFailed && (
              <span className="text-[10px] text-muted-foreground">couldn't check</span>
            )}
          </div>
          <button
            onClick={async () => { setUpdating(true); await forceUpdate(); }}
            disabled={updating}
            className={`shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-md border transition-colors disabled:opacity-50 ${
              deployed && deployed.id !== __BUILD_ID__
                ? 'border-amber-500/60 bg-amber-500/15 text-amber-600 hover:bg-amber-500/25'
                : 'border-border text-foreground/80 hover:bg-muted'}`}
          >
            {updating ? 'Updating…' : 'Force update'}
          </button>
        </div>

        {/* The readout, full width under the heading. One line per fact, each
            label on its own row rather than a run-on paragraph — these are read
            at a glance when something looks wrong. */}
        <div className="mt-2 rounded-md bg-muted/30 px-2.5 py-2 text-[9px] leading-relaxed font-mono text-muted-foreground whitespace-pre-line break-words">
          {useLayoutReadoutValue}
        </div>
      </CardHeader>
      
      <CardContent className="p-4 space-y-4">
        {/* Metric Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div className="bg-card p-3 rounded-lg border border-0 space-y-1">
            <span className="text-[10px] text-muted-foreground block font-medium">Active API Requests</span>
            <span className="text-lg font-mono font-bold text-foreground transition-colors duration-300">
              {metrics.activeCalls}
            </span>
          </div>

          <div className="bg-card p-3 rounded-lg border border-0 space-y-1">
            <span className="text-[10px] text-muted-foreground block font-medium">Avg API Latency</span>
            <span className="text-lg font-mono font-bold text-foreground">
              {metrics.averageResponseTime} ms
            </span>
          </div>

          <div className="bg-card p-3 rounded-lg border border-0 space-y-1 col-span-2 md:col-span-1">
            <span className="text-[10px] text-muted-foreground block font-medium">Global Render Count</span>
            <span className="text-lg font-mono font-bold text-foreground">
              {metrics.renderCount}
            </span>
          </div>

          <div className="bg-card p-3 rounded-lg border border-0 space-y-1">
            <span className="text-[10px] text-muted-foreground block font-medium">Telemetry Cache Rate</span>
            <span className="text-lg font-mono font-bold text-emerald-400">
              {metrics.cacheHitRate}%
            </span>
          </div>

          <div className="bg-card p-3 rounded-lg border border-0 space-y-1 col-span-2">
            <span className="text-[10px] text-muted-foreground block font-medium">WS Subelement Subscription</span>
            <span className="text-xs font-mono font-bold text-indigo-400 truncate block mt-1" title={metrics.wsSubscriptions.join(", ")}>
              {metrics.wsSubscriptions.join(", ") || "None"}
            </span>
          </div>
        </div>

        {/* Broker Connection lives on the chart page (it reads Kite counters
            there) but is reached from here, where app health belongs. */}
        <button
          onClick={() => { try { window.dispatchEvent(new CustomEvent('toggle_broker_connection')); } catch (e) {} }}
          className="w-full flex items-center justify-between rounded-xl border border-border/60 bg-card/60 px-3 py-2 text-left hover:bg-card transition-colors"
        >
          <span className="text-[11px] font-medium text-foreground/90">Broker Connection</span>
          <span className="text-[10px] text-muted-foreground">Kite request rate · bound contract</span>
        </button>

        {/* Telemetry warnings. THIS panel — not the toast — was the warning
            Martin kept seeing: it listed raw hit counts with no exemption, so an
            endpoint the interceptor had already judged harmless (a server-cached
            /api/ta refetching on a window resize) still read as a throttle
            advisory here. The same exemption now applies. Exempt endpoints are
            still listed, but as a plain count under a neutral heading, because
            a count is useful information and a warning about it is not. */}
        {(() => {
          const risky = metrics.warnings.filter((w) => !isFrequencyExempt(w.endpoint));
          return (
            <>
              {risky.length > 0 && (
                <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 space-y-2">
                  <p className="text-[11px] font-bold text-primary flex items-center gap-1">
                    <ShieldAlert className="w-3.5 h-3.5" /> THROTTLE API ADVISORY Warning
                  </p>
                  <div className="space-y-1">
                    {risky.map((w, idx) => (
                      <div key={idx} className="flex justify-between items-center text-[10px] font-mono text-foreground/80 bg-card/60 p-1.5 rounded">
                        <span className="truncate max-w-[200px]">{w.endpoint}</span>
                        <span className="text-primary font-bold">{w.ratePer15s} hits / 15s</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Harmless endpoints get NO box. The neutral "busy endpoints" list
                  read to Martin as the same warning by another name, and a count
                  of a cached endpoint is not actionable. */}
            </>
          );
        })()}

        {/* Where the latency actually goes. "srv" is time inside our server
            (which includes the Kite round trip through the Bangalore proxy) and
            "net" is the wire between this phone and Railway. Medians, so a
            single cold chart load does not colour the whole picture. */}
        <div className="space-y-2">
          <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5 text-sky-400" /> Latency by endpoint
          </p>
          {(metrics as any).endpointBreakdown?.length ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-[9px] font-mono text-muted-foreground/70 uppercase">
                <span className="flex-1">endpoint</span>
                <span className="w-8 text-right">n</span>
                <span className="w-12 text-right">total</span>
                <span className="w-12 text-right">srv</span>
                <span className="w-12 text-right">net</span>
              </div>
              {(metrics as any).endpointBreakdown.map((r: any, idx: number) => (
                <div key={idx} className="flex items-center gap-2 text-[10px] font-mono bg-card/60 px-1.5 py-1 rounded">
                  <span className="flex-1 truncate text-muted-foreground">{r.endpoint.replace('/api/', '')}</span>
                  <span className="w-8 text-right text-muted-foreground/70">{r.calls}</span>
                  <span className={`w-12 text-right font-bold ${r.totalMs > 800 ? 'text-primary' : 'text-foreground/80'}`}>{r.totalMs}</span>
                  <span className="w-12 text-right text-amber-400">{r.serverMs === null ? '–' : r.serverMs}</span>
                  <span className="w-12 text-right text-sky-400">{r.networkMs === null ? '–' : r.networkMs}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground italic">No calls measured yet.</p>
          )}
        </div>

        {/* Slowest components performance profiles */}
        <div className="space-y-2">
          <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-indigo-400" /> Active Frame Speeds
          </p>
          <div className="space-y-1.5">
            {metrics.slowestComponents.length === 0 ? (
              <p className="text-[10px] text-muted-foreground italic">Profiling in progress...</p>
            ) : (
              metrics.slowestComponents.map((c, idx) => (
                <div key={idx} className="flex justify-between items-center text-[11px] font-mono hover:bg-white/[0.01] p-1 rounded transition-colors">
                  <span className="text-muted-foreground">{c.name}</span>
                  <span className={c.avgTimeMs > 4 ? "text-primary" : "text-foreground/80"}>{c.avgTimeMs} ms</span>
                </div>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
