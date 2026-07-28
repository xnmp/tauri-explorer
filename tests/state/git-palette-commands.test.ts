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

import {
  clearRecentCommands,
  getAvailableCommands,
  getCommand,
  getCommandFrecencyScore,
  executeCommand,
} from "$lib/state/commands.svelte";
import {
  MAX_GIT_PALETTE_COMMIT_TARGETS,
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
      stashes: [{ selector: "stash@{0}", summary: "Saved parser experiment" }],
      actions,
    });

    try {
      clearRecentCommands();
      const labels = getAvailableCommands().map((command) => command.label);
      expect(labels).toEqual(
        expect.arrayContaining([
          "Git: Checkout Branch feature/palette",
          "Git: Merge Branch feature/palette",
          "Git: Cherry-pick a1b2c3d — Add command palette targets",
          "Git: Rebase onto a1b2c3d — Add command palette targets",
          "Git: Jump to Commit a1b2c3d — Add command palette targets",
          "Git: Apply Stash stash@{0} — Saved parser experiment",
          "Git: Pop Stash stash@{0} — Saved parser experiment",
        ]),
      );

      await executeCommand(
        "git.palette.left.checkout.branch.feature%2Fpalette",
      );
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
      expect(
        getCommandFrecencyScore(
          "git.palette.left.checkout.branch.feature%2Fpalette",
        ),
      ).toBe(0);

      const replace = registerGitPaletteTargets("left", {
        branches: ["release"],
        commits: [],
        stashes: [],
        actions,
      });
      expect(
        getCommand("git.palette.left.checkout.branch.feature%2Fpalette"),
      ).toBeUndefined();
      expect(
        getCommand("git.palette.left.checkout.branch.release"),
      ).toBeDefined();
      replace();

      h.activeTab.activePaneId = "right";
      expect(getAvailableCommands().map((command) => command.id)).not.toContain(
        "git.palette.left.checkout.branch.feature%2Fpalette",
      );
      await expect(
        executeCommand("git.palette.left.checkout.branch.feature%2Fpalette"),
      ).resolves.toBe(false);
    } finally {
      stop();
    }

    expect(
      getCommand("git.palette.left.checkout.branch.feature%2Fpalette"),
    ).toBeUndefined();
  });

  it("caps ephemeral commit targets at the recent window", () => {
    const actions = {
      checkout: vi.fn(async () => {}),
      cherryPick: vi.fn(async () => {}),
      rebase: vi.fn(async () => {}),
      merge: vi.fn(async () => {}),
      stashApply: vi.fn(async () => {}),
      stashPop: vi.fn(async () => {}),
      jumpToCommit: vi.fn(async () => {}),
    };
    const commits = Array.from(
      { length: MAX_GIT_PALETTE_COMMIT_TARGETS + 1 },
      (_, n) => ({
        oid: `commit-${n}`,
        shortOid: `c${n}`,
        summary: `Commit ${n}`,
      }),
    );
    const stop = registerGitPaletteTargets("left", {
      branches: [],
      commits,
      stashes: [],
      actions,
    });
    try {
      expect(
        getCommand(
          `git.palette.left.jump.commit-${MAX_GIT_PALETTE_COMMIT_TARGETS - 1}`,
        ),
      ).toBeDefined();
      expect(
        getCommand(
          `git.palette.left.jump.commit-${MAX_GIT_PALETTE_COMMIT_TARGETS}`,
        ),
      ).toBeUndefined();
    } finally {
      stop();
    }
  });

  it("hides targets when the active pane stops showing a graph", () => {
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
      branches: ["main"],
      commits: [],
      stashes: [],
      actions,
    });
    try {
      delete (h.activeTab.panes.left as { gitGraph?: string }).gitGraph;
      expect(getAvailableCommands().map((command) => command.id)).not.toContain(
        "git.palette.left.checkout.branch.main",
      );
    } finally {
      stop();
    }
  });
});
