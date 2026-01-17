/**
 * Keyboard shortcut utilities.
 * Provides consistent key normalization for keyboard event handling.
 *
 * The main issue this solves is that `event.key` returns different cases
 * depending on Caps Lock state:
 * - Caps Lock OFF: Ctrl+V returns "v"
 * - Caps Lock ON: Ctrl+V returns "V"
 *
 * By normalizing to lowercase, we ensure shortcuts work regardless of Caps Lock.
 */

/**
 * Normalizes a keyboard event key for consistent shortcut matching.
 *
 * - Single letter keys are lowercased (handles Caps Lock)
 * - Special keys (Delete, F1-F12, Arrow*, etc.) are preserved as-is
 *
 * @param key - The `event.key` value from a KeyboardEvent
 * @returns Normalized key for comparison
 */
export function normalizeKeyForShortcut(key: string): string {
  // Single letter keys should be lowercased for consistent matching
  if (key.length === 1) {
    return key.toLowerCase();
  }
  // Special keys (Delete, F1, ArrowLeft, etc.) keep their original casing
  return key;
}

/**
 * Checks if the given key matches a target shortcut key.
 *
 * @param eventKey - The `event.key` value from a KeyboardEvent
 * @param targetKey - The target key to match (should be lowercase for letters)
 * @returns true if keys match
 */
export function matchesShortcutKey(eventKey: string, targetKey: string): boolean {
  return normalizeKeyForShortcut(eventKey) === targetKey;
}

/**
 * Common modifier shortcut keys mapped to lowercase for consistent comparison.
 */
export const SHORTCUT_KEYS = {
  COPY: "c",
  CUT: "x",
  PASTE: "v",
  UNDO: "z",
  REDO: "y",
  SELECT_ALL: "a",
  SAVE: "s",
  NEW: "n",
  OPEN: "o",
  FIND: "f",
} as const;

/**
 * Common special keys that don't need normalization.
 */
export const SPECIAL_KEYS = {
  DELETE: "Delete",
  BACKSPACE: "Backspace",
  ENTER: "Enter",
  ESCAPE: "Escape",
  TAB: "Tab",
  SPACE: " ",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
  ARROW_UP: "ArrowUp",
  ARROW_DOWN: "ArrowDown",
  ARROW_LEFT: "ArrowLeft",
  ARROW_RIGHT: "ArrowRight",
} as const;
