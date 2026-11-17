import React, { useState, useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
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
  const [location, setLocation] = useLocation();
  // OPEN CHART (4 Nov 2026, Martin): one tap from any screen to this position's
  // option chart. It hands the contract to the chart the same way a trade or a
  // search does — the session's selected instrument and option tabs, which the
  // chart reads when it mounts (phone, desktop split alike) — and clears any
  // earlier "closed this chart" record so the tap always opens it. Not shown on
  // the chart page itself, where the contract is already one tap away.
  const onChartPage = location.startsWith('/advanced-chart');
  const openChartFor = (pos: ActiveTrade) => {
    if (!pos.token) { toast.error('Chart not ready yet — the contract is still loading from Zerodha.'); return; }
    const instr: any = { instrument_token: String(pos.token), tradingsymbol: pos.symbol,
      exchange: /^(SENSEX|BANKEX)/.test(pos.symbol) ? 'BFO' : 'NFO' };
    try {
      const d = JSON.parse(localStorage.getItem('dismissedOptionCharts') || '[]');
      if (Array.isArray(d)) localStorage.setItem('dismissedOptionCharts', JSON.stringify(d.filter((x: string) => x !== pos.symbol)));
    } catch (e) {}
    try {
      sessionStorage.setItem('selectedInstrument', JSON.stringify(instr));
      const tabs = JSON.parse(sessionStorage.getItem('openOptionCharts') || '[]');
      const list = Array.isArray(tabs) ? tabs.filter((t: any) => t?.tradingsymbol !== pos.symbol) : [];
      sessionStorage.setItem('openOptionCharts', JSON.stringify([...list, instr]));
    } catch (e) {}
    setLocation('/advanced-chart');
  };

  // THE CARD'S OWN STATE WENT WITH THE CARD (17 Nov 2026): the Auto-Exit form
  // (levels on the spot or its RSI, set and cancelled from the card) and its
  // ten-second read of /api/exit-rules, and whether the card was open. The
  // rules themselves are untouched on the server; the chart still reads them
  // for the stop it draws on the index chart, and cancels that one from there.
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
  const lastPollErrorRef = useRef<string | null>(null);
  // Hard floor between position polls, whatever triggers one — the interval, a
  // tab regaining focus, a re-time, or a remount. Several of those can coincide
  // (switching back to the tab fires visibilitychange AND re-times the interval),
  // which is how short bursts appeared even with a sane cadence.
  const lastPollAtRef = useRef<number>(0);
  const MIN_POLL_GAP_MS = 2000;
  const [netPnl, setNetPnl] = useState<number | null>(null); // day net P&L: realized today + live unrealized
  const [pollError, setPollError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

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
    const pollReal = async (force = false) => {
      if (!force && Date.now() - lastPollAtRef.current < MIN_POLL_GAP_MS) return;
      lastPollAtRef.current = Date.now();
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
      } catch (err: any) {
        // This catch used to be bare. Anything that threw inside the poll — a bad
        // response, an exception in the adoption block — vanished silently, and the
        // symptom was simply "my position isn't showing" with nothing to debug from.
        // A watcher of real money must never fail invisibly.
        lastPollErrorRef.current = err?.message || String(err);
        console.error('[positions] poll failed:', err);
        setPollError(lastPollErrorRef.current);
        return;
      }
      setPollError(null);
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
    const desiredMs = () => (document.visibilityState !== 'visible' ? 0 : (positionsRef.current.length > 0 ? 3000 : 8000));
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

  // Manual sync. Whatever the automatic cadence is doing, one click forces a read
  // of Zerodha's live positions — so a position can always be brought on screen
  // (and therefore exited from here) without waiting on a timer.
  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/positions-live');
      const data = await res.json().catch(() => null);
      if (!data) { toast.error('No response from the server.'); return; }
      if (!data.success) { toast.error(data.error || 'Zerodha did not return positions.'); return; }
      const list: any[] = Array.isArray(data.positions) ? data.positions : [];
      if (list.length === 0) { toast.info('Zerodha reports no open positions.'); return; }
      // Rebuild straight from Zerodha, bypassing the incremental merge entirely.
      const rebuilt: ActiveTrade[] = list.filter((kp) => Number(kp.quantity) !== 0).map((kp) => {
        const qty = Number(kp.quantity) || 0;
        const m = /(\d+)(CE|PE)$/.exec(kp.tradingsymbol || '');
        const existing = positionsRef.current.find((x) => x.symbol === kp.tradingsymbol && !x.testMode);
        return {
          id: existing?.id || `kite-${kp.tradingsymbol}`,
          symbol: kp.tradingsymbol,
          side: qty > 0 ? 'BUY' : 'SELL',
          qty: Math.abs(qty),
          entryPrice: Number(kp.average_price) || 0,
          currentPrice: Number(kp.last_price) || Number(kp.average_price) || 0,
          optionType: m ? (m[2] as 'CE' | 'PE') : undefined,
          strike: m ? Number(m[1]) : undefined,
          timestamp: existing?.timestamp || new Date().toISOString(),
          testMode: false,
          kitePnl: typeof kp.pnl === 'number' ? kp.pnl : undefined,
          product: kp.product,
          token: kp.instrument_token,
          pnlBase: kp.pnl_base ?? undefined,
          qtySigned: qty,
        } as ActiveTrade;
      });
      const tests = positionsRef.current.filter((x) => x.testMode);
      const next = [...tests, ...rebuilt];
      rebuilt.forEach((r) => confirmedOpenRef.current.add(r.symbol));
      recentlyExitedRef.current.clear();   // an explicit sync overrides exit suppression
      setPositions(next);
      setLastPrices((prev) => {
        const lp = { ...prev };
        rebuilt.forEach((r) => { if (!lp[r.id]) lp[r.id] = { price: r.currentPrice || r.entryPrice, dir: 'flat' }; });
        return lp;
      });
      localStorage.setItem('active_positions', JSON.stringify(next));
      if (typeof data.netPnl === 'number') setNetPnl(data.netPnl);
      setPollError(null);
      toast.success(`Synced ${rebuilt.length} position${rebuilt.length === 1 ? '' : 's'} from Zerodha.`);
    } catch (e: any) {
      toast.error('Could not reach the server.');
    } finally { setSyncing(false); }
  };

  // The mobile toolbar's POS button lives in AdvancedChart, which cannot reach
  // syncNow directly; a window event keeps the two decoupled and means any other
  // surface can request a sync the same way.
  useEffect(() => {
    const onReq = () => { syncNow(); };
    window.addEventListener('sync_positions_request', onReq);
    return () => window.removeEventListener('sync_positions_request', onReq);
  });

  // The chart's Exit chip (on the entry line of an open trade) asks for an exit
  // the same way: this component owns the ONE exit path — the server closes the
  // real position and the card stays if the order is refused — so the chart
  // sends the symbol here instead of placing anything itself. No dependency
  // list, like the sync listener above: it must always see the current
  // positions and the current handler.
  useEffect(() => {
    const onExitReq = (ev: Event) => {
      const sym = (ev as CustomEvent)?.detail?.symbol;
      if (!sym) return;
      const pos = positions.find((p) => p.symbol === sym);
      // EXIT ON THE CHART CLOSES EVERYTHING THAT IS OPEN (17 Nov 2026). Martin:
      // "I want it exit all positions when I tap on exit in the chart." The
      // one asked for goes first, then every other open position, each through
      // the same one exit path (the server reads the real position and closes
      // exactly that). Practice positions are left to their own cards' rules.
      if (pos) {
        handleExitPosition(pos);
        positions.filter((p) => p.id !== pos.id && !p.testMode === !pos.testMode).forEach((p) => handleExitPosition(p));
        return;
      }
      toast.error(`${sym} is not in the open positions here`, { description: 'Nothing was sent. Sync positions and check Zerodha.' });
    };
    window.addEventListener('exit_position_request', onExitReq);
    return () => window.removeEventListener('exit_position_request', onExitReq);
  });

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
        // "Exited", not "order placed": the server answers only once the broker
        // has filled it (server/exit_order.ts), or says in words that it has not.
        toast.success(`Exited ${pos.symbol}`, {
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

  if (positions.length === 0) {
    // Never render nothing: if the poll is failing, or Zerodha has a position this
    // app has not picked up, there must still be somewhere to see it and act.
    // Nothing to show when flat and healthy. The sync control now lives ONLY in
    // the chart's bottom toolbar (the POS button) — it was briefly in both places,
    // which is just two buttons doing one job. The error state below still renders,
    // because a failed position check must always be visible somewhere.
    if (!pollError) return null;
    return (
      <div className="w-full mb-1.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 flex items-center justify-between gap-3">
        <span className="text-xs text-amber-400">
          Position check failed — a trade taken in the Kite app may not be shown here. {pollError}
        </span>
        <button
          onClick={syncNow}
          disabled={syncing}
          className="shrink-0 flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-lg bg-card hover:bg-popover text-foreground/80 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3 h-3', syncing && 'animate-spin')} /> Retry
        </button>
      </div>
    );
  }

  // ONE LINE: THE OVERALL P&L (17 Nov 2026). Martin, with a picture of the card
  // open above ScalpPro: "Remove the positions card that shows every detail and
  // exit button. The exit button already exists in the chart.  Also show only
  // the overall P&L in one single line at the top."
  // What was here: a strip (the count, the day's P&L, Exit, a chevron) that
  // opened a card per position — side, symbol, time of entry, quantity, average,
  // the live price, its own P&L, Set Auto-Exit and 1-Click Exit. All of that is
  // on the chart now, on the trade's own line, with its Exit; on a phone the
  // card took a third of the screen from the two charts a trade is worked from.
  // WHAT THIS COMPONENT STILL DOES IS EVERYTHING ELSE, and that is why it is
  // still mounted when it draws so little: it is what reads the positions from
  // Zerodha, notices one taken or closed outside the app, and places the exit
  // order when the chart's Exit or ScalpPro's asks for one (exit_position_request).
  // The line is there only while a position is open, as the strip was — so a
  // trade still cannot be forgotten with nothing on screen to say so.
  // The figure is the day's net (what is booked plus what is open), Zerodha's
  // own, as the strip showed. Until that has been read once — and for a practice
  // position, which Zerodha knows nothing of — it is what the open positions
  // come to at their last prices.
  const openPnl = positions.reduce((sum, pos) => {
    const ltp = (lastPrices[pos.id] || { price: pos.entryPrice }).price;
    const computed = pos.side === "BUY" ? (ltp - pos.entryPrice) * pos.qty : (pos.entryPrice - ltp) * pos.qty;
    const live = (!pos.testMode && typeof pos.pnlBase === 'number' && typeof pos.qtySigned === 'number' && ltp > 0)
      ? pos.pnlBase + pos.qtySigned * ltp : null;
    return sum + (live !== null ? live : (!pos.testMode && typeof pos.kitePnl === 'number') ? pos.kitePnl : computed);
  }, 0);
  const overall = netPnl !== null ? netPnl : openPnl;
  return (
    <div
      data-positions-line=""
      className="w-full mb-1 px-3 sm:px-4 py-1 flex items-center justify-between gap-3 border border-emerald-500/20 md:border-x-0 md:rounded-none rounded-xl bg-emerald-500/5 select-none"
    >
      <span className="text-xs font-semibold text-foreground/65 whitespace-nowrap">Overall P&amp;L</span>
      <span data-positions-pnl="" className={`text-sm font-bold font-mono whitespace-nowrap ${overall >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
        {overall >= 0 ? '+' : ''}{new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(overall)}
      </span>
    </div>
  );
}
