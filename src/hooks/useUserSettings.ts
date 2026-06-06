import { useState, useEffect } from "react";

export interface UserSettings {
  soundAlerts: boolean;
  desktopNotifications: boolean;
  refreshInterval: number; // in milliseconds, e.g., 5000, 10000, 30000
  chartTheme: 'cosmic' | 'neon' | 'monochrome';
  strikeBuffer: number; // number of strike prices to load
  highFpsMode: boolean; // toggle fancy transitions for fast renders
}

const DEFAULT_SETTINGS: UserSettings = {
  soundAlerts: true,
  desktopNotifications: false,
  refreshInterval: 10000,
  chartTheme: 'cosmic',
  strikeBuffer: 5,
  highFpsMode: true,
};

export function useUserSettings() {
  const [settings, setSettings] = useState<UserSettings>(() => {
    try {
      const stored = localStorage.getItem("quant_terminal_settings");
      if (stored) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
      }
    } catch (e) {
      console.warn("Could not load user settings from local storage:", e);
    }
    return DEFAULT_SETTINGS;
  });

  const updateSetting = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings((prev) => {
      const updated = { ...prev, [key]: value };
      try {
        localStorage.setItem("quant_terminal_settings", JSON.stringify(updated));
      } catch (e) {
        console.error("Failed saving settings to local storage:", e);
      }
      return updated;
    });
  };

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    try {
      localStorage.setItem("quant_terminal_settings", JSON.stringify(DEFAULT_SETTINGS));
    } catch (e) {
      console.error("Failed resetting settings:", e);
    }
  };

  return {
    settings,
    updateSetting,
    resetSettings,
  };
}
