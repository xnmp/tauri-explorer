# Issue 480: Keep optional Git folder decoration off slow listings

`FileEntry.is_git_repo` is an icon-decoration hint, not information needed to
list a directory. Checking each child for `.git` adds one stat per directory;
on UNC network shares and WSL's 9P mount that becomes one remote round-trip per
child. Directory listing therefore keeps the field for IPC compatibility but
sets it to `false` without probing on UNC roots. Local listings continue to
detect normal `.git` directories and worktree gitlink files.
