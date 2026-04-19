/**
 * Git status state management.
 * Issue: feat/git-status-indicators
 *
 * Fetches git status for the current directory and exposes
 * per-file status indicators.
 */

import { getGitStatus, type GitFileStatus } from "$lib/api/files";

function createGitStatusStore() {
  let currentPath = $state<string>("");
  let isGitRepo = $state(false);
  let statuses = $state<Record<string, GitFileStatus>>({});
  let loading = $state(false);

  async function fetchForDirectory(path: string): Promise<void> {
    if (path === currentPath && Object.keys(statuses).length > 0) return;
    currentPath = path;
    loading = true;

    const result = await getGitStatus(path);
    if (result.ok && currentPath === path) {
      isGitRepo = result.data.is_git_repo;
      statuses = result.data.statuses;
    }
    loading = false;
  }

  function getStatus(fileName: string): GitFileStatus | null {
    return statuses[fileName] ?? null;
  }

  function clear(): void {
    currentPath = "";
    isGitRepo = false;
    statuses = {};
  }

  return {
    get isGitRepo() { return isGitRepo; },
    get loading() { return loading; },
    get currentPath() { return currentPath; },
    fetchForDirectory,
    getStatus,
    clear,
  };
}

export const gitStatusStore = createGitStatusStore();
