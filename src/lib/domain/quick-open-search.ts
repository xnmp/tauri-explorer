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
 * Creates the search-start boundary for Quick Open.
 *
 * This initial contract intentionally invokes immediately; the red test pins
 * the required debounce behaviour before the green implementation changes it.
 */
export function createQuickOpenSearchScheduler(
  startSearch: StartQuickOpenSearch,
): QuickOpenSearchScheduler {
  return {
    schedule(query) {
      startSearch(query);
    },
    cancel() {},
  };
}
