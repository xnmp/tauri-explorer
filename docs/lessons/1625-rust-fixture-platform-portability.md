# #1625 — Rust git fixtures must not depend on the host filesystem or git config

Rust platforms (macOS + Windows) failed on dev after #1623/#1624 while Linux
was green. Two fixture assumptions held only on Linux:

- **Case-distinct paths.** `git_index_reset`'s ignorecase test wrote `a` and
  `A` (and `d` beside `D/x`) into the worktree. On a case-insensitive
  filesystem those are one file, so the second `update-index --cacheinfo`
  failed ("cannot add to the index"). Case variants are built in the index
  only (`update-index --add --cacheinfo`) with `core.ignorecase=false`, then
  ignorecase is switched on — `git init` defaults it to true on macOS/Windows.
- **Host `core.autocrlf`.** Windows runners set `core.autocrlf=true`
  globally. Passing `-c core.autocrlf=false` to the *test's* git calls does
  not reach the product's own git subprocesses (discard, `worktree add`), so
  checked-out fixture text came back with CRLF. Persist
  `git config core.autocrlf false` in the fixture repository instead.

The theme-order failure from the same runs was the same class of bug and was
fixed separately by #1628 (#1627).
