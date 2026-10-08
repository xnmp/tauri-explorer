# 974 — Separate cache contracts from delayed native notifications

The macOS streaming-search fixture attributed every extra scan to a cache or
coverage bug. Native notifications from its own setup writes could arrive after
the first listing was published, correctly invalidating it before the next query.

The first hosted diagnostic reproduced the overlapping-parent count failure.
The file was created at 35.149 ms; the parent published revision 10 at 47.397 ms.
Its recursive `Create(File)` arrived at 47.531 ms and removed the 0.190 ms-old
listing. Child coverage subsequently advanced only the child's epoch. Parent
reuse correctly missed revision 11 and scanned again. TTL, capacity, coverage
loss and refused publication did not cause this reproduced failure. The
original uninstrumented CI event sequence was not recorded.

[Negative causal receipts](../reviews/974-cache-watch-fixture/negative-receipts.json)
bind that reproduction to the diagnostic source, run and log. One of 20 original
isolated controls failed. Moving the overlapping file before registration then
passed that assertion in 48 controls, but seven of 50 controls still failed:
two initial-query counts and five shared-owner counts. Delayed Direct/Recursive
setup events rejected publication or removed a new listing. Pre-watch setup is
therefore insufficient to make lifetime scan totals deterministic.

[Follow-up comparison](../reviews/974-cache-watch-fixture/setup-comparison.json)
retains those results. Diagnostic logging can affect scheduling; these receipts
prove the observed reproductions rather than every possible native delivery.

Use three independent contracts:

- Controlled actual streaming commands retain exact cross-query reuse and
  changed-directory/descendant scan counts. Serialize the handful of tests
  sharing the process cache so its four-root capacity does not become another
  source of interference.
- An isolated `DirectoryWatches` plus actual `NativeObserver`/`Observation`
  dispatches through the same production invalidation adapter into a local real
  cache. Assert parent preservation, child rebuild, shared-owner preservation,
  final-owner epoch retirement and rejection of a pre-retirement publication.
- Real native streaming checks keep returned-file, coverage, cancellation and
  stale-publication outcomes. A mutation waits for its exact path's Recursive
  callback after invalidation, with observation time at or after that write
  began. Another path's callback or a coverage revision cannot acknowledge it.

A receipt acknowledges an invalidation, not a drained event stream. `notify`
does not expose native stream flush/IDs, and one FSEvents flags record may
produce several application callbacks. Do not suppress legitimate invalidations,
add quiet-period sleeps, or relax stale-result/cancellation assertions.
