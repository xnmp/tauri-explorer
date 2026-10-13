# Service admission and completed subprocess boundaries

Shared cwd `/var/tmp/te-wt2/hops`, branch `feat/ai-ops-auto-settle`. No commits.
Coordinator owns broad Rust/native/Vitest verification and the final report.

## Finding 2: delayed optional-provider admission

Production `service_bridge::invoke` now delegates to `invoke_admitted` with the
original provider lease. The lease's lifecycle revision is checked before and
after `ensure`, by the image bridge's liveness predicate, and immediately before
dispatch. Recovery control calls use the same revision fence around ensuring a
replacement and claiming recovery. This prevents disable/re-enable from lending
a fresh provider incarnation to an admission that disable already cancelled.
Final references: `service_bridge.rs:581,587,589,634,639,1107`;
native regression `service_native_tests.rs:2005`.

`native_service_admission_before_disable_cannot_start_after_reenable` exercises
the actual helper with a native Wry app and Python SDK fixture. The consumer has
an optional provider dependency, remains enabled, and owns the old call lease.
The provider completes disable/re-enable before the delayed invoke resumes.
The test asserts no paid `.start` and no new durable admission.

Fail-first `/tmp/hops-service-admission-red.log`: 0 passed, 1 failed (0.28 s),
observed `.start` and a Running receipt. Green
`/tmp/hops-service-admission-green.log`: 1 passed, 0 failed (0.24 s). Private
Xvfb/Openbox, separate D-Bus/XDG, x11, actual app DISPLAY checked.

The exact reported interleaving was introduced on this branch by `22eddca4`.
Current `origin/dev` is `773eb55a`: its bridge also lacked the revision check,
but `drain_idle`/`begin_drain` refused lifecycle mutation while a lease was live.
The branch added `begin_change` to make explicit lifecycle mutations unblockable,
making the previously protected delayed call reachable.

## Additional defect: cancelled leases exhaust fresh capacity

Minimal capacity trace: acquire all 16 provider service leases; lifecycle change
invalidates them; acquire a fresh lease before old owners drop. The old code
rejected that fresh lease. Admissions counts now include the lifecycle revision;
capacity sums current revisions only, and Drop decrements its exact original
revision. All revisions still count toward actual ownership/idle proofs, so
cancelled-but-running workers cannot be reported idle during output handoff.
Final references: `backend.rs:70,151,190`;
`service_bridge_tests.rs:64`.

`lifecycle_change_releases_cancelled_service_capacity_without_releasing_live_ownership`
checks all 16 fresh admissions and verifies dropping stale leases cannot free
the fresh generation's capacity. Red `/tmp/hops-service-capacity-red.log`: 0
passed, 1 failed (0.00 s), `Plugin call capacity reached`. Green
`/tmp/hops-service-capacity-green.log`: 1 passed, 0 failed (0.00 s).

## Additional defect: cancellation discards an already exited paid CLI

Minimal trace: start CLI; CLI exits 0 with full stdout/stderr; cancellation
predicate observes owner retirement before the host polls that exit. Both Unix
supervisor and fallback plugin process helper returned Interrupted and discarded
the original bytes before any spool could preserve them.

The regressions block the first post-spawn cancellation callback until Linux
`/proc/PID/stat` reports a zombie and `waitid(WNOWAIT)` proves exit 0. They then
return true without reaping, leaving production responsible for observing exit.

Unix supervisor now checks the authoritative, unreaped leaf exit after sampling
cancellation and before acting on cancellation or anchor death. It retires the
owned tree and drains original pipes as before. `process_ext` uses a private
completion policy: owned plugin `output_with_input` preserves a completed exit
and retires descendants; generic scans keep their original cancellation check
while descendants hold pipes. Live children still terminate promptly.
Final references: `process_supervisor.rs:458`; `process_ext.rs:121,274`;
ordinary regression `process_ext.rs:662`.

Fail-first ordinary test `/tmp/hops-completed-cancel-ext-red.log`: 0 passed, 1
failed (0.00 s), `Started(Other("plugin retired"))`. Exact production supervisor
fixture `/tmp/hops-completed-cancel-supervisor-red.log`: first 14 fixtures passed,
then completed success was returned as `started-error=fixture cancelled`.

Final `/tmp/hops-completed-cancel-ext-final.log`:

```text
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 2278 filtered out; finished in 0.11s
```

`/tmp/hops-completed-cancel-process-run.log`:

```text
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 2277 filtered out; finished in 0.31s
```

`/tmp/hops-completed-cancel-supervisor-green.log`: all 21 exact-module process
fixtures passed, including completed success/nonzero versus cancellation, live
cancellation, overflow, large stdin, parent SIGKILL, gated pre-exec parent death,
and private mode rejection. Build/run:

