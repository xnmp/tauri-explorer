/**
 * Preview diff loading contracts: superseded and retargeted responses never
 * land, a redundant reload of the in-flight target is dropped (#396), a
 * re-check of the shown diff does not blank it, and a commit diff is never
 * claimed by the working-tree render cache.
 */
import { describe, expect, it, vi } from "vitest";
import type { ApiResult } from "$lib/api/common";
import { createPreviewDiff, type CommitDiffTarget } from "$lib/state/preview-diff.svelte";

const PATCH = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture() {
  const store = {
    activeDiff: null as { path: string; staged: boolean } | null,
    commitDiff: null as CommitDiffTarget | null,
  };
  const working: { args: [string, string, boolean]; reply: ReturnType<typeof deferred<ApiResult<string>>> }[] = [];
  const commits: ReturnType<typeof deferred<string>>[] = [];
  const workingDiff = vi.fn((repoRoot: string, path: string, staged: boolean) => {
    const reply = deferred<ApiResult<string>>();
    working.push({ args: [repoRoot, path, staged], reply });
    return reply.promise;
  });
  const commitFileDiff = vi.fn(() => {
    const reply = deferred<string>();
    commits.push(reply);
    return reply.promise;
  });
  const compareCommitFileDiff = vi.fn(() => {
    const reply = deferred<string>();
    commits.push(reply);
    return reply.promise;
  });
  const diff = createPreviewDiff({ current: () => store, workingDiff, commitFileDiff, compareCommitFileDiff });
  return { store, diff, working, commits, workingDiff, commitFileDiff, compareCommitFileDiff };
}

describe("working-tree diff", () => {
  it("shows a spinner, then the parsed diff of the open target", async () => {
    const f = fixture();
    f.store.activeDiff = { path: "a.ts", staged: false };
    const loading = f.diff.load("/repo", "a.ts", false);
    expect(f.diff.loading).toBe(true);
    expect(f.workingDiff).toHaveBeenCalledWith("/repo", "a.ts", false);
    f.working[0].reply.resolve({ ok: true, data: PATCH });
    await loading;
    expect(f.diff.loading).toBe(false);
    expect(f.diff.parsed?.lines.some((line) => line.kind === "add" && line.text === "new")).toBe(true);
  });

  it("drops a redundant reload of the target already in flight (#396)", async () => {
    const f = fixture();
    f.store.activeDiff = { path: "a.ts", staged: false };
    const first = f.diff.load("/repo", "a.ts", false);
    void f.diff.load("/repo", "a.ts", false);
    expect(f.workingDiff).toHaveBeenCalledTimes(1);
    f.working[0].reply.resolve({ ok: true, data: PATCH });
    await first;
    expect(f.diff.parsed).not.toBeNull();
    expect(f.diff.loading).toBe(false);
  });

  it("re-checking the shown diff keeps it on screen without a spinner", async () => {
    const f = fixture();
    f.store.activeDiff = { path: "a.ts", staged: false };
    const first = f.diff.load("/repo", "a.ts", false);
    f.working[0].reply.resolve({ ok: true, data: PATCH });
    await first;
    const shown = f.diff.parsed;
    void f.diff.load("/repo", "a.ts", false);
    expect(f.diff.parsed).toBe(shown);
    expect(f.diff.loading).toBe(false);
  });

  it("a different target blanks the old diff while it loads", async () => {
    const f = fixture();
    f.store.activeDiff = { path: "a.ts", staged: false };
    const first = f.diff.load("/repo", "a.ts", false);
    f.working[0].reply.resolve({ ok: true, data: PATCH });
    await first;
    f.store.activeDiff = { path: "a.ts", staged: true };
    void f.diff.load("/repo", "a.ts", true);
    expect(f.diff.parsed).toBeNull();
    expect(f.diff.loading).toBe(true);
  });

  it("a superseded response never lands", async () => {
    const f = fixture();
    f.store.activeDiff = { path: "a.ts", staged: false };
    const stale = f.diff.load("/repo", "a.ts", false);
    f.store.activeDiff = { path: "b.ts", staged: false };
    const fresh = f.diff.load("/repo", "b.ts", false);
    f.working[0].reply.resolve({ ok: true, data: PATCH });
    await stale;
    expect(f.diff.parsed).toBeNull();
    expect(f.diff.loading).toBe(true);
    f.working[1].reply.resolve({ ok: true, data: "" });
    await fresh;
    expect(f.diff.loading).toBe(false);
  });

  it("drops a response whose target changed while fetching", async () => {
    const f = fixture();
    f.store.activeDiff = { path: "a.ts", staged: false };
    const pending = f.diff.load("/repo", "a.ts", false);
    f.store.activeDiff = { path: "a.ts", staged: true };
    f.working[0].reply.resolve({ ok: true, data: PATCH });
    await pending;
    expect(f.diff.parsed).toBeNull();
  });

  it("surfaces a failed diff and forgets the rendered target", async () => {
    const f = fixture();
    f.store.activeDiff = { path: "a.ts", staged: false };
    const failed = f.diff.load("/repo", "a.ts", false);
    f.working[0].reply.resolve({ ok: false, error: "not a repo" });
    await failed;
    expect(f.diff.error).toBe("not a repo");
    expect(f.diff.parsed).toBeNull();
    expect(f.diff.loading).toBe(false);
  });

  it("a landed request releases its target, so a later re-check fetches and replaces it", async () => {
    const f = fixture();
    f.store.activeDiff = { path: "a.ts", staged: false };
    const first = f.diff.load("/repo", "a.ts", false);
    f.working[0].reply.resolve({ ok: true, data: PATCH });
    await first;
    const recheck = f.diff.load("/repo", "a.ts", false);
    expect(f.workingDiff).toHaveBeenCalledTimes(2);
    f.working[1].reply.resolve({ ok: true, data: PATCH.replace("+new", "+newer") });
    await recheck;
    expect(f.diff.parsed?.lines.some((line) => line.text === "newer")).toBe(true);
  });

  it("a re-check after an error blanks and shows the spinner", async () => {
    const f = fixture();
    f.store.activeDiff = { path: "a.ts", staged: false };
    const failed = f.diff.load("/repo", "a.ts", false);
    f.working[0].reply.resolve({ ok: false, error: "boom" });
    await failed;
    void f.diff.load("/repo", "a.ts", false);
    expect(f.diff.loading).toBe(true);
    expect(f.diff.error).toBeNull();
  });

  it("clear invalidates an in-flight request", async () => {
    const f = fixture();
    f.store.activeDiff = { path: "a.ts", staged: false };
    const pending = f.diff.load("/repo", "a.ts", false);
    f.diff.clear();
    f.working[0].reply.resolve({ ok: true, data: PATCH });
    await pending;
    expect(f.diff.parsed).toBeNull();
    expect(f.diff.loading).toBe(false);
  });
});

