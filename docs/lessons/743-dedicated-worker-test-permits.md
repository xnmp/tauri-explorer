# #743 — dedicated-worker tests stranded a queued future and aborted the suite

**Symptom.** `pooled_and_dedicated_batches_keep_cleanup_owned_after_the_waiter_disappears`
timed out under full-suite concurrency. While it unwound, `Cleanup::drop` /
`ObservedOwner::drop` unwrapped disconnected channels. A panic in a destructor
during unwinding aborted the whole test process (SIGABRT).

**Cause.** Dedicated batch workers (`batch::run_dedicated*`) share one
process-wide semaphore of four permits. The waiter-drop tests polled their
batch future once with `Waker::noop()` and then blocked on a test channel.
When all four permits were held by parallel tests at that single poll,
`acquire_owned()` returned `Pending`. The release of a permit then woke the
no-op waker. Nothing polled the future again, so its worker never started,
however soon a permit became free. The failure was always the `dedicated`
variant: 4 of 6 loaded runs (`--test-threads=64`) failed before the fix and
0 of 6 after it.

**Fix.**
- `batch::drive_until_stopped` polls the future like an executor. It re-polls
  only after the future's waker fires, and checks the test's stop signal before
  every poll. A queued caller therefore starts as soon as a permit frees, as it
  does in production.
- `a_caller_queued_behind_every_permit_starts_once_one_is_released` holds all
  four permits, queues a fifth caller, and releases one. It fails with the
  single-poll behaviour and with a no-op wake, so it proves the wakeup rather
  than a timed re-poll. Its threads are joined even when an assertion fails,
  so they cannot hold permits after the serialization guard is released.
- Tests that hold a dedicated permit across a timed handshake also take
  `batch::serialize_dedicated_workers()`. One test's deadline then cannot run
  while other tests hold permits for their own handshakes.
- Helper destructors never panic. A missed handshake leaves the cleanup marker
  unwritten, and the owning test's own assertion reports it. An induced early
  assertion failure now reports normally instead of aborting the suite.

**Rules.**
- Never assert progress on a future that was polled once with a no-op waker
  if it can wait on a shared resource: the resource's release wakes nobody.
  Drive it with a real waker.
- Serialize tests that hold a process-wide resource across a timed handshake.
- Teardown helpers must not unwrap channel operations.
