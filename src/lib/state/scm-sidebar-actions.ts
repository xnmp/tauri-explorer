/**
 * Source Control sidebar actions and their feedback: init, commit, discard /
 * remove, .gitignore, archive, Trash, and abort / continue of an
 * in-progress operation. Each reports through a toast and, where the working
 * tree changed outside the store's own mutations, refreshes the store.
 * Extracted from ScmSidebarView.svelte (#1372).
 */

import { gitAddToGitignore, gitArchiveUntracked, gitInit, gitTrashUntracked } from "$lib/api/git";
import type { ScmStore } from "./scm.svelte";
import { toastStore } from "./toast.svelte";

type ScmActionsStore = Pick<
  ScmStore,
  "repoRoot" | "discard" | "commit" | "refresh" | "setActivePath" | "abortOperation" | "continueRebase"
>;

export interface DiscardTarget {
  paths: string[];
  /** Untracked files are deleted from disk ("Remove"), not reverted. */
  isUntracked: boolean;
}

const countLabel = (paths: string[]) => (paths.length === 1 ? paths[0] : `${paths.length} files`);
const itemCount = (paths: string[]) => `${paths.length} item${paths.length === 1 ? "" : "s"}`;

export function createScmSidebarActions(scm: () => ScmActionsStore) {
  async function initRepo(path: string | undefined): Promise<void> {
    if (!path) return;
    const r = await gitInit(path);
    if (!r.ok) {
      toastStore.error(`git init failed: ${r.error}`);
      return;
    }
    toastStore.show(`Initialized git repository at ${r.data}`, "success");
    await scm().setActivePath(path);
  }

  async function commit(opts: { forceAmend?: boolean } | undefined, amendMode: boolean): Promise<void> {
    const wasAmend = amendMode || opts?.forceAmend;
    const result = await scm().commit(opts);
    if (result.ok) {
      toastStore.show(wasAmend ? "Amended last commit" : "Commit created", "success");
    }
  }

  async function discard(target: DiscardTarget): Promise<void> {
    const r = await scm().discard(target.paths);
    if (!r.ok) {
      toastStore.error(`${target.isUntracked ? "Remove" : "Discard"} failed: ${r.error}`);
      return;
    }
    toastStore.success(
      target.isUntracked
        ? `Removed ${countLabel(target.paths)}`
        : `Discarded changes in ${countLabel(target.paths)}`,
    );
  }

  async function ignore(path: string): Promise<void> {
    const store = scm();
    if (!store.repoRoot) return;
    const r = await gitAddToGitignore(store.repoRoot, path);
    if (!r.ok) {
      toastStore.error(`Ignore failed: ${r.error}`);
      return;
    }
    toastStore.success(`Added ${r.data} to .gitignore`);
    await store.refresh();
  }

  async function archive(paths: string[]): Promise<void> {
    const store = scm();
    if (!store.repoRoot) return;
    const r = await gitArchiveUntracked(store.repoRoot, paths);
    if (!r.ok) {
      toastStore.error(`Archive failed: ${r.error}`);
      return;
    }
    toastStore.success(`Archived ${itemCount(paths)} to .archive`);
    await store.refresh();
  }

  async function trash(paths: string[]): Promise<void> {
    const store = scm();
    if (!store.repoRoot) return;
    const r = await gitTrashUntracked(store.repoRoot, paths);
    if (!r.ok) {
      await store.refresh();
      toastStore.error(`Move to Trash failed: ${r.error}`);
      return;
    }
    toastStore.success(`Moved ${itemCount(paths)} to Trash`);
    await store.refresh();
  }

  async function abortOperation(label: string): Promise<void> {
    const r = await scm().abortOperation();
    if (!r.ok) {
      toastStore.error(`Abort failed: ${r.error}`);
      return;
    }
    toastStore.success(`${label} aborted`);
  }

  async function continueRebase(): Promise<void> {
    const r = await scm().continueRebase();
    if (!r.ok) {
      toastStore.error(`Rebase continue failed: ${r.error}`);
      return;
    }
    toastStore.success("Rebase continued");
  }

  return { initRepo, commit, discard, ignore, archive, trash, abortOperation, continueRebase };
}
