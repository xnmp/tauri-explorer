import { loadPersisted } from "./persisted";
import { readSharedHistory, mutateSharedHistory, usesNativeHistory } from "$lib/api/history";
import { sanitizeRecentHistory, sanitizeFrecencyHistory, type HistoryMutation, type HistorySnapshot } from "$lib/domain/history";

/** Per-renderer FIFO; SQLite owns cross-process ordering and canonical data. */
export function createHistoryChannel({ read, mutate, seed, native, reportError }: {
  read: (seed: HistorySnapshot) => Promise<HistorySnapshot>;
  mutate: (operation: HistoryMutation) => Promise<void>;
  seed: () => HistorySnapshot;
  native: () => boolean;
  reportError: (error: unknown) => void;
}) {
  let tail: Promise<void> = Promise.resolve();
  let initialization: Promise<HistorySnapshot> | null = null;
  let epoch = 0;
  const report = (error: unknown) => { try { reportError(error); } catch { /* Optional diagnostics cannot reject selection. */ } };
  function initialize(snapshot: HistorySnapshot): Promise<HistorySnapshot> {
    initialization ??= read(snapshot).catch(error => { initialization = null; throw error; });
    return initialization;
  }
  return {
    enqueue(operation: HistoryMutation): void {
      epoch++;
      if (!native()) return;
      // Capture migration data before the optimistic local mutation is applied.
      const snapshot = seed();
      tail = tail.then(async () => { await initialize(snapshot); await mutate(operation); }).catch(report);
    },
    async refresh(publish?: (snapshot: HistorySnapshot) => void): Promise<HistorySnapshot | null> {
      if (!native()) return null;
      const capturedEpoch = epoch;
      const snapshot = seed();
      let result: HistorySnapshot | null = null;
      tail = tail.then(async () => {
        await initialize(snapshot);
        const fresh = await read(snapshot);
        if (epoch === capturedEpoch) { result = fresh; publish?.(fresh); }
      }).catch(report);
      await tail;
      return epoch === capturedEpoch ? result : null;
    },
    flush(): Promise<void> { return tail; },
  };
}

let recent = { get: () => [] as HistorySnapshot["recent"], set: (_value: HistorySnapshot["recent"]) => {} };
let frecency = { get: () => [] as HistorySnapshot["frecency"], set: (_value: HistorySnapshot["frecency"]) => {} };
const channel = createHistoryChannel({ read: readSharedHistory, mutate: mutateSharedHistory,
  seed: () => ({ recent: sanitizeRecentHistory(loadPersisted("explorer-recent-files", [], 1_000_000)), frecency: sanitizeFrecencyHistory(loadPersisted("explorer-frecency", [], 1_000_000)) }), native: usesNativeHistory,
  reportError: error => console.warn("Optional shared history could not be saved", error),
});
let refreshQueued = false;
function scheduleInitialRefresh(): void {
  if (refreshQueued || !usesNativeHistory()) return;
  refreshQueued = true;
  queueMicrotask(() => { refreshQueued = false; void refreshSharedHistory(); });
}
export function registerRecentHistory(store: typeof recent): void { recent = store; scheduleInitialRefresh(); }
export function registerFrecencyHistory(store: typeof frecency): void { frecency = store; scheduleInitialRefresh(); }
export const enqueueHistory = channel.enqueue;
export const flushSharedHistory = channel.flush;
export async function refreshSharedHistory(): Promise<void> {
  await channel.refresh(snapshot => {
    recent.set(sanitizeRecentHistory(snapshot.recent));
    frecency.set(sanitizeFrecencyHistory(snapshot.frecency));
  });
}
