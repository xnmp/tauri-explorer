# TraceExplorer #32: image timing cohorts

The host reserves native jobs before the consumer knows its prepared image recipe. Cohort metadata therefore arrives in the consumer's first `jobs.status` receipt, is committed with that receipt's revision, and stays pinned in the durable job. Backend initialization advertises the additive `jobService.estimateKey` boolean. Legacy jobs and older consumers omit it; source history remains their fallback. No frontend SDK shape changes are needed.

Training uses `settledAtMs`, never mutable `updatedAtMs`. The pure estimator takes the median of the latest 20 successful, valid completions by completion time, requiring three samples at each level: matching source/key, then source, then 120s. Running native jobs now show the estimate too. Overdue jobs say “Estimate · longer than usual”; the estimated bar remains below completion.

## Local measurement, 2026-10-11

Copied the host `service-state/ledger.sqlite` and its WAL, the image provider `operations.sqlite` and its WAL, and Trace's `trace.sqlite` and its WAL to `/tmp/image-estimates-32/` before opening copies read-only. The host's `presentation_jobs` table has **zero rows**, so an exact host `settledAtMs` replay is unavailable. Provider history contains five operations: four successes and one unknown outcome. All five use Codex, no explicit model, 2048×1360 / 2k, and one input; no cross-provider, model, size, or generation/edit comparison is supported by this sample.

The three timed successes have provider admission-to-delivery durations of **112.854s, 37.582s, 38.470s**. Process execution takes **81.107s, 36.551s, 37.521s** respectively; credential checks take **30.199s, 0.113s, 0.195s**. The first success has no stage timings. The unknown operation's 105.324s partial timing is excluded from training and scoring. The cold 120s estimate exceeds the two fast provider runs by **82.418s and 81.530s**. The slow successful runs would also bias a shared pool toward roughly 112s. These are real end-to-end costs, not malformed outliers to discard.

For a bounded surrogate replay, join Trace runs to provider receipts, require success on both sides, use Trace's `created_at` → `finished_at`, and reconstruct cohorts from the prepared recipes. Invoke the original captured `imageJobProgress` and the new function against only earlier completed jobs. Four successful runs have timestamps, including the success without stage instrumentation:

| Run | Actual (s) | Before estimate (s) | After estimate (s) | Before absolute error (s) | After absolute error (s) |
|---|---:|---:|---:|---:|---:|
| 1 | 111.904 | 120.000 | 120.000 | 8.096 | 8.096 |
| 2 | 112.880 | 111.904 | 120.000 | 0.976 | 7.120 |
| 3 | 37.578 | 112.392 | 120.000 | 74.814 | 82.422 |
| 4 | 38.462 | 111.904 | 111.904 | 73.442 | 73.442 |

Median absolute error: **40.769s → 40.769s**. Mean absolute error: **39.332s → 42.770s**. The three-sample minimum delays warm-up; one homogeneous cohort gives partitioning no opportunity to improve this small replay. Do not claim empirical accuracy improvement from this history. Cohort-specific behavior and fallbacks are verified with deterministic tests; a heterogeneous retained host history is still needed to measure their benefit. The local replay and original module snapshot are in `/tmp/image-estimates-32/replay.ts` and `image-job-progress-before.ts`.

## Verification

