/**
 * Bulk "hide remote-only branches" toggle (#515).
 *
 * `branchWalkQuery` is the seam the git graph's log query is built from: what
 * it returns becomes `GitLogOptions.branches` / `exclude_branches`, i.e. the
 * tips the revwalk is seeded from and the ones subtracted from that seed set.
 * Asserting here is asserting on what the graph actually walks, not on the
 * checkbox that toggles it.
 *
 * Why the toggle is a SUBTRACTION and not just a narrower `branches` list:
 * the backend ignores `local_only` and skips `push_head()` whenever `branches`
 * is set, so spelling "everything except the remote-only refs" as an explicit
 * list would make a HIDE toggle reveal remote-ahead commits and drop a
 * detached HEAD's history. `src-tauri/src/git_log.rs` pins the backend half.
 */
import { describe, it, expect } from "vitest";
import {
  remoteOnlyBranchNames,
  branchWalkQuery,
  type BranchListEntry,
} from "$lib/domain/git-graph";

const local = (name: string): BranchListEntry => ({ name, remote: false });
const remote = (name: string): BranchListEntry => ({ name, remote: true });

/** Mirrors the mock repo: two tracked remotes and one remote-only branch. */
const BRANCHES: BranchListEntry[] = [
  local("main"),
  local("hotfix"),
  local("feature"),
  remote("origin/main"),
  remote("origin/hotfix"),
  remote("origin/legacy-import"),
];

describe("remoteOnlyBranchNames", () => {
  it("returns remote refs that no local branch of the same name tracks", () => {
    expect(remoteOnlyBranchNames(BRANCHES)).toEqual(["origin/legacy-import"]);
  });

  it("matches nested branch names below the remote segment", () => {
    const branches = [local("feat/x"), remote("origin/feat/x"), remote("origin/feat/y")];
    expect(remoteOnlyBranchNames(branches)).toEqual(["origin/feat/y"]);
  });

  it("treats identically named branches on different remotes independently", () => {
    const branches = [local("main"), remote("origin/main"), remote("upstream/main")];
    // Both track a local `main`, so neither is remote-only.
    expect(remoteOnlyBranchNames(branches)).toEqual([]);
  });

  it("handles empty, local-only and slash-less input without throwing", () => {
    expect(remoteOnlyBranchNames([])).toEqual([]);
    expect(remoteOnlyBranchNames([local("main"), local("dev")])).toEqual([]);
    // A remote entry with no `/` keeps its whole name as the branch part.
    expect(remoteOnlyBranchNames([local("weird"), remote("weird")])).toEqual([]);
    expect(remoteOnlyBranchNames([remote("weird")])).toEqual(["weird"]);
  });

  it("does not repeat a duplicated remote entry", () => {
    const branches = [remote("origin/legacy"), remote("origin/legacy")];
    expect(remoteOnlyBranchNames(branches)).toEqual(["origin/legacy"]);
  });
});

describe("branchWalkQuery", () => {
  it("asks for nothing special while the toggle is off", () => {
    expect(branchWalkQuery(BRANCHES, null, false)).toEqual({
      branches: null,
      excludeBranches: null,
    });
    expect(branchWalkQuery(BRANCHES, ["main", "origin/legacy-import"], false)).toEqual({
      branches: ["main", "origin/legacy-import"],
      excludeBranches: null,
    });
  });

  it("subtracts the remote-only branches instead of enumerating the rest", () => {
    // `branches: null` is the point: the walk keeps seeding HEAD and keeps
    // honouring local_only, and only the remote-only tips are dropped.
    expect(branchWalkQuery(BRANCHES, null, true)).toEqual({
      branches: null,
      excludeBranches: ["origin/legacy-import"],
    });
  });

  it("composes with a per-branch selection without rewriting it", () => {
    // The user unchecked `hotfix` by hand; the bulk toggle leaves that
    // selection alone and subtracts on top of it.
    const selected = ["main", "feature", "origin/main", "origin/legacy-import"];
    expect(branchWalkQuery(BRANCHES, selected, true)).toEqual({
      branches: selected,
      excludeBranches: ["origin/legacy-import"],
    });
  });

  it("leaves an explicitly empty selection empty (#413)", () => {
    expect(branchWalkQuery(BRANCHES, [], true)).toEqual({
      branches: [],
      excludeBranches: ["origin/legacy-import"],
    });
  });

  it("subtracts nothing when there is nothing remote-only to hide", () => {
    const allTracked = [local("main"), remote("origin/main")];
    expect(branchWalkQuery(allTracked, null, true).excludeBranches).toBeNull();
  });

  it("never subtracts before the branch list has loaded", () => {
    // The popover loads the branch list lazily; an empty list must not read
    // as "every branch is remote-only".
    expect(branchWalkQuery([], null, true)).toEqual({ branches: null, excludeBranches: null });
    expect(branchWalkQuery([], ["main"], true)).toEqual({
      branches: ["main"],
      excludeBranches: null,
    });
  });

  it("does not mutate its inputs", () => {
    const selected = ["main", "origin/legacy-import"];
    const query = branchWalkQuery(BRANCHES, selected, true);
    query.branches!.push("mutated");
    expect(selected).toEqual(["main", "origin/legacy-import"]);
    expect(BRANCHES).toHaveLength(6);
  });
});
