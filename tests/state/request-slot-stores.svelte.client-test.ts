import { describe, expect, it, vi } from "vitest";
import { flushSync, untrack } from "svelte";
import type { BranchAuthor, CommitFile, FailedCiCheck, FailedCiCheckLog, GitRefs, OpenPr } from "$lib/api/git-log";
import { createGitGraphBranches } from "$lib/state/git-graph-branches.svelte";
import { createGitPrSession } from "$lib/state/git-pr-session.svelte";
import { createGitGraphDetail } from "$lib/state/git-graph-detail.svelte";
import { parseUnifiedDiff } from "$lib/domain/diff";

// Client-compiled: effects run for real. Store commands must not subscribe the
// effect that calls them, and each getter must notify only when its own value
// changes (not when a reload begins).

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); flushSync(); };

const pr = (number: number, ciStatus: OpenPr["ciStatus"] = "failure"): OpenPr => ({
  number, title: `PR ${number}`, headRef: `b${number}`, baseRef: "main", htmlUrl: "u",
  draft: false, ciStatus, reviewDecision: null, commentCount: 0,
});
const check: FailedCiCheck = { name: "c", runId: 1, jobId: 1 };
let repoN = 0;

function prFixture() {
  const badges: ReturnType<typeof deferred<OpenPr[]>>[] = [];
  const checks: ReturnType<typeof deferred<FailedCiCheck[]>>[] = [];
  const logs: ReturnType<typeof deferred<FailedCiCheckLog>>[] = [];
  const track = <T>(list: ReturnType<typeof deferred<T>>[]) => { const d = deferred<T>(); list.push(d); return d.promise; };
  const session = createGitPrSession(`/client-${repoN++}`, {
    openPrs: () => track(badges), failedChecks: () => track(checks), checkLog: () => track(logs),
  });
  return { session, badges, checks, logs };
}

const refs = (names: string[]): GitRefs => ({
  local_branches: names.map((name) => ({ name, target: name })),
  remote_branches: [], tags: [], head: null, head_branch: null, detached: false,
});

function branchFixture() {
  const refsCalls: ReturnType<typeof deferred<GitRefs>>[] = [];
  const authorCalls: ReturnType<typeof deferred<BranchAuthor[]>>[] = [];
  const baseCalls: ReturnType<typeof deferred<string | null>>[] = [];
  const track = <T>(list: ReturnType<typeof deferred<T>>[]) => { const d = deferred<T>(); list.push(d); return d.promise; };
  const session = createGitGraphBranches("/r", {
    refs: () => track(refsCalls), branchAuthors: () => track(authorCalls), mergeBase: () => track(baseCalls),
  });
  return { session, refsCalls, authorCalls, baseCalls };
}
const left = { name: "a", remote: false };
const right = { name: "b", remote: false };

/** Runs `body` as a tracked effect; returns how many times the effect ran. */
function runInEffect(body: () => void) {
  let runs = 0;
  const stop = $effect.root(() => { $effect(() => { runs++; body(); }); });
  flushSync();
  return { runs: () => runs, stop };
}

/** Counts notifications of each named getter, as separate effects. */
function watch<S extends object>(session: S, keys: readonly (keyof S)[]) {
  const counts = {} as Record<keyof S, number>;
  const stop = $effect.root(() => {
    for (const key of keys) {
      counts[key] = 0;
      $effect(() => { void session[key]; untrack(() => { counts[key]++; }); });
    }
  });
  flushSync();
  return { counts, stop };
}

