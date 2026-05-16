/**
 * Deduplicates, debounces, and rate-limits directory refresh requests.
 *
 * A single file operation can trigger 2-3 refresh cycles through different
 * paths (onRefresh callback, broadcastFileChange, filesystem watcher).
 * This module collapses them into one refresh per directory per debounce window,
 * and enforces a minimum interval between consecutive refreshes to prevent
 * refresh storms on highly active directories (e.g. /tmp).
 */

const DEBOUNCE_MS = 150;
const MIN_INTERVAL_MS = 2000;

const pendingRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
const lastRefreshAt = new Map<string, number>();

export function requestRefresh(
  explorerRefresh: (opts: { silent: boolean }) => void,
  dirPath: string,
  silent: boolean = true,
): void {
  const existing = pendingRefreshes.get(dirPath);
  if (existing) clearTimeout(existing);

  const last = lastRefreshAt.get(dirPath);
  const elapsed = last != null ? Date.now() - last : Infinity;
  const delay = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - elapsed);

  const timer = setTimeout(() => {
    pendingRefreshes.delete(dirPath);
    lastRefreshAt.set(dirPath, Date.now());
    explorerRefresh({ silent });
  }, delay);
  pendingRefreshes.set(dirPath, timer);
}

export function cancelPendingRefreshes(): void {
  for (const timer of pendingRefreshes.values()) clearTimeout(timer);
  pendingRefreshes.clear();
  lastRefreshAt.clear();
}
