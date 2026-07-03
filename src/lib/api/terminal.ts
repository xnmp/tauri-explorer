/**
 * API bridge for the embedded terminal (issue #139).
 *
 * Output/exit arrive as global Tauri events named per terminal so windows
 * can't cross-subscribe: `terminal-output-{id}` (string chunk) and
 * `terminal-exit-{id}` (exit code or null).
 */

import { invoke } from "./files";

/** Spawn the user's shell in a PTY at `cwd`; resolves to the terminal id. */
export async function terminalSpawn(
  cwd: string | undefined,
  cols: number,
  rows: number
): Promise<number> {
  return invoke<number>("terminal_spawn", { cwd, cols, rows });
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
