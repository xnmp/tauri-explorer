/**
 * API client for git status decoration and the SCM (stage/commit/diff) backend.
 * Issue: refactor/audit-tier4-splits (#212)
 */

import { invoke, extractError, type ApiResult } from "./common";

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
export async function getGitStatus(path: string): Promise<ApiResult<GitStatusResponse>> {
  try {
    const data = await invoke<GitStatusResponse>("get_git_status", { path });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

// ----- SCM git backend (#53) ----- //

export type GitStatusCode =
  | "Modified"
  | "Added"
  | "Deleted"
  | "Renamed"
  | "Copied"
  | "Untracked"
  | "Ignored"
  | "Conflicted"
  | "TypeChange";

export interface GitFileEntry {
  path: string;
  old_path: string | null;
  status: GitStatusCode;
}

export interface GitStatusSummary {
  is_repo: boolean;
  repo_root: string | null;
  branch: string | null;
  detached: boolean;
  staged: GitFileEntry[];
  changes: GitFileEntry[];
  untracked: GitFileEntry[];
  merge: GitFileEntry[];
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

export async function gitSummary(repoPath: string): Promise<ApiResult<GitStatusSummary>> {
  try {
    const data = await invoke<GitStatusSummary>("git_status", { repoPath });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: extractError(err) };
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
