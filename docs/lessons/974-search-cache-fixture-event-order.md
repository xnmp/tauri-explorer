# 974 — Seed cached-search fixtures before watching them

The macOS streaming-search test asserted that registering child coverage must
preserve an unchanged cached parent. Its own `before-overlap.txt` creation
occurred after an earlier fixture had started the shared native watcher.
A delayed notification could therefore invalidate the parent after the listing
was published, making the exact walk count attribute a file event to coverage.

The hosted diagnostic reproduced the same assertion in isolated control 10.
The file was created at 35.149 ms; the parent published revision 10 at 47.397 ms.
Its actual recursive `Create(File)` event arrived at 47.531 ms, followed by
`Changed`, path invalidation and removal of the 0.190 ms-old listing. Child
coverage subsequently advanced only the child's epoch. Parent reuse correctly
missed revision 11 and performed its second walk. TTL expiry, capacity eviction,
coverage loss and refused publication did not cause this reproduced failure.
The original uninstrumented CI event sequence was not recorded.

[Complete causal receipts](../reviews/974-cache-watch-fixture/negative-receipts.json)
retain the diagnostic source, run, log hash and ordered observations. The
parallel library suite passed; one of 20 isolated original-fixture controls
failed with exit 101. Diagnostic logging can change scheduling, so those
observations establish this reproduction rather than every possible delivery.

Create the initial overlapping file alongside the initial directories, before
any watcher registration. Keep every cache count, epoch, invalidation and
returned-file assertion. Production cache invalidation is correct for an actual
file event; do not suppress it or add a quiet-period sleep to make the test pass.
