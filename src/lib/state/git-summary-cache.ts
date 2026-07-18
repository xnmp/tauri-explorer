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
 * Freshness after a mutation: change-driven callers (the SCM store reacting to
 * a `git-status-changed`) pass `{ force: true }` to bypass the TTL and get a
 * post-change scan, while still joining any in-flight fetch. Passive callers
 * (graph reload, commit-row selection) omit it and share whatever is fresh.
 *
 * This shares the FETCH, not any store: the per-pane `getScmStore` semantics
 * are untouched — stores still hold their own state and just route their scan
 * through here.
 */

import { gitSummary, type GitStatusSummary, type ApiResult } from "$lib/api/files";

/** How long a settled scan may be reused by a passive (non-forced) caller. */
const TTL_MS = 1500;

interface CacheEntry {
  at: number;
  result: ApiResult<GitStatusSummary>;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ApiResult<GitStatusSummary>>>();

/**
 * Fetch a repo's working-tree summary, deduped and short-TTL cached.
 *
 * @param repoPath repo root (the same string every consumer passes for a repo)
 * @param opts.force skip the TTL read (still joins an in-flight fetch) — used by
 *   change-driven callers that must observe a post-mutation scan.
 */
export async function fetchGitSummary(
  repoPath: string,
  opts?: { force?: boolean },
): Promise<ApiResult<GitStatusSummary>> {
  const key = repoPath;

  // Always share a fetch already in progress, even when forcing: a concurrent
  // scan started for the same change is exactly what a forcing caller wants.
  const flight = inFlight.get(key);
  if (flight) return flight;

  if (!opts?.force) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.result;
  }

  const p = gitSummary(repoPath)
    .then((result) => {
      cache.set(key, { at: Date.now(), result });
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
}

/** Drop a repo's cached scan (or all repos when omitted). */
export function invalidateGitSummary(repoPath?: string): void {
  if (repoPath) cache.delete(repoPath);
  else cache.clear();
}
