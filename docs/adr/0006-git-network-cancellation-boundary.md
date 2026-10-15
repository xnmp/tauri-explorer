# ADR 0006: Git network cancellation and mutation boundary

Status: Accepted

Governs: `src-tauri/src/github.rs`, `src/lib/state/git-pr-mutations.svelte.ts`, `src/lib/state/git-pr-session.svelte.ts`, `src/lib/api/git-log.ts`, `src-tauri/src/git_actions.rs`, `src/lib/domain/git-network-operation.ts`, `src/lib/state/git-graph-refresh.ts`, `src/lib/components/GitGraphView.svelte`

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
  boundary. The caller supplies a per-invocation IPC phase channel before pull
  starts; before the local phase starts, the backend must successfully send
  that the task is no longer cancellable. A missing/broken channel fails closed
  before HEAD/index/worktree can move. The UI keeps truthful progress visible
  as `Finishing Git pull…` but removes Cancel, including when a cancellation
  click races with delayed phase delivery. Cancellation before the boundary
  leaves HEAD/index/worktree unchanged and creates no undo entry. Once the
  local fast-forward begins it is allowed to finish; a moved HEAD returns the
  normal backend-authored undo snapshot even if a late cancellation request
  arrived.
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
  pull still records its undo snapshot; a real command-channel test verifies
  the serialized phase payload and proves channel delivery failure refuses the
  local fast-forward;
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


## GitHub PR mutation boundary (#1082)

Create, merge and approve are remote GitHub mutations, not local Git changes.
They run `gh` with `--repo github.com/owner/name`, bound to the confirmed badge
repository or current branch context. The default CLI hostname cannot retarget
that confirmation. No local branch deletion or undo is implied; a successful
merge command may have queued a merge rather than completed it.

A repository owner survives pane disposal in each window. Pending admission,
outcomes and uncertain errors remain observable on remount. Disposal unregisters
only badge refresh observers; it neither cancels nor repeats the command. The
Rust process additionally holds one admission guard per case-insensitive GitHub
repository across all windows and worktrees until the child is reaped and badges
invalidated. This process-wide guard refuses concurrent submissions before spawn.
It is not a cross-process or across-restart exactly-once guarantee. If pipe
collection or waiting fails before reap can be established, native admission
fails closed until process exit; checking GitHub alone does not unlock that
native target while an unobserved child could still be running.

Before spawn, validation, admission and executable failures are known refusals
and may be retried. After spawn, any failure is conservatively uncertain:
GitHub may have accepted the mutation before its acknowledgement was lost.
There is no automatic retry. Badge invalidation and reload reconcile the visible
remote state; an uncertain retry requires the user to confirm they checked
GitHub. A refresh is not proof of non-acceptance (approval could already exist,
a PR may be outside the bounded list, or a merge could be queued).

Window teardown does not kill the native blocking task; its process guard
continues to own work even when that window cannot receive the result. Closing
the whole app or a process crash can lose both acknowledgement and admission.
On restart no mutation is replayed; inspect GitHub before resubmitting. Results
are retained for this window session, not persisted as a durable operation log.

| Boundary | Observable contract | Behavioral proof |
| --- | --- | --- |
| Pre-spawn validation/executable failure | No accepted mutation, actionable error, admission released | `pr_actions_refuse_stale_or_detached_head_before_spawning`, `pr_actions_success_invalidates_badges_and_missing_cli_is_actionable` |
| Remote acceptance then lost acknowledgement | Accepted marker written once; uncertain error, cache invalidated; no replay | `pr_actions_repair_accepted_then_lost_ack_is_uncertain_and_never_replayed`; deferred uncertainty/remount test in `git-pr-mutation-repair.test.ts` |
| Pane teardown while pending | Remount stays busy, duplicate refused, eventual outcome and refreshed badge observable | Deferred remount test in `git-pr-mutation-repair.test.ts`; `git-graph-pr-mutation-repair.spec.ts` |
| Another window/worktree while pending | Second native invocation refused without spawning, allowed only after reap | `pr_actions_repair_other_windows_are_refused_until_child_is_reaped` (detached native worker independent of mounted caller) |
| Concurrent panes | One command runs, both panes observe its outcome | Simultaneous session test in `git-pr-mutation-repair.test.ts` |
| Uncertain retry | Warning retained across remount; retry blocked until explicit check acknowledgement | Deferred uncertainty/remount test and browser uncertainty test |
| Process loss/restart | No automatic replay; remote state must be inspected | Structural policy: no persisted replay queue or startup mutation dispatch; no claim of crash recovery/exactly-once delivery |

The native lost-ack fixture records simulated remote acceptance *before* failing,
so it tests the distributed uncertainty boundary rather than just CLI rejection.
The browser suite is UI proof; it does not claim a real GitHub mutation occurred.