All test/check commands unset `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and `BFL_API_KEY`. Rust commands use the assigned `target-h32` or `target-i32`; commands below run in the corresponding worktree. Logs are in `/tmp/image-estimates-32/`.

| Worktree | Command | Actual result lines |
|---|---|---|
| Host, before fix | `bunx vitest run tests/domain/image-job-progress.test.ts` | `Test Files 1 failed (1)`; `Tests 3 failed \| 12 passed (15)` — expected regression failures |
| Host | `bunx vitest run tests/domain/image-job-progress.test.ts` | `Test Files 1 passed (1)`; `Tests 15 passed (15)` |
| Host | `bunx vitest run tests/domain tests/state/native-plugin-jobs.test.ts tests/components/job-elapsed-frozen.test.ts` | `Test Files 103 passed (103)`; `Tests 1417 passed (1417)` |
| Host, final touched files | `bunx vitest run tests/domain/image-job-progress.test.ts tests/components/job-elapsed-frozen.test.ts tests/state/native-plugin-jobs.test.ts` | `Test Files 3 passed (3)`; `Tests 40 passed (40)` |
| Host | `bun run check` | `COMPLETED 1802 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS`; only the acknowledged `website/api/report.js` missing `@vercel/blob` |
| Host | `cargo test --locked --manifest-path src-tauri/Cargo.toml service_state::job_store` | `test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 2147 filtered out` |
| Host | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib installed_plugins::job_bridge` | `test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 2161 filtered out` |
| Host | `python3 docs/code-map/validate.py --coverage` | `coverage: 725/725 source files in map-folder.md`; all three maps have `0 unresolvable` |
| Trace | `bun run check` | `COMPLETED 162 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` |
| Trace, final full suite | `bun run test --maxWorkers=1` | `Test Files 30 passed (30)`; `Tests 427 passed \| 1 skipped (428)` |
| Trace | `cargo test --locked --manifest-path src-tauri/Cargo.toml image_estimate` | `test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 239 filtered out` |
| Trace | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib trace::service_images` | `test result: ok. 78 passed; 0 failed; 0 ignored; 0 measured; 164 filtered out` |
| Trace, non-socket suite | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -- --skip openai_image::tests::http_ --test-threads=1` | `test result: ok. 238 passed; 0 failed; 2 ignored; 0 measured; 2 filtered out` |
| Trace, non-socket protocol | `cargo test --locked --manifest-path src-tauri/Cargo.toml --test backend_protocol -- --skip shared_ai_end_to_end_preserves_ordered_inputs_durable_recipe_and_large_output_by_artifact` | `test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out` |
| Host, browser discovery only | `bunx playwright test -c playwright.issue32.config.ts --list e2e/image-generation-progress.spec.ts` | `Total: 10 tests in 1 file`; temporary config used port 15432 and was removed |
| Replay | `bun /tmp/image-estimates-32/replay.ts` | `before: n=4; median absolute error=40.769 s; mean absolute error=39.332 s`; `after: n=4; median absolute error=40.769 s; mean absolute error=42.770 s` |

Earlier runs and recoveries:

- The first host check caught a Svelte narrowing error after the running branch was moved. A selective formatter also reordered module declarations incorrectly, causing Rust `E0428` / `E0433`. Both implementation errors were fixed before the final checks above.
- Trace's initial `bun run test` returned `Test Files 2 failed | 28 passed (30)` and `Tests 6 failed | 421 passed | 1 skipped (428)`: graph performance budgets and a layout-client timeout while compiling Rust. The two files passed in isolation (`Test Files 2 passed (2)`; `Tests 25 passed (25)`). A subsequent single-worker full run still exceeded three graph timing budgets (`Tests 3 failed | 424 passed | 1 skipped (428)`); the final full run passed after the build load eased.
- Trace's unfiltered `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` returned `test result: FAILED. 237 passed; 3 failed; 2 ignored`. Two HTTP tests failed to bind sockets with `PermissionDenied` / `Operation not permitted`; one concurrent IO fixture timed out (`IO fixture did not enter`). The serial non-socket suite passed all 238 runnable tests, including that fixture.
- Unfiltered `cargo test --locked --manifest-path src-tauri/Cargo.toml --test backend_protocol` returned `test result: FAILED. 11 passed; 1 failed`. Its HTTP scenario failed with Python `PermissionError: [Errno 1] Operation not permitted` while creating a socket. All 11 remaining protocol tests passed separately.

An independent adversarial review found no remaining actionable findings after fixing cancellation acknowledgement and preserving registration idempotence. Rustfmt was restricted to changed Rust files/hunks. Both worktrees pass `git diff --check`. No commits, pushes, or `gh` calls were made.

Still unverified: actual browser/native UI execution and screenshots, the three socket-dependent tests, and accuracy on a heterogeneous retained host history. The browser regression checks matching-cohort remaining time, overdue wording, cancellation acknowledgement, and explicit completion with frozen elapsed time. Trace's `e2e/harness/view-fixture.ts` has no native job-status/estimate surface to mirror; its job-start, folder and selection rules are unchanged. The native receipt extension leaves `integration/plugin-sdk/index.d.ts` and the host's frontend SDK shape unchanged.
