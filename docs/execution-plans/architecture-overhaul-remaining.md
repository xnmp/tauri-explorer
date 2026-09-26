# Architecture overhaul — remaining work

Written 2026-09-26 after v1.10.0. Tracking issue: #770.

v1.10.0 shipped every follow-up from the 2026-09-25 handover
([`docs/handoffs/architecture-review-2026-09-25.md`](../handoffs/architecture-review-2026-09-25.md)).
It did not close the overhaul. The acceptance table in
[`docs/review-completion.md`](../review-completion.md) still has open rows, and
most of them are the same gap:

- recovery, admission and native behaviour are verified on Linux only;
- Windows is verified by a filtered set of Rust contracts and a smoke suite
  where most file-operation specs skip;
- macOS runs no Rust tests at all, although every `cfg(unix)` recovery module
  compiles there.

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
| W1.1 | Run `cargo test --lib` and strict Clippy on `macos-latest`. This covers the `cfg(unix)` recovery, move retention and retirement, and `native_directory` (`renameatx_np`) code, and permanent deletion on APFS. Fix each failure at its root cause, or gate the test with a documented platform reason | macOS runner, green on dev | Open |
| W1.2 | Replace the filtered Windows contract loop in `e2e-tauri.yml` with a full `cargo test --lib`. Keep the per-filter step only if the full run exceeds the job budget | Windows runner, green on dev | Open |
| W1.3 | Add `durable-move-recovery` to the Linux feature-gated Clippy and test steps. Today only `durable-copy-recovery` runs in CI | ubuntu `rust` job | Open |

Exit: all three jobs are green on dev. Any test that is skipped per platform
carries a reason that names the missing capability.

## W2 — Native test reliability

The required Linux smoke has to be trustworthy before it can serve as evidence
for anything else.

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W2.1 | #709: terminal keystrokes transposed, so the Ctrl+Q probe is never received. Reproduce under the CI wrapper, then fix delivery ordering at its source (driver key actions against terminal input), not by retrying | 20 consecutive local runs of `terminal-key-ownership` under the CI wrapper, plus green required smoke | Open |
| W2.2 | #764: `git_status` rev-parse cancellation flake under the parallel suite. Decide whether it is a test race or a product race using instrumentation before changing logic | `--test-threads=64` loop, 0 failures in 30 runs | Open |
| W2.3 | #761: migrate every spec that `rmSync`s a fixture while the app is alive onto `createNativeFixtureDirectory` | grep guard in the native contract tests, full native suite green | Open |
| W2.4 | #710 (`window-transfer-lifetime`) and #715 (`context-clipboard`) Windows flakes. Retain diagnostics, find the missing wait or race, and fix it | Windows smoke green on 5 consecutive dev runs | Open |
| W2.5 | #703: fresh-window lookup renderer loss. The diagnostic sampler exists; use its output to decide whether a product change is needed | Retained `/proc` samples from a failing run | Open |

## W3 — File-operation ownership (Linux remainder)

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W3.1 | Converge ordinary copy onto the ordered copy session, as ADR 0024 prescribes. Route `performFileTransfer`'s `isCopy` branch through `copy_session`, move the recovery probe's overwrite coverage onto the session path, and remove the unadmitted `copy_entry` family | Vitest caller tests, Rust session tests, and the native recovery suite, including the overwrite probe | Open |
| W3.2 | #760 durable-move retirement follow-ups: a plan byte budget consistent with `MAX_ENTRIES`, endpoint changes after intent, resumption of stuck `Retiring` records, probe cost, macOS `ENOTSUP` and probe-mode umask, a downgrade story for `deny_unknown_fields` records, and a documented escape hatch | Rust temp-tree tests for each, run under the W1.3 job | Open |
| W3.3 | Real cross-filesystem move acceptance on Linux (tmpfs ↔ ext4; `/dev/shm` ↔ runner disk in CI). Cover forward move, Undo, Redo, and interruption residue | Rust temp-tree tests across two real mounts, plus a native spec | Open |
| W3.4 | Broader cancellation qualification. For copy and move sessions, cancel at each phase boundary. Prove that no output is published late, that residue exactly matches the phase table, and that history stays consistent | Rust interleaving tests with deterministic phase gates, plus one native outcome per session | Open |
| W3.5 | Git working-tree mutations under admission | — | **Closed by ADR 0024**. The only capturable footprint is a blanket worktree lock, and Git's `index.lock` arbitrates git-vs-git |

