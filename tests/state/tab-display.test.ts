/**
 * Regression test for #471 ("tab title shows plain folder instead of git
 * icon for git repos").
 *
 * Investigation (git log -S "tabTitleGitRoot" --all): the isGitRoot
 * decoration in WindowTabBar.svelte / tab-display.svelte.ts has never
 * malfunctioned — it has correctly rendered the git icon whenever
 * `settingsStore.tabTitleGitRoot` was on since the feature's introduction
 * (#281/22a0e320). But that setting defaulted to `false` from day one, so a
 * tab opened on an ordinary git repo (no prior manual opt-in) always showed
 * the plain folder icon — exactly the symptom reported as a "regression".
 * There is no broken commit to bisect; the fix is defaulting the setting on
 * so the decoration a user expects to "just work" for git repos does, out
 * of the box, without requiring them to find a hidden toggle first. The
 * setting still exists for anyone who wants to turn it back off.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";
import { settingsStore } from "$lib/state/settings.svelte";

// Mirrors mock-invoke.ts's git_repo_root mock: any path under this prefix
// resolves to the repo root "/home/user/Documents/project".
const REPO_ROOT = "/home/user/Documents/project";

function freshManager() {
  const manager = createWindowTabsManager();
  manager.init("/home/user", true);
  return manager;
}

afterEach(() => {
  // Tests below toggle the setting directly; always restore the default so
  // later tests (and other describe blocks in this file) see it on.
  settingsStore.update({ tabTitleGitRoot: true });
});

describe("git-root tab decoration (#471)", () => {
  it("defaults to on: a tab inside a git repo shows the git icon without any prior setup", async () => {
    expect(settingsStore.tabTitleGitRoot).toBe(true);

    const manager = freshManager();
    const tab = manager.createTab(`${REPO_ROOT}/src`);
    await manager.ensureGitRoot(manager.getTabPath(tab.id)!);

    const display = manager.getTabDisplay(tab);
    expect(display.isGitRoot).toBe(true);
    expect(display.repo).toBe("project");
    expect(display.name).toBe("src");
  });

  it("shows just the repo name (no folder part) when the tab sits at the repo root", async () => {
    const manager = freshManager();
    const tab = manager.createTab(REPO_ROOT);
    await manager.ensureGitRoot(manager.getTabPath(tab.id)!);

    const display = manager.getTabDisplay(tab);
    expect(display.isGitRoot).toBe(true);
    expect(display.repo).toBeNull();
    expect(display.name).toBe("project");
  });

  it("still shows the plain folder for a tab outside any git repo", async () => {
    const manager = freshManager();
    const tab = manager.createTab("/tmp/not-a-repo");
    await manager.ensureGitRoot(manager.getTabPath(tab.id)!);

    const display = manager.getTabDisplay(tab);
    expect(display.isGitRoot).toBe(false);
    expect(display.repo).toBeNull();
    expect(display.name).toBe("not-a-repo");
  });

  it("the setting can still be switched off to hide the decoration", async () => {
    settingsStore.update({ tabTitleGitRoot: false });

    const manager = freshManager();
    const tab = manager.createTab(`${REPO_ROOT}/src`);
    await manager.ensureGitRoot(manager.getTabPath(tab.id)!);

    expect(manager.getTabDisplay(tab).isGitRoot).toBe(false);
  });
});
