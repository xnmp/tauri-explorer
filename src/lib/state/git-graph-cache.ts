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
 * a visible lag. A remount paints synchronously from an observed snapshot.
 * Its observation lease survives the component, and starts before the read.
 *
 * Every Git change invalidates snapshots and outstanding writer tokens for
 * that repository. Local actions may originate from another surface while
 * the graph is hidden, so they must invalidate history too.
 */

import { gitLog, type CommitInfo, type RefInfo } from "$lib/api/git-log";
import { fetchGitSummary } from "$lib/state/git-summary-cache";
import { subscribeGitChanges } from "$lib/state/git-refresh";
import { directoryKey } from "$lib/domain/path";
import { E2E_HOOKS_ENABLED } from "$lib/domain/e2e-hooks";
import { gitGraphCoverage, type GraphCoverageLease } from "./git-graph-coverage";

export const PAGE_SIZE = 300;

export type GraphCommit = Readonly<Omit<CommitInfo, "parents">> & { readonly parents: readonly string[] };
export type GraphRefs = Readonly<Record<string, readonly Readonly<RefInfo>[]>>;
export interface GraphWalk {
  readonly branches: readonly string[] | null;
  readonly excludeBranches: readonly string[] | null;
}

export interface GraphSnapshot {
  /** Resolved seed/exclusion set that produced these rows. Pagination must
   *  retain it even when the branch popover has not loaded after a remount. */
  readonly walk?: GraphWalk;
  readonly commits: readonly GraphCommit[];
  readonly refs: GraphRefs;
  readonly hasMore: boolean;
  readonly headOid: string | null;
  /** Shorthand of the checked-out branch (HEAD's symbolic target), or null
   *  when detached / unborn — highlights only that branch chip (#433). */
  readonly headBranch: string | null;
  /** True while HEAD is detached (#524). Carried through the snapshot so a
   *  remount repaints the standing indicator from cache instead of dropping
   *  it until the background refetch lands. Not derivable from `headBranch`,
   *  which is also null on an unborn branch. Optional so callers that build a
   *  snapshot by hand needn't care; absent reads as attached. */
  readonly detached?: boolean;
  readonly workingChanges: number;
  /** False means the summary failed/cancelled; display history but do not retain it as a complete snapshot. */
  readonly summaryReady?: boolean;
  /** Resume cursor for the commit AFTER this snapshot's page (#431); passed
   *  to the next `gitLog` so deeper pages don't re-walk from the tips. Always
   *  corresponds to the last real commit of the stored slice. */
  readonly nextCursor: string | null;
}

// Share immutable page-zero payloads across mounts. Ownership is established
// once on ingress; getters never clone large histories on the render path.
const ownedSnapshots = new WeakSet<GraphSnapshot>();
export function ownGraphSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  if (ownedSnapshots.has(snapshot)) return snapshot;
  const commits = Object.freeze(snapshot.commits.map((commit) =>
    Object.isFrozen(commit) && Object.isFrozen(commit.parents) ? commit
      : Object.freeze({ ...commit, parents: Object.freeze([...commit.parents]) }),
  ));
  const refs = Object.freeze(Object.fromEntries(Object.entries(snapshot.refs).map(([oid, values]) =>
    [oid, Object.freeze(values.map((ref) => Object.isFrozen(ref) ? ref : Object.freeze({ ...ref })))],
  )));
  const walk = snapshot.walk ? Object.freeze({
    branches: snapshot.walk.branches === null ? null : Object.freeze([...snapshot.walk.branches]),
    excludeBranches: snapshot.walk.excludeBranches === null ? null : Object.freeze([...snapshot.walk.excludeBranches]),
  }) : undefined;
  const owned = Object.freeze({ ...snapshot, commits, refs, ...(walk ? { walk } : {}) });
  ownedSnapshots.add(owned);
  return owned;
}

const graphCache = new Map<string, { snapshot: GraphSnapshot; coverage: GraphCoverageLease }>();
// Only outstanding writers occupy this map: invalidation needs no permanent
// per-path epoch table. Replacing a token also prevents an older warm from
// overwriting a newer visible reload for the same query.
const writers = new Map<string, { coverage: GraphCoverageLease; covered: boolean }>();
const warmInFlight = new Map<string, Promise<void>>();
// The high-load tab fan-out opens 12 distinct graphs. Keep modest headroom so
// returning to any of those tabs paints its last snapshot synchronously rather
// than forcing a fresh git log during the switch.
const GRAPH_CACHE_MAX = 16;

function publishCacheProbe(): void {
  if (!E2E_HOOKS_ENABLED || typeof document === "undefined") return;
  document.documentElement.dataset.e2eGraphSnapshots = JSON.stringify(
    [...graphCache].map(([key, value]) => ({ key, headOid: value.snapshot.headOid })),
  );
}

/** Cache key: filtered views are cached too (#416) — keyed by their filter
 *  so a remount with the same filter paints instantly and can never flash
 *  another filter's rows (#342). The local-only (#381) and hide-remote-only
 *  (#515) toggles change what the walk seeds from, so they are part of the key
 *  too. A structured tuple keeps path characters distinct from key syntax. */
