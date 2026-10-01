/** Shared, bounded repository detection for labels and speculative warming.
 * Failed probes are retryable; invalidation also revokes pending publication. */
import { gitRepoRoot } from "$lib/api/git";
import type { ApiResult } from "$lib/api/common";
import { directoryKey } from "$lib/domain/path";

function overlaps(a: string, b: string): boolean {
  const contains = (parent: string, child: string) =>
    child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
  return contains(a, b) || contains(b, a);
}

export function createRepoRootCache(
  lookup: (path: string) => Promise<ApiResult<string | null>> = gitRepoRoot,
  capacity = 256,
  now: () => number = Date.now,
) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Cache capacity must be positive");
  const values = new Map<string, { root: string | null; expires: number }>();
  const pending = new Map<string, Promise<void>>();
  let valuesVersion = $state(0);
  let invalidationVersion = $state(0);

  function get(path: string): string | null | undefined {
    void valuesVersion;
    const key = directoryKey(path);
    const value = values.get(key);
    if (!value) return undefined;
    // Expiry controls probe reuse, not the displayed decoration. Keep the
    // last resolved value visible while ensure() refreshes it in the
    // background; explicit invalidation still removes it immediately.
    values.delete(key);
    values.set(key, value);
    return value.root;
  }

  function ensure(path: string): Promise<void> {
    // Reactive callers rerun on invalidation, not on every cache eviction;
    // more visible tabs than capacity must not create a request feedback loop.
    void invalidationVersion;
    if (!path) return Promise.resolve();
    const key = directoryKey(path);
    const cached = values.get(key);
    if (cached && cached.expires > now()) return Promise.resolve();
    const existing = pending.get(key);
    if (existing) return existing;
    const task = Promise.resolve().then(() => lookup(path)).then((result) => {
      if (pending.get(key) !== task || !result.ok) return;
      values.delete(key);
      values.set(key, { root: result.data, expires: now() + (result.data ? 60_000 : 2_000) });
      if (values.size > capacity) values.delete(values.keys().next().value!);
      valuesVersion++;
    }).catch(() => { /* Decoration is optional; a later caller may retry. */ })
      .finally(() => { if (pending.get(key) === task) pending.delete(key); });
    pending.set(key, task);
    return task;
  }

  function invalidate(path?: string): void {
    const key = path ? directoryKey(path) : null;
    for (const cached of values.keys()) if (!key || overlaps(key, cached)) values.delete(cached);
    for (const active of pending.keys()) if (!key || overlaps(key, active)) pending.delete(active);
    valuesVersion++;
    invalidationVersion++;
  }

  return { get, ensure, invalidate };
}

export const repoRootCache = createRepoRootCache();
