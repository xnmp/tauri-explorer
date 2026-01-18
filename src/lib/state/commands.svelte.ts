/**
 * Command registry system for command palette.
 * Issue: tauri-explorer-abm, tauri-explorer-npjh.4
 *
 * Provides a centralized registry for all app commands that can be
 * executed via command palette, keyboard shortcuts, or menus.
 */

import { keybindingsStore } from "./keybindings.svelte";

export interface Command {
  id: string;
  label: string;
  category: CommandCategory;
  /** Default shortcut - actual binding comes from keybindingsStore */
  shortcut?: string;
  handler: () => void | Promise<void>;
  when?: () => boolean;
}

/** Get the effective display shortcut for a command */
export function getCommandShortcut(commandId: string): string | undefined {
  return keybindingsStore.getDisplayShortcut(commandId);
}

export type CommandCategory =
  | "navigation"
  | "file"
  | "edit"
  | "view"
  | "selection"
  | "bookmarks"
  | "general";

const categoryLabels: Record<CommandCategory, string> = {
  navigation: "Navigation",
  file: "File",
  edit: "Edit",
  view: "View",
  selection: "Selection",
  bookmarks: "Bookmarks",
  general: "General",
};

/** Get human-readable category label */
export function getCategoryLabel(category: CommandCategory): string {
  return categoryLabels[category];
}

/** Internal command registry */
const commands = new Map<string, Command>();

/** Recently used command IDs (most recent first) */
let recentCommands = $state<string[]>([]);
const MAX_RECENT = 10;

/** Register a command */
export function registerCommand(command: Command): void {
  commands.set(command.id, command);
}

/** Register multiple commands */
export function registerCommands(cmds: Command[]): void {
  for (const cmd of cmds) {
    commands.set(cmd.id, cmd);
  }
}

/** Unregister a command */
export function unregisterCommand(id: string): void {
  commands.delete(id);
}

/** Get a command by ID */
export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

/** Get all registered commands */
export function getAllCommands(): Command[] {
  return Array.from(commands.values());
}

/** Get commands filtered by enabled state */
export function getAvailableCommands(): Command[] {
  return getAllCommands().filter((cmd) => !cmd.when || cmd.when());
}

/** Get recently used commands */
export function getRecentCommands(): Command[] {
  return recentCommands
    .map((id) => commands.get(id))
    .filter((cmd): cmd is Command => cmd !== undefined && (!cmd.when || cmd.when()));
}

/** Execute a command by ID */
export async function executeCommand(id: string): Promise<boolean> {
  const command = commands.get(id);
  if (!command) {
    console.warn(`Command not found: ${id}`);
    return false;
  }

  if (command.when && !command.when()) {
    console.warn(`Command not available: ${id}`);
    return false;
  }

  try {
    await command.handler();
    trackRecentCommand(id);
    return true;
  } catch (err) {
    console.error(`Command failed: ${id}`, err);
    return false;
  }
}

/** Track a command as recently used */
function trackRecentCommand(id: string): void {
  recentCommands = [id, ...recentCommands.filter((rid) => rid !== id)].slice(0, MAX_RECENT);
}

/** Clear recent commands */
export function clearRecentCommands(): void {
  recentCommands = [];
}
