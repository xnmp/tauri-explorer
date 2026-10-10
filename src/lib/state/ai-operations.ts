import { aiOperationKey, resolutionAvailable, validAiOperations, type AiOperationsSnapshot, type AiResolution, type UnresolvedAiOperation } from "$lib/domain/ai-operations";
export interface AiOperationsView { snapshot: AiOperationsSnapshot | null; loading: boolean; busyKey: string | null; error: string | null }
export interface AiOperationsDependencies {
  read(): Promise<AiOperationsSnapshot>;
  resolve(operation: UnresolvedAiOperation, action: AiResolution): Promise<AiOperationsSnapshot>;
  watch(receive: () => void): Promise<() => void>;
}
export function createAiOperationsController(deps: AiOperationsDependencies, changed: (view: AiOperationsView) => void) {
  let view: AiOperationsView = { snapshot: null, loading: false, busyKey: null, error: null };
  let alive = true, reads = 0, unlisten: (() => void) | null = null, refreshPending = false;
  let readTask: Promise<void> | null = null;
  let watchTask: Promise<void> | null = null, watchError: string | null = null;
  let actionError: string | null = null;
  const publish = (patch: Partial<AiOperationsView>) => { if (alive) { view = { ...view, ...patch }; changed(view); } };
  function ensureWatch(): Promise<void> {
    if (unlisten) return Promise.resolve();
    if (watchTask) return watchTask;
    watchTask = (async () => {
      try {
        const stop = await deps.watch(() => { if (alive) void refresh(false); });
        if (!alive) { stop(); return; }
        unlisten = stop; watchError = null;
      } catch (failure) {
        if (alive) watchError = failure instanceof Error ? failure.message : "Operation notifications are unavailable; reload to retry";
      } finally { watchTask = null; }
    })();
    return watchTask;
  }
  function refresh(explicit = true): Promise<void> {
    if (!alive) return Promise.resolve();
    if (explicit) actionError = null;
    if (view.busyKey) { refreshPending = true; return Promise.resolve(); }
    if (readTask) { refreshPending = true; return readTask; }
    const own = ++reads; publish({ loading: true });
    readTask = (async () => {
      try {
        await ensureWatch();
        if (!alive || own !== reads) return;
        const snapshot = await deps.read();
        if (!alive || own !== reads) return;
        if (!validAiOperations(snapshot)) throw new Error("Unresolved operation metadata is malformed");
        publish({ snapshot, error: actionError ?? watchError });
      } catch (failure) { if (own === reads) publish({ error: actionError ?? (failure instanceof Error ? failure.message : "Operations could not be loaded") }); }
      finally {
        readTask = null;
        if (own === reads) publish({ loading: false });
        if (alive && refreshPending && !view.busyKey) { refreshPending = false; void refresh(false); }
      }
    })();
    return readTask;
  }
  return {
    get view() { return view; }, refresh,
    init: refresh,
    async resolve(operation: UnresolvedAiOperation, action: AiResolution): Promise<boolean> {
      const key = aiOperationKey(operation), current = view.snapshot?.operations.find((r) => aiOperationKey(r) === key);
      if (!alive || view.busyKey || !current || !resolutionAvailable(current, action)) return false;
      actionError = null;
      ++reads; publish({ busyKey: key, loading: false, error: null });
      let success = false;
      try {
        const snapshot = await deps.resolve(current, action);
        if (!alive) return false;
        if (!validAiOperations(snapshot)) throw new Error("Operation resolution returned malformed metadata; reload its original identity");
        publish({ snapshot }); success = true;
      } catch (failure) { actionError = failure instanceof Error ? failure.message : "Operation resolution failed; its evidence remains retained"; publish({ error: actionError }); }
      finally {
        publish({ busyKey: null });
        if (alive && (success || refreshPending)) { refreshPending = false; await refresh(false); }
      }
      return success;
    },
    dispose(): void { alive = false; ++reads; unlisten?.(); unlisten = null; },
  };
}
