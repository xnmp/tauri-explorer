/**
 * Bulk "hide remote-only branches" toggle (#515).
 *
 * `effectiveBranchSelection` is the seam the git graph's log query is built
 * from: whatever it returns becomes `GitLogOptions.branches`, i.e. the tips the
 * revwalk is seeded from. Asserting here is asserting on the set of branches
 * the graph actually walks, not on the checkbox that toggles it.
 */
import { describe, it, expect } from "vitest";
import {
  remoteOnlyBranchNames,
  effectiveBranchSelection,
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

describe("effectiveBranchSelection", () => {
  it("leaves the selection untouched while the toggle is off", () => {
    expect(effectiveBranchSelection(BRANCHES, null, false)).toBeNull();
    expect(effectiveBranchSelection(BRANCHES, ["main", "origin/legacy-import"], false)).toEqual([
      "main",
      "origin/legacy-import",
    ]);
  });

  it("walks every branch except the remote-only ones when nothing is selected", () => {
    expect(effectiveBranchSelection(BRANCHES, null, true)).toEqual([
      "main",
      "hotfix",
      "feature",
      "origin/main",
      "origin/hotfix",
    ]);
  });

  it("composes with a per-branch selection: hand-unchecked branches stay out", () => {
    // The user unchecked `hotfix` by hand; the bulk toggle only removes the
    // remote-only branch on top of that.
    const selected = ["main", "feature", "origin/main", "origin/legacy-import"];
    expect(effectiveBranchSelection(BRANCHES, selected, true)).toEqual([
      "main",
      "feature",
      "origin/main",
    ]);
  });

  it("walks nothing when only remote-only branches were selected", () => {
    expect(effectiveBranchSelection(BRANCHES, ["origin/legacy-import"], true)).toEqual([]);
  });

  it("keeps an unfiltered walk when there is nothing remote-only to hide", () => {
    const allTracked = [local("main"), remote("origin/main")];
    expect(effectiveBranchSelection(allTracked, null, true)).toBeNull();
  });

  it("never empties the graph before the branch list has loaded", () => {
    // The popover loads the branch list lazily; an empty list must not be read
    // as "every branch is remote-only".
    expect(effectiveBranchSelection([], null, true)).toBeNull();
    expect(effectiveBranchSelection([], ["main"], true)).toEqual(["main"]);
  });

  it("preserves an explicitly empty selection (#413)", () => {
    expect(effectiveBranchSelection(BRANCHES, [], true)).toEqual([]);
    expect(effectiveBranchSelection(BRANCHES, [], false)).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const selected = ["main", "origin/legacy-import"];
    effectiveBranchSelection(BRANCHES, selected, true);
    expect(selected).toEqual(["main", "origin/legacy-import"]);
    expect(BRANCHES).toHaveLength(6);
  });
});
