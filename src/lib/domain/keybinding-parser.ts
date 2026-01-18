/**
 * Keybinding parser for customizable hotkeys.
 * Issue: tauri-explorer-npjh.4
 *
 * Parses shortcut strings (e.g., "Ctrl+Shift+P") and matches them against
 * keyboard events. Handles cross-platform modifier keys and Caps Lock.
 */

import { normalizeKeyForShortcut } from "./keyboard";

/** Parsed representation of a keyboard shortcut */
export interface ParsedShortcut {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** Special key display names */
const DISPLAY_NAMES: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
  Escape: "Esc",
  Delete: "Del",
  Backspace: "Backspace",
  Enter: "Enter",
  Tab: "Tab",
};

/** Modifier key aliases (for parsing user input) */
const MODIFIER_ALIASES: Record<string, keyof ParsedShortcut> = {
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  win: "meta",
  windows: "meta",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/**
 * Parse a shortcut string into its components.
 *
 * @example
 * parseShortcut("Ctrl+Shift+P") // { key: "p", ctrl: true, shift: true, alt: false, meta: false }
 * parseShortcut("Alt+Left") // { key: "ArrowLeft", ctrl: false, shift: false, alt: true, meta: false }
 */
export function parseShortcut(shortcut: string): ParsedShortcut | null {
  if (!shortcut || shortcut.trim() === "") {
    return null;
  }

  const parts = shortcut.split("+").map((p) => p.trim());
  if (parts.length === 0) {
    return null;
  }

  const result: ParsedShortcut = {
    key: "",
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lowerPart = part.toLowerCase();

    // Check if it's a modifier
    const modifierKey = MODIFIER_ALIASES[lowerPart];
    if (modifierKey) {
      result[modifierKey] = true;
      continue;
    }

    // Last part (or only non-modifier part) is the key
    // Normalize directional keys
    if (lowerPart === "left") {
      result.key = "ArrowLeft";
    } else if (lowerPart === "right") {
      result.key = "ArrowRight";
    } else if (lowerPart === "up") {
      result.key = "ArrowUp";
    } else if (lowerPart === "down") {
      result.key = "ArrowDown";
    } else if (lowerPart === "space" || lowerPart === "spacebar") {
      result.key = " ";
    } else if (lowerPart === "esc" || lowerPart === "escape") {
      result.key = "Escape";
    } else if (lowerPart === "del") {
      result.key = "Delete";
    } else if (lowerPart === "enter" || lowerPart === "return") {
      result.key = "Enter";
    } else if (part.length === 1) {
      // Single character - store as lowercase for consistent matching
      result.key = part.toLowerCase();
    } else {
      // Preserve casing for special keys (F1, Delete, etc.)
      result.key = part;
    }
  }

  // Must have a key to be valid
  if (!result.key) {
    return null;
  }

  return result;
}

/**
 * Check if a keyboard event matches a parsed shortcut.
 */
export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: ParsedShortcut
): boolean {
  // Check modifiers
  // Use both ctrlKey and metaKey for cross-platform support (Ctrl on Windows, Cmd on Mac)
  const eventCtrl = event.ctrlKey || event.metaKey;
  if (shortcut.ctrl !== eventCtrl) return false;
  if (shortcut.shift !== event.shiftKey) return false;
  if (shortcut.alt !== event.altKey) return false;
  // Meta is checked separately for explicit meta shortcuts
  if (shortcut.meta && !event.metaKey) return false;

  // Normalize and compare the key
  const normalizedEventKey = normalizeKeyForShortcut(event.key);
  const normalizedShortcutKey = normalizeKeyForShortcut(shortcut.key);

  return normalizedEventKey === normalizedShortcutKey;
}

/**
 * Check if a keyboard event matches a shortcut string.
 */
export function matchesShortcutString(
  event: KeyboardEvent,
  shortcutString: string
): boolean {
  const parsed = parseShortcut(shortcutString);
  if (!parsed) return false;
  return matchesShortcut(event, parsed);
}

/**
 * Format a shortcut for display (e.g., for showing in UI).
 */
export function formatShortcut(shortcut: string): string {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return shortcut;

  const parts: string[] = [];

  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.shift) parts.push("Shift");
  if (parsed.alt) parts.push("Alt");
  if (parsed.meta) parts.push("Meta");

  // Format the key for display
  let displayKey = parsed.key;
  if (DISPLAY_NAMES[parsed.key]) {
    displayKey = DISPLAY_NAMES[parsed.key];
  } else if (parsed.key.length === 1) {
    displayKey = parsed.key.toUpperCase();
  }

  parts.push(displayKey);

  return parts.join("+");
}

/**
 * Convert a KeyboardEvent to a shortcut string.
 * Useful for recording new keybindings.
 */
export function eventToShortcutString(event: KeyboardEvent): string | null {
  // Ignore modifier-only key presses
  if (
    event.key === "Control" ||
    event.key === "Shift" ||
    event.key === "Alt" ||
    event.key === "Meta"
  ) {
    return null;
  }

  const parts: string[] = [];

  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");

  // Format the key
  let key = event.key;

  // Normalize arrow keys
  if (key === "ArrowLeft") key = "Left";
  else if (key === "ArrowRight") key = "Right";
  else if (key === "ArrowUp") key = "Up";
  else if (key === "ArrowDown") key = "Down";
  else if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();

  parts.push(key);

  return parts.join("+");
}
