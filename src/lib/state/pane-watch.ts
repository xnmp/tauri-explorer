/**
 * Per-pane filesystem watch + local-mutation cooldown.
 * Extracted from explorer.svelte.ts; no Svelte or UI dependencies.
 */

import { watchDirectory, unwatchDirectory } from "$lib/api/files";
import { isVirtualPath } from "$lib/domain/virtual-path";

/** How long after a local mutation watcher-triggered refreshes are ignored. */
export const MUTATION_COOLDOWN_MS = 1000;

export function createPaneWatch() {
  let watchedPath: string | null = null;

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

    /** Watch `newPath`, releasing the previous watch (no-op if unchanged).
     *  Virtual (`scheme://…`) paths aren't real directories — release any
     *  existing watch and skip watching them. */
    update(newPath: string): void {
      if (isVirtualPath(newPath)) {
        if (watchedPath) {
          unwatchDirectory(watchedPath);
          watchedPath = null;
        }
        return;
      }
      if (watchedPath === newPath) return;
      if (watchedPath) unwatchDirectory(watchedPath);
      watchDirectory(newPath);
      watchedPath = newPath;
    },

    destroy(): void {
      if (watchedPath) {
        unwatchDirectory(watchedPath);
        watchedPath = null;
      }
    },
  };
}

export type PaneWatch = ReturnType<typeof createPaneWatch>;
