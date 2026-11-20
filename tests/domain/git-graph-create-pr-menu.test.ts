/**
 * "Create pull request…" in the branch pill menu (#1847): offered only for a
 * local branch, disabled with a reason while a PR action runs or once the
 * branch already has an open PR.
 */
import { describe, it, expect } from "vitest";
import { createPrMenuItem } from "$lib/domain/git-graph-create-pr";

describe("createPrMenuItem", () => {
  it("offers an enabled entry for an idle local branch without an open PR", () => {
    expect(createPrMenuItem("feature/login", false, undefined)).toEqual({ branch: "feature/login", enabled: true });
  });

  it("is absent when the menu is not scoped to a local branch (row, remote or tag pill)", () => {
    expect(createPrMenuItem(null, false, undefined)).toBeNull();
    expect(createPrMenuItem(null, true, { number: 3 })).toBeNull();
    expect(createPrMenuItem("", false, undefined)).toBeNull();
  });

  it("is disabled with a reason while a PR action is running", () => {
    expect(createPrMenuItem("main", true, undefined)).toEqual({
      branch: "main", enabled: false, reason: "A GitHub PR action is in progress",
    });
  });

  it("is disabled with the open PR's number when the branch already has one", () => {
    expect(createPrMenuItem("main", false, { number: 42 })).toEqual({
      branch: "main", enabled: false, reason: "PR #42 is already open",
    });
  });

  it("reports the running action before the open PR when both apply", () => {
    const item = createPrMenuItem("main", true, { number: 42 });
    expect(item).toMatchObject({ enabled: false, reason: "A GitHub PR action is in progress" });
  });
});
