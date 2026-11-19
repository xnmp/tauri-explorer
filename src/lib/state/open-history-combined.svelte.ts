/**
 * "Date opened" source (#1525 + #1526): the app-owned history merged with the
 * OS's own recent-files record, newest wins. Loaded lazily with the open
 * history, so neither costs startup bundle.
 *
 * OS times are a cached resolver: a row (or the sort) that reads a path asks
 * for it once, requests coalesce into one batched IPC call, and results expire
 * after OS_TTL_MS so an open made elsewhere shows up on a later read. With the
 * setting off nothing is requested and OS data is ignored.
 */
import { osOpenedTimes } from "$lib/api/os-opened";
import { directoryKey } from "$lib/domain/path";
import { newestOpened } from "$lib/domain/open-history";
import { settingsStore } from "./settings.svelte";
import { openHistoryStore } from "./open-history.svelte";

const BATCH_DELAY_MS = 20;
const BATCH_SIZE = 5_000;
const OS_TTL_MS = 60_000;

export interface OsOpenedResolverDeps {
  fetch: (paths: readonly string[]) => Promise<Record<string, number>>;
  enabled: () => boolean;
  now?: () => number;
  ttlMs?: number;
  delayMs?: number;
}

export function createOsOpenedResolver({ fetch, enabled, now = () => Date.now(), ttlMs = OS_TTL_MS, delayMs = BATCH_DELAY_MS }: OsOpenedResolverDeps) {
  let times = $state.raw<ReadonlyMap<string, number>>(new Map());
  const requestedAt = new Map<string, number>();
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Fetch one batch. Each chunk publishes into the *current* map when it
   * settles, so overlapping flushes cannot overwrite one another. A failed
   * chunk keeps what is known and is retried on a later read. */
  async function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    const batch = [...pending.values()];
    pending.clear();
    for (let start = 0; start < batch.length; start += BATCH_SIZE) {
      const chunk = batch.slice(start, start + BATCH_SIZE);
      let result: Record<string, number>;
      try { result = await fetch(chunk); } catch {
        for (const path of chunk) requestedAt.delete(directoryKey(path));
        continue;
      }
      const next = new Map(times);
      for (const path of chunk) {
        const at = result[path];
        if (typeof at === "number") next.set(directoryKey(path), at);
        else next.delete(directoryKey(path));
      }
      times = next;
    }
  }

  return {
    /** OS time for `path` (epoch ms), requesting it if unknown or stale. */
    get(path: string): number | undefined {
      if (!enabled()) return undefined;
      const key = directoryKey(path);
      const asked = requestedAt.get(key);
      if (asked === undefined || now() - asked > ttlMs) {
        requestedAt.set(key, now());
        pending.set(key, path);
        timer ??= setTimeout(() => void flush(), delayMs);
      }
      return times.get(key);
    },
    flush,
  };
}

const os = createOsOpenedResolver({ fetch: osOpenedTimes, enabled: () => settingsStore.osRecentSources });

/** The open history as the Details column and sort see it. */
export const combinedHistory = {
  lastOpened: (path: string): number | undefined => newestOpened(openHistoryStore.lastOpened(path), os.get(path)),
  record: openHistoryStore.record,
  move: openHistoryStore.move,
  forget: openHistoryStore.forget,
};
