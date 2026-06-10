import { useState, useEffect, useCallback } from "react";

export interface UserSettings {
  soundAlerts: boolean;
  desktopNotifications: boolean;
  refreshInterval: number;
  chartTheme: 'cosmic' | 'neon' | 'monochrome';
  appTheme: 'dark' | 'light';
  accentColor: string;
  customFontUrl: string;
  strikeBuffer: number;
  highFpsMode: boolean;
}

const DEFAULT_SETTINGS: UserSettings = {
  soundAlerts: true,
  desktopNotifications: false,
  refreshInterval: 10000,
  chartTheme: 'cosmic',
  appTheme: 'dark',
  accentColor: '#a855f7',
  customFontUrl: '',
  strikeBuffer: 5,
  highFpsMode: true,
};

// Global state mechanism
let globalSettings: UserSettings = { ...DEFAULT_SETTINGS };
const listeners = new Set<() => void>();

try {
  const stored = localStorage.getItem("quant_terminal_settings");
  if (stored) {
    globalSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  }
} catch (e) {
  console.warn("Could not load user settings from local storage:", e);
}

function dispatchChange() {
  listeners.forEach((listener) => listener());
}

export function useUserSettings() {
  const [settings, setSettings] = useState<UserSettings>(globalSettings);

  useEffect(() => {
    const listener = () => setSettings(globalSettings);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const updateSetting = useCallback(<K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    globalSettings = { ...globalSettings, [key]: value };
    try {
      localStorage.setItem("quant_terminal_settings", JSON.stringify(globalSettings));
    } catch (e) {
      console.error("Failed saving settings to local storage:", e);
    }
    dispatchChange();
  }, []);

  const resetSettings = useCallback(() => {
    globalSettings = { ...DEFAULT_SETTINGS };
    try {
      localStorage.setItem("quant_terminal_settings", JSON.stringify(globalSettings));
    } catch (e) {
      console.error("Failed resetting settings:", e);
    }
    dispatchChange();
  }, []);

  return {
    settings,
    updateSetting,
    resetSettings,
  };
}
