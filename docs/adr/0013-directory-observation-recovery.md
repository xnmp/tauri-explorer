# Directory observation recovery

Status: Accepted

Governs: `src-tauri/src/files/watch_observation.rs`,
`src-tauri/src/files/fs_watcher.rs`, `src-tauri/src/files/directory_watches.rs`

Renderer-owned leases and observation health are separate concerns. The lease
registry retains identity and release authority across an observation outage;
cache eligibility and new shared acquisitions require healthy coverage.

`Observation` owns one shared native watcher generation, desired roots, physical
registrations and recovery deadlines. Its injected factory permits deterministic
failure/interleaving tests. The filesystem adapter owns cache invalidation and
coalesced frontend events. Native callbacks never take the filesystem service
mutex: installation and removal may synchronously wait for those callbacks.

Direct observation registers each root and its parent non-recursively. Physical
paths are shared across parent/root roles and removed only when no surviving
root needs them. This detects deletion, movement and replacement of the watched
inode. Data and metadata modifications refresh directory entries and previews;
Access events are ignored. Recursive observation remains a separate, lazy source
used only for Quick Open name/path cache coverage. Ordinary pane observation does
not recursively walk a tree or create a watcher per directory.

A native callback error, rescan/overflow signal, or root lifecycle change faults
its generation before publishing invalidation. Recovery reconstructs coverage
using the existing filesystem flush worker. Retired generations reject new
callbacks. A callback accepted before retirement can finish a conservative
invalidation/refresh; it cannot publish cached data or restore replacement health.
Relevant callbacks during initial installation
are latched and request a catch-up refresh after successful activation. A fault
during installation prevents activation.

Missing roots and factory failures retry with exponential backoff, capped at
25.6 seconds. The flush worker retains the earliest deadline and does not acquire
the filesystem service mutex on every debounce tick during an outage. The final
release removes recovery demand and native registrations.

A recursive registration can partially succeed before returning an error. Such a
candidate is discarded entirely; the failed root is excluded from that recovery
attempt so healthy siblings can recover. Each restart excludes one root, bounding
candidate attempts by the number of desired roots plus one. Registration outcomes
can change during recovery; the ordering limits repeated successful tree traversal
under stable outcomes, not arbitrary filesystem churn. Later successful incremental
registration restores only the missing root. Removing an overlapping
recursive registration reconstructs all survivors because notify can remove
shared descendant OS watches. Successful incremental additions preserve unchanged
ancestor/descendant cache epochs (#651).

Coverage transitions advance each affected root's cache epoch before advertising
coverage. Actual filesystem changes retain ancestor/descendant invalidation.
Refresh delivery follows the existing trailing debounce and pane refresh policy;
this boundary introduces no new frontend refresh gate.

Native delivery is eventual. The initial directory listing still precedes watch
acknowledgment; callbacks captured during installation are covered here, but a
mutation before native registration exists needs a separate listing/watch handoff
contract. This decision does not establish macOS startup latency or platform-wide
native acceptance.

References: notify's [Watcher requirements](https://docs.rs/notify/latest/notify/trait.Watcher.html),
[rescan contract](https://docs.rs/notify/latest/notify/struct.Event.html#method.need_rescan),
and [Linux implementation](https://docs.rs/crate/notify/latest/source/src/inotify.rs).
