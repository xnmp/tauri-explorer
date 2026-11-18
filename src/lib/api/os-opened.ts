/**
 * IPC for OS "last opened" records (#1526): epoch ms per requested path, for
 * the paths the OS knows. Read-only and best-effort — any failure is "none".
 */
import { invoke } from "./common";

export async function osOpenedTimes(paths: readonly string[]): Promise<Record<string, number>> {
  try { return (await invoke<Record<string, number>>("os_opened_times", { paths })) ?? {}; }
  catch { return {}; }
}
