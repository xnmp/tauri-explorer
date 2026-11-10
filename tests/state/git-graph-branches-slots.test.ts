import { describe, expect, it, vi } from "vitest";
import type { BranchAuthor, GitRefs } from "$lib/api/git-log";
import { createGitGraphBranches } from "$lib/state/git-graph-branches.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const refs = (local: string[]): GitRefs => ({
  local_branches: local.map((name) => ({ name, target: name })),
  remote_branches: [], tags: [], head: null, head_branch: null, detached: false,
});
const names = (session: { branches: readonly { name: string }[] }) => session.branches.map((b) => b.name);

function fixture() {
  const refsRequests: ReturnType<typeof deferred<GitRefs>>[] = [];
  const authorRequests: ReturnType<typeof deferred<BranchAuthor[]>>[] = [];
  const baseRequests: ReturnType<typeof deferred<string | null>>[] = [];
  const session = createGitGraphBranches("/repo", {
    refs: vi.fn(() => { const r = deferred<GitRefs>(); refsRequests.push(r); return r.promise; }),
    branchAuthors: vi.fn(() => { const r = deferred<BranchAuthor[]>(); authorRequests.push(r); return r.promise; }),
    mergeBase: vi.fn(() => { const r = deferred<string | null>(); baseRequests.push(r); return r.promise; }),
  });
  return { session, refsRequests, authorRequests, baseRequests };
}

const left = { name: "left", remote: false };
const right = { name: "right", remote: false };

async function loaded(f: ReturnType<typeof fixture>, local: string[]) {
  const load = f.session.refreshForQuery();
  f.refsRequests[f.refsRequests.length - 1].resolve(refs(local));
  await load;
}

describe("branch refs slot", () => {
  it("ignores a superseded refs result and keeps the newest", async () => {
    const f = fixture();
    const first = f.session.refreshForQuery();
    const second = f.session.refreshForQuery();
    f.refsRequests[1].resolve(refs(["new"]));
    await second;
    f.refsRequests[0].resolve(refs(["old"]));
    await first.catch(() => {});
    expect(names(f.session)).toEqual(["new"]);
    expect(f.session.hasKnownBranches).toBe(true);
  });

  it("keeps old branches and known coverage when a reload fails", async () => {
    const f = fixture();
    await loaded(f, ["main"]);
    const retry = f.session.refreshForQuery();
    f.refsRequests[1].reject(new Error("offline"));
    await retry;
    expect(names(f.session)).toEqual(["main"]);
    expect(f.session.hasKnownBranches).toBe(true);
  });

  it("drops an invalidated in-flight result but keeps loaded data", async () => {
    const f = fixture();
    await loaded(f, ["main"]);
    const reload = f.session.refreshForQuery();
    f.session.invalidate();
    f.refsRequests[1].resolve(refs(["other"]));
    await expect(reload).rejects.toThrow("superseded");
    expect(names(f.session)).toEqual(["main"]);
    expect(f.session.hasKnownBranches).toBe(true);
  });

  it("a request begun after invalidate is live", async () => {
    const f = fixture();
    const stale = f.session.refreshForQuery();
    f.session.invalidate();
    const fresh = f.session.refreshForQuery();
    f.refsRequests[1].resolve(refs(["fresh"]));
    await fresh;
    f.refsRequests[0].resolve(refs(["stale"]));
    await stale.catch(() => {});
    expect(names(f.session)).toEqual(["fresh"]);
  });

  it("disposal mid-flight ignores the late result and clears data", async () => {
    const f = fixture();
    await loaded(f, ["main"]);
    const reload = f.session.refreshForQuery();
    f.session.dispose();
    f.refsRequests[1].resolve(refs(["late"]));
    await reload;
    expect(f.session.branches).toEqual([]);
    expect(f.session.hasKnownBranches).toBe(false);
  });
});

describe("branch authors and popover slots", () => {
  it("keeps authors when a reload fails, and surfaces the error then recovers on retry", async () => {
    const f = fixture();
    const first = f.session.loadForPopover();
    f.refsRequests[0].resolve(refs(["main"]));
    f.authorRequests[0].resolve([{ name: "main", author: "ann", remote: false }]);
    await first;
    expect(f.session.popoverLoaded).toBe(true);
    expect(f.session.authors.get("main")).toBe("ann");

    f.session.invalidate();
    expect(f.session.popoverLoaded).toBe(false);
    expect(f.session.authors.get("main")).toBe("ann");

    const failing = f.session.loadForPopover();
    expect(f.session.popoverLoading).toBe(true);
    f.refsRequests[1].resolve(refs(["main"]));
    f.authorRequests[1].reject(new Error("authors down"));
    await failing;
    expect(f.session.popoverError).toBe("authors down");
    expect(f.session.popoverLoading).toBe(false);
    expect(f.session.popoverLoaded).toBe(false);
    expect(f.session.authors.get("main")).toBe("ann");

    const retry = f.session.loadForPopover();
    expect(f.session.popoverError).toBeNull();
    f.refsRequests[2].resolve(refs(["main"]));
    f.authorRequests[2].resolve([{ name: "main", author: "bob", remote: false }]);
    await retry;
    expect(f.session.popoverLoaded).toBe(true);
    expect(f.session.popoverError).toBeNull();
    expect(f.session.authors.get("main")).toBe("bob");
  });

  it("invalidate during a popover load leaves nothing loading and ignores late results", async () => {
    const f = fixture();
    const load = f.session.loadForPopover();
    f.session.invalidate();
    expect(f.session.popoverLoading).toBe(false);
    f.refsRequests[0].resolve(refs(["late"]));
    f.authorRequests[0].resolve([{ name: "late", author: "x", remote: false }]);
    await load;
    expect(f.session.popoverLoaded).toBe(false);
    expect(f.session.popoverLoading).toBe(false);
    expect(f.session.popoverError).toBeNull();
    expect(f.session.authors.size).toBe(0);
  });

  it("disposal mid popover load ignores late results", async () => {
    const f = fixture();
    const load = f.session.loadForPopover();
    f.session.dispose();
    f.refsRequests[0].resolve(refs(["late"]));
    f.authorRequests[0].resolve([{ name: "late", author: "x", remote: false }]);
    await load;
    expect(f.session.popoverLoaded).toBe(false);
    expect(f.session.popoverLoading).toBe(false);
    expect(f.session.authors.size).toBe(0);
    expect(f.session.branches).toEqual([]);
  });
});

