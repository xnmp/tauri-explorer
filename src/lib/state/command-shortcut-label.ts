/**
 * Prose hints for command-owned settings copy: the command's effective
 * shortcut (persisted override or default), or nothing when it is unbound.
 */
import { getCommandShortcut } from "./commands.svelte";

/** `" (Ctrl+H)"` for a bound command, `""` when unbound. */
export function shortcutSuffix(commandId: string): string {
  const shortcut = getCommandShortcut(commandId);
  return shortcut ? ` (${shortcut})` : "";
}