## W4 — Windows platform acceptance (windows-latest runner)

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W4.1 | Native identity (ledger gate 7). Add a native spec in which separator, case and trailing-slash variants of one directory resolve to a single watch and a single listing on Windows, while Linux keeps case-sensitive semantics | New spec green on Windows and Linux smoke | Open |
| W4.2 | Audit every Linux-only native spec. Enable each spec whose behaviour is platform-independent on Windows, such as file-list focus, preview resize, terminal resize and directory-watch lifetime. Record each spec that stays Linux-only, with the missing Windows capability as the reason | Windows smoke green | Open |
| W4.3 | ConPTY terminal acceptance. The terminal spec already runs on Windows; add key ownership, which `terminal-key-ownership` skips on `win32`, and resize | Windows smoke | Open |
| W4.4 | Config replacement and autoreload on Windows, through an atomic-replace writer rather than an in-place write | Windows smoke | Open |
| W4.5 | Windows runtime physical-identity acceptance for batch spelling validation (`file_identity/windows.rs`), on real NTFS: a case variant, a short name, and a hardlink | Rust tests on the Windows runner (after W1.2) | Open |

## W5 — macOS platform acceptance

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W5.1 | macOS PTY: a Rust test that spawns the production PTY backend, round-trips input, resizes, and reaps the child | macOS runner (after W1.1) | Open |
| W5.2 | Case-insensitive APFS rename, identity and recovery semantics, covered by the W1.1 suite on the runner's default volume | macOS runner | Open |
| W5.3 | macOS native UI E2E | — | **Blocked: tooling**. There is no WKWebView WebDriver. Browser WebKit Playwright is the proxy, and makes no native claim |
| W5.4 | Mac half-bounce, first presented frame, and usable-input startup qualification (#696, ledger gate 1) | — | **Blocked: hardware**. `launch-smoke` keeps recording 30 cold and warm process samples |

## W6 — Long-session retention (ledger gate 3)

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W6.1 | A 4-hour Linux native soak (`SOAK_DURATION_MS=14400000`) against a qualification build, with a recorded seed and the report committed to the ledger | `qualification-results/` report | Open |
| W6.2 | A bounded Windows soak (`SOAK_MAX_CYCLES=1`) on the runner. Make the runner portable if it is not | Windows job artifact | Open |

## W7 — Product acceptance matrix (ledger gates 8 and "Product acceptance")

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W7.1 | For every built-in theme, run an automated contrast check (WCAG AA) on text and selection tokens, and an axe accessibility scan of the main surfaces in all three view modes | Browser Playwright, both engines | Open |
| W7.2 | Keyboard-only traversal across the main regions: sidebar, address bar, file list, preview and terminal, with visible focus in each theme | Browser Playwright, plus one native outcome | Open |
| W7.3 | Preview formats × narrow split × zoom (80, 100, 150 %) containment | Browser Playwright | Open |
| W7.4 | Plugin failure combinations: throw on activate, reject a command, and time out a job, each while another plugin is active | Vitest registry tests, plus one browser outcome | Open |

## W8 — Integration and records

| ID | Step | Verification | Status |
| --- | --- | --- | --- |
| W8.1 | Re-run the full gate set on the final dev tip: svelte-check, Vitest, perf contracts, Rust (default and feature-gated), Clippy, native suite, and `ALL_VIEW_MODES=1` Playwright. Record the exact numbers against that commit | Ledger section with its commit SHA | Open |
| W8.2 | Update each ledger acceptance row and the ADR 0020 and 0024 status lines to match the evidence. Mark the "existing ownership overhaul" and "external jobs" rows accepted only if W8.1 covers them | Adversarial fact-check of the ledger against PRs and CI runs | Open |
| W8.3 | Cut the next minor release: bump the versions, write the CHANGELOG entry, open a Release PR from dev to main with `--merge` (the owner merges it; never tag manually), then verify the release assets | GitHub release with every platform asset | Open |

## Decisions for the owner

| ID | Decision | Default until decided |
| --- | --- | --- |
| D1 | Enable `durable-copy-recovery` and `durable-move-recovery` by default | Both stay opt-in, and ADR 0020 stays *Proposed* |
| D2 | Accept Linux-only recovery admission for the release, or require ports of Windows and macOS admission adapters. A port is a separate multi-PR project: `forward_copy`, `forward_move`, `history` and the coordinator are `cfg(target_os = "linux")` or `cfg(unix)` today | Linux-only. The `platform-recovery-adapters` matrix row stays `not-implemented` |

## Order

1. W1, because every later platform claim depends on it.
2. W2.1 and W2.2, because they make required checks trustworthy.
3. W3.1, W3.3 and W3.4, then W3.2.
4. W4 and W5.1–W5.2, in parallel with W7.
5. W6.
6. W8.
