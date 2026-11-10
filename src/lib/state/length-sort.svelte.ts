/**
 * Sort by Length (#1531), the startup-resident side. Explorer state reads
 * lengths and keeps its folder-wide requests in step through this module; the
 * resolvers live in `length-sort-requests.svelte.ts`, imported the first time
 * any Explorer sorts by Length. Until it loads, every length is unknown, and
 * its arrival re-runs every reader (it is reactive state).
 */
import { untrack } from "svelte";
import type { FileEntry } from "$lib/domain/file";
import type { LengthSortRequests } from "./length-sort-requests.svelte";

type Requests = typeof import("./length-sort-requests.svelte");

let loaded = $state.raw<Requests | null>(null);
let loading: Promise<void> | null = null;

/** Load the resolver side once; a failed import may be retried later. */
function loadLengthSort(): Promise<void> {
  loading ??= import("./length-sort-requests.svelte").then(
    (module) => { loaded = module; },
    () => { loading = null; },
  );
  return loading;
}

/** Reactive: playback seconds for the Length sort and cell, `undefined` while unknown. */
export function entryLengthSeconds(entry: FileEntry): number | null | undefined {
  return loaded?.entryLengthSeconds(entry);
}

/** Reactive: changes whenever any length value settles. */
export function lengthRevision(): number {
  return loaded ? loaded.lengthRevision() + 1 : 0;
}

export interface LengthSortInputs {
  active: () => boolean;
  path: () => string;
  entries: () => readonly FileEntry[];
}

/** Keeps an Explorer's folder-wide length requests in step with its sort,
 *  folder and listing. Returns the disposer, which withdraws them. */
export function trackLengthSort(inputs: LengthSortInputs): () => void {
  let requests: LengthSortRequests | null = null;
  const stop = $effect.root(() => {
    $effect(() => {
      const active = inputs.active();
      const path = inputs.path();
      const module = loaded;
      if (!module) {
        if (active) void loadLengthSort();
        return;
      }
      requests ??= module.createLengthSortRequests();
      const entries = active ? inputs.entries() : [];
      const sources = active ? module.lengthSources() : [];
      // Requests read resolver caches: untracked, so settling values never
      // re-runs this effect (the listing, sort and sources do).
      untrack(() => requests!.sync(active, path, entries, sources));
    });
  });
  return () => {
    stop();
    requests?.dispose();
  };
}
