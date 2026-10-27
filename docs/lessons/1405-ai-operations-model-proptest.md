# AI-operation fixtures must own the process-wide host gates (#1405)

A loaded `cargo test --lib --features avif,durable-recovery,e2e-hooks` run
recorded a new `ai_operations_model_tests` proptest seed. The shrunk trace
passes deterministically on its own (25 idle runs, 214 runs beside 32 busy
loops), so it was not a model/implementation divergence.

The failures only appear when many installed-plugin test fixtures run in one
process. Automatic settlement gives each candidate a 10-second
`native_deadline` budget and first takes `ai_operations::ACTIONS`, a
process-wide mutex. Production hosts one profile per process, so that gate is
never shared between independent ledgers. Test fixtures, however, each own a
private profile but share the same process. Instrumenting the gate in a
parallel `mutation_matrix_tests` run showed waits of up to 10 s for other
fixtures' recovery work, and every `timed_out` deferral was an action-gate
wait that used the whole budget. The operation was then correctly left
unsettled for a later pass, but the test expected this pass to settle it. The
result was `inactive operation never settled` from the reference machine, and
failures in several directed model, matrix and `service_bridge_tests` cases.
Shrinking also ran under that interference, so the recorded trace itself has
no special meaning.

The fix removes the cross-fixture coupling rather than relaxing the budget or
the invariants. `ai_operations::exclusive_host_profile()` is a test-only
host-profile lock. Matrix `Fixture`, the model's `ProfileFixture` and
`service_bridge_tests`' `FixtureRoot` hold it for their whole lifetime, and
`FixtureRoot` previously had its own lock. One fixture still races real
threads against the real gates. Nested fixtures on the same thread share the
guard through a thread-local `Weak`, so `m = Machine::new()` reassignment does
not deadlock.

When a new test fixture drives automatic settlement, lifecycle mutation or
service-bridge admission, take the same guard. A private temp profile does not
isolate process-wide statics.
