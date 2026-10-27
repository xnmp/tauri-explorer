/**
 * Mock Git working-tree commands: status, stage/unstage/discard, commit, diffs, in-progress
 * operation aborts, watching and the cancellable fetch/pull network operation.
 * Split out of mock-invoke.ts (#1372); `mockInvoke` dispatches every family.
 */
import type { GitNetworkPhaseEvent } from "$lib/domain/git-network-operation";
import { getMockControl } from "./mock-control";
import { MOCK_GRAPH_REFS } from "./mock-fixtures";
import type { CommandHandler } from "./mock-dispatch";
import { hunkState, LOAD_REPO_PREFIX, loadRepoIndex, MOCK_REPO_ROOT, mockAppendCommit, mockClearOperation, mockDetached, mockDiscardPath, mockGit, mockGitArchived, mockGitCommits, mockGitignored, mockGitSummary, mockHeadOid, mockStagePath, mockUnstagePath, removeFrom, upsert } from "./mock-git-state";

let pendingGitNetworkOperation:
  | {
      taskId: number;
      cancellable: boolean;
      reject: (reason: Error) => void;
      onPhase?: (phase: GitNetworkPhaseEvent) => void;
    }
  | undefined;

export function holdGitNetworkOperation(
  command: "git_fetch" | "git_pull" | "git_delete_remote_branch",
  args: Record<string, unknown>,
): Promise<never> | null {
  if (new URLSearchParams(location.search).get("mockGitNetwork") !== command) return null;
  return new Promise<never>((_resolve, reject) => {
    pendingGitNetworkOperation = { taskId: Number(args.taskId), cancellable: true, reject };
  });
}

