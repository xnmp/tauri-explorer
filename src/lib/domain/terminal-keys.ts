/**
 * Key-ownership rules for the embedded terminal (#249, #260).
 *
 * When the terminal is focused, its application owns keyboard input. Explorer
 * keeps only a small, explicit navigation allowlist: Quick Open, Command
 * Palette, and previous/next tab. Every other key reaches the terminal so
 * full-screen terminal apps can use their own bindings.
 */

type KeyEventLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey"> &
  Partial<Pick<KeyboardEvent, "code">>;

/**
 * Ctrl+<key> combos the shell always keeps, even when the app binds them:
 * Ctrl+C (SIGINT), Ctrl+D (EOF), Ctrl+Z (suspend), Ctrl+V (paste/verbatim),
 * Ctrl+X (emacs prefix), Ctrl+A (line start). The app's clipboard/select-all
 * bindings on these keys make no sense while a shell prompt has focus.
 */
export interface ShellKeyContext {
  /** The event matches an available registered Explorer command. */
  appBound?: boolean;
}

/**
 * The only Explorer shortcuts that may claim keyboard input from a focused
 * terminal. Keep this list intentionally small: terminal applications own all
 * other app-level bindings, including custom bindings and chords.
 */
export function isAlwaysActiveTerminalShortcut(event: KeyEventLike): boolean {
  const hasExactlyOnePrimaryModifier = event.ctrlKey !== event.metaKey;
  if (!hasExactlyOnePrimaryModifier || event.altKey) return false;

  const key = event.key.toLowerCase();
  if (key === "p") return true;
  return !event.shiftKey && (event.key === "PageUp" || event.key === "PageDown");
}

/**
 * True when the shell should keep this keydown; false when the app's
 * shortcut handling may claim it.
 */
export function isShellReservedKey(event: KeyEventLike, context?: ShellKeyContext): boolean {
  return !(context?.appBound && isAlwaysActiveTerminalShortcut(event));
}

// ─── Configurable line-editing shortcuts (#375) ─────────────────────────────

import { matchesShortcutString } from "./keybinding-parser";

/** A shell line-editing action a key combo can be bound to. The sequence is
 *  the readline/emacs control byte the shell understands — portable across
 *  bash/zsh/fish and PSReadLine, unlike terminal escape sequences. */
export interface TerminalLineAction {
  id: string;
  label: string;
  sequence: string;
}

export const TERMINAL_LINE_ACTIONS: readonly TerminalLineAction[] = [
  { id: "beginningOfLine", label: "Beginning of line", sequence: "\x01" }, // C-a
  { id: "endOfLine", label: "End of line", sequence: "\x05" }, // C-e
  { id: "wordLeft", label: "Move word left", sequence: "\x1bb" }, // M-b
  { id: "wordRight", label: "Move word right", sequence: "\x1bf" }, // M-f
  { id: "deleteWordBackward", label: "Delete word backward", sequence: "\x17" }, // C-w
  { id: "killLineBackward", label: "Delete to line start", sequence: "\x15" }, // C-u
  { id: "killLineForward", label: "Delete to line end", sequence: "\x0b" }, // C-k
  { id: "clearScreen", label: "Clear screen", sequence: "\x0c" }, // C-l
] as const;

/**
 * Platform default bindings (#404). Off-mac the map is empty — every key
 * keeps its native terminal behavior (full-screen apps like vim depend on
 * it). On mac, Home/End and Option+arrows do nothing useful at a zsh prompt
 * out of the box (zsh doesn't bind their escape sequences), so they default
 * to the matching readline motions — each can be cleared in Settings
 * (empty binding = native behavior) if a full-screen app needs the raw key.
 */
export function defaultTerminalShortcuts(isMac: boolean): Record<string, string> {
  if (!isMac) return {};
  return {
    beginningOfLine: "Home",
    endOfLine: "End",
    wordLeft: "Alt+Left",
    wordRight: "Alt+Right",
  };
}

/** The map `resolveTerminalShortcut` should see: platform defaults overlaid
 *  with the user's bindings (a user's empty string disables a default). */
export function effectiveTerminalShortcuts(
  user: Record<string, string>,
  isMac: boolean,
): Record<string, string> {
  return { ...defaultTerminalShortcuts(isMac), ...user };
}

/**
 * Resolve a keydown against a terminal shortcut map
 * (action id → binding string like "Alt+Backspace"); returns the control
 * sequence to inject, or null when nothing matches. Unset/empty bindings
 * are disabled.
 */
export function resolveTerminalShortcut(
  event: KeyboardEvent,
  shortcuts: Record<string, string>,
): string | null {
  for (const action of TERMINAL_LINE_ACTIONS) {
    const binding = shortcuts[action.id];
    if (!binding) continue;
    if (matchesShortcutString(event, binding)) return action.sequence;
  }
  return null;
}
