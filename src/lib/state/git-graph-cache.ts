/**
 * Per-repo git-graph snapshot cache (#255, extracted in #433 / arch Finding 7).
 *
 * Previously this lived in `GitGraphView.svelte`'s module script, which forced
 * the state layer (`git-warm.ts`) to import a *component* — a layering
 * inversion. The cache is a store concern, so it lives here; the component and
 * the warmer both depend on this module, and nothing depends upward.
 *
 * PaneContainer recreates `GitGraphView` on every tab activation. Without a
 * snapshot the view re-runs `gitLog` + `gitSummary` and repaints from scratch —
 * a visible lag. A remount paints synchronously from the cached snapshot, then
 * refreshes in the background.
 *
 * Staleness (Finding 7): the cache is evicted for a repo whenever the shared
 * `git-refresh` stream reports an external (non-local) change, so a remounted
 * graph never paints history that a pull/rebase already invalidated. Local
 * mutations are handled by the mounted view, which reloads and re-caches
 * itself, so they are ignored here (mirroring the graph's own subscription).
 */

import { gitLog, type CommitInfo, type RefInfo } from "$lib/api/git-log";
import { fetchGitSummary } from "$lib/state/git-summary-cache";
import { subscribeGitChanges } from "$lib/state/git-refresh";
import { directoryKey } from "$lib/domain/path";

export const PAGE_SIZE = 300;

export interface GraphSnapshot {
  commits: CommitInfo[];
  refs: Record<string, RefInfo[]>;
  hasMore: boolean;
  headOid: string | null;
  /** Shorthand of the checked-out branch (HEAD's symbolic target), or null
   *  when detached / unborn — highlights only that branch chip (#433). */
  headBranch: string | null;
  /** True while HEAD is detached (#524). Carried through the snapshot so a
   *  remount repaints the standing indicator from cache instead of dropping
   *  it until the background refetch lands. Not derivable from `headBranch`,
   *  which is also null on an unborn branch. Optional so callers that build a
   *  snapshot by hand needn't care; absent reads as attached. */
  detached?: boolean;
  workingChanges: number;
  /** Resume cursor for the commit AFTER this snapshot's page (#431); passed
   *  to the next `gitLog` so deeper pages don't re-walk from the tips. Always
   *  corresponds to the last real commit of the stored slice. */
  nextCursor: string | null;
}

const graphCache = new Map<string, GraphSnapshot>();
const GRAPH_CACHE_MAX = 8;

/** Cache key: filtered views are cached too (#416) — keyed by their filter
 *  so a remount with the same filter paints instantly and can never flash
 *  another filter's rows (#342). The local-only (#381) and hide-remote-only
 *  (#515) toggles change what the walk seeds from, so they are part of the key
 *  too. The repo path is the segment before the first `|`, which the eviction
 *  pass relies on. */
export function snapshotKey(
  repoPath: string,
  branches: string[] | null,
  localOnly: boolean,
  hideRemoteOnly = false,
): string {
  const mode = `${localOnly ? "local" : ""}${hideRemoteOnly ? "-noremoteonly" : ""}`;
  return `${repoPath}|${mode}|${branches ? branches.join("\n") : "*"}`;
}

/** Repo path portion of a snapshot key (segment before the first `|`). */
function repoOfKey(key: string): string {
  const i = key.indexOf("|");
  return i < 0 ? key : key.slice(0, i);
}

export function getSnapshot(key: string): GraphSnapshot | undefined {
  return graphCache.get(key);
}

export function cacheSnapshot(key: string, snapshot: GraphSnapshot): void {
  graphCache.delete(key); // re-insert to refresh LRU position
  graphCache.set(key, snapshot);
  if (graphCache.size > GRAPH_CACHE_MAX) {
    const oldest = graphCache.keys().next().value;
    if (oldest !== undefined) graphCache.delete(oldest);
  }
}

/** Drop every cached snapshot (all filters/local-only variants) for a repo so
 *  the next remount refetches instead of painting stale history. */
export function evictRepoSnapshots(repoRoot: string | null): void {
  if (!repoRoot) return;
  const target = directoryKey(repoRoot);
  for (const key of graphCache.keys()) {
    if (directoryKey(repoOfKey(key)) === target) graphCache.delete(key);
  }
}

/** Fetch the page-0 data (first PAGE_SIZE commits + working summary) shared
 *  by the view's own initial load and the background warm (#287). Pass a
 *  branch subset to fetch a filtered page (#342) — never cached.
 *
 *  The log walk and the working-tree summary run CONCURRENTLY, and `onLog`
 *  (when given) fires as soon as the log half is ready: the status scan can
 *  take seconds on a large working tree but only feeds the "Uncommitted
 *  Changes (N)" row, so the graph must not wait for it (#367). */
export async function fetchPage0Snapshot(
  repoPath: string,
  branches: string[] | null = null,
  onLog?: (partial: Omit<GraphSnapshot, "workingChanges">) => void,
  localOnly = false,
  excludeBranches: string[] | null = null,
): Promise<GraphSnapshot> {
  const summaryPromise = fetchGitSummary(repoPath);
  const page = await gitLog(repoPath, {
    skip: 0,
    limit: PAGE_SIZE,
    ...(branches ? { branches } : {}),
    ...(excludeBranches ? { exclude_branches: excludeBranches } : {}),
    ...(localOnly ? { local_only: true } : {}),
  });
  const headOid =
    Object.entries(page.refs).find(([, rs]) => rs.some((r) => r.kind === "Head"))?.[0] ?? null;
  const partial = {
    commits: page.commits.slice(0, PAGE_SIZE),
    refs: page.refs,
    hasMore: page.has_more,
    headOid,
    headBranch: page.head_branch,
    // Normalized so the snapshot always holds a real boolean, even if an
    // older backend binary omits the field entirely (#524).
    detached: page.detached === true,
    nextCursor: page.next_cursor,
  };
  onLog?.(partial);
  const summary = await summaryPromise;
  const workingChanges = summary.ok
    ? summary.data.staged.length +
      summary.data.changes.length +
      summary.data.untracked.length +
      summary.data.merge.length
    : 0;
  return { ...partial, workingChanges };
}

const warmInFlight = new Set<string>();

/**
 * Best-effort background warm (#287): populate the cache for a repo before its
 * git-graph tab is ever opened, so the first open paints instantly instead of
 * showing "Loading history…". No-op if already cached or a warm for the same
 * repo is already in flight; failures are swallowed (the view still loads
 * normally when actually opened).
 */
export async function warmGraphSnapshot(repoPath: string): Promise<void> {
  const key = snapshotKey(repoPath, null, false);
  if (!repoPath || graphCache.has(key) || warmInFlight.has(repoPath)) return;
  warmInFlight.add(repoPath);
  try {
    cacheSnapshot(key, await fetchPage0Snapshot(repoPath));
  } catch {
    /* best-effort warm — ignore failures */
  } finally {
    warmInFlight.delete(repoPath);
  }
}

// Evict cached snapshots for a repo on any external git change (#433). Local
// mutations are re-cached by the mounted view itself, so they are ignored here
// (mirrors GitGraphView's own `source === "local"` filter). This subscription
// is a process-lifetime singleton, like the cache it guards.
void subscribeGitChanges((change) => {
  if (change.source === "local") return;
  evictRepoSnapshots(change.repoRoot);
});
