# 685 — A durable move is an ordering problem, not a copy problem

The obvious way to make moves recoverable is to reuse the replacement-copy
record: stage a copy, publish it, retain the original. That is exactly wrong
for a move, and the reasons are worth writing down.

## A move's phases are not a replacement's

`OperationSpec::Move` shares the catalog, journal, owner locks and artifact
roots with `CopyReplacement`, but it does not share the phase machine. A move
has two phases a replacement can never have — **parking** the source and
**removing** that parked copy — and a fast path that needs no private storage
at all. Reusing `Phase` would have made illegal move states representable and
would have quietly widened `ReplacementState::validate`. `MovePhase` and
`move_transition.rs` are separate for that reason; ADR 0020 explicitly asks
for "their own future authority and state contract".

## The ordering is the whole safety argument

Three rules, each enforced by the pure transition function rather than by
execution discipline:

1. `BeginPark` is reachable only from `Published`. A crash before publication
   leaves the source untouched at its public name.
2. `BeginSourceRemoval` is reachable only from a durable `Parked`. The parked
   copy is the exact original object; removing it before parking is recorded
   would lose the only evidence that the move happened at all.
3. `BeginRestoration` is **not** reachable from `Removed`. Once the parked
   source is gone there is no exact original to return, so no inverse is
   offered — rather than offering one that would fabricate a copy. Source
   removal advances `effect_revision` for the same reason: otherwise a caller
   holding the *completed* move's revision could claim a record whose source
   had since been discarded, because `(revision, position)` would name two
   different states.

Restoration deletes nothing. Returning a cross-filesystem publication means
renaming it back into the destination's private root, exactly where it was
staged — not `remove_tree`. That keeps "never delete during restoration"
literally true, and it preserves a destination someone edited after the move:
`EntryVersion` is not a recursive snapshot, so a deletion gated on the top-level
version would have destroyed edits made deep inside a moved directory.

Because these are checked in a pure function that runs before every journal
compare-and-swap, a future executor cannot reorder them by accident. The
subprocess kill tests in `test_support/recovery_move_execution.rs` assert the
consequence directly: at every boundary the payload is still reachable, either
at a public endpoint or inside retained private storage.

## Three strategies, one record

- **Same filesystem, no overwrite** — one `renameat2(RENAME_NOREPLACE)`.
  `Planned → PublishIntent → Published`, no artifact root at all. This is the
  overwhelmingly common case and it must stay a single syscall; a journal that
  forced private storage on it would be a large regression for no safety gain
  (the rename is already atomic).
- **Same filesystem, overwriting** — the displaced destination is renamed into
  a private root before the source is renamed over it. Crash between the two:
  original retained, destination absent, source present. Nothing is lost.
- **Cross filesystem** — stage a copy into the destination's private root,
  publish it, and only then park the source into the *source's* private root.
  The pre-existing `file_ops::cross_device_move` published and then removed the
  live source with no record; that is the hazard ADR 0020 names, and the
  durable path never deletes during the forward move.

## Do not derive the restoration origin from the current phase

The first version of `restoration_source` took `(strategy, phase)` and mapped
anything that was not `ParkIntent | Parked` to "the source is at its public
name". An adversarial review refuted the recoverability claim with it: a
restoration that commits `RestoreIntent` and then fails before the unpark
rename — a transient EIO on the manifest read is enough — leaves a phase whose
own origin lookup has forgotten that the source is parked. Every retry then
reported "Move source is not at its original name" forever, while the source
sat hidden in private storage.

The origin now depends only on the immutable `Strategy`, and the executor
decides what work remains by *observing the source*. That is the general rule:
a phase label records what was intended, never what the filesystem contains.
`an_interrupted_restoration_can_still_bring_the_parked_source_home` pins it.

Note the consequence for the two surfaces. `try_claim_history` only accepts
stable positions, so an interrupted Undo cannot be re-consumed by history — it
becomes an explicit File Recovery item instead, and `service::relocation`
offers Restore from `RestoreIntent`. That split is deliberate: Undo is for
completed effects, recovery is for interrupted ones.

## The inverse is the record, never a path

