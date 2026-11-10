# Native and WSL status rows disagreed with git (#1619)

The SCM panel has two status producers: libgit2 (`collect_status`) and, for
`\\wsl.localhost\…` repos, the distro's `git status --porcelain=v2 -z`
through `parse_status_v2`. The v2 parser was already faithful to git; the
libgit2 classifier was not, in three cases:

- **Intent-to-add** (`git add -N`). libgit2 has no concept of it: the
  placeholder index entry looks like a staged addition, and the file a
  worktree modification. Git lists an unstaged addition (`.A`), or an
  unstaged deletion once the file is gone (`.D`), with nothing staged.
  `classify` now checks the index entry's `INTENT_TO_ADD` extended flag for
  `INDEX_NEW` entries (the index is loaded only when such an entry exists).
- **`git rm --cached`** with the file still on disk is one libgit2 entry,
  `INDEX_DELETED | WT_NEW`. Git lists two rows: staged Deleted and untracked.
  The classifier's untracked branch used to require "no index flags", and the
  collector stopped after an untracked row; both now allow the pair.
- **`status.renames`** (falling back to `diff.renames`, default on;
  `copies` counts as on) now drives `renames_head_to_index`. libgit2 status
  cannot report copies, so a `copies` repo with a real copy can still differ.

The regression tests in `git.rs` (`tests::v2`) build one repo per case, run
real `git status --porcelain=v2 --branch -z -uall` through the v2 parser and
the native collector, and require both to equal git's rows exactly. Use the
same twin assertion for any future classification change.

Discard: an intent-to-add row's index entry differs from HEAD, so
`discard_paths` refuses it as a staged change (git's own `restore` would empty
the file). The sidebar therefore offers no Discard on a Changes row whose
status is Added — only intent-to-add produces one on either path — and folder
Discard sends only the discardable rows (`canDiscardScmRow`,
`discardableScmPaths` in `domain/scm-sidebar.ts`), so one such file no longer
gets the whole batch refused. Stage remains its action. An intent-to-add file
deleted from disk shows as a Changes Deleted row that is indistinguishable in
the IPC shape; its Discard is still refused safely by the backend.
