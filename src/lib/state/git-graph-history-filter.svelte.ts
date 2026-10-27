/**
 * The git graph's history-walk filters for one repository:
 * - branch subset (#342): null = all branches, [] = none (#413); persisted;
 * - local branches only (#381): persisted;
 * - hide remote-only branches (#515): a separate axis from the per-branch
 *   selection so toggling it never destroys a curated subset; persisted;
 * - file path (#529): deliberately ephemeral, so a one-off lookup does not
 *   silently survive reopening the graph.
 *
 * Only the values and their persistence live here. The graph view owns the
 * side effects of a change (retiring navigation, closing details, reloading).
 */
import { loadPersisted, savePersisted } from "./persisted";

export function createGitGraphHistoryFilter(repoPath: string) {
  const branchFilterKey = `git-graph-branch-filter:${repoPath}`;
  const localOnlyKey = `git-graph-local-only:${repoPath}`;
  const hideRemoteOnlyKey = `git-graph-hide-remote-only:${repoPath}`;

  const savedBranchFilter = loadPersisted<unknown>(branchFilterKey, null);
  let branchFilter = $state<string[] | null>(
    Array.isArray(savedBranchFilter) && savedBranchFilter.every((s) => typeof s === "string")
      ? (savedBranchFilter as string[])
      : null,
  );
  let localOnly = $state(loadPersisted<unknown>(localOnlyKey, false) === true);
  let hideRemoteOnly = $state(loadPersisted<unknown>(hideRemoteOnlyKey, false) === true);
  let filePath = $state("");

  return {
    get branchFilter() { return branchFilter; },
    get localOnly() { return localOnly; },
    get hideRemoteOnly() { return hideRemoteOnly; },
    get filePath() { return filePath; },
    /** Whether any filter narrows the walked history. */
    get active() {
      return branchFilter !== null || localOnly || hideRemoteOnly || !!filePath.trim();
    },
    setBranchFilter(next: string[] | null): void {
      branchFilter = next;
      savePersisted(branchFilterKey, branchFilter);
    },
    toggleLocalOnly(): void {
      localOnly = !localOnly;
      savePersisted(localOnlyKey, localOnly);
    },
    toggleHideRemoteOnly(): void {
      hideRemoteOnly = !hideRemoteOnly;
      savePersisted(hideRemoteOnlyKey, hideRemoteOnly);
    },
    setFilePath(value: string): void {
      filePath = value;
    },
    /** Walk every ref: clears every filter (the fork-point jump needs an
     *  unhidden ancestor and unambiguous ref identities). */
    clearAll(): void {
      branchFilter = null;
      filePath = "";
      localOnly = false;
      hideRemoteOnly = false;
      savePersisted(branchFilterKey, branchFilter);
      savePersisted(localOnlyKey, false);
      savePersisted(hideRemoteOnlyKey, false);
    },
  };
}

export type GitGraphHistoryFilter = ReturnType<typeof createGitGraphHistoryFilter>;
