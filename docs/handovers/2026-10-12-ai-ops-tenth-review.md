# Tenth independent AI-operation review

Repository `/var/tmp/te-wt2/hops`, branch `feat/ai-ops-auto-settle`.
Review base HEAD `ae8430247d1bbc9af5bb8d17a551fccf3cdd2e35`.
Round-10 fixes are committed (7f54a10a).
Contract: `docs/lessons/ai-ops-auto-settle-review.md`.

## Numbered findings

1. Both cancellation branches kill then reap, deciding natural success from the
   actual OS result through `process_ext::reap_after_cancellation`. Drained output
   survives natural exit zero even after a stale Running observation. Observed
   nonzero natural exits retain their process status. Windows Job termination now
   explicitly uses code 1 before handle close. Fake-reaper regression failed first;
   independent real-process probes passed 29 fixtures. Exact production process
   modules compile for Windows MSVC and macOS ARM64; those checks are not native
   runtime tests on those systems.
2. Successful nonempty verified stdout independently authorizes recovery and
   delivery; incomplete stderr becomes empty diagnostics. Stdout file and entry
   barriers precede any stderr write. Quota compaction synchronizes diagnostics
   independently and preserves prior charge when a barrier fails. Collector can
   remove malformed diagnostic directories. Replaced refusal regression with
   surviving bytes plus zero charge; full model performs actual image delivery.
3. GC and the individual artifact collector use LEFT JOIN, so released orphaned
   artifact rows own collectability. Removal releases package-owned orphans by
   artifact custody. Real `recapture-retired` checkpoint crashes after retirement
   and operation deletion before replacement insertion. Regression observes zero
   files/charge via GC and explicit removal. Unexplained active sealed orphans are
   not blanket-collected.
4. Retention is not admission. Initialization schedules every admissionless,
   unacknowledged job beyond the attention deadline, adopts replacement authority,
   obtains status null, cancels/fences original operation ID, then requires status
   null again. Atomic settlement checks owner/epoch/revision/acknowledgement and
   absence of admission, releases input custody/grants, and leaves a released
   tombstone. Tests cover presentation-only, complete/interrupted capture,
   concurrent acknowledgement, stale owner replies, and late capture refusal.
5. Host ownership epoch defaults to 0 and increments during preparation adoption.
   Frontend accepts later epochs and rejects old owners even with higher revisions.
   Reducer regression failed first and verifies completion/removal updates without
   snapshot reload. Backend registration cannot forge a nonzero epoch.
6. Removed native replay's model-side expected-refusal return. Attempts now call
   real Store reservation and `process_run::admit` before metering work. Both
   reported native refusal regressions failed first. Production reservations
   reject disposed/idle-fenced originals and unauthorized changed generations;
   scoped host recovery guards allow local original reconstruction. Direct,
   automatic and service-control recovery paths own that guard.

## Model changes

- Nonempty diagnostics in every modeled successful native reply, with actual
  stdout/stderr persistence checkpoints. Full stdout + interrupted stderr delivers
  the same PNG and eventually releases every charge.
- Cancellation stale-observation + reaped natural success/kill transitions.
- Real recapture delete-before-insert crash and automatic retained preparation
  convergence; no manual dispatch/adoption is required in quiescence.
- Consumer copy-before-acquisition-proof transition. Fixture consumer persists a
  durable operation/descriptor/path journal before making a visible copy; restart
  loses transient delivery knowledge and recovers via that journal. This models
  a consumer protocol guarantee, not host enforcement for arbitrary consumers.
- Provider as well as consumer lifecycle changes while native writes or recovery
  responses are paused.
- Separately queued/delivered provider and consumer idle answers tied to their
  generations, real IdleCallFence, shared production generation validator.
- Compatible upgrade crash/power-loss boundaries at prepared/committed/published/
  replacement-abandonment, plus TestFs marker/index/snapshot-file durability.
- Checkpoints within actual aggregate stage, seal, receipt and acquisition calls;
  file creation/write/barriers and SQLite pre/post-commit boundaries are exercised.
- Restart no longer erases valid-original or paid-success truth, including
  pre-persistence success and undurable stage writes.
- Hard-link-aware physical quota oracle; equal bytes in separate objects still
  require separate charges. Power loss restores both unlinked aliases to one
  physical object. Provider visibility guards do not filter fenced/replaced
  admissions; retained preparation and consumer-idle transitions remain reachable.
- Lost receipt cannot erase actual provider invocation. Shared-consumer coverage
  increments only when an admission really changes the observable system.

## Remaining counterexamples and limits

