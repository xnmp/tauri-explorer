/**
 * Lazy per-row metadata for Details-only columns (#995, #1523).
 *
 * Listings never carry these values: rendered rows request their entry, and
 * requests made in the same tick share one bounded `load` call. Results are
 * cached per path and revision (size + mtime), so an unchanged file is never
 * re-read while a rewritten one is. A rejected batch settles every entry with
 * the `failure` value; `dispose` aborts in-flight loads and drops the cache.
 *
 * Folder-wide requests (the Length sort, #1531) name an owner: `cancel(owner)`
 * withdraws that owner's interest, dropping queued work nobody else wants and
 * aborting an in-flight batch once none of its entries is wanted. Rendered-row
 * requests have no owner and are never withdrawn.
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

/** Who wants a value: a rendered row, or a cancellable folder-wide owner. */
const ROW: unique symbol = Symbol("row");
type Owner = object | typeof ROW;

interface Batch { works: Work[]; abort: AbortController }
interface Work { entry: FileEntry; revision: string; owners: Set<Owner>; batch?: Batch }

export class BatchedEntryResolver<T> {
  #cache = new SvelteMap<string, { revision: string; value: T }>();
  #pending = new Map<string, Work>();
  #queue: Work[] = [];
  #batches = new Set<Batch>();
  #active = 0;
  #scheduled = false;
  #abort = new AbortController();
  #deps: BatchedEntryResolverDeps<T>;
  #batchSize: number;
  #maxConcurrent: number;
  #maxEntries: number;
  /** Bumped whenever a value settles: a cheap dependency for cached projections. */
  #revision = $state(0);

  constructor(deps: BatchedEntryResolverDeps<T>) {
    this.#deps = deps;
    this.#batchSize = Math.max(1, deps.batchSize ?? 16);
    this.#maxConcurrent = Math.max(1, deps.maxConcurrent ?? 2);
    this.#maxEntries = Math.max(1, deps.maxEntries ?? 5000);
  }

  /** Reactive count of settled values. */
  get revision(): number {
    return this.#revision;
  }

  /** Reactive read: `undefined` until resolved for the entry's current revision. */
  value(entry: FileEntry): T | undefined {
    const cached = this.#cache.get(entry.path);
    return cached?.revision === entryRevision(entry) ? cached.value : undefined;
  }

  /** Request resolution for a rendered entry (or, with `owner`, on its behalf);
   *  a no-op for ineligible entries. */
  request(entry: FileEntry, owner: Owner = ROW): void {
    if (this.#abort.signal.aborted || this.#deps.eligible?.(entry) === false) return;
    const { path } = entry;
    const revision = entryRevision(entry);
    if (this.#cache.get(path)?.revision === revision) return;
    const pending = this.#pending.get(path);
    if (pending?.revision === revision) {
      pending.owners.add(owner);
      return;
    }

    const work: Work = { entry, revision, owners: new Set([owner]) };
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

  /** Request every eligible entry for `owner`, up to the cache's capacity:
   *  beyond it, values would evict one another, so the rest stay unknown. */
  requestAll(entries: Iterable<FileEntry>, owner: object): void {
    let admitted = 0;
    for (const entry of entries) {
      if (this.#deps.eligible?.(entry) === false) continue;
      if (++admitted > this.#maxEntries) return;
      this.request(entry, owner);
    }
  }

  /** Withdraw `owner`'s requests: unwanted queued work is dropped, and an
   *  in-flight batch nobody wants any more is aborted and left unsettled. */
  cancel(owner: object): void {
    for (const work of [...this.#pending.values()]) {
      if (!work.owners.delete(owner) || work.owners.size) continue;
      if (!work.batch) {
        this.#pending.delete(work.entry.path);
        this.#queue = this.#queue.filter((queued) => queued !== work);
      } else if (work.batch.works.every((other) => other.owners.size === 0)) {
        this.#abortBatch(work.batch);
      }
    }
  }

  /** Abort in-flight loads and forget every value; later requests are ignored. */
  dispose(): void {
    this.#abort.abort();
    for (const batch of this.#batches) batch.abort.abort();
    this.#queue = [];
    this.#pending.clear();
    this.#cache.clear();
  }

  #abortBatch(batch: Batch): void {
    batch.abort.abort();
    for (const work of batch.works) if (this.#pending.get(work.entry.path) === work) this.#pending.delete(work.entry.path);
  }

  #pump(): void {
    while (!this.#abort.signal.aborted && this.#active < this.#maxConcurrent && this.#queue.length > 0) {
      const batch: Batch = { works: this.#queue.splice(0, this.#batchSize), abort: new AbortController() };
      for (const work of batch.works) work.batch = batch;
      const { signal } = batch.abort;
      this.#batches.add(batch);
      this.#active += 1;
      const { load, failure } = this.#deps;
      // A synchronous throw from `load` is the same failure as a rejection;
      // a throwing normalization fails only its own item, so every entry settles.
      void Promise.resolve()
        .then(() => load(batch.works.map((work) => work.entry), signal))
        .then(
          (values) => batch.works.map((_, index) => this.#normalize(Array.isArray(values) ? values[index] : undefined)),
          () => batch.works.map(() => failure),
        )
        .then((values) => {
          // An aborted batch's results (or abort failure) are not values.
          if (signal.aborted) return;
          batch.works.forEach((work, index) => this.#settle(work, values[index]));
          this.#revision += 1;
        })
        .finally(() => {
          this.#batches.delete(batch);
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
