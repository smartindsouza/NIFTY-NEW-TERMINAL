// ONLY TWO MARKET ALERTS (20 Nov 2026). Martin: "Remove all the alerts which are
// currently getting a delivered. I just want a breaker block alert and Swap sweep
// reversal indicator alert forming in every time frame except the 1 min and 3 min
// time frame". NIFTY only, on Telegram and in the app.
//
// The server finds them (server/setup_alerts.ts, the chart's own indicators on
// NIFTY 5m, 15m, 30m and 1h) and sends them to Telegram. This shows the same ones
// in the app wherever it is open: a toast, a short chime, a phone notification if
// they are allowed, and a line in the Notifications list. Each once per device;
// one made before the app was opened is not announced.
//
// MARKET_ALERTS_OFF silences every other market alert in the app (level touches,
// zone taps, breakouts, divergences, 50% levels, Swap-Sweep 5m+15m confluence,
// GIFT divergence, live signal, world-market moves, the bias popup). Orders and
// system messages, and lines he draws and arms himself, are not affected.
import { useEffect } from 'react';
import { toast } from 'sonner';
import { notificationService } from '../lib/notificationService';

export const MARKET_ALERTS_OFF = true;

const SEEN_KEY = 'setupAlertsSeen';
const OPENED_AT = Date.now();

function chime() {
  try {
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext; if (!AC) return;
    const a = new AC(); const o = a.createOscillator(); const g = a.createGain();
    o.connect(g); g.connect(a.destination); o.frequency.value = 740; g.gain.value = 0.07;
    o.start(); o.frequency.setValueAtTime(980, a.currentTime + 0.12); o.stop(a.currentTime + 0.26);
    setTimeout(() => { try { a.close(); } catch (e) {} }, 500);
  } catch (e) {}
}

export function SetupAlerts() {
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const r = await fetch(`/api/setup-alerts?since=${Date.now() - 6 * 3600000}`);
        if (!r.ok) return;
        const j = await r.json();
        let seen: string[] = [];
        try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); if (Array.isArray(v)) seen = v; } catch (e) {}
        let changed = false;
        for (const a of (j.alerts || []) as any[]) {
          if (seen.includes(a.id)) continue;
          seen.push(a.id); changed = true;
          if (Number(a.at) < OPENED_AT - 60000) continue;      // before the app was opened: listed nowhere, not replayed
          try { toast(a.title, { description: a.body, duration: 12000, closeButton: true }); } catch (e) {}
          try { notificationService.add('divergence', a.title, a.body, { ephemeral: true, source: 'setup-alert', key: a.id }); } catch (e) {}
          try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(a.title, { body: a.body, tag: a.id }); } catch (e) {}
          chime();
        }
        if (changed) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-300))); } catch (e) {} }
      } catch (e) { /* the next poll tries again */ }
    };
    poll();
    const iv = window.setInterval(poll, 20000);
    const vis = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', vis);
    return () => { stopped = true; window.clearInterval(iv); document.removeEventListener('visibilitychange', vis); };
  }, []);
  return null;
}
