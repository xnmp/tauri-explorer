/**
 * Lazy empty-folder resolver.
 *
 * Directory listings no longer carry `is_empty` (#129): the backend used to pay
 * one `read_dir` per subdirectory in every listing just to dim empty-folder
 * icons, multiplying listing syscalls 2-3x in folder-heavy directories. Instead,
 * views request emptiness on demand as directory entries render, and this
 * resolver resolves it via the dedicated `is_directory_empty` command with a
 * bounded concurrency pool. The dimmed style may therefore appear a frame late,
 * which is acceptable for a purely cosmetic cue.
 *
 * Results are keyed by the current hidden-file visibility (`showHidden`): a
 * folder that only holds dotfiles is "empty" when hidden files are off but not
 * when they're on, so the cache is dropped whenever that setting flips.
 */
import { SvelteMap } from "svelte/reactivity";
import { isDirectoryEmpty as invokeIsDirectoryEmpty } from "$lib/api/files";
import { settingsStore } from "./settings.svelte";
import type { FileEntry } from "$lib/domain/file";
import { nativeDirectoryKey } from "$lib/domain/path";

const DEFAULT_MAX_CONCURRENT = 8;

export interface EmptyFolderDeps {
  /** Resolves whether `path` is empty under the given hidden-file rule. */
  resolveEmpty: (path: string, includeHidden: boolean) => Promise<boolean>;
  /** Current hidden-file visibility; results are cached per its value. */
  includeHidden: () => boolean;
  /** Max in-flight `resolveEmpty` calls. */
  maxConcurrent?: number;
}

/**
 * Resolves directory emptiness lazily with per-path reactive results and a
 * bounded concurrency pool. Not a singleton by construction so it can be unit
 * tested with injected dependencies; the shared instance is exported below.
 */
export class EmptyFolderResolver {
  #cache = new SvelteMap<string, { path: string; empty: boolean }>();
  #inFlight = new Map<string, { path: string; key: string }>();
  #queue: Array<{ path: string; key: string }> = [];
  #active = 0;
  #key = "";
  #resolveEmpty: EmptyFolderDeps["resolveEmpty"];
  #includeHidden: EmptyFolderDeps["includeHidden"];
  #maxConcurrent: number;

  constructor(deps: EmptyFolderDeps) {
    this.#resolveEmpty = deps.resolveEmpty;
    this.#includeHidden = deps.includeHidden;
    this.#maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /**
   * Reactive read of a directory's emptiness. `undefined` until resolved,
   * then `true`/`false`. Reading tracks only this path, so a resolution
   * elsewhere doesn't invalidate unrelated entries.
   */
  isEmpty(path: string): boolean | undefined {
    return this.#cache.get(nativeDirectoryKey(path))?.empty;
  }

  /**
   * Request resolution for a directory entry. No-op for files or for paths
   * already known or in flight, so it is safe to call on every render. If the
   * entry carries `is_empty`, it still needs a probe: physical metadata has no
   * hidden-visibility or observation revision and may belong to an old listing.
   */
  request(entry: FileEntry): void {
    if (entry.kind !== "directory") return;
    this.#syncKey();

    const { path } = entry;
    const key = nativeDirectoryKey(path);
    if (this.#cache.has(key) || this.#inFlight.has(key)) return;

    this.#enqueue(path);
  }

  /** Drop all resolved state (setting flips, forced refresh, tests). */
  reset(): void {
    this.#cache.clear();
    this.#inFlight.clear();
    this.#queue = [];
  }

  /**
   * Recheck folders changed by a successful file operation. A probe that began
   * before the mutation loses its identity so it cannot restore an old result.
   */
  invalidate(paths: readonly string[]): void {
    for (const key of new Set(paths.map(nativeDirectoryKey))) {
      const path = this.#inFlight.get(key)?.path ?? this.#cache.get(key)?.path;
      this.#cache.delete(key);
      this.#queue = this.#queue.filter((work) => work.key !== key);
      this.#inFlight.delete(key);
      if (path !== undefined) this.#enqueue(path);
    }
  }

  #syncKey(): void {
    const key = this.#includeHidden() ? "1" : "0";
    if (key !== this.#key) {
      this.#key = key;
      this.reset();
    }
  }

  #enqueue(path: string): void {
    const key = nativeDirectoryKey(path);
    // Identity belongs only to live work. Dropping/replacing it invalidates old
    // results without retaining a revision for every directory ever mutated.
    const work = { path, key };
    this.#inFlight.set(key, work);
    this.#queue.push(work);
    this.#pump();
  }

  #pump(): void {
    while (this.#active < this.#maxConcurrent && this.#queue.length > 0) {
      const work = this.#queue.shift()!;
      const { path, key } = work;
      const includeHidden = this.#includeHidden();
      this.#active += 1;
      void this.#resolveEmpty(path, includeHidden)
        .then((empty) => {
          if (this.#inFlight.get(key) === work && this.#includeHidden() === includeHidden) {
            this.#cache.set(key, { path, empty });
          }
        })
        .catch(() => {
          // resolveEmpty is expected to swallow errors (unreadable dirs resolve
          // to "not empty"); guard anyway so one rejection can't stall the pool.
        })
        .finally(() => {
          if (this.#inFlight.get(key) === work) this.#inFlight.delete(key);
          this.#active -= 1;
          this.#pump();
        });
    }
  }
}

/** Shared resolver wired to the real IPC command and settings store. */
export const emptyFolderResolver = new EmptyFolderResolver({
  resolveEmpty: invokeIsDirectoryEmpty,
  includeHidden: () => settingsStore.showHidden,
});
