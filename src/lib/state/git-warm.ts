/**
 * Background git cache warmer — infrastructure wiring (#287).
 *
 * Wires the pure scheduler (`domain/git-warm`) to the real repo-root probe and
 * the git-graph / SCM cache warmers, exposing a single `gitWarmer` used by
 * ExplorerPane. When a pane settles on a folder inside a git repo, this warms
 * both caches so their first panel open paints instantly instead of loading.
 */

import { settingsStore } from "./settings.svelte";
import { warmScmSummaryForRoot } from "./scm.svelte";
import { repoRootCache } from "./repo-root-cache.svelte";
import { warmGraphSnapshot } from "$lib/state/git-graph-cache";
import { createGitWarmer, type GitWarmer } from "$lib/domain/git-warm";
import { releaseGitSummaryConsumer } from "./git-summary-cache";

const warmConsumerId = (root: string) => `git-warm:${root}`;

/** Resolve through the shared bounded probe cache regardless of title settings. */
async function resolveRepoRoot(path: string): Promise<string | null> {
  await repoRootCache.ensure(path);
  return repoRootCache.get(path) ?? null;
}

export const gitWarmer: GitWarmer = createGitWarmer({
  resolveRepoRoot,
  warmGraph: (root) => void warmGraphSnapshot(root, warmConsumerId(root)),
  warmScm: (root) => void warmScmSummaryForRoot(root, warmConsumerId(root)),
  cancelWarm: (root) => releaseGitSummaryConsumer(warmConsumerId(root)),
  graphEnabled: () => settingsStore.enableGitGraph,
  scmEnabled: () => settingsStore.showGitStatus,
});
