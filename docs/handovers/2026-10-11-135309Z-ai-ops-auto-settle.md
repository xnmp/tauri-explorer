# AI operations automatic settlement handover

Saved 2026-10-11 13:53 UTC after implementation, regression verification, and independent review. All changes are **uncommitted**. The user explicitly forbids committing, pushing, and `gh`; those instructions override the handover skill's checkpoint and issue-update steps. No issue/PR number was provided or queried. This document preserves the completed work under the standing repository handover preference.

## Goal and constraints

Fix the host's automatic AI settlement at its durable/native boundaries:

1. Delayed success must restore recovery ownership atomically and never make the store unopenable.
2. Cached missing/corrupt output must be refreshed and original bytes/seal recovered before irreversible discard.
3. Proven-idle settled operations must release unused artifact reservations while retaining actual recoverable bytes, receipts, and admission evidence.
4. Hold provider/consumer idle proof until commit, including lifecycle/startup admission.
5. Protect `host.services.test.begin` while its provider worker registers, including timeout and provider death races.

Hard rules: never replay Unknown, never settle/discard active work, never discard recoverable output, and release settled capacity. No UI/SDK/harness shapes changed; this work fixes native ledger, artifact recovery, and admission boundaries.

## Repository and checkpoint

- Worktree: `/var/tmp/te-wt2/hops`, host tauri-explorer. No `/home/chong/Repos/*` checkout was touched.
- Branch: `feat/ai-ops-auto-settle`.
- HEAD remains `0c741fa2140bbeccbe9c6ec6613ae40bd2e8ab0c` (the original automatic-settlement commit).
- Starting dev/base: `0c7bd95fc14172a03b264f494df7734f48ae7bfe`.
- During the task, another actor advanced `origin/dev` to `5b60861d93b3f9c6984b8d3c78b09f05b4fc31f5`. Final status is ahead 1 / behind 2. The two new commits concern shared modal UI (`7d204c36`, `5b60861d`); they change none of `src-tauri`, `website/api/report.js`, or `package.json`.
- No rebase/stash/index modification was performed after that external advancement. The lead owns final Git operations.
- Baseline verification used a read-only source archive at `/tmp/hops-origin-dev`, created from the starting dev SHA. It did not create a Git worktree or modify a host checkout.

## Implementation

### Settlement and receipt ownership

`src-tauri/src/installed_plugins/ai_operations.rs`:

- `auto_reconcile_in` rereads admission and receipt after acquiring live proof and refreshing the authoritative provider status.
- `AutomaticPort::with_activity` keeps the live fence and both provider/consumer call leases through the disposition commit.
- A missing authoritative status fails closed. Succeeded/unavailable first attempts original local output recovery; a typed loss then requires another fresh provider status before discard. Transient IO or artifact ownership failures defer settlement.
- Actual recovery runs after the lifecycle fence drops, while the operation action guard remains held. This prevents recovery's own activation from being rejected by its fence.

`src-tauri/src/service_state/receipts.rs`:

- `observe_receipt` publishes with a SQLite IMMEDIATE transaction. Valid newer non-Unknown receipts revoke stale execution release/dismissal; late available success pins its original descriptor in the same transaction and restores recovery ownership. Unknown retains the no-replay fence.
- `auto_settle_operation` retains artifact IO ownership through release flags, job transition, and byte accounting commit.
- Store startup conservatively repairs legacy late-success execution flags instead of rejecting the whole store. It also normalizes legacy empty/partial settled reservations. Malformed flag values still fail validation.

