/**
 * Background git cache warmer — infrastructure wiring (#287).
 *
 * Wires the pure scheduler (`domain/git-warm`) to the real repo-root probe and
 * the git-graph / SCM cache warmers, exposing a single `gitWarmer` used by
 * ExplorerPane. When a pane settles on a folder inside a git repo, this warms
 * both caches so their first panel open paints instantly instead of loading.
 */

import { gitRepoRoot } from "$lib/api/files";
import { settingsStore } from "./settings.svelte";
import { scmStore } from "./scm.svelte";
import { windowTabsManager } from "./window-tabs.svelte";
import { warmGraphSnapshot } from "$lib/components/GitGraphView.svelte";
import { createGitWarmer, type GitWarmer } from "$lib/domain/git-warm";

/** Resolve a repo root, reusing the tab bar's cached probe when the git-root
 *  tab-title setting is on (avoids a duplicate gitRepoRoot IPC), else one IPC. */
async function resolveRepoRoot(path: string): Promise<string | null> {
  if (settingsStore.tabTitleGitRoot) {
    await windowTabsManager.ensureGitRoot(path);
    const cached = windowTabsManager.getGitRoot(path);
    if (cached !== undefined) return cached;
  }
  const r = await gitRepoRoot(path);
  return r.ok ? r.data : null;
}

export const gitWarmer: GitWarmer = createGitWarmer({
  resolveRepoRoot,
  warmGraph: (root) => void warmGraphSnapshot(root),
  warmScm: (root) => void scmStore.warm(root),
  graphEnabled: () => settingsStore.enableGitGraph,
  scmEnabled: () => settingsStore.showGitStatus,
});
