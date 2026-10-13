# AI operations: five follow-up findings fixed

Repository `/var/tmp/te-wt2/hops`, branch `feat/ai-ops-auto-settle`.
All changes remain uncommitted. This handover was written immediately after
verification; no delayed handover work is required. It supersedes the earlier
native-fixture limitation in `2026-10-12-ai-ops-auto-settle-invariants.md`.

## Fixes

1. Receipt-only settlement missed sealed output when success publication never
   reached the host. Retained artifact custody now prevents settlement, overrides
   old matching dismissal markers during discovery, and keeps status probes alive
   beyond the uncertainty budget. Nonempty original stages receive the same
   protection. Healthy status completes delivery without restart or replay.
2. Output reservation trusted pre-transaction admission validation. It now checks
   current admission, provider authority and artifact status atomically with quota
   reservation. The paused seal rejects removal before it publishes any bytes.
3. Removal zeroed quota before files were deleted. Artifact rows now act as durable
   pending-collection records: deletion owns quota retirement. Lease drop retries
   after unlocking; the existing two-second automatic worker retries even without
   recovery candidates. GC enumerates collectable artifacts directly, avoiding
   per-tombstone work across unbounded forensic operation history. The accounting
   rule applies to input settlement and all removal paths.
4. Job pruning rejected row 385 before evicting terminal history. It now evicts
   excess history before enforcing capacity. The exact 128-active/256-terminal
   regression checks one synthetic notice, committed release, deleted output,
   retained bounds and idempotence across reopening.
5. Native upgrade tests mixed an incompatible removal with later compatible
   recovery, asserting the superseded contract. Separate incompatible provider/
   consumer fixtures prove A, and direct compatible upgrades prove completed
   delivery, acquired disposition, matching file hash and no extra start. A new
   compatible-provider fixture upgrades sealed/unpublished Running output after
   six failed status probes and completes its original delivery.

## Fail-first evidence

`/tmp/hops-five-before.log`: 5 new regressions failed on the old production logic.
`/tmp/hops-reservation-guard-reverted.log`: the strengthened paused-seal test failed
when only its atomic transaction guard was reverted; cleanup stayed enabled.
The guard was restored immediately.
`/tmp/hops-native-before.log`: original consumer native test failed at the stale
Terminal expectation because the incompatible upgrade had correctly released it.

Independent read-only adversarial review: all five fixes CONFIRMED at source and
regression-contract level; no remaining blocker. The reviewer also identified the
historical-operation GC scan, which was replaced with artifact-driven collection.

## Final verification

The required command ran twice with default parallelism:

```sh
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --offline --manifest-path src-tauri/Cargo.toml --lib
```

```text
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 0.00s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 0.00s
```

Both failures are the user-listed unrelated
`file_mutation::tests::recovery_admission::creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged`
at `src-tauri/test_support/file_mutation.rs:475`, `completed.warning.is_none()`.
Logs: `/tmp/hops-five-rust-final-1.log`, `/tmp/hops-five-rust-final-2.log`.

```sh
bunx vitest run tests/api/mock-ai-presentation.test.ts tests/components/ai-auto-settlement.test.ts tests/domain/ai-operations.test.ts tests/state/native-plugin-jobs.test.ts
```

```text
Test Files  4 passed (4)
Tests  71 passed (71)
```

Log: `/tmp/hops-five-vitest.log`. `git diff --check` passes. Code-map coverage
validation passes: 722/722 source files. No new source files were added.

## Native execution

These are Linux-only `#[ignore]` library tests, enabled by normal dev-dependency
Tauri test support; no extra Cargo feature is required. Each needs a fresh process
and private profile because host initialization is process-global.
The fixture requires `TE_SERVICE_NATIVE_FIXTURE=1`, no provider credentials,
private XDG roots under a `te-service-native.*` directory, and an isolated display.
Xvfb, Openbox, D-Bus and Python were available here. All ten tests ran in separate
private Xvfb/D-Bus/XDG fixtures. App and helper process environments were checked
for the private DISPLAY, X11 backend, absent WAYLAND_DISPLAY and matching profile.
No user desktop interaction or clipboard access occurred.

Runnable wrapper: `/tmp/hops-run-native.sh`; display verification:
`/tmp/hops-check-native-display.py`. For example:

```sh
sh /tmp/hops-run-native.sh \
  installed_plugins::service_bridge::native_tests::native_review_compatible_provider_upgrade_delivers_sealed_unpublished_output \
  /tmp/hops-compatible-provider.log
```

The wrapper creates private roots, unsets provider secrets and WAYLAND_DISPLAY,
forces GDK_BACKEND=x11, then runs Openbox and the following command inside
`xvfb-run -a dbus-run-session`:

```sh
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --offline --manifest-path src-tauri/Cargo.toml --lib \
  installed_plugins::service_bridge::native_tests::native_review_compatible_provider_upgrade_delivers_sealed_unpublished_output \
  -- --ignored --exact --test-threads=1
```

Final native result lines, one isolated process per test:

```text
native_review_compatible_upgrade_delivers_original_success_through_real_reverse_rpc
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 0.41s
native_review_incompatible_consumer_upgrade_releases_original_success_once
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 0.27s
native_review_incompatible_provider_upgrade_releases_original_success_once
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 0.19s
native_review_broken_provider_upgrade_recovers_original_success
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 0.55s
native_review_failed_late_publication_survives_provider_upgrade_without_replay
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 0.55s
native_review_live_failed_delivery_does_not_pin_consumer_job_ownership
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 0.55s
native_review_legacy_stopped_job_delivers_authoritative_success
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 0.34s
native_review_storage_full_survives_recovery_budget_and_delivers_after_release
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 1.63s
native_review_sealed_unpublished_output_recovers_after_status_outage_without_restart
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 0.43s
native_review_compatible_provider_upgrade_delivers_sealed_unpublished_output
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2243 filtered out; finished in 0.52s
```

Logs: `/tmp/hops-final-<native-test-name>.log`; harness environment proof:
`/tmp/hops-native-final-harness.log`. Cleanup checks private profile processes only.

## Remaining

No requested implementation or verification remains. Do not commit unless the
user changes the instruction. The known unrelated file-mutation test is unchanged.
