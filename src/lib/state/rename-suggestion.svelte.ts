/**
 * Inline-rename autocomplete suggestions (#215).
 *
 * A single pluggable provider (registered by the ai-rename plugin) is asked
 * for one suggested filename when a rename session starts. The suggestion is
 * exposed reactively, keyed to the entry being renamed, so the rename box can
 * offer it as a Tab-autocomplete. Core stays model-agnostic: without a
 * registered provider (plugin disabled, no API key) nothing is fetched and
 * Tab keeps its default behavior.
 */

import type { FileEntry } from "$lib/domain/file";

export type RenameSuggestionProvider = (entry: FileEntry) => Promise<string | null>;

function createRenameSuggestionStore() {
  // Plain (non-reactive): only consulted at fetch time.
  let provider: RenameSuggestionProvider | null = null;

  // The path this suggestion belongs to guards against a late response
  // landing on a different rename session.
  let suggestion = $state<{ forPath: string; name: string } | null>(null);
  let pending = $state(false);
  let requestSeq = 0;

  return {
    /** Reactive: the suggested full filename for `path`, or null. */
    suggestionFor(path: string): string | null {
      return suggestion?.forPath === path ? suggestion.name : null;
    },

    get pending(): boolean {
      return pending;
    },

    get hasProvider(): boolean {
      return provider !== null;
    },

    setProvider(p: RenameSuggestionProvider): void {
      provider = p;
    },

    /** Remove `p` if it is the current provider (a stale plugin deactivate
     *  must not clobber a newer registration). */
    clearProvider(p: RenameSuggestionProvider): void {
      if (provider === p) provider = null;
    },

    /** Start fetching a suggestion for a freshly-opened rename session. */
    fetch(entry: FileEntry): void {
      this.clear();
      if (!provider) return;
      const seq = ++requestSeq;
      pending = true;
      provider(entry)
        .then((name) => {
          if (seq !== requestSeq) return; // superseded by a newer session
          pending = false;
          const trimmed = name?.trim() ?? "";
          // An empty or unchanged suggestion is no suggestion.
          if (!trimmed || trimmed === entry.name) return;
          suggestion = { forPath: entry.path, name: trimmed };
        })
        .catch(() => {
          if (seq === requestSeq) pending = false;
          // Suggestions are best-effort; failures stay silent.
        });
    },

    /** Drop any current/pending suggestion (rename confirmed or cancelled). */
    clear(): void {
      requestSeq++;
      pending = false;
      suggestion = null;
    },
  };
}

export const renameSuggestionStore = createRenameSuggestionStore();
