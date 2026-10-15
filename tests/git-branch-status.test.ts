import { describe, expect, it, vi } from "vitest";
import type { BranchStatuses } from "$lib/api/git-log";
import { branchStatusBadge, indexBranchStatuses } from "$lib/domain/git-branch-status";
import { createGitBranchStatusSession } from "$lib/state/git-branch-status.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture() {
  const requests: ReturnType<typeof deferred<BranchStatuses>>[] = [];
  const statuses = vi.fn(() => {
    const request = deferred<BranchStatuses>();
    requests.push(request);
    return request.promise;
  });
  return { session: createGitBranchStatusSession("/repo", { statuses }), requests, statuses };
}

const result = (entries: BranchStatuses["statuses"], trunk: string | null = "main"): BranchStatuses =>
  ({ trunk, statuses: entries });

describe("branch status badge presenter (#1081)", () => {
  it("labels each positive status and names the trunk", () => {
    expect(branchStatusBadge("merged", "origin/main")).toEqual({
      status: "merged", label: "merged", title: "Merged into origin/main",
    });
    expect(branchStatusBadge("squash_merged", "main")).toEqual({
      status: "squash_merged", label: "squashed", title: "Squash-merged into main",
    });
    expect(branchStatusBadge("stale", "main")).toMatchObject({ status: "stale", label: "stale" });
    expect(branchStatusBadge("stale", "main")?.title).toContain("not merged");
  });

  it("shows no badge for unknown or unclassified branches", () => {
    expect(branchStatusBadge("unknown", "main")).toBeNull();
    expect(branchStatusBadge(undefined, "main")).toBeNull();
  });

  it("indexes local and remote shorthands separately", () => {
    const index = indexBranchStatuses([
      { name: "feature", remote: false, status: "merged" },
      { name: "origin/feature", remote: true, status: "stale" },
    ]);
    expect(index.get("feature")).toBe("merged");
    expect(index.get("origin/feature")).toBe("stale");
  });
});

describe("branch status session (#1081)", () => {
  it("publishes the classification of the newest reload", async () => {
    const f = fixture();
    const load = f.session.reload();
    f.requests[0].resolve(result([{ name: "feature", remote: false, status: "squash_merged" }]));
    await load;

    expect(f.session.statuses.get("feature")).toBe("squash_merged");
    expect(f.session.trunk).toBe("main");
  });

  it("does not let a superseded reload overwrite the newer result", async () => {
    const f = fixture();
    const older = f.session.reload();
    const newer = f.session.reload();
    f.requests[1].resolve(result([{ name: "feature", remote: false, status: "stale" }]));
    await newer;
    f.requests[0].resolve(result([{ name: "feature", remote: false, status: "merged" }]));
    await older;

    expect(f.session.statuses.get("feature")).toBe("stale");
  });

  it("ignores a superseded failure", async () => {
    const f = fixture();
    const older = f.session.reload();
    const newer = f.session.reload();
    f.requests[1].resolve(result([{ name: "feature", remote: false, status: "merged" }]));
    await newer;
    f.requests[0].reject(new Error("late failure"));
    await older;

    expect(f.session.statuses.get("feature")).toBe("merged");
  });

  it("clears badges when the newest reload fails", async () => {
    const f = fixture();
    const first = f.session.reload();
    f.requests[0].resolve(result([{ name: "feature", remote: false, status: "merged" }]));
    await first;
    const second = f.session.reload();
    f.requests[1].reject(new Error("not a repository"));
    await second;

    expect(f.session.statuses.size).toBe(0);
    expect(f.session.trunk).toBeNull();
  });

  it("publishes nothing after dispose", async () => {
    const f = fixture();
    const load = f.session.reload();
    f.session.dispose();
    f.requests[0].resolve(result([{ name: "feature", remote: false, status: "merged" }]));
    await load;

    expect(f.session.statuses.size).toBe(0);
    await f.session.reload();
    expect(f.statuses).toHaveBeenCalledTimes(1);
  });
});
