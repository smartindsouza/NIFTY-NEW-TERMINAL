import { useState, useEffect, useCallback } from "react";

export interface UserSettings {
  soundAlerts: boolean;
  desktopNotifications: boolean;
  refreshInterval: number;
  chartTheme: 'cosmic' | 'neon' | 'monochrome';
  appTheme: 'dark' | 'light' | 'auto';
  accentColor: string;
  customFontUrl: string;
  strikeBuffer: number;
  highFpsMode: boolean;
  // Candle and volume colours. One pair drives both: the volume histogram uses
  // the same hues at lower opacity, so a green candle and its bar always agree.
  candleUpColor: string;
  candleDownColor: string;
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
  candleUpColor: '#22c55e',
  candleDownColor: '#ef4444',
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


// ---------------------------------------------------------------------------
// Resolved theme: what is actually on screen, after 'auto' has been settled
// against the OS. Components that paint outside the CSS-variable system (the
// chart canvas) need a plain 'dark' | 'light', and they need it to change when
// the OS flips at sunset without a reload — hence a subscription rather than a
// one-off read.
// ---------------------------------------------------------------------------
export type ResolvedTheme = 'dark' | 'light';
export function resolveTheme(pref: UserSettings['appTheme']): ResolvedTheme {
  if (pref === 'dark' || pref === 'light') return pref;
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch (e) { return 'dark'; }
}
export function useResolvedTheme(): ResolvedTheme {
  const { settings } = useUserSettings();
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveTheme(settings.appTheme));
  useEffect(() => {
    setTheme(resolveTheme(settings.appTheme));
    if (settings.appTheme !== 'auto' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setTheme(resolveTheme('auto'));
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange); };
  }, [settings.appTheme]);
  return theme;
}
