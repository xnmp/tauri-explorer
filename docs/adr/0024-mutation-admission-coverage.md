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
| Deletion / trash | `file_mutation.rs::delete_entries` | Selected paths plus Linux trash auxiliary namespaces: layout directories, `.trashinfo` metadata, exact artifact names and prepared fallback layouts (lesson 680, *Trash preparation includes its auxiliary namespaces*). | Yes. | **Deferred** — holds (1) and (2) but not (3). See below. |
| Grouped / bulk rename | `BulkRenameDialog.svelte` → N × `rename_entry` | Each call: old path + new path (write, subtree), plus traversed parent-symlink reads. | Yes, per item. | **No gap** — every item already takes all three through the `entry()` path (`files/entry_plan.rs`). The batch is a renderer loop with no grouped inverse; that is a history-grouping question, not an admission one. |
| Plugin-driven mutations | `plugins/api.ts::moveFile` → `state/file-transfer.ts::performFileTransfer` → `move_entry` | Source + destination (write, subtree). | Yes. | **No gap** — `performFileTransfer` dispatches through `api/files.ts`, which goes through `api/file-mutations.ts` and therefore carries a session id; `move_entry` already takes all three. `PluginWorkspace` exposes no other mutating method. The remaining difference is that plugins use the per-item path rather than the ordered session (#685); that is ordering, not admission. |
| Ordinary copy outside the session | `file_mutation.rs::copy_entry` | Source (read) + destination (write). Holds (1) and (2); it takes a recovery claim only on the overwrite path, via `Runtime::copy_overwriting`. | In principle. | **Deferred** — no production caller. Its only frontend caller is `performFileTransfer`'s `isCopy: true` branch, which no UI flow reaches: paste and drop both run the ordered `copy_session`. It is not dead, though — `src/test-support/file-recovery-probe.ts` drives it with `overwrite: true`, so the native recovery suite exercises exactly the `copy_overwriting` path. Extending admission would harden a path only that probe reaches, and deleting it would remove that coverage; the ordered session is where ordinary copy should converge. |
| Git working-tree mutations | `git_actions.rs` — `git_checkout`, `git_create_branch(checkout)`, `git_cherry_pick`, `git_revert`, `git_merge`, `git_rebase`(+`_continue`/`_abort`), `git_stash_apply`/`_pop`, `git_reset --hard`, `git_merge_abort`, `git_cherry_pick_abort`, `git_revert_abort`, `git_checkout_tracking`, `git_sync_local_branches` (checked-out branch), `git_undo` → `HeadMove` | Every working-tree path that differs between two trees, plus `.git` internals. Not derivable without diffing the two trees — an unbounded prewalk — and the operation runs in a subprocess that chooses its own paths. | Yes, in principle. | **Deferred** — the only capturable footprint is a write claim on the whole worktree root, which would serialize *all* file operations in the repository against any git action. That is a blanket lock, not the footprint, and #686 explicitly does not authorize a blanket rewrite of Git operations. Git's own `index.lock` arbitrates git-vs-git. None of these commands acquires (1) either; adding (1) alone would give renderer-lifetime ownership without filesystem exclusion, which is the misleading half. |

`git_watch.rs`'s lease is an observation lifetime, not filesystem admission; it
is not evidence of Git coverage.

### Why deletion defers rather than migrates

Deletion is the next migration, and it is deferred on evidence rather than
effort. Its exact artifact names are chosen by whole-selection preparation,
which by #680's design runs *inside* the owned batch worker, after admission
would have to have happened. Two conservative supersets were considered and
both are worse than waiting:

- Claiming the trash roots as write subtrees covers every layout directory,
  `.trashinfo` and payload name — and makes every deletion conflict with every
  other deletion, including two panes deleting unrelated files. Trash-internal
  exclusion is already a whole-selection policy (#680); replacing it with a
  global lock is a concurrency regression, not a safety gain.
- Claiming only the selected sources leaves the artifact namespace unclaimed
  while advertising admission, and it forces the worker onto admission's
  resolved paths. #680 requires the opposite: trash preparation observes
  requested sources *in their requested spelling*, including nested parent
  symlinks, and the batch ledger preserves that spelling through its receipts.

The correct shape is for trash preparation's read-only phase to produce the
claim set, which means hoisting it above the worker or admitting from inside
it. That is a change to `files/batch`, not to one command, and belongs in its
own reviewable delivery.

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
and (2) only, exactly as every other family does. Deletion, ordinary copy and
Git remain outside (3); "full managed-mutation coverage" is still not claimed.
