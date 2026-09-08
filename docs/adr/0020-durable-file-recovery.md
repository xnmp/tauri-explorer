# ADR 0020: Durable file recovery

Status: Proposed — implementation and crash/platform acceptance outstanding.

Governs: `src-tauri/src/files/replacement.rs`,
`src-tauri/src/files/publication.rs`, `src-tauri/src/files/file_ops.rs`,
`src-tauri/src/file_history/`, `src-tauri/src/file_mutation.rs`,
`src/lib/state/window-session.ts`.

## Problem

Current replacement ownership preserves a displaced destination when rollback
fails, but its sibling JSON record is not a durable discovery service. Successful
overwrites discard the previous destination. Cross-device moves still copy then
remove the live source, and partial removal can leave the destination holding the
only complete copy. Source parking must not precede recoverable ownership: a
crash after hiding the source would otherwise strand user data.

## Proposed ownership

One native recovery coordinator owns a lazily opened, application-local SQLite
index. Use bundled SQLite through `rusqlite`, short transactions, rollback journal
mode and `synchronous=EXTRA` initially. Never hold a database transaction across
copying or filesystem calls. A database commit and a filesystem rename are
separate commits; intent precedes the effect, and observed completion follows
the required filesystem durability barriers. See SQLite's
[atomic commit](https://www.sqlite.org/atomiccommit.html) and
[synchronous modes](https://www.sqlite.org/pragma.html#pragma_synchronous).

Before an artifact-bearing operation can move user bytes, publish an immutable
record in a fixed, bounded active catalog beside the index. It names the complete
operation intent and all predicted private artifact roots. Same-volume manifests
duplicate that intent at each artifact root. Paths use tagged, lossless native
encoding; IDs are generated natively. Record and aggregate limits reject new
work before displacement rather than evicting unresolved recovery.
The order is durable catalog intent, secure private-root creation, durable local
manifest, then user-byte movement; creating a root first cannot substitute for
publishing its discovery record.

Database loss can then fall back to this one bounded catalog, without searching
arbitrary siblings or volumes. Unknown schema, corrupt records and disagreement
between catalog and database preserve the evidence. Losing the entire recovery
catalog is outside automatic discovery; sibling manifests alone do not make
arbitrary paths discoverable.

Recovery storage needs an identity-checked directory anchor and handle-relative
access to private descendants. Checking only the final path component does not
protect against parent replacement. Platform adapters must establish and retain
this authority before SQLite or filesystem work uses the namespace.

## Admission, execution and reconciliation

All managed file mutations pass the same loaded-recovery conflict check, including
when a user acts before background discovery. Conflict reservations arbitrate
across native application processes: shared admission serializes overlapping
resource claims, and an exact OS-held owner lock covers their filesystem work.
A process-local map is insufficient. Ordinary reservations last for the operation;
creating persistent hidden artifacts additionally requires durable discovery
intent. Ordinary creation, rename and permanent deletion remain outside process
crash recovery until explicitly migrated; a reservation does not promise Undo
after restart. A known unresolved path fences overlapping work. Unreadable
records with unknown affected paths fence destructive file mutations until the
evidence is resolved, while browsing remains available. External applications
and uncoordinated filesystem writers remain interference to detect by identity.

Session liveness uses an OS-held lock with recorded file identity and nonce.
Only successful acquisition of the exact abandoned lock establishes that its
owner is gone. Missing, replaced or unreadable locks are unknown. Each operation
also retains an exact lock handle and a database claim generation; every phase
transition compares the generation so a stale worker cannot settle another
claimant's work. Do not unlink actionable lock files.
Retired locks have a bounded cleanup lifecycle under exclusive shared retirement
arbitration, after proving no operation, claimant or catalog record can reference
them. Unlinking and recreating a live lock must never split its authority.

The coordinator records intent before displacement, publication, restoration or
cleanup. Captured parent and payload identities govern each step; path spelling
and timestamps alone cannot authorize an inverse. Publication remains atomic
no-replace. Files and relevant parent directories must be synchronized before a
durable completion claim. On Linux, syncing a file does not by itself persist
its directory entry ([fsync](https://man7.org/linux/man-pages/man2/fsync.2.html)).
Windows/macOS adapters require separate flush and identity acceptance.

Reconciliation is a pure policy over durable intent plus observations classified
as missing, matching, different or unavailable. An intent without a completion
record does not prove that its syscall failed. Different occupants, unavailable
volumes and ambiguous identities preserve artifacts and require attention.
Startup discovery announces unresolved work; it does not silently overwrite,
delete or restore user paths. Recovery actions revalidate under a current claim.

Overwritten originals have explicit retention leases referenced by native
history. Dropping a Rust owner never deletes retained user bytes. History
trim/clear/retirement schedules lease release outside the history mutex. Cleanup
is itself journaled: durable retirement intent, identity-checked removal,
filesystem barriers, then completion and catalog retirement. An interrupted
cleanup remains discoverable. Retained-payload quotas and visible recovery
decisions must accompany overwrite Undo; the current in-memory history budget
does not bound filesystem storage.

## Startup and delivery boundary

Initialize on a blocking owner after `WindowSession.markCoreReady`, or lazily
when the first mutation requires admission. Do not open, migrate, scan or repair
the journal in Tauri setup. Initial discovery reads the bounded index/catalog;
probing user or offline volumes is separately scheduled recovery work. This is
a startup constraint, not evidence that the half-bounce target is achieved.

First deliver a complete vertical integration into displaced-destination
ownership, with indexed restart discovery, a usable recovery surface and
subprocess crash tests. Then add overwrite Undo/retention, cross-device source
parking, move-overwrite composition and whole-intent batches. Do not count an
unused journal or policy model as delivered recovery.

Acceptance must kill the process at every intent/effect/completion boundary and
verify exact bytes after restart. Include competing claimants, interrupted GC,
disk-full commits, namespace substitution, occupied restoration paths, missing
volumes, database loss, history retirement during an inverse and actual separate
filesystems. Native Windows/macOS tests and measured launch/input latency remain
required. Portable recursive copy does not promise a point-in-time snapshot of
files still being written through existing descriptors or hard links.
