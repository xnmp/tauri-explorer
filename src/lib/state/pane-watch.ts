/**
 * Per-pane filesystem watch + local-mutation cooldown.
 * Extracted from explorer.svelte.ts; no Svelte or UI dependencies.
 */

import { createDirectoryWatch } from "./directory-watch";

/** How long after a local mutation watcher-triggered refreshes are ignored. */
export const MUTATION_COOLDOWN_MS = 1000;

export function createPaneWatch() {
  const directoryWatch = createDirectoryWatch();

  // Suppress redundant watcher refreshes after local mutations
  // (delete/rename/create). Local mutations already update entries; the
  // watcher event that follows would trigger an identical refresh causing
  // all thumbnails to flash.
  let lastMutationTime = 0;

  return {
    markLocalMutation(): void {
      lastMutationTime = Date.now();
    },

    inMutationCooldown(): boolean {
      return Date.now() - lastMutationTime < MUTATION_COOLDOWN_MS;
    },

    ...directoryWatch,
  };
}

export type PaneWatch = ReturnType<typeof createPaneWatch>;
