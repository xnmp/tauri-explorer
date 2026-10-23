/**
 * Branch-filter popover semantics (#342, #411–#413, #515): the filter is
 * `null` for every branch and an explicit list otherwise; a selection equal
 * to every branch collapses back to `null`.
 */
import { describe, expect, it } from "vitest";
import {
  authorOptions,
  branchesByAuthor,
  branchRef,
  filterBranchesByQuery,
  isAuthorShown,
  isBranchShown,
  toggleAllBranchesFilter,
  toggleAuthorInFilter,
  toggleBranchInFilter,
} from "$lib/domain/git-graph-branch-filter";

const ALL = ["main", "dev", "feat/a"];

describe("branchRef", () => {
  it("distinguishes local and remote branches with the same shorthand", () => {
    expect(branchRef({ name: "origin/main", remote: true })).toBe("refs/remotes/origin/main");
    expect(branchRef({ name: "origin/main", remote: false })).toBe("refs/heads/origin/main");
  });
});

describe("filterBranchesByQuery", () => {
  const branches = [{ name: "Main", remote: false }, { name: "feat/Login", remote: false }];

  it("matches case-insensitive substrings", () => {
    expect(filterBranchesByQuery(branches, "login").map((b) => b.name)).toEqual(["feat/Login"]);
  });

  it("returns every branch for an empty query and none for a non-match", () => {
    expect(filterBranchesByQuery(branches, "")).toHaveLength(2);
    expect(filterBranchesByQuery(branches, "zzz")).toEqual([]);
  });
});

describe("isBranchShown", () => {
  it("shows everything under the all-branches filter", () => {
    expect(isBranchShown("anything", null, false)).toBe(true);
  });

  it("shows only listed branches under an explicit filter, and none under []", () => {
    expect(isBranchShown("dev", ["dev"], false)).toBe(true);
    expect(isBranchShown("main", ["dev"], false)).toBe(false);
    expect(isBranchShown("main", [], false)).toBe(false);
  });

  it("never shows a branch the bulk remote-only toggle hides", () => {
    expect(isBranchShown("origin/legacy", null, true)).toBe(false);
    expect(isBranchShown("origin/legacy", ["origin/legacy"], true)).toBe(false);
  });
});

describe("toggleBranchInFilter", () => {
  it("unchecking from 'all' shows everything but that branch", () => {
    expect(toggleBranchInFilter(null, ALL, "dev")).toEqual(["main", "feat/a"]);
  });

  it("re-checking the last missing branch collapses back to 'all'", () => {
    expect(toggleBranchInFilter(["main", "feat/a"], ALL, "dev")).toBeNull();
  });

  it("checking from 'none' starts an explicit selection", () => {
    expect(toggleBranchInFilter([], ALL, "dev")).toEqual(["dev"]);
  });

  it("does not mutate the input filter", () => {
    const filter = ["main"];
    toggleBranchInFilter(filter, ALL, "dev");
    expect(filter).toEqual(["main"]);
  });
});

describe("toggleAllBranchesFilter", () => {
  it("toggles between all and none; a partial selection becomes all", () => {
    expect(toggleAllBranchesFilter(null)).toEqual([]);
    expect(toggleAllBranchesFilter([])).toBeNull();
    expect(toggleAllBranchesFilter(["dev"])).toBeNull();
  });
});

describe("authors", () => {
  const branches = [
    { name: "main", remote: false },
    { name: "feat/a", remote: false },
    { name: "origin/old", remote: true },
  ];
  const authors = new Map([["main", "Ann"], ["feat/a", "Bo"], ["origin/old", "Bo"], ["dev", ""]]);
  const noneHidden = () => false;

  it("lists distinct, non-empty authors in sorted order", () => {
    expect(authorOptions(authors)).toEqual(["Ann", "Bo"]);
    expect(authorOptions(new Map())).toEqual([]);
  });

  it("governs only branches the remote-only toggle does not hide", () => {
    expect(branchesByAuthor(branches, authors, "Bo", noneHidden)).toEqual(["feat/a", "origin/old"]);
    expect(branchesByAuthor(branches, authors, "Bo", (n) => n === "origin/old")).toEqual(["feat/a"]);
    expect(branchesByAuthor(branches, authors, "Nobody", noneHidden)).toEqual([]);
  });

  it("an author is checked only when every governed branch is shown", () => {
    expect(isAuthorShown(["a", "b"], () => true)).toBe(true);
    expect(isAuthorShown(["a", "b"], (n) => n === "a")).toBe(false);
    expect(isAuthorShown([], () => true)).toBe(false);
  });

  it("ticking an author adds all their branches; collapsing to all when complete", () => {
    expect(toggleAuthorInFilter(["main"], ALL, ["feat/a"])).toEqual(["main", "feat/a"]);
    expect(toggleAuthorInFilter(["main", "dev"], ALL, ["feat/a"])).toBeNull();
  });

  it("unticking an author whose branches are all shown removes them", () => {
    expect(toggleAuthorInFilter(null, ALL, ["dev", "feat/a"])).toEqual(["main"]);
  });

  it("an author with no governed branches leaves the selection unchanged", () => {
    expect(toggleAuthorInFilter(["main"], ALL, [])).toEqual(["main"]);
    expect(toggleAuthorInFilter(null, ALL, [])).toBeNull();
  });
});
