# Filtered discard needs a filter-aware status oracle

The CI failure in `discarding_runs_the_smudge_filter_like_git_checkout` reported
`staged.txt` as modified even though discard restored its expected `S` contents
and HEAD stored `s`. The test used libgit2 status, which cannot run the external
`tr A-Z a-z` clean filter. A stat-cache hit could hide that limitation; a miss
compared the uppercase worktree bytes directly against the lowercase blob.

Reproduction: after discard, change only the restored file's modification time
to a fixed old value. The original status assertion then fails deterministically
with the same modified row as CI, without changing the restored content.

The test now uses native `git status --porcelain=v1 --untracked-files=all`, checks
its successful exit, and requires empty output. This still verifies both index
and worktree cleanliness, including force-discard of a staged edit, while the
existing content assertions verify smudging of modified/deleted/staged files
and restoration of an unfiltered file. Keep the metadata perturbation: do not
replace it with a sleep, retry, or assumption about filesystem clock precision.

Production discard and SCM status are unchanged. This corrects the oracle for
the external-filter checkout contract, not libgit2's external-filter support.