Deep model fails on:
`[SpoolReserve(0, true, false), SpoolReply(0), SpoolCrash(0, 2)]`.
The CLI's paid original is captured only in RAM. Completion intent persists its
status/hash/length, then host restart occurs before stdout persistence. No bytes
survive. Backend ProcessSpool completion has the same capture-to-persistence
window. The conservation oracle correctly reports `original bytes disappeared`.
`model_pre_persistence_success_is_not_erased_by_restart` proves this independent
truth cannot be downgraded to Unknown. Do not claim the complete contract passes.
A durable native/source-output custody design is still required.

Lifecycle power-loss modeling covers marker/index/snapshot-file writes and
renames; package payload directory creation/rename, restoration directory topology
and cleanup are not fully modeled. The deep campaign stops at the real output-loss
counterexample, so required coverage counts have not all been verified. Idle proof
transport remains a model fixture; actual broker idle producer timing needs native
race probes. Consumer durable journal is fixture behavior, not an arbitrary-
consumer exactly-once proof. Linux native probes do not verify macOS/Windows GUI
runtime behavior.

Additional independently found attacks fixed in this review: diagnostic charge
1017 -> 317 after an unsynced truncate, with 1017 bytes resurrecting on power loss;
unreadable/nonregular stderr preventing delivery or cleanup; owner adoption or
acknowledgement arriving during null status replies; late capture reusing a settled
presentation-only ID; cancellation relabeling an already observed nonzero exit.
Two added proptest seeds are driver regressions (hard-link double count and released
preparation refusal classification), not additional production findings.

## Verification and fail-first evidence

All final Cargo commands use `CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops`.
Final results are recorded below after the last source audit. The final complete
lib reruns use `--test-threads=8`; the default-threading runs and isolated timing
reruns remain recorded separately.

Fail-first logs:
- `/tmp/hops-tenth-red-process.log`
- `/tmp/hops-tenth-red-spools.log`
- `/tmp/hops-tenth-red-orphan.log`
- `/tmp/hops-tenth-red-retention.log`
- `/tmp/hops-tenth-red-vitest.log`: reducer failed before epoch support
- `/tmp/hops-tenth-red-native-replay.log`
- `/tmp/hops-tenth-red-generation-replay.log`

Other logs:
- `/tmp/hops-tenth-results.log`, `/tmp/hops-tenth-lib-{1,2}.log`
- `/tmp/hops-tenth-model-deep.log`, `/tmp/hops-tenth-model-final.log`
- `/tmp/hops-tenth-native-verification.log` and per-test native logs
- `/tmp/hops-tenth-vitest.log`, `/tmp/hops-tenth-map.log`
- `/tmp/hops-tenth-process-{windows,macos}.log`
Native runners use private Xvfb/Openbox, isolated D-Bus/XDG profiles and no host
credentials, with app and fixture-provider DISPLAY/XDG verification. No physical
user desktop interaction or host clipboard writes.

## Next work

Preserve strict conservation and the failing deep counterexample. Design native
output streaming/durable source custody before marking a paid CLI success, and
clarify which crash boundary the provider can guarantee without acknowledging its
own durable output. Add real process-death/restart probes around that custody seam.
Finish lifecycle directory/payload power-loss instrumentation and native delayed
idle-proof/lifecycle races, then rerun deep until required transitions reach their
actual hit threshold. No approval, merge, issue close or commit has occurred.

## Final observed result lines

```text
Final full lib 1: test result: FAILED. 2277 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 55.99s
Final full lib 2: test result: FAILED. 2277 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 59.67s
Deep model: test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 2356 filtered out; finished in 5.23s
Native isolated recovery: 22 passed; 0 failed
Private native environments: 22/22 app and fixture provider verified
Vitest: Test Files 5 passed (5); Tests 67 passed (67)
Exact production process regressions: test result: ok. 9 passed; 0 failed; 0 ignored
Code-map coverage: 729/729; zero unresolved file references
```

Both final complete lib failures are the known
`creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged`.
Default-threading runs produced 2276/1 and 2275/3 passed/failed; the extra CLI
help-probe retry-count and PTY timing failures both passed immediately in isolation
(`/tmp/hops-tenth-cli-isolated.log`, `/tmp/hops-tenth-pty-isolated.log`). Those
runs remain in `/tmp/hops-tenth-lib-default-{1,2}.log`. Final complete lib logs
are `/tmp/hops-tenth-lib-final-{1,2}.log`. Deep failure is the separate, genuine
RAM-only paid-output-loss counterexample. No complete-contract acceptance.

Windows MSVC and macOS ARM64 exact process-module compile checks passed; native
runtime execution on those operating systems was not performed.
`git diff --check` passed. Independent adversarial review found no new regression
in the six production fixes and confirmed the remaining conservation defect and
lifecycle instrumentation limit.
