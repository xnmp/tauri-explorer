/**
 * Command registry system for command palette.
 * Issue: tauri-explorer-abm, tauri-explorer-npjh.4
 *
 * Provides a centralized registry for all app commands that can be
 * executed via command palette, keyboard shortcuts, or menus.
 */

import { keybindingsStore } from "./keybindings.svelte";
import { loadPersisted, savePersisted } from "./persisted";
import { computeFrecencyScore } from "./frecency.svelte";

export interface Command {
  id: string;
  label: string;
  category: CommandCategory;
  /** Default shortcut - actual binding comes from keybindingsStore */
  shortcut?: string;
  handler: () => void | Promise<void>;
  when?: () => boolean;
  /** Hide from command palette (shortcut still works) */
  hidden?: boolean;
  /** Dynamic/ephemeral targets must not evict durable commands from frecency. */
  trackFrecency?: boolean;
  /** For toggle commands: returns the current on/off state so the palette can
   *  show an ON/OFF badge. Omit for non-toggle commands. */
  toggleState?: () => boolean;
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
  | "plugins"
  | "general";

const categoryLabels: Record<CommandCategory, string> = {
  navigation: "Navigation",
  file: "File",
  edit: "Edit",
  view: "View",
  selection: "Selection",
  bookmarks: "Bookmarks",
  plugins: "Plugins",
  general: "General",
};

/** Get human-readable category label */
export function getCategoryLabel(category: CommandCategory): string {
  return categoryLabels[category];
}

/** Internal command registry */
const commands = new Map<string, Command>();

// --- Frecency tracking (persisted) ---

const FRECENCY_KEY = "command-frecency";
const MAX_COMMAND_ENTRIES = 100;
const MAX_ACCESSES = 10;

interface CommandFrecencyEntry {
  id: string;
  accesses: number[];
}

let frecencyData = $state<CommandFrecencyEntry[]>(
  loadPersisted(FRECENCY_KEY, []),
);

function trackCommandUsage(id: string): void {
  const now = Date.now();
  const existing = frecencyData.find((e) => e.id === id);
  if (existing) {
    existing.accesses = [...existing.accesses.slice(-(MAX_ACCESSES - 1)), now];
  } else {
    frecencyData = [...frecencyData, { id, accesses: [now] }];
  }
  if (frecencyData.length > MAX_COMMAND_ENTRIES) {
    const scored = frecencyData.map((e) => ({
      entry: e,
      score: computeFrecencyScore(e.accesses, now),
    }));
    scored.sort((a, b) => b.score - a.score);
    frecencyData = scored.slice(0, MAX_COMMAND_ENTRIES).map((s) => s.entry);
  }
  savePersisted(FRECENCY_KEY, frecencyData);
}

/** Get commands ranked by frecency score (highest first). */
export function getCommandsByFrecency(): Command[] {
  const now = Date.now();
  return frecencyData
    .map((e) => ({ id: e.id, score: computeFrecencyScore(e.accesses, now) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((e) => commands.get(e.id))
    .filter(
      (cmd): cmd is Command =>
        cmd !== undefined && !cmd.hidden && (!cmd.when || cmd.when()),
    );
}

/** Get the frecency score for a single command. */
export function getCommandFrecencyScore(id: string): number {
  const entry = frecencyData.find((e) => e.id === id);
  if (!entry) return 0;
  return computeFrecencyScore(entry.accesses, Date.now());
}

/** @deprecated Use getCommandsByFrecency */
export function getRecentCommands(): Command[] {
  return getCommandsByFrecency();
}

// --- Command registry ---

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

/** Get commands filtered by enabled state (excludes hidden commands) */
export function getAvailableCommands(): Command[] {
  return getAllCommands().filter(
    (cmd) => !cmd.hidden && (!cmd.when || cmd.when()),
  );
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
    if (command.trackFrecency !== false) trackCommandUsage(id);
    return true;
  } catch (err) {
    console.error(`Command failed: ${id}`, err);
    return false;
  }
}

/** Clear frecency history */
export function clearRecentCommands(): void {
  frecencyData = [];
  savePersisted(FRECENCY_KEY, frecencyData);
}
