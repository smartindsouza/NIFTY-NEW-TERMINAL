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
      return raw ? JSON.parse(raw) : [];
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
