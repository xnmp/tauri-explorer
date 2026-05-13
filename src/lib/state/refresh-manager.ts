/**
 * Deduplicates and debounces directory refresh requests.
 *
 * A single file operation can trigger 2-3 refresh cycles through different
 * paths (onRefresh callback, broadcastFileChange, filesystem watcher).
 * This module collapses them into one refresh per directory per debounce window.
 */

const DEBOUNCE_MS = 150;
const pendingRefreshes = new Map<string, ReturnType<typeof setTimeout>>();

export function requestRefresh(
  explorerRefresh: (opts: { silent: boolean }) => void,
  dirPath: string,
  silent: boolean = true,
): void {
  const existing = pendingRefreshes.get(dirPath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingRefreshes.delete(dirPath);
    explorerRefresh({ silent });
  }, DEBOUNCE_MS);
  pendingRefreshes.set(dirPath, timer);
}

export function cancelPendingRefreshes(): void {
  for (const timer of pendingRefreshes.values()) clearTimeout(timer);
  pendingRefreshes.clear();
}
