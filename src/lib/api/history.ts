import { invoke, isTauri } from "./common";
import { directoryKey } from "$lib/domain/path";
import type { HistoryMutation, HistorySnapshot } from "$lib/domain/history";
export const usesNativeHistory = isTauri;
export function readSharedHistory(seed: HistorySnapshot): Promise<HistorySnapshot> {
  return invoke("shared_history_read", { seed: {
    recent: seed.recent.map(entry => ({ key: directoryKey(entry.path), entry })),
    frecency: seed.frecency.map(entry => ({ key: directoryKey(entry.path), entry })),
  } });
}
export async function mutateSharedHistory(operation: HistoryMutation): Promise<void> {
  await invoke("shared_history_mutate", { operation });
}
