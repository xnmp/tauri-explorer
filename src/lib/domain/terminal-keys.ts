/**
 * Key-ownership rules for the embedded terminal (#249).
 *
 * When the terminal is focused, the shell and the app compete for keyboard
 * shortcuts. The split follows terminal-emulator convention (and VS Code's
 * default): the shell keeps plain typing and single-Ctrl combos — readline
 * binds nearly every Ctrl+<key> (Ctrl+C interrupt, Ctrl+D EOF, Ctrl+R
 * history…) — while combos carrying Alt or Meta, or Ctrl+Shift, belong to
 * the app's shortcut system.
 */

/**
 * True when the shell should keep this keydown; false when the app's
 * shortcut handling may claim it.
 */
export function isShellReservedKey(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey">): boolean {
  // Plain keys and Shift+key are typing.
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return true;
  // Alt/Meta combos are app shortcut territory (Alt+M chords, Super bindings).
  if (event.altKey || event.metaKey) return false;
  // Ctrl-only goes to the shell (readline); Ctrl+Shift goes to the app.
  return !event.shiftKey;
}
