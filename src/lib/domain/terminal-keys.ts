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
}

/**
 * True when the shell should keep this keydown; false when the app's
 * shortcut handling may claim it.
 */
export function isShellReservedKey(event: KeyEventLike, context?: ShellKeyContext): boolean {
  // Plain keys and Shift+key are typing.
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return true;
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
