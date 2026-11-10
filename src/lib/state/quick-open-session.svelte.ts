/**
 * Quick Open search session (#1577): the query, the rendered result rows and
 * the recursive-search stream lifecycle, owned outside the component so every
 * ordering rule is testable through an import.
 *
 * One discriminated `StreamState` replaces the former generation counter,
 * debounce timer and stream-resource holder. Every async continuation carries
 * the `StreamRun` it belongs to and acts only while that run is still the
 * current one, so there is no second token that can disagree with the first.
 *
 * Ordering rules (CLAUDE.md "Quick Open …", #600, #651, #1007):
 * - Local (recents/frecency/active-pane) matches render synchronously on every
 *   input; only the recursive backend walk waits for the trailing debounce.
 * - New input, an emptied query, close and open leave the current stream at
 *   once: the debounce timer is cleared, the stream listener is detached
 *   synchronously, and only then is backend cancellation requested. The
 *   cancellation IPC is never awaited, so its completion cannot touch a later
 *   stream's listener.
 * - The listener is registered BEFORE the start IPC, and the first event's
 *   search id is adopted while the start IPC is still in flight (the backend
 *   can emit before `invoke` returns); later events must match that id.
 * - A start that resolves after its run was superseded cancels the orphaned
 *   backend search and changes nothing else.
 * - Outside Tauri `listen` rejects, and the session falls back to the
 *   one-shot `fallbackSearch`.
 */
import type { ApiResult } from "$lib/api/common";
import type { SearchResult } from "$lib/domain/search";
import { clampSelection, mergeResultsByScore } from "$lib/domain/quick-open-ranking";
import { QUICK_OPEN_RESULT_LIMIT, QUICK_OPEN_SEARCH_DEBOUNCE_MS } from "$lib/domain/quick-open-search";

/** Payload of one `search-results` event. */
export interface QuickOpenStreamEvent {
  readonly searchId: number;
  readonly results: SearchResult[];
  readonly done: boolean;
  readonly totalScanned: number;
}

type Unlisten = () => void;

export interface QuickOpenTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface QuickOpenSessionDeps {
  /** Registers the stream listener; rejects where Tauri events are unavailable. */
  listen(onEvent: (event: QuickOpenStreamEvent) => void): Promise<Unlisten>;
  startStream(query: string, root: string, limit: number): Promise<ApiResult<number>>;
  cancelStream(searchId: number): Promise<unknown>;
  /** One-shot search used when streaming is unavailable (browser/mock mode). */
  fallbackSearch(query: string, root: string, limit: number): Promise<ApiResult<SearchResult[]>>;
  /** Recents/frecency/active-pane matches, read from the live stores. */
  localMatches(query: string): SearchResult[];
  /** Backend hits re-ranked with the live frecency scores. */
  rankBackend(results: readonly SearchResult[], query: string): SearchResult[];
  /** Root of the recursive walk, read when the debounce fires. */
  searchRoot(): string;
  /** Backend hits replaced the rendered rows (the pointer-intent re-anchor). */
  onBackendResults(): void;
  timers?: QuickOpenTimers;
}

/** One debounce firing: the identity every async continuation checks. */
interface StreamRun {
  readonly query: string;
}

type StreamState =
  /** No pending work: closed, empty query, or a settled fallback search. */
  | { readonly kind: "idle" }
  /** A non-empty query waits out the trailing pause. */
  | { readonly kind: "debouncing"; readonly query: string; readonly timer: unknown }
  /**
   * Listener registration (`unlisten` null) or the stream itself. Events are
   * accepted from the moment the listener exists. `searchId` is adopted from
   * the first event or set by the start IPC; `settled` once `done` arrives or
   * the start IPC fails. The listener stays attached until the run is left.
   */
  | {
      readonly kind: "streaming";
      readonly run: StreamRun;
      readonly unlisten: Unlisten | null;
      readonly searchId: number | null;
      readonly settled: boolean;
    }
  /** Streaming is unavailable; the one-shot search is in flight. */
  | { readonly kind: "fallback"; readonly run: StreamRun };

type Streaming = Extract<StreamState, { kind: "streaming" }>;

const IDLE: StreamState = { kind: "idle" };

