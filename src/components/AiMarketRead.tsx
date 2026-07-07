import { useEffect, useRef, useState } from "react";

interface Props {
  taInfo?: any;
  oiData?: any;
  pulseBias?: any;
  model?: string;
  autoIntervalMs?: number;
}

interface AiRead {
  bias?: string;
  confidence?: string;
  reasoning?: string[];
  risks?: string[];
  summary?: string;
  raw?: string;
  asOf?: number;
  model?: string;
}

// Same four-quadrant classification the chart uses, in words.
function sentimentFromChg(chgLtp: number, chgOi: number): string {
  if (chgLtp > 0 && chgOi > 0) return "Long buildup";
  if (chgLtp < 0 && chgOi > 0) return "Short buildup";
  if (chgLtp < 0 && chgOi < 0) return "Long unwinding";
  if (chgLtp > 0 && chgOi < 0) return "Short covering";
  return "Neutral";
}

// Build a compact, token-cheap snapshot of everything the chart already knows.
function buildSnapshot(taInfo: any, oiData: any, pulseBias: any): any | null {
  if (!taInfo && !oiData) return null;
  const spot = taInfo?.spot ?? oiData?.spot ?? null;
  const recentCandles = Array.isArray(taInfo?.candles)
    ? taInfo.candles.slice(-6).map((c: any) => ({ o: c.open, h: c.high, l: c.low, c: c.close }))
    : [];

  let atmStrike: number | null = null;
  const chain: any[] = [];
  if (oiData?.strikes?.length && spot) {
    const strikes = [...oiData.strikes].sort((a: number, b: number) => a - b);
    atmStrike = strikes.reduce(
      (best: number, s: number) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best),
      strikes[0],
    );
    const idx = strikes.indexOf(atmStrike);
    for (let i = Math.max(0, idx - 2); i <= Math.min(strikes.length - 1, idx + 2); i++) {
      const s = strikes[i];
      const ce = oiData.ceData?.[s];
      const pe = oiData.peData?.[s];
      chain.push({
        strike: s,
        ceOi: ce?.oi ?? null,
        ceChgOi: ce?.chgOi ?? null,
        ceBuildup: ce ? sentimentFromChg(ce.chgLtp || 0, ce.chgOi || 0) : null,
        peOi: pe?.oi ?? null,
        peChgOi: pe?.chgOi ?? null,
        peBuildup: pe ? sentimentFromChg(pe.chgLtp || 0, pe.chgOi || 0) : null,
      });
    }
  }

  return {
    spot,
    rsi: taInfo?.rsi ?? null,
    adx: taInfo?.adx ?? null,
    adxTrend: taInfo?.adxTrend ?? null,
    vwap: taInfo?.vwap ?? null,
    ema20: taInfo?.ema20 ?? null,
    recentCandles,
    expiry: oiData?.expiryDate ?? null,
    atmStrike,
    chain,
    premiumPulseBias: pulseBias?.success
      ? {
          label: pulseBias.label,
          confidence: pulseBias.confidence,
          ceIvTrend: pulseBias.ce?.ivTrend ?? null,
          peIvTrend: pulseBias.pe?.ivTrend ?? null,
          reason: pulseBias.reason,
        }
      : null,
  };
}

