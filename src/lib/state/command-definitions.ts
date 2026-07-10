/**
 * Command definitions for the command palette.
 * Issue: tauri-explorer-abm, tauri-explorer-npjh.4
 *
 * Aggregates all command modules and registers them with the command registry.
 */

import { registerCommands } from "./commands.svelte";
import { keybindingsStore } from "./keybindings.svelte";

import { navigationCommands } from "./commands/navigation-commands";
import { fileCommands, editCommands, selectionCommands } from "./commands/file-commands";
import { viewCommands } from "./commands/view-commands";
import { paneCommands, crossPaneCommands } from "./commands/pane-commands";
import {
  windowCommands,
  tabCommands,
  gitGraphCommands,
  bookmarkCommands,
  recentCommands,
  workspaceCommands,
  terminalCommands,
  generalDialogCommands,
} from "./commands/general-commands";

/** Register all commands */
export function registerAllCommands(): void {
  const allCommands = [
    ...navigationCommands,
    ...fileCommands,
    ...editCommands,
    ...selectionCommands,
    ...viewCommands,
    ...paneCommands,
    ...crossPaneCommands,
    ...bookmarkCommands,
    ...recentCommands,
    ...windowCommands,
    ...tabCommands,
    ...gitGraphCommands,
    ...terminalCommands,
    ...workspaceCommands,
    ...generalDialogCommands,
  ];

  // Register commands with the command registry
  registerCommands(allCommands);

  // Register default shortcuts with the keybindings store
  const defaultShortcuts: Record<string, string> = {};
  for (const cmd of allCommands) {
    if (cmd.shortcut) {
      defaultShortcuts[cmd.id] = cmd.shortcut;
    }
  }
  keybindingsStore.registerDefaults(defaultShortcuts);

  // Warn about shortcut conflicts at startup (dev only)
  if (import.meta.env.DEV) {
    validateShortcutConflicts(allCommands);
  }
}

/** Log warnings for commands sharing the same shortcut without `when` guards */
function validateShortcutConflicts(commands: { id: string; shortcut?: string; when?: () => boolean }[]): void {
  const byShortcut = new Map<string, typeof commands>();
  for (const cmd of commands) {
    if (!cmd.shortcut) continue;
    const key = cmd.shortcut.toLowerCase();
    const group = byShortcut.get(key) ?? [];
    group.push(cmd);
    byShortcut.set(key, group);
  }
  for (const [shortcut, group] of byShortcut) {
    if (group.length <= 1) continue;
    const unguarded = group.filter((c) => !c.when);
    if (unguarded.length > 1) {
      console.warn(
        `[keybindings] Shortcut conflict: "${shortcut}" is bound to multiple commands without 'when' guards:`,
        unguarded.map((c) => c.id),
      );
    }
  }
}
