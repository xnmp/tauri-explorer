import { describe, expect, it, vi } from "vitest";
import type { BranchAuthor, GitRefs } from "$lib/api/git-log";
import { createGitGraphBranches } from "$lib/state/git-graph-branches.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const refs = (local: string[], remote: string[] = []): GitRefs => ({
  local_branches: local.map((name) => ({ name, target: name })),
  remote_branches: remote.map((name) => ({ name, target: name })),
  tags: [],
  head: null,
  head_branch: null,
  detached: false,
});

function fixture() {
  const refsRequests: ReturnType<typeof deferred<GitRefs>>[] = [];
  const authorRequests: ReturnType<typeof deferred<BranchAuthor[]>>[] = [];
  const dependencies = {
    refs: vi.fn(() => {
      const request = deferred<GitRefs>();
      refsRequests.push(request);
      return request.promise;
    }),
    branchAuthors: vi.fn(() => {
      const request = deferred<BranchAuthor[]>();
      authorRequests.push(request);
      return request.promise;
    }),
  };
  return {
    session: createGitGraphBranches("/repo", dependencies),
    refsRequests,
    authorRequests,
  };
}

describe("git graph branch metadata", () => {
  it("rejects a cold refs failure before a filtered query can use empty coverage", async () => {
    const f = fixture();
    const loading = f.session.refreshForQuery();
    f.refsRequests[0].reject(new Error("refs unavailable"));

    await expect(loading).rejects.toThrow("refs unavailable");
    expect(f.session.hasKnownBranches).toBe(false);
    expect(f.session.branches).toEqual([]);
  });

  it("retains known branch coverage when a later refresh fails", async () => {
    const f = fixture();
    const first = f.session.refreshForQuery();
    f.refsRequests[0].resolve(refs(["main"], ["origin/topic"]));
    await first;
    const retry = f.session.refreshForQuery();
    f.refsRequests[1].reject(new Error("offline"));

    await expect(retry).resolves.toBeUndefined();
    expect(f.session.hasKnownBranches).toBe(true);
    expect(f.session.branches).toEqual([
      { name: "main", remote: false },
      { name: "origin/topic", remote: true },
    ]);
  });

  it("does not let reversed ref responses replace newer coverage", async () => {
    const f = fixture();
    const older = f.session.refreshForQuery();
    const newer = f.session.refreshForQuery();
    f.refsRequests[1].resolve(refs(["new"]));
    await newer;
    f.refsRequests[0].resolve(refs(["old"]));
    await older;

    expect(f.session.branches.map(({ name }) => name)).toEqual(["new"]);
  });

  it("waits for replacement coverage instead of publishing an obsolete query response", async () => {
    const f = fixture();
    const older = f.session.refreshForQuery();
    const newer = f.session.refreshForQuery();
    f.refsRequests[0].resolve(refs(["obsolete"]));
    await Promise.resolve();
    expect(f.session.hasKnownBranches).toBe(false);
    expect(f.session.branches).toEqual([]);

    f.refsRequests[1].resolve(refs(["current"]));
    await Promise.all([older, newer]);
    expect(f.session.branches.map(({ name }) => name)).toEqual(["current"]);
  });

  it("drains a newer popover refresh even when older coverage is already known", async () => {
    const f = fixture();
    const seed = f.session.refreshForQuery();
    f.refsRequests[0].resolve(refs(["seed"]));
    await seed;

    const query = f.session.refreshForQuery();
    const popover = f.session.loadForPopover();
    f.refsRequests[1].resolve(refs(["obsolete"]));
    await Promise.resolve();
    expect(f.session.branches.map(({ name }) => name)).toEqual(["seed"]);
    f.authorRequests[0].resolve([{ name: "current", author: "Ada", remote: false }]);
    f.refsRequests[2].resolve(refs(["current"]));
    await Promise.all([query, popover]);

    expect(f.session.branches.map(({ name }) => name)).toEqual(["current"]);
  });

  it("loads refs and authors lazily and exposes popover failures without rejecting", async () => {
    const f = fixture();
    expect(f.refsRequests).toHaveLength(0);
    expect(f.authorRequests).toHaveLength(0);
    const loading = f.session.loadForPopover();
    expect(f.session.popoverLoading).toBe(true);
    f.refsRequests[0].resolve(refs(["main"]));
    f.authorRequests[0].reject(new Error("authors unavailable"));
    await expect(loading).resolves.toBeUndefined();

    expect(f.session.popoverLoaded).toBe(false);
    expect(f.session.popoverLoading).toBe(false);
    expect(f.session.popoverError).toBe("authors unavailable");
    expect(f.session.branches.map(({ name }) => name)).toEqual(["main"]);
    expect([...f.session.authors]).toEqual([]);

    const retry = f.session.loadForPopover();
    f.refsRequests[1].resolve(refs(["main"]));
    f.authorRequests[1].resolve([{ name: "main", author: "Ada", remote: false }]);
    await retry;
    expect(f.session.popoverLoaded).toBe(true);
    expect(f.session.popoverError).toBeNull();
    expect([...f.session.authors]).toEqual([["main", "Ada"]]);
  });

  it("does not surface an obsolete popover refs failure over newer query coverage", async () => {
    const f = fixture();
    const popover = f.session.loadForPopover();
    const query = f.session.refreshForQuery();
    f.refsRequests[1].resolve(refs(["current"]));
    await query;
    f.authorRequests[0].resolve([{ name: "current", author: "Ada", remote: false }]);
    f.refsRequests[0].reject(new Error("obsolete failure"));
    await popover;

    expect(f.session.popoverLoaded).toBe(true);
    expect(f.session.popoverError).toBeNull();
    expect(f.session.branches.map(({ name }) => name)).toEqual(["current"]);
  });

  it("lets a cold query drain a popover replacement before returning", async () => {
    const f = fixture();
    const query = f.session.refreshForQuery();
    const popover = f.session.loadForPopover();
    f.refsRequests[0].resolve(refs(["obsolete"]));
    await Promise.resolve();
    expect(f.session.hasKnownBranches).toBe(false);
    f.authorRequests[0].resolve([{ name: "current", author: "Ada", remote: false }]);
    f.refsRequests[1].resolve(refs(["current"]));
    await Promise.all([query, popover]);

    expect(f.session.hasKnownBranches).toBe(true);
    expect(f.session.branches.map(({ name }) => name)).toEqual(["current"]);
    expect(f.session.popoverError).toBeNull();
  });

  it("invalidates lazy authors and rejects stale completion state", async () => {
    const f = fixture();
    const stale = f.session.loadForPopover();
    f.session.invalidate();
    f.refsRequests[0].resolve(refs(["main"]));
    f.authorRequests[0].resolve([{ name: "main", author: "old", remote: false }]);
    await stale;

    expect(f.session.branches).toEqual([]);
    expect(f.session.popoverLoaded).toBe(false);
    expect(f.session.popoverLoading).toBe(false);
    expect([...f.session.authors]).toEqual([]);

    const fresh = f.session.loadForPopover();
    f.refsRequests[1].resolve(refs(["next"]));
    f.authorRequests[1].resolve([{ name: "next", author: "new", remote: false }]);
    await fresh;
    expect([...f.session.authors]).toEqual([["next", "new"]]);

    f.session.invalidate();
    expect([...f.session.authors]).toEqual([["next", "new"]]);
    expect(f.session.popoverLoaded).toBe(false);
  });

  it("revokes late refs and authors when disposed", async () => {
    const f = fixture();
    const loading = f.session.loadForPopover();
    f.session.dispose();
    f.refsRequests[0].resolve(refs(["late"]));
    f.authorRequests[0].resolve([{ name: "late", author: "late", remote: false }]);
    await loading;

    expect(f.session.hasKnownBranches).toBe(false);
    expect(f.session.branches).toEqual([]);
    expect([...f.session.authors]).toEqual([]);
    expect(f.session.popoverLoaded).toBe(false);
    expect(f.session.popoverLoading).toBe(false);
  });
});
