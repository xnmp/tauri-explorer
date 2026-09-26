# ADR 0023: Recovery artifact retention and durable retirement

Status: Proposed — Linux only; Windows/macOS adapters and native acceptance
outstanding.

Governs: `src-tauri/src/files/recovery/retention.rs`,
`src-tauri/src/files/recovery/retirement.rs`,
`src-tauri/src/files/recovery/replacement_retire.rs`,
`src-tauri/src/files/recovery/coordinator/retirement.rs`,
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

Every durable record consumes the record bound, settled or not: an unresolved
record retains artifacts too, and the bound exists so retention policy refuses
new work before the catalog exhausts itself with an unexplained "catalog is
full".

Per ADR 0020, **budgets reject new work; they never evict unresolved recovery.**
When retention is at or over budget, promotion of a new durable record fails with
a message naming File Recovery. Both bounds are checked from decoded durable
evidence inside the same admission-gated SQLite transaction that publishes the
catalog, so concurrent record creation cannot race past either one. A record
created but not yet measured contributes zero bytes until the next enforcement
pass measures it; the record bound is what caps that window.

Enforcement claims ownership only where ownership can accomplish something —
journaling a first measurement, or reclaiming a redundant artifact. Claiming
advances a record's generation and therefore invalidates the generation the user
is looking at, so a settled record with nothing to do is never claimed by an
enforcement pass.

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
a restored record's retained `publication` of a **regular file**, whose content
is already published at a live endpoint, and the residue of a record already
journaled `Discarded`. A directory payload is never provably redundant here:
`EntryVersion` is deliberately not a recursive snapshot, so an unchanged
directory version cannot show that the tree beneath it still holds what the
parked copy retains. Directory payloads always need an explicit user decision.
It runs only from recovery-session activity or immediately after a new record is
created, walks the inventory in catalog order, and leaves any record it cannot
verify exactly as it found it before continuing to the next.

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
4. **Re-observe, then remove** — journaling the intent released and retook the
   admission gate, so the live endpoint is classified once more immediately
   before anything is unlinked. A changed endpoint refuses the removal and
   preserves every file. Removal then goes through the retained,
   identity-verified root handle:
   the private namespace is revalidated, each recorded entry is unlinked
   handle-relatively, the root is synced, and only then is the root directory
   itself unlinked from its verified parent and that parent synced.
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

