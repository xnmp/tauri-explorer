# AI operation model review: final test results

All changes remain uncommitted. Both Rust suites used exactly:

```sh
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --offline --manifest-path src-tauri/Cargo.toml --lib
```

## Rust run 1 (default parallelism)

```text
test result: FAILED. 2206 passed; 1 failed; 77 ignored; 0 measured; 0 filtered out; finished in 41.40s
```

Raw log: `/tmp/hops-rust-final-1.log`.

## Rust run 2 (default parallelism)

```text
test result: FAILED. 2206 passed; 1 failed; 77 ignored; 0 measured; 0 filtered out; finished in 43.49s
```

Raw log: `/tmp/hops-rust-final-2.log`.

## Normal model module

```text
test result: ok. 7 passed; 0 failed; 1 ignored; 0 measured; 2275 filtered out; finished in 8.53s
```

Raw log: `/tmp/ai-model-final-all.log`.

## Ignored deep model

```text
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2282 filtered out; finished in 267.73s
```

Raw log: `/tmp/ai-model-deep-final.log`.

Both broad runs failed only at the known unrelated
`file_mutation::tests::recovery_admission::creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged`
assertion in `src-tauri/test_support/file_mutation.rs:475`.

## Affected Vitest

```sh
bunx vitest run tests/api/mock-ai-presentation.test.ts tests/components/ai-auto-settlement.test.ts tests/domain/ai-operations.test.ts tests/state/native-plugin-jobs.test.ts tests/state/plugin-jobs.test.ts tests/state/jobs.test.ts tests/state/jobs-retry.test.ts tests/domain/image-job-progress.test.ts
```

```text
 Test Files  8 passed (8)
      Tests  118 passed (118)
   Duration  7.82s (transform 87%, import 9%, tests 2%, setup 1%)
```

## Linux native ignored recovery

Every case below ran in its own private Xvfb/Openbox/D-Bus/XDG profile.
GDK used x11, Wayland was unset, and the actual app/helper DISPLAY was verified.
Private-display evidence: `/tmp/hops-model-native-final-harness.log`.

```text
native_review_startup_settlement_queries_retained_paid_output_before_recovery
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.17s
native_review_reopened_unknown_recovers_provider_raw_image_without_replay
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.20s
native_review_success_evidence_failure_keeps_querying_provider_for_repair
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.30s
native_review_compatible_provider_upgrade_recovers_host_spool_after_quiesce_refusal
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.42s
native_review_compatible_consumer_upgrade_recovers_host_spool
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.38s
native_review_compatible_provider_upgrade_recovers_bound_host_success_after_lost_reply
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.41s
native_review_compatible_consumer_upgrade_recovers_bound_host_success_after_lost_reply
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.38s
native_review_unbound_host_success_delivers_after_exhausted_status_outage_without_restart
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.48s
native_review_compatible_upgrade_delivers_original_success_through_real_reverse_rpc
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.40s
native_review_incompatible_consumer_upgrade_releases_original_success_once
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.24s
native_review_incompatible_provider_upgrade_releases_original_success_once
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.16s
native_review_sealed_unpublished_output_recovers_after_status_outage_without_restart
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.47s
native_review_compatible_provider_upgrade_delivers_sealed_unpublished_output
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.62s
native_review_live_failed_delivery_does_not_pin_consumer_job_ownership
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.39s
native_review_legacy_stopped_job_delivers_authoritative_success
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.27s
native_review_broken_provider_upgrade_recovers_original_success
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.36s
native_review_failed_late_publication_survives_provider_upgrade_without_replay
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.55s
native_review_storage_full_survives_recovery_budget_and_delivers_after_release
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.84s
native_review_uncertain_settlement_bounds_real_status_failures_and_timeouts
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 1.12s
native_service_admission_before_disable_cannot_start_after_reenable
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2283 filtered out; finished in 0.15s
Native isolated recovery: 20 passed; 0 failed
```

## Real subprocess boundaries

```text
/tmp/hops-detached-output-ext-green.log
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 2278 filtered out; finished in 0.12s
/tmp/hops-detached-output-process-run-green.log
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 2277 filtered out; finished in 0.31s
/tmp/hops-detached-output-final.log
29 process-supervisor outcome fixtures passed
```

The standalone fixture imports the exact production supervisor and fallback modules.
It verifies complete and partial raw captures, completed exit versus cancellation,
both or either pipe held by a detached descendant, overflow and owned-tree cleanup.

`git diff --check` passed. Code-map validation passed with 0 unresolvable references
and 722/722 tracked source files covered; all three new Rust source files are mapped.
