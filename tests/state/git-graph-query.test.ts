import { describe, expect, it, vi } from "vitest";
import { createGitGraphQuerySession, type GraphQuery } from "$lib/state/git-graph-query.svelte";
import { type GraphSnapshot, fetchPage0Snapshot, cacheSnapshot, getSnapshot, snapshotKey, evictRepoSnapshots } from "$lib/state/git-graph-cache";
import { type CommitInfo, type GitLogPage, gitLog } from "$lib/api/git-log";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const commit = (oid: string, stash?: string): CommitInfo => ({
  oid, short_oid: oid, parents: [], author_name: "Author", author_email: "a@example.com",
  author_time: 1, summary: oid, ...(stash ? { stash } : {}),
});
const snapshot = (oid: string): GraphSnapshot => ({
  commits: [commit(oid)], refs: {}, hasMore: true, headOid: oid, headBranch: "main",
  detached: false, workingChanges: 0, nextCursor: oid,
});
const page = (oid: string): GitLogPage => ({
  commits: [commit(oid)], refs: {}, has_more: true, head_branch: "main", next_cursor: oid, detached: false,
});

function fixture(seed: GraphSnapshot | null = snapshot("seed"), initialQuery: Partial<GraphQuery> = {}) {
  let query: GraphQuery = { branches: null, localOnly: false, hideRemoteOnly: false, filePath: "", ...initialQuery };
  const writes: GraphSnapshot[] = [];
  const dependencies = {
    gitLog: vi.fn<typeof gitLog>(async () => page("append")),
    getSnapshot: vi.fn(() => seed ?? undefined),
    beginSnapshotWrite: vi.fn(() => ({ publish: (value: GraphSnapshot) => { writes.push(value); return true; }, dispose: vi.fn() })),
    fetchPage0Snapshot: vi.fn<typeof fetchPage0Snapshot>(async (_repo, _branches, onLog) => {
      const result = snapshot("fresh");
      onLog?.(result);
      return result;
    }),
  };
  const session = createGitGraphQuerySession({
    repoPath: "/repo", summaryConsumerId: "test-graph",
    readQuery: () => query, readBranches: () => [], refreshBranches: async () => {},
  }, dependencies);
  return { session, dependencies, writes, setQuery: (next: Partial<GraphQuery>) => { query = { ...query, ...next }; } };
}

