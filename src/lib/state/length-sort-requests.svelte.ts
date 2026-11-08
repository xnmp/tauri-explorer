/**
 * Sort by Length (#1531), the resolver side — loaded lazily by
 * `length-sort.svelte.ts` the first time any Explorer sorts by Length, so the
 * startup graph does not carry the duration and plugin-column resolvers.
 *
 * Length values are lazy per-row metadata — video durations (#995) and plugin
 * `lengthSeconds` (#1523) — normally loaded only for rendered rows. While a
 * folder is sorted by Length every eligible entry in its listing is requested
 * instead, through each resolver's bounded batching (`requestAll`, capped at
 * the resolver's cache capacity), on behalf of one owner per Explorer.
 * Leaving the Length sort or the folder withdraws that owner, dropping queued
 * work and aborting batches nobody else wants.
 */
import type { FileEntry } from "$lib/domain/file";
import { mediaDurationResolver } from "./media-durations.svelte";
import { detailColumnRegistry } from "$lib/plugins/detail-column-registry.svelte";

/** A resolver that can serve folder-wide, cancellable length requests. */
export interface LengthSource {
  requestAll(entries: Iterable<FileEntry>, owner: object): void;
  cancel(owner: object): void;
}

/** Reactive: the Length cell's seconds — the host's probe, else a plugin's. */
export function entryLengthSeconds(entry: FileEntry): number | null | undefined {
  return mediaDurationResolver.duration(entry) ?? detailColumnRegistry.lengthSeconds(entry);
}

/** Reactive: changes whenever any length value settles (cached projections key on it). */
export function lengthRevision(): number {
  let revision = mediaDurationResolver.revision;
  for (const resolver of detailColumnRegistry.resolvers()) revision += resolver.revision + 1;
  return revision;
}

/** Reactive: the resolvers that can supply a length (plugins come and go). */
export function lengthSources(): readonly LengthSource[] {
  return [mediaDurationResolver, ...detailColumnRegistry.resolvers()];
}

export interface LengthSortRequests {
  /** Request lengths for `entries` of `path` while `active`; otherwise (or on
   *  another folder) withdraw the earlier requests first. Not reactive. */
  sync(active: boolean, path: string, entries: Iterable<FileEntry>, sources: readonly LengthSource[]): void;
  dispose(): void;
}

export function createLengthSortRequests(): LengthSortRequests {
  let owner: object | null = null;
  let folder: string | null = null;
  let requested: readonly LengthSource[] = [];
  const withdraw = () => {
    if (owner) for (const source of requested) source.cancel(owner);
    owner = null;
    folder = null;
    requested = [];
  };
  return {
    sync(active, path, entries, sources) {
      if (!active || folder !== path) withdraw();
      if (!active) return;
      owner ??= {};
      folder = path;
      // A source that left (a disabled plugin) is disposed with its resolver.
      requested = sources;
      for (const source of sources) source.requestAll(entries, owner);
    },
    dispose: withdraw,
  };
}
