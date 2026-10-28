/**
 * Per-pane presentation preferences owned by the window tab strip: the commit
 * graph a pane shows (#272) and its SCM panel override (#434). Extracted from
 * window-tabs.svelte.ts; the strip supplies its tabs and persistence.
 */

import type { PaneId, TabPane } from "./types";

interface PaneHolder { panes: Record<PaneId, TabPane>; activePaneId: PaneId }

export interface PanePrefsDeps {
  tabs(): readonly PaneHolder[];
  activeTab(): PaneHolder | null;
  saveState(): void;
  /** The global `showScmPanel` setting, which a pane without a choice follows. */
  scmDefault(): boolean;
}

export function createPanePrefs(deps: PanePrefsDeps) {
  /** A pane's presentation state, from the first tab that holds it. */
  function findPane(paneId: PaneId): TabPane | undefined {
    for (const tab of deps.tabs()) {
      const pane = tab.panes[paneId];
      if (pane) return pane;
    }
    return undefined;
  }

  /** The repo whose commit graph a pane is showing, if any (#272). */
  function getPaneGitGraph(paneId: PaneId): string | undefined {
    return findPane(paneId)?.gitGraph;
  }

  /** Point a pane's open commit graph at a different repo, or close it
   *  (null). Used when the pane's directory changes while the graph is
   *  showing — the graph follows the navigation instead of pinning the old
   *  repo (#362). No-op when the pane isn't showing a graph. */
  function setPaneGitGraph(paneId: PaneId, repoPath: string | null): void {
    const pane = findPane(paneId);
    if (!pane?.gitGraph) return;
    if (repoPath) pane.gitGraph = repoPath;
    else delete pane.gitGraph;
    deps.saveState();
  }

  /** Show the graph for one specific pane. Unlike the active-pane toggle,
   *  this is idempotent so SCM row actions can safely target their owner. */
  function showGitGraphInPane(paneId: PaneId, repoPath: string): void {
    const pane = findPane(paneId);
    if (!pane) return;
    pane.gitGraph = repoPath;
    deps.saveState();
  }

  /** Toggle the commit graph in the active pane (#272): showing → back to
   *  the file listing; hidden → the graph for `repoPath`. */
  function toggleGitGraphInActivePane(repoPath: string | null): void {
    const tab = deps.activeTab();
    const pane = tab?.panes[tab.activePaneId];
    if (!tab || !pane) return;
    if (pane.gitGraph) {
      delete pane.gitGraph;
    } else if (repoPath) {
      pane.gitGraph = repoPath;
    }
    deps.saveState();
  }

  /** Whether a pane's SCM panel is visible (#434). Per-pane override wins;
   *  when the pane made no explicit choice, fall back to the global
   *  `showScmPanel` setting so new panes and existing tests track the default. */
  function getPaneScmVisible(paneId: PaneId): boolean {
    return findPane(paneId)?.scmPanel ?? deps.scmDefault();
  }

  /** Toggle the SCM panel in the active pane only (#434). Sets an explicit
   *  per-pane override so sibling panes are unaffected. */
  function toggleScmInActivePane(): boolean {
    const tab = deps.activeTab();
    const pane = tab?.panes[tab.activePaneId];
    if (!tab || !pane) return false;
    const next = !(pane.scmPanel ?? deps.scmDefault());
    pane.scmPanel = next;
    deps.saveState();
    return next;
  }

  return { getPaneGitGraph, setPaneGitGraph, showGitGraphInPane, toggleGitGraphInActivePane, getPaneScmVisible, toggleScmInActivePane };
}
