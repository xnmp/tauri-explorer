import { gitBranchStatuses, type BranchStatus, type BranchStatuses } from "$lib/api/git-branch-status";
import { indexBranchStatuses } from "$lib/domain/git-branch-status";

export interface GitBranchStatusDependencies {
  statuses(repoPath: string): Promise<BranchStatuses>;
}

/** Owns one mounted graph's branch-status badges (#1081). Each graph reload
 *  requests a fresh classification; only the newest request may publish, and
 *  nothing publishes after dispose. A failed request clears the badges rather
 *  than leaving a classification of an older history on screen. */
export function createGitBranchStatusSession(
  repoPath: string,
  dependencies: GitBranchStatusDependencies = { statuses: gitBranchStatuses },
) {
  let byBranch = $state.raw<ReadonlyMap<string, BranchStatus>>(new Map());
  let trunk = $state<string | null>(null);
  let request = 0;
  let disposed = false;

  async function reload(): Promise<void> {
    if (disposed) return;
    const current = ++request;
    try {
      const result = await dependencies.statuses(repoPath);
      if (disposed || current !== request) return;
      byBranch = indexBranchStatuses(result.statuses);
      trunk = result.trunk;
    } catch {
      if (disposed || current !== request) return;
      byBranch = new Map();
      trunk = null;
    }
  }

  return {
    get statuses(): ReadonlyMap<string, BranchStatus> { return byBranch; },
    get trunk(): string | null { return trunk; },
    reload,
    dispose(): void {
      disposed = true;
      request += 1;
      byBranch = new Map();
      trunk = null;
    },
  };
}

export type GitBranchStatusSession = ReturnType<typeof createGitBranchStatusSession>;
