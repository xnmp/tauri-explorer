/**
 * Shared per-repo working-tree summary fetch (#431).
 *
 * `gitSummary` (the `git_status` command) is a full working-tree scan —
 * "seconds on a large working tree" per the backend's own comment. Before this
 * module every consumer scanned independently: on a single `git-status-changed`
 * the SCM panel refreshed its summary AND the git-graph reloaded (each a full
 * scan), so one file save cost several redundant scans per window.
 *
 * This module funnels those consumers through ONE fetch per repo with:
 *  - in-flight dedup: concurrent callers for the same repo await the SAME
 *    promise (never two scans in parallel), generalizing the badge dedup
 *    from #426 across stores;
 *  - a short TTL: a caller arriving shortly after a scan settled reuses its
 *    result instead of re-scanning. The window only needs to span one logical
 *    refresh (the graph's watcher reload is debounced ~300ms after the SCM
 *    store's), so it is deliberately brief.
 *
 * Freshness after a mutation (the staleness fix, #445): change-driven callers
 * (the SCM store reacting to a `git-status-changed` after a stage/commit) pass
 * `{ force: true }` to observe a scan that reflects the POST-mutation tree. A
 * force must therefore NOT adopt a scan that began before it — in particular a
 * passive scan that started reading the tree BEFORE the mutation would return
 * stale counts. The `forced` flag on an in-flight scan is its generation
 * marker: a forced scan belongs to the current post-mutation generation, a
 * passive scan is pre-mutation and unsafe for a force to adopt.
 *
 *  - a passive caller may join whatever scan is currently in flight (forced or
 *    not), or, failing that, reuse a settled scan within the TTL;
 *  - a FORCE joins an in-flight scan ONLY if that scan is itself force-
 *    originated — so genuinely-concurrent forced callers reacting to the same
 *    mutation share one fresh scan instead of stampeding the backend, while a
 *    force arriving over a pre-mutation passive scan starts its own fresh scan
 *    and observes post-mutation state (the passive scan keeps its own result).
 *
 * Passive callers (graph reload, commit-row selection) omit `force` and share
 * whatever is fresh.
 *
 * This shares the FETCH, not any store: the per-pane `getScmStore` semantics
 * are untouched — stores still hold their own state and just route their scan
 * through here.
 */

import {
  cancelGitStatus,
  gitSummary,
  type GitStatusSummary,
  type ApiResult,
} from "$lib/api/files";

/** How long a settled scan may be reused by a passive (non-forced) caller. */
const TTL_MS = 1500;

interface CacheEntry {
  at: number;
  result: ApiResult<GitStatusSummary>;
}

interface FlightEntry {
  promise: Promise<ApiResult<GitStatusSummary>>;
  taskId: number;
  /** Whether this scan was started by a `force` call (known post-mutation). */
  forced: boolean;
  consumers: Set<string>;
  hasUnownedConsumer: boolean;
  cancelled: boolean;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, FlightEntry>();
const allFlights = new Map<string, Set<FlightEntry>>();

/**
 * Fetch a repo's working-tree summary, deduped and short-TTL cached.
 *
 * @param repoPath repo root (the same string every consumer passes for a repo)
 * @param opts.force observe a POST-mutation scan: bypass the TTL and refuse to
 *   adopt a pre-mutation (passive) scan already in flight. A fresh scan is
 *   begun unless a concurrent force is already scanning, in which case that one
 *   is shared. Used by change-driven callers after a stage/commit.
 */
export async function fetchGitSummary(
  repoPath: string,
  opts?: { force?: boolean; consumerId?: string },
): Promise<ApiResult<GitStatusSummary>> {
  const key = repoPath;
  const force = opts?.force ?? false;
  const flight = inFlight.get(key);

  if (force) {
    // Adopt an in-flight scan only if it too is post-mutation (a concurrent
    // force); never adopt a pre-mutation passive scan.
    if (flight?.forced) {
      addConsumer(flight, opts?.consumerId);
      return flight.promise;
    }
    return startScan(key, true, opts?.consumerId);
  }

  // Passive caller: any in-flight scan is good enough to share.
  if (flight) {
    addConsumer(flight, opts?.consumerId);
    return flight.promise;
  }

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.result;

  return startScan(key, false, opts?.consumerId);
}

function startScan(
  key: string,
  forced: boolean,
  consumerId?: string,
): Promise<ApiResult<GitStatusSummary>> {
  const taskId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  const flight = {
    taskId,
    forced,
    consumers: new Set<string>(),
    hasUnownedConsumer: false,
    cancelled: false,
  } as FlightEntry;
  addConsumer(flight, consumerId);
  const promise = gitSummary(key, taskId)
    .then((result) => {
      if (!flight.cancelled) cache.set(key, { at: Date.now(), result });
      return result;
    })
    .finally(() => {
      // Only clear the slot if it is still ours: a force may have replaced a
      // pre-mutation passive scan with a newer forced one.
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
      const flights = allFlights.get(key);
      flights?.delete(flight);
      if (flights?.size === 0) allFlights.delete(key);
    });
  flight.promise = promise;
  inFlight.set(key, flight);
  const flights = allFlights.get(key) ?? new Set<FlightEntry>();
  flights.add(flight);
  allFlights.set(key, flights);
  return promise;
}

function addConsumer(flight: FlightEntry, consumerId?: string): void {
  if (consumerId) flight.consumers.add(consumerId);
  else flight.hasUnownedConsumer = true;
}

/**
 * Release a pane from every summary scan it joined. A scan shared with
 * another pane (or an ownerless graph/cache caller) remains alive.
 */
export function releaseGitSummaryConsumer(consumerId: string): void {
  for (const [key, flights] of allFlights) {
    for (const flight of flights) {
      flight.consumers.delete(consumerId);
      if (
        !flight.cancelled
        && flight.consumers.size === 0
        && !flight.hasUnownedConsumer
      ) {
        flight.cancelled = true;
        if (inFlight.get(key) === flight) inFlight.delete(key);
        void cancelGitStatus(flight.taskId);
      }
    }
  }
}

/** Drop a repo's cached scan (or all repos when omitted). */
export function invalidateGitSummary(repoPath?: string): void {
  if (repoPath) cache.delete(repoPath);
  else cache.clear();
}
