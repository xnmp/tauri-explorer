/**
 * Single source of git change notifications (refactor #5).
 *
 * Owns the one Tauri `git-status-changed` listener and fans changes out to
 * subscribers; local mutations (stage/unstage/commit/discard) push through
 * the same channel. Previously the SCM store and the per-directory badge
 * store each attached their own listener and the SCM store imperatively
 * chained the badge store's refresh — now both consume one stream.
 *
 * The backend split (files/git_status.rs for badges vs git.rs for the SCM
 * summary) is intentional and unchanged; only the frontend coordination is
 * unified.
 */

import { listen } from "@tauri-apps/api/event";
import { E2E_HOOKS_ENABLED } from "$lib/domain/e2e-hooks";

export interface GitChange {
  /** Repo root the change belongs to; null when unknown. */
  repoRoot: string | null;
  /** "watcher" = backend filesystem watcher; "local" = an action in this app. */
  source: "watcher" | "local";
}

type Subscriber = (change: GitChange) => void;

const subscribers = new Set<Subscriber>();
let listenerAttached = false;
let listenerPending: Promise<boolean> | null = null;

/** Cache readers need acknowledged event delivery before acquiring coverage.
 * A failed attachment is retryable; local subscribers remain usable meanwhile. */
export function ensureGitWatcherListener(): Promise<boolean> {
  if (listenerAttached) return Promise.resolve(true);
  if (listenerPending) return listenerPending;
  listenerPending = listen<string>("git-status-changed", (event) => {
      dispatch({ repoRoot: event.payload ?? null, source: "watcher" });
    }).then(() => { listenerAttached = true; return true; }, () => false)
    .finally(() => { listenerPending = null; });
  return listenerPending;
}

function dispatch(change: GitChange): void {
  if (E2E_HOOKS_ENABLED && typeof document !== "undefined") {
    const node = document.documentElement;
    const receipts = JSON.parse(node.dataset.e2eGitChanges ?? "[]") as unknown[];
    receipts.push({ ...change, receivedAt: Date.now() });
    node.dataset.e2eGitChanges = JSON.stringify(receipts.slice(-32));
  }
  for (const fn of [...subscribers]) fn(change);
}

/** Subscribe to git changes (watcher + local). Returns an unsubscribe fn. */
export async function subscribeGitChanges(fn: Subscriber): Promise<() => void> {
  subscribers.add(fn);
  await ensureGitWatcherListener();
  return () => subscribers.delete(fn);
}

/** Announce a git mutation performed by this app (stage/commit/discard…). */
export function notifyLocalGitChange(repoRoot: string | null): void {
  dispatch({ repoRoot, source: "local" });
}

/**
 * Announce a change originating outside this app (as the filesystem watcher
 * would). Real builds get these from the Tauri `git-status-changed` event; the
 * mock backend (E2E) drives this directly to simulate external edits.
 */
export function emitWatcherGitChange(repoRoot: string | null): void {
  dispatch({ repoRoot, source: "watcher" });
}
