import { useState } from "react";

interface Props {
  taInfo?: any;
  oiData?: any;
  pulseBias?: any;
}

const fmt = (v: any, d = 1) => (typeof v === "number" && isFinite(v) ? v.toFixed(d) : "—");

function Bar({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, value || 0));
  const color = v >= 70 ? "bg-emerald-500" : v >= 40 ? "bg-amber-500" : "bg-slate-500";
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 text-muted-foreground">{label}</span>
      <div className="flex-1 h-1.5 rounded bg-slate-700/60 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${v}%` }} />
      </div>
      <span className="w-7 text-right text-foreground/80">{v}</span>
    </div>
  );
}

export default function BounceConviction({ taInfo, oiData, pulseBias }: Props) {
  const [open, setOpen] = useState(false);

  const b = taInfo?.bounce;
  const spot = taInfo?.spot;
  const rsi = taInfo?.rsi;
  const adx = taInfo?.adx;
  const adxRising = taInfo?.adxRising;
  const plusDi = taInfo?.plusDi;
  const minusDi = taInfo?.minusDi;
  const adxTrend = taInfo?.adxTrend;
  const ema20 = taInfo?.ema20;
  const vwap = taInfo?.vwap;

  const hasSetup = b?.inBounceContext;
  const score = hasSetup ? b.score : 0;
  const label = b?.label || "NO SETUP";
  const scoreColor =
    label === "STRONG" ? "text-emerald-400 bg-emerald-500/20"
    : label === "BUILDING" ? "text-amber-400 bg-amber-500/20"
    : "text-slate-300 bg-slate-500/20";

  // Live-only options confirmation (never part of the backtested score).
  const pulse = pulseBias?.success ? pulseBias.label : null;
  const optionsConfirm = pulse ? (String(pulse).toUpperCase().includes("BULL") ? "confirm" : String(pulse).toUpperCase().includes("BEAR") ? "conflict" : "neutral") : null;

  const relColor = (px?: number, ref?: number) =>
    typeof px === "number" && typeof ref === "number" ? (px >= ref ? "text-emerald-400" : "text-rose-400") : "text-slate-300";
  const relText = (px?: number, ref?: number) =>
    typeof px === "number" && typeof ref === "number" ? (px >= ref ? "above" : "below") : "—";

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`inline-flex items-center h-9 px-3 rounded-md text-xs font-mono font-bold whitespace-nowrap ${hasSetup ? scoreColor : "bg-slate-700/90 text-slate-200"}`}
        title="Bounce Conviction + live ADX / EMA / VWAP readout"
      >
        ↩ BOUNCE {hasSetup ? score : "—"}
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 z-[90] w-[92vw] max-w-[330px] bg-popover border border-border rounded-lg shadow-xl p-3 text-xs font-mono flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-bold tracking-wide text-foreground">BOUNCE CONVICTION</span>
        <button onClick={() => setOpen(false)} className="px-2 py-1 rounded bg-slate-500/20 text-slate-300 hover:bg-slate-500/30">✕</button>
      </div>

      <div className="flex items-center gap-2">
        <span className={`px-2 py-1 rounded font-bold ${scoreColor}`}>{hasSetup ? `${score} · ${label}` : "NO SETUP"}</span>
        {!hasSetup && <span className="text-muted-foreground">RSI not bouncing off oversold</span>}
      </div>

      {hasSetup && b?.components && (
        <div className="flex flex-col gap-1">
          <Bar label="RSI thrust" value={b.components.rsiThrust} />
          <Bar label="50 reclaim" value={b.components.rsiReclaim} />
          <Bar label="Trend/ADX" value={b.components.trend} />
          <Bar label="Volume/range" value={b.components.expansion} />
        </div>
      )}

      <div className="border-t border-border pt-2 flex flex-col gap-1">
        <div className="text-muted-foreground">Live readout</div>
        <div className="flex justify-between">
          <span>RSI</span>
          <span className={typeof rsi === "number" && rsi >= 50 ? "text-emerald-400" : "text-rose-400"}>{fmt(rsi)}</span>
        </div>
        <div className="flex justify-between">
          <span>ADX</span>
          <span className="text-foreground/90">
            {fmt(adx)} {adxRising ? "▲" : "▼"} <span className="text-muted-foreground">{adxTrend || ""}</span>
          </span>
        </div>
        <div className="flex justify-between">
          <span>+DI / −DI</span>
          <span className="text-foreground/80">{fmt(plusDi)} / {fmt(minusDi)}</span>
        </div>
        <div className="flex justify-between">
          <span>vs EMA20</span>
          <span className={relColor(spot, ema20)}>{relText(spot, ema20)} ({fmt(ema20, 0)})</span>
        </div>
        <div className="flex justify-between">
          <span>vs VWAP</span>
          <span className={relColor(spot, vwap)}>{relText(spot, vwap)} ({fmt(vwap, 0)})</span>
        </div>
      </div>

      {pulse && (
        <div className="border-t border-border pt-2 flex justify-between">
          <span className="text-muted-foreground">Options (Pulse)</span>
          <span className={optionsConfirm === "confirm" ? "text-emerald-400" : optionsConfirm === "conflict" ? "text-rose-400" : "text-slate-300"}>
            {pulse}{optionsConfirm === "confirm" ? " ✓ confirms" : optionsConfirm === "conflict" ? " ✗ conflicts" : ""}
          </span>
        </div>
      )}

      <div className="text-[10px] text-muted-foreground border-t border-border pt-1">
        Bounce score is the technical confluence only (RSI thrust + 50-reclaim + rising ADX + volume/range). Options shown separately. Not a trade signal — you decide.
      </div>
    </div>
  );
}
