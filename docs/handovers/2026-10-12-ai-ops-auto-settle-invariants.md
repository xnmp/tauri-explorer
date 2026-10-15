# Automatic AI settlement: lifecycle invariants

Repository: `/var/tmp/te-wt2/hops`, branch `feat/ai-ops-auto-settle`.
All work is uncommitted, as requested. This checkpoint saves the completed
session directly before context expiry; no delayed handover work remains.

## Completed request

- Explicit disable/uninstall has no AI phase, claim, job or live-work veto.
  `lifecycle::remove_or_disable` durably journals the full index decision before
  effects. `finish_removal` is the common executor for immediate removal,
  restart and same-session retry: fence admission, durably retire generations,
  signal cancellation, retire native processes, publish index, transact custody
  and presentation cleanup, then remove the intent. Failed sweeps retain native
  admission closure; recovery atomically takes over that fence.
- `Store::abandon_package_operations` enumerates every ledger admission and
  unadmitted preparation rather than `claims()`. Explicit/incompatible removal
  releases all affected artifacts and quota and terminalizes nonterminal jobs;
  succeeded undelivered images produce at most one plugin-named notice. Original
  acquisition receipts and no-replay tombstones remain evidence.
- Compatible upgrades use `ai_operations::replacement_recovers`, the existing
  consumer/provider service negotiation, in every phase. Recovery uses original
  pinned custody/authority, resets old reconciliation budgets, and re-arms old
  presentation dismissal markers while preserving execution release. Self-owned
  provider operations require their exported contract, not a self-dependency.
  Incompatible replacements use the same removal transaction and disable required
  incompatible dependents through the committed upgrade journal.
- Acquired Released operations with stranded nonterminal jobs complete from the
  verified consumer copy (safe path, size, hash). A run ID is optional. Automatic
  settlement retains successful output and never replays Unknown.
- Settlement collects captured input files immediately after its commit using
  the same collector as store-open. The old regression's explicit `s.gc()` is
  removed.
- Durable generation checks cover creation of capture, reservation, forwarding
  and presentation rows. Admission revisions survive disable/re-enable, reject
  old UI dispatch, and atomically fence broker startup publication. Bootstrap
  does not hold the lifecycle write gate across journal recovery/native joins.

Deleted phase-specific delivery-repair busy exemptions, mutation claim gates,
candidate downgrade claim gates, and terminal/dead lifecycle settlement stacks.
Retained compatibility/migration paths concern legacy persisted evidence only.
Code maps, presentation conventions and the feature's lesson are updated.

## Evidence

Fail-first findings 1/2: `/tmp/hops-invariants-before.log`, both regressions fail.
Finding 3: `/tmp/hops-gc-before.log`, input file remains without explicit GC.

The property matrices cover 352 A cases and 352 B cases: both service roles,
11 operation phases, every one of the 8 presentation states, disable/uninstall
or compatible/incompatible upgrade. Additional contracts cover crash boundaries,
late workers, repeated disable, cancellation queue saturation/restart, self-owned
contracts, and acquired completion with/without a run.

Affected frontend command:

```sh
bunx vitest run tests/api/mock-ai-presentation.test.ts tests/components/ai-auto-settlement.test.ts tests/domain/ai-operations.test.ts tests/state/native-plugin-jobs.test.ts
```

`/tmp/hops-vitest-final.log`: `Test Files 4 passed (4)`, `Tests 71 passed (71)`.

Full Rust command, twice on final source, default parallelism:

```sh
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --offline --manifest-path src-tauri/Cargo.toml --lib
```

```text
test result: FAILED. 2167 passed; 1 failed; 66 ignored; 0 measured; 0 filtered out; finished in 22.23s
test result: FAILED. 2167 passed; 1 failed; 66 ignored; 0 measured; 0 filtered out; finished in 23.06s
```

Logs: `/tmp/hops-rust-final-2.log`, `/tmp/hops-rust-final-3.log`.
Both failures are the user-listed unrelated
`file_mutation::tests::recovery_admission::creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged`
at `src-tauri/test_support/file_mutation.rs:475` (`completed.warning.is_none()`).
No search issue-651 failures. The recovery test clock now starts after action-lane
ownership, so parallel matrix work is not simulated provider latency; threads
were not reduced.

Independent read-only adversarial reviewer found no remaining blockers and
confirmed A/B, successful-output retention, acquired completion and Unknown
no-replay within lifecycle/domain and modeled interleavings. Independent final
`invariant_` filter: 13 passed; lifecycle revision filter: 2 passed; fence
takeover: 1 passed; collector regression: 1 passed, default parallelism.
Native-display fixtures remain ignored/unexecuted; no active desktop interaction.
Code-map coverage: 722/722; `git diff --check` clean.

## Remaining work

No requested implementation or verification remains. Do not commit unless the
user changes their instruction. If native GUI qualification is requested later,
use a private display, isolated D-Bus/XDG profile and the existing native harness.