Enforcement therefore resumes only a *crash-interrupted* retirement, one with no
recorded failure (#760). A journaled retirement carrying an error waits for the
user's explicit retry; one whose artifact parents cannot be opened with their
recorded identities (checked read-only, before any claim) is left unclaimed and
counted unavailable; and one that is claimed but cannot proceed records its
reason, so later passes skip it. None of these is claimed on every pass, which
would otherwise advance its generation each time and invalidate the one the user
is inspecting.

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
`retention` function that names the artifact a record retains and its disposal
rule, paired with a `retirement_step` observation that verifies the live
endpoints before anything may be removed.

Durable moves use `move_retention.rs` for pure policy and
`move_retirement.rs` for native observation and cleanup. Their settled positions
have these rules:

| Move position | Disposal |
| --- | --- |
| Same-volume Published, including a rename with no artifact root | Explicit only: the record is still its Undo authority |
| Cross-volume Published | Unresolved: source parking has not completed |
| Cross-volume Parked | Explicit only: the parked source is the exact original required by Undo |
| Removed with displaced target original | Explicit only |
| Removed without displaced target original | Automatic verified residue cleanup |
| Restored rename | Automatic verified empty-root/evidence cleanup |
| Restored cross-volume regular file | Automatic only after both public endpoints verify |
| Restored cross-volume directory or symlink | Explicit only |

One durable decision authorizes the whole immutable cleanup plan. Each root has
its own `Pending -> Removing -> Removed` checkpoints, in source-then-target
order. Root removal intent precedes effects; completion follows the parent
sync. The final record-completion checkpoint requires both roots to be removed.
A resumed explicit decision may finish automatically, but enforcement can never
invent a decision to discard an original. Beginning retirement prevents both
history claims and forward/inverse execution, and retains full mutation claims
until record retirement releases them.

The decision is not allowed to consume Undo for nothing (#760). Public endpoints
are verified once more immediately before `BeginRetirement` is journaled. If
verification after the decision refuses while no root is `Removed` and every
root still strictly matches its captured plan, manifest and exact payload
version, `WithdrawRetirement` returns the record to its settled phase with its
effect revision unchanged. The native history entry, which survives a refused
claim, therefore claims it again. An interrupted decision that removed nothing
withdraws itself the same way when it is resumed. Once any root is retired the
decision can only be completed or forgotten.

A decision holds its cleanup plans in the journal until it completes, so
`BeginRetirement` must leave a quarter of the 64 MiB journal free
(`Journal::replace_leaving`). At most three maximal decisions can be pending
while ordinary operations keep that headroom. A declined decision journals
nothing and keeps Undo.

**Forget** (`RecoveryChoice::Release`) is the escape hatch for a committed
move discard that cannot finish: a persistent native error such as `EROFS`, a
reused endpoint, or a volume that changed identity. It is offered only for such
a stopped decision and is decided from durable evidence alone, because the
stranded volume may be exactly what cannot be observed. It removes the journal
row and catalog evidence under exact ownership and touches nothing on disk. The
record's locks are released, and any private folder it still names stays at its
listed location, owned by the user. Undo was already consumed by the decision,
so no recovery authority is lost. If the process dies between the two commits,
the catalog-only residue is retired automatically once those folders are gone.

Observation verifies both recorded public parents, the expected source and
target versions, exact private root identities and manifests, and the allowed
child set. Missing volumes, unplanned children and changed endpoints preserve
evidence. Removal deletes the expected payload first, the manifest last, and
then the empty root. Missing payloads/roots are completed work only after their
removal intent. Before the global retirement decision, bounded, no-follow walks capture both
payloads' descendant native paths and versions. Both plans are journaled with
that decision before any root effect; restart never recaptures a pending root. The journal validates that preorder tree
against the immutable top-level payload, with unique child paths, directory
parents and no cross-mount traversal. Resumption permits missing planned entries
but rejects newly added descendants and changed files before deleting anything.
Directory size/mtime may differ after the application's own child removals;
its native identity, ownership, mode and complete remaining child set must still
match the recorded plan. Every leaf is rechecked before unlink and each parent
is synced. Plans have depth, entry-count and conservative 8 MiB per-root encoded-byte
bounds (16 MiB aggregate, below the 32 MiB checkpoint limit). With long paths
the byte bound admits far fewer entries than the 65,536-entry bound (roughly
12,000 when each entry costs 2·path+512 bytes). Forward moves therefore apply the same walk and budgets
to every payload they would retain *before* any record exists, and refuse a
payload that could never be discarded (#760). A tree that grows after admission
(for example, edited after an Undo) can still exceed them; its discard then
refuses before the decision and keeps Undo. Each completed
root releases its descendant plan; all later pending plans remain durable. This does not claim protection from an external same-user writer
swapping a leaf in the final check-to-unlink syscall interval.

Move byte measurements are bounded and journaled in `MoveState.retained_bytes`;
confirmed effects and retirement steps invalidate them. Cleanup refusal does
not prevent measuring observable retained roots; unknown interrupted-retirement
bytes remain explicitly unmeasured rather than becoming zero. A rootless completed
rename measures zero bytes but still consumes a record and retains Undo.
Repeated enforcement of measured, explicit-only records does not claim them or
advance their generations. Both new move fields default when decoding older
journals; absence never grants cleanup authority. Both are also omitted from the
encoding while absent (as is `ReplacementState.retained_bytes`), so a
pre-retirement build, whose `MoveState` rejects unknown fields, still reads
every record that does not use them (#760). A measured or retiring record stays
unreadable to such a build and fails closed. Catalog-only residue requires
verified absence of every planned root, not just the first one.

Rust acceptance includes real same-volume/cross-volume files and directories,
overwrite and restoration, changed endpoints, unexpected root children, missing
roots, accounting stability, injected failures and subprocess kills at both
roots' intent/removal/completion boundaries. Native UI acceptance covers actual
file/directory move discard, accounting and preservation of externally edited
endpoints. ADR 0020 describes the journaled per-volume capability preflight:
interrupted probes permit only evidence-checked explicit cleanup, and aborted
preflight records retire only after every planned probe name is absent.

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
A record whose live endpoint has changed permanently — a foreign writer replaced
the published entry — stays in the inventory indefinitely with its reason shown,
because unverified evidence is preserved rather than resolved by deletion. That
is the same class ADR 0020 already creates for a changed restoration target; it
consumes the record bound until the user acts. Enforcement never stops early on
such a record, so one unverifiable record does not hide the rest.
Process-kill acceptance covers the checkpoints in this document with the kernel
alive; power-loss durability is not claimed. Replacement discards journal
`DiscardIntent` before their final endpoint check, so an endpoint change in that
window still consumes their Undo without removing anything; restoration remains
legal from that phase, but a withdrawal equivalent to the move one is follow-up
work. Windows/macOS retirement and a
retention view of native history remain outstanding.
