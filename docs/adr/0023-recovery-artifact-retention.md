# ADR 0023: Recovery artifact retention and durable retirement

Status: Proposed — Linux only; Windows/macOS adapters and native acceptance
outstanding.

Governs: `src-tauri/src/files/recovery/retention.rs`,
`src-tauri/src/files/recovery/retirement.rs`,
`src-tauri/src/files/recovery/retirement_plan.rs`,
`src-tauri/src/files/recovery/storage.rs`,
`src-tauri/src/files/recovery/commands.rs`,
`src/lib/domain/file-recovery.ts`, `src/lib/state/file-recovery.svelte.ts`.

Extends [ADR 0020](0020-durable-file-recovery.md), whose release policy makes
durable replacement records opt-in "until retirement exists (#687)". This ADR is
that retirement contract. It does not change admission, promotion, execution or
reconciliation.

## Problem

Durable replacement records retain user bytes in a private artifact root
(`original` after a completed overwrite, `publication` after a restoration) for
the life of the record. Nothing removes them. The catalog's 1,024-record and
64 MiB payload limits bound *metadata*, not retained user data, so an enabled
build accumulates unbounded retained bytes and eventually refuses new work with
an unexplained "catalog is full". There is no user-visible discard, no accounting
of what is retained, and no crash-safe cleanup path.

## Decision

### User-visible retention semantics

A durable record is one of:

- **Retained** — a completed operation is holding user bytes the user may still
  need. File Recovery shows the original path, what is retained, and its size.
- **Needs attention** — an interrupted or errored record. Never retired
  automatically, never counted as reclaimable.
- **Unavailable** — the record's volume or target parent cannot be reached. It
  is listed, its size is reported as unknown, and it is never retired.

Retention is indefinite until the user discards, or until automatic retirement
finds the record redundant. Time is not a retention input: an artifact does not
become disposable by ageing.

### Storage budget

Two bounds, both enforced natively:

| Bound | Default | Setting |
| --- | --- | --- |
| Retained artifact bytes | 2 GiB | `recoveryRetainedBytesBudget` |
| Retained records | 256 | `recoveryRetainedRecordBudget` |

The record budget stays at or below the catalog's 1,024-record cap so retention
policy fails before catalog exhaustion and can explain itself. Both are read natively from the
existing `settings.json`; an absent, malformed or out-of-range value falls back
to the default rather than disabling the bound.

Per ADR 0020, **budgets reject new work; they never evict unresolved recovery.**
When retention is at or over budget, promotion of a new durable record fails with
a message naming File Recovery. Both bounds are checked from decoded durable
evidence inside the same admission-gated SQLite transaction that publishes the
catalog, so concurrent record creation cannot race past either one. A record
created but not yet measured contributes zero bytes until the next enforcement
pass measures it; the record bound is what caps that window.

Usage is derived from durable evidence. A settled record's retained size is
measured once, by a bounded walk of the *private* artifact root —
application-created storage, not a user-volume scan — and journaled as
`retained_bytes` on its checkpoint. Every confirmed content transition clears
that measurement, because the retained artifact changes identity. An artifact
that cannot be walked stays unmeasured and is reported as unknown, never as
zero. Listing therefore reads accounting without claiming ownership, probing a
user volume or advancing a generation.

### Discard is explicit; retirement is automatic and narrow

**User discard** is the only path that may destroy the sole surviving copy of a
displaced original. It is an explicit, per-record action in File Recovery, is
refused unless the *public* endpoint independently verifies as the expected live
payload, and is otherwise identical in mechanism to automatic retirement.

**Automatic retirement** may only remove artifacts that are provably redundant:
a restored record's retained `publication`, whose content is already published
at a live endpoint, and the residue of a record already journaled `Discarded`.
It runs only from recovery-session activity or immediately after a new record is
created, oldest record first, and stops at the first record it cannot verify.

Never removed automatically, under any budget pressure:

- the only known original of a displaced or parked entry;
- any artifact whose live counterpart is missing, different, ambiguous or
  unverifiable — unverified evidence is preserved, not resolved by deletion;
- any record whose volume or artifact root is unavailable;
- any record in an intent phase, carrying an error, or of an operation kind
  without a retirement plan.

