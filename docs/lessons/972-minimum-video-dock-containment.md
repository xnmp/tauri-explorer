# Minimum video docks must retain reachable controls

The full merged-dev run initially timed out because the all-format containment
matrix still expected a video thumbnail as `.preview-image`. Replace that stale
oracle with decoded video dimensions, duration, readiness, visibility and usable
Play/Seek controls before measuring layout.

That correction exposed a real bug: the two-row controls consumed the entire
minimum-height content region, leaving a zero-height video stage and partially
clipped controls. Keep a visible stage and non-shrinking controls; use one row in
sufficiently wide players and allow the constrained player to scroll. Preserve
all generic containment assertions.

Errors need separate geometry: a tiny normal media stage can clip the complete
message and external-open button even when a center-point hit test succeeds.
Give failed stages intrinsic room and safe scrollable message alignment. Verify
full text/button bounds and the actual external-open outcome.

Do not modify tests or source while a long Vite-driven matrix runs. HMR can
navigate a live test back to its initial path and detach a virtualized entry,
creating unrelated metadata and scroll assertions. Rerun after edits settle.
