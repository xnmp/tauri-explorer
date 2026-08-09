# ADR 0006: Git network cancellation and mutation boundary

Status: Accepted

Governs: `src-tauri/src/git_actions.rs`, `src/lib/state/git-graph-refresh.ts`, `src/lib/components/GitGraphView.svelte`

## Context

Git Graph network commands use the user's Git CLI so credential helpers, SSH
agents, and remote configuration behave exactly as they do in a terminal. A
network child can hang indefinitely, but killing a mutating Git command at an
arbitrary instruction is not transactional. Fetch may already have updated a
remote-tracking ref, pull may be moving HEAD/index/worktree, and a remote may
accept a branch deletion before the client receives its acknowledgement.

Cancellation therefore needs an explicit boundary and honest reporting. It
must never imply that a remote mutation was rolled back or manufacture an undo
snapshot from frontend state.

## Decision

- Every fetch, pull, and remote-branch deletion receives a client-generated
  task ID and registers it before spawning network work. Cancellation terminates
  the Git process tree and the command remains owned until the child is reaped.
- Fetch uses Git's atomic-ref-update option. Cancellation may observe either the
  old ref set or the fully applied new ref set, but consumers always reload from
  repository truth. The worktree and index are not mutated. A later fetch is the
  reconciliation path.
- Pull is two phases: cancellable `git fetch --atomic`, then non-cancellable
  `git merge --ff-only @{upstream}`. The cancellation flag is checked at the
  boundary. Cancellation before the boundary leaves HEAD/index/worktree
  unchanged and creates no undo entry. Once the local fast-forward begins it is
  allowed to finish; a moved HEAD returns the normal backend-authored undo
  snapshot even if a late cancellation request arrived.
- Remote deletion is an at-most-once push. Cancellation never retries. If the
  remote accepted deletion before the child was terminated, the command reports
  `git network operation cancelled; remote branch may already have been deleted`.
  The UI reloads local state, and a later fetch/prune reconciles remote-tracking
  refs. It does not claim rollback or create a remote undo action. In the
  delete-local-and-remote flow, the already-completed local deletion retains its
  independently recorded local undo entry.
- Cancellation is informational rather than a generic failure, clears the
  operation banner, skips success-only follow-up work, and reloads the graph so
  any operation that crossed an external commit point is visible.

## Crash-point verification

Rust temp-repository tests exercise the real Git CLI at each boundary:

- cancellation after an atomic fetch ref update proves refs remain valid,
  HEAD/index/worktree remain unchanged, no lock remains, and a later fetch works;
- cancellation after pull's fetch but before fast-forward proves no HEAD move or
  undo, then proves a later pull and its undo both work;
- a late cancellation at fast-forward start proves the local mutation completes
  and returns a valid undo snapshot;
- cancellation after a bare remote accepted branch deletion proves the explicit
  uncertain-result message, repository/lock consistency, and fetch/prune
  reconciliation.

## Consequences

Cancel is prompt during the potentially unbounded network phase without exposing
HEAD/index/worktree to process-tree termination. Remote deletion remains
inherently distributed and can have an uncertain outcome; the application says
so and reconciles rather than guessing. New cancellable Git mutations must define
their local commit boundary, uncertain external outcomes, and temp-repository
crash-point tests before joining this lifecycle.
