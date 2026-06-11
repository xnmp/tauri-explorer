/**
 * Deduplicates, debounces, and rate-limits directory refresh requests.
 *
 * A single file operation can trigger 2-3 refresh cycles through different
 * paths (onRefresh callback, broadcastFileChange, filesystem watcher).
 * This module collapses them into one refresh per directory per debounce window,
 * and enforces a minimum interval between consecutive refreshes to prevent
 * refresh storms on highly active directories (e.g. /tmp).
 *
 * Requests fan out per subscriber: when two panes show the same directory,
 * both panes refresh when the window flushes (previously only the last
 * registered callback won). Repeated requests from the same subscriber
 * (same callback identity or explicit subscriber key) collapse to one.
 */

const DEBOUNCE_MS = 150;
const MIN_INTERVAL_MS = 2000;

type RefreshCallback = (opts: { silent: boolean }) => void;

interface PendingRefresh {
  timer: ReturnType<typeof setTimeout>;
  callbacks: Map<unknown, { cb: RefreshCallback; silent: boolean }>;
}

const pendingRefreshes = new Map<string, PendingRefresh>();
const lastRefreshAt = new Map<string, number>();

function flush(dirPath: string): void {
  const pending = pendingRefreshes.get(dirPath);
  if (!pending) return;
  pendingRefreshes.delete(dirPath);
  lastRefreshAt.set(dirPath, Date.now());
  for (const { cb, silent } of pending.callbacks.values()) {
    cb({ silent });
  }
}

export function requestRefresh(
  explorerRefresh: RefreshCallback,
  dirPath: string,
  silent: boolean = true,
  /** Identity used to collapse repeated requests from the same subscriber.
   *  Defaults to the callback itself. */
  subscriberKey: unknown = explorerRefresh,
): void {
  const last = lastRefreshAt.get(dirPath);
  const elapsed = last != null ? Date.now() - last : Infinity;
  const delay = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - elapsed);

  const existing = pendingRefreshes.get(dirPath);
  if (existing) {
    clearTimeout(existing.timer);
    existing.callbacks.set(subscriberKey, { cb: explorerRefresh, silent });
    existing.timer = setTimeout(() => flush(dirPath), delay);
    return;
  }

  pendingRefreshes.set(dirPath, {
    callbacks: new Map([[subscriberKey, { cb: explorerRefresh, silent }]]),
    timer: setTimeout(() => flush(dirPath), delay),
  });
}

export function cancelPendingRefreshes(): void {
  for (const pending of pendingRefreshes.values()) clearTimeout(pending.timer);
  pendingRefreshes.clear();
  lastRefreshAt.clear();
}
