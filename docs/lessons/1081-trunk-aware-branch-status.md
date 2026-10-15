# #1081 — trunk-aware branch status (merged / squashed / stale)

- "Merged" means *reachable from trunk through a merge*, not "an ancestor of
  trunk". A tip on trunk's own first-parent chain (freshly branched, or merely
  behind) is an ancestor too; `git_branch_status.rs` excludes it explicitly.
- Squash detection compares the libgit2 patch-id of the branch's combined diff
  (merge base → tip) with each non-merge trunk first-parent commit since that
  merge base. A partial squash yields a different patch-id, so it is not
  reported. Trunk commits whose context lines drifted after the squash can
  also miss; that errs towards "no badge".
- Resolve trunk from `<remote>/HEAD`, `init.defaultBranch`, `main`, `master` —
  never from HEAD — or classification changes with each checkout.
- Every search is bounded; a search that hits its limit reports `unknown`
  (no badge), never a positive status.
- The badges are informational. The graph's "Mute merge commits" toggle keeps
  keying on parent count (2+ parents); do not wire it to branch status.
