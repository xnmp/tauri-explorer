/**
 * Source-control state (#54).
 *
 * Reactive store that tracks the git repo for a pane, fetches the summary
 * (staged / changes / untracked / merge), and coordinates stage / unstage /
 * discard / commit actions. Listens for `git-status-changed` from the Rust
 * watcher (`git.rs`) to refresh without polling.
 *
 * Per-pane instances (#334): stores are created per pane via `getScmStore`,
 * so two panes on different repos show independent git panels. The summary
 * cache is shared module-wide (same repo → same data); global surfaces
 * (preview diff, palette commands) resolve `activeScmStore()`.
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
  gitMergeAbort,
  gitRebaseAbort,
  gitRebaseContinue,
  gitCherryPickAbort,
  gitRevertAbort,
  type GitFileEntry,
  type GitStatusSummary,
} from "$lib/api/files";
import type { GitOpState } from "$lib/domain/git";
import { subscribeGitChanges, notifyLocalGitChange } from "./git-refresh";

function emptySummary(): GitStatusSummary {
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

// Last known summary per repo root (#271): served immediately when a repo
// becomes active again so switching panes/tabs doesn't flash the empty
// state, then refreshed in the background. Watcher events evict entries
// for repos that changed while inactive. Shared across pane stores (#334) —
// the same repo has the same summary regardless of which pane shows it.
const summaryCache = new Map<string, GitStatusSummary>();
// Repo roots with a warm currently in flight — dedups concurrent warms
// for the same repo (#287).
const warmInFlight = new Set<string>();

async function detectRepo(path: string): Promise<string | null> {
  if (!path) return null;
  const r = await gitRepoRoot(path);
  return r.ok ? r.data : null;
}

/**
 * Background warm (#287): populate the shared summaryCache for the repo
 * containing `path` without mounting any SCM panel, so a panel's first open
 * serves a cached summary instead of flashing the empty/loading state.
 * Purely additive — it never touches any store's activePath, repoRoot,
 * watcher, or refreshGeneration, so it cannot race a panel's own
 * setActivePath flow. No-op if the repo is already cached or a warm for it
 * is in flight; failures are swallowed (best-effort).
 */
export async function warmScmSummary(path: string): Promise<void> {
  try {
    const root = await detectRepo(path);
    if (!root || summaryCache.has(root) || warmInFlight.has(root)) return;
    warmInFlight.add(root);
    try {
      const result = await gitSummary(root);
      if (result.ok && !summaryCache.has(root)) summaryCache.set(root, result.data);
    } finally {
      warmInFlight.delete(root);
    }
  } catch {
    /* best-effort warm — ignore failures */
  }
}

