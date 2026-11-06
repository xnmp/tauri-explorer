/**
 * Lazy per-row metadata for Details-only columns (#995, #1523).
 *
 * Listings never carry these values: rendered rows request their entry, and
 * requests made in the same tick share one bounded `load` call. Results are
 * cached per path and revision (size + mtime), so an unchanged file is never
 * re-read while a rewritten one is. A rejected batch settles every entry with
 * the `failure` value; `dispose` aborts in-flight loads and drops the cache.
 */
import { SvelteMap } from "svelte/reactivity";
import type { FileEntry } from "$lib/domain/file";
import { mediaDurationRevision as entryRevision } from "$lib/domain/media-duration";

export interface BatchedEntryResolverDeps<T> {
  /** One result per entry, in order. Missing or malformed items normalize. */
  load: (entries: FileEntry[], signal: AbortSignal) => Promise<readonly unknown[]>;
  normalize: (value: unknown) => T;
  /** Settled value when a batch rejects. */
  failure: T;
  /** Entries this resolver never requests (cheap, synchronous). */
  eligible?: (entry: FileEntry) => boolean;
  batchSize?: number;
  maxConcurrent?: number;
  maxEntries?: number;
}

interface Work { entry: FileEntry; revision: string }

export class BatchedEntryResolver<T> {
  #cache = new SvelteMap<string, { revision: string; value: T }>();
  #pending = new Map<string, Work>();
  #queue: Work[] = [];
  #active = 0;
  #scheduled = false;
  #abort = new AbortController();
  #deps: BatchedEntryResolverDeps<T>;
  #batchSize: number;
  #maxConcurrent: number;
  #maxEntries: number;

  constructor(deps: BatchedEntryResolverDeps<T>) {
    this.#deps = deps;
    this.#batchSize = Math.max(1, deps.batchSize ?? 16);
    this.#maxConcurrent = Math.max(1, deps.maxConcurrent ?? 2);
    this.#maxEntries = Math.max(1, deps.maxEntries ?? 5000);
  }

  /** Reactive read: `undefined` until resolved for the entry's current revision. */
  value(entry: FileEntry): T | undefined {
    const cached = this.#cache.get(entry.path);
    return cached?.revision === entryRevision(entry) ? cached.value : undefined;
  }

  /** Request resolution for a rendered entry; a no-op for ineligible entries. */
  request(entry: FileEntry): void {
    if (this.#abort.signal.aborted || this.#deps.eligible?.(entry) === false) return;
    const { path } = entry;
    const revision = entryRevision(entry);
    if (this.#cache.get(path)?.revision === revision) return;
    if (this.#pending.get(path)?.revision === revision) return;

    const work = { entry, revision };
    // A newer revision supersedes queued or in-flight work for the same path.
    this.#queue = this.#queue.filter((queued) => queued.entry.path !== path);
    this.#pending.set(path, work);
    this.#queue.push(work);
    // Defer one microtask so rows rendered together share a load call.
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#pump();
    });
  }

  /** Abort in-flight loads and forget every value; later requests are ignored. */
  dispose(): void {
    this.#abort.abort();
    this.#queue = [];
    this.#pending.clear();
    this.#cache.clear();
  }

  #pump(): void {
    const { signal } = this.#abort;
    while (!signal.aborted && this.#active < this.#maxConcurrent && this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#batchSize);
      this.#active += 1;
      const { load, failure } = this.#deps;
      // A synchronous throw from `load` is the same failure as a rejection;
      // a throwing normalization fails only its own item, so every entry settles.
      void Promise.resolve()
        .then(() => load(batch.map((work) => work.entry), signal))
        .then(
          (values) => batch.map((_, index) => this.#normalize(Array.isArray(values) ? values[index] : undefined)),
          () => batch.map(() => failure),
        )
        .then((values) => batch.forEach((work, index) => this.#settle(work, values[index])))
        .finally(() => {
          this.#active -= 1;
          this.#pump();
        });
    }
  }

  #normalize(value: unknown): T {
    try { return this.#deps.normalize(value); } catch { return this.#deps.failure; }
  }

  #settle(work: Work, value: T): void {
    if (this.#abort.signal.aborted || this.#pending.get(work.entry.path) !== work) return;
    this.#pending.delete(work.entry.path);
    this.#cache.delete(work.entry.path);
    this.#cache.set(work.entry.path, { revision: work.revision, value });
    // Map iteration is insertion order: evict the least recently resolved.
    while (this.#cache.size > this.#maxEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
