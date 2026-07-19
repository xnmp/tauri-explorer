/**
 * Commit-panel store (#466).
 *
 * Holds the live state instance for the git graph's uncommitted-node inline
 * commit panel, per pane. The pure transitions live in `domain/commit-panel`;
 * this wraps them in a rune so the in-flight commit guard survives the panel
 * closing and reopening (Escape → reopen mid-flight must NOT drop the guard,
 * or a second concurrent `git_commit` could fire). Keeping the instance out of
 * component-local scope also makes the guard unit-testable through the import
 * (#444).
 */

import {
  type CommitPanelState,
  initialCommitPanelState,
  setMessage as setMessageTransition,
  startCommit,
  commitSucceeded,
  commitFailed,
} from "$lib/domain/commit-panel";

function createCommitPanelStore() {
  let state = $state<CommitPanelState>(initialCommitPanelState());

  return {
    get state() {
      return state;
    },
    get message() {
      return state.message;
    },
    get phase() {
      return state.phase;
    },
    get error() {
      return state.error;
    },
    get committing() {
      return state.phase === "committing";
    },

    setMessage(message: string): void {
      state = setMessageTransition(state, message);
    },

    /**
     * Atomically enter the committing phase. Returns `false` if a commit is
     * already in flight — the guard. Callers MUST bail when it returns false,
     * so exactly one `git_commit` can be in flight per pane regardless of how
     * many times the panel is closed and reopened.
     */
    begin(): boolean {
      if (state.phase === "committing") return false;
      state = startCommit(state);
      return true;
    },

    /** Commit landed: clear the draft, return to idle. */
    succeed(): void {
      state = commitSucceeded(state);
    },

    /** Commit failed: preserve the typed message, surface the error, idle. */
    fail(error: string): void {
      state = commitFailed(state, error);
    },

    /**
     * Reset the ephemeral editor to blank — but ONLY while idle. A close (or a
     * re-open, which closes first) during an in-flight commit is a no-op, so it
     * can't reset away the guard and let a second commit start (#466).
     */
    resetIfIdle(): void {
      if (state.phase !== "committing") state = initialCommitPanelState();
    },
  };
}

export type CommitPanelStore = ReturnType<typeof createCommitPanelStore>;

// One store per pane (matches getScmStore semantics, #334): two panes each
// showing a graph keep independent commit drafts / in-flight guards.
const paneStores = new Map<string, CommitPanelStore>();

export function getCommitPanelStore(paneId: string): CommitPanelStore {
  let store = paneStores.get(paneId);
  if (!store) {
    store = createCommitPanelStore();
    paneStores.set(paneId, store);
  }
  return store;
}

/** Drop a pane's store when the pane closes (mirrors disposeScmStore, #439). */
export function disposeCommitPanelStore(paneId: string): void {
  paneStores.delete(paneId);
}
