# Architecture overhaul — remaining work

Written 2026-09-26 after v1.10.0. Tracking issue: #770.

v1.10.0 shipped every follow-up from the 2026-09-25 handover
([`docs/handoffs/architecture-review-2026-09-25.md`](../handoffs/architecture-review-2026-09-25.md)).
It did not close the overhaul. The acceptance table in
[`docs/review-completion.md`](../review-completion.md) still has open rows, and
the remaining rows still share a platform boundary:

- recovery, admission and native behaviour are verified on Linux only;
- Windows and macOS now run the full Rust library suite, but those jobs do not
  establish native UI behaviour;
- Windows native coverage remains incomplete, and macOS native UI automation
  remains tooling-blocked.

This file lists every remaining step. It gives each one a verification tier
and an exit condition. When an item lands, update its status here and in the
ledger in the same PR.

## Status legend

| Status | Meaning |
| --- | --- |
| **Open** | Can be implemented and verified in this repository, on Linux or on the GitHub-hosted Windows/macOS runners |
| **Blocked: hardware** | Needs a physical Mac or an interactive desktop session that CI cannot supply. It stays open, and no claim is made |
| **Blocked: tooling** | No driver exists for the platform: tauri-driver does not support WKWebView, so there is no macOS native UI automation |
| **Decision** | A product decision for the owner, not an implementation task |
| **Closed by ADR** | Out of scope by a recorded decision. Reopening it needs a new ADR |
| **Done** | Merged to dev with the stated evidence |

## Rules for every item

- One issue, branch, and PR per item, off `origin/dev`. The branch name must
  match the issue title.
- Write the regression test first. It must fail for the reported reason before
  the fix. Where there is no importable seam, extracting one is part of the
  work.
- Every item gets an independent adversarial review. The reviewer is not given
  the implementer's conclusions. Each finding is either fixed or recorded here
  as a limit.
- Required dev checks must be green on the final head before the squash merge.
- A platform claim needs evidence from that platform. A Windows or macOS job
  that is not required still has to be green on the merge head before its row
  can say "Done".

## W1 — Cross-platform Rust verification in CI