`Action::Replacement` already carries a durable record identity and is claimed
by `(id, revision, stable position)`. Durable moves reuse it, and
`recovery::history::execute` dispatches on the operation kind. A path-only
`{type: "move"}` inverse — which the renderer still manufactures for the
non-durable path — can relocate whatever now happens to sit at the destination
path, which for a cross-filesystem move is the last copy of the data.

A consumed move record has no Redo: `ReplacementOutcome::reapplicable` is
false for moves, so `file_history::execution` produces `opposite: None` rather
than an action whose evidence no longer exists.

## A completed move must release its endpoints

`coordinator::claims::operation_claims` excludes every resource an unfinished
operation named. A completed move that kept claiming its source path would
make that name permanently unusable — you could not create a new file there.
`completed()` therefore recognises `Published | Parked | Removed | Restored`
for moves, and the idle-completed branch retains only the private artifact
roots. This is the move analogue of the replacement's "root + retained
original" reduction, and it is easy to forget when adding a new operation
kind.

## Platform limit worth knowing

POSIX `rename(2)` must update a directory's `..` entry when it moves to a new
parent, so **a directory its owner cannot write cannot be relinked at all** —
`mv(1)` fails the same way. For a cross-filesystem move this means the copy
publishes and then parking fails. That outcome is uncertain, not destructive:
both copies exist, the record is retained, and its inverse is still exact.
`a_source_directory_that_cannot_be_relinked_publishes_without_losing_data`
pins that behaviour so nobody "fixes" it by chmod-ing the user's source.

A related known limitation: on filesystems where `renameat2` rejects
`RENAME_NOREPLACE` (older FUSE, some network mounts), the move fails closed —
correctly — but `prepare` has already created the visible
`.tauri-explorer-recovery-<token>` sibling directories, and with no retirement
(#687) each retry leaves another pair. Probing support before publishing root
intent would avoid it.

## The session engine is the copy session, generalised

A move session is not a new orchestration. `copy_session::run` already owned
ordering, conflict pauses, cancellation, the bounded diagnostic budget and the
completed-prefix ledger; `Work` was the only copy-specific seam. Moves supply a
second implementation (`files/move_session.rs`) rather than a parallel engine,
because the interesting failure mode here is *divergence*: a separately written
move loop would eventually acquire a weaker cancellation or retention contract
than the copy loop, and nothing would notice. The module keeps its name for
diff size; its doc comment says plainly that it is the session engine, not the
copy effect.

Three things the move effect must do that a copy must not:

- Reject a directory relocated into its own subtree **before** prompting. A
  copy into a descendant is merely recursive; a move detaches the subtree from
  the namespace entirely.
- Treat a paste into the directory the entry already occupies as a success that
  touches nothing — never a conflict against itself. The test pins the inode.
- Fail closed on an un-prompted conflict on the durable path. `PreparedMove`
  decides overwriting from the target it observes, so the session must refuse
  before calling it; a target that appears after that check is still safe,
  because the durable overwrite retains the displaced original.

## One session, one inverse, no renderer undo

`move_session_outcome` pairs each committed item with exactly one inverse: the
durable record when the receipt carries a relocation, an `Action::Move`
otherwise, and neither for a same-directory no-op. It never emits both — a
path-only replay of a durable cross-filesystem move can relocate whatever now
sits at the destination, which is the last copy of the data.

The renderer therefore records nothing. `paste-operations.ts` shrank to a
dispatch and a clipboard-release decision, and `drop-operations.ts` lost its
per-item transfer loop entirely, including the `existingNames` conflict set:
native inspects the real destination per item, which a renderer-side name set
cannot do once earlier items in the same batch have landed. A cut clipboard is
released only when every requested item arrived, so a cancelled or partially
failed session leaves the cut intact.

## Why it is opt-in

`durable-move-recovery` is a Cargo feature, off by default, for the same
reason as `durable-copy-recovery`: retirement does not exist yet (#687).
A parked cross-filesystem source and a displaced overwrite target are retained
bytes with no quota and no GC. Shipping the journal without retirement would
silently accumulate user data in `.tauri-explorer-recovery-*` siblings.
