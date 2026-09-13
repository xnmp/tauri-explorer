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
  #cache = new SvelteMap<string, boolean>();
  #inFlight = new Map<string, number>();
  #queue: Array<{ path: string; version: number }> = [];
  #versions = new Map<string, number>();
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
    return this.#cache.get(path);
  }

  /**
   * Request resolution for a directory entry. No-op for files or for paths
   * already known or in flight, so it is safe to call on every render. If the
   * entry already carries a backend-resolved `is_empty` (create/rename/copy
   * results), that value is trusted instead of a redundant round-trip.
   */
  request(entry: FileEntry): void {
    if (entry.kind !== "directory") return;
    this.#syncKey();

    const { path } = entry;
    if (this.#cache.has(path) || this.#inFlight.has(path)) return;

    if (entry.is_empty !== undefined) {
      this.#cache.set(path, entry.is_empty);
      return;
    }

    this.#enqueue(path, this.#version(path));
  }

  /** Drop all resolved state (setting flips, forced refresh, tests). */
  reset(): void {
    for (const path of new Set([
      ...this.#cache.keys(),
      ...this.#inFlight.keys(),
      ...this.#queue.map(({ path }) => path),
    ])) {
      this.#advanceVersion(path);
    }
    this.#cache.clear();
    this.#inFlight.clear();
    this.#queue = [];
  }

  /**
   * Recheck folders changed by a successful file operation. A probe that began
   * before the mutation is versioned out so it cannot restore an old result.
   */
  invalidate(paths: readonly string[]): void {
    for (const path of paths) {
      const wasTracked = this.#cache.has(path)
        || this.#inFlight.has(path)
        || this.#queue.some((work) => work.path === path);
      this.#cache.delete(path);
      const version = this.#advanceVersion(path);
      this.#queue = this.#queue.filter((work) => work.path !== path);
      this.#inFlight.delete(path);
      if (wasTracked) this.#enqueue(path, version);
    }
  }

  #syncKey(): void {
    const key = this.#includeHidden() ? "1" : "0";
    if (key !== this.#key) {
      this.#key = key;
      this.reset();
    }
  }

  #version(path: string): number {
    return this.#versions.get(path) ?? 0;
  }

  #advanceVersion(path: string): number {
    const version = this.#version(path) + 1;
    this.#versions.set(path, version);
    return version;
  }

  #enqueue(path: string, version: number): void {
    this.#inFlight.set(path, version);
    this.#queue.push({ path, version });
    this.#pump();
  }

  #pump(): void {
    while (this.#active < this.#maxConcurrent && this.#queue.length > 0) {
      const { path, version } = this.#queue.shift()!;
      this.#active += 1;
      void this.#resolveEmpty(path, this.#includeHidden())
        .then((empty) => {
          if (this.#version(path) === version && this.#inFlight.get(path) === version) {
            this.#cache.set(path, empty);
          }
        })
        .catch(() => {
          // resolveEmpty is expected to swallow errors (unreadable dirs resolve
          // to "not empty"); guard anyway so one rejection can't stall the pool.
        })
        .finally(() => {
          if (this.#inFlight.get(path) === version) this.#inFlight.delete(path);
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
