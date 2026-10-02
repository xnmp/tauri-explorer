/**
 * Keybinding parser for customizable hotkeys.
 * Issue: tauri-explorer-npjh.4
 *
 * Parses shortcut strings (e.g., "Ctrl+Shift+P") and matches them against
 * keyboard events. Handles cross-platform modifier keys and Caps Lock.
 */

import { isModifierKey, normalizeKeyForShortcut } from "./keyboard";
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

/** Optional modifier overlays for matching (see keybindings store, #244). */
export interface MatchOptions {
  /** Treat the meta/Super modifier as held even though event.metaKey is
   * false. WebKitGTK maps only GDK_META_MASK into metaKey — the Super/Mod4
   * modifier (the Linux "Cmd") never sets it, so the caller tracks the
   * Super key's held state and overlays it here. */
  metaHeld?: boolean;
}

/**
 * Check if a keyboard event matches a parsed shortcut.
 */
export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: ParsedShortcut,
  options?: MatchOptions
): boolean {
  const metaDown = event.metaKey || options?.metaHeld === true;
  // Check modifiers — exact in both directions so extra held modifiers
  // (e.g. Ctrl+Meta+P against a Ctrl+P binding) never leak through.
  if (shortcut.meta) {
    // Explicit Meta binding: metaKey required, ctrl must match exactly.
    if (!metaDown) return false;
    if (shortcut.ctrl !== event.ctrlKey) return false;
  } else if (shortcut.ctrl) {
    // "Ctrl" bindings fire on either Ctrl or Cmd (mac convention, matching
    // eventToShortcutString which records Cmd as "Ctrl") — but exactly one
    // of the two, never both and never neither.
    if (event.ctrlKey === metaDown) return false;
  } else {
    // Binding has no ctrl/meta: the event must not have them either.
    if (event.ctrlKey || metaDown) return false;
  }
  if (shortcut.shift !== event.shiftKey) return false;
  if (shortcut.alt !== event.altKey) return false;

  return shortcutEventKey(event) === shortcutKeyIdentity(shortcut.key, shortcut.shift);
}

/** Match exactly the identity the recorder has always saved: physical Alt
 * letters (Option-produced characters) and shifted digits, logical other keys.
 * Removing the alternate fallback preserves existing recorded shortcuts while
 * preventing a layout event from also matching a different physical shortcut.
 */
function shortcutEventKey(event: KeyboardEvent): string {
  const letter = event.altKey ? /^Key([A-Z])$/.exec(event.code ?? "") : null;
  const digit = event.shiftKey ? /^Digit([0-9])$/.exec(event.code ?? "") : null;
  return letter ? letter[1].toLowerCase() : digit ? digit[1] : shortcutKeyIdentity(event.key, event.shiftKey);
}

function shortcutKeyIdentity(key: string, shift: boolean): string {
  const normalized = normalizeKeyForShortcut(key);
  // Retain conventional US shifted-digit aliases in existing imported bindings.
  const index = shift && normalized.length === 1 ? "!@#$%^&*()".indexOf(normalized) : -1;
  return index >= 0 ? String((index + 1) % 10) : normalized;
}

/** Conflict checks use exactly the identity used by runtime matching. */
export function shortcutKeysOverlap(left: ParsedShortcut, right: ParsedShortcut): boolean {
  return shortcutKeyIdentity(left.key, left.shift) === shortcutKeyIdentity(right.key, right.shift);
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
  const parts = shortcutString.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [prefixStr, suffixStr] = parts;

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
  shortcutString: string,
  options?: MatchOptions
): boolean {
  // Chord shortcuts should not be matched as single-key shortcuts
  if (isChordShortcut(shortcutString)) return false;

  const parsed = parseShortcut(shortcutString);
  if (!parsed) return false;
  return matchesShortcut(event, parsed, options);
}

/**
 * Format a single parsed shortcut for display.
 */
function formatParsedShortcut(parsed: ParsedShortcut): string {
  const parts: string[] = [];

  if (parsed.ctrl) parts.push(isMac && !parsed.meta ? "Cmd" : "Ctrl");
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

/**
 * Convert a KeyboardEvent to a shortcut string.
 * Useful for recording new keybindings.
 */
export function eventToShortcutString(event: KeyboardEvent, options?: MatchOptions): string | null {
  if (isModifierKey(event.key)) {
    return null;
  }

  const parts: string[] = [];

  const metaDown = event.metaKey || options?.metaHeld === true;
  if (event.ctrlKey || metaDown) parts.push("Ctrl");
  if (event.ctrlKey && metaDown) parts.push("Meta");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");

  const rawKey = shortcutEventKey(event);

  // Format the key using lookup or uppercase for single chars
  const key = KEY_TO_SHORTCUT[rawKey] ??
    (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey);

  parts.push(key);

  return parts.join("+");
}
