/** Owns pane resources and their asynchronous lifetime, independently of layout
 * and Svelte. Detachment is synchronous; disposal drains pending work (ADR 0002). */

interface PaneResource {
  destroy(): Promise<void>;
}

type CleanupReason = "removed" | "replaced" | "disposed";
type TaskKind = "load" | "cleanup";

// Invoke immediately so resources detach before a replacement can register.
// A synchronous failure must not prevent sibling cleanup from starting.
function invokeTask(task: () => void | Promise<void>): Promise<void> {
  try { return Promise.resolve(task()); }
  catch (error) { return Promise.reject(error); }
}

async function settleCleanup(tasks: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export function createPaneSessions<T extends PaneResource>(dependencies: {
  releasePane(paneId: string): void | Promise<void>;
  reportCleanupError(reason: CleanupReason, error: unknown): void;
  onChange?(paneId: string, ready: boolean | undefined): void;
}) {
  const resources = new Map<string, T>();
  const deferred = new Map<string, { factory(): T; start(resource: T): Promise<void> }>();
  const pending = new Map<Promise<void>, TaskKind>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  function track(task: Promise<void>, kind: TaskKind, reason?: CleanupReason): void {
    pending.set(task, kind);
    void task.then(
      () => { pending.delete(task); },
      (error) => {
        pending.delete(task);
        if (reason && reason !== "disposed") dependencies.reportCleanupError(reason, error);
      },
    );
  }

  function remove(paneId: string, reason: CleanupReason = "removed"): void {
    const resource = resources.get(paneId);
    const reserved = deferred.delete(paneId);
    if (!resource && !reserved) return;
    resources.delete(paneId);
    dependencies.onChange?.(paneId, undefined);
    track(settleCleanup([
      invokeTask(() => dependencies.releasePane(paneId)),
      ...(resource ? [invokeTask(() => resource.destroy())] : []),
    ]), "cleanup", reason);
  }

  function clear(reason: CleanupReason = "replaced"): void {
    for (const paneId of [...resources.keys(), ...deferred.keys()]) remove(paneId, reason);
  }

  /** Reserve an identity without opening a directory or subscribing to events. */
  function reserve(paneId: string, factory: () => T, start: (resource: T) => Promise<void>): void {
    if (disposed) throw new Error("Cannot create a pane after disposal");
    if (resources.has(paneId) || deferred.has(paneId)) throw new Error(`Pane already exists: ${paneId}`);
    deferred.set(paneId, { factory, start });
    dependencies.onChange?.(paneId, false);
  }

  function activate(paneId: string): T | undefined {
    if (disposed) return undefined;
    const reservation = deferred.get(paneId);
    if (!reservation) return resources.get(paneId);
    const resource = reservation.factory();
    deferred.delete(paneId);
    resources.set(paneId, resource);
    dependencies.onChange?.(paneId, true);
    track(invokeTask(() => reservation.start(resource)), "load");
    return resource;
  }

  return {
    reserve,
    activate,
    isPending: (paneId: string): boolean => deferred.has(paneId),
    // A failed load leaves the pane available for navigation/retry. Its
    // normal error UI owns that failure; teardown only propagates cleanup.
    create(paneId: string, factory: () => T, start: (resource: T) => Promise<void>): T {
      reserve(paneId, factory, start);
      return activate(paneId)!;
    },
    get: (paneId: string): T | undefined => resources.get(paneId),
    values: (): T[] => [...resources.values()],
    remove,
    clear,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      clear("disposed");
      const tasks = [...pending];
      disposal = Promise.allSettled(tasks.map(([task]) => task)).then((results) => {
        const failure = results.find((result, i) =>
          result.status === "rejected" && tasks[i][1] === "cleanup");
        if (failure?.status === "rejected") throw failure.reason;
      });
      return disposal;
    },
  };
}
