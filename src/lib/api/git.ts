/**
 * API client for git status decoration and the SCM (stage/commit/diff) backend.
 * Issue: refactor/audit-tier4-splits (#212)
 */

import { invoke, extractError, type ApiResult } from "./common";
import type { GitFileEntry, GitStatusCode, GitOpState } from "$lib/domain/git";

export type { GitFileEntry, GitStatusCode, GitOpState };

/**
 * Git file status types.
 */
export type GitFileStatus = "Modified" | "Added" | "Deleted" | "Renamed" | "Copied" | "Untracked" | "Ignored" | "Conflicted" | "TypeChange";

export interface GitStatusResponse {
  is_git_repo: boolean;
  statuses: Record<string, GitFileStatus>;
}

/**
 * Get git status for files in a directory.
 */
export async function getGitStatus(
  path: string,
  taskId?: number,
): Promise<ApiResult<GitStatusResponse>> {
  try {
    const data = await invoke<GitStatusResponse>("get_git_status", { path, taskId });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function cancelGetGitStatus(taskId: number): Promise<void> {
  try {
    await invoke<void>("cancel_get_git_status", { taskId });
  } catch (err) {
    console.debug(
      `[git-status] badge cancellation for task ${taskId} did not reach an active request: ${extractError(err)}`,
    );
  }
}

// ----- SCM git backend (#53) ----- //

export interface GitStatusSummary {
  is_repo: boolean;
  repo_root: string | null;
  branch: string | null;
  detached: boolean;
  staged: GitFileEntry[];
  changes: GitFileEntry[];
  untracked: GitFileEntry[];
  merge: GitFileEntry[];
  /** In-progress operation, or "clean". Drives the SCM in-progress banner. */
  op_state: GitOpState;
}

export interface GitCommitResult {
  commit_id: string;
  summary: string;
}

export async function gitInit(path: string): Promise<ApiResult<string>> {
  try {
    const data = await invoke<string>("git_init", { path });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitRepoRoot(path: string): Promise<ApiResult<string | null>> {
  try {
    const data = await invoke<string | null>("git_repo_root", { path });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Append a path to the repo's `.gitignore`, creating the file if needed.
 *  Idempotent — duplicate entries are skipped. */
export async function gitAddToGitignore(
  repoRoot: string,
  entry: string,
): Promise<ApiResult<string>> {
  try {
    const data = await invoke<string>("git_add_to_gitignore", { repoRoot, entry });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Move untracked working-tree paths into the repository's `.archive` folder. */
export async function gitArchiveUntracked(
  repoPath: string,
  paths: string[],
): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_archive_untracked", { repoPath, paths });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Move untracked working-tree paths to the operating system trash. */
export async function gitTrashUntracked(
  repoPath: string,
  paths: string[],
): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_trash_untracked", { repoPath, paths });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitSummary(
  repoPath: string,
  taskId?: number,
): Promise<ApiResult<GitStatusSummary>> {
  try {
    const data = await invoke<GitStatusSummary>("git_status", { repoPath, taskId });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function cancelGitStatus(taskId: number): Promise<void> {
  try {
    await invoke<void>("cancel_git_status", { taskId });
  } catch (err) {
    console.debug(
      `[git-status] SCM cancellation for task ${taskId} did not reach an active request: ${extractError(err)}`,
    );
  }
}

export async function gitStage(repoPath: string, paths: string[]): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_stage", { repoPath, paths });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitUnstage(repoPath: string, paths: string[]): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_unstage", { repoPath, paths });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** The index/worktree target to which a unified patch is applied. */
export type GitPatchAction = "stage" | "unstage" | "discard";

export async function gitApplyPatch(
  repoPath: string,
  patch: string,
  action: GitPatchAction,
): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_apply_patch", { repoPath, patch, action });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitDiscard(
  repoPath: string,
  paths: string[],
  options?: { force?: boolean },
): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_discard", { repoPath, paths, options: options ?? null });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitDiff(
  repoPath: string,
  path: string,
  options?: { staged?: boolean },
): Promise<ApiResult<string>> {
  try {
    const data = await invoke<string>("git_diff", { repoPath, path, options: options ?? null });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitCommit(
  repoPath: string,
  message: string,
  options?: { amend?: boolean },
): Promise<ApiResult<GitCommitResult>> {
  try {
    const data = await invoke<GitCommitResult>("git_commit", { repoPath, message, options: options ?? null });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitWatchRepo(repoPath: string): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_watch_repo", { repoPath });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitUnwatchRepo(repoPath: string): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_unwatch_repo", { repoPath });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

// ----- In-progress operation abort / continue (#294) ----- //

export async function gitMergeAbort(repoPath: string): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_merge_abort", { repoPath });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitRebaseAbort(repoPath: string): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_rebase_abort", { repoPath });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitRebaseContinue(repoPath: string): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_rebase_continue", { repoPath });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitCherryPickAbort(repoPath: string): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_cherry_pick_abort", { repoPath });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

export async function gitRevertAbort(repoPath: string): Promise<ApiResult<void>> {
  try {
    await invoke<void>("git_revert_abort", { repoPath });
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}
