# #1617 — libgit2 index writers must hold `index.lock` from read to write

**Symptom.** During a 5000-path unstage (~720 ms in a debug build), a
concurrent `git add concurrent.txt` exited 0, but the file was not in the
index afterwards.

**Cause.** `git2::Index::write` takes `index.lock` only for the write itself.
Stage, unstage and discard read the index, plan and change it in memory, and
then write it. Anything another git process committed in that window was
overwritten without any error. git's CLI takes the lock before it reads.

**Fix.** `src-tauri/src/git_index_lock.rs` (`with_locked_index`) is now the
only way the app writes an index through libgit2:

1. Create `<gitdir>/index.lock` with `create_new` (O_EXCL), then close it.
   Windows cannot rename over an open file. A concurrent git command now
   fails with "index.lock exists" instead of being lost. A foreign lock
   refuses the operation before anything is read and is never removed.
2. Copy `index` to a private file in the same gitdir, **keeping its mtime**.
   libgit2 smudges racily clean entries by comparing them with the stamp of
   the file it read, and a fresh copy's mtime would hide a same-size edit.
   Open the copy and install it with `Repository::set_index`. That keeps
   racy smudging working and makes checkout (discard) use this index.
3. After the caller's update, `Index::write` writes the private file (through
   its own `<copy>.lock`). The code then renames it over `index.lock`, and
   `index.lock` over `index`, which is git's own commit sequence. On failure
   or `IndexUpdate::Unchanged`, the private file and our lock are removed.

`<gitdir>` is `Repository::path()`, so a linked worktree locks and replaces
its own `.git/worktrees/<name>/index`.

**Case handling.** An index opened by path is exact-case, which unstage and
discard need (#1589). Staging has always used `Repository::index()`, which
follows `core.ignorecase`. git2 does not bind `git_index_set_caps`, so
`IndexCase::Repository` declares it directly and passes
`GIT_INDEX_CAPABILITY_FROM_OWNER`.

**Behaviour change.** Discard now holds the lock for the whole batch.
Previously only batches containing a restore checked for a held lock. A
removal-only discard now also refuses while another git process holds the
index. This is the price of planning from the same index that checkout
rewrites.

**Tests.** Each writer has a seam that runs between the read/plan and the
write: `reset_index_paths_with`, `stage_paths_with` and
`discard_paths_with`'s `after_planning`. Each test runs a real `git add` in
that window. The test fails if git exits 0 and its entry is missing (the
pre-fix behaviour, reproduced by the unstage test). It then requires git to
be refused with an `index.lock` message, and checks that no lock or private
copy is left behind. There are no sleeps. The `git_index_lock` tests cover a
foreign lock, failed and unchanged updates, linked worktrees and the case
mode.

**Review follow-ups (PR #1633).**
- `index.lock` is a cross-process mutex, not an in-process one. Two in-app
  writes of one index (e.g. un-awaited stage/unstage clicks) collided, and the
  second failed with "another git process holds the index". In-app writers
  now queue on a per-gitdir turn (`GitdirTurn`, keyed by the canonical gitdir)
  before creating the lock. The turn is declared before the lock guard, so
  the lock file is gone before the next writer runs. The test makes the first
  writer hold its turn until the second is observed waiting; without the turn
  it fails with the wrong-blame error.
- On Windows, renaming over `index` fails transiently while a reader has it
  open. The final renames now retry briefly, like libgit2's `p_rename`.
- The private copy is a new file written from the index's bytes, not
  `fs::copy`. A copy would inherit a read-only (0444) mode and then refuse the
  write handle that restores the mtime.
- Discard installs the index after checkout has already restored the work
  tree. A failure there is reported through `effect_error` as a partial
  discard.

**Interaction with #1616 (filtered discard through the git CLI).**
`git checkout` takes `index.lock` itself, so it cannot run while we hold the
lock, and its index update must not be overwritten by our locked write. Inside
the lock, discard checks out only the unfiltered paths through libgit2 and
writes our index. Our index does not touch the filtered paths. The CLI
restores them in the helper's `after_release` step. That step runs after our
index is renamed into place and `index.lock` is gone, but while the process
still holds its per-gitdir turn. The CLI therefore does its own locked
read-modify-write on the index we committed, and no in-app writer can take the
lock first.

**The handle gets its index back.** The helper installs the private copy
with `set_index`. A later reader of the same `Repository` handle (discard's
caller running a status) would otherwise see that consumed copy rather than
the index on disk, which the CLI has since changed. On return, success or
not, the helper re-opens the real index, installs it and restores the
repository's case capabilities.