const globalTimers: QuickOpenTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createQuickOpenSession(deps: QuickOpenSessionDeps) {
  const timers = deps.timers ?? globalTimers;

  let stream = $state.raw<StreamState>(IDLE);
  let query = $state("");
  let results = $state.raw<SearchResult[]>([]);
  let selectedIndex = $state(0);
  let totalScanned = $state(0);
  // Raw backend hits for the current query, kept so a downvote can re-run the
  // ranking from scratch instead of adding frecency to already-boosted scores.
  let rawResults: readonly SearchResult[] = [];

  const loading = $derived(
    stream.kind === "debouncing" ||
      stream.kind === "fallback" ||
      (stream.kind === "streaming" && !stream.settled),
  );

  function isCurrent(run: StreamRun): boolean {
    return (stream.kind === "streaming" || stream.kind === "fallback") && stream.run === run;
  }

  function streamingFor(run: StreamRun): Streaming | null {
    return stream.kind === "streaming" && stream.run === run ? stream : null;
  }

  /**
   * Leave the current stream. State, timer and listener are released
   * synchronously; the backend cancellation request goes out last and is not
   * awaited, so nothing a later stream owns can depend on its completion.
   */
  function leaveStream(): void {
    const previous = stream;
    stream = IDLE;
    if (previous.kind === "debouncing") {
      timers.clear(previous.timer);
    } else if (previous.kind === "streaming") {
      previous.unlisten?.();
      if (previous.searchId !== null) void deps.cancelStream(previous.searchId);
    }
  }

  function publishLocal(term: string): void {
    rawResults = [];
    results = mergeResultsByScore([], deps.localMatches(term));
  }

  function publishBackend(run: StreamRun, raw: SearchResult[]): void {
    rawResults = raw;
    results = mergeResultsByScore(deps.rankBackend(raw, run.query), deps.localMatches(run.query));
    deps.onBackendResults();
    selectedIndex = clampSelection(selectedIndex, results.length);
  }

  function receive(run: StreamRun, event: QuickOpenStreamEvent): void {
    const current = streamingFor(run);
    if (!current) return;
    if (current.searchId === null) {
      stream = { ...current, searchId: event.searchId };
    } else if (event.searchId !== current.searchId) {
      return;
    }
    publishBackend(run, event.results);
    totalScanned = event.totalScanned;
    if (event.done) settle(run);
  }

  function settle(run: StreamRun): void {
    const current = streamingFor(run);
    if (current) stream = { ...current, settled: true };
  }

  async function runFallback(run: StreamRun, root: string): Promise<void> {
    const found = await deps.fallbackSearch(run.query, root, QUICK_OPEN_RESULT_LIMIT);
    if (!isCurrent(run)) return;
    if (found.ok) publishBackend(run, found.data);
    stream = IDLE;
  }

  async function attachAndStart(run: StreamRun, root: string): Promise<void> {
    let unlisten: Unlisten;
    try {
      unlisten = await deps.listen((event) => receive(run, event));
    } catch {
      if (!isCurrent(run)) return;
      stream = { kind: "fallback", run };
      return runFallback(run, root);
    }

    const registering = streamingFor(run);
    if (!registering) {
      // Superseded while registering: never let a stale listener survive.
      unlisten();
      return;
    }
    stream = { ...registering, unlisten };

    const started = await deps.startStream(run.query, root, QUICK_OPEN_RESULT_LIMIT);
    const current = streamingFor(run);
    if (!current) {
      // Superseded while starting: cancel the now-orphaned backend search.
      if (started.ok) void deps.cancelStream(started.data);
      return;
    }
    stream = started.ok ? { ...current, searchId: started.data } : { ...current, settled: true };
  }

  function fire(timer: unknown): void {
    if (stream.kind !== "debouncing" || stream.timer !== timer) return;
    const run: StreamRun = { query: stream.query };
    // The pause may have changed the stores (e.g. the pane finished loading).
    publishLocal(run.query);
    const root = deps.searchRoot();
    stream = { kind: "streaming", run, unlisten: null, searchId: null, settled: false };
    void attachAndStart(run, root);
  }

  function reset(): void {
    leaveStream();
    query = "";
    results = [];
    rawResults = [];
    selectedIndex = 0;
    totalScanned = 0;
  }

  return {
    get query() {
      return query;
    },
    get results() {
      return results;
    },
    get selectedIndex() {
      return selectedIndex;
    },
    set selectedIndex(index: number) {
      selectedIndex = index;
    },
    get totalScanned() {
      return totalScanned;
    },
    get loading() {
      return loading;
    },

    /** The input changed: local matches now, the recursive search after the pause. */
    input(next: string): void {
      leaveStream();
      query = next;
      if (!next.trim()) {
        results = [];
        rawResults = [];
        selectedIndex = 0;
        totalScanned = 0;
        return;
      }
      // A new query pins the selection to the top result (VSCode behavior).
      selectedIndex = 0;
      publishLocal(next);
      const timer: unknown = timers.set(() => fire(timer), QUICK_OPEN_SEARCH_DEBOUNCE_MS);
      stream = { kind: "debouncing", query: next, timer };
    },

    /** Re-rank the current rows after frecency/recents changed (downvote). */
    rerank(): void {
      if (!query.trim()) return;
      results = mergeResultsByScore(deps.rankBackend(rawResults, query), deps.localMatches(query));
      selectedIndex = clampSelection(selectedIndex, results.length);
    },

    /** The dialog opened: start from an empty query with nothing pending. */
    open: reset,

    /** The dialog closed or unmounted: stop all search work. */
    close(): void {
      leaveStream();
      totalScanned = 0;
    },
  };
}

export type QuickOpenSession = ReturnType<typeof createQuickOpenSession>;
