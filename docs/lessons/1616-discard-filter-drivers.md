# Discard wrote the raw blob instead of running smudge filters (#1616)

`git_discard` restored tracked files with libgit2's `checkout_head`. libgit2
applies git's built-in conversions (CRLF / `eol`, `ident`) but never runs
external filter drivers (`filter=<name>` with `filter.<name>.smudge` or
`.process`). With `*.txt filter=upper` and `filter.upper.smudge = tr a-z A-Z`,
`git checkout -- f.txt` writes `HELLO` while Discard wrote `hello`; for Git
LFS the discarded file became its pointer text.

Fix (`git_discard.rs`): after planning, removals and the per-path re-checks
(unchanged), restore paths are split. A path whose HEAD entry is a regular
blob and whose `filter` attribute (index first, then work tree, as checkout
reads it) names a driver with `smudge` or `process` configured is restored
by `git --literal-pathspecs checkout --pathspec-from-file=- --pathspec-file-nul
HEAD`; everything else still goes through libgit2. The CLI runs after
libgit2's checkout, because libgit2 writes its in-memory index over the file
and would otherwise undo the CLI's index update. `GIT_DIR` / `GIT_WORK_TREE` /
`GIT_INDEX_FILE` and pathspec-mode variables are cleared, and
`GIT_TERMINAL_PROMPT=0` makes an LFS download fail instead of hanging on a
prompt. Git itself refuses paths beyond a symbolic link and replaces (never
follows) a link at the path.

Gotchas:
- Only filtered paths need the git CLI, so repositories without filter
  drivers keep working where no `git` binary is installed.
- A path HEAD lacks (a staged addition under `force`) keeps libgit2's
  behaviour: `git checkout HEAD -- <path>` would fail on it.
- Fixture repos must set `core.autocrlf false` locally: Windows runners set it
  to `true` globally and the CLI checkout reads that config too.

Regression: `git_discard::tests::discarding_runs_the_smudge_filter_like_git_checkout`
(modified, deleted and force-discarded staged files under a `tr` filter; the
index ends clean). It fails with the CLI routing removed.
