import { createOwnedRegistry } from "./owned-registry";

/** Owned registry whose list is reactive: every mutation (register, dispose,
 * delete, clear) invalidates readers of `values()`. Used where a UI such as the
 * command palette stays open while plugins register late (#1270).
 * `get` is a dispatch-time lookup and stays untracked. */
export function createReactiveRegistry<T>() {
  const inner = createOwnedRegistry<T>();
  let revision = $state(0);
  // Write a fresh value without reading `revision`: `revision++` would subscribe
  // any effect that registers (e.g. the Git graph's palette targets) to its own
  // write and loop forever.
  let version = 0;
  const touch = () => { revision = ++version; };
  return {
    register(id: string, value: T, replace = false): () => boolean {
      const dispose = inner.register(id, value, replace);
      touch();
      return () => {
        const removed = dispose();
        if (removed) touch();
        return removed;
      };
    },
    get(id: string): T | undefined { return inner.get(id); },
    values(): T[] { void revision; return inner.values(); },
    delete(id: string): void { inner.delete(id); touch(); },
    clear(): void { inner.clear(); touch(); },
  };
}
