/**
 * Content search stream lifecycle for ContentSearchDialog.
 *
 * Owns the IPC stream: the search id, the 'content-search-results' event
 * listener (registered BEFORE the invoke so fast-completing searches can't
 * emit before we listen), the generation counter that discards stale events,
 * and the per-search dedup set. Pure flattening lives in
 * domain/content-search-flatten.
 *
 * Rendering-facing arrays use $state.raw: rows are plain immutable objects,
 * so replacing the array reference is enough to re-render without paying for
 * deep proxies over thousands of match objects.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  startContentSearch,
  cancelContentSearch,
  type ContentSearchEvent,
  type ContentSearchResult,
} from "$lib/api/files";
import {
  flattenBatch,
  rebuildAllFlattened,
  type FlattenedResult,
} from "$lib/domain/content-search-flatten";

export interface ContentSearchOptions {
  caseSensitive: boolean;
  regexMode: boolean;
  maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 5000;

export function useContentSearch() {
  // Published render state.
  let flattened = $state.raw<FlattenedResult[]>([]);
  let expandedFiles = $state.raw<ReadonlySet<string>>(new Set());
  let loading = $state(false);
  let filesSearched = $state(0);
  let totalMatches = $state(0);
  let fileCount = $state(0);

  // Non-reactive accumulators for the in-flight search.
  let results: ContentSearchResult[] = [];
  let allFlattened: FlattenedResult[] = [];
  let seenPaths = new Set<string>();
  let filterLower = "";

  // Stream lifecycle.
  let generation = 0;
  let activeSearchId: number | null = null;
  let unlisten: UnlistenFn | null = null;

  function publish(): void {
    flattened = allFlattened.slice();
    fileCount = results.length;
  }

  function teardownListener(): void {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  }

  async function cancelActive(): Promise<void> {
    if (activeSearchId !== null) {
      const id = activeSearchId;
      activeSearchId = null;
      await cancelContentSearch(id);
    }
    teardownListener();
  }

  function ingest(gen: number, payload: ContentSearchEvent): void {
    if (gen !== generation) return;

    // Accept events matching our search id, OR adopt the id from the first
    // event if we haven't learned it yet (the backend thread can emit before
    // the invoke returns). Once adopted, lock to it.
    if (activeSearchId === null) {
      activeSearchId = payload.searchId;
    } else if (payload.searchId !== activeSearchId) {
      return;
    }

    // Dedup across batches with a persistent set — O(batch), not O(total).
    const fresh = payload.results.filter((r) => {
      if (seenPaths.has(r.path)) return false;
      seenPaths.add(r.path);
      return true;
    });

    if (fresh.length > 0) {
      results.push(...fresh);
      const batch = flattenBatch(fresh, filterLower, expandedFiles);
      if (batch.length > 0) allFlattened.push(...batch);
    }

    filesSearched = payload.filesSearched;
    totalMatches = payload.totalMatches;
    publish();

    if (payload.done) loading = false;
  }

  async function setupListener(gen: number): Promise<void> {
    teardownListener();
    unlisten = await listen<ContentSearchEvent>("content-search-results", (event) => {
      ingest(gen, event.payload);
    });
  }

  /**
   * Start a new search, superseding any in-flight one. The previous search's
   * rows stay on screen until the new search produces data, so re-searching
   * never flashes an empty list.
   */
  async function start(query: string, root: string, opts: ContentSearchOptions): Promise<void> {
    const gen = ++generation;
    loading = true;

    await cancelActive();
    if (gen !== generation) return;

    results = [];
    allFlattened = [];
    seenPaths = new Set();
    expandedFiles = new Set();
    filesSearched = 0;
    totalMatches = 0;

    // Register the listener BEFORE invoking so a fast-completing search
    // can't emit batches (or `done`) before we're listening. Outside Tauri
    // the event system is unavailable and listen() rejects — the mock then
    // returns the complete result set inline instead.
    let streaming = true;
    try {
      await setupListener(gen);
    } catch {
      streaming = false;
    }
    if (gen !== generation) return;

    const res = await startContentSearch(
      query,
      root,
      opts.caseSensitive,
      opts.regexMode,
      opts.maxResults ?? DEFAULT_MAX_RESULTS
    );

    if (gen !== generation) {
      // Superseded while awaiting: cancel the now-orphaned backend search.
      if (res.ok && res.data.searchId !== null) void cancelContentSearch(res.data.searchId);
      return;
    }

    if (!res.ok) {
      publish(); // accumulators are empty — clears stale rows
      loading = false;
      return;
    }

    if (res.data.inline) {
      ingest(gen, res.data.inline);
      if (!res.data.inline.done) loading = false;
      return;
    }

    activeSearchId = res.data.searchId;
    if (!streaming) loading = false;
  }

  function rebuild(): void {
    allFlattened = rebuildAllFlattened(results, filterLower, expandedFiles);
    publish();
  }

  /** Re-filter the current results (case-insensitive substring). */
  function setFilter(filter: string): void {
    filterLower = filter.toLowerCase();
    rebuild();
  }

  /** Toggle showing all matches for a file vs the collapsed preview. */
  function toggleExpanded(filePath: string): void {
    const next = new Set(expandedFiles);
    if (next.has(filePath)) next.delete(filePath);
    else next.add(filePath);
    expandedFiles = next;
    rebuild();
  }

  /** Clear all state and cancel any in-flight search. */
  function reset(): void {
    generation++;
    results = [];
    allFlattened = [];
    seenPaths = new Set();
    expandedFiles = new Set();
    filterLower = "";
    flattened = [];
    fileCount = 0;
    filesSearched = 0;
    totalMatches = 0;
    loading = false;
    void cancelActive();
  }

  return {
    get flattened() {
      return flattened;
    },
    get expandedFiles() {
      return expandedFiles;
    },
    get loading() {
      return loading;
    },
    get filesSearched() {
      return filesSearched;
    },
    get totalMatches() {
      return totalMatches;
    },
    get fileCount() {
      return fileCount;
    },
    start,
    setFilter,
    toggleExpanded,
    reset,
  };
}

export type ContentSearchStore = ReturnType<typeof useContentSearch>;
