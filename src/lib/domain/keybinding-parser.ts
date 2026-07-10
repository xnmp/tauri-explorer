/**
 * Keybinding parser for customizable hotkeys.
 * Issue: tauri-explorer-npjh.4
 *
 * Parses shortcut strings (e.g., "Ctrl+Shift+P") and matches them against
 * keyboard events. Handles cross-platform modifier keys and Caps Lock.
 */

import { normalizeKeyForShortcut } from "./keyboard";
import { isMac } from "./platform";

/** Parsed representation of a single keyboard shortcut step */
export interface ParsedShortcut {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** A chord shortcut is a sequence of two key presses (e.g., "Alt+M T") */
export interface ParsedChord {
  prefix: ParsedShortcut;
  suffix: ParsedShortcut;
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

/** Modifier keys in ParsedShortcut (excludes "key") */
type ModifierKey = "ctrl" | "shift" | "alt" | "meta";

/**
 * Modifier key aliases (for parsing user input).
 *
 * The Windows/"Super" key maps to `meta`, the same slot as macOS Cmd. Note
 * that Windows itself reserves most Win-key combinations at the OS level, so
 * pure Win bindings rarely reach the app — `meta` is kept mainly so cross-
 * platform bindings authored as "Cmd+…" still parse on Windows.
 */
const MODIFIER_ALIASES: Record<string, ModifierKey> = {
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  win: "meta",
  windows: "meta",
  super: "meta",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/** Key name aliases (maps user-friendly names to event.key values) */
const KEY_ALIASES: Record<string, string> = {
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  space: " ",
  spacebar: " ",
  esc: "Escape",
  escape: "Escape",
  del: "Delete",
  enter: "Enter",
  return: "Enter",
};

/** Reverse map: event.key values to shortcut string format */
const KEY_TO_SHORTCUT: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  " ": "Space",
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

  // A trailing literal "+" key is written as "Ctrl++" (or just "+").
  // Peel it off before splitting so the separator split doesn't eat it.
  let body = shortcut.trim();
  let literalPlusKey = false;
  if (body === "+") {
    literalPlusKey = true;
    body = "";
  } else if (body.endsWith("++")) {
    literalPlusKey = true;
    body = body.slice(0, -2);
  }

  const parts = body === "" ? [] : body.split("+").map((p) => p.trim());

  const result: ParsedShortcut = {
    key: literalPlusKey ? "+" : "",
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lowerPart = part.toLowerCase();

    // Empty segment means a malformed definition like "Ctrl+" or "Ctrl+++A"
    if (part === "") {
      return null;
    }

    // Check if it's a modifier
    const modifierKey = MODIFIER_ALIASES[lowerPart];
    if (modifierKey) {
      result[modifierKey] = true;
      continue;
    }

    // Reject multi-key definitions like "Ctrl+A+B" instead of silently
    // keeping only the last key.
    if (result.key) {
      return null;
    }

    const aliasedKey = KEY_ALIASES[lowerPart];
    if (aliasedKey) {
      result.key = aliasedKey;
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
  // Check modifiers — exact in both directions so extra held modifiers
  // (e.g. Ctrl+Meta+P against a Ctrl+P binding) never leak through.
  if (shortcut.meta) {
    // Explicit Meta binding: metaKey required, ctrl must match exactly.
    if (!event.metaKey) return false;
    if (shortcut.ctrl !== event.ctrlKey) return false;
  } else if (shortcut.ctrl) {
    // "Ctrl" bindings fire on either Ctrl or Cmd (mac convention, matching
    // eventToShortcutString which records Cmd as "Ctrl") — but exactly one
    // of the two, never both and never neither.
    if (event.ctrlKey === event.metaKey) return false;
  } else {
    // Binding has no ctrl/meta: the event must not have them either.
    if (event.ctrlKey || event.metaKey) return false;
  }
  if (shortcut.shift !== event.shiftKey) return false;
  if (shortcut.alt !== event.altKey) return false;

  // On macOS, Option/Alt produces special characters in event.key (e.g., Alt+M → "µ").
  // Use event.code (physical key) when Alt is held to match the intended key.
  const eventKey = event.altKey && event.code?.startsWith("Key")
    ? event.code.slice(3).toLowerCase()
    : event.key;

  const normalizedShortcutKey = normalizeKeyForShortcut(shortcut.key);

  if (normalizeKeyForShortcut(eventKey) === normalizedShortcutKey) return true;

  // Layout fallback: on non-US (and Windows) layouts a shifted digit yields a
  // symbol in event.key (e.g. Shift+1 → "!"), so "Ctrl+Shift+1" would never
  // match. Recover the layout-independent letter/digit from the physical
  // event.code and compare that. Used only as a fallback so logical matching
  // (the common case) still wins first.
  const physical = physicalKeyFromCode(event.code);
  if (physical && normalizeKeyForShortcut(physical) === normalizedShortcutKey) {
    return true;
  }

  return false;
}

/**
 * Recover the layout-independent character a physical key represents from
 * `event.code`. Letters (`KeyA` → `"a"`) and digits (`Digit1` → `"1"`) only;
 * returns null for other codes so the caller falls back to `event.key`.
 */
function physicalKeyFromCode(code: string | undefined): string | null {
  if (!code) return null;
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  return null;
}

/**
 * Check if a shortcut string is a chord (two-step sequence).
 * Chord shortcuts use a space to separate the two steps: "Alt+M T"
 */
export function isChordShortcut(shortcutString: string): boolean {
  return shortcutString.includes(" ");
}

/**
 * Parse a chord shortcut string into prefix and suffix.
 * @example parseChord("Alt+M T") => { prefix: Alt+M, suffix: T }
 */
export function parseChord(shortcutString: string): ParsedChord | null {
  const spaceIndex = shortcutString.indexOf(" ");
  if (spaceIndex === -1) return null;

  const prefixStr = shortcutString.substring(0, spaceIndex).trim();
  const suffixStr = shortcutString.substring(spaceIndex + 1).trim();

  const prefix = parseShortcut(prefixStr);
  const suffix = parseShortcut(suffixStr);

  if (!prefix || !suffix) return null;
  return { prefix, suffix };
}

/**
 * Check if a keyboard event matches a shortcut string.
 */
export function matchesShortcutString(
  event: KeyboardEvent,
  shortcutString: string
): boolean {
  // Chord shortcuts should not be matched as single-key shortcuts
  if (isChordShortcut(shortcutString)) return false;

  const parsed = parseShortcut(shortcutString);
  if (!parsed) return false;
  return matchesShortcut(event, parsed);
}

/**
 * Format a single parsed shortcut for display.
 */
function formatParsedShortcut(parsed: ParsedShortcut): string {
  const parts: string[] = [];

  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.shift) parts.push("Shift");
  if (parsed.alt) parts.push("Alt");
  if (parsed.meta) parts.push(isMac ? "Cmd" : "Super");

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
 * Format a shortcut for display (e.g., for showing in UI).
 * Supports both single shortcuts and chord shortcuts.
 */
export function formatShortcut(shortcut: string): string {
  if (isChordShortcut(shortcut)) {
    const chord = parseChord(shortcut);
    if (!chord) return shortcut;
    return `${formatParsedShortcut(chord.prefix)} ${formatParsedShortcut(chord.suffix)}`;
  }

  const parsed = parseShortcut(shortcut);
  if (!parsed) return shortcut;
  return formatParsedShortcut(parsed);
}

/** Modifier keys that should be ignored when pressed alone */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * Convert a KeyboardEvent to a shortcut string.
 * Useful for recording new keybindings.
 */
export function eventToShortcutString(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }

  const parts: string[] = [];

  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");

  // On macOS, Option/Alt produces special characters — use event.code for the real key.
  // With Shift, non-US/Windows layouts turn digits into symbols (Shift+1 → "!"),
  // so recover the digit from event.code to record "Ctrl+Shift+1", not "Ctrl+Shift+!".
  const rawKey = event.altKey && event.code?.startsWith("Key")
    ? event.code.slice(3).toLowerCase()
    : event.shiftKey && event.code?.startsWith("Digit")
      ? event.code.slice(5)
      : event.key;

  // Format the key using lookup or uppercase for single chars
  const key = KEY_TO_SHORTCUT[rawKey] ??
    (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey);

  parts.push(key);

  return parts.join("+");
}
