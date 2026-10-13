# Reference model and frontend settlement correction

Shared working tree `/var/tmp/te-wt2/hops`, branch `feat/ai-ops-auto-settle`.
No commits. Coordinator owns all production Rust fixes and broad verification.

## Model

`src-tauri/src/installed_plugins/ai_operations_model_tests.rs` is included by
`lifecycle::mutation_matrix_tests`. It uses proptest's hand-written reference
state-machine pattern: shrinkable command vectors exercise the real Store,
image-call bridge, automatic reconciliation and lifecycle operations.

Independent domain truth records paid success, original image bytes, validity
and durability, provider knowledge, worker activity, acquired consumer bytes,
acknowledgment, explicit removal and previously proven idle execution fences.
Artifacts and transfer handles come from production; native preflight and
provider/consumer transport are infrastructure fakes. Three slots admit many
unique request identities across package generations with a small quota.

Commands cover admission/input capture; full/partial/synced/unsynced staging;
seal and whole provider completion; success/Unknown/Failed/Cancelled publication
and commit failure; host-spooled completion with provider knowledge still
Unknown; healthy/unhealthy probes; independent provider/consumer active-to-idle
proofs; acquire, acknowledgment and consumer crash before presentation; replay;
compatible/incompatible replacements of either role with live call leases;
disable/re-enable/uninstall; GC/sweep; unlink/directory-sync faults; reopen after
process crash; and power loss. A compound recovery writer transition holds a
real permit across stage writing, a second Store opening, and GC.

Every step checks conserved originals and acknowledged bytes, one paid start,
monotonic job revisions/completion, durable idle fences, live-worker protection,
terminal/released removal and at most one undelivered notice. Quota is bounded
against live output reservations plus per-path possible disk bytes. The fs
oracle returns every unflushed removal, including restored older bytes at a
recreated path; each path contributes max(current, restored), never a global max
or duplicate charge within an existing output reservation. SQLite uses real
FULL-synchronous transactions. Power-loss simulation drops unsynced stage
writes and restores unflushed removals, not arbitrary storage-controller state.

Quiescence clears injected faults and worker activity, preserves Unknown
provider knowledge, drives actual sweeps/recovery, checks original byte delivery
or terminal settlement, zero active claims and exact retained-byte accounting.
The normal property runs 64 cases with up to 40 commands; ignored deep runs
1024 cases with up to 100 commands. Applied family counts are printed.

## Genuine shrunk model failures

Every trace starts with one real admission. Seeds are retained in
`src-tauri/proptest-regressions/installed_plugins/ai_operations_model_tests.txt`.

1. `[Sweep, Stage(0, false, false)]`: stage disappeared while original recovery
   still owned its permit. `/tmp/ai-model-2.log`; coordinator fixed shared writer
   guards and GC/Store-open validation.
2. `[Sweep, DirectorySyncFailure(true), Upgrade(false, false, false)]`: physical
   reservation reconciliation blocked incompatible consumer replacement.
   `/tmp/ai-model-5.log`; coordinator deferred cleanup while keeping accounting.
3. `[Stage(0, true, false)]`: valid original image with permanently Unknown
   provider knowledge never received recovery. Also reproduced independently
   with a durable stage in `/tmp/ai-model-unknown-original.log`; coordinator
   routes retained valid output to original unpaid recovery.
4. `[Sweep, Upgrade(false, true, false), DirectorySyncFailure(true), Probe(true)]`:
   newer cached Running status revoked the durable idle execution fence and
   resurrected an unreserved capacity claim. `/tmp/ai-model-deep-2.log` and
   `/tmp/ai-model-cached-running-red.log`; coordinator changed receipt publication
   to restore custody only for original success.

Driver-only failures were corrected and their seeds removed: starting a host
process after an already settled admission; attempting Unknown-to-Failed,
which violates receipt transition validation; leaving an injected commit
failure armed after a rejected receipt; reusing an admission identity after
quota-rejected preparation; and counting an unflushed stage twice inside its
existing reservation. These are not production defect claims.

## Frontend finding 3

`src/lib/domain/native-plugin-jobs.ts` validates each event before merging and
accepts a newer same-identity Completed event with a nonempty delivered path
after stopped/delivery_failed/storage_full, including a null run ID. Invalid
events, changed identities, stale revisions and unrelated terminal corrections
remain rejected. Pure reducer and live-controller tests demonstrate convergence
without a reload. A Rust model regression acknowledges a recovered original,
omits consumer completion, then checks host Completed with no run ID.

Fail-first Vitest: 4 failed, 17 passed. Green reducer: 21 passed. Affected suite:
5 files, 65 tests passed (4.25 s). Command:

```sh
bunx vitest run tests/state/native-plugin-jobs.test.ts tests/state/plugin-jobs.test.ts tests/state/jobs.test.ts tests/state/jobs-retry.test.ts tests/domain/image-job-progress.test.ts
```

## Verification status

Frozen final normal module `/tmp/ai-model-final-all.log`: `test result: ok.
7 passed; 0 failed; 1 ignored; 0 measured; 2275 filtered out; finished in 8.53s`.

Final deep run `/tmp/ai-model-deep-final.log`: `test result: ok. 1 passed;
0 failed; 0 ignored; 0 measured; 2282 filtered out; finished in 267.73s`.
Its 1024 cases exercised every action family, including independent active
provider/consumer workers, individual acquire/ack/crash, 100 host spools,
142 guarded writer/GC transitions, 2171 restarts and 2140 power losses.

Coordinator owns the full Rust suites and native verification.

## Native deadline recovery finding

The real `LiveAutomatic` adapter had another liveness defect outside the fake
transport seam: each sent status RPC could consume its deadline, then a
deadline-bound job lookup returned before the failure counter advanced. Three
real timeouts therefore still appeared as zero attempts, and every fresh pass
sent another status RPC instead of settling inactive work. Combined private
native diagnostics in `/tmp/hops-native-timeout-diag.log` verified stable
incarnation, successful idle fences, idle provider/process proofs and three
actual status frames, with status failures remaining zero.

`ai_operations.rs` now records sent non-storage-full failures before
deadline-bound metadata reads. Explicit quota refusals and already-observed
storage-full jobs remain excluded, and current storage-full job state keeps
unpaid recovery eligible. The native
regression asserts each timed-out status frame and a fourth fresh idle proof
with no fourth status request. `/tmp/hops-native-timeout-green.log`:
`test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out;
finished in 1.12s`. Private Xvfb application/helper display inheritance was
verified. This fix changes the native adapter only; the frozen model source and
deep results remain applicable to store/lifecycle policy. Coordinator's final
native batch reruns timeout and storage-full after the pre-RPC quota exemption.
