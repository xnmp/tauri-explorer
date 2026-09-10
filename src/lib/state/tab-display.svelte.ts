/**
 * Tab display: titles, icons, and git-root decoration (#281).
 *
 * Extracted from the window-tabs manager (sweep finding B2): everything
 * here exists purely to LABEL tabs — the git-root cache (async IPC that
 * only decorates titles), VS Code-style disambiguation for single-pane
 * tabs, and multi-pane title joining. The manager passes reactive getters,
 * so the derivations recompute on tab/path changes exactly as before.
 */

import type { ExplorerTab, PaneId, WindowTab } from "./types";
import { settingsStore } from "./settings.svelte";
import { repoRootCache } from "./repo-root-cache.svelte";
import {
  disambiguateTabTitles,
  extractFolderName,
  gitTabDisplay,
  type GitTabDisplay,
} from "$lib/domain/tab-title";
import { countLeaves, leafIds } from "$lib/domain/pane-layout";

/** Separator between pane folder names in a multi-pane tab title. */
const PANE_TITLE_SEPARATOR = " | ";

/** How a tab labels itself.
 *  - git mode (setting on + folder inside a repo): a git icon, the repo root
 *    name, and the current folder (`repo` is null when the cwd *is* the root).
 *  - single-pane normal mode: a folder icon and the (disambiguated) folder name.
 *  - multi-pane: the custom name if renamed, else every pane's folder name
 *    joined (no disambiguation — the combination is the identity). */
export type TabDisplay = GitTabDisplay;

export interface TabDisplayDeps {
  getTabs: () => WindowTab[];
  getTabLivePath: (tab: WindowTab) => string;
  panePath: (tab: ExplorerTab, paneId: PaneId) => string;
}

export function createTabDisplay(deps: TabDisplayDeps) {
  /** Per-tab display info for SINGLE-pane explorer tabs. Normal-mode tabs are
   *  disambiguated against each other (VS Code style); git-mode tabs carry
   *  repo + cwd, which is already distinct. Reactive on tab paths, the
   *  git-root cache, and the setting. */
  const singlePaneDisplays = $derived.by((): Map<string, TabDisplay> => {
    const useGit = settingsStore.tabTitleGitRoot;
    const normal: { id: string; path: string }[] = [];
    const gitMode = new Map<string, { repoRoot: string; cwd: string }>();

    const singles = deps
      .getTabs()
      .filter((t): t is ExplorerTab => t.kind === "explorer" && countLeaves(t.layout) === 1);
    for (const t of singles) {
      const cwd = deps.getTabLivePath(t);
      const root = useGit ? repoRootCache.get(cwd) : null;
      if (root) gitMode.set(t.id, { repoRoot: root, cwd });
      else normal.push({ id: t.id, path: cwd });
    }

    const disamb = disambiguateTabTitles(normal);
    const out = new Map<string, TabDisplay>();
    for (const t of singles) {
      const g = gitMode.get(t.id);
      if (g) {
        out.set(t.id, gitTabDisplay(g.cwd, g.repoRoot));
      } else {
        out.set(t.id, {
          isGitRoot: false,
          repo: null,
          name: disamb.get(t.id) ?? extractFolderName(deps.getTabLivePath(t)),
        });
      }
    }
    return out;
  });

  /** Multi-pane title: custom name, or all pane folder names joined. */
  function multiPaneTitle(tab: ExplorerTab): string {
    if (tab.name) return tab.name;
    return leafIds(tab.layout)
      .map((paneId) => extractFolderName(deps.panePath(tab, paneId)))
      .join(PANE_TITLE_SEPARATOR);
  }

  /** Structured display (icon + repo + name) for rendering a tab. */
  function getTabDisplay(tab: WindowTab): TabDisplay {
    if (countLeaves(tab.layout) > 1) {
      return { isGitRoot: false, repo: null, name: multiPaneTitle(tab) };
    }
    return (
      singlePaneDisplays.get(tab.id) ?? {
        isGitRoot: false,
        repo: null,
        name: extractFolderName(deps.getTabLivePath(tab)),
      }
    );
  }

  /** Plain-text tab title (used for the drag ghost and width measurement). */
  function getTabTitle(tab: WindowTab): string {
    const d = getTabDisplay(tab);
    return d.repo ? `${d.repo} › ${d.name}` : d.name;
  }

  /** Fetch (and cache) the git repo root for a folder. No-op unless the
   *  setting is on and we haven't already resolved/queued this folder. Called
   *  from the tab bar so the async work has a component owner. */
  async function ensureGitRoot(path: string): Promise<void> {
    if (!settingsStore.tabTitleGitRoot || !path) return;
    await repoRootCache.ensure(path);
  }

  /** Read the cached git repo root for a folder: the root string, `null` when
   *  known not to be a repo, or `undefined` when not yet resolved. Lets other
   *  consumers (git-warm, #287) reuse the tab bar's probe instead of issuing a
   *  duplicate gitRepoRoot IPC. */
  function getGitRoot(path: string): string | null | undefined {
    return path ? repoRootCache.get(path) : undefined;
  }

  return { getTabDisplay, getTabTitle, ensureGitRoot, getGitRoot };
}
