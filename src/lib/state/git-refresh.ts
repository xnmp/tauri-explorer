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

export interface GitChange {
  /** Repo root the change belongs to; null when unknown. */
  repoRoot: string | null;
  /** "watcher" = backend filesystem watcher; "local" = an action in this app. */
  source: "watcher" | "local";
}

type Subscriber = (change: GitChange) => void;

const subscribers = new Set<Subscriber>();
let listenerAttached = false;

async function ensureWatcherListener(): Promise<void> {
  if (listenerAttached) return;
  listenerAttached = true;
  try {
    await listen<string>("git-status-changed", (event) => {
      dispatch({ repoRoot: event.payload ?? null, source: "watcher" });
    });
  } catch {
    // Listener attach fails gracefully in non-Tauri contexts (E2E browser).
  }
}

function dispatch(change: GitChange): void {
  for (const fn of [...subscribers]) fn(change);
}

/** Subscribe to git changes (watcher + local). Returns an unsubscribe fn. */
export async function subscribeGitChanges(fn: Subscriber): Promise<() => void> {
  subscribers.add(fn);
  await ensureWatcherListener();
  return () => subscribers.delete(fn);
}

/** Announce a git mutation performed by this app (stage/commit/discard…). */
export function notifyLocalGitChange(repoRoot: string | null): void {
  dispatch({ repoRoot, source: "local" });
}
