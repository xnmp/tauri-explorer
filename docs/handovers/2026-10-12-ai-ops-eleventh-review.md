# Eleventh AI-operation review

Branch `feat/ai-ops-auto-settle`, HEAD `7f54a10a`. No commit or merge.
The tenth-handover modification present on entry is preserved.

## Changes and expectation updates

All capture paths use `Store::durable_host_completion`: stdout/stderr files,
spool directory and parent are synced before completion identity is published.
Conflicting repeats are refused before modifying identified bytes. Both process
executors stream bounded stdout through their shared reader; completion avoids
truncating an exact streamed file. The bounded Output API still retains RAM
copies, and unfsynced chunks have no power-loss guarantee.

Conservation/delivery becomes mandatory after actual identity publication and
stays mandatory through restart. RAM/unflushed witnesses cannot satisfy it.
No action types added. `model_pre_persistence_success_is_not_erased_by_restart`
retains paid invocation truth but now requires Unknown, terminal non-Completed
history, no delivery/replay, and zero charges for Restart and SpoolCrash(0, 2).
The former stderr-crash test now checks interruption at stdout-sync (5), partial
stderr (7), and durable capture without identity (10), versus exact delivery
after identity (11). Partial stdout has no pending manifest. Failed direct-seal
directory barriers now produce no identity and permit eventual collection;
metadata-fault tests inject failure after durable capture so their recovery
expectations remain meaningful.

Later exploration found driver assumptions: callbacks now use production
`recovery_caller` after presentation validation; capture tombstone refusals reach
production before classification; automatic cancellation is allowed only for
preparations proved released before lifecycle. Four shrunk traces regress these
cases. Active preparations retain their retention assertion. No production
input-capture/lifecycle behavior changed; four generated seeds are retained.

## Observed verification

Ordering regression failed first at checkpoint 1, then passed all 17 boundaries.
Independent review confirmed ordering, immutable repeats and oracle conservation.
Exact production-module streaming probes: 6 passed across both executors
(success, prefix before exit, bounded overflow). No GUI interaction.

```text
Deep: test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 2360 filtered out; finished in 67.65s
Full lib: test result: FAILED. 2281 passed; 1 failed; 79 ignored; 0 measured; 0 filtered out; finished in 58.12s
Vitest: Test Files 280 passed (280); Tests 2889 passed (2889)
Code-map coverage: 729/729; zero unresolved references
```

Lib failure is solely the known `file_mutation::…creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged`.
All completion-contract regressions passed. Requested Cargo runs use
`CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops`; full lib uses 8 test threads.
Vitest command: `bunx vitest run tests/domain tests/state --maxWorkers=2`.
Logs: `/tmp/hops-eleventh-{red-ordering,ordering,model-deep,lib-final,vitest,stream-review,map}.log`.
`git diff --check` passed.

## Remaining counterexample and documented limits

Deep fails on `[Register(1), LifecycleCrash(true, 0), Admit(1, true), Upgrade(false, true, false)]`
→ `compatible replacement discarded accepting preparation`. Independent audit:
provider removal leaves an old consumer presentation; restart/capture creates
input custody under a newer incarnation, and the compatible-upgrade retention
join requires exact preparation/job ownership. This never captures output,
persists completion identity, or starts paid work. Production applicability is
plausible, not proven. Do not claim full model acceptance; required transition
hit counts remain unverified while this separate lifecycle trace stops the run.

Lifecycle power-loss modeling covers marker/index/snapshot-file writes/renames;
payload creation/rename, restoration directory topology and cleanup remain
incomplete. Idle transport and consumer durable journal remain model fixtures.
Streaming cannot preserve RAM/pipe/unsynced bytes. No native GUI or macOS/Windows
runtime checks. The original completion-identity-before-bytes defect is fixed.
