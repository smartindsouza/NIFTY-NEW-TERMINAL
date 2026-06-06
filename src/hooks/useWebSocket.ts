import { useState, useEffect } from 'react';
import { performanceTracker } from '../lib/performanceTracker';

export type WsStatus = 'Connecting' | 'Connected' | 'Reconnecting' | 'Failed';

let globalWsStatus: WsStatus = 'Connecting';
let activeWs: WebSocket | null = null;
const messageListeners = new Set<(msg: any) => void>();

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