function holdGitPullAtFastForwardBoundary(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> | null {
  const boundary = new URLSearchParams(location.search).get("mockGitPullBoundary");
  if (boundary !== "fast_forward" && boundary !== "late_cancel") {
    return null;
  }

  const taskId = Number(args.taskId);
  const onPhase = args.onPhase as ((phase: GitNetworkPhaseEvent) => void) | undefined;
  const before_oid = mockHeadOid();
  const branch = mockDetached
    ? null
    : ((MOCK_GRAPH_REFS[before_oid] ?? []).find((ref) => ref.kind === "LocalBranch")?.name ??
      null);

  return new Promise((resolve, reject) => {
    pendingGitNetworkOperation = { taskId, cancellable: false, reject, onPhase };
    if (boundary === "fast_forward") onPhase?.({ taskId, cancellable: false });
    window.addEventListener(
      "tauri-explorer:mock-git-pull-finish",
      () => {
        if (pendingGitNetworkOperation?.taskId === taskId) {
          pendingGitNetworkOperation = undefined;
        }
        const after_oid = mockAppendCommit("Pull from upstream");
        resolve({ kind: "head_move", operation: "pull", branch, before_oid, after_oid });
      },
      { once: true },
    );
  });
}

export const gitCommands: Record<string, CommandHandler> = {


  get_git_status: (args: Record<string, unknown>) => {
    const path = args.path as string;
    // Mock: treat /home/user/Documents/project as a git repo
    if (path.startsWith("/home/user/Documents/project")) {
      return {
        is_git_repo: true,
        statuses: {
          "App.tsx": "Modified",
          "index.css": "Modified",
          "router.tsx": "Untracked",
          "src": "Modified",
          "CHANGELOG.md": "Modified",
          ".env.example": "Untracked",
        },
      };
    }
    return { is_git_repo: false, statuses: {} };
  },
  cancel_get_git_status: () => {},

  // ----- SCM git backend (#53) mock -----

  git_init: (args: Record<string, unknown>) => {
    return args.path as string;
  },

  git_repo_root: (args: Record<string, unknown>) => {
    const p = args.path as string;
    // No trailing slash — must stay consistent with git_status.repo_root
    if (p?.startsWith("/home/user/Documents/project")) return "/home/user/Documents/project";
    const li = loadRepoIndex(p);
    if (li !== null) return `${LOAD_REPO_PREFIX}${li}`;
    return null;
  },

  git_directory_scope: async (args: Record<string, unknown>) => {
    const root = await gitCommands.git_repo_root(args) as string | null;
    return root ? { repo_root: root, relative_directory: (args.path as string).slice(root.length).replace(/^\/+/, "") } : null;
  },

  git_add_to_gitignore: (args: Record<string, unknown>) => {
    const entry = ((args.entry as string) || "").replace(/^\.\//, "").replace(/^\//, "");
    if (!mockGitignored.has(entry)) {
      mockGitignored.add(entry);
    }
    return entry;
  },

  git_archive_untracked: (args: Record<string, unknown>) => {
    const paths = (args.paths as string[]) ?? [];
    if (paths.length === 0 || new Set(paths).size !== paths.length || paths.some((path) => !mockGit.untracked.some((entry) => entry.path === path))) {
      throw new Error("refusing to operate on non-untracked path");
    }
    for (const path of paths) {
      removeFrom(mockGit.untracked, path);
      mockGitArchived.add(`.archive/${path}`);
    }
if (typeof window !== "undefined") {
      getMockControl().gitArchived = [...mockGitArchived];
    }
    return null;
  },

  git_trash_untracked: (args: Record<string, unknown>) => {
    const paths = (args.paths as string[]) ?? [];
    if (paths.length === 0 || new Set(paths).size !== paths.length || paths.some((path) => !mockGit.untracked.some((entry) => entry.path === path))) {
      throw new Error("refusing to operate on non-untracked path");
    }
    for (const path of paths) removeFrom(mockGit.untracked, path);
    return null;
  },

  git_status: (args: Record<string, unknown>) => {
    const repoPath = args.repoPath as string;
    const li = loadRepoIndex(repoPath);
    if (li !== null) {
      // Synthetic repos have a clean working tree (no uncommitted row).
      return {
        is_repo: true,
        repo_root: `${LOAD_REPO_PREFIX}${li}`,
        branch: "main",
        detached: false,
        staged: [],
        changes: [],
        untracked: [],
        merge: [],
        op_state: "clean",
      };
    }
    if (!repoPath?.startsWith(MOCK_REPO_ROOT)) {
      return {
        is_repo: false,
        repo_root: null,
        branch: null,
        detached: false,
        staged: [],
        changes: [],
        untracked: [],
        merge: [],
        op_state: "clean",
      };
    }
    return mockGitSummary();
  },
  cancel_git_status: () => {},
  git_stage: (args: Record<string, unknown>) => {
    const paths = (args.paths as string[]) ?? [];
    for (const p of paths) mockStagePath(p);
    return null;
  },
  git_unstage: (args: Record<string, unknown>) => {
    const paths = (args.paths as string[]) ?? [];
    for (const p of paths) mockUnstagePath(p);
    return null;
  },
  git_apply_patch: (args: Record<string, unknown>) => {
    const patch = String(args.patch ?? "");
    const action = args.action as "stage" | "unstage" | "discard";
    const path = patch.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    if (!path) throw new Error("patch is missing its target path");
    const hunkMatch = patch.match(/^@@ -(\d+)/m);
    if (!hunkMatch) throw new Error("patch is missing its hunk header");
    const hunk = Number(hunkMatch[1]);
    const state = hunkState(path);
    if (action === "stage") {
      state.staged.add(hunk);
      upsert(mockGit.staged, { path, old_path: null, status: "Modified" });
      // A partially staged file remains in Changes as well as Staged. Once
      // both mock hunks are staged, its worktree side is exhausted.
      if (state.staged.size >= 2) removeFrom(mockGit.changes, path);
    } else if (action === "unstage") {
      state.staged.delete(hunk);
      if (state.staged.size === 0) removeFrom(mockGit.staged, path);
      upsert(mockGit.changes, { path, old_path: null, status: "Modified" });
    } else {
      state.discarded.add(hunk);
    }
    return null;
  },
  git_discard: (args: Record<string, unknown>) => {
    const paths = (args.paths as string[]) ?? [];
    const options = (args.options as { force?: boolean } | null) ?? null;
    const force = options?.force ?? false;
    for (const p of paths) mockDiscardPath(p, force);
    return null;
  },
  git_commit: (args: Record<string, unknown>) => {
    const msg = (args.message as string) ?? "";
    const options = (args.options as { amend?: boolean } | null) ?? null;
    const amend = options?.amend ?? false;
    if (msg.trim().length === 0 && !amend) {
      throw new Error("commit message cannot be empty");
    }
    // Unresolved conflicts block the commit entirely (mirrors the backend
    // `index.has_conflicts()` guard). Resolving = staging moves the entry out
    // of `merge`, at which point committing is allowed.
    if (mockGit.merge.length > 0) {
      throw new Error(`resolve ${mockGit.merge.length} conflicted file(s) before committing`);
    }
    const committed = mockGit.staged.map((e) => e.path);
    if (committed.length === 0 && !amend) {
      throw new Error("nothing to commit");
    }
    // Only staged (resolved) entries become part of the commit; the working
    // tree (changes/untracked) is left untouched, mirroring the real backend.
    // A completed commit also ends any in-progress operation.
    mockGit.staged = [];
    mockGit.op_state = "clean";
    const effectiveMessage =
      msg.trim().length === 0 && amend
        ? mockGitCommits[mockGitCommits.length - 1]?.message ?? ""
        : msg;
    if (amend && mockGitCommits.length > 0) {
      const prev = mockGitCommits[mockGitCommits.length - 1];
      prev.message = effectiveMessage;
      prev.files = Array.from(new Set([...prev.files, ...committed]));
      return { commit_id: prev.commit_id, summary: effectiveMessage.split("\n")[0] };
    }
    // A fresh commit advances HEAD/main and weaves a new row onto the graph so
    // the git-graph view reflects it after its reload (#466) — mirroring the
    // real backend, which `git_log` re-reads. mockAppendCommit returns the OID.
    const commit_id = mockAppendCommit(effectiveMessage.split("\n")[0]);
    mockGitCommits.push({ message: effectiveMessage, amend, files: committed, commit_id });
    return { commit_id, summary: effectiveMessage.split("\n")[0] };
  },
  git_diff: (args: Record<string, unknown>) => {
    const p = args.path as string;
    const staged = !!((args.options as { staged?: boolean } | null)?.staged);
    // Binary files show a marker rather than a textual hunk.
    if (/\.(png|jpg|jpeg|gif|webp|ico|bin|exe|zip|pdf)$/i.test(p)) {
      return [
        `diff --git a/${p} b/${p}`,
        "index 0000000..1111111",
        `Binary files a/${p} and b/${p} differ`,
        "",
      ].join("\n");
    }
    // Two distant hunks make partial stage/unstage/discard observable in the
    // running browser, matching the real patch command's semantics.
    const state = hunkState(p);
    const visible = (hunk: number) => staged ? state.staged.has(hunk) : !state.staged.has(hunk) && !state.discarded.has(hunk);
    const lines = [
      `diff --git a/${p} b/${p}`,
      "index 1111111..2222222 100644",
      `--- a/${p}`,
      `+++ b/${p}`,
    ];
    if (visible(1)) lines.push("@@ -1,3 +1,3 @@", " import { useState } from \"react\";", "-export function App() { return null; }", "+export function App() { return <div>first hunk</div>; }");
    if (visible(10)) lines.push("@@ -10,3 +10,3 @@", " export const VERSION = \"1.0\";", "-export const FLAG = false;", "+export const FLAG = true;");
    return [...lines, ""].join("\n");
  },
  git_watch_repo: ({ repoPath }) => ({ id: crypto.randomUUID(), repoRoot: repoPath }),
  git_unwatch_repo: () => null,

  // In-progress operation abort / continue (#294): clear the mock operation
  // state so the next git_status reports a clean tree.
  git_merge_abort: () => {
    mockClearOperation();
    return null;
  },
  git_rebase_abort: () => {
    mockClearOperation();
    return null;
  },
  git_rebase_continue: () => {
    // Continue only succeeds once conflicts are resolved (staged).
    if (mockGit.merge.length > 0) {
      throw new Error("resolve conflicts before continuing the rebase");
    }
    mockClearOperation();
    return null;
  },
  git_cherry_pick_abort: () => {
    mockClearOperation();
    return null;
  },
  git_revert_abort: () => {
    mockClearOperation();
    return null;
  },
  git_fetch: (args) => {
    return holdGitNetworkOperation("git_fetch", args);
  },
  cancel_git_network_operation: (args) => {
    if (
      pendingGitNetworkOperation?.taskId === Number(args.taskId) &&
      pendingGitNetworkOperation.cancellable
    ) {
      const operation = pendingGitNetworkOperation;
      pendingGitNetworkOperation = undefined;
      operation.reject(new Error("git network operation cancelled"));
    } else if (pendingGitNetworkOperation?.taskId === Number(args.taskId)) {
      // The local fast-forward has already begun. Model delayed phase-event
      // delivery after a stale Cancel click without rejecting the pull.
      pendingGitNetworkOperation.onPhase?.({
        taskId: pendingGitNetworkOperation.taskId,
        cancellable: false,
      });
    }
    return null;
  },
  git_pull: (args) => {
    const boundary = holdGitPullAtFastForwardBoundary(args);
    if (boundary) return boundary;
    const held = holdGitNetworkOperation("git_pull", args);
    if (held) return held;
    const before_oid = mockHeadOid();
    const branch =
      mockDetached
        ? null
        : (MOCK_GRAPH_REFS[before_oid] ?? []).find((ref) => ref.kind === "LocalBranch")?.name ??
          null;
    const after_oid = mockAppendCommit("Pull from upstream");
    return { kind: "head_move", operation: "pull", branch, before_oid, after_oid };
  },
};