describe("mounted graph query", () => {
  it("cannot mutate another mounted graph through a shared cached snapshot", () => {
    const repoPath = "/shared-query-owner";
    const key = snapshotKey(repoPath, null, false);
    const seed = { ...snapshot("seed"), refs: { seed: [{ name: "main", kind: "LocalBranch" as const }] } };
    cacheSnapshot(key, seed);
    const create = () => createGitGraphQuerySession({
      repoPath, summaryConsumerId: "test", readQuery: () => ({ branches: null, localOnly: false, hideRemoteOnly: false, filePath: "" }),
      readBranches: () => [], refreshBranches: async () => {},
    });
    const first = create();
    const second = create();
    try {
      // Model a JavaScript consumer ignoring the readonly public contract.
      try { (first.commits as CommitInfo[]).push(commit("injected")); } catch {}
      try { (first.commits[0] as CommitInfo).parents.push("injected-parent"); } catch {}
      try { (first.refs.seed[0] as { name: string }).name = "injected-ref"; } catch {}
      expect(second.commits.map((row) => row.oid)).toEqual(["seed"]);
      expect(second.commits[0].parents).toEqual([]);
      expect(getSnapshot(key)?.refs.seed[0].name).toBe("main");
    } finally {
      first.dispose(); second.dispose(); evictRepoSnapshots(repoPath);
    }
  });

  it("paints cached history synchronously without starting an IPC", () => {
    const { session, dependencies } = fixture();
    expect(session.seeded).toBe(true);
    expect(session.commits.map((row) => row.oid)).toEqual(["seed"]);
    expect(dependencies.gitLog).not.toHaveBeenCalled();
    expect(dependencies.fetchPage0Snapshot).not.toHaveBeenCalled();
    session.dispose();
  });

  it("paints the log before its summary and preserves appended history when the summary arrives", async () => {
    const { session, dependencies, writes } = fixture(null);
    const summary = deferred<GraphSnapshot>();
    dependencies.fetchPage0Snapshot.mockImplementation(async (_repo, _filter, onLog) => {
      onLog?.(snapshot("first"));
      return summary.promise;
    });
    const loading = session.reload();
    expect(session.loading).toBe(false);
    expect(session.commits.map((row) => row.oid)).toEqual(["first"]);
    expect(writes).toHaveLength(0);
    await session.loadMore();
    expect(dependencies.gitLog).toHaveBeenCalledWith("/repo", { limit: 300, cursor: "first" });
    summary.resolve({ ...snapshot("first"), workingChanges: 7 });
    await loading;
    expect(session.commits.map((row) => row.oid)).toEqual(["first", "append"]);
    expect(session.workingChanges).toBe(7);
    expect(writes.map((value) => value.commits.map((row) => row.oid))).toEqual([["first"]]);
    session.dispose();
  });

  it("does not let summary completion hide an in-flight pagination spinner", async () => {
    const { session, dependencies } = fixture();
    const summary = deferred<GraphSnapshot>();
    const append = deferred<GitLogPage>();
    dependencies.fetchPage0Snapshot.mockImplementation(async (_repo, _filter, onLog) => {
      onLog?.(snapshot("first")); return summary.promise;
    });
    dependencies.gitLog.mockReturnValue(append.promise);
    const loading = session.reload();
    const paging = session.loadMore();
    summary.resolve(snapshot("first"));
    await loading;
    expect(session.loading).toBe(true);
    expect(session.loadingMore).toBe(true);
    append.resolve(page("append"));
    await paging;
    expect(session.loading).toBe(false);
    session.dispose();
  });

  it("does not publish obsolete log/summary results and drains a queued reload", async () => {
    const { session, dependencies, writes } = fixture();
    const first = deferred<GraphSnapshot>();
    let publishOld!: (value: GraphSnapshot) => void;
    dependencies.fetchPage0Snapshot.mockImplementationOnce(async (_repo, _filter, onLog) => {
      publishOld = onLog!;
      return first.promise;
    });
    const old = session.reload();
    const current = session.reload();
    publishOld(snapshot("stale"));
    expect(session.commits.map((row) => row.oid)).toEqual(["seed"]);
    first.resolve(snapshot("stale"));
    await Promise.all([old, current]);
    expect(session.commits.map((row) => row.oid)).toEqual(["fresh"]);
    expect(writes.map((value) => value.headOid)).toEqual(["fresh"]);
    session.dispose();
  });

  it("counts real commits for filtered pages and keeps local/path constraints", async () => {
    const seed = { ...snapshot("one"), commits: [commit("one"), commit("stash", "stash@{0}"), commit("two")] };
    const { session, dependencies } = fixture(seed, { branches: ["topic"], localOnly: true, filePath: " src/main.rs " });
    await session.loadMore();
    expect(dependencies.gitLog).toHaveBeenCalledWith("/repo", {
      limit: 300, skip: 2, branches: ["topic"], local_only: true, file_path: "src/main.rs",
    });
    session.dispose();
  });

  it("rejects a stale append as soon as query input changes, before its deferred reload", async () => {
    const { session, dependencies, setQuery } = fixture();
    const append = deferred<GitLogPage>();
    dependencies.gitLog.mockReturnValue(append.promise);
    const loading = session.loadMore();
    setQuery({ filePath: "different.rs" });
    append.resolve(page("stale"));
    await loading;
    expect(session.commits.map((row) => row.oid)).toEqual(["seed"]);
    session.dispose();
  });

  it("does not append a changed query to the previously displayed rows during debounce", async () => {
    const { session, dependencies, setQuery } = fixture();
    setQuery({ filePath: "new-filter.rs" });
    await session.loadMore();
    expect(dependencies.gitLog).not.toHaveBeenCalled();
    expect(session.commits.map((row) => row.oid)).toEqual(["seed"]);
    session.dispose();
  });

  it("resumes the cached resolved exclusions even before branch metadata is mounted", async () => {
    const seed = { ...snapshot("seed"), walk: { branches: null, excludeBranches: ["origin/retired"] } };
    const { session, dependencies } = fixture(seed, { hideRemoteOnly: true });
    await session.loadMore();
    expect(dependencies.gitLog).toHaveBeenCalledWith("/repo", {
      limit: 300, skip: 1, exclude_branches: ["origin/retired"],
    });
    expect(dependencies.fetchPage0Snapshot).not.toHaveBeenCalled();
    session.dispose();
  });

  it("refreshes an older hidden-remote snapshot without walk metadata before paging", async () => {
    const { session, dependencies } = fixture(snapshot("legacy"), { hideRemoteOnly: true });
    await session.loadMore();
    expect(dependencies.gitLog).not.toHaveBeenCalled();
    expect(session.commits.map((row) => row.oid)).toEqual(["fresh"]);
    await session.loadMore();
    expect(dependencies.gitLog).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("coalesces repeated scroll requests and stops paging at the final page", async () => {
    const { session, dependencies } = fixture();
    const append = deferred<GitLogPage>();
    dependencies.gitLog.mockReturnValue(append.promise);
    const loading = session.loadMore();
    await session.loadMore();
    expect(dependencies.gitLog).toHaveBeenCalledOnce();
    append.resolve({ ...page("last"), has_more: false });
    await loading;
    await session.loadMore();
    expect(dependencies.gitLog).toHaveBeenCalledOnce();
    expect(session.commits.map((row) => row.oid)).toEqual(["seed", "last"]);
    session.dispose();
  });

  it("keeps current errors retryable and rejects all publication after disposal", async () => {
    const { session, dependencies, writes } = fixture();
    dependencies.fetchPage0Snapshot.mockRejectedValueOnce(new Error("unavailable"));
    await session.reload();
    expect(session.error).toBe("unavailable");
    expect(session.loading).toBe(false);
    const later = deferred<GraphSnapshot>();
    let onLog!: (value: GraphSnapshot) => void;
    dependencies.fetchPage0Snapshot.mockImplementationOnce(async (_repo, _filter, callback) => {
      onLog = callback!; return later.promise;
    });
    const loading = session.reload();
    expect(session.error).toBeNull();
    session.dispose();
    onLog(snapshot("late"));
    later.resolve(snapshot("late"));
    await loading;
    await session.reload();
    await session.loadMore();
    expect(session.commits.map((row) => row.oid)).toEqual(["seed"]);
    expect(writes).toHaveLength(0);
    expect(session.loading).toBe(false);
  });

  it("rejects a late partial result after its page-zero operation already failed", async () => {
    const { session, dependencies } = fixture();
    let onLog!: (value: GraphSnapshot) => void;
    dependencies.fetchPage0Snapshot.mockImplementationOnce(async (_repo, _filter, callback) => {
      onLog = callback!;
      throw new Error("summary transport failed before the log settled");
    });
    await session.reload();
    onLog(snapshot("late"));
    expect(session.commits.map((row) => row.oid)).toEqual(["seed"]);
    expect(session.error).toBe("summary transport failed before the log settled");
    session.dispose();
  });

  it("keeps the replacement page spinner when a pre-reload append completes late", async () => {
    const { session, dependencies } = fixture();
    const old = deferred<GitLogPage>();
    const replacement = deferred<GitLogPage>();
    dependencies.gitLog.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    const previousLoad = session.loadMore();
    await session.reload();
    const currentLoad = session.loadMore();
    expect(session.loadingMore).toBe(true);
    old.resolve(page("stale"));
    await previousLoad;
    expect(session.loadingMore).toBe(true);
    expect(session.commits.map((row) => row.oid)).toEqual(["fresh"]);
    replacement.resolve(page("current"));
    await currentLoad;
    expect(session.commits.map((row) => row.oid)).toEqual(["fresh", "current"]);
    expect(session.loadingMore).toBe(false);
    session.dispose();
  });
});
