import { toast } from "sonner";

export interface TerminalNotification {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
}

export interface SavedNotification {
  id: string;
  type: "oi_alert" | "divergence" | "order" | "system";
  title: string;
  body: string;
  timestamp: string;
  read: boolean;
  metadata?: any;
}

const STORAGE_KEY = "quant_terminal_notification_history";

/**
 * Market-movement alerts describe a MOMENT — a level touched, a zone tapped, a
 * breakout scored. Once that moment has passed they are not information, they
 * are clutter: "Support touched" from Friday tells you nothing on Tuesday, but
 * it still sat in the list with an unread dot because history was capped by
 * COUNT (200) and never by AGE.
 *
 * These types are therefore scoped to the trading session they fired in and
 * pruned on read. Orders and system messages are a RECORD rather than a
 * observation, so they are kept — you should still be able to see yesterday's
 * fills.
 */
const SESSION_SCOPED: SavedNotification["type"][] = ["oi_alert", "divergence"];

/** Start of the session currently in play: 09:15 IST today, or yesterday's if
 *  the day's session has not opened yet. IST is UTC+5:30 with no DST, so
 *  09:15 IST is exactly 03:45 UTC and fixed arithmetic is safe. */
function currentSessionStartMs(now: number = Date.now()): number {
  const d = new Date(now);
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3, 45, 0);
  if (now < start) start -= 86400000;
  return start;
}

/** Drop expired session-scoped alerts. Returns the kept list plus whether
 *  anything was removed, so the caller only writes when it must. */
function pruneExpired(list: SavedNotification[], now: number = Date.now()) {
  const cutoff = currentSessionStartMs(now);
  const kept = list.filter((n) => {
    if (!SESSION_SCOPED.includes(n.type)) return true;
    const t = Date.parse(n.timestamp);
    // An unparseable timestamp is kept rather than silently binned.
    if (!Number.isFinite(t)) return true;
    return t >= cutoff;
  });
  return { kept, changed: kept.length !== list.length };
}
const POPUPS_KEY = "quant_popups_enabled";

export const notificationService = {
  /**
   * Master switch for quant pop-up alerts (desktop notifications). DEFAULT OFF —
   * alerts are always archived to the terminal silently; pop-ups fire only when
   * the user enables them, so they don't mix with the chart's level-touch alerts.
   */
  popupsEnabled(): boolean {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem(POPUPS_KEY) === "1"; } catch { return false; }
  },

  setPopupsEnabled(on: boolean) {
    try { localStorage.setItem(POPUPS_KEY, on ? "1" : "0"); } catch { /* ignore */ }
    this._notifyChange();
  },

  /**
   * Checks if notifications are supported by the browser client
   */
  isSupported(): boolean {
    return typeof window !== 'undefined' && 'Notification' in window;
  },

  /**
   * Retrieves the current permission state
   */
  getPermission(): NotificationPermission {
    if (!this.isSupported()) return 'denied';
    return Notification.permission;
  },

  /**
   * Requests permission to send desktop alerts
   */
  async requestPermission(): Promise<NotificationPermission> {
    if (!this.isSupported()) {
      toast.error("Desktop Alerts Not Supported", {
        description: "Your browser does not support native desktop push alerts.",
      });
      return 'denied';
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        toast.success("Desktop Alerts Granted", {
          description: "Instant option signal updates will now push to your desktop.",
        });
      } else if (permission === 'denied') {
        toast.warning("Desktop Alerts Denied", {
          description: "You will only receive local in-browser toaster messages.",
        });
      }
      return permission;
    } catch (err) {
      console.error("Failed requesting notification permissions:", err);
      return 'denied';
    }
  },

  /**
   * Fires a native browser push notification
   */
  send(notification: TerminalNotification) {
    if (!this.isSupported()) return;

    if (Notification.permission === 'granted') {
      try {
        const options: NotificationOptions = {
          body: notification.body,
          icon: notification.icon || '/icon.svg',
          tag: notification.tag || 'quant-terminal-alert',
          badge: '/icon.svg',
        };

        // If service worker is active, push notification through registration for better PWA experience
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.ready.then((reg) => {
            reg.showNotification(notification.title, options);
          }).catch(() => {
            // Fallback to standard window Notification
            new Notification(notification.title, options);
          });
        } else {
          new Notification(notification.title, options);
        }
      } catch (err) {
        console.error("Error dispatching desktop notification:", err);
      }
    } else if (Notification.permission === 'default') {
      // Prompt user with a toast alerting them to enable it
      toast.info("Enable Desktop Alerts", {
        description: "Click here to receive instant desktop alerts for options triggers.",
        action: {
          label: "Enable",
          onClick: () => this.requestPermission(),
        },
      });
    }
  },

  /**
   * Gets notification history from localStorage
   */
  getHistory(): SavedNotification[] {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const list: SavedNotification[] = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      // Prune on read, so every consumer — list, filters, unread badge — sees
      // the same session-scoped view without needing to know the rule.
      const { kept, changed } = pruneExpired(list);
      if (changed) {
        // Write back WITHOUT _notifyChange: this is called from render paths and
        // from add() itself, and a change event here would re-enter.
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(kept)); } catch (e) {}
      }
      return kept;
    } catch (e) {
      console.error("Failed to read notifications from localStorage", e);
      return [];
    }
  },

  /**
   * Clears notification history
   */
  clearAll() {
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem(STORAGE_KEY);
      this._notifyChange();
    } catch (e) {
      console.error("Failed to clear notifications storage", e);
    }
  },

  /**
   * Marks a specific notification as read
   */
  markAsRead(id: string) {
    if (typeof window === "undefined") return;
    try {
      const history = this.getHistory();
      const updated = history.map((n) =>
        n.id === id ? { ...n, read: true } : n
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      this._notifyChange();
    } catch (e) {
      console.error("Failed to mark notification as read", e);
    }
  },

  /**
   * Marks all notifications as read
   */
  markAllAsRead() {
    if (typeof window === "undefined") return;
    try {
      const history = this.getHistory();
      const updated = history.map((n) => ({ ...n, read: true }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      this._notifyChange();
    } catch (e) {
      console.error("Failed to mark all notifications as read", e);
    }
  },

  /**
   * Adds a new notification to the history
   */
  add(
    type: SavedNotification["type"],
    title: string,
    body: string,
    metadata?: any
  ): SavedNotification {
    const id = Math.random().toString(36).substring(2, 11);
    const notification: SavedNotification = {
      id,
      type,
      title,
      body,
      timestamp: new Date().toISOString(),
      read: false,
      metadata,
    };

    if (typeof window !== "undefined") {
      try {
        const history = this.getHistory();
        // Limit history size to 200 items to prevent localStorage bloating
        const updated = [notification, ...history].slice(0, 200);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        this._notifyChange();
      } catch (e) {
        console.error("Failed to save notification to localStorage", e);
      }

      // Also dispatch to OS-level notification tray if permissions allow —
      // ONLY when quant pop-ups are enabled (default off; see popupsEnabled).
      if (this.popupsEnabled() && (type === "oi_alert" || type === "divergence" || type === "order")) {
        this.send({
          title: `[Quant] ${title}`,
          body: body,
        });
      }
    }

    return notification;
  },

  /**
   * Dispatches custom event to notify listeners
   */
  _notifyChange() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("notifications-updated"));
    }
  },
};