describe("PR session reactivity", () => {
  it("GitGraphView cached remount: reloadBadges in the effect neither re-runs it nor reloads history", async () => {
    const f = prFixture();
    let hasCachedSnapshot = true;
    let historyReloads = 0;
    const effect = runInEffect(() => {
      if (hasCachedSnapshot) {
        hasCachedSnapshot = false;
        void f.session.reloadBadges();
        return;
      }
      untrack(() => { historyReloads++; });
    });
    f.badges[0].resolve([pr(1)]);
    await settle();
    expect(effect.runs()).toBe(1);
    expect(historyReloads).toBe(0);
    effect.stop();
    f.session.dispose();
  });

  it("no command subscribes the effect that calls it", async () => {
    const f = prFixture();
    const open = pr(2);
    void f.session.openDetail("o", open);
    f.checks[0].resolve([]);
    await settle();
    const target = f.session;
    const commands: [string, () => void][] = [
      ["reloadBadges", () => void target.reloadBadges()],
      ["openDetail", () => void target.openDetail("o", open)],
      ["openCheckLog", () => void target.openCheckLog(open, check)],
      ["closeCheckLog", () => target.closeCheckLog()],
      ["closeDetail", () => target.closeDetail()],
      ["dispose", () => target.dispose()],
    ];
    for (const [name, command] of commands) {
      const effect = runInEffect(command);
      await settle();
      // Settle anything the command started, then confirm it never re-ran.
      for (const d of f.badges) d.resolve([]);
      for (const d of f.checks) d.resolve([]);
      for (const d of f.logs) d.resolve({ checkName: "c", log: "" });
      await settle();
      expect(effect.runs(), name).toBe(1);
      effect.stop();
    }
  });

  it("getters notify when their value changes, not when a reload begins", async () => {
    const f = prFixture();
    const w = watch(f.session, ["prsByBranch", "failedCiChecks", "failedCiChecksLoading", "ciCheckLog", "prDetail"]);
    expect(w.counts.prsByBranch).toBe(1);

    void f.session.reloadBadges(); flushSync();
    expect(w.counts.prsByBranch).toBe(1); // begin: previous (empty) data unchanged
    f.badges[0].resolve([pr(1)]); await settle();
    expect(w.counts.prsByBranch).toBe(2);
    void f.session.reloadBadges(); flushSync();
    expect(w.counts.prsByBranch).toBe(2); // begin keeps showing the previous badges
    f.badges[1].resolve([pr(1)]); await settle();
    expect(w.counts.prsByBranch).toBe(3);

    void f.session.openDetail("o", pr(1)); flushSync();
    expect(w.counts.failedCiChecksLoading).toBe(2); // false -> true
    expect(w.counts.failedCiChecks).toBe(1); // still null while loading
    f.checks[0].resolve([check]); await settle();
    expect(w.counts.failedCiChecks).toBe(2);
    expect(w.counts.failedCiChecksLoading).toBe(3);

    void f.session.openCheckLog(pr(1), check); flushSync();
    expect(w.counts.ciCheckLog).toBe(2); // loading state
    f.logs[0].resolve({ checkName: "c", log: "x" }); await settle();
    expect(w.counts.ciCheckLog).toBe(3);
    w.stop();
    f.session.dispose();
  });
});

describe("branch metadata reactivity", () => {
  it("commands that only write do not subscribe the effect that calls them", async () => {
    const f = branchFixture();
    const s = f.session;
    const commands: [string, () => void][] = [
      ["refreshForQuery", () => void s.refreshForQuery().catch(() => {})],
      ["invalidate", () => s.invalidate()],
      ["cancelMergeBase", () => s.cancelMergeBase()],
      ["dispose", () => s.dispose()],
    ];
    for (const [name, command] of commands) {
      const effect = runInEffect(command);
      for (const d of f.refsCalls) d.resolve(refs(["a"]));
      await settle();
      expect(effect.runs(), name).toBe(1);
      effect.stop();
    }
  });

  it("entry guards the old code read reactively stay reactive, and start exactly one request", async () => {
    const f = branchFixture();
    const popover = runInEffect(() => void f.session.loadForPopover());
    await settle();
    expect(f.refsCalls).toHaveLength(1);
    expect(f.authorCalls).toHaveLength(1);
    popover.stop();

    const g = branchFixture();
    const jump = runInEffect(() => void g.session.jumpToMergeBase(left, right, async () => true));
    await settle();
    expect(g.baseCalls).toHaveLength(1);
    jump.stop();
  });

  it("getters notify when their value changes, not when a reload begins", async () => {
    const f = branchFixture();
    const w = watch(f.session, [
      "branches", "authors", "hasKnownBranches", "popoverLoaded", "popoverLoading", "popoverError",
      "mergeBaseBusy", "mergeBaseError", "mergeBaseResult",
    ]);
    void f.session.refreshForQuery(); flushSync();
    expect(w.counts.branches).toBe(1);
    expect(w.counts.hasKnownBranches).toBe(1);
    f.refsCalls[0].resolve(refs(["a"])); await settle();
    expect(w.counts.branches).toBe(2);
    expect(w.counts.hasKnownBranches).toBe(2);

    void f.session.refreshForQuery(); flushSync();
    expect(w.counts.branches).toBe(2); // begin keeps the loaded branches
    expect(w.counts.hasKnownBranches).toBe(2);
    f.refsCalls[1].reject(new Error("offline")); await settle();
    expect(w.counts.branches).toBe(2); // failed reload keeps them too
    expect(w.counts.hasKnownBranches).toBe(2);

    void f.session.loadForPopover(); flushSync();
    expect(w.counts.popoverLoading).toBe(2);
    expect(w.counts.popoverError).toBe(1);
    f.refsCalls[2].resolve(refs(["a"]));
    f.authorCalls[0].resolve([{ name: "a", author: "x", remote: false }]);
    await settle();
    expect(w.counts.popoverLoaded).toBe(2);
    expect(w.counts.popoverLoading).toBe(3);
    expect(w.counts.authors).toBe(2);

    f.session.invalidate(); flushSync();
    void f.session.jumpToMergeBase(left, right, async () => true); flushSync();
    expect(w.counts.mergeBaseBusy).toBe(2);
    expect(w.counts.mergeBaseError).toBe(1);
    expect(w.counts.mergeBaseResult).toBe(1);
    f.baseCalls[0].resolve("oid"); await settle();
    expect(w.counts.mergeBaseResult).toBe(2);
    expect(w.counts.mergeBaseBusy).toBe(3);
    w.stop();
    f.session.dispose();
  });

  it("onStart runs before the slot changes, seeing the previous error and no busy flag", async () => {
    const f = branchFixture();
    const first = f.session.jumpToMergeBase(left, right, async () => true);
    f.baseCalls[0].resolve(null);
    await first;
    expect(f.session.mergeBaseError).toBe("These branches have no common ancestor");
    const seen: unknown[] = [];
    const second = f.session.jumpToMergeBase(left, right, async () => true, () => {
      seen.push(f.session.mergeBaseBusy, f.session.mergeBaseError);
    });
    expect(seen).toEqual([false, "These branches have no common ancestor"]);
    expect(f.session.mergeBaseBusy).toBe(true);
    expect(f.session.mergeBaseError).toBeNull();
    f.baseCalls[1].resolve("oid");
    await second;
    expect(f.session.mergeBaseResult).toEqual({ first: "a", second: "b", oid: "oid" });
    vi.restoreAllMocks();
  });
});

