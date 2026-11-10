# Discarding a deleted file must not delete a directory now in its place (#1606)

Restoring a tracked file `a` with a forced checkout removed whatever stood at
`a`: after `rm a && mkdir a && echo q > a/q`, discarding the "deleted a" row
silently deleted the untracked `a/q` (matching `git checkout -- a`, without the
warning the panel owes the user).

Fix (`git_discard.rs`): if a non-empty real directory stands at a tracked
blob/symlink path, refuse with an error naming it; an empty one is removed with
`remove_dir` (which fails rather than delete anything created since) and the
file restored. A submodule's directory at a gitlink path is left to checkout.
The same check covers ancestors: a file where a tracked path's parent
directory was would also be deleted, so that is refused too.
