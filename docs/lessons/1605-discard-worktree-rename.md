# A worktree rename row had no correct discard (#1605)

libgit2 status ran with `renames_index_to_workdir(true)`, so `mv old.txt
new.txt` plus an edit was one Changes row "new.txt (renamed from old.txt)".
Every action sent only `new.txt`; it is not in the index, so discard took the
untracked branch and deleted `new.txt` with its edits while `old.txt` stayed
deleted, under a confirmation that said "changes will be reverted".

Decision: stop pairing worktree renames rather than teach discard about
`old_path`. `git status` never pairs an unstaged delete with an untracked file
(only intent-to-add files), the WSL delegation already showed two rows, and a
pair cannot be staged or discarded atomically by the existing per-path
commands either. Now `old.txt` is a Deleted row whose Discard restores it, and
`new.txt` an Untracked row whose Remove says it deletes the file. Staged
(HEAD-to-index) renames are still paired. The porcelain-v2 parser splits git's
intent-to-add worktree pair the same way (`--no-renames` shape). No frontend,
mock or IPC change was needed: the mock never produced worktree renames.
