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

export type StartQuickOpenSearch = (query: string) => void;

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
