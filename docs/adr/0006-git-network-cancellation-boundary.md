# ADR 0006: Git network cancellation and mutation boundary

Status: Accepted

Governs: `src-tauri/src/git_actions.rs`, `src/lib/domain/git-network-operation.ts`, `src/lib/state/git-graph-refresh.ts`, `src/lib/components/GitGraphView.svelte`

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
- Fetch enumerates the remotes eligible for `git fetch --all`, preserving the
  `remote.<name>.skipFetchAll` and legacy `skipDefaultUpdate` opt-outs, and
  fetches each eligible remote separately with `--prune --atomic`; Git does not
  allow `--all` and `--atomic` when more than one remote participates. Each
  completed remote therefore has an internally atomic ref update. Cancellation
  stops before starting the next remote: completed remotes stay updated and
  later remotes stay unchanged. Consumers reload repository truth, and a later
  fetch reconciles the remaining remotes. An ordinary error from one remote is
  recorded while the remaining eligible remotes are still attempted, matching
  `fetch --all`; the command returns an aggregate error after the sequence.
  Cancellation still short-circuits immediately. The worktree and index are
  not mutated.
- Pull is two phases: cancellable `git fetch --atomic`, then non-cancellable
  `git merge --ff-only @{upstream}`. The cancellation flag is checked at the
  boundary. Before the local phase starts, the backend publishes that the task
  is no longer cancellable. The UI keeps truthful progress visible as
  `Finishing Git pull…` but removes Cancel, including when a cancellation click
  races with the phase transition. Cancellation before the boundary leaves
  HEAD/index/worktree unchanged and creates no undo entry. Once the local
  fast-forward begins it is allowed to finish; a moved HEAD returns the normal
  backend-authored undo snapshot even if a late cancellation request arrived.
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
- a two-remote fetch proves eligible remotes update normally while opted-out
  remotes remain untouched, then cancels between remotes and proves the
  completed remote is fully updated while the unstarted remote remains at its
  previous ref set until a later reconciliation fetch; a multi-ref remote also
  proves an in-flight cancellation and a rejected ref transaction cannot expose
  a partial remote-tracking ref set; a broken first remote proves its error is
  returned without preventing a later healthy remote from updating;
- cancellation after pull's fetch but before fast-forward proves no HEAD move or
  undo, then proves a later pull and its undo both work;
- a late cancellation at fast-forward start proves the local mutation completes
  and returns a valid undo snapshot; browser coverage pauses at the same phase
  boundary and proves Cancel disappears before completion while the resulting
  pull still records its undo snapshot;
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
