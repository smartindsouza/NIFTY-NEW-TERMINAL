import { useState, useEffect } from "react";
import { notificationService, SavedNotification } from "../lib/notificationService";

export function useNotifications() {
  const [notifications, setNotifications] = useState<SavedNotification[]>([]);

  useEffect(() => {
    // Initial load
    setNotifications(notificationService.getHistory());

    const handleUpdate = () => {
      setNotifications(notificationService.getHistory());
    };

    window.addEventListener("notifications-updated", handleUpdate);
    return () => {
      window.removeEventListener("notifications-updated", handleUpdate);
    };
  }, []);

  return {
    notifications,
    addNotification: (
      type: SavedNotification["type"],
      title: string,
      body: string,
      metadata?: any
    ) => {
      return notificationService.add(type, title, body, metadata);
    },
    markAsRead: (id: string) => {
      notificationService.markAsRead(id);
    },
    markAllAsRead: () => {
      notificationService.markAllAsRead();
    },
    clearAll: () => {
      notificationService.clearAll();
    },
    unreadCount: notifications.filter((n) => !n.read).length,
  };
}