The atomic write approach follows the single-writer transaction boundary described in [SQLite's transaction documentation](https://www.sqlite.org/lang_transaction.html).

### Original output recovery and capacity

`src-tauri/src/service_state/artifacts.rs`:

- `idle_output_reservation` measures real stage/bin/pending bytes while holding the artifact IO lease through settlement. Empty settled reservations become zero; retained bytes remain charged. Identity and receipt evidence remain durable.
- `recover_original_output` retries the original seal and pins a recovered descriptor. Only typed missing/corrupt is a confirmed local loss; IO/lease/path/sync failures are retryable.
- Sealed descriptor restoration requires the original exact SHA and length, including retained stage/pending copies.
- Unsealed recovery examines all original publication locations (bin, pending, stage), preserving valid original publication precedence rather than a differing later stage.
- Shared original publication preserves a validated original until durable publication completes. Pending data is flushed **before** path mutations. Pending-only publication hard-links rather than truncating the only copy; malformed bin recovery uses the validated retained original.
- `Store::seal` uses that recovery path. Test-only per-store sync fault injection proves failed publication leaves the original available for retry.

`src-tauri/src/service_state/receipt.rs` separates cached loss from confirmed loss after a recovery attempt. `src-tauri/src/service_state/store.rs` prevents a settled Reserved operation from acquiring forwarding ownership.

### Idle proof and connection-test registration

`src-tauri/src/installed_plugins/backend.rs` adds `IdleCallFence`: it excludes active normal/startup calls and lifecycle changes, blocks new starts/drains while held, and allows receipt/control callbacks. Both provider and consumer leases are retained until settlement commits.

`src-tauri/src/installed_plugins/service_bridge.rs`:

- A retained test-start map stores exact provider generation plus `StartDispatch`; dispatch ownership survives a lost/timed-out settings.test response.
- `begin_test_in` is the actual durable admission seam. It holds the common admission lock, verifies owner liveness, persists reservation/forwarding, and retains dispatch before returning acceptance.
- Only a valid explicit registration/update or exact provider death releases that dispatch. A status query does not imply registration completed.
- `on_dead` takes the same admission lock before test-start cleanup, preventing death from slipping between validation and registration.

Architecture documentation updated in `docs/shared-ai-presentation-conventions.md` and the AI cluster of `docs/code-map/map-feature.md`. No source files were added, so map-folder coverage remains complete.

## Reproduction evidence before fixes

New regressions use the real Store and durable host admission seams in `src-tauri/src/installed_plugins/service_bridge_tests.rs`; assertions check restart opening, output descriptors/bytes, no paid restart/discard, capacity acceptance, and active work ownership.

- `/tmp/hops-repro.log`: initial three-P1 run: `test result: FAILED. 16 passed; 3 failed`. Delayed success reproduced `invalid retained execution claim`; capacity reproduced `artifact capacity reached`.
- The initial missing-output fixture hit a permissions precondition too early. After correcting it to use the provider's original read before pinning, `/tmp/hops-missing-repro.log` cleanly failed with `recoverable original output was discarded`: `test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 2183 filtered out; finished in 0.20s`.
- Registration and idle-fence regressions failed before their respective fixes (`/tmp/hops-repro-all.log`, `/tmp/hops-repro-final.log`). One early assertion inside an action callback poisoned the global action mutex; later failures from that poison are not counted as independent evidence. Current tests assert after the callback and isolated reproductions were clean.
- `/tmp/hops-stage-repro.log`: exact sealed-stage recovery returned `None` instead of the descriptor before recovery repair.
- `/tmp/hops-unsealed-repro.log`: original unsealed bin/pending publication was unrecoverable before multi-source recovery repair.
- `/tmp/hops-pending-sync-repro.log`: fault injection failed with `pending data must be flushed before publishing its descriptor` before adding the data-sync boundary: `test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 2189 filtered out; finished in 0.04s`.

All 22 `automatic_` native tests pass on the final changes. Important new tests begin at lines 1660, 1775, 1883, 1938, 2004, 2146, 2184, 2230, and 2285 of `service_bridge_tests.rs` (line numbers may move after integration).

## Final verification and exact commands

All commands ran in the host worktree with provider credentials unset. Cargo used the user-specified target; sandbox escalation was needed because that target directory is outside writable roots. No automatic approval rejection occurred.

```sh
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GEMINI_API_KEY -u BFL_API_KEY bun run check
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GEMINI_API_KEY -u BFL_API_KEY VITEST_MAX_WORKERS=1 bun run test
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GEMINI_API_KEY -u BFL_API_KEY CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --lib
```

Final actual results:

| Command | Actual output and outcome | Log |
| --- | --- | --- |
| `bun run check` | `COMPLETED 1796 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS`; exit 1 | `/tmp/hops-check-final.log` |
| `bun run test` with one worker | `Test Files  2 failed \| 383 passed (385)`; `Tests  4 failed \| 3628 passed \| 3 skipped (3635)`; `Errors  4 errors`; exit 1 | `/tmp/hops-vitest-final.log` |
| Cargo full lib | `test result: FAILED. 2133 passed; 1 failed; 56 ignored; 0 measured; 0 filtered out; finished in 38.15s`; exit 101 | `/tmp/hops-cargo-final4.log` |

Pre-existing non-socket failures:

- Check and `tests/website/report-relay.test.ts`: `Cannot find module '@vercel/blob' or its corresponding type declarations.` Baseline `bun run check` also failed: `COMPLETED 1803 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS` (`/tmp/hops-dev-check.log`). The baseline report-relay import failure was verified too. No dependency/package changes attempted.
- Cargo's sole failure is `file_mutation::tests::recovery_admission::creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged`, assertion `completed.warning.is_none()` in `test_support/file_mutation.rs:475`. The exact filtered baseline command against the dev archive reproduced the same assertion: `test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 2165 filtered out; finished in 0.20s` (`/tmp/hops-dev-cargo-known.log`).

Sandbox socket failures:

- Four `tests/native-driver-ports.test.ts` cases cannot listen: `Error: listen EPERM: operation not permitted 127.0.0.1`. These are the four failed Bun tests plus four unhandled errors. No feature assertion failed in the final Bun run.
- The final escalated Cargo run had no socket/D-Bus failures. Its 56 ignored opt-in tests were not enabled.

Additional validation:

```sh
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GEMINI_API_KEY -u BFL_API_KEY bunx --no-install vitest run -c vitest.perf.config.ts --maxWorkers=1
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GEMINI_API_KEY -u BFL_API_KEY CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --lib automatic_
python3 docs/code-map/validate.py --coverage
git diff --check
```

- Separate perf config: `Test Files  3 passed (3)`, `Tests  29 passed (29)` (`/tmp/hops-vitest-perf.log`). This ran separately because the unit failures prevent the package script's `&&` perf stage.
- Focused graph/AI Vitest: 4 files / 79 tests passed (`/tmp/hops-vitest-focused.log`).
- Focused Cargo before the final sync regression: `test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 2168 filtered out; finished in 2.48s` (`/tmp/hops-cargo-focused-final.log`). Final independent verifier rerun includes the new test: `test result: ok. 22 passed; 0 failed; 0 ignored; 0 measured; 2168 filtered out; finished in 30.22s`.
- Code-map validator: feature 769 refs / 0 unresolvable, folder 860 refs / 0 unresolvable, playbook 145 refs / 0 unresolvable; `coverage: 720/720 source files in map-folder.md`.
- Only changed Rust files were formatted. `git diff --check` exit 0.

Earlier default-worker Bun run suffered load timeouts (16 failed files / 369 passed, 30 failed tests / 3602 passed / 3 skipped). Isolated reruns and the final full one-worker run resolved those. `tests/native-suite-typecheck.test.ts` passed in the final run. Earlier full Cargo iterations also failed only the same unrelated baseline assertion; final4 above covers the final implementation and all regression additions.

## Independent adversarial review

Read-only reviewer `/root/adversarial_review` tried to falsify restart safety, cached loss recovery, capacity, activity fences, and connection-test admission. Its feedback found additional original-publication edge cases (sealed stage, unsealed bin/pending, pending data flush), each reproduced before fixing.

Final verdict: **all required claims CONFIRMED within the reviewed native boundaries; no remaining concrete defect found**. The reviewer independently ran all 22 automatic tests and diff checks on the final changes. It made no source edits.

Limits: no real provider GUI/live IPC end-to-end session or physical power-loss probe was run. Actual sync failure and retry are covered by fault injection; concurrency is covered by deterministic admission/barrier tests. The 56 opt-in native tests remain ignored. No new UI behavior was introduced by these repairs, so no browser screenshot/GUI session was launched. The user prohibits port 1420 and the sandbox blocks sockets.

## Ownership, jobs, and next actions

- All touched source and documentation remain in the current worktree; nothing is staged. No new issue, commit, push, or GitHub comment.
- No owned dev server, native GUI, test driver, background test process, or worktree agent remains running. No active-desktop input or clipboard use occurred.
- `/tmp/hops-origin-dev` is a temporary source archive, not a Git worktree. Logs under `/tmp/hops-*.log` are local durable evidence for this session; preserve/export if needed.
- Required environment: Bun, offline Cargo dependencies, `CARGO_TARGET_DIR=/var/tmp/te-wt2/target-hops`; unset `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `BFL_API_KEY`. Never use port 1420. Cargo target writes need sandbox permission here.

The lead's first action is to review the uncommitted diff and integrate/rebase onto the now-current dev tip using their authorized Git workflow:

```sh
git status --short --branch
git diff --stat
git diff -- src-tauri/src/installed_plugins/ai_operations.rs src-tauri/src/installed_plugins/backend.rs src-tauri/src/installed_plugins/service_bridge.rs src-tauri/src/service_state
```

Then commit per the lead's conventions and run socket-enabled checks if desired. Do not treat the known Blob dependency and file-mutation baseline assertion as regressions from this patch. Reverify branch merge-base before integration; do not assume the origin/dev tip stayed fixed after this handover.
