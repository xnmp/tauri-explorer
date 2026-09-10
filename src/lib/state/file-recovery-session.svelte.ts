import { extractError } from "$lib/api/common";
import type { FileRecoveryState } from "./file-recovery.svelte";

/** Page-owned demand for recovery. The store and IPC code load only after the
 * foreground is usable or the user explicitly opens recovery. Module loading
 * may outlive the page; a retired session cannot start a late subscription. */
export function createFileRecoverySession(load: () => Promise<FileRecoveryState> = async () => {
  const { createFileRecoveryState } = await import("./file-recovery.svelte");
  return createFileRecoveryState();
}) {
  let state = $state.raw<FileRecoveryState | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let pending: Promise<void> | undefined;
  let disposed = false;
  let stopping: Promise<void> | undefined;

  function start(reconnect = false): Promise<void> {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    if (state && !reconnect) return Promise.resolve();
    loading = true;
    loadError = null;
    pending = Promise.resolve().then(async () => {
      if (disposed) return;
      const loaded = state ?? await load();
      if (disposed) return;
      state = loaded;
      await loaded.start();
    }).catch((error) => {
      if (!disposed) loadError = extractError(error);
    }).finally(() => { pending = undefined; loading = false; });
    return pending;
  }

  return {
    get state() { return state; },
    get loading() { return loading || (state?.loading ?? false); },
    get error() { return loadError ?? state?.error ?? null; },
    start: () => start(),
    // Manual refresh also repairs a failed/lost subscription. It does not add
    // a timer or another refresh policy to the live explorer.
    refresh: () => start(true),
    dispose(): Promise<void> {
      if (stopping) return stopping;
      disposed = true;
      const owned = state;
      state = null;
      loading = false;
      loadError = null;
      return stopping = owned?.dispose() ?? Promise.resolve();
    },
  };
}

export type FileRecoverySession = ReturnType<typeof createFileRecoverySession>;
