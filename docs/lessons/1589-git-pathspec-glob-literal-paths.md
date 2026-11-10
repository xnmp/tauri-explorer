# Git: user-selected file names are not pathspecs (#1589)

libgit2 parses `CheckoutBuilder::path`, `reset_default`, `StatusOptions::pathspec`
and `DiffOptions::pathspec` as pathspecs, so a file literally named `f[1].txt`
also matched `f1.txt`: discarding it reverted the other file, unstaging it
unstaged the other, and a staged `f1.txt` blocked the discard. Staging was
already literal (`index.add_path`).

Fix: set `disable_pathspec_match(true)` on checkout, status and diff options (and
`--literal-pathspecs` on the WSL `git diff` fallback). Any new call that hands a
renderer-supplied name to git as a pathspec must do the same.

`reset_default` has no literal mode, so `git_unstage` uses
`git_index_reset::reset_index_paths`, built to match `git --literal-pathspecs
reset -- <paths>` exactly (twin-repo tests compare `git ls-files -s -v` against
real git for modify/add/delete, rename, mode, symlink, gitlink, intent-to-add,
conflicts, dir<->file swaps, skip-worktree/assume-unchanged, unborn branch,
legacy `100664` trees). A first hand-rolled version got four things wrong,
each now covered:
- it `index.add`ed tree entries, so a directory replaced by a file failed with
  `invalid entry mode` (and "Unstage all" failed as a batch) — expand trees to
  leaves and apply removals before additions;
- it scanned the whole index per path (2,000 paths x 50k entries: 10.4 s debug)
  — binary-search each path with `Index::find_prefix` (0.20 s);
- it rewrote every entry under a directory, zeroing stat data and dropping
  `skip-worktree` / assume-unchanged — touch only entries that differ, and keep
  `skip-worktree` on rewritten ones as git does;
- it accepted `.`, `./a`, `d/../a` and silently did nothing.
Index paths are built as `/`-joined bytes, never through a platform `Path`
(`\` on Windows), so non-UTF-8 names also survive on Unix.

`git_common::literal_repo_path` rejects empty, absolute, drive-prefixed,
`.`/`..`/empty-segment paths for unstage, discard and Add to .gitignore;
libgit2's `Index::get_path` panics on an absolute path. It also rejects, on
every platform, any segment that can name `.git` somewhere (git's
`protectNTFS` rules): `.git` in any case followed only by dots/spaces up to an
optional `:stream`, and `GIT~<digits>`. Trailing dots/spaces in a segment are
rejected only on Windows, where `a.` is the file `a`; on Unix `a.` and `a `
are ordinary trackable names.

`core.ignorecase` (review of the fix): `Repository::index()` inherits it, and
libgit2 then finds, removes and replaces entries case-insensitively. Unstaging
`A` with both `a` and `A` staged removed the staged `a` (a deletion git never
makes), and a discard of the untracked `A` became a restore of the edited,
tracked `a`. git matches literal paths case-sensitively whatever
`core.ignorecase` says. Mutations now use `git_common::exact_case_index`
(`Index::open` on the index file: no owner, so no ignore-case capability), and
`git_discard` installs it as the repository's index with `set_index` so
libgit2's checkout is exact-case too (without that, restoring `B` deleted a
tracked `b`). The staged-change pre-check is `index_differs_from_tree` on the
same index, i.e. exactly the entries an unstage would rewrite, instead of a
libgit2 status query (case-insensitive under `core.ignorecase`). Twin tests
cover `a`/`A` both staged, only `A` staged, and `d` vs `D/x`.

Regressions use `[`, `*`, `?` and leading `:(glob)` / `:!` names (non-Windows
only for characters Windows forbids) plus a directory-path case. Discarding a
directory path that contains tracked files is now refused (it used to delete
them as "untracked").

Writing an ownerless index skips libgit2's `truncate_racily_clean`: an entry
whose mtime is not older than the index the writer read was left unsmudged, so
a same-size edit made in that timestamp tick vanished from `git status`.
`reset_index_paths` installs the index with `repo.set_index` before writing
(the capabilities stay exact-case). Test:
`rewriting_the_index_smudges_racily_clean_entries_like_git` (explicit mtimes,
`core.trustctime=false`, compared with `git reset`).
