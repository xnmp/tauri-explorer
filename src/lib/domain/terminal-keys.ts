/**
 * Key-ownership rules for the embedded terminal (#249, #260).
 *
 * When the terminal is focused, the shell and the app compete for keyboard
 * shortcuts. The split follows VS Code's model: plain typing stays with the
 * shell; Alt/Meta combos, Ctrl+Shift combos and chord suffixes belong to the
 * app; and a Ctrl-only combo goes to the APP when the app has a binding for
 * it (Ctrl+P quick open, Ctrl+T new tab, …) — except a small shell-critical
 * set (interrupt, EOF, paste, …) that the shell always keeps, binding or not.
 */

type KeyEventLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey"> &
  Partial<Pick<KeyboardEvent, "code">>;

/**
 * Ctrl+<key> combos the shell always keeps, even when the app binds them:
 * Ctrl+C (SIGINT), Ctrl+D (EOF), Ctrl+Z (suspend), Ctrl+V (paste/verbatim),
 * Ctrl+X (emacs prefix), Ctrl+A (line start). The app's clipboard/select-all
 * bindings on these keys make no sense while a shell prompt has focus.
 */
export const SHELL_CRITICAL_CTRL_KEYS: ReadonlySet<string> = new Set([
  "c",
  "d",
  "v",
  "x",
  "z",
  "a",
]);

export interface ShellKeyContext {
  /** The event matches a registered app keybinding or hardcoded app shortcut. */
  appBound?: boolean;
  /** macOS: the primary clipboard modifier is ⌘, so Cmd+C/V/… must stay with
   *  the terminal (#403) instead of falling into "Meta = app territory". */
  isMac?: boolean;
}

/**
 * True when the shell should keep this keydown; false when the app's
 * shortcut handling may claim it.
 */
export function isShellReservedKey(event: KeyEventLike, context?: ShellKeyContext): boolean {
  // Plain keys and Shift+key are typing.
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return true;
  // On mac, ⌘-only clipboard/process combos belong to the terminal (#403):
  // Cmd+C copies the terminal selection, Cmd+V pastes into the shell — the
  // explorer's file clipboard must never fire while a prompt has focus.
  if (
    context?.isMac &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    SHELL_CRITICAL_CTRL_KEYS.has(event.key.toLowerCase())
  ) {
    return true;
  }
  // Alt/Meta combos are app shortcut territory (Alt+M chords, Super bindings).
  if (event.altKey || event.metaKey) return false;
  // Ctrl+Shift goes to the app.
  if (event.shiftKey) return false;
  // Ctrl-only: process-control keys stay with the shell unconditionally…
  if (SHELL_CRITICAL_CTRL_KEYS.has(event.key.toLowerCase())) return true;
  // …anything the app has bound goes to the app (#260); unbound Ctrl combos
  // remain readline territory.
  return !context?.appBound;
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
  { id: "deleteWordBackward", label: "Delete word backward", sequence: "\x17" }, // C-w
  { id: "killLineBackward", label: "Delete to line start", sequence: "\x15" }, // C-u
  { id: "killLineForward", label: "Delete to line end", sequence: "\x0b" }, // C-k
  { id: "clearScreen", label: "Clear screen", sequence: "\x0c" }, // C-l
] as const;

/**
 * Resolve a keydown against the user's terminal shortcut map
 * (action id → binding string like "Alt+Backspace"); returns the control
 * sequence to inject, or null when nothing matches. Unset/empty bindings
 * are disabled — the default map is empty so out of the box every key keeps
 * its native terminal behavior (full-screen apps like vim depend on it).
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

/**
 * App shortcuts hardcoded in +page.svelte outside the keybindings registry
 * (Ctrl+J jobs, Ctrl+, settings, Ctrl+\ dual pane). The terminal gates need
 * to treat these as app-bound too, or they'd never fire while the terminal
 * is focused.
 */
export function isHardcodedAppShortcut(event: KeyEventLike): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  return (
    event.key === "j" ||
    event.key === "," ||
    event.key === "\\" ||
    event.key === "|" ||
    event.code === "Backslash"
  );
}