```sh
CARGO_TARGET_DIR=/tmp/hops-supervisor-target cargo build --offline --manifest-path src-tauri/test_support/process_supervisor_fixture/Cargo.toml
python3 src-tauri/test_support/process_supervisor.py /tmp/hops-supervisor-target/debug/te-process-supervisor-fixture
```

The fixture needs private Unix sockets; sandboxed socket creation must be enabled.
No GUI, accounts, paid endpoints or network calls are involved. An independent
review confirmed completed-exit precedence, ownership cleanup before reaping,
prompt live cancellation, unchanged generic Git behavior and overflow limits.

## Additional defect: detached pipe holder discards a fully captured image

The independent reviewer identified a further boundary. A paid CLI can fork a
helper that calls `setsid` and retains stdout/stderr, then write and flush a
complete valid PNG and exit 0. The detached helper never writes bytes. Killing
the owned process group cannot close its inherited pipes, so the bounded drain
expired and discarded the already captured original.

Minimal trace: fork detached inert pipe holder; original leaf emits the complete
74-byte decoded 2x3 PNG and completed stderr and exits 0; owned group cleanup;
EOF drain deadline. Exact production supervisor red
`/tmp/hops-detached-output-red.log`: `started-error=Owned output drain stopped`.
Fallback red `/tmp/hops-detached-fallback-red.log`:
`started-error=Child output pipes remained open after exit`.

Supervisor readers now return their captured bytes when stopped after the
authoritative leaf exit; cancellation/error callers still return their original
error. Fallback owned-plugin capture keeps a bounded shared buffer through an
individual pipe's EOF, freezes both buffers at the completed-leaf drain deadline,
and retains the original exit/status while blocked readers detach boundedly.
Generic Git cancellation and pipe-reader behavior remain unchanged.
Final references: `process_supervisor.rs:327,458`;
`process_ext.rs:346,377,381,386`; exact-module PNG fixture
`test_support/process_supervisor_fixture/src/main.rs:248`.

Fixtures cover both pipes held, stdout held, and stderr held, through both exact
production helpers. They assert original PNG and stderr equality. Additional
partial-output fixtures verify the helper returns only the captured half-image
and cannot invent a complete PNG; provider image validation still determines
whether raw stdout contains valid image output.

Final ordinary helper batch `/tmp/hops-detached-output-ext-green.log`:

```text
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 2278 filtered out; finished in 0.12s
```

Final owned plugin batch `/tmp/hops-detached-output-process-run-green.log`:

```text
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 2277 filtered out; finished in 0.31s
```

`/tmp/hops-detached-output-final.log`: all 29 exact-module supervisor/fallback
fixtures passed. The private fixture runner cleans up and reaps its own escaped
helpers using a local subreaper; production never changes global child policy.
Independent final review confirmed capture/close serialization, preservation of
the pipe that reaches EOF first, authoritative original exit, unchanged generic
behavior and overflow rejection, with no further verified defect.

## Bridge fixtures and contract updates

The bridge group reused process-global `consumer`/`provider` package identities
across distinct filesystem fixtures. Default parallelism let one test's lifecycle
fence cancel another profile. A test-only FixtureRoot owns a profile mutex;
within-test worker/thread interleavings remain concurrent. It never holds the
production action guard across asynchronous worker recovery.

Old tests were updated for the required no-replay execution fence with zero
inactive reservations, missing-success deferral, and collection of invalid empty
stages. Unknown original recovery no longer panics in a fake: original handoff
is unpaid, while paid `.start` assertions still forbid replay. A fallible fake
seal helper propagates expected quota errors instead of poisoning action locks.

`/tmp/hops-service-bridge-isolated.log`:

```text
test result: ok. 75 passed; 0 failed; 0 ignored; 0 measured; 2206 filtered out; finished in 25.23s
```

## Independent adversarial review

Fresh review confirmed independent valid/durable-original model obligations,
provider Unknown knowledge, worker active/idle policy, per-path unflushed quota
accounting, real Store reopen, and quiescent zero claims/exact retained bytes.
It identified original-request collisions across host spool incarnations,
unbound/bound custody distinctions, active-writer collection races, and unreadable
host output mistaken for absence; owners supplied fixes and regressions. See the
coordinator's handovers for those production changes and model shrunk traces.

Known model limits are explicit: provider/consumer transport is fake while the
Store/service/lifecycle code is real, and power loss models unsynced filesystem
entries/writes rather than arbitrary storage-controller corruption. SQLite uses
real FULL-synchronous transactions. Native/standalone subprocess tests cover the
broker/process boundaries outside that model.
