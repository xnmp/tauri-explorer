# Git graph rules

These cover the whole feature: `GitGraphView.svelte`, `GitAuthorAvatar.svelte`
and this directory, `state/git-graph-*.ts` and `state/git-pr-*.svelte.ts`,
`domain/git-graph*.ts`, and the Rust commands in `src-tauri/src/git_*.rs`,
`github.rs` and `git_avatar.rs`. Root `CLAUDE.md`'s refresh split applies: the
graph once built a private refresh stack and produced #431/#432.

## History and lineage

- Git-graph fork-point lookup uses exact `refs/heads/` or `refs/remotes/` identities in `git_merge_base`, never the loaded graph topology. Clear history curation before revealing the result (the ordinary branch filter uses ambiguous shorthands), page through the existing query owner, and retire lookup results on user selection/filter changes or disposal (#1083).
- Git graph lineage is first-parent topology plus the branch paths from
  `assignLayout`, never a lane number or color: paths can curve between lanes
  and color slots are recycled. Compute trace/jump semantics in the domain
  layer, then pass the classified rows and path segments to the renderer.
- Base-update merge muting follows an open PR's first-parent chain and checks
  each non-first parent against the configured base ref's reachable history.
  Keep both the base ref and selected GitHub remote in the PR IPC shape so a
  current remote-tracking base wins over a stale local base; a merge merely
  adjacent to a PR ref is not enough to classify it as housekeeping (#527).
- Graph reference disclosures capture the scroller's actual position when opened.
  A native scroll notification can arrive after the click for positioning that
  already happened. Compare positions rather than dismissing on every delivery;
  inherit the snapshot into scoped actions and focus with preventScroll. Subsequent
  vertical or horizontal movement still dismisses the anchored menu (#1082).

## Mutations, undo and network operations

- Git-graph undo snapshots come from the Rust mutation command, stay session/repository-scoped in `state/git-graph-undo.ts`, and are re-verified by `git_undo` before the inverse. Merge/pull undo requires unchanged HEAD + a clean tree; tag deletion records the raw tag-object OID so annotated tags restore exactly (#513).
- Git-graph tabs remount on activation once evicted from the retained-tab set; their snapshot cache must retain the supported 12-tab load fan-out so switching back can paint cached history instead of starting a new git-log request. External watcher changes evict the snapshot; valid cached remounts skip the redundant graph reload (#505).
- Git-graph fetch, pull, and remote-branch push share one client-ID network-operation lifecycle in `git-graph-refresh.ts`. Per ADR 0006, fetch enumerates `fetch --all`-eligible remotes (respecting `skipFetchAll`/`skipDefaultUpdate`) and updates each one atomically; ordinary remote errors are aggregated after later remotes run, while cancellation stops immediately between remotes. Only the unbounded network phase is killable: pull receives a per-invocation IPC phase channel before starting, then must deliver the transition from atomic fetch to local fast-forward (or fail closed before moving HEAD) so the banner switches to “Finishing Git pull…” and removes the now-ineffective Cancel control while preserving completed-pull undo; remote-delete cancellation reports that the remote may already have applied it (#528).

## GitHub PR mutations (ADR 0005, ADR 0006)

Git Graph PR mutations use `git_pr_action` through `gh` with an explicit selected
GitHub repository and user confirmation. Creation starts from a local branch
pill's context menu, for any local branch (not only HEAD's); the backend checks
that `refs/heads/<branch>` still exists before spawning the CLI, and
`gh pr create --head` reports a branch that was never pushed (#1847).
Every confirmation carries its displayed repository identity, which the backend
rechecks against the selected remote. A successful merge command means “merge
requested”: GitHub may enqueue it, so only refreshed badges reflect closure. PR
mutations do not delete or update local branches and have no local undo receipt.
Badge-cache revisions reject pre-mutation cache fills, including uncertain CLI
failures; the mounted PR session refreshes badges and keeps duplicate submissions
blocked through that refresh. Browser screenshots simulate GitHub, while isolated
Rust subprocess fixtures cover the production argv/cwd and CLI error boundary.
See ADR 0005 and ADR 0006.

GitHub PR mutations (#1082): keep `--repo github.com/owner/name` explicit. Pending work belongs to `git-pr-mutations.svelte.ts`, not a mounted graph session; Rust admission spans windows/worktrees of the same target. After gh starts, a failure may follow remote acceptance: invalidate badges, retain the uncertain warning, and require an explicit GitHub check before retrying (ADR 0006).

PR CLI subprocess tests must execute the checked-in shell launcher, with their
mutable response scripts read as shell input. Executing freshly written files
can fail with Linux `ETXTBSY` while another thread's fork retains a writable
descriptor. Keep the held-writer regression and do not retry mutations to mask
fixture failures (#1626).

## Author avatars (ADR 0027)

Git Graph author avatars keep display preference separate from third-party
consent: GitHub noreply addresses may resolve while Gravatar remains opt-in.
Their restart-persistent cache is derived, best-effort state: publication uses
sibling temporary files and rename, interrupted/corrupt entries are discarded,
and every storage or network failure must leave the deterministic row fallback.
Pruning must also exhaust its current candidates and return when deletion fails;
retrying an unchanged byte total after the candidate list empties can panic and
poison the process-wide lookup lock.
See ADR 0027.
Mount `GitAuthorAvatar` only while display is enabled so the off state cannot
start lookups; native responses are bounded, validated data URIs backed by the
disk cache, while the row always owns its deterministic local fallback.
Keep the avatar decoration out of Git Graph's table minimum width: at narrow
sizes it should borrow from the message cell, not widen inline commit details.

## Native tests

Native graph fixtures must wait for the reset view's `.file-list` before their
repository is deleted, because reset navigation completes asynchronously.