describe("popover entry guard", () => {
  it("does not start a second load while loading or once loaded", async () => {
    const f = fixture();
    const first = f.session.loadForPopover();
    await f.session.loadForPopover();
    expect(f.refsRequests).toHaveLength(1);
    f.refsRequests[0].resolve(refs(["main"]));
    f.authorRequests[0].resolve([]);
    await first;
    expect(f.session.popoverLoaded).toBe(true);
    await f.session.loadForPopover();
    expect(f.refsRequests).toHaveLength(1);
    expect(f.authorRequests).toHaveLength(1);
    expect(f.session.popoverLoaded).toBe(true);
  });
});

describe("merge-base slot", () => {
  it("cancel mid-lookup clears busy and ignores the late result", async () => {
    const f = fixture();
    const reveal = vi.fn(async () => true);
    const jump = f.session.jumpToMergeBase(left, right, reveal);
    expect(f.session.mergeBaseBusy).toBe(true);
    f.session.cancelMergeBase();
    expect(f.session.mergeBaseBusy).toBe(false);
    f.baseRequests[0].resolve("fork");
    await jump;
    expect(reveal).not.toHaveBeenCalled();
    expect(f.session.mergeBaseResult).toBeNull();
    expect(f.session.mergeBaseError).toBeNull();
  });

  it("cancel mid-reveal ignores the late reveal and never reports settled", async () => {
    const f = fixture();
    const revealing = deferred<boolean>();
    let wasCurrent = true;
    const onSettled = vi.fn();
    const jump = f.session.jumpToMergeBase(left, right, async (_oid, isCurrent) => {
      const ok = await revealing.promise;
      wasCurrent = isCurrent();
      return ok;
    }, undefined, onSettled);
    f.baseRequests[0].resolve("fork");
    await Promise.resolve();
    expect(f.session.mergeBaseBusy).toBe(true);
    f.session.cancelMergeBase();
    revealing.resolve(true);
    await jump;
    expect(wasCurrent).toBe(false);
    expect(f.session.mergeBaseBusy).toBe(false);
    expect(f.session.mergeBaseResult).toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("publishes the result and settles once, then allows a new lookup", async () => {
    const f = fixture();
    const onSettled = vi.fn();
    const jump = f.session.jumpToMergeBase(left, right, async () => true, undefined, onSettled);
    f.baseRequests[0].resolve("fork");
    await jump;
    expect(f.session.mergeBaseResult).toEqual({ first: "left", second: "right", oid: "fork" });
    expect(f.session.mergeBaseBusy).toBe(false);
    expect(onSettled).toHaveBeenCalledWith(true);
    const again = f.session.jumpToMergeBase(left, right, async () => false);
    expect(f.session.mergeBaseResult).toBeNull();
    f.baseRequests[1].resolve("fork");
    await again;
    expect(f.session.mergeBaseError).toMatch(/Could not reveal/);
    expect(f.session.mergeBaseResult).toBeNull();
  });

  it("reports a missing ancestor and a lookup failure", async () => {
    const f = fixture();
    const none = f.session.jumpToMergeBase(left, right, async () => true);
    f.baseRequests[0].resolve(null);
    await none;
    expect(f.session.mergeBaseError).toBe("These branches have no common ancestor");
    const fail = f.session.jumpToMergeBase(left, right, async () => true);
    f.baseRequests[1].reject(new Error("git exploded"));
    await fail;
    expect(f.session.mergeBaseError).toBe("git exploded");
  });

  it("disposal mid-lookup ignores the late result", async () => {
    const f = fixture();
    const reveal = vi.fn(async () => true);
    const onSettled = vi.fn();
    const jump = f.session.jumpToMergeBase(left, right, reveal, undefined, onSettled);
    f.session.dispose();
    f.baseRequests[0].resolve("fork");
    await jump;
    expect(reveal).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    expect(f.session.mergeBaseBusy).toBe(false);
    expect(f.session.mergeBaseResult).toBeNull();
  });

  it("rejects a second lookup while one is in flight", async () => {
    const f = fixture();
    void f.session.jumpToMergeBase(left, right, async () => true);
    await f.session.jumpToMergeBase(left, right, async () => true);
    expect(f.baseRequests).toHaveLength(1);
  });
});
