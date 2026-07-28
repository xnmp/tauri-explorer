/**
 * Git command-palette targets (#520).
 *
 * The palette's observable contract is target-driven: local branch names and
 * commit hashes are fuzzy-searchable command labels, and selecting one reaches
 * the graph action seam for the active pane only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  activeTab: {
    activePaneId: "left",
    panes: { left: { gitGraph: "/repo" }, right: { gitGraph: "/other" } },
  },
}));

vi.mock("$lib/state/window-tabs.svelte", () => ({
  windowTabsManager: h,
}));

import { getAvailableCommands, getCommand, executeCommand } from "$lib/state/commands.svelte";
import {
  registerGitPaletteTargets,
  type GitPaletteTarget,
} from "$lib/state/git-palette";

const commit: GitPaletteTarget = {
  oid: "a1b2c3d4e5f6",
  shortOid: "a1b2c3d",
  summary: "Add command palette targets",
};

describe("git command-palette targets (#520)", () => {
  beforeEach(() => {
    h.activeTab = {
      activePaneId: "left",
      panes: { left: { gitGraph: "/repo" }, right: { gitGraph: "/other" } },
    };
  });

  it("surfaces fuzzy branch, commit, and stash targets only for the active graph pane", async () => {
    const actions = {
      checkout: vi.fn(async () => {}),
      cherryPick: vi.fn(async () => {}),
      rebase: vi.fn(async () => {}),
      merge: vi.fn(async () => {}),
      stashApply: vi.fn(async () => {}),
      stashPop: vi.fn(async () => {}),
      jumpToCommit: vi.fn(async () => {}),
    };
    const stop = registerGitPaletteTargets("left", {
      branches: ["feature/palette"],
      commits: [commit],
      stashes: ["stash@{0}"],
      actions,
    });

    try {
      const labels = getAvailableCommands().map((command) => command.label);
      expect(labels).toEqual(expect.arrayContaining([
        "Git: Checkout Branch feature/palette",
        "Git: Merge Branch feature/palette",
        "Git: Cherry-pick a1b2c3d — Add command palette targets",
        "Git: Rebase onto a1b2c3d — Add command palette targets",
        "Git: Jump to Commit a1b2c3d — Add command palette targets",
        "Git: Apply Stash stash@{0}",
        "Git: Pop Stash stash@{0}",
      ]));

      await executeCommand("git.palette.left.checkout.branch.feature%2Fpalette");
      await executeCommand("git.palette.left.merge.feature%2Fpalette");
      await executeCommand("git.palette.left.cherry-pick.a1b2c3d4e5f6");
      await executeCommand("git.palette.left.rebase.a1b2c3d4e5f6");
      await executeCommand("git.palette.left.jump.a1b2c3d4e5f6");
      await executeCommand("git.palette.left.stash-apply.stash%40%7B0%7D");
      await executeCommand("git.palette.left.stash-pop.stash%40%7B0%7D");
      expect(actions.checkout).toHaveBeenCalledWith("feature/palette");
      expect(actions.merge).toHaveBeenCalledWith("feature/palette");
      expect(actions.cherryPick).toHaveBeenCalledWith(commit.oid);
      expect(actions.rebase).toHaveBeenCalledWith(commit.oid);
      expect(actions.jumpToCommit).toHaveBeenCalledWith(commit.oid);
      expect(actions.stashApply).toHaveBeenCalledWith("stash@{0}");
      expect(actions.stashPop).toHaveBeenCalledWith("stash@{0}");

      const replace = registerGitPaletteTargets("left", {
        branches: ["release"],
        commits: [],
        stashes: [],
        actions,
      });
      expect(getCommand("git.palette.left.checkout.branch.feature%2Fpalette")).toBeUndefined();
      expect(getCommand("git.palette.left.checkout.branch.release")).toBeDefined();
      replace();

      h.activeTab.activePaneId = "right";
      expect(getAvailableCommands().map((command) => command.id)).not.toContain(
        "git.palette.left.checkout.branch.feature%2Fpalette",
      );
      await expect(executeCommand("git.palette.left.checkout.branch.feature%2Fpalette")).resolves.toBe(false);
    } finally {
      stop();
    }

    expect(getCommand("git.palette.left.checkout.branch.feature%2Fpalette")).toBeUndefined();
  });
});
