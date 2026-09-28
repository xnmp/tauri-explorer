# Platform pilot publication packet

Prepared 2026-09-28 from the verified remote `dev` tip
`e8050938d3e602eed4700fe005b04dcc0f524a47`. The issue-matched branches
and draft PRs were published on 2026-09-28. The Mac2 and Windows NTFS pilots
have both passed. Recheck the real `dev` tip before merging.

## W4.5 — NTFS short-name identity

Candidate: `.claude/worktrees/overhaul-w45-publication` at `3cd6fe9a`.
Published as [issue #824](https://github.com/xnmp/tauri-explorer/issues/824),
branch `test/ntfs-short-name-identity`, and draft
[PR #826](https://github.com/xnmp/tauri-explorer/pull/826).
Its only changes are `.github/workflows/rust-platforms.yml` and
`src-tauri/test_support/recovery_file_identity.rs`; their content matches the
reviewed integration patch `0480039f`. The dedicated Windows step verifies
that a real TEMP file is on NTFS, temporarily enables 8.3 generation, requires
a distinct short leaf with the same physical identity, then restores the
original policy. It requires exactly one executed Rust test. Case and hardlink
aliases already passed in #808; this candidate covers the remaining short-name
case. Local Rust formatting, workflow YAML parsing, map coverage (514/514),
and diff checks passed. Hosted [Windows Rust job 108836388520](https://github.com/xnmp/tauri-explorer/actions/runs/36394122928/job/108836388520)
then confirmed its actual TEMP volume is NTFS, enabled 8.3 name creation
(registry state 2 → 0), executed exactly one short-name identity test with
1 passed and 0 ignored, and restored state 2. The Rust test asserts a distinct
short filename and equal physical identity; a skipped alias cannot satisfy it.
The remaining PR checks and `dev` merge are pending.

Proposed issue title: `ntfs-short-name-identity: qualify the Windows 8.3 alias`

Proposed issue body:

> ## Plan
> - Run the existing short-name physical-identity test on a hosted NTFS volume.
> - Check the actual fixture volume, require a distinct 8.3 alias, and restore
>   the runner's prior 8.3 policy even after failure.
> - Retain the Windows Rust job result and executed-test count before accepting
>   W4.5.
>
> ## Screenshots
> - [x] None required — CI test coverage has no user-visible effect.

Proposed branch: `test/ntfs-short-name-identity` (create after its issue opens).

Proposed PR body:

> The Windows identity suite previously covered case and hardlink aliases, but
> a disabled 8.3 policy let the short-name case return without testing an alias.
> This adds a dedicated hosted NTFS run that requires a distinct short filename
> and matching physical identity, then restores the runner policy. Local
> formatting, workflow parsing and code-map checks pass; W4.5 acceptance still
> requires the hosted Windows outcome.
>
> ## Screenshots
> - [x] None required — CI test coverage has no user-visible effect.

## W5.3 — macOS native UI listing and Up navigation

Candidate: `.claude/worktrees/overhaul-w53-publication` at `2f3d27a7`.
Published as [issue #825](https://github.com/xnmp/tauri-explorer/issues/825),
branch `test/macos-native-ui-qualification`, and draft
[PR #827](https://github.com/xnmp/tauri-explorer/pull/827).
Its implementation files match the reviewed integration patch `8cb3cba0`.
The hosted Mac2/XCTest pilot builds the production app, verifies a unique
child-only filename in the native accessibility tree, activates the Up control,
then requires a parent-only filename and the absence of the child name. It
retains both XML snapshots, a screenshot, binary identity, driver versions and
a machine-readable report. Local Svelte/type, native TypeScript, shell syntax,
workflow YAML, code-map (514/514), and diff checks passed. The script also
failed closed on Linux and wrote a report with `passed: false` and the explicit
macOS-only error. Hosted `native-ui` job 108836443808 on macOS ARM64 passed and uploaded
[artifact 10957059159](https://github.com/xnmp/tauri-explorer/actions/runs/36394140182/artifacts/10957059159).
The report records all three outcome booleans as true: child filename visible,
parent filename visible after Up, and child filename absent after navigation.
The initial and final XCTest accessibility XML independently contain the
respective unique filenames. The retained 1024×768 screenshot was visually
checked: it shows the parent directory with the child folder and parent-only
file. The report includes the release-binary SHA-256 and Appium 3.8.0/Mac2
4.2.0 versions. PR #827 still has an unrelated Windows native smoke failure
in the unchanged concurrent-window-transfer test and cannot merge yet.

Proposed issue title: `macos-native-ui-qualification: verify listing and Up`

Proposed issue body:

> ## Plan
> - Build the production WKWebView app on a hosted Mac and launch it through
>   Appium Mac2/XCTest with a unique child-directory fixture.
> - Assert the child listing, activate Up, then assert the parent listing and
>   child-name absence from native accessibility source.
> - Retain source snapshots, screenshot, app hash, driver versions and report;
>   review the actual Mac2 tree before accepting W5.3.
>
> ## Screenshots
> - [x] None required for this test-only change; the hosted outcome itself
>   must retain a native screenshot as evidence.

Proposed branch: `test/macos-native-ui-qualification` (create after its issue opens).

Proposed PR body:

> The existing macOS Rust and startup jobs do not prove that a WKWebView user
> can see a child directory and navigate Up. This adds a hosted Mac2/XCTest
> outcome that checks distinct child and parent filenames in native
> accessibility source, with a screenshot and provenance report. Linux static
> checks and fail-closed behavior pass; W5.3 remains open until the hosted Mac
> run and its retained artifacts are reviewed.
>
> ## Screenshots
> - [x] None required for the test-only PR; its Mac CI artifact must include
>   the native result screenshot.

Both platform pilot outcomes are verified. W4.5 and W5.3 still need green PRs
and merges into `dev` before their plan rows can close.
