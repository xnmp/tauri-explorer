/** IPC for slow directory-load diagnostics (#1022). */
import type { FrontendSlowLoadRecord, SlowLoadRecord } from "$lib/domain/load-diagnostics";
import { invoke } from "./common";

/** Persist (or replace) one record; native code adds its own phase breakdown. */
export function recordSlowLoad(record: FrontendSlowLoadRecord): Promise<void> {
  return invoke<void>("record_slow_load", { record });
}

/** Recent persisted records, newest first. Unavailable records read as none. */
export async function recentSlowLoads(limit?: number): Promise<SlowLoadRecord[]> {
  try {
    return await invoke<SlowLoadRecord[]>("recent_slow_loads", { limit: limit ?? null });
  } catch {
    return [];
  }
}