function detailFixture() {
  const commitFiles: ReturnType<typeof deferred<CommitFile[]>>[] = [];
  const commitDiffs: ReturnType<typeof deferred<string>>[] = [];
  const track = <T>(list: ReturnType<typeof deferred<T>>[]) => { const d = deferred<T>(); list.push(d); return d.promise; };
  const unused = () => Promise.reject(new Error("unused"));
  const session = createGitGraphDetail("/d", "detail-client", {
    commitFiles: () => track(commitFiles), commitDiff: () => track(commitDiffs),
    compareFiles: unused, summary: unused, workingDiff: unused, compareDiff: unused,
    parseDiff: parseUnifiedDiff,
  });
  return { session, commitFiles, commitDiffs };
}
const graphCommit = (oid: string) => ({
  oid, short_oid: oid, parents: [], author_name: "A", author_email: "a@b.test", author_time: 1, summary: oid,
});

describe("git graph detail reactivity", () => {
  it("diff commands do not subscribe the effect that calls them", async () => {
    const f = detailFixture();
    const opening = f.session.select(graphCommit("c"));
    f.commitFiles[0].resolve([{ path: "a.ts", status: "M" }]);
    await opening;
    const commands: [string, () => void][] = [
      ["toggleDiff", () => void f.session.toggleDiff({ path: "a.ts", status: "M" })],
      ["closeDiff", () => f.session.closeDiff()],
    ];
    for (const [name, command] of commands) {
      const effect = runInEffect(command);
      for (const d of f.commitDiffs) d.resolve("line");
      await settle();
      expect(effect.runs(), name).toBe(1);
      effect.stop();
    }
    f.session.dispose();
  });

  it("getters notify when their value changes, not when a load begins", async () => {
    const f = detailFixture();
    const w = watch(f.session, ["files", "openDiff", "openDiffPath", "diffLoading", "diffError"]);
    void f.session.select(graphCommit("c")); flushSync();
    expect(w.counts.files).toBe(1); // still empty while the files load
    f.commitFiles[0].resolve([{ path: "a.ts", status: "M" }]); await settle();
    expect(w.counts.files).toBe(2);

    void f.session.toggleDiff({ path: "a.ts", status: "M" }); flushSync();
    expect(w.counts.diffLoading).toBe(2);
    expect(w.counts.openDiffPath).toBe(2);
    expect(w.counts.openDiff).toBe(1); // nothing to show yet
    f.commitDiffs[0].resolve("line"); await settle();
    expect(w.counts.openDiff).toBe(2);
    expect(w.counts.diffLoading).toBe(3);
    expect(w.counts.diffError).toBe(1);
    expect(w.counts.files).toBe(2);
    w.stop();
    f.session.dispose();
  });
});