export default function AiMarketRead({
  taInfo,
  oiData,
  pulseBias,
  model = "claude-sonnet-4-6",
  autoIntervalMs = 180000,
}: Props) {
  const [read, setRead] = useState<AiRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [open, setOpen] = useState(false);

  // Keep latest props in a ref so the auto-refresh interval always reads fresh data.
  const dataRef = useRef({ taInfo, oiData, pulseBias });
  useEffect(() => {
    dataRef.current = { taInfo, oiData, pulseBias };
  }, [taInfo, oiData, pulseBias]);

  const runRead = async () => {
    const d = dataRef.current;
    const snapshot = buildSnapshot(d.taInfo, d.oiData, d.pulseBias);
    if (!snapshot) {
      setError("No market data loaded yet — open the chart during market hours.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/ai-read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot, model }),
      });
      const data = await r.json();
      if (!data?.success) {
        setError(data?.error || "AI read failed.");
      } else {
        setRead(data);
      }
    } catch (e: any) {
      setError(e?.message || "Network error.");
    } finally {
      setLoading(false);
    }
  };

  // Auto-refresh while enabled and the tab is visible.
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") runRead();
    }, autoIntervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, autoIntervalMs]);

  const biasClass = (b?: string) => {
    if (!b) return "text-slate-300 bg-slate-500/20";
    const u = b.toUpperCase();
    if (u.includes("BULL")) return "text-emerald-400 bg-emerald-500/20";
    if (u.includes("BEAR")) return "text-rose-400 bg-rose-500/20";
    return "text-slate-300 bg-slate-500/20";
  };

  if (!open) {
    return (
      <button
        onClick={() => {
          setOpen(true);
          if (!read) runRead();
        }}
        className="fixed top-3 right-3 z-[90] px-3 py-2 rounded-full text-xs font-mono font-bold bg-indigo-500/90 text-white shadow-lg hover:bg-indigo-500"
        title="Claude's plain-English read of the current setup"
      >
        🧠 AI READ
      </button>
    );
  }

  return (
    <div className="fixed top-3 right-3 z-[90] w-[92vw] max-w-[340px] bg-popover border border-border rounded-lg shadow-xl p-3 text-xs font-mono flex flex-col gap-2 max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between">
        <span className="font-bold tracking-wide text-foreground">AI MARKET READ</span>
        <div className="flex items-center gap-2">
          <button
            onClick={runRead}
            disabled={loading}
            className="px-2 py-1 rounded bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
          >
            {loading ? "…" : "↻"}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="px-2 py-1 rounded bg-slate-500/20 text-slate-300 hover:bg-slate-500/30"
          >
            ✕
          </button>
        </div>
      </div>

      <label className="flex items-center gap-2 text-muted-foreground cursor-pointer select-none">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        Auto-refresh every {Math.round(autoIntervalMs / 60000)} min
      </label>

      {error && <div className="text-rose-400">{error}</div>}

      {loading && !read && <div className="text-muted-foreground">Reading the tape…</div>}

      {read && (
        <div className="flex flex-col gap-2">
          {read.bias && (
            <div className="flex items-center gap-2">
              <span className={`px-2 py-1 rounded font-bold ${biasClass(read.bias)}`}>{read.bias}</span>
              {read.confidence && (
                <span className="text-muted-foreground">{read.confidence} confidence</span>
              )}
            </div>
          )}

          {read.summary && <div className="text-foreground">{read.summary}</div>}

          {Array.isArray(read.reasoning) && read.reasoning.length > 0 && (
            <div>
              <div className="text-muted-foreground mb-0.5">Why:</div>
              <ul className="list-disc pl-4 flex flex-col gap-0.5">
                {read.reasoning.map((r, i) => (
                  <li key={i} className="text-foreground/90">{r}</li>
                ))}
              </ul>
            </div>
          )}

          {Array.isArray(read.risks) && read.risks.length > 0 && (
            <div>
              <div className="text-muted-foreground mb-0.5">Watch / risks:</div>
              <ul className="list-disc pl-4 flex flex-col gap-0.5">
                {read.risks.map((r, i) => (
                  <li key={i} className="text-amber-300/90">{r}</li>
                ))}
              </ul>
            </div>
          )}

          {read.raw && !read.bias && <div className="text-foreground/90 whitespace-pre-wrap">{read.raw}</div>}

          <div className="text-[10px] text-muted-foreground border-t border-border pt-1 mt-1">
            Commentary synthesised from your indicators — not a trade signal or financial advice. You decide.
            {read.asOf ? ` · ${new Date(read.asOf).toLocaleTimeString()}` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
