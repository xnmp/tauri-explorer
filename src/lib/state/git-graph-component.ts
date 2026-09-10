import type { Component } from "svelte";

/**
 * Retain a resolved lazy component so later mounts can render synchronously.
 * The caller supplies the import: state never depends on a component module.
 * Pending imports are shared; failures never become a cached constructor.
 * Every caller of a cache instance must supply the same component importer.
 */
export function createLazyComponentCache<T>() {
  let current: T | undefined;
  let pending: Promise<T> | undefined;
  return {
    get current() { return current; },
    load(loader: () => Promise<T>): Promise<T> {
      if (current !== undefined) return Promise.resolve(current);
      return pending ??= Promise.resolve().then(loader).then((component) => {
        current = component;
        return component;
      }).finally(() => { pending = undefined; });
    },
  };
}

export const gitGraphComponent = createLazyComponentCache<Component<{ repoPath: string }>>();
