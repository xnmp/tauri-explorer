/**
 * Coordinates the expensive recursive-search boundary used by Quick Open.
 *
 * Keeping this scheduler in the domain layer makes the user-visible promise
 * testable: a burst of text input produces one backend search for its final
 * value. The component remains responsible for rendering immediate local
 * matches while it waits.
 */
export interface QuickOpenSearchScheduler {
  schedule(query: string): void;
  cancel(): void;
}

/** Maximum number of ranked rows Quick Open presents for one query. */
export const QUICK_OPEN_RESULT_LIMIT = 20;

export type StartQuickOpenSearch = (query: string) => void;

export interface QuickOpenSearchController<T> {
  handleInput(query: string): T[];
  dispose(): void;
}

export interface QuickOpenStreamResources {
  readonly searchId: number | null;
  setSearchId(searchId: number): void;
  matchesOrAdopts(searchId: number): boolean;
  replaceListener(unlisten: () => void): void;
  cancel(): Promise<void>;
}

/**
 * Owns the active backend search and its event listener as one lifecycle.
 * Listener teardown is deliberately synchronous: an IPC cancellation may be
 * slow, and its eventual completion must never detach a replacement stream.
 */
export function createQuickOpenStreamResources(
  cancelSearch: (searchId: number) => Promise<unknown>,
): QuickOpenStreamResources {
  let searchId: number | null = null;
  let unlisten: (() => void) | null = null;

  return {
    get searchId() {
      return searchId;
    },
    setSearchId(nextSearchId) {
      searchId = nextSearchId;
    },
    matchesOrAdopts(eventSearchId) {
      if (searchId === null) {
        searchId = eventSearchId;
        return true;
      }
      return eventSearchId === searchId;
    },
    replaceListener(nextUnlisten) {
      unlisten?.();
      unlisten = nextUnlisten;
    },
    async cancel() {
      const searchIdToCancel = searchId;
      searchId = null;
      const listenerToRemove = unlisten;
      unlisten = null;
      listenerToRemove?.();

      if (searchIdToCancel !== null) {
        await cancelSearch(searchIdToCancel);
      }
    },
  };
}

/**
 * A trailing pause keeps normal typing from launching a full directory walk
 * for every intermediate character while still feeling immediate in the UI.
 */
export const QUICK_OPEN_SEARCH_DEBOUNCE_MS = 150;

/**
 * Creates the search-start boundary for Quick Open.
 *
 * Only the final query in a burst reaches the expensive recursive backend.
 */
export function createQuickOpenSearchScheduler(
  startSearch: StartQuickOpenSearch,
): QuickOpenSearchScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule(query) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        startSearch(query);
      }, QUICK_OPEN_SEARCH_DEBOUNCE_MS);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Connects immediate in-memory matching with the delayed recursive-search
 * boundary. Components use the returned matches immediately; only the final
 * value from a typing burst reaches `startSearch`.
 */
export function createQuickOpenSearchController<T>({
  immediateMatches,
  startSearch,
  cancelActiveSearch,
}: {
  immediateMatches: (query: string) => T[];
  startSearch: StartQuickOpenSearch;
  cancelActiveSearch: () => void;
}): QuickOpenSearchController<T> {
  const scheduler = createQuickOpenSearchScheduler(startSearch);

  return {
    handleInput(query) {
      cancelActiveSearch();
      if (!query.trim()) {
        scheduler.cancel();
        return [];
      }
      const matches = immediateMatches(query);
      scheduler.schedule(query);
      return matches;
    },
    dispose() {
      scheduler.cancel();
      cancelActiveSearch();
    },
  };
}
