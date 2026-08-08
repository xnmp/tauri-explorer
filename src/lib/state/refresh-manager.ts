/**
 * Deduplicates, debounces, and rate-limits directory refresh requests.
 *
 * ## Refresh policy ownership (audit A9)
 *
 * Refresh behavior is layered across three modules, each owning ONE decision.
 * When changing refresh behavior, change the layer that owns the decision —
 * do not add a fourth gate:
 *
 * 1. **This module — WHEN a refresh runs.** Global, per-directory: collapses
 *    duplicate requests from all sources into one per debounce window and
 *    rate-limits storms.
 * 2. **`pane-watch.ts` — WHETHER a watcher-triggered refresh may run.**
 *    Per-pane: the local-mutation cooldown suppresses the watcher's echo of
 *    a mutation the pane already applied to its own entries.
 * 3. **`pane-refresh.ts` — HOW a refresh is applied.** Per-pane: fetches
 *    without touching UI state and drops the result when the entry
 *    fingerprint is unchanged (no flash) or the pane navigated away.
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
const SLOW_LISTING_MULTIPLIER = 3;
const MAX_INTERVAL_MS = 8000;

type RefreshCallback = (opts: { silent: boolean }) => void | Promise<void>;

interface PendingRefresh {
  timer: ReturnType<typeof setTimeout> | null;
  callbacks: Map<unknown, { cb: RefreshCallback; silent: boolean }>;
  requestedAt: number;
}

const pendingRefreshes = new Map<string, PendingRefresh>();
const lastRefreshAt = new Map<string, number>();
const inFlightRefreshes = new Set<string>();
const listingBaselines = new Map<string, number>();
const refreshIntervals = new Map<string, number>();

function intervalFor(dirPath: string): number {
  return refreshIntervals.get(dirPath) ?? MIN_INTERVAL_MS;
}

function schedule(dirPath: string, pending: PendingRefresh): void {
  if (pending.timer) clearTimeout(pending.timer);
  const now = Date.now();
  const last = lastRefreshAt.get(dirPath);
  const sinceLastRefresh = last == null ? Infinity : now - last;
  const sinceLastRequest = now - pending.requestedAt;
  const delay = Math.max(
    0,
    DEBOUNCE_MS - sinceLastRequest,
    intervalFor(dirPath) - sinceLastRefresh,
  );
  pending.timer = setTimeout(() => flush(dirPath), delay);
}

function recordListingDuration(dirPath: string, duration: number): void {
  // A synchronous test callback has no listing wall-clock to learn from.
  if (duration <= 0) return;

  const baseline = listingBaselines.get(dirPath);
  if (baseline != null && duration > baseline * SLOW_LISTING_MULTIPLIER) {
    refreshIntervals.set(
      dirPath,
      Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, MIN_INTERVAL_MS * Math.ceil(duration / baseline))),
    );
    return;
  }

  // Normal observations slowly follow real storage performance. A degraded
  // observation deliberately does not raise the baseline, so a healthy listing
  // immediately restores the normal watcher cadence.
  listingBaselines.set(dirPath, baseline == null ? duration : Math.round(baseline * 0.75 + duration * 0.25));
  refreshIntervals.set(dirPath, MIN_INTERVAL_MS);
}

function finishRefresh(dirPath: string, startedAt: number): void {
  inFlightRefreshes.delete(dirPath);
  recordListingDuration(dirPath, Date.now() - startedAt);
  const pending = pendingRefreshes.get(dirPath);
  if (pending) schedule(dirPath, pending);
}

function flush(dirPath: string): void {
  const pending = pendingRefreshes.get(dirPath);
  if (!pending) return;
  pendingRefreshes.delete(dirPath);
  const startedAt = Date.now();
  lastRefreshAt.set(dirPath, startedAt);
  inFlightRefreshes.add(dirPath);
  const completions: Promise<void>[] = [];
  for (const { cb, silent } of pending.callbacks.values()) {
    try {
      const result = cb({ silent });
      if (result) completions.push(Promise.resolve(result).catch(() => undefined));
    } catch {
      // A refresh failure is already handled at the pane boundary. Keep the
      // scheduler alive so a later watcher event can retry it.
    }
  }
  if (completions.length === 0) {
    finishRefresh(dirPath, startedAt);
    return;
  }
  void Promise.all(completions).then(() => finishRefresh(dirPath, startedAt));
}

export function requestRefresh(
  explorerRefresh: RefreshCallback,
  dirPath: string,
  silent: boolean = true,
  /** Identity used to collapse repeated requests from the same subscriber.
   *  Defaults to the callback itself. */
  subscriberKey: unknown = explorerRefresh,
): void {
  const existing = pendingRefreshes.get(dirPath);
  if (existing) {
    existing.callbacks.set(subscriberKey, { cb: explorerRefresh, silent });
    existing.requestedAt = Date.now();
    if (!inFlightRefreshes.has(dirPath)) schedule(dirPath, existing);
    return;
  }

  const pending: PendingRefresh = {
    callbacks: new Map([[subscriberKey, { cb: explorerRefresh, silent }]]),
    requestedAt: Date.now(),
    timer: null,
  };
  pendingRefreshes.set(dirPath, pending);
  if (!inFlightRefreshes.has(dirPath)) schedule(dirPath, pending);
}

export function cancelPendingRefreshes(): void {
  for (const pending of pendingRefreshes.values()) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  pendingRefreshes.clear();
  lastRefreshAt.clear();
  inFlightRefreshes.clear();
  listingBaselines.clear();
  refreshIntervals.clear();
}
