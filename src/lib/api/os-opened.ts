/**
 * IPC for OS "last opened" records (#1526): epoch ms per requested path, for
 * the paths the OS knows. Read-only; a failure rejects so the resolver can
 * keep what it knows and retry.
 */
import { invoke } from "./common";

export async function osOpenedTimes(paths: readonly string[]): Promise<Record<string, number>> {
  return (await invoke<Record<string, number>>("os_opened_times", { paths })) ?? {};
}