function createScmStore() {
  let activePath = $state<string>("");
  let repoRoot = $state<string | null>(null);
  let summary = $state<GitStatusSummary>(emptySummary());
  let loading = $state(false);
  let commitMessage = $state("");
  let amend = $state(false);
  let commitError = $state<string | null>(null);
  let selectedPath = $state<string | null>(null);
  let activeDiff = $state<{ path: string; staged: boolean } | null>(null);
  let watcherPath: string | null = null;
  let subscribed = false;

  let refreshGeneration = 0;

  /** Re-fetch this store's summary only (no cross-store side effects). */
  async function refreshSummary(): Promise<void> {
    const gen = ++refreshGeneration;
    if (!repoRoot) {
      loading = false;
      summary = emptySummary();
      return;
    }
    const root = repoRoot;
    loading = true;
    const result = await gitSummary(root);
    if (gen !== refreshGeneration) return;
    loading = false;
    summary = result.ok ? result.data : emptySummary();
    if (result.ok) summaryCache.set(root, result.data);
  }

  /** Refresh the summary and announce the change so other git consumers
   *  (per-directory badges) update from the same source. */
  async function refresh(): Promise<void> {
    await refreshSummary();
    notifyLocalGitChange(repoRoot);
  }

  async function setActivePath(path: string): Promise<void> {
    if (path === activePath) return;
    activePath = path;
    // Repo detection is itself an IPC round-trip; without the flag the view
    // renders "not a git repository" during it (#271). Every exit path below
    // ends in refreshSummary (or the competing call's), which clears it.
    loading = true;
    const detected = await detectRepo(path);
    if (activePath !== path) return;
    if (detected === repoRoot) {
      loading = false;
      return;
    }

    if (watcherPath) {
      try { await gitUnwatchRepo(watcherPath); } catch { /* non-Tauri */ }
      watcherPath = null;
    }
    repoRoot = detected;
    selectedPath = null;
    activeDiff = null;
    // Serve the last known summary for this repo (or the empty state for a
    // fresh/non-repo) while the refresh runs — never another repo's rows.
    summary = (detected && summaryCache.get(detected)) || emptySummary();

    if (repoRoot) {
      await gitWatchRepo(repoRoot);
      watcherPath = repoRoot;
    }
    await refreshSummary();
  }

  /**
   * Detach this pane's store when its panel unmounts (#334): drop the
   * watcher (refcounted in the backend) and reset the active path so a
   * remount at the same path re-runs detection and re-watches. The shared
   * summaryCache keeps the last summary for an instant repaint.
   */
  async function release(): Promise<void> {
    activePath = "";
    repoRoot = null;
    if (watcherPath) {
      const p = watcherPath;
      watcherPath = null;
      try { await gitUnwatchRepo(p); } catch { /* non-Tauri */ }
    }
  }

  function filterToDir<T extends { path: string }>(entries: T[]): T[] {
    if (!activePath || !repoRoot || activePath === repoRoot) return entries;
    const root = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
    if (activePath === root) return entries;
    const prefix = activePath + "/";
    return entries.filter((e) => {
      const fullPath = root + "/" + e.path;
      return fullPath.startsWith(prefix);
    });
  }

  async function initWatcherListener(): Promise<void> {
    if (subscribed) return;
    subscribed = true;
    // Local changes already refreshed the summary before notifying, so only
    // watcher events (changes made outside this store) trigger a re-fetch.
    await subscribeGitChanges((change) => {
      if (change.source !== "watcher") return;
      if (repoRoot && change.repoRoot === repoRoot) {
        void refreshSummary();
      } else if (change.repoRoot) {
        // An inactive repo changed: its cached summary is stale — evict so
        // the next activation fetches fresh instead of serving it (#271).
        summaryCache.delete(change.repoRoot);
      }
    });
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
    // Unresolved merge/rebase conflicts block every commit — git refuses while
    // the index has conflicts. Staging a conflict (resolving it) moves it out
    // of `merge`, so this only fires while conflicts remain.
    if (summary.merge.length > 0) {
      commitError = `Resolve ${summary.merge.length} conflicted file(s) before committing`;
      return { ok: false, error: commitError };
    }
    const hasStaged = summary.staged.length > 0;
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

  /**
   * Abort the in-progress operation reported by `summary.op_state`, then
   * refresh. Dispatches to the matching backend abort command. No-op when the
   * repo is clean.
   */
  async function abortOperation(): Promise<{ ok: boolean; error?: string }> {
    if (!repoRoot) return { ok: false, error: "not a git repository" };
    const op: GitOpState = summary.op_state;
    const abortByOp: Partial<Record<GitOpState, (r: string) => Promise<{ ok: boolean; error?: string }>>> = {
      merge: gitMergeAbort,
      rebase: gitRebaseAbort,
      cherry_pick: gitCherryPickAbort,
      revert: gitRevertAbort,
    };
    const fn = abortByOp[op];
    if (!fn) return { ok: true };
    const r = await fn(repoRoot);
    await refresh();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** Continue an in-progress rebase (conflicts resolved & staged), then refresh. */
  async function continueRebase(): Promise<{ ok: boolean; error?: string }> {
    if (!repoRoot) return { ok: false, error: "not a git repository" };
    const r = await gitRebaseContinue(repoRoot);
    await refresh();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
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
    /** True while we have nothing to show yet for the active path — repo
     *  detection or the first summary fetch is still in flight. Cached
     *  summaries keep this false, so background refreshes don't flash. */
    get pending() { return loading && !summary.is_repo; },
    get commitMessage() { return commitMessage; },
    get amend() { return amend; },
    get commitError() { return commitError; },
    get selectedPath() { return selectedPath; },
    get activeDiff() { return activeDiff; },

    // actions
    setActivePath,
    release,
    refresh,
    stage,
    unstage,
    discard,
    commit,
    abortOperation,
    continueRebase,
    setCommitMessage,
    setAmend,
    setSelected,
    openDiff,
    closeDiff,
    moveSelection,
    initWatcherListener,
  };
}

export type ScmStore = ReturnType<typeof createScmStore>;

// One store per pane (#334). Pane ids recur across tab switches, so the map
// stays small; a pane's store keeps its commit-message draft across panel
// toggles, and release() (called on panel unmount) drops its watcher.
const paneScmStores = new Map<string, ScmStore>();

export function getScmStore(paneId: string): ScmStore {
  let store = paneScmStores.get(paneId);
  if (!store) {
    store = createScmStore();
    paneScmStores.set(paneId, store);
  }
  return store;
}

/** Close the diff in every pane's store (used when a setting invalidates
 *  open diffs — a diff may be open in a non-active pane). */
export function closeAllDiffs(): void {
  for (const store of paneScmStores.values()) store.closeDiff();
}
