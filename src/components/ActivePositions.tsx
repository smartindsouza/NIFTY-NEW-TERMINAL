import React, { useState, useEffect, useRef } from "react";
import { X, RefreshCw, Sparkles, TrendingUp, TrendingDown, Shield } from "lucide-react";
import { toast } from "sonner";
import { addWsMessageListener } from "../hooks/useWebSocket";

export interface ActiveTrade {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  entryPrice: number;
  currentPrice: number;
  optionType?: "CE" | "PE";
  strike?: number;
  timestamp: string;
  testMode?: boolean;
  kitePnl?: number;   // Zerodha's own P&L for this position (matches the Kite app exactly)
  product?: string;
  token?: number;     // instrument token — how live ticks are matched to this row
  pnlBase?: number;   // sell_value − buy_value, so pnl = pnlBase + qtySigned × ltp
  qtySigned?: number; // Kite's signed quantity: + long, − short
}

export function ActivePositions() {
  const [positions, setPositions] = useState<ActiveTrade[]>([]);

  // ===== Auto-exit (server-side stoploss/target watcher) state =====
  const [autoExitOpenId, setAutoExitOpenId] = useState<string | null>(null);
  const [exitRules, setExitRules] = useState<any[]>([]);
  const [rulesArmed, setRulesArmed] = useState<boolean>(true);
  const [savingRule, setSavingRule] = useState(false);
  const [form, setForm] = useState<{ spotLower: string; spotUpper: string; spotMode: 'TOUCH' | 'CLOSE'; rsiLower: string; rsiUpper: string; timeframe: string }>({ spotLower: '', spotUpper: '', spotMode: 'TOUCH', rsiLower: '', rsiUpper: '', timeframe: '5' });

  useEffect(() => {
    let active = true;
    const fetchRules = async () => {
      try {
        const res = await fetch('/api/exit-rules');
        if (!res.ok) return;
        const data = await res.json();
        if (active && data.success) { setExitRules(data.rules || []); setRulesArmed(!!data.armed); }
      } catch {}
    };
    fetchRules();
    const id = setInterval(fetchRules, 10000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const armAutoExit = async (pos: ActiveTrade) => {
    const spotLower = parseFloat(form.spotLower) || null;
    const spotUpper = parseFloat(form.spotUpper) || null;
    const rsiLower = parseFloat(form.rsiLower) || null;
    const rsiUpper = parseFloat(form.rsiUpper) || null;
    if (!spotLower && !spotUpper && !rsiLower && !rsiUpper) {
      toast.error('Set at least one level (spot or RSI) before arming.');
      return;
    }
    setSavingRule(true);
    try {
      const res = await fetch('/api/exit-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tradingsymbol: pos.symbol, exchange: 'NFO', qty: pos.qty, product: pos.product || 'MIS',
          positionSide: pos.side, spotLower, spotUpper, spotMode: form.spotMode,
          rsiLower, rsiUpper, timeframe: form.timeframe
        })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.armed ? 'Auto-exit armed on the Zerodha watcher.' : 'Saved — but no active Kite session. Log in today to arm it.');
        setAutoExitOpenId(null);
      } else {
        toast.error(data.error || 'Could not arm auto-exit.');
      }
    } catch {
      toast.error('Network error arming auto-exit.');
    } finally { setSavingRule(false); }
  };

  const cancelAutoExit = async (ruleId: number) => {
    try {
      await fetch(`/api/exit-rules/${ruleId}`, { method: 'DELETE' });
      setExitRules(rs => rs.filter(r => r.id !== ruleId));
      toast.success('Auto-exit cancelled.');
    } catch { toast.error('Could not cancel auto-exit.'); }
  };
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const [lastPrices, setLastPrices] = useState<Record<string, { price: number; dir: "up" | "down" | "flat" }>>({});
  const lastPricesRef = useRef<Record<string, { price: number; dir: "up" | "down" | "flat" }>>({});
  useEffect(() => { lastPricesRef.current = lastPrices; }, [lastPrices]);
  useEffect(() => { positionsRef.current = positions; }, [positions]);
  const confirmedOpenRef = useRef<Set<string>>(new Set()); // symbols Kite has confirmed as open this session
  // Symbols whose exit order was just placed. Zerodha keeps reporting the position
  // as open until the closing order actually fills, so without this the poll would
  // re-adopt the card seconds after the user exited — and a second click would send
  // a SECOND closing order, flipping a closed long into a fresh short. Suppressing
  // re-adoption briefly makes that impossible. Time-based (not a permanent flag) so
  // deliberately re-entering the same strike later in the day still shows up.
  const recentlyExitedRef = useRef<Map<string, number>>(new Map());
  // The poll effect must not re-mount whenever the position count changes (that
  // would tear down and rebuild the interval, and was part of how duplicate polls
  // appeared). It reads the live count through this ref instead.
  const positionsRef = useRef<ActiveTrade[]>([]);
  const [netPnl, setNetPnl] = useState<number | null>(null); // day net P&L: realized today + live unrealized

  // Fetch active positions from localStorage
  const loadPositions = () => {
    try {
      const stored = localStorage.getItem("active_positions");
      if (stored) {
        const parsed: ActiveTrade[] = JSON.parse(stored);
        setPositions(parsed);
        
        // Initialize last prices state
        const initialPrices: Record<string, { price: number; dir: "up" | "down" | "flat" }> = {};
        parsed.forEach((pos) => {
          initialPrices[pos.id] = {
            price: pos.currentPrice || pos.entryPrice,
            dir: "flat"
          };
        });
        setLastPrices(prev => ({ ...initialPrices, ...prev }));
      } else {
        setPositions([]);
      }
    } catch (e) {
      console.error("Failed to load active positions", e);
    }
  };

  useEffect(() => {
    loadPositions();

    // Listen to custom event for active positions changes
    const handleUpdate = () => loadPositions();
    window.addEventListener("active_positions_updated", handleUpdate);
    window.addEventListener("storage", handleUpdate);

    return () => {
      window.removeEventListener("active_positions_updated", handleUpdate);
      window.removeEventListener("storage", handleUpdate);
    };
  }, []);

  // Live prices: poll REAL Kite position data (avg fill, LTP, Zerodha P&L).
  // Test-mode positions keep a small simulation; real positions never use fake ticks.
  useEffect(() => {
    // NOTE: this effect must run even when there are no local cards. It used to
    // bail on positions.length === 0 (and again unless a non-test card existed),
    // which meant a trade taken in the ZERODHA APP was never discovered: the poll
    // that would have found it only ran once the app itself had opened something.
    const pollReal = async () => {
      try {
        const res = await fetch('/api/positions-live');
        const data = await res.json();
        if (!data?.success || !Array.isArray(data.positions)) return;
        if (typeof data.netPnl === 'number') setNetPnl(data.netPnl);
        const bySymbol: Record<string, any> = {};
        data.positions.forEach((kp: any) => { if (Number(kp.quantity) !== 0) bySymbol[kp.tradingsymbol] = kp; });

        // Remember every symbol Kite currently reports as open
        Object.keys(bySymbol).forEach(sym => confirmedOpenRef.current.add(sym));

        setPositions((prevPositions) => {
          let changed = false;
          const removed: string[] = [];
          const kept = prevPositions.filter((pos) => {
            if (pos.testMode || exitingIds.has(pos.id)) return true; // never auto-remove test cards or in-flight exits
            if (bySymbol[pos.symbol]) return true; // still open on Kite
            // Absent from Kite. Drop it if it was open before (closed by watcher/manually)
            // or if it's an old stale card (>25s) — but keep freshly-placed cards still lagging into Kite.
            const ageMs = Date.now() - new Date(pos.timestamp).getTime();
            const wasOpen = confirmedOpenRef.current.has(pos.symbol);
            if (wasOpen || ageMs > 25000) {
              confirmedOpenRef.current.delete(pos.symbol);
              removed.push(pos.symbol);
              changed = true;
              return false; // remove the card
            }
            return true; // just-opened, not in Kite yet — keep
          });

          const updated = kept.map((pos) => {
            if (pos.testMode || exitingIds.has(pos.id)) return pos;
            const kp = bySymbol[pos.symbol];
            if (!kp) return pos;
            const next: any = { ...pos };
            // Reconcile entry to the ACTUAL average fill price from Zerodha
            if (kp.average_price > 0 && Math.abs((pos.entryPrice || 0) - kp.average_price) > 0.009) {
              next.entryPrice = kp.average_price;
              changed = true;
            }
            if (kp.last_price > 0 && kp.last_price !== pos.currentPrice) {
              next.currentPrice = kp.last_price;
              changed = true;
            }
            if (typeof kp.pnl === 'number' && kp.pnl !== (pos as any).kitePnl) {
              next.kitePnl = kp.pnl;
              changed = true;
            }
            if (kp.instrument_token && next.token !== kp.instrument_token) { next.token = kp.instrument_token; changed = true; }
            if (kp.pnl_base !== undefined && next.pnlBase !== kp.pnl_base) { next.pnlBase = kp.pnl_base ?? undefined; changed = true; }
            if (Number(kp.quantity) !== next.qtySigned) { next.qtySigned = Number(kp.quantity); changed = true; }
            const prevLtp = lastPricesRef.current[pos.id]?.price || pos.entryPrice;
            const dir: "up" | "down" | "flat" = kp.last_price > prevLtp ? "up" : kp.last_price < prevLtp ? "down" : "flat";
            setLastPrices((prev) => ({ ...prev, [pos.id]: { price: kp.last_price || prevLtp, dir } }));
            return next;
          });

          // Adopt positions Kite reports that this app never opened — i.e. trades
          // taken in the Zerodha app. They become ordinary cards, so they show live
          // P&L and can be exited from here (the server closes by symbol, reading
          // the real quantity/product/side from Zerodha, so origin doesn't matter).
          const known = new Set(updated.map((pos) => pos.symbol));
          const adopted: ActiveTrade[] = [];
          Object.keys(bySymbol).forEach((sym) => {
            if (known.has(sym)) return;
            const exitedAt = recentlyExitedRef.current.get(sym);
            if (exitedAt && Date.now() - exitedAt < 30000) return;   // exit in flight
            const kp = bySymbol[sym];
            const qty = Number(kp.quantity) || 0;
            if (qty === 0) return;
            const m = /(\d+)(CE|PE)$/.exec(sym);
            adopted.push({
              id: `kite-${sym}`,
              symbol: sym,
              side: qty > 0 ? 'BUY' : 'SELL',
              qty: Math.abs(qty),
              entryPrice: Number(kp.average_price) || 0,
              currentPrice: Number(kp.last_price) || Number(kp.average_price) || 0,
              optionType: m ? (m[2] as 'CE' | 'PE') : undefined,
              strike: m ? Number(m[1]) : undefined,
              // Entry time isn't in the positions feed; the journal import carries
              // the real fill time. Stamp now so the >25s stale rule behaves.
              timestamp: new Date().toISOString(),
              testMode: false,
              kitePnl: typeof kp.pnl === 'number' ? kp.pnl : undefined,
              product: kp.product,
              token: kp.instrument_token,
              pnlBase: kp.pnl_base ?? undefined,
              qtySigned: Number(kp.quantity),
            });
          });
          if (adopted.length) {
            updated.push(...adopted);
            changed = true;
            // Seed the price map, or the LTP column shows the ENTRY price until the
            // next poll lands — a card that looks frozen the moment it appears.
            setLastPrices((prev) => {
              const next = { ...prev };
              adopted.forEach((a) => { next[a.id] = { price: a.currentPrice || a.entryPrice, dir: 'flat' }; });
              return next;
            });
            adopted.forEach((a) => toast.info(`${a.symbol} — open position found on Zerodha.`, { id: `adopted-${a.symbol}` }));
          }

          if (changed) localStorage.setItem("active_positions", JSON.stringify(updated));
          if (removed.length > 0) {
            // Cascade to the chart's Arm Auto-Exit panel and let the user know
            window.dispatchEvent(new Event('active_positions_updated'));
            removed.forEach(sym => toast.info(`${sym} is no longer open on Zerodha — cleared from the banner.`, { id: `closed-${sym}` }));
          }
          return changed ? updated : prevPositions;
        });
      } catch { /* keep last real values; never fall back to simulation */ }
    };

    // Cadence must match what is actually at stake. Removing the old
    // positions.length === 0 guard (so a Kite-app trade can be DISCOVERED) turned a
    // no-position app into a permanent 3s poll on every open tab — which is what
    // tripped the broker-throttle warning. So:
    //   • holding something → 3s, because the P&L on screen is real money
    //   • flat             → 20s, enough to notice a trade taken in the Kite app
    //   • tab hidden       → nothing at all; poll once the moment it comes back
    // Two broker calls per request means a background tab was spending quota for
    // a screen nobody was looking at.
    let realTimer: any = null;
    let currentMs = 0;
    const desiredMs = () => (document.visibilityState !== 'visible' ? 0 : (positionsRef.current.length > 0 ? 3000 : 20000));
    const retime = () => {
      const ms = desiredMs();
      if (ms === currentMs) return;
      currentMs = ms;
      if (realTimer) { clearInterval(realTimer); realTimer = null; }
      if (ms > 0) realTimer = setInterval(pollReal, ms);
    };
    if (document.visibilityState === 'visible') pollReal();
    retime();
    const retimeTicker = setInterval(retime, 2000);
    // When the app returns to the foreground (e.g., after exiting a trade in the
    // Zerodha app), reconcile immediately instead of waiting for the next tick —
    // iOS suspends timers in the background, which left closed trades looking open.
    const onVisible = () => { retime(); if (document.visibilityState === 'visible') pollReal(); };
    document.addEventListener('visibilitychange', onVisible);

    // Simulation strictly for test-mode cards
    const simTimer = setInterval(() => {
      setPositions((prevPositions) => {
        const anyTest = prevPositions.some(p => p.testMode && !exitingIds.has(p.id));
        if (!anyTest) return prevPositions;
        const updated = prevPositions.map((pos) => {
          if (!pos.testMode || exitingIds.has(pos.id)) return pos;
          const current = pos.currentPrice || pos.entryPrice;
          const fluctuationPercent = (Math.random() * 0.8 - 0.4) / 100;
          const delta = current * fluctuationPercent;
          const nextPrice = parseFloat(Math.max(0.5, current + delta).toFixed(2));
          let dir: "up" | "down" | "flat" = "flat";
          if (nextPrice > current) dir = "up";
          else if (nextPrice < current) dir = "down";
          setLastPrices((prev) => ({ ...prev, [pos.id]: { price: nextPrice, dir } }));
          return { ...pos, currentPrice: nextPrice };
        });
        localStorage.setItem("active_positions", JSON.stringify(updated));
        return updated;
      });
    }, 2000);

    return () => { if (realTimer) clearInterval(realTimer); clearInterval(retimeTicker); clearInterval(simTimer); document.removeEventListener('visibilitychange', onVisible); };
  }, [exitingIds]);

  // Live ticks between polls. PASSIVE ONLY — this never calls subscribeToTicks,
  // because the socket carries ONE subscribed symbol at a time and subscribing from
  // here would silently steal the chart's feed. So we use option ticks that are
  // already flowing (which is exactly the case that matters: watching the option
  // chart of a position you hold) and let the 3s poll cover everything else.
  useEffect(() => {
    const off = addWsMessageListener((msg: any) => {
      if (!msg || msg.type !== 'optionTick' || msg.token == null || typeof msg.ltp !== 'number') return;
      if (!(msg.ltp > 0)) return;
      setPositions((prev) => {
        let hit = false;
        const next = prev.map((pos) => {
          if (pos.testMode || String(pos.token ?? '') !== String(msg.token)) return pos;
          if (pos.currentPrice === msg.ltp) return pos;
          hit = true;
          setLastPrices((lp) => {
            const prevPrice = lp[pos.id]?.price ?? pos.entryPrice;
            const dir: 'up' | 'down' | 'flat' = msg.ltp > prevPrice ? 'up' : msg.ltp < prevPrice ? 'down' : 'flat';
            return { ...lp, [pos.id]: { price: msg.ltp, dir } };
          });
          return { ...pos, currentPrice: msg.ltp };
        });
        return hit ? next : prev;   // never re-render on a tick for a symbol we don't hold
      });
    });
    return off;
  }, []);

  // One-click exit function
  const handleExitPosition = async (pos: ActiveTrade) => {
    if (exitingIds.has(pos.id)) return;

    // Toggle loading state for this position
    setExitingIds((prev) => {
      const next = new Set(prev);
      next.add(pos.id);
      return next;
    });

    const toastId = toast.loading(`Exiting position ${pos.symbol}...`, {
      description: `Closing ${pos.qty} qty of ${pos.symbol}`
    });

    try {
      // For real positions, close the ACTUAL Zerodha position: the server reads its real
      // product / quantity / side and places a matching closing order. Only clear the card if it works.
      let alreadyClosed = false;
      if (!pos.testMode) {
        const response = await fetch("/api/exit-position", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tradingsymbol: pos.symbol })
        });
        const result = await response.json().catch(() => ({ success: false, error: "Bad response from server" }));
        if (!result.success && !result.alreadyClosed) {
          toast.error("Could not exit position", {
            id: toastId,
            description: (result.error || "The order was rejected.") + " Your position is still OPEN — please check Zerodha."
          });
          setExitingIds((prev) => { const next = new Set(prev); next.delete(pos.id); return next; });
          return; // keep the card — the position is still live
        }
        alreadyClosed = !!result.alreadyClosed;
      }

      // Exit order placed, or Zerodha confirms it's already closed — clear the card either way.
      const finalPrice = lastPrices[pos.id]?.price || pos.currentPrice || pos.entryPrice;
      const computedExitPnl = pos.side === "BUY"
        ? (finalPrice - pos.entryPrice) * pos.qty
        : (pos.entryPrice - finalPrice) * pos.qty;
      const pnl = (!pos.testMode && typeof pos.kitePnl === 'number') ? pos.kitePnl : computedExitPnl;

      const formattedPnl = new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR"
      }).format(pnl);

      if (alreadyClosed) {
        toast.success(`${pos.symbol} was already closed — cleared it.`, { id: toastId });
      } else {
        toast.success(`Exit order placed for ${pos.symbol}`, {
          id: toastId,
          description: `Closing at ~₹${finalPrice.toFixed(2)}. Realized P&L: ${pnl >= 0 ? "+" : ""}${formattedPnl}`
        });
      }

      // Mark the symbol as just-exited BEFORE clearing the card, so the 3s poll
      // cannot re-adopt it while the closing order is still working.
      recentlyExitedRef.current.set(pos.symbol, Date.now());

      // Remove from active positions and save remaining
      const currentActive = JSON.parse(localStorage.getItem("active_positions") || "[]");
      const filtered = currentActive.filter((item: any) => item.id !== pos.id);
      localStorage.setItem("active_positions", JSON.stringify(filtered));

      // Append to local ledger / reports so it reflects in the app session
      try {
        const closedHistory = JSON.parse(localStorage.getItem("closed_positions_history") || "[]");
        closedHistory.unshift({
          ...pos,
          exitPrice: finalPrice,
          exitTime: new Date().toISOString(),
          pnl: pnl,
          formattedPnl
        });
        localStorage.setItem("closed_positions_history", JSON.stringify(closedHistory));
      } catch (err) {
        console.error("Ledger storage error", err);
      }

      // Fire events
      window.dispatchEvent(new Event("active_positions_updated"));

    } catch (err: any) {
      console.error(err);
      toast.error(`Exit Order Failed`, {
        id: toastId,
        description: err.message || "Could not fill offset trade. Please try again."
      });
      
      // Remove exiting loading state
      setExitingIds((prev) => {
        const next = new Set(prev);
        next.delete(pos.id);
        return next;
      });
    }
  };

  if (positions.length === 0) return null;

  return (
    <div className="w-full mb-6 border border-emerald-500/20 bg-emerald-950/10 rounded-xl overflow-hidden backdrop-blur-sm transition-all duration-300 animate-in slide-in-from-top-4">
      {/* Ribbon Header */}
      <div className="px-4 py-2 border-b border-emerald-500/15 bg-emerald-500/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span className="text-xs uppercase font-bold text-emerald-400 tracking-wider flex items-center gap-1.5 font-sans">
            Active Option Positions ({positions.length})
            <Sparkles className="w-3.5 h-3.5 animate-pulse text-primary" />
          </span>
        </div>
        <div className="flex items-center gap-3">
          {netPnl !== null && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-sans">Net P&amp;L (today)</span>
              <span className={`text-sm font-bold font-mono ${netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {netPnl >= 0 ? '+' : ''}{new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(netPnl)}
              </span>
            </div>
          )}
          <div className="text-[10px] text-emerald-400/60 font-mono hidden sm:block">
            Click "Exit" to place instant reversing MARKET order
          </div>
        </div>
      </div>

      {/* Grid of Active Positions */}
      <div className="divide-y divide-emerald-500/10 bg-card/65">
        {positions.map((pos) => {
          const ltpInfo = lastPrices[pos.id] || { price: pos.entryPrice, dir: "flat" };
          const ltp = ltpInfo.price;
          const dir = ltpInfo.dir;

          // P&L: for real positions, use Zerodha's own number (matches the Kite app exactly);
          // computed fallback for test-mode or before the first poll lands
          const computedPnl = pos.side === "BUY"
            ? (ltp - pos.entryPrice) * pos.qty
            : (pos.entryPrice - ltp) * pos.qty;
          // Preference order: Zerodha's own formula evaluated against the freshest
          // tick (updates continuously and matches the Kite app), then Zerodha's
          // last polled figure, then the local estimate for test cards.
          const livePnl = (!pos.testMode && typeof pos.pnlBase === 'number' && typeof pos.qtySigned === 'number' && ltp > 0)
            ? pos.pnlBase + pos.qtySigned * ltp
            : null;
          const pnl = livePnl !== null
            ? livePnl
            : (!pos.testMode && typeof pos.kitePnl === 'number') ? pos.kitePnl : computedPnl;
          const isProfit = pnl >= 0;

          // Fancy class for pricing flashes
          const textFlashClass = 
            dir === "up" 
              ? "text-emerald-400 font-bold bg-emerald-950/20 px-1 rounded transition-all duration-200"
              : dir === "down"
              ? "text-rose-400 font-bold bg-rose-950/20 px-1 rounded transition-all duration-200"
              : "text-foreground font-semibold font-mono";

          const rule = exitRules.find((r:any) => r.tradingsymbol === pos.symbol && r.status === 'ACTIVE');
          const isAutoOpen = autoExitOpenId === pos.id;
          return (
            <div key={pos.id}>
            <div 
              className="flex flex-wrap items-center justify-between gap-4 p-3 md:px-5 md:py-3.5 hover:bg-emerald-500/[0.02] transition-colors"
            >
              {/* Left Column: Symbol & Side Tags */}
              <div className="flex items-center gap-3">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md tracking-wider uppercase font-mono shrink-0 ${
                  pos.side === "BUY" 
                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" 
                    : "bg-rose-500/15 text-rose-400 border border-rose-500/30"
                }`}>
                  {pos.side} LONG
                </span>

                <div className="flex flex-col">
                  <span className="text-sm font-bold text-foreground font-mono leading-tight">
                    {pos.symbol}
                  </span>
                  <span className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1 font-mono">
                    Entered {new Date(pos.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 
                  </span>
                </div>
              </div>

              {/* Middle Metrics: Qty, Entry, LTP, P&L */}
              <div className="flex items-center gap-x-6 md:gap-x-10 flex-wrap">
                {/* Qty */}
                <div className="flex flex-col items-center md:items-start min-w-[70px]">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Quantity</span>
                  <span className="text-xs font-semibold text-foreground mt-0.5 font-mono">{pos.qty} Qty</span>
                </div>

                {/* Entry Price */}
                <div className="flex flex-col items-center md:items-start min-w-[80px]">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Avg Entry</span>
                  <span className="text-xs font-semibold text-foreground/90 mt-0.5 font-mono">₹{pos.entryPrice.toFixed(2)}</span>
                </div>

                {/* Last Traded Price (LTP) */}
                <div className="flex flex-col items-center md:items-start min-w-[80px]">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Live LTP</span>
                  <span className={`text-xs mt-0.5 font-mono flex items-center gap-1 ${textFlashClass}`}>
                    ₹{ltp.toFixed(2)}
                    {dir === "up" && <TrendingUp className="w-3 h-3 text-emerald-400 shrink-0" />}
                    {dir === "down" && <TrendingDown className="w-3 h-3 text-rose-400 shrink-0" />}
                  </span>
                </div>

                {/* Current Profit / Loss */}
                <div className="flex flex-col items-center md:items-end min-w-[100px]">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Unrealized P&L</span>
                  <span className={`text-sm font-extrabold mt-0.5 font-mono flex items-center ${
                    isProfit ? "text-emerald-400" : "text-rose-400"
                  }`}>
                    {isProfit ? "+" : ""}
                    {new Intl.NumberFormat("en-IN", {
                      style: "currency",
                      currency: "INR"
                    }).format(pnl)}
                  </span>
                </div>
              </div>

              {/* Right: Auto-Exit + Quick Exit */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setAutoExitOpenId(isAutoOpen ? null : pos.id); setForm({ spotLower: rule?.spot_lower ? String(rule.spot_lower) : '', spotUpper: rule?.spot_upper ? String(rule.spot_upper) : '', spotMode: (rule?.spot_mode === 'CLOSE' ? 'CLOSE' : 'TOUCH'), rsiLower: rule?.rsi_lower ? String(rule.rsi_lower) : '', rsiUpper: rule?.rsi_upper ? String(rule.rsi_upper) : '', timeframe: rule?.timeframe ? String(rule.timeframe) : '5' }); }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all duration-200 select-none ${rule ? 'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20' : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'}`}
                >
                  <Shield className="w-3.5 h-3.5" />
                  {rule ? 'Auto-Exit ON' : 'Set Auto-Exit'}
                </button>
                <button
                  onClick={() => handleExitPosition(pos)}
                  disabled={exitingIds.has(pos.id)}
                  className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500 hover:text-black font-semibold text-rose-400 text-xs transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed select-none "
                >
                  {exitingIds.has(pos.id) ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      Exiting...
                    </>
                  ) : (
                    <>
                      <X className="w-3.5 h-3.5 font-bold" />
                      1-Click Exit
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Active auto-exit rule banner */}
            {rule && !isAutoOpen && (
              <div className="px-4 py-2 bg-amber-950/20 border-t border-amber-500/15 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
                <span className="text-amber-300/90 flex items-center gap-1.5">
                  <Shield className="w-3 h-3" />
                  Auto-exit armed:
                  {rule.spot_lower ? ` spot ≤ ${rule.spot_lower}` : ''}
                  {rule.spot_upper ? ` · spot ≥ ${rule.spot_upper}` : ''}
                  {(rule.spot_lower || rule.spot_upper) ? ` (${rule.spot_mode === 'CLOSE' ? 'on close' : 'touch'})` : ''}
                  {rule.rsi_lower ? ` · RSI ≤ ${rule.rsi_lower}` : ''}
                  {rule.rsi_upper ? ` · RSI ≥ ${rule.rsi_upper}` : ''}
                  {` · ${rule.timeframe}m`}
                </span>
                <span className="flex items-center gap-2">
                  {!rulesArmed && <span className="text-rose-400">⚠ no Kite session — log in to arm</span>}
                  <button onClick={() => cancelAutoExit(rule.id)} className="px-2 py-0.5 rounded border border-rose-500/40 text-rose-300 hover:bg-rose-500/20">Cancel</button>
                </span>
              </div>
            )}

            {/* Auto-exit setup form */}
            {isAutoOpen && (
              <div className="px-4 py-3 bg-background/40 border-t border-primary/15 space-y-3">
                <div className="text-[11px] text-muted-foreground">
                  Exits the <span className="text-foreground font-semibold">entire</span> position on Zerodha when any level is hit. Spot levels watch the NIFTY index; RSI is checked on candle close. Leave a field blank to ignore it.
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <label className="flex flex-col gap-1 text-[10px] text-muted-foreground uppercase font-semibold">
                    Spot lower
                    <input type="number" value={form.spotLower} onChange={(e)=>setForm(f=>({...f, spotLower:e.target.value}))} placeholder="e.g. 23100" className="bg-card border border-0 rounded px-2 h-8 text-xs text-foreground font-mono focus:outline-none focus:border-primary" />
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] text-muted-foreground uppercase font-semibold">
                    Spot upper
                    <input type="number" value={form.spotUpper} onChange={(e)=>setForm(f=>({...f, spotUpper:e.target.value}))} placeholder="e.g. 23300" className="bg-card border border-0 rounded px-2 h-8 text-xs text-foreground font-mono focus:outline-none focus:border-primary" />
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] text-muted-foreground uppercase font-semibold">
                    Spot trigger
                    <div className="grid grid-cols-2 gap-1 bg-card/40 p-0.5 rounded border border-0 h-8">
                      <button type="button" onClick={()=>setForm(f=>({...f, spotMode:'TOUCH'}))} className={`rounded text-[10px] font-bold ${form.spotMode==='TOUCH'?'bg-primary/20 text-primary':'text-muted-foreground'}`}>Touch</button>
                      <button type="button" onClick={()=>setForm(f=>({...f, spotMode:'CLOSE'}))} className={`rounded text-[10px] font-bold ${form.spotMode==='CLOSE'?'bg-primary/20 text-primary':'text-muted-foreground'}`}>On Close</button>
                    </div>
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] text-muted-foreground uppercase font-semibold">
                    RSI lower
                    <input type="number" value={form.rsiLower} onChange={(e)=>setForm(f=>({...f, rsiLower:e.target.value}))} placeholder="e.g. 40" className="bg-card border border-0 rounded px-2 h-8 text-xs text-foreground font-mono focus:outline-none focus:border-primary" />
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] text-muted-foreground uppercase font-semibold">
                    RSI upper
                    <input type="number" value={form.rsiUpper} onChange={(e)=>setForm(f=>({...f, rsiUpper:e.target.value}))} placeholder="e.g. 60" className="bg-card border border-0 rounded px-2 h-8 text-xs text-foreground font-mono focus:outline-none focus:border-primary" />
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] text-muted-foreground uppercase font-semibold">
                    Timeframe (RSI / close)
                    <select value={form.timeframe} onChange={(e)=>setForm(f=>({...f, timeframe:e.target.value}))} className="bg-card border border-0 rounded px-2 h-8 text-xs text-foreground font-mono focus:outline-none focus:border-primary">
                      <option value="1">1m</option><option value="3">3m</option><option value="5">5m</option><option value="10">10m</option><option value="15">15m</option>
                    </select>
                  </label>
                </div>
                <div className="flex items-center justify-end gap-2 pt-1">
                  {rule && <button onClick={()=>cancelAutoExit(rule.id)} className="px-3 py-1.5 rounded-lg border border-rose-500/40 text-rose-300 text-xs hover:bg-rose-500/20">Remove</button>}
                  <button onClick={()=>setAutoExitOpenId(null)} className="px-3 py-1.5 rounded-lg border border-0 text-muted-foreground text-xs hover:text-foreground">Close</button>
                  <button onClick={()=>armAutoExit(pos)} disabled={savingRule} className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:opacity-90 disabled:opacity-50">{savingRule ? 'Arming…' : (rule ? 'Update Auto-Exit' : 'Arm Auto-Exit')}</button>
                </div>
              </div>
            )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
