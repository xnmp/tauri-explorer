/**
 * Working-tree actions of the git graph's inline commit panel on the
 * uncommitted node (#466), plus per-file diff routing (#221, #366).
 *
 * Stage/unstage/commit orchestrate the existing backend commands and refresh
 * through the standard policy — the graph's reloader plus
 * `refreshAfterGitMutation` for badges and an open SCM panel — so no private
 * refresh stack lives here (the cause of #431/#432). The commit-message
 * state machine stays in `domain/commit-panel` behind the pane's
 * `CommitPanelStore`, whose in-flight guard survives the panel closing.
 */
import type { ApiResult } from "$lib/api/common";
import { gitCommit, gitStage, gitUnstage } from "$lib/api/git";
import {
  canCommit,
  conflictCountOf,
  stagedCountOf,
  stageFilesOf,
} from "$lib/domain/commit-panel";
import { directoryKey } from "$lib/domain/path";
import type { CommitPanelStore } from "./commit-panel.svelte";
import { refreshAfterGitMutation } from "./git-graph-refresh";
import {
  UNCOMMITTED_OID,
  type DetailFile,
  type DetailSelectionToken,
  type GitGraphDetail,
} from "./git-graph-detail.svelte";
import type { ScmStore } from "./scm.svelte";
import { settingsStore } from "./settings.svelte";
import { toastStore } from "./toast.svelte";

export interface GitGraphWorkingTreeDeps {
  repoPath: string;
  detail: GitGraphDetail;
  /** Read at call time: the stores follow the graph's pane. */
  commitPanel: () => CommitPanelStore;
  scm: () => ScmStore;
  reload: () => Promise<void>;
  closeDetails: () => void;
}

/** Whether the uncommitted panel's Commit action may run now. */
export function uncommittedCommitEnabled(message: string, files: readonly DetailFile[]): boolean {
  const stageFiles = stageFilesOf(files);
  return canCommit({
    message,
    stagedCount: stagedCountOf(stageFiles),
    conflictCount: conflictCountOf(stageFiles),
  });
}

export function createGitGraphWorkingTree(deps: GitGraphWorkingTreeDeps) {
  const { repoPath, detail, reload, closeDetails } = deps;
  const scmOwnsRepo = (scm: ScmStore) =>
    !!scm.repoRoot && directoryKey(scm.repoRoot) === directoryKey(repoPath);

  /** After a stage/unstage: rebuild the panel's file list, then reload so
   *  the synthetic row's "Uncommitted Changes (N)" count is recomputed from
   *  the canonical summary. A partially-staged file is double-counted in that
   *  total (it sits in both `staged` and `changes`), so staging/unstaging it
   *  flips the count by one — without this reload the header would go stale
   *  until a watcher event (#466). */
  async function afterStageChange(selection: DetailSelectionToken | null): Promise<void> {
    await refreshAfterGitMutation(repoPath, async () => {
      await detail.refreshUncommittedFiles(selection);
      await reload();
    });
  }

  async function changeIndex(
    paths: string[],
    command: (repo: string, paths: string[]) => Promise<ApiResult<void>>,
  ): Promise<void> {
    const unique = [...new Set(paths)];
    if (unique.length === 0) return;
    const selection = detail.captureSelection();
    const result = await command(repoPath, unique);
    if (!result.ok) {
      toastStore.error(result.error);
      return;
    }
    await afterStageChange(selection);
  }

  return {
    stagePaths: (paths: string[]) => changeIndex(paths, gitStage),
    unstagePaths: (paths: string[]) => changeIndex(paths, gitUnstage),

    async commit(): Promise<void> {
      const commitPanel = deps.commitPanel();
      if (!uncommittedCommitEnabled(commitPanel.message, detail.files)) return;
      const message = commitPanel.message;
      // Atomic in-flight guard: begin() returns false if a commit is already
      // running for this pane, so Escape + reopen mid-flight can't start a
      // second concurrent gitCommit (which, absent the backend guard, could
      // be empty).
      if (!commitPanel.begin()) return;
      const selection = detail.captureSelection();
      const result = await gitCommit(repoPath, message);
      if (!result.ok) {
        // Preserve the typed message so the user can fix and retry (#466).
        commitPanel.fail(result.error);
        toastStore.error(result.error);
        return;
      }
      commitPanel.succeed();
      toastStore.success("Changes committed");
      // Invalidate old graph data and notify badges/SCM before publishing the
      // post-commit graph, then rebuild the still-open panel (#102, #432).
      await refreshAfterGitMutation(repoPath, reload);
      const refreshed = await detail.refreshUncommittedFiles(selection);
      const scm = deps.scm();
      if (scmOwnsRepo(scm)) void scm.refresh();
      // Working tree now clean → the synthetic row is gone; close the stale panel.
      if (refreshed && detail.files.length === 0) closeDetails();
    },

    /** Expand/collapse one file's diff below its row, or route it to the
     *  preview pane when that is open (#366). */
    async toggleFileDiff(file: DetailFile): Promise<void> {
      const forPreview = detail.selected;
      if (settingsStore.showPreviewPane && forPreview) {
        const scm = deps.scm();
        if (forPreview.oid === UNCOMMITTED_OID) {
          // Working-tree diffs go through the SCM store's own loader, which
          // needs its repoRoot on THIS repo; otherwise keep the inline diff.
          if (scmOwnsRepo(scm)) {
            detail.closeDiff();
            scm.openDiff(file.path, !!file.staged);
            return;
          }
        } else {
          detail.closeDiff();
          scm.openCommitDiff(repoPath, forPreview.oid, file.path, detail.comparison?.older.oid);
          return;
        }
      }
      const error = await detail.toggleDiff(file);
      if (error) toastStore.error(error);
    },
  };
}

export type GitGraphWorkingTree = ReturnType<typeof createGitGraphWorkingTree>;
