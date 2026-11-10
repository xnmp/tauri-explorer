# Volumes without a usable trash offer a confirmed permanent delete

Deleting from a Google Drive folder failed with "Trash directory is not a
private directory owned by the current user". #1508 had already made GVfs
(`fuse.gvfsd-fuse`) refuse trashing with "use Delete Permanently instead", so
this message came from a different mount: a cloud FUSE filesystem such as
rclone or google-drive-ocamlfuse. These filesystems do not store POSIX modes.
They report fixed permissions for every directory, for example `0755` from
rclone's default `--dir-perms` or `0775` from ocamlfuse. The `mkdir(0700)` of
`$topdir/.Trash-$uid` succeeds, but the directory then reads back as non-private
and `chmod` has no effect. The Freedesktop planner was right to refuse that
directory. The refusal was simply reported as an ordinary permission failure.
Each attempt also left an empty `.Trash-$uid` folder on the remote drive.

The private-directory check is unchanged. Only how a refusal is classified and
presented changed:

- For a per-volume (topdir) layout, a `PermissionDenied` during preparation, or
  one returned by every destination's directory step during execution, becomes
  `AppError::TrashUnavailable`. That covers a non-private, foreign or
  uncreatable trash. These refusals all happen before any metadata or payload
  effect, so the source is untouched. The GVfs refusal from #1508 uses the
  same variant. A failing home trash keeps its ordinary error because it is
  a real problem with the user's own trash.
- A trash directory that this execution created and then found non-private is
  removed again (`plan::discard_created`). Removal happens only while the name
  still denotes that same empty directory.
- `FileBatchOutcome.trashUnavailable` lists exactly those failed paths, which
  also stay in `failed` so that every other consumer, including native history
  settlement, still sees a failure. The renderer (`pane-mutations.confirmDelete`)
  keeps reporting the refusal as the error toast, which explains why, and opens
  the existing permanent-delete confirmation for just those entries. The
  renderer never pre-classifies paths and never deletes permanently without
  that confirmation. This applies even when "Confirm before deleting" is off.
- The startup bundle had 54 gzip bytes of headroom. A dedicated
  dialog note and an adjusted success toast cost about 150 bytes, so the
  explanation stays in the existing error toast. The renderer change is three
  statements.

Tests: `test_support/freedesktop_trash.rs` re-roots the scratch directory's
real mount at the scratch path, with the home trash on `/proc`'s mount. This
exercises real topdir placement without touching a mount root. A mode-ignoring
FUSE filesystem cannot be emulated, so the create-then-refuse cleanup is tested
directly. `tests/state/pane-mutation-dialogs.test.ts` covers the fallback flow.

Local note: Vitest in a worktree nested inside the main checkout can fail with
"Tsconfig not found". Vite's oxc resolver also loads ancestor `tsconfig.json`
files, and the main checkout's file extends a `.svelte-kit/tsconfig.json` that
has not been generated. Run `svelte-kit sync` there, or run tests from a copy
outside the checkout.
