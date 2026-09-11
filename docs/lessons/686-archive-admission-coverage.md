# 686 — Extending admission is mostly an inventory problem

The issue reads like a refactor ("adopt the common admission in the remaining
mutation families"). Most of the work turned out to be establishing which
families have a gap at all, and three of the six answers were not what the
plan assumed.

## Count the three mechanisms separately

"Managed mutation" is three things, and a family can hold one without the
others: `renderer_owner::acquire_owner` (renderer lifetime),
`file_history::run_forward` (forward position, inverse settlement, refresh
publication) and Linux `recovery::Runtime::admit` (cross-process write claims).
Grepping for any one of them gives the wrong inventory.

- **Grouped/bulk rename** looked like a gap because `BulkRenameDialog.svelte`
  issues N `rename_entry` calls in a loop. Every one of those calls already
  takes all three through `entry()`. The loop is a *history-grouping* question,
  not an admission one.
- **Plugin transfers** looked like a gap because `performFileTransfer` has no
  `sessionId` parameter. It does not need one: it dispatches through
  `api/files.ts`, which goes through `api/file-mutations.ts`, which acquires
  the session itself. Reading the TypeScript signature is not reading the IPC.
- **Ordinary `copy_entry`** is a real gap in the third mechanism — and has no
  live caller. Its only frontend caller is `performFileTransfer`'s `isCopy`
  branch, which nothing calls now that paste and drop use the ordered session.
  Hardening unreachable code is not coverage.

Archive was the one family with a real gap in all three.

## A conservative claim is fine; a narrow one is not

Neither archive operation knows its exact leaf set before it runs: compress
picks its output name by probing, and extract writes whatever names the archive
contains. Both therefore claim their output as a **write subtree** — wider than
the effect. That can refuse genuinely disjoint work, which is a usability cost.
A claim *narrower* than the effect is qualitatively worse: it advertises
exclusion it does not provide, which is exactly the hazard lesson 680 records
under *Native move admission must govern the worker's actual paths*.

That asymmetry is why deletion deferred rather than migrating. Both available
supersets for trash are wrong in different directions: claiming the trash roots
makes every deletion conflict with every other deletion, and claiming only the
selected sources leaves the artifact namespace unclaimed *and* forces the
worker onto admission's resolved paths, which contradicts #680's requirement
that trash preparation observe sources in their requested spelling.

## Recovery storage is inside the claim space

`extract_archive(here: true)` claims the archive's containing directory as a
write subtree. The first version of the contract tests put the recovery storage
under that same temp directory, and admission correctly refused every
extraction: the recovery root and its ancestors are protected resources
(ADR 0020, *SQLite namespace boundary*). Production storage is
`app_local_data_dir()/file-recovery`, so this never occurs in the app — but a
test fixture that colocates them is testing the protection, not the feature.
Keep fixture storage outside the tree under test.

## Owning a name means refusing to overwrite it

Making admission claim the chosen output forced the question of what happens
when something takes that name between the probe and the write. Both answers
were wrong, and both were pre-existing:

- `compress_to_zip` created its archive with `File::create`, which truncates.
  A file that appeared at the selected name since the probe was destroyed —
  and then the failure path `remove_file`'d it. Now `create_new`, fails closed.
- `extract_archive` created its destination with `create_dir_all`, which
  succeeds on an existing directory. It would merge into an occupant, and its
  failure cleanup then `remove_dir_all`'d that pre-existing directory with
  everything in it. Now `create_dir`, fails closed.

Neither bug is about concurrency with *managed* operations — a claim would not
have prevented them, because the writer is unmanaged. The claim only made them
visible. The general rule: if you are about to assert ownership of a name,
check that the code actually behaves as though it owns it.

## A failure that cannot clean up must still publish

`extract_here` writes into a pre-existing directory, so it must not remove its
destination on failure — which means a failed extract-here leaves visible
partial output. The old code returned an error and published nothing, so the
pane kept showing a listing that no longer matched the disk. `run_plan` now
returns whether a failure may have left changes behind, and the outcome
publishes the affected directories in that case. `Result::is_ok()` is not a
"did anything change" test — the same shape as #685's *A committed destination
is not a completed move*.

## Cancellation ownership belongs to the supervisor, not the worker

The blocking archive job needs a cancellation flag, but the flag's registration
must outlive it and be released on every exit. Moving `TaskRegistry::register`
(the RAII form) into the async supervisor and passing only an `Arc` of the flag
into `spawn_blocking` gives both: a panicked worker releases its job id, and
the supervisor can set the flag itself when `Owner::retired()` fires. That is
the same `tokio::select!` shape `copy_session::run` already uses; a second
hand-written cancellation path would have drifted from it.
