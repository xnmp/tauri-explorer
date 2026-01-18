/**
 * Keybindings state management for customizable hotkeys.
 * Issue: tauri-explorer-npjh.4
 *
 * Manages user-customizable keyboard shortcuts with localStorage persistence.
 * Each command can have a custom shortcut that overrides the default.
 */

import { matchesShortcutString, formatShortcut } from "$lib/domain/keybinding-parser";

/** A single keybinding entry */
export interface Keybinding {
  commandId: string;
  defaultShortcut: string;
  userShortcut: string | null; // null means use default
}

/** Map of command ID to user's custom shortcut (null = use default) */
export type UserKeybindings = Record<string, string | null>;

const STORAGE_KEY = "explorer-keybindings";

/** Default shortcuts defined by commands */
let defaultShortcuts = $state<Record<string, string>>({});

/** User's custom shortcuts (overrides defaults) */
let userShortcuts = $state<UserKeybindings>({});

/**
 * Load user keybindings from localStorage.
 */
function loadUserShortcuts(): UserKeybindings {
  if (typeof localStorage === "undefined") {
    return {};
  }

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // Ignore parse errors
  }

  return {};
}

/**
 * Save user keybindings to localStorage.
 */
function saveUserShortcuts(): void {
  if (typeof localStorage === "undefined") return;

  // Only save non-null entries (user customizations)
  const toSave: UserKeybindings = {};
  for (const [commandId, shortcut] of Object.entries(userShortcuts)) {
    if (shortcut !== null) {
      toSave[commandId] = shortcut;
    }
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

/**
 * Create the keybindings store.
 */
function createKeybindingsStore() {
  // Load saved shortcuts on initialization
  userShortcuts = loadUserShortcuts();

  /**
   * Register a command's default shortcut.
   * Called during command registration.
   */
  function registerDefault(commandId: string, shortcut: string): void {
    defaultShortcuts[commandId] = shortcut;
  }

  /**
   * Register multiple default shortcuts at once.
   */
  function registerDefaults(shortcuts: Record<string, string>): void {
    defaultShortcuts = { ...defaultShortcuts, ...shortcuts };
  }

  /**
   * Get the effective shortcut for a command (user override or default).
   */
  function getShortcut(commandId: string): string | undefined {
    // User override takes precedence
    if (commandId in userShortcuts) {
      const userShortcut = userShortcuts[commandId];
      // null means explicitly unbound
      if (userShortcut === null) return undefined;
      return userShortcut;
    }
    // Fall back to default
    return defaultShortcuts[commandId];
  }

  /**
   * Get the formatted display string for a command's shortcut.
   */
  function getDisplayShortcut(commandId: string): string | undefined {
    const shortcut = getShortcut(commandId);
    return shortcut ? formatShortcut(shortcut) : undefined;
  }

  /**
   * Set a custom shortcut for a command.
   * Pass null to unbind the command.
   */
  function setShortcut(commandId: string, shortcut: string | null): void {
    userShortcuts = { ...userShortcuts, [commandId]: shortcut };
    saveUserShortcuts();
  }

  /**
   * Reset a command to its default shortcut.
   */
  function resetToDefault(commandId: string): void {
    const { [commandId]: _, ...rest } = userShortcuts;
    userShortcuts = rest;
    saveUserShortcuts();
  }

  /**
   * Reset all shortcuts to defaults.
   */
  function resetAllToDefaults(): void {
    userShortcuts = {};
    saveUserShortcuts();
  }

  /**
   * Check if a command has a custom shortcut.
   */
  function hasCustomShortcut(commandId: string): boolean {
    return commandId in userShortcuts;
  }

  /**
   * Get all keybindings (for UI display).
   */
  function getAllBindings(): Keybinding[] {
    const bindings: Keybinding[] = [];

    for (const commandId of Object.keys(defaultShortcuts)) {
      bindings.push({
        commandId,
        defaultShortcut: defaultShortcuts[commandId],
        userShortcut: userShortcuts[commandId] ?? null,
      });
    }

    return bindings;
  }

  /**
   * Find which command matches a keyboard event.
   * Returns the command ID if found, undefined otherwise.
   */
  function findMatchingCommand(event: KeyboardEvent): string | undefined {
    // Build a map of shortcut -> commandId for efficient lookup
    for (const commandId of Object.keys(defaultShortcuts)) {
      const shortcut = getShortcut(commandId);
      if (shortcut && matchesShortcutString(event, shortcut)) {
        return commandId;
      }
    }
    return undefined;
  }

  /**
   * Check for shortcut conflicts.
   * Returns command IDs that would conflict with the given shortcut.
   */
  function findConflicts(shortcut: string, excludeCommandId?: string): string[] {
    const conflicts: string[] = [];

    for (const commandId of Object.keys(defaultShortcuts)) {
      if (commandId === excludeCommandId) continue;

      const existingShortcut = getShortcut(commandId);
      if (existingShortcut && existingShortcut.toLowerCase() === shortcut.toLowerCase()) {
        conflicts.push(commandId);
      }
    }

    return conflicts;
  }

  /**
   * Clear all data for testing purposes.
   * @internal
   */
  function _clearForTesting(): void {
    defaultShortcuts = {};
    userShortcuts = {};
  }

  return {
    registerDefault,
    registerDefaults,
    getShortcut,
    getDisplayShortcut,
    setShortcut,
    resetToDefault,
    resetAllToDefaults,
    hasCustomShortcut,
    getAllBindings,
    findMatchingCommand,
    findConflicts,
    _clearForTesting,

    /** Get the raw user shortcuts (for debugging/inspection) */
    get userShortcuts() {
      return { ...userShortcuts };
    },

    /** Get the raw default shortcuts (for debugging/inspection) */
    get defaultShortcuts() {
      return { ...defaultShortcuts };
    },
  };
}

export const keybindingsStore = createKeybindingsStore();