describe("commit diff", () => {
  it("uses the comparison endpoint when a base commit is given", async () => {
    const f = fixture();
    const target = { repoPath: "/repo", oid: "b", baseOid: "a", path: "a.ts" };
    f.store.commitDiff = target;
    const pending = f.diff.loadCommit(target);
    expect(f.compareCommitFileDiff).toHaveBeenCalledWith("/repo", "a", "b", "a.ts");
    f.commits[0].resolve(PATCH);
    await pending;
    expect(f.diff.parsed).not.toBeNull();
    expect(f.diff.loading).toBe(false);
  });

  it("drops the result when the routed target was replaced", async () => {
    const f = fixture();
    const target = { repoPath: "/repo", oid: "b", path: "a.ts" };
    f.store.commitDiff = target;
    const pending = f.diff.loadCommit(target);
    f.store.commitDiff = { ...target };
    f.commits[0].resolve(PATCH);
    await pending;
    expect(f.diff.parsed).toBeNull();
  });

  it("is not claimed by the working-tree cache: reopening the working diff reloads blank", async () => {
    const f = fixture();
    f.store.activeDiff = { path: "a.ts", staged: false };
    const working = f.diff.load("/repo", "a.ts", false);
    f.working[0].reply.resolve({ ok: true, data: PATCH });
    await working;

    const target = { repoPath: "/repo", oid: "b", path: "a.ts" };
    f.store.activeDiff = null;
    f.store.commitDiff = target;
    const commit = f.diff.loadCommit(target);
    f.commits[0].resolve(PATCH);
    await commit;

    f.store.commitDiff = null;
    f.store.activeDiff = { path: "a.ts", staged: false };
    void f.diff.load("/repo", "a.ts", false);
    expect(f.diff.parsed).toBeNull();
    expect(f.diff.loading).toBe(true);
  });

  it("a commit diff superseded by a working-tree load never lands", async () => {
    const f = fixture();
    const target = { repoPath: "/repo", oid: "b", path: "a.ts" };
    f.store.commitDiff = target;
    const commit = f.diff.loadCommit(target);
    f.store.commitDiff = null;
    f.store.activeDiff = { path: "a.ts", staged: false };
    void f.diff.load("/repo", "a.ts", false);
    f.commits[0].resolve(PATCH);
    await commit;
    expect(f.diff.parsed).toBeNull();
    expect(f.diff.loading).toBe(true);
  });

  it("reports a rejected commit diff as an error", async () => {
    const f = fixture();
    const target = { repoPath: "/repo", oid: "b", path: "a.ts" };
    f.store.commitDiff = target;
    const pending = f.diff.loadCommit(target);
    f.commits[0].reject(new Error("bad object"));
    await pending;
    expect(f.diff.error).toBe("bad object");
    expect(f.diff.loading).toBe(false);
  });
});
