/**
 * IPC wrapper for the git history / commit-graph backend (#57).
 *
 * Mirrors the Rust structs in `src-tauri/src/git_log.rs`. Field names match the
 * serde output (snake_case), consistent with the SCM `git_status` backend.
 *
 * Graph topology (lane assignment) is computed on the frontend from each
 * commit's `parents` array — the backend only supplies the edges.
 */

import { invoke } from "./files";

export type RefKind = "LocalBranch" | "RemoteBranch" | "Tag" | "Head";

export interface RefInfo {
  /** Display name, e.g. `main`, `origin/main`, `v1.0`. */
  name: string;
  kind: RefKind;
}

export interface CommitInfo {
  /** Full 40-char SHA. */
  oid: string;
  /** Abbreviated SHA (7 chars) for display. */
  short_oid: string;
  /** Parent OIDs: 0 = root, 1 = normal, 2+ = merge. Graph edges. */
  parents: string[];
  author_name: string;
  author_email: string;
  /** Author time, Unix seconds (UTC). */
  author_time: number;
  /** First line of the commit message. */
  summary: string;
}

/** One page of history plus decoration + cursor metadata. */
export interface GitLogPage {
  commits: CommitInfo[];
  /** OID → refs decorating that commit (only decorated commits appear). */
  refs: Record<string, RefInfo[]>;
  /** True if more commits exist past this page. */
  has_more: boolean;
  /** OID of the last commit in the page; next page uses `skip + commits.length`. */
  next_cursor: string | null;
}

export interface GitLogOptions {
  /** Commits to skip from the tip (page offset). Default 0. */
  skip?: number;
  /** Max commits to return. Default 500, clamped to 5000. */
  limit?: number;
}

export interface GitRef {
  name: string;
  /** OID the ref resolves to (peeled for annotated tags). */
  target: string;
}

export interface GitRefs {
  local_branches: GitRef[];
  remote_branches: GitRef[];
  tags: GitRef[];
  /** Current HEAD target OID (null on an unborn / empty repo). */
  head: string | null;
  /** Shorthand of the checked-out branch, or null when detached / unborn. */
  head_branch: string | null;
  detached: boolean;
}

/**
 * Fetch a page of commit history in topological order, with refs decoration.
 * Pass `skip`/`limit` to page; use `page.has_more` / `page.next_cursor` to
 * drive incremental loading.
 */
export async function gitLog(
  repoPath: string,
  options?: GitLogOptions,
): Promise<GitLogPage> {
  return invoke<GitLogPage>("git_log", { repoPath, options: options ?? null });
}

/** Fetch all branches (local + remote), tags, and HEAD for a repo. */
export async function gitRefs(repoPath: string): Promise<GitRefs> {
  return invoke<GitRefs>("git_refs", { repoPath });
}
