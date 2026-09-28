# Architecture overhaul — remaining work

Written 2026-09-26 after v1.10.0. Tracking issue: #770.

v1.10.0 shipped every follow-up from the 2026-09-25 handover
([`docs/handoffs/architecture-review-2026-09-25.md`](../handoffs/architecture-review-2026-09-25.md)).
It did not close the overhaul. The acceptance table in
[`docs/review-completion.md`](../review-completion.md) still has open rows, and
the remaining rows still share a platform boundary:

- durable recovery and admission adapters remain Linux-only;
- Windows and macOS now run the full Rust library suite and selected native
  outcomes, but these do not establish comprehensive native UI behaviour;
- Windows native coverage remains incomplete, and the local macOS Mac2/XCTest
  pilot still needs a hosted native UI outcome.

This file lists every remaining step. It gives each one a verification tier
and an exit condition. When an item lands, update its status here and in the
ledger in the same PR.

## Status legend

| Status | Meaning |
| --- | --- |
| **Open** | Can be implemented and verified in this repository, on Linux or on the GitHub-hosted Windows/macOS runners |
| **Blocked: hardware** | Needs a physical Mac or an interactive desktop session that CI cannot supply. It stays open, and no claim is made |
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

The local #812/#815/#816 publication ranges and their intermediate Git objects
have a [read-only egress audit](architecture-overhaul-publication-audit-2026-09-28.md).
It does not authorize the pending GitHub writes.

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
| W2.3 | #761: migrate every spec that `rmSync`s a fixture while the app is alive onto `createNativeFixtureDirectory` | grep guard in the native contract tests, full native suite green | **Done ([#816](https://github.com/xnmp/tauri-explorer/pull/816), `dev` `8e9403bd`)**. Its 25 focused contracts, native typecheck and independent review passed. The hosted Linux native suite executed 94 cases with 17 feature-gated skips across 43 specs, and all 15 PR checks passed. The final combined W8.1 gate remains separate |
| W2.4 | #710 (`window-transfer-lifetime`) and #715 (`context-clipboard`) Windows flakes. Retain diagnostics, find the missing wait or race, and fix it | Windows smoke green on 5 consecutive dev runs | Implementation merged in [#811](https://github.com/xnmp/tauri-explorer/pull/811); **3/5** post-merge Windows `dev` smoke bodies passed in runs `36304881589` (`5c67f0c3`), `36306053111` (`e8050938`) and `36423371292` (`c90f0d4d`; its Windows smoke body completed successfully at 13:14 UTC). The intervening cancelled #813 workflow did not execute its Windows smoke body and adds no pass. PR #827's unchanged Windows smoke failed while `switchToLabel` scanned several WebDriver handles under one 20-second deadline; the target label and listing were present in retained diagnostics. [PR #830](https://github.com/xnmp/tauri-explorer/pull/830), merged on `dev` as `579fc9ea`, completes each scan before checking the deadline, with focused contracts, native typecheck and independent review; hosted Windows smoke passed. The hosted Ubuntu smoke run and its first failed-job rerun lost the WebDriver session in two different unchanged directory-watch specs after fresh children reached app readiness, matching the separately tracked #703/#781 observation problem rather than a scanner assertion. The second targeted Ubuntu rerun passed, completing all 15 hosted checks on PR #830 head `2fcff9b9`. Two more qualifying consecutive `dev` Windows smoke bodies are required; #710 and #715 remain open |
| W2.5 | Fresh-window lookup renderer loss. #703 added a `/proc` sampler, but classification still requires that sampler to capture the failing fresh label. PR #804 run 36289184005 timed out waiting for fresh-window readiness and then lost the WebDriver session; its retained sampler covered earlier successful labels, not the failing label, so it cannot distinguish renderer loss from driver-session loss. The unchanged rerun passed. Open [#781](https://github.com/xnmp/tauri-explorer/issues/781) also tracks session loss while an abandoned warm claim expires; do not open a duplicate issue | Retained sampler output for the failing label, including the process timeline around session loss | **Observation criterion met on the failing label; #781 remains open and PR #831 is in exact-head CI**. The prior [PR #831](https://github.com/xnmp/tauri-explorer/pull/831) head `614a814a` passed all 15 hosted checks; prior head `52adf4f1` passed all 15 exact-head checks after an unchanged-head Linux smoke rerun. Its conflict-resolved head `3ece3cb8` includes current `dev` `c90f0d4d`; native TypeScript, 32 focused contracts and code-map coverage passed, and new hosted checks are running. It derives a fresh child label from the request token, captures process timelines before launch and selection, writes selected evidence before the page snapshot, and retains warm-claim source-close diagnostics. Stored process groups and renderer first-seen/first-missing summaries are bounded; process scans used for liveness are complete. On current head `52adf4f1`, 32 focused contracts, the full Vitest suite (2,687 passed, 3 skipped), 29/29 perf contracts, Svelte/native typechecks, map coverage and independent adversarial review pass. This observation PR was extracted into a clean issue-matched branch from `dev`; it does not contain the separate #817 soak harness. A separate #817 fresh-only diagnostic lost its session at cycle 399 during `fresh-open`, before a child label was returned, so it cannot supply the required labeled timeline. The local integration now derives the fresh child label from the E2E request token and samples processes before `fresh-open` dispatch; rejected, null and mismatched launches retain bounded JSON in the soak artifact directory. Focused contracts, typecheck, map coverage and an independent adversarial review pass. The exact `4eb9b97e` debug binary (`294d2c2a…798ad53`) passed two fresh-only native cycles with matching launch labels and no run errors; the local ignored report is `qualification-results/linux-fresh-prelaunch-20260928-f4868d54e4fb.json`. A later [450-cycle fresh-window diagnostic](architecture-overhaul-fresh-window-450-2026-09-28.md) on the same binary passed every real-native cycle, including the older failure boundary at cycle 399; its ignored report and logs are hashed in that record. This 9m36s run did not reproduce a session loss or produce a failing-label process timeline, and its four-hour retention fields are inapplicable. A later [1,500-cycle private-display diagnostic](architecture-overhaul-fresh-window-1500-2026-09-28.md) on the same binary also exited 0: 1,500 sequential fresh `window-workspace` outcomes passed, with 1,500 native closes, no run errors and no failure artifact. Its 38m23s duration does not satisfy four-hour retention; an independent Sol audit confirmed the cycle and binary evidence but found private-display isolation only plausible from retained artifacts because live child process environments were not saved. The earlier desktop run was interrupted at 552 opens so windows stopped appearing on the user's workspace. Neither run captured a failing-label timeline. The same binary passed the complete default native suite with a same-filesystem isolated XDG profile: **98 executed, 17 gated skips across 44 spec files**, with no failures; full Vitest passed 2,699/3 skipped and perf 29/29. A `/tmp` XDG data profile had first caused four trash/copy spec failures, and those four passed when rerun on the fixture filesystem before the clean full rerun. The sampler sees global WebKit processes, so its renderer timeline is observational until a child is selected. [Hosted native smoke run 36409158510](https://github.com/xnmp/tauri-explorer/actions/runs/36409158510) completed successfully on Linux and Windows at prior head `614a814a`, without reproducing a session loss or yielding a failing-label timeline. Exact-head Windows native smoke passed on `52adf4f1`, while [Linux job 108898363468](https://github.com/xnmp/tauri-explorer/actions/runs/36413296329/job/108898363468) failed after capturing the [actual failing-label timeline](architecture-overhaul-w25-failing-label-2026-09-28.md): 41 samples span session deletion, one WebKit renderer disappeared, and the app and driver processes persisted. Independent review confirmed that the stalled command targeted the earlier of two new WebDriver handles; no handle or renderer was mapped to the requested child. This meets the row’s literal sampler criterion, but not root-cause attribution or `dev` acceptance. The [unchanged-head Linux smoke rerun, job 108906854373](https://github.com/xnmp/tauri-explorer/actions/runs/36413296329/job/108906854373), passed, completing **15/15 hosted PR #831 checks** on `52adf4f1`; the original failure remains unexplained. On merged-base head `3ece3cb8`, [Ubuntu smoke job 108931835975](https://github.com/xnmp/tauri-explorer/actions/runs/36423534604/job/108931835975) captured a [second failing-label timeline](architecture-overhaul-w25-failing-label-2026-09-28.md): the requested child handle and label were identified, then WebDriver lost its session during an immediate page snapshot. One renderer disappeared, but its window ownership is unproven; 43 other spec files passed and no directory-watch assertion failed. Independent Sol triage recommends one unchanged-head rerun before a source-regression claim. Current-head hosted checks, merge and final-tip acceptance remain; #703/#781 session loss is still open |

