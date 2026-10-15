/**
 * IPC wrapper for trunk-aware branch status (#1081), mirroring
 * `src-tauri/src/git_branch_status.rs`. Kept out of `git-log.ts` because that
 * module is in the startup bundle while only the lazily loaded graph needs
 * this call.
 */

import { invoke } from "./common";
import type { BranchStatuses } from "$lib/domain/git-branch-status";

export type { BranchStatus, BranchStatusEntry, BranchStatuses } from "$lib/domain/git-branch-status";

export async function gitBranchStatuses(repoPath: string): Promise<BranchStatuses> {
  return invoke<BranchStatuses>("git_branch_statuses", { repoPath });
}
