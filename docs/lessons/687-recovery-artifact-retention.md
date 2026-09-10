# 687 — Recovery artifact retention and durable retirement

Durable replacement records (ADR 0020) retained user bytes forever: nothing ever
removed an `original` after a completed overwrite or a parked `publication` after
a restoration. This issue added the retention contract (ADR 0023), a crash-safe
retirement state machine, storage budgets and the File Recovery surface for both.

## Retention is a policy decision, not a cleanup routine

The retained `original` of a completed overwrite is the **only** copy of the
previous content. Nothing may delete it automatically, at any budget pressure.
The retained `publication` of a completed restoration is redundant **only while
its recorded source is verifiably intact**. That distinction lives in the pure
`retention.rs` (`Disposal::ExplicitOnly` vs `Disposal::AutomaticWhenSourceIntact`)
and is separate from the mechanism, so a new operation kind (Move, #685) gains
retirement by supplying its plan, not by touching the state machine.

Every removal is additionally gated on observing the *live public endpoint*
holding the exact recorded payload. Absence is not consent: an artifact whose
counterpart is missing, different or unobservable is preserved.

## "Unavailable" is a reason, not an absence

`ENOENT` on an artifact whose parent directory is readable is a resolved
observation. A parent that cannot be opened, a missing mount, `EIO` or a changed
volume identity is *unavailable*, and preserves everything. Classifying purely on
"the file isn't there" would have deleted records for unplugged drives.

## Budgets reject new work; they never evict

Both bounds (2 GiB, 256 records; `recoveryRetainedBytesBudget` /
`recoveryRetainedRecordBudget`) are checked from decoded durable evidence
**inside the same admission-gated SQLite transaction that publishes the catalog**
(`coordinator/promotion.rs`). Checking them before taking the gate is a race:
two concurrent overwrites both observe headroom and both promote.

## Accounting cannot cost a scan

Sizes are measured once by a bounded walk of the *private* artifact root and
journaled as `retained_bytes` on the checkpoint (`RetentionMeasured`). Listing
then reads accounting without claiming ownership, probing a user volume or
advancing a generation. Every confirmed content transition must clear that field,
because the retained artifact changes identity.

**The trap that cost the most time:** adding `retained_bytes` with a validation
rule ("only measurable phases may carry it") silently broke *restore*. A measured
`Published` record moved to `RestoreIntent` still carrying its measurement, the
state failed validation, and the restore was refused with no visible error — a
long-standing service test failed with "target still holds copied bytes". Any new
checkpoint field with a phase-conditional validity rule must be cleared in every
`Begin*` arm, not only the completion arms.

## Two commits, one crash window

Removing the journal row and retiring the catalog record are separate commits.
Order matters: a journal row without catalog evidence fences every managed
mutation, whereas a catalog record without a journal row merely stays
discoverable. So the journal row goes first, and the enforcement pass reclaims
catalog-only residue after verifying — outside the admission gate — that the
artifact root is absent. That same rule reclaims a record whose index was lost
before it ever created an artifact.

## Resumption must be a no-op, not a special case

A retirement killed after its completion checkpoint resumes at phase `Discarded`
with nothing left to remove. Rather than teach the caller to branch on the phase,
`replacement_transition.rs` makes `BeginDiscard`/`DiscardCompleted` legal no-ops
there. Without that arm the resume path raised "Illegal recovery replacement
phase transition" and stranded the record. Subprocess-kill coverage at every
boundary (`intent`, `removed`, `completed`) is what surfaced it.

When writing those kill tests, note that destructuring the fixture to drop only
the coordinator is required — `drop(fixture)` also drops the `TempDir`, and the
child then finds no fixture at all.

## Failure preserves inventory

A cleanup failure (`EACCES`, `EBUSY`, missing volume) records the reason on the
checkpoint, leaves every remaining artifact in place, and leaves the record
listed in a **retained evidence** state with that reason shown. It is reported,
never retried automatically and never converted into a completed retirement.
`ENOSPC` cannot lose records because the intent write precedes every effect.

## No startup work

Per ADR 0020's startup boundary, the enforcement pass runs only from
recovery-session activity or immediately after a new record is created. It is
never called from Tauri setup, and `enforce` skips claiming ownership for records
that are already settled and measured, so ordinary listing stays cheap.

## Frontend

`mock-invoke.ts` now serves the whole `file_recovery_*` family, including a
record whose discard deliberately fails, so the browser build exercises the
retained-evidence state. Extending the item status union meant extending
`mergeRecoveryPresentation`'s keep rule too: it previously retained an inspected
presentation only while `status === "pending"`, which discarded the new
`"retained"` presentation on the next snapshot.