Unverified platforms must get their own tests before any platform row can
close. This workstream comes first because every later platform claim depends
on it.

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W1.1 | Run `cargo test --lib` and strict Clippy on `macos-latest`. This covers the `cfg(unix)` recovery, move retention and retirement, and `native_directory` (`renameatx_np`) code, and permanent deletion on APFS. Fix each failure at its root cause, or gate the test with a documented platform reason | macOS runner, green on dev | **Done ([#773](https://github.com/xnmp/tauri-explorer/pull/773))** |
| W1.2 | Replace the filtered Windows contract loop in `e2e-tauri.yml` with a full `cargo test --lib`. Keep the per-filter step only if the full run exceeds the job budget | Windows runner, green on dev | **Done ([#773](https://github.com/xnmp/tauri-explorer/pull/773))** |
| W1.3 | Add `durable-move-recovery` to the Linux feature-gated Clippy and test steps. Today only `durable-copy-recovery` runs in CI | ubuntu `rust` job | **Done ([#773](https://github.com/xnmp/tauri-explorer/pull/773))** |

Exit: all three jobs are green on dev. Any test that is skipped per platform
carries a reason that names the missing capability.

## W2 — Native test reliability

The required Linux smoke has to be trustworthy before it can serve as evidence
for anything else.

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W2.1 | #709: terminal keystrokes transposed, so the Ctrl+Q probe is never received. Reproduce under the CI wrapper, then fix delivery ordering at its source (driver key actions against terminal input), not by retrying | 20 consecutive local runs of `terminal-key-ownership` under the CI wrapper, plus green required smoke | **Done ([#775](https://github.com/xnmp/tauri-explorer/pull/775))** |
| W2.2 | #764: `git_status` rev-parse cancellation flake under the parallel suite. Decide whether it is a test race or a product race using instrumentation before changing logic | `--test-threads=64` loop, 0 failures in 30 runs | **Done ([#777](https://github.com/xnmp/tauri-explorer/pull/777))** |
| W2.3 | #761: migrate every spec that `rmSync`s a fixture while the app is alive onto `createNativeFixtureDirectory` | grep guard in the native contract tests, full native suite green | Open |
| W2.4 | #710 (`window-transfer-lifetime`) and #715 (`context-clipboard`) Windows flakes. Retain diagnostics, find the missing wait or race, and fix it | Windows smoke green on 5 consecutive dev runs | Implementation merged in [#811](https://github.com/xnmp/tauri-explorer/pull/811); five consecutive smoke runs on `dev` remain open |
| W2.5 | Fresh-window lookup renderer loss. #703 added a `/proc` sampler, but classification still requires that sampler to capture the failing fresh label. PR #804 run 36289184005 timed out waiting for fresh-window readiness and then lost the WebDriver session; its retained sampler covered earlier successful labels, not the failing label, so it cannot distinguish renderer loss from driver-session loss. The unchanged rerun passed. Open [#781](https://github.com/xnmp/tauri-explorer/issues/781) already tracks this session-loss family and should receive a future classified recurrence; do not open a duplicate issue | Retained sampler output for the failing label, including the process timeline around session loss | **Open observation (#781); sampler criterion unmet** |

## W3 — File-operation ownership (Linux remainder)

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W3.1 | Converge ordinary copy onto the ordered copy session, as ADR 0024 prescribes. Route `performFileTransfer`'s `isCopy` branch through `copy_session`, move the recovery probe's overwrite coverage onto the session path, and remove the unadmitted `copy_entry` family | Vitest caller tests, Rust session tests, and the native recovery suite, including the overwrite probe | **Done ([#813](https://github.com/xnmp/tauri-explorer/pull/813))**; the legacy copy IPC and plugin copy entry point were retired |
| W3.2 | #760 durable-move retirement follow-ups: a plan byte budget consistent with `MAX_ENTRIES`, endpoint changes after intent, resumption of stuck `Retiring` records, probe cost, macOS `ENOTSUP` and probe-mode umask, a downgrade story for `deny_unknown_fields` records, and a documented escape hatch | Rust temp-tree tests for each, run under the W1.3 job | **Done ([#790](https://github.com/xnmp/tauri-explorer/pull/790))**. Durable move remains Linux-only and opt-in; bind-mount moves fail admission, and the probe cost remains an owner decision documented in ADR 0020 |
| W3.3 | Run the gated native recovery suites in CI. `file-recovery`, `file-forward-history`, `file-history-lifetime`, `file-move-recovery` and `move-retirement` need a binary built with `e2e-renderer-recovery`, `durable-copy-recovery` and `durable-move-recovery`, and they need the `TAURI_E2E_FILE_RECOVERY_DIR`, `TAURI_E2E_HISTORY_GATE_DIR` and `TAURI_E2E_MOVE_SOURCE_DIR`/`TAURI_E2E_MOVE_TARGET_DIR` variables. No workflow sets these, so the suites skip in CI, and they skipped in the local 2026-09-26 run as well. Add a Linux job that builds that binary and points source and target at `/dev/shm` and the runner disk, so they are two real mounts. Then add the missing real cross-device forward, Undo and Redo cases: the existing Undo/Redo cycles use a single `os.tmpdir()` | New CI job green; each suite reports executed, not skipped, tests | **Done ([#778](https://github.com/xnmp/tauri-explorer/pull/778), issue [#774](https://github.com/xnmp/tauri-explorer/issues/774))**. `file-move-recovery` turned out to be a default-build suite that already runs in smoke; the durable job runs `cross-device-move-history` instead |
| W3.4 | Broader cancellation qualification. For copy and move sessions, cancel at each phase boundary. Prove that no output is published late, that residue exactly matches the phase table, and that history stays consistent | Rust interleaving tests with deterministic phase gates, plus one native outcome per session | Open |
| W3.5 | Git working-tree mutations under admission | — | **Closed by ADR 0024**. The only capturable footprint is a blanket worktree lock, and Git's `index.lock` arbitrates git-vs-git |

## W4 — Windows platform acceptance (windows-latest runner)

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W4.1 | Native identity (ledger gate 7). Add a native spec in which separator, case and trailing-slash variants of one directory resolve to a single watch and a single listing on Windows, while Linux keeps case-sensitive semantics | New spec green on Windows and Linux smoke | **Done ([#808](https://github.com/xnmp/tauri-explorer/pull/808))**; UNC root-case variants remain explicitly unsupported |
| W4.2 | Audit every Linux-only native spec. Enable each spec whose behaviour is platform-independent on Windows, such as file-list focus, preview resize, terminal resize and directory-watch lifetime. Record each spec that stays Linux-only, with the missing Windows capability as the reason | Windows smoke green | **Done ([#805](https://github.com/xnmp/tauri-explorer/pull/805))**; the per-spec audit and runner outcomes are recorded in lesson #800 |
| W4.3 | ConPTY terminal acceptance. The terminal spec already runs on Windows; add key ownership, which `terminal-key-ownership` skips on `win32`, and resize | Windows smoke | **Done ([#805](https://github.com/xnmp/tauri-explorer/pull/805))** |
| W4.4 | Config replacement and autoreload on Windows, through an atomic-replace writer rather than an in-place write | Windows smoke | **Done ([#805](https://github.com/xnmp/tauri-explorer/pull/805))** |
| W4.5 | Windows runtime physical-identity acceptance for batch spelling validation (`file_identity/windows.rs`), on real NTFS: a case variant, a short name, and a hardlink | Rust tests on the Windows runner (after W1.2) | **Partial ([#808](https://github.com/xnmp/tauri-explorer/pull/808))**: case and hardlink aliases passed on NTFS; the runner could not create a distinct 8.3 alias, so that case remains unqualified |
| W4.6 | Window launch and transfer ownership on Windows (ledger gate 6): closing the destination during a real handoff receipt, an unready native target with later app initialization, and a failed asynchronous creation with a duplicate label. Enable or port the Linux specs that cover these on WebView2 | Windows smoke | **Done ([#811](https://github.com/xnmp/tauri-explorer/pull/811))**; the final-head Windows native run executed the seven ownership cases, five rejection cases and the negative control |

## W5 — macOS platform acceptance

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W5.1 | macOS PTY: a Rust test that spawns the production PTY backend, round-trips input, resizes, and reaps the child | macOS runner (after W1.1) | **Done ([#806](https://github.com/xnmp/tauri-explorer/pull/806))**; hosted macOS Rust execution covered the production PTY test |
| W5.2 | Case-insensitive APFS rename, identity and recovery semantics, covered by the W1.1 suite on the runner's default volume | macOS runner | **Done ([#806](https://github.com/xnmp/tauri-explorer/pull/806))** on the runner's default case-insensitive volume; this is Rust contract evidence, not native UI qualification |
| W5.3 | macOS native UI E2E | — | **Blocked: tooling**. There is no WKWebView WebDriver. Browser WebKit Playwright is the proxy, and makes no native claim |
| W5.4 | Mac half-bounce, first presented frame, and usable-input startup qualification (#696, ledger gate 1) | — | **Blocked: hardware**. `launch-smoke` keeps recording 30 cold and warm process samples |

## W6 — Long-session retention (ledger gate 3)

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W6.1 | A 4-hour Linux native soak (`SOAK_DURATION_MS=14400000`) against a qualification build, with a recorded seed and the report committed to the ledger | `qualification-results/` report | Open |
| W6.2 | A bounded Windows soak (`SOAK_MAX_CYCLES=1`) on the runner. Make the runner portable if it is not | Windows job artifact | Open |
| W6.3 | External jobs (ledger gate 2): list the Rust tests for worker draining, held staging files, serialized cancel and publication, bounded fal requests and Nano child kill/reap, and confirm they run in the default suite on every W1 platform. Add one native outcome that cancels a real long-running external process (a fake executable on `PATH`) and asserts that no output is published late | Per-platform CI, plus the native outcome | **Done ([#814](https://github.com/xnmp/tauri-explorer/pull/814))** for the existing timeout cancellation path; no user Cancel control was added |

## W7 — Product acceptance matrix (ledger gates 8 and "Product acceptance")

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W7.1 | For every built-in theme, run an automated contrast check (WCAG AA) on text and selection tokens, and an axe accessibility scan of the main surfaces in all three view modes | Browser Playwright, both engines | **Done ([#787](https://github.com/xnmp/tauri-explorer/pull/787))** |
| W7.2 | Keyboard-only traversal across the main regions: sidebar, address bar, file list, preview and terminal, with visible focus in each theme | Browser Playwright, plus one native outcome | **Done ([#804](https://github.com/xnmp/tauri-explorer/pull/804))**; all three view modes and the native keyboard outcome passed |
| W7.3 | Preview formats × narrow split × zoom (80, 100, 150 %) containment | Browser Playwright | **Done ([#796](https://github.com/xnmp/tauri-explorer/pull/796))**; final-head Chromium and WebKit checks passed |
| W7.4 | Plugin failure combinations: throw on activate, reject a command, and time out a job, each while another plugin is active | Vitest registry tests, plus one browser outcome | **Done ([#783](https://github.com/xnmp/tauri-explorer/pull/783))** |

## W8 — Integration and records

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W8.1 | Re-run the full gate set on the final dev tip: svelte-check, Vitest, perf contracts, Rust (default and feature-gated), Clippy, native suite (including the W3.3 gated suites), and `ALL_VIEW_MODES=1` Playwright. Record the exact numbers against that commit. For native specs, count executed tests, not spec files: a file whose `describe` skips still counts as "passed" in the WDIO summary | Ledger section with its commit SHA | Open |
| W8.2 | Correct the 2026-09-26 ledger claim that "all 38 native specs pass": the gated recovery suites were skipped in that run. Update each ledger acceptance row and the ADR 0020 and 0024 status lines to match the evidence. Mark the "existing ownership overhaul" and "external jobs" rows accepted only if W8.1 covers them | Adversarial fact-check of the ledger against PRs and CI runs | Open |
| W8.3 | Cut the next minor release: bump the versions, write the CHANGELOG entry, open a Release PR from dev to main with `--merge` (the owner merges it; never tag manually), then verify the release assets | GitHub release with every platform asset | Open |

## Pending integration acceptance

Work on open PRs and local branches is branch evidence only. It does not close a
plan row or establish release acceptance until it is merged into `dev` and the
required platform outcomes execute. The five-run Windows flake criterion,
final-tip gate, four-hour Linux soak, bounded Windows soak, native macOS UI,
physical-Mac startup measurements and non-Linux durable recovery adapters
remain open. The distinct NTFS 8.3 alias case in W4.5 also remains unqualified
on the hosted runner. Local #817 corrected-binary diagnostics in the separate
`linux-retention-soak` worktree lost the WebKitWebDriver session at window cycle
399 after 398 native closes in mixed, warm-only, fresh-only and main-window-only
runs. The last mode avoids child WebDriver handle enumeration, switching and
DOM/script calls; it still fails at the same boundary. Reports:
`qualification-results/linux-linux-four-hour-817-df127-20260927-9b1661adf5d4.json`,
`linux-linux-warm-only-817-fad2656-20260927-b9d68aa3d187.json`, and
`linux-linux-fresh-only-817-fad2656-20260927-316ad85fd1c4.json`, and
`linux-linux-mainonly-817-74c4873-450-20260927-57900d58aea7.json` in that
worktree. The root app retained roughly one deleted WebKitSharedMemory FD per
native close, but RSS stayed bounded and the OS FD limit was far above the
observed count. A separate direct-X11 run of the same native binary, with no
WebDriver or tauri-driver, observed 399 distinct focused children with Alt+F4
returning focus to main, then failed to focus child 400 from Ctrl+N; its app
retained 401 WebKitSharedMemory memfds at cycle 399. Independent review
confirmed WebDriver independence and linear descriptor retention, but the X11
probe does not prove child destruction or loaded/painted state on each cycle.
It rules out WebDriver as the sole cause of this GUI symptom without isolating
WebKitGTK from Tauri/renderer lifetime. Its log is
`/tmp/overhaul-resume/817-x11-450.log`; the first app log was overwritten by
a later preflight. A strengthened third run
(`/tmp/overhaul-resume/817-x11-close-proof-450.log`) verified each of 399 child
XIDs disappeared after Alt+F4. At attempt 400 the main WebKitWebProcess PID
3412618 disappeared, the mapped main window turned blank white, and a control
Ctrl+T produced no new listing while the native app stayed alive. Its source,
binary and script hashes are embedded in the log; the screenshot is
`/tmp/overhaul-resume/817-x11-failure-close-proof-450.png`. Independent review
confirmed those observations, while complete child renderer teardown and the
WebKitGTK/Tauri/app ownership of the failure remain unproven. These are
diagnostic artifacts, not integrated or passing four-hour acceptance. An
earlier cycle-187 failure came from an invalid window-selector fixture and
does not count as product evidence. W2.5 also remains an unclassified
observation until the sampler captures the label that actually loses its
session. W8.1 must record executed test counts and list skips separately on the
final selected `dev` SHA.

### W8.3 release checklist (v1.11.0)

The authoritative version fields still read `1.10.0` at this checkpoint:
`package.json`, `src-tauri/Cargo.toml`, the root package in
`src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, and the `PKGBUILD`
fallback. Update all five to `1.11.0`, reset `pkgrel=1`, and add a dated
`CHANGELOG.md` entry that states the platform and opt-in limits.

Before opening the release PR, record the owner's D1/D2 decisions, integrate
or explicitly defer each remaining branch, and run W8.1 on one exact final
`dev` SHA. Report executed and skipped native test cases separately. Require a
passing four-hour Linux report, bounded Windows report and screenshot, five
consecutive Windows `dev` smoke runs for W2.4, and final hosted Rust/platform
checks; keep any unmet item open instead of implying release acceptance.
The release PR is `dev` → `main` with merge strategy `--merge`. Its required
checks and evidence must pass before the owner merges it. Do not create a tag
manually; verify the resulting GitHub release and every expected platform
asset after the merge.

## Decisions for the owner

| ID | Decision | Default until decided |
| --- | --- | --- |
| D1 | Enable `durable-copy-recovery` and `durable-move-recovery` by default | Both stay opt-in, and ADR 0020 stays *Proposed* |
| D2 | Accept Linux-only recovery admission for the release, or require ports of Windows and macOS admission adapters. A port is a separate multi-PR project: `forward_copy`, `forward_move`, `history` and the coordinator are `cfg(target_os = "linux")` or `cfg(unix)` today | Linux-only. The `platform-recovery-adapters` matrix row stays `not-implemented` |

## Order

1. W1, because every later platform claim depends on it.
2. W2.1 and W2.2, because they make required checks trustworthy.
3. W3.3 (it turns existing recovery acceptance into CI evidence), then W3.1 and W3.4, then W3.2.
4. W4 and W5.1–W5.2, in parallel with W7.
5. W6.
6. W8.
