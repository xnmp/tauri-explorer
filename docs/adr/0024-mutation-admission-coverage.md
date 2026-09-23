# ADR 0024: Mutation admission coverage

Status: Accepted for the families migrated below; the deferrals are decisions,
not omissions.

Governs: `src-tauri/src/file_mutation.rs`, `src-tauri/src/archive.rs`,
`src-tauri/src/files/archive_plan.rs`, `src-tauri/src/git_actions.rs`,
`src/lib/plugins/api.ts`, `src/lib/state/file-transfer.ts`.

## Problem

ADR 0020 records that "deletion, transfer, inverse, archive, plugin and Git
roots remain required before claiming full managed-mutation coverage." Until
that inventory exists, "managed mutation" is an unbounded claim: a recovery
catalog does not protect files that a command reaches without passing it
(lesson 680, *Native move admission must govern the worker's actual paths*).

The common admission is three separate things, and a family can hold one
without the others:

1. `renderer_owner::acquire_owner` — the calling renderer generation is alive.
   Presentation-lifetime admission, not a filesystem lock.
2. `file_history::run_forward` — reserves a forward history position, settles
   the inverse, publishes affected directories, and owns settlement even if the
   invoking window disappears.
3. Linux `files::recovery::Runtime::admit` + `MutationAdmission::finish` — the
   ADR 0020 conflict authority: per-resource write claims across processes,
   with execution bound to admission's resolved paths.

## Admission is only correct where the footprint is capturable

Adopting (3) requires naming *every* path the operation can touch, including
aliases, sidecars and fallback allocations, before any effect. A claim narrower
than the effect is worse than no claim: it advertises exclusion it does not
provide. A claim wider than the effect is merely conservative — it can refuse
genuinely disjoint work, which is a usability cost, not a safety one. Where the
footprint is not derivable without an unbounded prewalk, the family defers.

## Inventory

| Family | Root | Footprint | Overlaps owned operations? | Decision |
| --- | --- | --- | --- | --- |
| Archive compress | `archive.rs::compress_to_zip` | One chosen `<name>.zip` under the selection's parent (write); every selected source subtree (read). No temp files, no sidecars; a failed run removes the archive it created. | Yes — writes a new entry into a directory a move/copy session may own, and reads sources such a session may be relocating. | **Migrated** |
| Archive extract | `archive.rs::extract_archive` | Extract-here: the archive's containing directory (write, subtree — the archive chooses its own entry names). Extract-to-folder: one chosen sibling directory (write, subtree). The archive itself (read). | Yes — the same directories panes and sessions operate in. | **Migrated** |
| Deletion / trash | `file_mutation.rs::delete_entries` | Selected paths plus Linux trash auxiliary namespaces: layout directories, `.trashinfo` metadata, exact artifact names and prepared fallback layouts (lesson 680, *Trash preparation includes its auxiliary namespaces*). | Yes. | **Migrated on Linux for forward `delete_entries` and native Trash Undo/Redo**, including permanent forward deletion. Trash claims its full prepared source/layout/artifact set; permanent deletion binds its source paths. See below. |
| Grouped / bulk rename | `BulkRenameDialog.svelte` → N × `rename_entry` | Each call: old path + new path (write, subtree), plus traversed parent-symlink reads. | Yes, per item. | **No gap** — every item already takes all three through the `entry()` path (`files/entry_plan.rs`). The batch is a renderer loop with no grouped inverse; that is a history-grouping question, not an admission one. |
| Plugin-driven mutations | `plugins/api.ts::moveFile` → `state/file-transfer.ts::performFileTransfer` → `move_entry` | Source + destination (write, subtree). | Yes. | **No gap** — `performFileTransfer` dispatches through `api/files.ts`, which goes through `api/file-mutations.ts` and therefore carries a session id; `move_entry` already takes all three. `PluginWorkspace` exposes no other mutating method. The remaining difference is that plugins use the per-item path rather than the ordered session (#685); that is ordering, not admission. |
| Ordinary copy outside the session | `file_mutation.rs::copy_entry` | Source (read) + destination (write). Holds (1) and (2); it takes a recovery claim only on the overwrite path, via `Runtime::copy_overwriting`. | In principle. | **Deferred** — no production caller. Its only frontend caller is `performFileTransfer`'s `isCopy: true` branch, which no UI flow reaches: paste and drop both run the ordered `copy_session`. It is not dead, though — `src/test-support/file-recovery-probe.ts` drives it with `overwrite: true`, so the native recovery suite exercises exactly the `copy_overwriting` path. Extending admission would harden a path only that probe reaches, and deleting it would remove that coverage; the ordered session is where ordinary copy should converge. |
| Git working-tree mutations | `git_actions.rs` — `git_checkout`, `git_create_branch(checkout)`, `git_cherry_pick`, `git_revert`, `git_merge`, `git_rebase`(+`_continue`/`_abort`), `git_stash_apply`/`_pop`, `git_reset --hard`, `git_merge_abort`, `git_cherry_pick_abort`, `git_revert_abort`, `git_checkout_tracking`, `git_sync_local_branches` (checked-out branch), `git_undo` → `HeadMove` | Every working-tree path that differs between two trees, plus `.git` internals. Not derivable without diffing the two trees — an unbounded prewalk — and the operation runs in a subprocess that chooses its own paths. | Yes, in principle. | **Deferred** — the only capturable footprint is a write claim on the whole worktree root, which would serialize *all* file operations in the repository against any git action. That is a blanket lock, not the footprint, and #686 explicitly does not authorize a blanket rewrite of Git operations. Git's own `index.lock` arbitrates git-vs-git. None of these commands acquires (1) either; adding (1) alone would give renderer-lifetime ownership without filesystem exclusion, which is the misleading half. |

`git_watch.rs`'s lease is an observation lifetime, not filesystem admission; it
is not evidence of Git coverage.

## Deletion admission contract (#735)

`delete_entries` now sends accepted Linux work through
`files/trash.rs::run_admitted_batch`. Trash preparation runs in
`Runtime::admit_prepared`: the coordinator reads its journal revision, builds the
complete read-only selection outside the gate, and reserves its captured claims
only if that revision still matches. A retry rebuilds the whole plan, including
candidate names, layouts and source observations. Preparing first and then using
ordinary path recapture would leave the old plan outside that revision fence.

The plan contributes selected physical sources as write subtrees, requested
parent-symlink reads, layout dependencies, and exact payload/final metadata/staged
metadata writes for both preferred and fallback destinations. Intra-selection
container reads still reject selecting a trash ancestor, but are not broad
inter-operation claims. Requested spelling remains the batch key and receipt key;
native execution keeps the source parent/version checks from preparation.

First-use private directories use `EnsurePrivateDirectory`, restricted to entry
scope. It permits exclusive mkdir or read-only adoption of a validated private
directory, never replacement, symlink traversal or unplanned permission repair.
Two ensures commute. Ordinary claims on that exact entry and enclosing subtree
claims exclude an ensure; distinct descendant payload entries keep independent
claims. Existing layout reads remain ordinary reads and planned permission repairs
remain writes. Thus two fresh disjoint selections can share planned directories,
including unused fallback layouts. A selection prepared after another worker has
created a directory can temporarily conflict as an ordinary reader until that
worker releases its ensure. This conservative first-use refusal does not hold a
blanket write claim on the trash tree.

The actual batch worker owns `admission.context()` through closure destruction.
The native forward supervisor awaits the worker and then explicitly retires
admission. Accepted work survives renderer closure; deletion has no separate
Cancel API, and dropping its IPC waiter is not cancellation. Ordinary per-item
failures retain their aligned receipts, uncertain work stops later items, and a
retirement failure remains an unattributed batch diagnostic without erasing
confirmed success or exact Undo artifacts.

Permanent deletion uses ordinary write-subtree admission and executes its resolved
native paths without lossy UTF-8 conversion. This coordinates managed peers; the
pre-existing path-based permanent removal still does not protect against an
unmanaged process replacing an entry between observation and removal ([#739](https://github.com/xnmp/tauri-explorer/issues/739)).

Regression evidence: the pre-fix trash executor removed a source while a managed
copy held a read claim. The admitted path now refuses it before effects. Rust
contracts also cover complete-plan revision retry, fresh disjoint layouts,
source/alias exclusion, candidate collisions, partial-batch exact restoration,
non-UTF-8 physical aliases and worker ownership after waiter loss. Existing trash
fallback, metadata-failure and substitution contracts remain applicable.

This delivery covers forward deletion and native Trash Undo/Redo on Linux.
Windows/macOS retain their existing platform implementations. It does not make
trash a durable recovery record or claim complete mutation-family coverage.

## Native trash inverse admission (#740)

`NativeOperations` passes its existing recovery owner to prepared ordinary-copy
Undo, trash Redo and exact restoration. These adapters use the same worker-owned
reservation and finish path as forward trash; they never recursively record a
forward history action. Missing ownership fails closed in production. Direct
unadmitted inverse wrappers are available only to platform adapters and tests.

Restoration prepares immutable item plans inside `Runtime::admit_prepared`'s
revision fence. Claims include the target and exact trash payload subtrees,
metadata entry, existing trash/parent directory entry reads, parent-alias reads,
and every missing destination-parent entry write. A shared selection index
rejects overlapping targets/artifacts and physical alias duplicates while
allowing distinct hardlink payloads. Missing-parent write claims are shared only
within the same batch; they still exclude other managed writers. Trash roots are
not claimed as broad subtrees, so disjoint artifacts can proceed concurrently.

Execution reopens captured directories without following symlinks, verifies
stable object/mount identities and exact metadata/payload versions, and publishes
with descriptor-relative no-replace rename. Missing parents use descriptor-relative
mkdir with ordinary user-directory permissions, subject to umask. Only parents
created by this batch may be reused, and their identities are rechecked. An
unexpected existing directory or symlink is rejected. Prepared plans do not retain
one descriptor set per item, avoiding selection-sized file-descriptor pressure.

The external batch ledger retains parent refresh effects even after partial
creation or leaf failure. Ordinary failed items leave later independent items
executable; uncertain items stop the remaining suffix. Metadata cleanup and sync
failure after publication become warnings without discarding the confirmed
restore or its fresh native publication. The actual worker retains admission
after its waiter disappears.

Copy history deliberately retains the physical publication's display projection
as its single-item receipt key; it must not redirect when the original UI alias
changes. Native preparation and settlement use the actual `PathBuf`, including
non-UTF-8 names. Restoration recognizes the exact trusted artifact's display key
and otherwise validates a requested alias against the artifact's physical path.
Display projections are not injective; they are never native path authority.

Shared claims exclude cooperating operations, not arbitrary external programs.
Directory handles and version checks prevent observed substitutions from redirecting
execution, but a final check and pathname rename/unlink are not one conditional
identity syscall. No universal immunity to unmanaged races or cross-platform
qualification is claimed. Native rename Undo/Redo still requires separate admission
work; it currently calls the low-level entry executor directly.

## Archive admission contract

`files/archive_plan.rs` is the pure intent, following `entry_plan.rs` and
`move_plan.rs`: validated input, one owned public `output`, `resources()`,
`resolve()` (binding execution to admission's resolved paths) and
`affected_dirs()`. Output-name selection probes the filesystem, so it stays in
the command and its result is handed to the plan; the plan itself performs no
filesystem work.

The output is claimed as a **write subtree**, deliberately wider than one file
for compress: neither operation's exact leaf set is known before it runs, and
for extract the leaf set is chosen by the archive. Sources are **read
subtrees**, which share with other readers and exclude writers. A conservative
superset is correct here; a claim narrower than the effect would not be.

One consequence is load-bearing: recovery storage is application-local
(`app_local_data_dir()/file-recovery`) and the recovery root is a protected
resource, so an extract-here into a directory that contains it is refused. That
is the intended behaviour, and the contract tests keep their recovery storage
outside the operated-on tree so they exercise the ordinary path.

Semantics preserved: client-generated `job_id` cancellation through the
existing `TaskRegistry` (now via the RAII `register`, so a panicked worker
releases its id, which the old explicit `cleanup` did not), per-job progress
events with the same names and ids, conflict refusal before any write in
extract's pre-scan, and best-effort removal of partial output.

Input validation is deliberately *stricter* than before, because the request is
now a claim: paths must be absolute, non-root, NUL-free and free of `.`/`..`
components; a selection is capped at 32,768 entries and 8 MiB of path bytes;
and repeated selections are de-duplicated rather than claimed and zipped twice.
A selection larger than those caps is refused where it previously ran.
`extract_archive`'s missing-archive check also moved inside the worker, so a
missing archive now acquires and releases ownership before reporting the same
`NotFound`; it still precedes destination creation, so no stray directory is
left behind.

Ownership is bounded on every exit: the renderer owner is acquired before any
effect, its retirement sets the job's cancellation flag, and
`MutationAdmission::finish` runs after the blocking worker joins — success,
ordinary failure, cancellation, a rejected path binding, or a panicking
blocking worker. A retirement that itself fails becomes a warning on a
successful result. It is *not* preserved on a failing one: `run_forward`
attaches warnings inside `map` over `Ok`, so an error result carries only its
error. That is pre-existing and shared by every family, not archive-specific.
The committed output path is reported back in the caller's own spelling, so a
renderer that reached the directory through a symlink broadcasts a refresh its
other windows recognise; native publication covers the resolved parent too.

Two failure modes the migration closed, both consequences of taking ownership
of a name seriously:

- Compress created its output with `File::create`, truncating whatever had
  taken the selected name since the probe, and then removed it on failure.
  It now uses `create_new` and fails closed.
- Extract-to-folder created its destination with `create_dir_all`, silently
  merging into an occupant that appeared since the probe — and its failure
  cleanup then `remove_dir_all`'d that pre-existing directory. It now uses
  `create_dir` and fails closed.

A failed extract-here leaves visible partial output (it must not delete a
directory it did not create), so it publishes its directory for refresh rather
than reporting no change. Archive operations advance history with no inverse:
they mutate, so the redo stack is discarded, but no Undo is offered because no
inverse exists.

## What this ADR does not claim

Archive operations are not durable-recovery operations: they hold an ordinary
reservation for the life of the call and promote nothing into the catalog, so a
crash mid-archive is not discoverable after restart. Non-Linux builds keep (1)
and (2) only, exactly as every other family does. Native rename inverses, ordinary copy outside the session and
Git remain outside (3); "full managed-mutation coverage" is still not claimed.
