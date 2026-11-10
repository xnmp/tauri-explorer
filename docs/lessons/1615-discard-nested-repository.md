# Remove must never delete another repository or ignored files (#1615)

Status lists an untracked nested repository, and a linked worktree created
inside the repository, as one row `sub/`. Its Remove action ran
`remove_dir_all`: the nested repository's `.git` (history, stashes, unpushed
commits) and its uncommitted work were deleted with no warning beyond "untracked
file". Ignored files inside an untracked directory were deleted too, although
status never lists them.

Fix (`git_discard.rs`): before anything is removed, an untracked directory is
scanned without following links; Remove is refused, naming the path, if it or
any entry at any depth is named `.git` (directory or gitfile, any case), or if
it contains an entry git ignores (`status_should_ignore`). A path inside a
directory that has its own `.git` is refused too. The same checks run again,
per entry, while the removal walks the tree: `contained_removal` admits every
entry of a directory when it enters it, before unlinking anything there, so a
repository created in the target after planning is refused with its siblings
intact (a deeper one can still follow files already removed from its
ancestors; the error then says so).

Decision: refuse rather than delete or silently keep ignored files. Deleting
them destroys data the user was not shown; leaving them would make "Remove"
report success while the directory remains. The panel only sends directory
paths for nested-repository rows (`recurse_untracked_dirs` lists files
otherwise), which are now always refused, so the confirmation text ("will be
permanently deleted") stays truthful for everything that is removed.

Tests: nested repository (`sub/`, `sub`, `sub/wip`), linked worktree inside
the repository, repository nested several levels down, `*.log` and `build/`
ignored content, and a repository created after planning.
