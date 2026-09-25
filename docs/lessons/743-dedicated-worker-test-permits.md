# #743 — dedicated-worker tests starved each other's permits

**Symptom.** `pooled_and_dedicated_batches_keep_cleanup_owned_after_the_waiter_disappears`
timed out under full-suite concurrency and, while unwinding, `Cleanup::drop` /
`ObservedOwner::drop` unwrapped disconnected channels: a panic in a destructor
during unwinding aborted the whole test process (SIGABRT).

**Cause.** Dedicated batch workers (`batch::run_dedicated*`) share one
process-wide semaphore of four permits. Several tests hold a permit while they
handshake with their own test thread. Under a parallel harness a worker queued
for a permit behind other tests' handshakes and missed its 3 s deadline. The
failure was always the `dedicated` variant: 4 of 6 loaded runs
(`--test-threads=64`) before the fix, 0 of 6 after.

**Fix.** Tests that use dedicated workers take
`batch::serialize_dedicated_workers()` first, so they queue before their
deadline starts; production permits are unchanged. Helper destructors never
panic: a missed handshake leaves the cleanup marker unwritten and the owning
test's own assertion reports it. An induced early assertion failure now
reports normally instead of aborting the suite.

**Rule.** A test that holds a process-wide resource across a timed handshake
must serialize with the other holders; teardown helpers must not unwrap
channel operations.
