# Quick Open watch cancellation and navigation (#1007)

The prepared base already contains #1028's dedicated recursive-watch worker and
#1022's phase-separated load diagnostics. Do not put recursive registration,
recovery, overlapping-root reconstruction or native watcher destruction back
under the direct directory lease mutex. Navigation still acquires an owned
observation before scanning (ADR 0014).

The remaining gap was upstream of walking: streaming search did not pass its
cancellation flag into watch admission. Cancelled searches could queue recursive
registration and preserve retry demand. Cancellation now reaches the worker and
its waiter. Native registration cannot be interrupted portably, so the waiter
returns independently; after the native call finishes, obsolete demand is
removed before any recovery. Pending demand is shared by identity and live
request flags, so cancelling one request cannot retire another search's root.
Successful registration retains pane-owned cache coverage. Failed registration
remains cancellable while its search runs; a completed uncancelled search retains
the recovery demand until the final pane release.

Reconcile after slow native operations as well as before them. A final lease
release can revoke demand while an add fails, and retrying before processing the
queued removal redoes expensive work. Batch obsolete recursive roots: removing
one at a time would rebuild other overlapping roots that are also obsolete.
Existing generation faults, per-root cache epochs and survivor reconstruction
remain owned by Observation (ADR 0013).

The cancellation regressions first failed with cancellation ignored. They check
physical watch calls, independent waiter replies, cache eligibility and stale
publication, including the actual streaming command path. The watch-limit test
injects notify's MaxFilesWatch and gates its successful retry while unrelated
owned navigation scans and releases leases. Native acceptance uses a synthetic
8,192-directory tree and the existing bounded registration gate on a private
X11 display.

Diagnostics join by root and log timestamp: Quick Open logs search ID and total
observation wait, and the recursive worker logs registration/recovery start and
duration. Existing navigation trace IDs retain watch-lock, watch-register,
read-dir, metadata, serialization and full frontend navigation durations.
Existing window-handoff records separately include request identity, phase,
elapsed, listener and dispatch timings. No warm-window behavior was changed.

Review also found two recovery seams worth keeping explicit: a later healthy
acquisition must adopt coverage independently of the original failed requester,
and an incremental watch-limit failure must not bypass its retry deadline when
discarding a partially installed watcher. Rebuilding healthy siblings excludes
recursive roots whose existing backoff has not elapsed. Final removal remains
silent and retires callback delivery, as the existing contract test requires.

A recovery pass can register several roots. Reconciliation around the whole pass
is insufficient: one native registration can block while a later root is
cancelled. Check live demand and its captured identity before each root in both
incremental recovery and survivor reconstruction. The regression gates whichever
root starts first, cancels the other, and proves no second native watch begins
for the cancelled root in either recovery mode.
