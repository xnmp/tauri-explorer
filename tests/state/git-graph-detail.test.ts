import { describe, expect, it, vi } from "vitest";
import type { CommitFile } from "$lib/api/git-log";
import type { ApiResult } from "$lib/api/common";
import type { GitStatusSummary } from "$lib/api/git";
import { parseUnifiedDiff } from "$lib/domain/diff";
import { createGitGraphDetail, UNCOMMITTED_OID } from "$lib/state/git-graph-detail.svelte";
import type { GraphCommit } from "$lib/state/git-graph-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const commit = (oid: string, author_time: number): GraphCommit => ({
  oid, short_oid: oid, parents: [], author_name: "A", author_email: "a@b.test",
  author_time, summary: oid,
});
const file = (path: string, status = "M"): CommitFile => ({ path, status });
const summary = (paths: string[]): GitStatusSummary => ({
  is_repo: true, repo_root: "/repo", branch: "main", detached: false,
  staged: paths.map((path) => ({ path, old_path: null, status: "Modified" })),
  changes: [], untracked: [], merge: [], op_state: "clean",
});

function fixture() {
  const commitFiles: ReturnType<typeof deferred<CommitFile[]>>[] = [];
  const compareFiles: ReturnType<typeof deferred<CommitFile[]>>[] = [];
  const summaries: ReturnType<typeof deferred<ApiResult<GitStatusSummary>>>[] = [];
  const workingDiffs: ReturnType<typeof deferred<ApiResult<string>>>[] = [];
  const commitDiffs: ReturnType<typeof deferred<string>>[] = [];
  const compareDiffs: ReturnType<typeof deferred<string>>[] = [];
  const session = createGitGraphDetail("/repo", "detail-test", {
    commitFiles: vi.fn(() => { const d = deferred<CommitFile[]>(); commitFiles.push(d); return d.promise; }),
    compareFiles: vi.fn(() => { const d = deferred<CommitFile[]>(); compareFiles.push(d); return d.promise; }),
    summary: vi.fn(() => { const d = deferred<ApiResult<GitStatusSummary>>(); summaries.push(d); return d.promise; }),
    workingDiff: vi.fn(() => { const d = deferred<ApiResult<string>>(); workingDiffs.push(d); return d.promise; }),
    commitDiff: vi.fn(() => { const d = deferred<string>(); commitDiffs.push(d); return d.promise; }),
    compareDiff: vi.fn(() => { const d = deferred<string>(); compareDiffs.push(d); return d.promise; }),
    parseDiff: parseUnifiedDiff,
  });
  return { session, commitFiles, compareFiles, summaries, workingDiffs, commitDiffs, compareDiffs };
}