export function snapshotKey(
  repoPath: string,
  branches: readonly string[] | null,
  localOnly: boolean,
  hideRemoteOnly = false,
  filePath = "",
): string {
  return JSON.stringify([directoryKey(repoPath), branches, localOnly, hideRemoteOnly, filePath.trim()]);
}

/** Keys are private structured tuples; path characters cannot act as syntax. */
function repoOfKey(key: string): string {
  return (JSON.parse(key) as [string])[0];
}

export function getSnapshot(key: string): GraphSnapshot | undefined {
  const entry = graphCache.get(key);
  if (entry) {
    graphCache.delete(key);
    graphCache.set(key, entry);
  }
  return entry?.snapshot;
}

function dropSnapshot(key: string): void {
  const previous = graphCache.get(key);
  graphCache.delete(key);
  previous?.coverage.release();
}

/** Capture before starting an async read; dispose in its finally block.
 * Publication succeeds only while this is still the current, valid writer. */
export function beginSnapshotWrite(key: string, repoPath: string) {
  if (repoOfKey(key) !== directoryKey(repoPath)) throw new Error("Graph snapshot coverage must match its repository");
  const coverage = gitGraphCoverage.retain(repoPath);
  const token = { coverage, covered: false };
  writers.get(key)?.coverage.release();
  writers.set(key, token);
  return {
    ready: coverage.ready.then((covered) => {
      token.covered = covered && writers.get(key) === token;
      return token.covered;
    }),
    publish(snapshot: GraphSnapshot): boolean {
      if (!token.covered || snapshot.summaryReady === false || writers.get(key) !== token) return false;
      const owned = ownGraphSnapshot(snapshot);
      writers.delete(key);
      dropSnapshot(key);
      // Transfer this writer's lease to the retained entry without a gap.
      graphCache.set(key, { snapshot: owned, coverage });
      if (graphCache.size > GRAPH_CACHE_MAX) {
        const oldest = graphCache.keys().next().value;
        if (oldest !== undefined) dropSnapshot(oldest);
      }
      publishCacheProbe();
      return true;
    },
    dispose(): void {
      if (writers.get(key) === token) {
        writers.delete(key);
        coverage.release();
      }
    },
  };
}

/** Drop every cached snapshot (all filters/local-only variants) for a repo so
 *  the next remount refetches instead of painting stale history. */
export function evictRepoSnapshots(repoRoot: string | null): void {
  if (!repoRoot) return;
  const target = directoryKey(repoRoot);
  const keys = new Set([...graphCache.keys(), ...writers.keys(), ...warmInFlight.keys()]);
  for (const key of keys) {
    if (repoOfKey(key) !== target) continue;
    dropSnapshot(key);
    writers.get(key)?.coverage.release();
    writers.delete(key);
    warmInFlight.delete(key);
  }
  publishCacheProbe();
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
  filePath = "",
  consumerId?: string,
): Promise<GraphSnapshot> {
  const walk = {
    branches: branches === null ? null : [...branches],
    excludeBranches: excludeBranches === null ? null : [...excludeBranches],
  };
  const summaryPromise = fetchGitSummary(repoPath, { consumerId });
  const logPromise = gitLog(repoPath, {
    skip: 0,
    limit: PAGE_SIZE,
    ...(walk.branches ? { branches: walk.branches } : {}),
    ...(walk.excludeBranches ? { exclude_branches: walk.excludeBranches } : {}),
    ...(localOnly ? { local_only: true } : {}),
    ...(filePath.trim() ? { file_path: filePath.trim() } : {}),
  }).then((page) => {
    const headOid =
      Object.entries(page.refs).find(([, rs]) => rs.some((r) => r.kind === "Head"))?.[0] ?? null;
    const partial = {
      walk,
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
    return partial;
  });
  const [partial, summary] = await Promise.all([logPromise, summaryPromise]);
  const workingChanges = summary.ok
    ? summary.data.staged.length +
      summary.data.changes.length +
      summary.data.untracked.length +
      summary.data.merge.length
    : 0;
  return { ...partial, workingChanges, summaryReady: summary.ok };
}

/**
 * Best-effort background warm (#287): populate the cache for a repo before its
 * git-graph tab is ever opened, so the first open paints instantly instead of
 * showing "Loading history…". No-op if already cached or a warm for the same
 * repo is already in flight; failures are swallowed (the view still loads
 * normally when actually opened).
 */
export function warmGraphSnapshot(repoPath: string, consumerId?: string): Promise<void> {
  const key = snapshotKey(repoPath, null, false);
  if (!repoPath || graphCache.has(key)) return Promise.resolve();
  const existing = warmInFlight.get(key);
  if (existing) return existing;
  const writer = beginSnapshotWrite(key, repoPath);
  const task = writer.ready.then(async (covered) => {
      if (!covered) return;
      const snapshot = await fetchPage0Snapshot(repoPath, null, undefined, false, null, "", consumerId);
      writer.publish(snapshot);
    })
    .catch(() => { /* best-effort warm; opening the view can retry */ })
    .finally(() => {
      writer.dispose();
      if (warmInFlight.get(key) === task) warmInFlight.delete(key);
    });
  warmInFlight.set(key, task);
  return task;
}

// Cache lifetime is process-wide, so its invalidation subscription is too.
// This only invalidates storage; mounted views retain their shared refresh policy.
void subscribeGitChanges((change) => {
  evictRepoSnapshots(change.repoRoot);
});