Unavailable is distinguished from disposable by the *reason* an endpoint could
not be observed, not by absence: `ENOENT` on an artifact whose parent directory
*is* readable is a resolved observation; a parent that cannot be opened, a
missing mount, `EIO`, `ENOTCONN` or a changed volume identity is unavailable and
preserves everything. An unavailable record's bytes count toward neither the
reclaimable total nor a decision to retire something else.

### Retirement state machine

Retirement is journaled with the same intent-precedes-effect discipline as every
other phase, using the existing `DiscardIntent` / `Discarded` phases:

1. **Claim** the exact native owner at the inspected generation.
2. **Verify safe** — reopen the artifact root, classify all endpoints, and
   require the public endpoint to hold the exact recorded live version. Failure
   here changes nothing.
3. **`DiscardIntent`** — journaled intent. Nothing has been removed yet.
4. **Remove artifacts** — through retained, identity-checked handles, each entry
   captured into a private quarantine before unlinking, with directory
   durability barriers after each removal.
5. **`Discarded`** — journaled completion.
6. **Retire the record** — remove the journal row, retire the catalog evidence,
   and retire the owner lock once nothing references it.

The journal row is removed before the catalog record, because a journal row
without catalog evidence fences every managed mutation, while a catalog record
without a journal row stays discoverable. A crash between those two commits
therefore leaves catalog-only residue, which the enforcement pass retires once
it has verified — outside the admission gate — that the artifact root is absent.
That same rule reclaims a record whose index was lost before it created any
artifact, and it is the only path that retires evidence without a checkpoint.

Every step is idempotent and resumable. A resumed retirement re-derives its next
effect from observed endpoints, never from the phase label alone: an artifact
already absent is a completed step, not an error. Because the artifact root may
legitimately be gone at step 4's checkpoints, retirement opens the root
tolerantly, unlike execution's reopen, which requires it.

Original data and history authority survive until step 5 commits. Native
replacement history entries pointing at a record are invalidated by the record's
disappearance through the existing generation check; they are never given a
different record.

### Failure preserves inventory

A cleanup failure — `EACCES`, `EBUSY`, `ENOENT` on an ancestor, a missing volume,
a changed identity — records the error on the checkpoint, leaves every remaining
artifact in place, and leaves the record in the inventory in a **retained
evidence** state with the reason shown to the user. It is reported, not retried
automatically, and never silently converted into a completed retirement.

`ENOSPC` cannot lose records. The intent write precedes every effect, so a
disk-full journal write aborts retirement before anything is removed. A
disk-full write of the *completion* checkpoint leaves `DiscardIntent` with the
artifacts already gone, which the tolerant reopen resumes to completion. No
retirement step deletes catalog evidence before its journal completion commits.

### Catalog schema, versioning and migration

`recovery_records`, `PRAGMA user_version = 1` and the `TERCV001` catalog frame
are unchanged; retirement needs no new persisted fields, so pre-existing records
remain readable and retirable without migration. Usage accounting is derived and
memoised, never journaled, specifically so accounting can change without a
schema version. A future field follows `effect_revision`'s precedent —
`#[serde(default)]` with a documented legacy meaning — and a `user_version`
greater than the supported version continues to fail closed rather than migrate.

### Operation kinds

Retirement dispatches on `OperationSpec` / `OperationState` through a single
retirement-plan function that names the artifacts a record retains and the live
endpoints that must be verified before each may be removed. A kind without a
plan is listed, never retired, and reported as requiring further support. Move
records (#685) slot in by supplying their plan — parked source and destination
endpoints — with no change to the state machine, the budget or the UI.

### Platforms and adapters

Linux only, matching ADR 0020's runtime enablement. Retirement uses the existing
Unix private-storage validation, handle-relative unlink and directory barriers.
Windows and macOS need their adapters' delete-pending, ACL and namespace-flush
semantics qualified before enablement; the plan and budget layers are platform
independent and are unit-tested as such.

## Limits and required follow-up

The bounded private-root walk measures what the application copied; it is not a
quota enforced by the filesystem, and an artifact modified by an external writer
between measurement and retirement is detected by identity, not by size. Budget
enforcement bounds *new durable records*, not disk usage already committed.
Automatic retirement deliberately reclaims very little: the common completed
overwrite retains a sole original and always requires an explicit user decision.
Process-kill acceptance covers the checkpoints in this document with the kernel
alive; power-loss durability is not claimed. Windows/macOS retirement, Move
retirement plans and a retention view of native history remain outstanding.
