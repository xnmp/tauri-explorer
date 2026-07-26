/**
 * Regression test for #506 ("git repo folder icon no longer shows in tab
 * title bar"), asserted at the seam that actually picks the icon.
 *
 * #471 flipped `DEFAULT_SETTINGS.tabTitleGitRoot` to `true`, but settings
 * persist as a WHOLE object and load as `{ ...DEFAULT_SETTINGS, ...saved }`,
 * so every install that had ever saved settings kept the original `false`
 * and the flip reached new installs only. With the setting off,
 * WindowTabBar.svelte never calls `ensureGitRoot`, `getTabDisplay(tab)
 * .isGitRoot` stays false, and the tab renders the plain folder glyph
 * instead of the git-branch one.
 *
 * `isGitRoot` — not the setting — is what the template branches on, so that
 * is what these assert. Each test boots a FRESH settings store against a
 * persisted blob (the store reads localStorage once, at construction), which
 * is why they reset the module registry rather than calling
 * `settingsStore.update`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CURRENT_SETTINGS_VERSION } from "$lib/domain/settings-migration";

/** Mirrors mock-invoke.ts's git_repo_root mock. */
const REPO_ROOT = "/home/user/Documents/project";
const STORAGE_KEY = "explorer-settings";

/** Boot a tabs manager whose settings store loaded `persisted` from disk. */
async function bootWith(persisted: Record<string, unknown>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  vi.resetModules();
  const { createWindowTabsManager } = await import("$lib/state/window-tabs.svelte");
  const manager = createWindowTabsManager();
  manager.init("/home/user", true);
  return manager;
}

/** Open a tab inside the mock repo and resolve its display exactly as the
 *  tab bar does (probe the root, then read the decoration). */
async function repoTabDisplay(
  manager: Awaited<ReturnType<typeof bootWith>>,
  path = `${REPO_ROOT}/src`,
) {
  const tab = manager.createTab(path);
  await manager.ensureGitRoot(manager.getTabPath(tab.id)!);
  return manager.getTabDisplay(tab);
}

beforeEach(() => {
  localStorage.clear();
});

describe("git-repo tab decoration on an existing install (#506)", () => {
  it("shows the git decoration despite a pre-#471 persisted tabTitleGitRoot:false", async () => {
    // The blob on a real upgraded install: written before #471, so the key is
    // present and false and there is no schema-version stamp.
    const manager = await bootWith({ tabTitleGitRoot: false });

    const display = await repoTabDisplay(manager);

    expect(display.isGitRoot).toBe(true);
    expect(display.repo).toBe("project");
    expect(display.name).toBe("src");
  });

  it("shows the decoration for a legacy blob carrying many other settings", async () => {
    // The real file has ~55 keys; the migration must touch only its own.
    const manager = await bootWith({
      tabTitleGitRoot: false,
      showGitStatus: true,
      previewFontSize: 20,
      ffmpegPath: "/usr/bin/ffmpeg",
    });

    expect((await repoTabDisplay(manager)).isGitRoot).toBe(true);
  });

  it("still shows the plain folder for a tab outside any git repo", async () => {
    const manager = await bootWith({ tabTitleGitRoot: false });

    const display = await repoTabDisplay(manager, "/tmp/not-a-repo");

    expect(display.isGitRoot).toBe(false);
    expect(display.name).toBe("not-a-repo");
  });
});

describe("a deliberate opt-out survives the migration (#506)", () => {
  it("keeps the plain folder icon when the stamped blob says the user turned it off", async () => {
    const manager = await bootWith({
      tabTitleGitRoot: false,
      settingsVersion: CURRENT_SETTINGS_VERSION,
    });

    expect((await repoTabDisplay(manager)).isGitRoot).toBe(false);
  });

  it("does not re-enable the setting on a build newer than the stamp it wrote", async () => {
    const manager = await bootWith({
      tabTitleGitRoot: false,
      settingsVersion: CURRENT_SETTINGS_VERSION + 5,
    });

    expect((await repoTabDisplay(manager)).isGitRoot).toBe(false);
  });
});
