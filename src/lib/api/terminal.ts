/**
 * API bridge for the embedded terminal (issue #139).
 *
 * Output/exit arrive as global Tauri events named per terminal so windows
 * can't cross-subscribe: `terminal-output-{id}` (string chunk) and
 * `terminal-exit-{id}` (exit code or null).
 */

import { invoke } from "./files";
import type { ShellKind } from "$lib/domain/terminal-shell";

/** Reserve a terminal id so listeners can register BEFORE the PTY spawns. */
export async function terminalReserveId(): Promise<number> {
  return invoke<number>("terminal_reserve_id");
}

/** What the backend actually spawned (#409): the frontend must speak this
 *  shell's dialect for cd syncs and path insertions. */
export interface TerminalSpawnInfo {
  id: number;
  shellKind: ShellKind;
  /** Set when the shell is `wsl.exe` into this distro (#378). */
  wslDistro: string | null;
}

/**
 * Spawn the user's shell in a PTY at `cwd` under a RESERVED id.
 * Register the `terminal-output-{id}` listener before calling this — a fast
 * shell emits its prompt immediately, and un-listened events are lost (#201).
 */
export async function terminalSpawn(
  id: number,
  cwd: string | undefined,
  cols: number,
  rows: number
): Promise<TerminalSpawnInfo> {
  return invoke<TerminalSpawnInfo>("terminal_spawn", { id, cwd, cols, rows });
}

/** Write user input (keystrokes) to the terminal. */
export async function terminalWrite(id: number, data: string): Promise<void> {
  return invoke("terminal_write", { id, data });
}

/** Resize the PTY grid to match xterm's cols/rows. */
export async function terminalResize(id: number, cols: number, rows: number): Promise<void> {
  return invoke("terminal_resize", { id, cols, rows });
}

/** Kill the terminal's shell process. */
export async function terminalKill(id: number): Promise<void> {
  return invoke("terminal_kill", { id });
}

/** cwd-sync status for a terminal (issue #149). */
export interface TerminalStatus {
  /** A foreground command is running (injecting `cd` would clobber it). */
  busy: boolean;
  /** The shell's last OSC 7-reported cwd, or null if none seen yet. */
  cwd: string | null;
}

/** Query whether the shell is busy and its last-known cwd. */
export async function terminalStatus(id: number): Promise<TerminalStatus> {
  return invoke<TerminalStatus>("terminal_status", { id });
}
