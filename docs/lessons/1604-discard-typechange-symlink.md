# Discarding a file replaced by a symlink wrote through the link (#1604)

`git_discard` restored a tracked file with a forced `checkout_head`. When the
file had been replaced by a symlink (status: TypeChange), libgit2 opened the
path for writing and followed the link: the link's target — another tracked
file, or anything outside the repository — received the HEAD content and the
link stayed.

Fix (`git_discard.rs`): plan every path before writing; a symlink at a tracked
path is unlinked (never followed) before checkout, so the restored file
replaces the link. The same module refuses a tracked path whose parent
directory is now a symlink or a file (git refuses "beyond a symbolic link";
the file would be deleted), and removes an untracked symlink — including a
dangling one, which the old `exists()` check skipped — without following it.
Tests (Unix; symlink creation is privileged on Windows) cover targets inside
and outside the repository.

Race (#1618, review): planning and acting were separated by the whole
checkout, so a parent swapped for a link to outside the repository after
planning was followed by the untracked removal, and a tracked file swapped for
a link was written through. Now removals run before checkout; on Unix every
removal (untracked entries, and the symlink / empty directory in a tracked
file's way) goes through `files::contained_removal`, which opens each ancestor
`O_NOFOLLOW | O_DIRECTORY` from the repository root and removes through
`tree_removal`, re-checking the planned kind (and `.git` / ignored entries)
from the observation it acts on. Each restore path is re-checked (ancestors
real directories, nothing but a regular file at the path) just before
checkout. Tests use a seam (`discard_paths_with`) that changes the tree after
planning.

The repository root is opened by its canonical path (its ancestors need only
search permission: walking from `/` with read access failed every Remove below
a 0711 home). Every entry of a directory is admitted when the walk enters it,
before anything there is unlinked, so a `.git` that appears in the target
after planning refuses it with its siblings intact. A pre-flight refuses the
whole batch, naming the path, when a directory an effect must modify is not
writable, a restore path fails its checks, or `.git/index.lock` exists; a
failure after earlier effects names the path and how many items were already
removed.

Still open (#1618):
- libgit2's checkout resolves paths by name: a component swapped for a link
  between the path-based re-check and its write is followed;
- on Windows, removals are path-based after the same re-check;
- `unlinkat` acts on a name: an entry swapped in at the same name between its
  observation and the unlink is removed instead (directories are re-identified
  before `rmdir`), always inside a directory reached without following links;
- the repository root path is resolved once, by name;
- a `.git` appearing in a subdirectory after the walk entered its parent can
  follow the parent's already-removed files;
- the pre-flight is advisory: permissions and locks can change after it.
