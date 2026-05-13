/**
 * Source-control state (#54).
 *
 * Reactive store that tracks the git repo for the active pane, fetches the
 * summary (staged / changes / untracked / merge), and coordinates stage /
 * unstage / discard / commit actions. Listens for `git-status-changed` from
 * the Rust watcher (`git.rs`) to refresh without polling.
 */

import {
  gitCommit,
  gitDiscard,
  gitRepoRoot,
  gitStage,
  gitSummary,
  gitUnstage,
  gitUnwatchRepo,
  gitWatchRepo,
  type GitFileEntry,
  type GitStatusSummary,
} from "$lib/api/files";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { gitStatusStore } from "./git-status.svelte";

const EMPTY_SUMMARY: GitStatusSummary = {
  is_repo: false,
  repo_root: null,
  branch: null,
  detached: false,
  staged: [],
  changes: [],
  untracked: [],
  merge: [],
};

function createScmStore() {
  let activePath = $state<string>("");
  let repoRoot = $state<string | null>(null);
  let summary = $state<GitStatusSummary>(EMPTY_SUMMARY);
  let loading = $state(false);
  let commitMessage = $state("");
  let amend = $state(false);
  let commitError = $state<string | null>(null);
  let selectedPath = $state<string | null>(null);
  let activeDiff = $state<{ path: string; staged: boolean } | null>(null);
  let watcherPath: string | null = null;
  let unlistenWatcher: UnlistenFn | null = null;

  async function detectRepo(path: string): Promise<string | null> {
    if (!path) return null;
    const r = await gitRepoRoot(path);
    return r.ok ? r.data : null;
  }

  async function refresh(): Promise<void> {
    if (!repoRoot) {
      summary = EMPTY_SUMMARY;
      return;
    }
    loading = true;
    const result = await gitSummary(repoRoot);
    loading = false;
    summary = result.ok ? result.data : EMPTY_SUMMARY;
    gitStatusStore.refresh();
  }

  async function setActivePath(path: string): Promise<void> {
    console.log("[SCM] setActivePath called:", path, "current:", activePath);
    if (path === activePath) return;
    activePath = path;
    const detected = await detectRepo(path);
    console.log("[SCM] detectRepo result:", detected, "current repoRoot:", repoRoot, "activePath still:", activePath);
    if (activePath !== path) { console.log("[SCM] stale path, bailing"); return; }
    if (detected === repoRoot) { console.log("[SCM] repo unchanged, bailing"); return; }

    console.log("[SCM] repo changed! old:", repoRoot, "new:", detected);
    // tear down existing watcher
    if (watcherPath) {
      try { await gitUnwatchRepo(watcherPath); } catch (e) { console.error("[SCM] unwatch error:", e); }
      watcherPath = null;
    }
    repoRoot = detected;
    selectedPath = null;
    activeDiff = null;

    if (repoRoot) {
      await gitWatchRepo(repoRoot);
      watcherPath = repoRoot;
    }
    await refresh();
    console.log("[SCM] refresh done, is_repo:", summary.is_repo, "repoRoot:", repoRoot);
  }

  function filterToDir<T extends { path: string }>(entries: T[]): T[] {
    if (!activePath || !repoRoot || activePath === repoRoot) return entries;
    const prefix = activePath + "/";
    return entries.filter((e) => {
      const fullPath = repoRoot + "/" + e.path;
      return fullPath.startsWith(prefix);
    });
  }

  async function initWatcherListener(): Promise<void> {
    if (unlistenWatcher) return;
    try {
      unlistenWatcher = await listen<string>("git-status-changed", (event) => {
        if (repoRoot && event.payload === repoRoot) {
          refresh();
        }
      });
    } catch {
      // Listener attach fails gracefully in non-Tauri contexts (E2E browser).
    }
  }

  async function stage(paths: string[]): Promise<void> {
    if (!repoRoot || paths.length === 0) return;
    await gitStage(repoRoot, paths);
    await refresh();
  }

  async function unstage(paths: string[]): Promise<void> {
    if (!repoRoot || paths.length === 0) return;
    await gitUnstage(repoRoot, paths);
    await refresh();
  }

  async function discard(paths: string[], force = false): Promise<{ ok: boolean; error?: string }> {
    if (!repoRoot || paths.length === 0) return { ok: true };
    const r = await gitDiscard(repoRoot, paths, { force });
    await refresh();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /**
   * Commit staged changes. Amend-no-edit (empty message) only happens when
   * the amend checkbox is ticked OR `forceAmend` is true (Ctrl+Enter).
   */
  async function commit(opts?: { forceAmend?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const msg = commitMessage.trim();
    if (!repoRoot) return { ok: false, error: "not a git repository" };
    const hasStaged = summary.staged.length > 0 || summary.merge.length > 0;
    const effectiveAmend = amend || (msg.length === 0 && hasStaged && !!opts?.forceAmend);
    if (msg.length === 0 && !effectiveAmend) {
      commitError = "Commit message cannot be empty";
      return { ok: false, error: commitError };
    }
    if (!hasStaged && !amend) {
      commitError = "Nothing to commit — stage some changes first";
      return { ok: false, error: commitError };
    }
    commitError = null;
    const r = await gitCommit(repoRoot, msg, { amend: effectiveAmend });
    if (!r.ok) {
      commitError = r.error;
      return { ok: false, error: r.error };
    }
    commitMessage = "";
    amend = false;
    await refresh();
    return { ok: true };
  }

  function setCommitMessage(msg: string): void {
    commitMessage = msg;
    if (commitError && msg.trim().length > 0) commitError = null;
  }

  function setAmend(value: boolean): void {
    amend = value;
  }

  function setSelected(path: string | null): void {
    selectedPath = path;
  }

  function openDiff(path: string, staged: boolean): void {
    activeDiff = { path, staged };
    selectedPath = path;
  }

  function closeDiff(): void {
    activeDiff = null;
  }

  function orderedRows(): GitFileEntry[] {
    return [...summary.merge, ...summary.staged, ...summary.changes, ...summary.untracked];
  }

  function moveSelection(delta: 1 | -1): void {
    const rows = orderedRows();
    if (rows.length === 0) return;
    const currentIdx = selectedPath == null ? -1 : rows.findIndex((r) => r.path === selectedPath);
    let next = currentIdx + delta;
    if (next < 0) next = 0;
    if (next >= rows.length) next = rows.length - 1;
    selectedPath = rows[next]?.path ?? null;
  }

  return {
    // readonly accessors
    get activePath() { return activePath; },
    get repoRoot() { return repoRoot; },
    get summary() { return summary; },
    get filteredSummary(): GitStatusSummary {
      return {
        ...summary,
        staged: filterToDir(summary.staged),
        changes: filterToDir(summary.changes),
        untracked: filterToDir(summary.untracked),
        merge: filterToDir(summary.merge),
      };
    },
    get loading() { return loading; },
    get commitMessage() { return commitMessage; },
    get amend() { return amend; },
    get commitError() { return commitError; },
    get selectedPath() { return selectedPath; },
    get activeDiff() { return activeDiff; },

    // actions
    setActivePath,
    refresh,
    stage,
    unstage,
    discard,
    commit,
    setCommitMessage,
    setAmend,
    setSelected,
    openDiff,
    closeDiff,
    moveSelection,
    initWatcherListener,
  };
}

export const scmStore = createScmStore();
