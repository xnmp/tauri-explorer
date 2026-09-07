/** One mounted graph's history query and pagination. Refresh scheduling stays
 * with the existing reloader; the shared cache owns only complete page zero. */
import { gitLog } from "$lib/api/git-log";
import { branchWalkQuery, type BranchListEntry } from "$lib/domain/git-graph";
import { createReloader, countGraphWalkCommits } from "./git-graph-refresh";
import {
  PAGE_SIZE, snapshotKey, getSnapshot, beginSnapshotWrite, fetchPage0Snapshot, ownGraphSnapshot,
  type GraphSnapshot,
} from "./git-graph-cache";

export interface GraphQuery {
  branches: string[] | null;
  localOnly: boolean;
  hideRemoteOnly: boolean;
  filePath: string;
}

export function createGitGraphQuerySession(options: {
  repoPath: string;
  summaryConsumerId: string;
  readQuery(): GraphQuery;
  readBranches(): readonly BranchListEntry[];
  refreshBranches(): Promise<void>;
  onReload?(): void;
  onLoaded?(): void;
}, dependencies = { gitLog, getSnapshot, beginSnapshotWrite, fetchPage0Snapshot }) {
  const keyOf = (query: GraphQuery) => snapshotKey(
    options.repoPath, query.branches, query.localOnly, query.hideRemoteOnly, query.filePath,
  );
  const captureQuery = (): GraphQuery => {
    const query = options.readQuery();
    return { ...query, branches: query.branches ? [...query.branches] : null, filePath: query.filePath.trim() };
  };
  const initialQuery = captureQuery();
  let displayedKey = keyOf(initialQuery);
  const cached = dependencies.getSnapshot(displayedKey);
  let snapshot = $state.raw<GraphSnapshot>(ownGraphSnapshot(cached ?? {
    commits: [], refs: {}, hasMore: false, headOid: null, headBranch: null,
    detached: false, workingChanges: 0, nextCursor: null,
  }));
  let initialLoading = $state(false);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let disposed = false;
  let appendOwner: object | null = null;

  const reloader = createReloader(async ({ isCurrent }) => {
    const query = captureQuery();
    const key = keyOf(query);
    let accepting = true;
    const current = () => accepting && isCurrent() && key === keyOf(options.readQuery());
    initialLoading = true;
    error = null;
    let writer: ReturnType<typeof beginSnapshotWrite> | undefined;
    try {
      options.onReload?.();
      if (query.hideRemoteOnly) await options.refreshBranches();
      if (!current()) return;
      const walk = branchWalkQuery(options.readBranches(), query.branches, query.hideRemoteOnly);
      const { branches, excludeBranches } = walk;
      writer = dependencies.beginSnapshotWrite(key);
      const result = await dependencies.fetchPage0Snapshot(options.repoPath, branches, (partial) => {
        if (!current()) return;
        snapshot = ownGraphSnapshot({ ...snapshot, ...partial, walk });
        displayedKey = key;
        initialLoading = false;
      }, query.localOnly, excludeBranches, query.filePath, options.summaryConsumerId);
      if (!current()) return;
      // Pagination may already have extended the visible history while the
      // summary was pending. Only the summary belongs in that live tail.
      snapshot = ownGraphSnapshot({ ...snapshot, workingChanges: result.workingChanges });
      writer.publish({ ...result, walk });
      options.onLoaded?.();
    } catch (cause) {
      if (current()) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      writer?.dispose();
      if (current()) initialLoading = false;
      accepting = false;
    }
  });

  async function loadMore(): Promise<void> {
    if (disposed || initialLoading || loadingMore || !snapshot.hasMore) return;
    const query = captureQuery();
    const key = keyOf(query);
    if (key !== displayedKey) return;
    // Older/injected snapshots may lack the resolved exclusions. Refresh
    // their head before paging instead of silently switching Git walks.
    if (!snapshot.walk && query.hideRemoteOnly) return reload();
    const generation = reloader.generation;
    const owner = {};
    appendOwner = owner;
    const current = () => !disposed && appendOwner === owner && generation === reloader.generation && key === keyOf(options.readQuery());
    const { branches, excludeBranches } = snapshot.walk ?? branchWalkQuery([], query.branches, false);
    loadingMore = true;
    error = null;
    try {
      const useCursor = branches === null && excludeBranches === null && !query.filePath && snapshot.nextCursor !== null;
      const page = await dependencies.gitLog(options.repoPath, {
        limit: PAGE_SIZE,
        ...(useCursor ? { cursor: snapshot.nextCursor! } : { skip: countGraphWalkCommits(snapshot.commits) }),
        ...(branches ? { branches: [...branches] } : {}),
        ...(excludeBranches ? { exclude_branches: [...excludeBranches] } : {}),
        ...(query.localOnly ? { local_only: true } : {}),
        ...(query.filePath ? { file_path: query.filePath } : {}),
      });
      if (!current()) return;
      snapshot = ownGraphSnapshot({
        ...snapshot, commits: [...snapshot.commits, ...page.commits],
        refs: { ...snapshot.refs, ...page.refs }, hasMore: page.has_more, nextCursor: page.next_cursor,
      });
    } catch (cause) {
      if (current()) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (appendOwner === owner) {
        appendOwner = null;
        loadingMore = false;
      }
    }
  }

  function reload(): Promise<void> {
    if (disposed) return Promise.resolve();
    // Invalidate an append immediately, even if the existing page-zero
    // read still has a queued reload to drain. Old finally blocks cannot
    // clear a replacement's busy state.
    appendOwner = null;
    loadingMore = false;
    initialLoading = true;
    return reloader.reload();
  }

  return {
    seeded: !!cached,
    get commits() { return snapshot.commits; },
    get refs() { return snapshot.refs; },
    get hasMore() { return snapshot.hasMore; },
    get headOid() { return snapshot.headOid; },
    get headBranch() { return snapshot.headBranch; },
    get detached() { return snapshot.detached === true; },
    get workingChanges() { return snapshot.workingChanges; },
    get loading() { return initialLoading || loadingMore; },
    get loadingMore() { return loadingMore; },
    get error() { return error; },
    reload,
    loadMore,
    dispose(): void {
      disposed = true;
      appendOwner = null;
      initialLoading = false;
      loadingMore = false;
      reloader.dispose();
    },
  };
}
