/**
 * Settings state management using Svelte 5 runes.
 * Issue: tauri-explorer-npjh
 *
 * Stores UI preferences and hotkey customization.
 * Persisted to localStorage.
 */

export interface Settings {
  showToolbar: boolean;
  showSidebar: boolean;
  showHidden: boolean;
  zoomLevel: number; // percentage, e.g. 100 = 100%
}

const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const ZOOM_STEP = 10;

const DEFAULT_SETTINGS: Settings = {
  showToolbar: true,
  showSidebar: true,
  showHidden: false,
  zoomLevel: 100,
};

const STORAGE_KEY = "explorer-settings";

function loadSettings(): Settings {
  if (typeof localStorage === "undefined") {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch {
    // Ignore parse errors
  }

  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: Settings): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function createSettingsStore() {
  let settings = $state<Settings>(loadSettings());

  function update(partial: Partial<Settings>): void {
    settings = { ...settings, ...partial };
    saveSettings(settings);
  }

  function toggleToolbar(): void {
    update({ showToolbar: !settings.showToolbar });
  }

  function toggleSidebar(): void {
    update({ showSidebar: !settings.showSidebar });
  }

  function toggleHidden(): void {
    update({ showHidden: !settings.showHidden });
  }

  function zoomIn(): void {
    update({ zoomLevel: Math.min(MAX_ZOOM, settings.zoomLevel + ZOOM_STEP) });
  }

  function zoomOut(): void {
    update({ zoomLevel: Math.max(MIN_ZOOM, settings.zoomLevel - ZOOM_STEP) });
  }

  function zoomReset(): void {
    update({ zoomLevel: 100 });
  }

  function reset(): void {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings(settings);
  }

  return {
    get state() {
      return settings;
    },
    get showToolbar() {
      return settings.showToolbar;
    },
    get showSidebar() {
      return settings.showSidebar;
    },
    get showHidden() {
      return settings.showHidden;
    },
    get zoomLevel() {
      return settings.zoomLevel;
    },
    update,
    toggleToolbar,
    toggleSidebar,
    toggleHidden,
    zoomIn,
    zoomOut,
    zoomReset,
    reset,
  };
}

export const settingsStore = createSettingsStore();
