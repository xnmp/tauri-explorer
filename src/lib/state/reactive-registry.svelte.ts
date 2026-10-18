import { createOwnedRegistry } from "./owned-registry";

/** Owned registry whose reads are reactive: every mutation (register, dispose,
 * delete, clear) invalidates readers of `get`/`values`. Used where a UI such
 * as the command palette stays open while plugins register late (#1270). */
export function createReactiveRegistry<T>() {
  const inner = createOwnedRegistry<T>();
  let revision = $state(0);
  const touch = () => { revision++; };
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
    get(id: string): T | undefined { void revision; return inner.get(id); },
    values(): T[] { void revision; return inner.values(); },
    delete(id: string): void { inner.delete(id); touch(); },
    clear(): void { inner.clear(); touch(); },
  };
}
