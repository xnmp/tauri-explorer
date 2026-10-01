# ADR 0017: File batch outcomes and undo progress

Status: Accepted

Implementation transition: [ADR 0018](0018-native-file-history.md) moves the
execution and reservation policy into the native application. Its acceptance
is still pending; this record describes the preceding verified checkpoint.

Governs: `src-tauri/src/files/trash.rs`, `src/lib/domain/file-batch-outcome.ts`,
`src-tauri/src/file_history/execution.rs`, `src/lib/state/pane-mutations.ts`,
`src/lib/state/undo.svelte.ts`, `src/lib/api/files.ts`.

## Context

Bulk trash and restore can change some requested paths before another path
fails. An aggregate command error hid those completed effects. The renderer
could then retain deleted rows, omit their undo actions, or retry an inverse
that had already succeeded. This resolves the batch-outcome and renderer-local
reservation work left open by [ADR 0016](0016-file-mutation-publication.md).

Restore has a second commit boundary. On Linux, moving the payload from the
Freedesktop trash is the durable user-visible result; deleting its `.trashinfo`
record is cleanup. Treating cleanup failure as restore failure causes history to
retry a file that is already back at its original path. The trash crate's
placeholder-based restore also separates the collision check from the move.

## Decision

Best-effort bulk trash and restore return a `FileBatchOutcome` containing
ordered `succeeded` paths and `{ path, error }` failures. Exact duplicate input
strings are processed once in first-seen order. An outer IPC error is reserved
for a failure before per-path work can be classified, such as failure to list
the trash or failure of the blocking task transport.

Linux restore indexes only requested original paths and selects the item with
the greatest deletion timestamp reported by the Freedesktop trash inventory;
ties retain the inventory's first match. Metadata records
whose payload is known to be missing are ignored; `symlink_metadata` preserves
broken symlinks and treats permission or other inspection errors as real work
to report. Each selected payload is moved with Linux
[`renameat2(..., RENAME_NOREPLACE)`](https://man7.org/linux/man-pages/man2/rename.2.html).
That syscall is the restore commit point and atomically rejects an existing
file, directory or symlink. A later `.trashinfo` unlink failure is logged but
does not turn the committed restore into a failed receipt. Systems or
filesystems without the no-replace operation fail closed for that path.

Windows restores one item per trash-crate call so one path's failure does not
obscure earlier results. macOS restoration remains unsupported.
UNC paths continue through permanent removal because Windows has no Recycle Bin
for those locations; a mixed delete records undo only for confirmed non-UNC
successes.

The frontend publishes, removes and records undo for `succeeded` paths only.
Undo execution returns both its completed action subset and the work remaining.
On a partial error, history retains only the remaining paths, while completed
paths provide invalidation and, when the branch is still current, redo history.
Batch order remains reverse for undo and forward for redo.

Each renderer admits one undo or redo at a time and reserves the exact history
entry. Completion cannot remove a newer entry, recreate history after `clear`,
or create an obsolete redo branch across an intervening push. A new push drops
the prior redo branch but retains unfinished work from a redo that was already
admitted; explicit `clear` retires that reservation. Accepted filesystem work
is not cancelled when its renderer-side history is retired.

## Consequences and verification

Process-isolated Linux tests use a temporary `XDG_DATA_HOME` on the same
filesystem. They exercise partial trash, unmatched and colliding restores,
newest-item selection, cleanup failure after a committed move, stale metadata,
broken symlinks and directory collisions. Domain and store tests cover action
ordering, reservation and partial retry behavior; browser/native evidence is
recorded separately in the acceptance report.

The reservation is renderer-local. Broadcast history does not prevent two
windows from concurrently invoking the same inverse; native or cross-window
admission is future work. Windows still delegates each restore to the shell via
the trash crate, and exact shell completion needs Windows-native evidence.
Linux cleanup failures can leave a metadata-only entry visible to other trash
tools even though this application ignores it. No restoration support is
claimed for macOS. The older inverse model also cannot redo a copied item on a
UNC location after undo permanently removes it. This decision does not claim a
complete inverse cycle for those platform-specific cases.
