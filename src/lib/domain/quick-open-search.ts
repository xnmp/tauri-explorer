/**
 * The expensive recursive-search boundary shared by Quick Open and the file
 * picker: a burst of text input produces one backend search for its final
 * value, after QUICK_OPEN_SEARCH_DEBOUNCE_MS of quiet. Callers render
 * immediate local matches while they wait. Quick Open's full stream lifecycle
 * (debounce, listener, cancellation) lives in `state/quick-open-session`.
 */
export interface QuickOpenSearchScheduler {
  schedule(query: string): void;
  cancel(): void;
}

/** Maximum number of ranked rows Quick Open presents for one query. */
export const QUICK_OPEN_RESULT_LIMIT = 20;

export type StartQuickOpenSearch = (query: string) => void;

/**
 * A trailing pause keeps normal typing from launching a full directory walk
 * for every intermediate character while still feeling immediate in the UI.
 */
export const QUICK_OPEN_SEARCH_DEBOUNCE_MS = 150;

/**
 * Creates the search-start boundary used by the file picker.
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