## W3 — File-operation ownership (Linux remainder)

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W3.1 | Converge ordinary copy onto the ordered copy session, as ADR 0024 prescribes. Route `performFileTransfer`'s `isCopy` branch through `copy_session`, move the recovery probe's overwrite coverage onto the session path, and remove the unadmitted `copy_entry` family | Vitest caller tests, Rust session tests, and the native recovery suite, including the overwrite probe | **Done ([#813](https://github.com/xnmp/tauri-explorer/pull/813))**; the legacy copy IPC and plugin copy entry point were retired |
| W3.2 | #760 durable-move retirement follow-ups: a plan byte budget consistent with `MAX_ENTRIES`, endpoint changes after intent, resumption of stuck `Retiring` records, probe cost, macOS `ENOTSUP` and probe-mode umask, a downgrade story for `deny_unknown_fields` records, and a documented escape hatch | Rust temp-tree tests for each, run under the W1.3 job | **Done ([#790](https://github.com/xnmp/tauri-explorer/pull/790))**. Durable move remains Linux-only and opt-in; bind-mount moves fail admission, and the probe cost remains an owner decision documented in ADR 0020 |
| W3.3 | Run the gated native recovery suites in CI. `file-recovery`, `file-forward-history`, `file-history-lifetime`, `file-move-recovery` and `move-retirement` need a binary built with `e2e-renderer-recovery`, `durable-copy-recovery` and `durable-move-recovery`, and they need the `TAURI_E2E_FILE_RECOVERY_DIR`, `TAURI_E2E_HISTORY_GATE_DIR` and `TAURI_E2E_MOVE_SOURCE_DIR`/`TAURI_E2E_MOVE_TARGET_DIR` variables. No workflow sets these, so the suites skip in CI, and they skipped in the local 2026-09-26 run as well. Add a Linux job that builds that binary and points source and target at `/dev/shm` and the runner disk, so they are two real mounts. Then add the missing real cross-device forward, Undo and Redo cases: the existing Undo/Redo cycles use a single `os.tmpdir()` | New CI job green; each suite reports executed, not skipped, tests | **Done ([#778](https://github.com/xnmp/tauri-explorer/pull/778), issue [#774](https://github.com/xnmp/tauri-explorer/issues/774))**. `file-move-recovery` turned out to be a default-build suite that already runs in smoke; the durable job runs `cross-device-move-history` instead |
| W3.4 | Broader cancellation qualification. For copy and move sessions, cancel at each phase boundary. Prove that no output is published late, that residue exactly matches the phase table, and that history stays consistent | Rust interleaving tests with deterministic phase gates, plus one native outcome per session | **Done ([#815](https://github.com/xnmp/tauri-explorer/pull/815), `dev` `eb4d4e3d`)**. Four focused default and durable-move Rust tests cover three-item cancellation residue, events and inverse paths; the rebuilt Linux native cancellation suite executed and passed 4/4 cases, including copy and move prefixes. Independent review and all 15 PR checks passed. W8.1 final-tip integration remains separate |
| W3.5 | Git working-tree mutations under admission | — | **Closed by ADR 0024**. The only capturable footprint is a blanket worktree lock, and Git's `index.lock` arbitrates git-vs-git |

## W4 — Windows platform acceptance (windows-latest runner)

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W4.1 | Native identity (ledger gate 7). Add a native spec in which separator, case and trailing-slash variants of one directory resolve to a single watch and a single listing on Windows, while Linux keeps case-sensitive semantics | New spec green on Windows and Linux smoke | **Done ([#808](https://github.com/xnmp/tauri-explorer/pull/808))**; UNC root-case variants remain explicitly unsupported |
| W4.2 | Audit every Linux-only native spec. Enable each spec whose behaviour is platform-independent on Windows, such as file-list focus, preview resize, terminal resize and directory-watch lifetime. Record each spec that stays Linux-only, with the missing Windows capability as the reason | Windows smoke green | **Done ([#805](https://github.com/xnmp/tauri-explorer/pull/805))**; the per-spec audit and runner outcomes are recorded in lesson #800 |
| W4.3 | ConPTY terminal acceptance. The terminal spec already runs on Windows; add key ownership, which `terminal-key-ownership` skips on `win32`, and resize | Windows smoke | **Done ([#805](https://github.com/xnmp/tauri-explorer/pull/805))** |
| W4.4 | Config replacement and autoreload on Windows, through an atomic-replace writer rather than an in-place write | Windows smoke | **Done ([#805](https://github.com/xnmp/tauri-explorer/pull/805))** |
| W4.5 | Windows runtime physical-identity acceptance for batch spelling validation (`file_identity/windows.rs`), on real NTFS: a case variant, a short name, and a hardlink | Rust tests on the Windows runner (after W1.2) | **Done ([#826](https://github.com/xnmp/tauri-explorer/pull/826), `dev` `f4c81ead`)**. Case and hardlink aliases passed earlier in #808. In [Windows Rust job 108836388520](https://github.com/xnmp/tauri-explorer/actions/runs/36394122928/job/108836388520), the dedicated step verified its actual TEMP fixture volume is NTFS, changed 8.3 creation policy from 2 to 0, executed exactly one `ntfs_short_name_alias_keeps_physical_identity` test with 1 passed/0 ignored/0 failed, then restored policy 2. The test requires a distinct short leaf and equal physical identity. All 15 PR checks passed on `3cd6fe9a`; the squash-merged `dev` commit has the identical tree `e1fa3ecd` as that checked PR head. W8.1 final-tip integration remains separate |
| W4.6 | Window launch and transfer ownership on Windows (ledger gate 6): closing the destination during a real handoff receipt, an unready native target with later app initialization, and a failed asynchronous creation with a duplicate label. Enable or port the Linux specs that cover these on WebView2 | Windows smoke | **Done ([#811](https://github.com/xnmp/tauri-explorer/pull/811))**; the final-head Windows native run executed the seven ownership cases, five rejection cases and the negative control |

## W5 — macOS platform acceptance

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W5.1 | macOS PTY: a Rust test that spawns the production PTY backend, round-trips input, resizes, and reaps the child | macOS runner (after W1.1) | **Done ([#806](https://github.com/xnmp/tauri-explorer/pull/806))**; hosted macOS Rust execution covered the production PTY test |
| W5.2 | Case-insensitive APFS rename, identity and recovery semantics, covered by the W1.1 suite on the runner's default volume | macOS runner | **Done ([#806](https://github.com/xnmp/tauri-explorer/pull/806))** on the runner's default case-insensitive volume; this is Rust contract evidence, not native UI qualification |
| W5.3 | macOS native UI E2E: child listing and Up navigation through XCTest | Hosted Mac Appium Mac2 pilot | **Done ([#827](https://github.com/xnmp/tauri-explorer/pull/827), `dev` `c90f0d4d`)**. The macOS ARM64 [native-ui artifact 10957059159](https://github.com/xnmp/tauri-explorer/actions/runs/36394140182/artifacts/10957059159) records child listing, Up navigation and parent listing as passed; two accessibility snapshots and a visually inspected screenshot support the report. All 16 PR checks passed. `tauri-driver` still lacks WKWebView support; W8.1 final-tip integration remains separate |
| W5.4 | Mac half-bounce, first presented frame, and usable-input startup qualification (#696, ledger gate 1) | — | **Blocked: hardware**. `launch-smoke` keeps recording 30 cold and warm process samples |

## W6 — Long-session retention (ledger gate 3)

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W6.1 | A 4-hour Linux native soak (`SOAK_DURATION_MS=14400000`) against a qualification build, with a recorded seed and the report committed to the ledger | [2026-09-28 report](../../qualification-results/linux-linux-four-hour-817-wry-isolated-20260927-ccc3a09cb1be.json): 2,510 complete cycles, 4 scenarios, 240.09 minutes, exit 0; independent `/proc` figures are excluded because their raw trace was not retained | **Open pending review and dev merge**. The four-hour Linux report qualifies pinned combined source `75859d97`, which included #812/#816; its raw independent `/proc` trace was not retained. [Draft PR #833](https://github.com/xnmp/tauri-explorer/pull/833) extracts the #817 delta; its current head includes `dev` `c90f0d4d`, where #812/#816 are merged. Exact extracted source `c4696e8e` passed a private-display bounded native preflight with **8/8 outcomes across two cycles**, including warm and fresh windows; [the committed report](https://github.com/xnmp/tauri-explorer/blob/27196ffa/qualification-results/linux-extracted-c4696e8e-dual-private-edd11a8752e5.json) records zero run errors. Svelte/native TypeScript, 40 focused Vitest contracts, 1,427 Rust library cases with 35 ignored, strict feature-gated Clippy and map coverage passed. Independent Sol review found and verified a preview prerequisite fix and corrected RSS documentation. The first hosted Ubuntu smoke exposed an existing `target-state` response-shape regression on #833. Head `faa64b97` preserves that hook contract and adds a separate readiness query; subsequent head `ea3a7932` checks the initial native child path and fixture entry before navigation. Local Svelte/native typechecks and 38 focused tests passed for the hook fix; native typecheck and 35 focused tests passed for the listing check. Independent Sol review confirmed the hook contract and identified the initial-listing gap. New exact-head hosted checks are running. The bounded pass is not four-hour proof for the updated source. Required review, `dev` merge and W8.1 final-tip acceptance remain open |
| W6.2 | A bounded Windows soak (`SOAK_MAX_CYCLES=1`) on the runner. Make the runner portable if it is not | Windows job artifact | **Done ([#812](https://github.com/xnmp/tauri-explorer/pull/812), `dev` `6f5aa9e2`)**. [Hosted artifact 10957692938](https://github.com/xnmp/tauri-explorer/actions/runs/36393848199/artifacts/10957692938) records one complete four-scenario Windows native soak cycle, six resource samples, scale 1, no run errors and `passed: true`; its screenshot shows the real Windows listing and Markdown preview. All 16 PR checks passed. The separate watcher-test fix #829 and fixture-lifetime fix #816 also landed on `dev`; W8.1 final-tip integration remains separate |
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
| W8.1 | Re-run the full gate set on the final dev tip: svelte-check, Vitest, perf contracts, Rust (default and feature-gated), Clippy, native suite (including the W3.3 gated suites), and `ALL_VIEW_MODES=1` Playwright. Record the exact numbers against that commit. For native specs, count executed tests, not spec files: a file whose `describe` skips still counts as "passed" in the WDIO summary | Ledger section with its commit SHA | **Open**. Local integration `47830d4e` has the same product source as tested `a4f8cf32` (only two native assertions changed later). Local checks passed: Svelte/type and map coverage; 2,694 unit cases with 3 skips; 29 perf contracts; 1,431 Rust library cases with 35 ignores in default and opt-in builds; strict all-target Clippy; bundle budget; 7 high-load browser cases; 98 executed default-native cases with 17 gated skips; 19 executed gated-native cases and renderer recovery. The full 2,408-case all-view browser run passed 2,372 with 36 skips under a local system-libsoup 3.6.6 preload; 16 WebKit page-process cores in its time window mean crash-free engine stability is unproven. The later W2.5 harness-only commit `4eb9b97e` additionally passed 2,699 unit cases/3 skips, 29 perf contracts, typecheck, and the full default native suite (98 executed/17 gated skips across 44 files) on its exact rebuilt binary; the broader W8.1 gates have not been rerun on that local head. A refreshed combined-integration rehearsal at detached `5ff25971` passed Svelte/native TypeScript, 2,699 unit cases/3 skips, 29 perf contracts, map coverage 514/514, both default and opt-in Rust library suites (1,431 passed/35 ignored each), strict feature-gated Clippy and the bundle budget. Its first uncached Rust compilation hit a full workspace disk before tests; after cleaning only that new target, both suites passed using the existing `/tmp` cache. These are pre-merge checks, not W8.1 final-tip acceptance. Final published `dev`, hosted platform gates and release acceptance remain required. [Local gate evidence](architecture-overhaul-local-gates-2026-09-28.md) records the logs and hashes |
| W8.2 | Correct the 2026-09-26 ledger claim that "all 38 native specs pass": the gated recovery suites were skipped in that run. Update each ledger acceptance row and the ADR 0020 and 0024 status lines to match the evidence. Mark the "existing ownership overhaul" and "external jobs" rows accepted only if W8.1 covers them | Adversarial fact-check of the ledger against PRs and CI runs | **Open pending dev merge and final-tip audit**. Draft [PR #832](https://github.com/xnmp/tauri-explorer/pull/832) publishes the current W8 evidence for review without claiming completion. The active ledger now distinguishes executed native cases from skipped specs and records the hosted #812 Windows soak, #826 NTFS 8.3 and #827 Mac2 pilots without claiming dev acceptance; it also reconciles #815/#816 and the newer pinned W6.1 evidence. ADR 0020 remains proposed for default/cross-platform recovery with Linux opt-in implementation, and ADR 0024 remains accepted only for enumerated family decisions. An independent Sol fact-check found no remaining material ledger/ADR contradiction against retained local evidence; its GitHub access failed, so the coordinator separately verified current PR checks and `origin/dev`. W8.1 on the final published dev tip remains the acceptance boundary |
| W8.3 | Cut the next minor release: bump the versions, write the CHANGELOG entry, open a Release PR from dev to main with `--merge` (the owner merges it; never tag manually), then verify the release assets | GitHub release with every platform asset | **Open pending final dev and owner merge.** Local release rehearsal `13b7213a` aligns all five v1.11.0 version fields and dates the changelog; the exact release-workflow notes step now passes (it rejected the prior `Unreleased` heading). The asset-matrix step accepted the six actual v1.10.0 asset names and rejected an extra wrong-version bundle. The date and qualification prose must be refreshed against the actual release day and final-dev results before the Release PR merges; the final PR, owner merge, and v1.11.0 assets are still outstanding |

## Pending integration acceptance

Work on open PRs and local branches is branch evidence only. It does not close a
plan row or establish release acceptance until it is merged into `dev` and the
required platform outcomes execute. The five-run Windows flake criterion, final-tip gate, and dev integration
of the passing pinned Linux four-hour report remain open. The bounded Windows
soak, native macOS UI and distinct NTFS 8.3 alias case have landed. Physical-Mac startup W5.4 is a follow-up outside this release
gate. Non-Linux durable recovery adapters remain unimplemented under the
default D2 scope decision. Local #817
corrected-binary diagnostics in the separate
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
confirmed those observations; at that stage complete child renderer teardown
and the WebKitGTK/Tauri/app ownership of the failure were unproven. These are
diagnostic artifacts, not integrated or passing four-hour acceptance. An
earlier cycle-187 failure came from an invalid window-selector fixture and
does not count as product evidence.

Subsequent matched GTK controls isolated the retained-descriptor signature:
a custom-scheme WebView released its descriptor after every close through 450
cycles, while a signal callback holding the WebView strongly retained one
per close. Wry 0.55.1's GTK IPC handler has that ownership cycle. A local
Wry `WeakRef<WebView>` patch in #817 passed 450 direct-X11 native child closes
with two stable shared-memory descriptors, then Ctrl+T completed another real
backend listing (901→902). The clean #817 commit `75859d97` produced a
qualification binary SHA256 `0067945418da5f5b35cf72f50517d6488c592a91923f00c49cee6a9015cb81ce`;
its four-cycle real Tauri/WebDriver warm/fresh preflight passed. A full
14,400,000 ms all-scenario Linux soak on that exact binary started at about
19:31 Sydney on 2026-09-27 (seed `linux-four-hour-817-wry-weak-20260927`).
The local #817 report gate now samples the app root's WebKit shared-memory
descriptors and requires timestamp-spanning early/late median bounds. That
first pinned four-hour attempt failed at 166.02 minutes, with 1,704 complete
four-scenario cycles and a failed cycle-1705 warm-window attempt. Its report is
`qualification-results/linux-linux-four-hour-817-wry-weak-20260927-8ca134a38a99.json`.
The app root and main renderer survived, and the shared-memory FD count stayed
near two. `coredumpctl` shows a different `WebKitWebProcess` aborted in a
JavaScriptCore GC helper before WebDriver deleted the session; independent
review confirmed that ordering, while exact parked-handle/PID ownership remains
probable rather than proved. The report has no full-duration RSS/FD verdict.
An isolated run on the exact source and binary, with no concurrent browser
suite, completed 240.09 minutes and 2,510 four-scenario cycles. Its committed
[report](../../qualification-results/linux-linux-four-hour-817-wry-isolated-20260927-ccc3a09cb1be.json)
passed; independent sampler figures are excluded from acceptance because the
raw trace was not retained.
W6.1 is accepted for that pinned Linux source, while final-dev W8.1 and other
platform retention acceptance remain open. W2.5 also
remains an unclassified failing-label observation: the separate #781 native
diagnostic passed 3/3 but did not capture this soak's crashed handle/PID.
W8.1 must record executed test counts and list skips separately on the final
selected `dev` SHA.

### W8.3 release checklist (v1.11.0)

The authoritative version fields on published `dev` still read `1.10.0`:
`package.json`, `src-tauri/Cargo.toml`, the root package in
`src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, and the `PKGBUILD`
fallback. The local release rehearsal updates all five to `1.11.0` and resets
`pkgrel=1`; the changelog still says `Unreleased`. After the final gates, add a dated
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
