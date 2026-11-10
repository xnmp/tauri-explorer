# Branch sync must not move a branch any worktree is using (#1590)

`sync_local_branches` only recognised the current worktree's HEAD branch. A
branch checked out in another worktree got a bare `update-ref`: that worktree's
HEAD moved under its files, and it then showed the reverse of the upstream
commits as local changes. A first fix parsed `git worktree list --porcelain`,
which still missed branches being rebased or bisected (HEAD is detached, in a
linked worktree or the current one); fast-forwarding those makes `git rebase
--continue` fail with "cannot lock ref".

Fix: let git decide. Branches other than the checked-out one are advanced with
`git fetch . <upstream-ref>:refs/heads/<branch>` (plus `--no-tags --no-prune
--no-write-fetch-head --no-recurse-submodules --no-auto-gc`). Fetch refuses a
branch checked out, rebased or bisected in any worktree, refuses
non-fast-forwards, and updates the ref with an old-value check. Measured in
containers: git 2.32.7 / 2.34.1 / 2.34.8 protect only the current worktree's
checked-out branch (linked, rebase and bisect cases were moved); 2.36.6, 2.39.5
and 2.56.0 refuse all six cases (2.35 was not available to test, so the gate is
2.36). Older or unparseable `git version` falls back to a conservative mode:
skip branches listed by `git worktree list`, skip every branch while any
worktree is detached (it may be rebasing/bisecting one), and move free branches
with a compare-and-swap `update-ref`. If that listing fails, other branches are
skipped and the checked-out branch's own `merge --ff-only` still runs.

Tests run every case in both modes; rebase stops via
`GIT_SEQUENCE_EDITOR="echo break >"` (git appends the todo path), bisect via
`bisect start` + `checkout --detach`, and each asserts `rebase --continue` /
`bisect reset` still succeeds.

The fetch must not depend on user configuration meant for real remotes:
with `protocol.file.allow=never` (or `protocol.allow=never`, or
`GIT_ALLOW_PROTOCOL` without `file`) `git fetch .` is refused and every
non-current branch was skipped. `fetch_fast_forward` now passes
`-c protocol.file.allow=always`, removes `GIT_ALLOW_PROTOCOL`, clears
`fetch.bundleURI`, pins `fetch.negotiationAlgorithm=default` (accepted by every
git; 2.38+ rejects unknown values), adds `--no-write-commit-graph`, and sets
`GIT_TERMINAL_PROMPT=0` and `GIT_NO_LAZY_FETCH=1` (a partial clone's
connectivity check could otherwise fetch from its promisor remote; the variable
needs git 2.44+, older git ignores it). Test: `sync_ignores_transport_policy`.

Hooks are honoured in both modes: the user's `reference-transaction` hook sees
the update, as with `update-ref` or a plain `git fetch`, and a rejection leaves
the branch where it was and reports it skipped (git's message is logged; the
result carries names only). Test: `sync_honours_a_rejecting_reference_transaction_hook`.
