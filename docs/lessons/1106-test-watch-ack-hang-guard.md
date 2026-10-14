# 1106: test watch acknowledgements need a hang guard, and shared test locks must recover

- `ChangeReceipt::wait_after` (test_support/watch_observation.rs) waits for the native watcher to acknowledge a specific write. Its deadline is a hang guard (`ACK_HANG_GUARD`, 30 s), not a latency budget: on a loaded machine the native callback can lag by several seconds, and a 5 s guard failed healthy runs.
- The shared test mutexes in search.rs (`TEST_CACHE_COMMANDS`, walk counts, stream gates) must be taken through `LockTestState::lock_test_state`. A panic while holding one poisons it, and without recovery every sibling test then fails with an unrelated `PoisonError`.
- A never-acknowledged write still panics with the same message at the guard. Loaded runs can still miss an acknowledgement entirely (one in ten in the verification for this fix), so the guard does not make those tests reliable on its own.
