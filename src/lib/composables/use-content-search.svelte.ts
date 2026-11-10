/**
 * Content search stream lifecycle for ContentSearchDialog.
 *
 * Owns the IPC stream: one run per search holding its listener (registered
 * BEFORE the invoke so fast-completing searches can't emit before we listen)
 * and its backend id, plus the per-search dedup set. Leaving a run detaches
 * its listener synchronously; events are attributed to a run only by the id
 * its own start IPC returned (domain/stream-correlation). Pure flattening lives in
 * domain/content-search-flatten.
 *
 * Rendering-facing arrays use $state.raw: rows are plain immutable objects,
 * so replacing the array reference is enough to re-render without paying for
 * deep proxies over thousands of match objects.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { startContentSearch, cancelContentSearch, type ContentSearchEvent, type ContentSearchResult } from "$lib/api/search";
import {
  heldEventsFor,
  holdStreamEvent,
  noHeldStreamEvents,
  type HeldStreamEvents,
} from "$lib/domain/stream-correlation";
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

/** One search: the identity every async continuation checks. */
interface StreamRun {
  /** Backend stream id, known once the start IPC returns. */
  searchId: number | null;
  /** Events that arrived before `searchId` was known (#1581). */
  held: HeldStreamEvents<ContentSearchEvent>;
  unlisten: UnlistenFn | null;
}

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

  // Stream lifecycle: the current run owns its listener and its backend id;
  // a continuation whose run is no longer `run` was superseded.
  let run: StreamRun | null = null;

  function publish(): void {
    flattened = allFlattened.slice();
    fileCount = results.length;
  }

  /**
   * Leave the current run. Its listener is detached synchronously and the
   * backend cancellation goes out last, unawaited: nothing a later run owns
   * may depend on that IPC's completion, or a late cancellation would tear
   * down its replacement's listener (#1579).
   */
  function leaveRun(): void {
    const previous = run;
    run = null;
    if (!previous) return;
    previous.unlisten?.();
    if (previous.searchId !== null) void cancelContentSearch(previous.searchId);
  }

  function receive(current: StreamRun, payload: ContentSearchEvent): void {
    if (run !== current) return;
    // Results are app-wide events: until the start IPC names this run's
    // stream, an event may be another window's search or a cancelled one.
    // Hold it rather than adopt its id (#1581).
    if (current.searchId === null) {
      current.held = holdStreamEvent(current.held, payload, "all");
      return;
    }
    if (payload.searchId === current.searchId) ingest(payload);
  }

  function ingest(payload: ContentSearchEvent): void {
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

  /**
   * Start a new search, superseding any in-flight one. The previous search's
   * rows stay on screen until the new search produces data, so re-searching
   * never flashes an empty list.
   */
  async function start(query: string, root: string, opts: ContentSearchOptions): Promise<void> {
    leaveRun();
    const current: StreamRun = { searchId: null, held: noHeldStreamEvents(), unlisten: null };
    run = current;
    loading = true;

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
      const unlisten = await listen<ContentSearchEvent>("content-search-results", (event) => {
        receive(current, event.payload);
      });
      if (run !== current) {
        // Superseded while registering: never let a stale listener survive.
        unlisten();
        return;
      }
      current.unlisten = unlisten;
    } catch {
      streaming = false;
    }
    if (run !== current) return;

    const res = await startContentSearch(
      query,
      root,
      opts.caseSensitive,
      opts.regexMode,
      opts.maxResults ?? DEFAULT_MAX_RESULTS
    );

    if (run !== current) {
      // Superseded while awaiting: cancel the now-orphaned backend search.
      if (res.ok && res.data.searchId !== null) void cancelContentSearch(res.data.searchId);
      return;
    }

    if (!res.ok) {
      current.held = noHeldStreamEvents();
      publish(); // accumulators are empty — clears stale rows
      loading = false;
      return;
    }

    if (res.data.inline) {
      ingest(res.data.inline);
      if (!res.data.inline.done) loading = false;
      return;
    }

    const searchId = res.data.searchId;
    const early = searchId === null ? [] : heldEventsFor(current.held, searchId);
    current.searchId = searchId;
    current.held = noHeldStreamEvents();
    for (const payload of early) ingest(payload);
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
    leaveRun();
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