describe("git graph detail session", () => {
  it("keeps only the newest selected commit files when responses reverse", async () => {
    const f = fixture();
    const old = f.session.select(commit("old", 1));
    const current = f.session.select(commit("new", 2));
    f.commitFiles[1].resolve([file("new.ts")]);
    await current;
    f.commitFiles[0].resolve([file("old.ts")]);
    await old;
    expect(f.session.selected?.oid).toBe("new");
    expect(f.session.files.map(({ path }) => path)).toEqual(["new.ts"]);
  });

  it("orders a comparison older to newer and loads its tree diff", async () => {
    const f = fixture();
    const initial = f.session.select(commit("new", 20));
    f.commitFiles[0].resolve([file("single")]);
    await initial;
    f.session.beginComparison();
    const compared = f.session.select(commit("old", 10));
    f.compareFiles[0].resolve([file("changed.ts")]);
    await compared;
    expect(f.session.comparison).toMatchObject({ older: { oid: "old" }, newer: { oid: "new" } });
    expect(f.session.files.map(({ path }) => path)).toEqual(["changed.ts"]);
  });

  it("distinguishes staged and unstaged diffs for the same path and rejects old finally", async () => {
    const f = fixture();
    const selected = f.session.select(commit(UNCOMMITTED_OID, 30));
    f.summaries[0].resolve({ ok: true, data: summary(["same.ts"]) });
    await selected;
    const staged = f.session.toggleDiff({ ...file("same.ts"), staged: true, section: "staged" });
    const unstaged = f.session.toggleDiff({ ...file("same.ts"), staged: false, section: "unstaged" });
    f.workingDiffs[0].resolve({ ok: true, data: "old" });
    await staged;
    expect(f.session.diffLoading).toBe(true);
    expect(f.session.isDiffOpen({ ...file("same.ts"), staged: false })).toBe(true);
    f.workingDiffs[1].resolve({ ok: true, data: "current" });
    await unstaged;
    expect(f.session.diffLoading).toBe(false);
    expect(f.session.openDiff?.lines[0]?.text).toBe("current");
  });

  it("returns only current diff failures and permits retry", async () => {
    const f = fixture();
    const selected = f.session.select(commit("oid", 1));
    f.commitFiles[0].resolve([file("a.ts")]);
    await selected;
    const failed = f.session.toggleDiff(file("a.ts"));
    f.commitDiffs[0].reject(new Error("diff failed"));
    await expect(failed).resolves.toBe("diff failed");
    expect(f.session.diffError).toBe("diff failed");
    expect(f.session.diffLoading).toBe(false);
    expect(f.session.openDiffPath).toBeNull();
    const retry = f.session.toggleDiff(file("a.ts"));
    f.commitDiffs[1].resolve("not a unified header");
    await expect(retry).resolves.toBeNull();
    expect(f.session.diffError).toBeNull();
    expect(f.session.openDiff?.lines[0]?.text).toBe("not a unified header");
  });

  it("does not let a same-file close and reopen accept the old error or finally", async () => {
    const f = fixture();
    const selected = f.session.select(commit("oid", 1));
    f.commitFiles[0].resolve([file("same.ts")]);
    await selected;
    const old = f.session.toggleDiff(file("same.ts"));
    f.session.closeDiff();
    const current = f.session.toggleDiff(file("same.ts"));
    f.commitDiffs[0].reject(new Error("obsolete"));
    await expect(old).resolves.toBeNull();
    expect(f.session.openDiffPath).toBe("same.ts");
    expect(f.session.diffError).toBeNull();
    expect(f.session.diffLoading).toBe(true);
    f.commitDiffs[1].resolve("current");
    await current;
    expect(f.session.openDiff?.lines[0]?.text).toBe("current");
    expect(f.session.diffLoading).toBe(false);
  });

  it("closeDiff revokes a late inline response", async () => {
    const f = fixture();
    const selected = f.session.select(commit("oid", 1));
    f.commitFiles[0].resolve([file("a.ts")]);
    await selected;
    const loading = f.session.toggleDiff(file("a.ts"));
    f.session.closeDiff();
    f.commitDiffs[0].resolve("late");
    await loading;
    expect(f.session.openDiffPath).toBeNull();
    expect(f.session.openDiff).toBeNull();
    expect(f.session.diffLoading).toBe(false);
  });

  it("a forced uncommitted refresh replaces its initial scan in the same generation", async () => {
    const f = fixture();
    const opening = f.session.select(commit(UNCOMMITTED_OID, 1));
    const token = f.session.captureSelection();
    const refreshing = f.session.refreshUncommittedFiles(token);
    f.summaries[1].resolve({ ok: true, data: summary(["fresh.ts"]) });
    await expect(refreshing).resolves.toBe(true);
    f.summaries[0].resolve({ ok: true, data: summary(["stale.ts"]) });
    await opening;
    expect(f.session.files.map(({ path }) => path)).toEqual(["fresh.ts"]);
  });

  it("preserves files and reports false when a forced refresh fails or rejects", async () => {
    const f = fixture();
    const opening = f.session.select(commit(UNCOMMITTED_OID, 1));
    f.summaries[0].resolve({ ok: true, data: summary(["kept.ts"]) });
    await opening;
    const failed = f.session.refreshUncommittedFiles();
    f.summaries[1].resolve({ ok: false, error: "scan failed" });
    await expect(failed).resolves.toBe(false);
    expect(f.session.files.map(({ path }) => path)).toEqual(["kept.ts"]);
    const rejected = f.session.refreshUncommittedFiles();
    f.summaries[2].reject(new Error("transport failed"));
    await expect(rejected).resolves.toBe(false);
    expect(f.session.files.map(({ path }) => path)).toEqual(["kept.ts"]);
  });

  it("revokes settled and pending working diffs before a post-mutation refresh", async () => {
    const f = fixture();
    const opening = f.session.select(commit(UNCOMMITTED_OID, 1));
    f.summaries[0].resolve({ ok: true, data: summary(["same.ts"]) });
    await opening;
    const settled = f.session.toggleDiff({ ...file("same.ts"), staged: true });
    f.workingDiffs[0].resolve({ ok: true, data: "old settled" });
    await settled;
    expect(f.session.openDiff).not.toBeNull();

    const firstRefresh = f.session.refreshUncommittedFiles();
    expect(f.session.openDiff).toBeNull();
    expect(f.session.openDiffPath).toBeNull();
    f.summaries[1].resolve({ ok: true, data: summary(["same.ts"]) });
    await firstRefresh;

    const pending = f.session.toggleDiff({ ...file("same.ts"), staged: true });
    const secondRefresh = f.session.refreshUncommittedFiles();
    expect(f.session.diffLoading).toBe(false);
    f.workingDiffs[1].resolve({ ok: true, data: "obsolete pending" });
    await pending;
    expect(f.session.openDiff).toBeNull();
    f.summaries[2].resolve({ ok: true, data: summary(["same.ts"]) });
    await secondRefresh;
    expect(f.session.openDiff).toBeNull();
  });

  it("does not publish an old refresh into a reopened uncommitted detail", async () => {
    const f = fixture();
    const firstOpen = f.session.select(commit(UNCOMMITTED_OID, 1));
    f.summaries[0].resolve({ ok: true, data: summary(["initial.ts"]) });
    await firstOpen;
    const oldRefresh = f.session.refreshUncommittedFiles(f.session.captureSelection());
    const normal = f.session.select(commit("normal", 2));
    f.commitFiles[0].resolve([file("normal.ts")]);
    await normal;
    const reopened = f.session.select(commit(UNCOMMITTED_OID, 3));
    f.summaries[2].resolve({ ok: true, data: summary(["reopened.ts"]) });
    await reopened;
    f.summaries[1].resolve({ ok: true, data: summary(["obsolete.ts"]) });
    await expect(oldRefresh).resolves.toBe(false);
    expect(f.session.files.map(({ path }) => path)).toEqual(["reopened.ts"]);
  });

  it("does not apply a post-mutation refresh to a replacement normal commit", async () => {
    const f = fixture();
    const opening = f.session.select(commit(UNCOMMITTED_OID, 1));
    f.summaries[0].resolve({ ok: true, data: summary(["work.ts"]) });
    await opening;
    const mutationSelection = f.session.captureSelection();
    const replacement = f.session.select(commit("normal", 2));
    await expect(f.session.refreshUncommittedFiles(mutationSelection)).resolves.toBe(false);
    expect(f.summaries).toHaveLength(1);
    f.commitFiles[0].resolve([file("normal.ts")]);
    await replacement;
    expect(f.session.files.map(({ path }) => path)).toEqual(["normal.ts"]);
  });

  it("revokes a comparison diff when exiting to the same newer commit", async () => {
    const f = fixture();
    const newer = f.session.select(commit("new", 20));
    f.commitFiles[0].resolve([file("same.ts")]);
    await newer;
    f.session.beginComparison();
    const comparison = f.session.select(commit("old", 10));
    f.compareFiles[0].resolve([file("same.ts")]);
    await comparison;
    const oldDiff = f.session.toggleDiff(file("same.ts"));
    const exiting = f.session.exitComparison();
    f.commitFiles[1].resolve([file("same.ts")]);
    await exiting;
    f.compareDiffs[0].resolve("obsolete comparison");
    await oldDiff;
    expect(f.session.openDiff).toBeNull();
    const currentDiff = f.session.toggleDiff(file("same.ts"));
    f.commitDiffs[0].resolve("normal current");
    await currentDiff;
    expect(f.session.openDiff?.lines[0]?.text).toBe("normal current");
  });

  it("retries an initial file failure after closing and reopening the commit", async () => {
    const f = fixture();
    const failed = f.session.select(commit("oid", 1));
    f.commitFiles[0].reject(new Error("first failure"));
    await failed;
    expect(f.session.files).toEqual([]);
    await f.session.select(commit("oid", 1));
    expect(f.session.selected).toBeNull();
    const retry = f.session.select(commit("oid", 1));
    f.commitFiles[1].resolve([file("recovered.ts")]);
    await retry;
    expect(f.session.files.map(({ path }) => path)).toEqual(["recovered.ts"]);
  });

  it("owns commit, file, and parsed diff values exposed to callers", async () => {
    const f = fixture();
    const input = { ...commit("owned", 1), parents: ["parent"] };
    const selecting = f.session.select(input);
    input.oid = "mutated";
    input.parents.push("mutated-parent");
    const returned = file("owned.ts");
    f.commitFiles[0].resolve([returned]);
    await selecting;
    returned.path = "mutated.ts";
    expect(f.session.selected).toMatchObject({ oid: "owned", parents: ["parent"] });
    expect(f.session.files.map(({ path }) => path)).toEqual(["owned.ts"]);
    expect(() => (f.session.selected?.parents as string[]).push("x")).toThrow();
    const diff = f.session.toggleDiff(file("owned.ts"));
    f.commitDiffs[0].resolve("line");
    await diff;
    expect(() => (f.session.openDiff?.lines as unknown[]).push({})).toThrow();
  });

  it("disposal clears state and revokes files, diffs, and finally publication", async () => {
    const f = fixture();
    const loadingFiles = f.session.select(commit("oid", 1));
    f.commitFiles[0].resolve([file("a.ts")]);
    await loadingFiles;
    const loadingDiff = f.session.toggleDiff(file("a.ts"));
    f.session.dispose();
    f.commitDiffs[0].resolve("late");
    await loadingDiff;
    expect(f.session.selected).toBeNull();
    expect(f.session.files).toEqual([]);
    expect(f.session.openDiff).toBeNull();
    expect(f.session.diffLoading).toBe(false);
  });
});
