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
  /** Stash selector (e.g. stash@{0}) when this row is a woven stash entry. */
  stash?: string;
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
  /** Shorthand of the checked-out branch (HEAD's symbolic target), or null when
   *  detached / unborn. Lets the graph highlight only the checked-out branch
   *  chip when several branches decorate the HEAD commit (#433). */
  head_branch: string | null;
}

export interface GitLogOptions {
  /** Commits to skip from the tip (page offset). Default 0. */
  skip?: number;
  /** Max commits to return. Default 500, clamped to 5000. */
  limit?: number;
  /** Walk history from only these branch tips (shorthand names, local like
   *  `main` or remote like `origin/main`). Omitted = all branches + HEAD.
   *  Unresolvable names are ignored; none resolving → empty page (#342). */
  branches?: string[];
  /** Seed from HEAD + local branches only, hiding history reachable solely
   *  from remote-tracking branches (#381). Ignored when `branches` is set. */
  local_only?: boolean;
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

export interface CommitFile {
  path: string;
  /** Porcelain-style letter: A, M, D, R, C, T. */
  status: string;
}

/** Files changed by a commit vs its first parent (detail panel, #58). */
export async function gitCommitFiles(repoPath: string, oid: string): Promise<CommitFile[]> {
  return invoke<CommitFile[]>("git_commit_files", { repoPath, oid });
}

/** Unified diff of one file in `oid` relative to its first parent (#221). */
export async function gitCommitFileDiff(
  repoPath: string,
  oid: string,
  filePath: string,
): Promise<string> {
  return invoke<string>("git_commit_file_diff", { repoPath, oid, filePath });
}

// ----- Mutating actions: VSCode "Git Graph"-parity commit context menu -----
//
// Each shells out to the git CLI in the backend and resolves to void on
// success, or rejects with the git stderr message on failure (including
// conflicts). Callers reload the graph + refresh the SCM panel afterwards.

/** `git reset` mode. */
export type ResetMode = "soft" | "mixed" | "hard";

/** Checkout a branch (attached HEAD) or a commit OID (detached HEAD). */
export async function gitCheckout(repoPath: string, target: string): Promise<void> {
  await invoke("git_checkout", { repoPath, target });
}

/** Create branch `name` at `oid`; optionally check it out. */
export async function gitCreateBranch(
  repoPath: string,
  name: string,
  oid: string,
  checkout: boolean,
): Promise<void> {
  await invoke("git_create_branch", { repoPath, name, oid, checkout });
}

/** Create a lightweight tag `name` at `oid`. */
export async function gitCreateTag(repoPath: string, name: string, oid: string): Promise<void> {
  await invoke("git_create_tag", { repoPath, name, oid });
}

/** Cherry-pick `oid` onto the current branch. */
export async function gitCherryPick(repoPath: string, oid: string): Promise<void> {
  await invoke("git_cherry_pick", { repoPath, oid });
}

/** Revert `oid` on the current branch. */
export async function gitRevert(repoPath: string, oid: string): Promise<void> {
  await invoke("git_revert", { repoPath, oid });
}

/** Merge `target` (branch or OID) into the current branch. */
export async function gitMerge(repoPath: string, target: string): Promise<void> {
  await invoke("git_merge", { repoPath, target });
}

/** Rebase the current branch onto `oid`. */
export async function gitRebase(repoPath: string, oid: string): Promise<void> {
  await invoke("git_rebase", { repoPath, oid });
}

/** Reset the current branch to `oid` with the given mode. */
export async function gitReset(repoPath: string, oid: string, mode: ResetMode): Promise<void> {
  await invoke("git_reset", { repoPath, oid, mode });
}

export interface BranchAuthor {
  name: string;
  /** The branch creator: author of its first unique commit; tip author for
   *  fully-merged branches (#376). */
  author: string;
  remote: boolean;
}

/** Branch → creator list for the author filter (#376). */
export async function gitBranchAuthors(repoPath: string): Promise<BranchAuthor[]> {
  return invoke<BranchAuthor[]>("git_branch_authors", { repoPath });
}

/** Fetch from every remote with pruning (#370). */
export async function gitFetch(repoPath: string): Promise<void> {
  await invoke("git_fetch", { repoPath });
}

/** Fast-forward pull on the current branch (#377). */
export async function gitPull(repoPath: string): Promise<void> {
  await invoke("git_pull", { repoPath });
}

/** Commits `name`'s upstream has that the local branch lacks; null when no
 *  upstream is configured (#377). */
export async function gitBranchBehindUpstream(
  repoPath: string,
  name: string,
): Promise<number | null> {
  return invoke<number | null>("git_branch_behind_upstream", { repoPath, name });
}

/** Delete a local branch; `force` drops unmerged commits (#371). */
export async function gitDeleteBranch(
  repoPath: string,
  name: string,
  force: boolean,
): Promise<void> {
  await invoke("git_delete_branch", { repoPath, name, force });
}

/** Delete `name` on `remote` (git push <remote> --delete <name>) (#371). */
export async function gitDeleteRemoteBranch(
  repoPath: string,
  remote: string,
  name: string,
): Promise<void> {
  await invoke("git_delete_remote_branch", { repoPath, remote, name });
}

/** Checkout a remote-tracking branch (#432): creates a local branch tracking
 *  `<remote>/<name>`, or plainly checks out an existing local `name`. */
export async function gitCheckoutTracking(
  repoPath: string,
  remote: string,
  name: string,
): Promise<void> {
  await invoke("git_checkout_tracking", { repoPath, remote, name });
}

/** Outcome of a local-branch sync (#432). */
export interface SyncLocalBranchesResult {
  /** Branches fast-forwarded to their upstream. */
  fast_forwarded: string[];
  /** Branches diverged (ahead AND behind) — left untouched, reported. */
  diverged: string[];
  /** Branches skipped for safety (dirty checked-out tree, refused ff). */
  skipped: string[];
}

/** Fetch + fast-forward local branches strictly behind their upstream (#432).
 *  Diverged branches are reported, never moved. */
export async function gitSyncLocalBranches(
  repoPath: string,
): Promise<SyncLocalBranchesResult> {
  return invoke<SyncLocalBranchesResult>("git_sync_local_branches", { repoPath });
}

/** An open GitHub pull request decorating a branch tip (#448, #459). The
 *  three status fields are populated only when the backend had a GitHub token
 *  (GraphQL path); on the tokenless REST path they arrive as `null`. */
export interface OpenPr {
  number: number;
  title: string;
  headRef: string;
  htmlUrl: string;
  draft: boolean;
  /** CI rollup for the PR's head commit; `null` when no checks / no token. */
  ciStatus: "success" | "failure" | "pending" | null;
  /** Aggregate review state; `null` when unrequested / no token. */
  reviewDecision: "approved" | "changes_requested" | "review_required" | null;
  /** Issue-comment count; `null` on the tokenless REST path. */
  commentCount: number | null;
}

/** Open PRs for the repo's GitHub remote. Degrades to `[]` — never
 *  rejects — for repos without a GitHub remote, offline machines, and
 *  rate-limit errors; the backend caches per-repo results briefly. */
export async function gitOpenPrs(repoPath: string): Promise<OpenPr[]> {
  return invoke<OpenPr[]>("git_open_prs", { repoRoot: repoPath });
}
