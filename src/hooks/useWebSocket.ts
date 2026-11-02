import { useState, useEffect } from 'react';
import { performanceTracker } from '../lib/performanceTracker';

export type WsStatus = 'Connecting' | 'Connected' | 'Reconnecting' | 'Failed';

let globalWsStatus: WsStatus = 'Connecting';
let activeWs: WebSocket | null = null;
const messageListeners = new Set<(msg: any) => void>();

// PRICE-AGE MEASUREMENT (2 Nov 2026). On every tick the phone notes how old the
// price is: since the server sent it, and since the exchange stamped it — both
// in SERVER time (the phone clock is corrected with a ping each minute). Every
// 30 s a summary goes to /api/diag/latency/client. Diagnostic only.
const lat = { offset: 0, rtt: null as number | null, net: [] as number[], total: [] as number[], gaps: [] as number[], lastAt: 0, started: false };
const q = (a: number[], p: number) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sum = (a: number[]) => ({ p50: q(a, 0.5), p90: q(a, 0.9), max: a.length ? Math.max(...a) : null });
function startLatencyProbe() {
  if (lat.started) return; lat.started = true;
  // Clock correction: 4 pings, keep the fastest (the error is at most half its
  // round trip). A slow ping is ignored rather than averaged in.
  const sync = async () => {
    let best: { rtt: number; off: number } | null = null;
    for (let k = 0; k < 4; k++) {
      try {
        const t0 = Date.now(); const r = await fetch('/api/diag/time', { cache: 'no-store' }); const d = await r.json(); const t1 = Date.now();
        if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, off: d.now - (t0 + t1) / 2 };      // server minus phone
      } catch { }
    }
    if (best) { lat.rtt = best.rtt; lat.offset = best.off; }
  };
  void sync(); setInterval(sync, 60000);
  setInterval(() => {
    if (!lat.net.length && !lat.total.length) return;
    const body = { device: navigator.userAgent.replace(/^.*?\(([^)]*)\).*$/, '$1').slice(0, 60), visible: document.visibilityState === 'visible',
      rttMs: lat.rtt, ticks: lat.net.length, net: sum(lat.net), total: sum(lat.total), gap: sum(lat.gaps) };
    lat.net = []; lat.total = []; lat.gaps = [];
    fetch('/api/diag/latency/client', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => { });
  }, 30000);
}
function noteTickAge(data: any) {
  if (!data || (data.type !== 'tick' && data.type !== 'optionTick') || typeof data.srvTs !== 'number') return;
  const now = Date.now() + lat.offset;                              // phone receipt, in server time
  lat.net.push(now - data.srvTs);
  if (typeof data.exTs === 'number' && data.exTs > 0) lat.total.push(now - data.exTs);
  if (data.type === 'tick' && data.symbol === 'NSE:NIFTY 50') { if (lat.lastAt) lat.gaps.push(now - lat.lastAt); lat.lastAt = now; }
  if (lat.net.length > 5000) { lat.net.shift(); lat.total.shift(); }
}

export function getWsDiagnostics() {
  return { status: globalWsStatus };
}

/**
 * Subscribes a specific trading symbol to the WebSocket tick stream.
 * Only one active chart symbol is subscribed at any given time.
 */
let pendingSubscription: string | null = null;

export function subscribeToTicks(symbol: string) {
  // Enforce diagnostic limits
  performanceTracker.subscribeToSymbol(symbol);
  
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    console.log(`[WS Client] Sending active subscription for: ${symbol}`);
    activeWs.send(JSON.stringify({ type: 'subscribe', symbol }));
    pendingSubscription = null;
  } else {
    pendingSubscription = symbol;
  }
}

/**
 * Registers an event listener callback for incoming WebSocket push messages.
 */
export function addWsMessageListener(callback: (msg: any) => void) {
  messageListeners.add(callback);
  return () => {
    messageListeners.delete(callback);
  };
}

export function useGlobalWebSocket() {
  const [status, setStatus] = useState<WsStatus>(globalWsStatus);
  const [lastUpdate, setLastUpdate] = useState<string>('');

  useEffect(() => {
    let reconnectTimer: NodeJS.Timeout | null = null;
    let attempt = 0;
    const maxBackoff = 30000;
    let isUnmounted = false;

    const connect = () => {
      if (isUnmounted) return;

      const updateStatus = (s: WsStatus) => {
        globalWsStatus = s;
        setStatus(s);
      };

      if (attempt === 0) updateStatus('Connecting');
      else updateStatus('Reconnecting');

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
      activeWs = ws;

      ws.onopen = () => {
        attempt = 0;
        updateStatus('Connected');
        
        // Re-subscribe to any active tracking symbol upon reconnection
        if (pendingSubscription) {
          ws.send(JSON.stringify({ type: 'subscribe', symbol: pendingSubscription }));
          pendingSubscription = null;
        } else {
          const activeSubscriptions = performanceTracker.getWsSubscriptions();
          if (activeSubscriptions.length > 0) {
            ws.send(JSON.stringify({ type: 'subscribe', symbol: activeSubscriptions[0] }));
          }
        }
      };

      ws.onclose = () => {
        updateStatus('Failed');
        if (!isUnmounted) {
          const backoff = Math.min(1000 * Math.pow(1.5, attempt), maxBackoff);
          attempt++;
          reconnectTimer = setTimeout(connect, backoff);
        }
      };

      ws.onerror = (err) => {
        console.error("[WS Client] Error encountered:", err);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          try { startLatencyProbe(); noteTickAge(data); } catch { }
          
          if (data.type === 'heartbeat' || data.type === 'connected' || data.type === 'subscribed') {
            updateStatus('Connected');
            setLastUpdate(new Date().toLocaleTimeString());
          }

          // Distribute events to all active chart or option listeners
          messageListeners.forEach((listener) => {
            try {
              listener(data);
            } catch (err) {
              console.error("[WS Listener Error]", err);
            }
          });
        } catch (e) {
          console.error("[WS JSON Error]", e);
        }
      };
    };

    if (!activeWs || activeWs.readyState === WebSocket.CLOSED) {
      connect();
    } else {
      // Sync local component state with pre-existing global status
      setStatus(globalWsStatus);
    }

    return () => {
      isUnmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  return { status, lastUpdate };
}
