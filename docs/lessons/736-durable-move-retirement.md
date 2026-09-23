# #736: Move retirement owns the inverse and both artifact roots

A completed move's durable record is its exact Undo authority. A same-volume
rename with no private payload still needs explicit discard; a cross-volume
parked source is the original object, not an automatically disposable copy.
Restoration consumes that inverse and can leave a redundant regular-file copy
eligible for automatic cleanup. Directories require explicit disposal.

Retirement needs operation-specific observation and one durable decision followed
by independent source-root and target-root intent/completion checkpoints. Keep
all managed mutation claims while cleanup is partial, reject history claims after
discard begins, and retire catalog evidence only after every planned root is gone.

A `Removing` bit does not distinguish an application's partial tree deletion from
a foreign child added after interruption. The first implementation reproduced
that error: a new child inside `parked/` was swept on resume. Capture bounded
native descendant plans for both roots before the global decision, journal them
together, verify the entire
remaining namespace and each leaf version, and reject unplanned descendants.
Missing planned children are resumable work; new or changed children are not.

Bound plans by encoded bytes as well as depth and entry count. Bound each root to half the aggregate plan budget and persist both before the
first effect, then release each completed root's plan. Keeping a later root's plan
only in memory lets a restart recapture and adopt a foreign descendant; storing
two independently unbounded plans can instead exceed the journal size limit
after the first root has irreversibly disappeared.

Cleanup eligibility is independent of accounting. An edited public target may
prevent removal while private artifacts still consume disk. Measure those
observable roots even when cleanup is refused; unknown interrupted-retirement
bytes must be reported as unmeasured or unavailable, never silently zero.

Regression evidence includes real filesystem outcomes, source/target conflicts,
foreign children before and during deletion, actual Undo after measurement,
partial-cleanup ownership fences, and process kills at both root boundaries and
inside directory deletion. Native UI acceptance and filesystem capability
preflight remain separate requirements; durable move recovery remains opt-in.
