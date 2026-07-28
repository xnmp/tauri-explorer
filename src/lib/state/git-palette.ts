/**
 * Dynamic Git Graph targets for the command palette (#520).
 *
 * Git data belongs to a pane, while the palette is window-global. This module
 * bridges those scopes without putting a second key handler or action stack in
 * GitGraphView: a mounted graph supplies its current targets and action seam;
 * only the active graph pane exposes them to the registry.
 */

import { registerCommands, unregisterCommand, type Command } from "./commands.svelte";
import { windowTabsManager } from "./window-tabs.svelte";

const registeredIdsByPane = new Map<string, Set<string>>();

export interface GitPaletteTarget {
  oid: string;
  shortOid: string;
  summary: string;
}

export interface GitPaletteActions {
  checkout(target: string): Promise<void>;
  cherryPick(oid: string): Promise<void>;
  rebase(oid: string): Promise<void>;
  merge(branch: string): Promise<void>;
  stashApply(stash: string): Promise<void>;
  stashPop(stash: string): Promise<void>;
  jumpToCommit(oid: string): Promise<void>;
}

export interface GitPaletteTargets {
  branches: readonly string[];
  commits: readonly GitPaletteTarget[];
  stashes: readonly string[];
  actions: GitPaletteActions;
}

function idPart(value: string): string {
  return encodeURIComponent(value);
}

function activeGraphPane(paneId: string): boolean {
  const tab = windowTabsManager.activeTab;
  return tab?.activePaneId === paneId && tab.panes[paneId]?.gitGraph !== null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Register the current graph's fuzzy-searchable targets. Re-registering a
 * pane replaces stale refs/commits; disposing removes its commands entirely.
 */
export function registerGitPaletteTargets(paneId: string, targets: GitPaletteTargets): () => void {
  const when = () => activeGraphPane(paneId);
  const commands: Command[] = [];
  const add = (suffix: string, label: string, handler: () => Promise<void>): void => {
    commands.push({
      id: `git.palette.${paneId}.${suffix}`,
      label,
      category: "general",
      when,
      handler,
    });
  };

  for (const branch of unique(targets.branches)) {
    const key = idPart(branch);
    add(`checkout.branch.${key}`, `Git: Checkout Branch ${branch}`, () => targets.actions.checkout(branch));
    add(`merge.${key}`, `Git: Merge Branch ${branch}`, () => targets.actions.merge(branch));
  }

  for (const commit of targets.commits) {
    const label = `${commit.shortOid} — ${commit.summary}`;
    const key = idPart(commit.oid);
    add(`checkout.commit.${key}`, `Git: Checkout Commit ${label}`, () => targets.actions.checkout(commit.oid));
    add(`cherry-pick.${key}`, `Git: Cherry-pick ${label}`, () => targets.actions.cherryPick(commit.oid));
    add(`rebase.${key}`, `Git: Rebase onto ${label}`, () => targets.actions.rebase(commit.oid));
    add(`jump.${key}`, `Git: Jump to Commit ${label}`, () => targets.actions.jumpToCommit(commit.oid));
  }

  for (const stash of unique(targets.stashes)) {
    const key = idPart(stash);
    add(`stash-apply.${key}`, `Git: Apply Stash ${stash}`, () => targets.actions.stashApply(stash));
    add(`stash-pop.${key}`, `Git: Pop Stash ${stash}`, () => targets.actions.stashPop(stash));
  }

  const ids = new Set(commands.map((command) => command.id));
  // A graph reload replaces its target snapshot. Remove the old snapshot
  // first so branches/commits that disappeared cannot remain actionable.
  for (const id of registeredIdsByPane.get(paneId) ?? []) unregisterCommand(id);
  registeredIdsByPane.set(paneId, ids);
  registerCommands(commands);
  return () => {
    // An older Svelte effect cleanup must not remove the snapshot installed by
    // a newer reload of this same pane.
    if (registeredIdsByPane.get(paneId) !== ids) return;
    registeredIdsByPane.delete(paneId);
    for (const id of ids) unregisterCommand(id);
  };
}
