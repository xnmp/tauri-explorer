/**
 * Live count of unresolved AI operations. Reads the native snapshot and refreshes on change
 * events while at least one consumer holds a subscription (ref-counted). Failures leave the
 * count at 0, so indicators stay hidden rather than surfacing an error.
 */
import { readAiOperations, watchAiOperations } from "$lib/api/ai-operations";

export interface AiOperationsCountDeps {
  read: () => Promise<{ operations: readonly unknown[] }>;
  watch: (receive: () => void) => Promise<() => void>;
}

export function createUnresolvedAiCount(deps: AiOperationsCountDeps) {
  let count = $state(0);
  let consumers = 0;
  let generation = 0;
  let stop: (() => void) | null = null;

  async function refresh(gen: number): Promise<void> {
    try {
      const snapshot = await deps.read();
      if (gen === generation) count = snapshot.operations.length;
    } catch {
      if (gen === generation) count = 0;
    }
  }

  async function start(gen: number): Promise<void> {
    try {
      const unwatch = await deps.watch(() => { void refresh(gen); });
      if (gen === generation) stop = unwatch; else unwatch();
    } catch { /* no notifications: the initial read still stands */ }
  }

  return {
    get count(): number { return count; },
    /** Returns a release function; the watch ends when the last consumer releases. */
    subscribe(): () => void {
      if (consumers++ === 0) {
        const gen = ++generation;
        void refresh(gen);
        void start(gen);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--consumers === 0) {
          generation++;
          stop?.();
          stop = null;
          count = 0;
        }
      };
    },
  };
}

export const unresolvedAiCount = createUnresolvedAiCount({ read: readAiOperations, watch: watchAiOperations });
