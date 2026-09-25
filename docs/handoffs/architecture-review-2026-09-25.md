# Architectural review continuation — 2026-09-25

## Read this first

The user's latest instruction was **“please commit WIP then write a comprehensive handover document for another agent to continue the goal.”** This checkpoint fulfills that instruction, not the overall architectural goal. No PR was merged and no release was cut during this checkpoint. Do not declare the review complete.

The immediate next implementation is **[#739 permanent-delete identity](https://github.com/xnmp/tauri-explorer/issues/739)**. Its current checkpoint is **deliberately red and not merge-ready**. Six of the original seven remaining issues have published implementations; integration, review, native acceptance and platform qualification remain distinct gates.

The user wants a sleek, minimal, customizable cross-platform file explorer with a maintainable, composable architecture and excellent performance. Ghostty-like startup is the aspiration. **No Mac is available; the user explicitly requested startup testing on this Arch machine.** Do not keep asking for a Mac or call the Linux measurements Mac half-bounce acceptance. Earlier instructions froze scope: finish the current release-critical architectural work and file further expansion as GitHub issues. Do not reopen an unbounded audit or begin a renderer rewrite.

The user previously authorized publishing, merging and releasing, but this turn requests a handoff. Respect review/CI gates; do not merge this red checkpoint. The user also asked to disable an old autonomous harness service. **Do not restart or re-enable it.** This checkpoint used ordinary Git and test commands, not that service.

## Durable workspace and checkpoint

- Repository: `/home/chong/Repos/tauri-explorer`.
- Active continuation worktree: `/home/chong/Repos/tauri-explorer/.claude/worktrees/permanent-739`.
- Branch: `fix/permanent-delete-identity`.
- WIP commit: **`b68b12cb`**, `wip: reproduce permanent-delete namespace replacement (#739)`.
- Its parent: **`5f968137`**, the native rename-inverse admission implementation (PR #751).
- Fetched `origin/dev` and root checkout `dev`: **`9ca896d5fcf50b40974dde499e4e703b33210538`**.
- Verified `git merge-base HEAD origin/dev` equals that dev tip before reconstruction.
- Root checkout user changes were preserved: modified `AGENTS.md`; untracked `docs/AI-native-ideas.md`, `docs/gotcha-study/`, `screenshots/_issue-refs/`. Do not stage these.

**Temporary storage loss:** the September 23 `/tmp` worktrees, logs, local harnesses and uncommitted #739 files were gone at re-entry on September 25. Published commits and Git branch refs survived. The stale #739 worktree index contained no staged changes. Only that stale registration was removed, then the branch was checked out at the persistent path above. Other stale registrations were left alone. Do not run a blanket prune or assume their indices are useless.

The small #739 extraction and two tests were reconstructed from conversation context, then rerun successfully as a *reproduction of failure*. No missing fix was invented. Committed performance evidence, including embedded runner source, survives in the published branches. Old `/tmp` paths in those documents are historical, not currently usable. The shared Cargo target survived, but its current binary must not be assumed to match any previous benchmark build.

Use the explicit author `xnmp <chonw89@gmail.com>` for commits. Git currently reports a stale hooks path, `/home/claudeuser/tauri-explorer/.git/hooks`; it was not changed or bypassed. The current user-supplied AGENTS instructions govern this task; old branch-local Beads instructions are not a reason to abandon GitHub tracking.

## Exact state of #739

`b68b12cb` contains seven files: a behavior-preserving extraction in `src-tauri/src/files/permanent_delete.rs`, delegation from `file_ops::delete_native_path`, module registration, two tests under `src-tauri/test_support/permanent_delete.rs`, both code-map updates, and [fresh raw test output](permanent-delete-739-red-2026-09-25.txt).

`Prepared::capture` retains the native path and `symlink_metadata`. `Prepared::execute` still calls `remove_entry_at` by pathname. **It does not verify identity or anchor execution to the observed parent.** There is no quarantine, no new admission integration and no new platform adapter. The tests use real temporary files and the actual executor:

1. Observe a file, rename it aside, create unrelated bytes at the original name, execute deletion.
2. Observe a file, rename its parent aside, recreate that parent and an unrelated file at the original path, execute deletion.

Both tests fail at the assertion that the replacement bytes remain: actual `None`, expected `Some(unrelated replacement)`. They are not ignored. The suite exits **101**, with **0 passed / 2 failed / 1,314 filtered out**. Later assertions about retained originals and error results are not reached; do not cite them as passing evidence. Compilation succeeded in 36.68 seconds.

Reproduction from this worktree:

```sh
CARGO_TARGET_DIR=/home/chong/Repos/tauri-explorer/src-tauri/target \
  cargo test --manifest-path src-tauri/Cargo.toml --lib permanent_delete::tests -- --nocapture
```

`cargo fmt --manifest-path src-tauri/Cargo.toml --all`, `git diff --check`, and code-map validation passed; coverage was **502/502** source files. No full suite was run for this intentionally red checkpoint. These two tests do not cover the final check-to-rename race or platform parity; those are implementation acceptance work.

## #739: reviewed design and limits — not implemented

A previous independent GPT-5.6 Sol reviewer examined the current deletion hole and proposed design twice. The following preserves that design review, **not acceptance of code that does not exist**. Obtain a fresh adversarial review of the implementation.

### What is actually wrong

`file_ops::delete_native_path` observes metadata and subsequently resolves/removes a pathname again. Linux's permanent branch of `trash::run_admitted_batch` retains resolved paths through the worker, but managed resource admission only excludes cooperating Explorer mutations. Another process can replace a selected leaf or ancestor.

Existing destructive errors already become `AppError::MutationUncertain`; preserve that classification. `remove_entry_at` and Rust's supported `remove_dir_all` implementation already protect normal symlink-leaf traversal. Do not claim that `std::fs::remove_dir_all` has no symlink TOCTOU protection.

Unix `unlinkat` has no expected-inode condition. A metadata recheck immediately before unlink, or `openat2` alone, does not close the final leaf replacement race. Relevant references from the prior investigation: [unlink(2)](https://man7.org/linux/man-pages/man2/unlink.2.html), [rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html), [Rust remove_dir_all](https://doc.rust-lang.org/std/fs/fn.remove_dir_all.html).

### Intended operation boundary

1. Prepare inside the existing revision-fenced `Runtime::admit_prepared`. Capture the exact native physical parent path, parent identity, selected `EntryVersion`, and planned sibling quarantine path. Preserve requested receipt spelling separately. Do not recanonicalize the requested alias later in the worker.
2. Plan a fresh, private, same-filesystem sibling directory with a bounded collision-resistant `.tauri-delete-...` name. Claim it as Write/Subtree along with the selected source and alias dependencies. Reuse `resources::SelectionIndex`; reject incompatible physical aliases/ancestor selections. Hardlinked leaves retain distinct namespace semantics.
3. Open and verify the parent without following substituted links. Create the quarantine directory exclusively, with restrictive permissions (0700 on Unix), verify its type/owner, and never reuse or repair a pre-existing container.
4. Atomically rename the source into quarantine with **no replacement**, using retained directory handles. Verify the captured leaf's identity/version **after the move and before irreversible recursion**.
5. On mismatch, restore using a no-replace rename between retained handles. If the source name is occupied, preserve both objects, report the exact residue, classify uncertainty and leave the batch suffix unstarted.
6. Recursion must be no-follow and handle-relative throughout; opened child directories must match observed identity. Bound depth/stack/descriptors; do not retain an fd for every entry. Symlinks, dangling links and special files are leaf unlinks.
7. Never put destructive cleanup in `Drop`. Panic, cancellation or renderer loss must not silently remove a captured payload.

Outcome phases matter:

| Phase/result | Required settlement |
| --- | --- |
| Failure before capture; owned empty container removed | No payload effect; report the original failure |
| Failure before capture; empty cleanup also fails | Surface the owned residue; do not claim clean no-effect |
| Captured payload, partial recursion, or incomplete mismatch rollback | Uncertain with exact retained residue; stop suffix |
| Mismatch fully restored and container cleanup confirmed | Report failed/no destructive effect using the existing ledger policy |
| Payload fully deleted; empty-container cleanup or sync fails | Confirmed success **with warning**; allow suffix to continue |

The current `Result<(), AppError>` may need an internal structured completion/warning receipt propagated into existing batch `TrashSuccess.warning` (legacy naming). Do not turn a fully completed deletion into an uncertain failure merely because an empty container could not be removed.

There is no cross-filesystem copy/delete fallback. Failed rename preserves data. Crash after capture may leave hidden sibling residue. The reviewer accepted that within #739 without introducing another permanent-delete journal: accepted deletion is already nontransactional. Do not automatically restore/delete residue after restart without durable identity evidence; a recognizable name alone proves nothing.

This design protects against substitution of the requested source/ancestor namespace before atomic capture. It does **not** prove immunity to a hostile same-UID process manipulating private staging, inode reuse, or provenance of every recursively discovered descendant. State the actual guarantee. Benchmark representative bulk deletion because per-item mkdir/rename/rmdir adds cost; do not share containers prematurely without modeling partial settlement and ownership.

Windows handle disposition and Unix quarantine have different guarantees. Do not silently retain stat/unlink fallbacks and advertise parity. Native macOS/Windows substitution evidence is required before claiming it. No native adapter for this fix has been implemented yet.

### Existing seams to reuse

- `files/native_directory.rs`: retained `Directory { file: File }`; Unix no-follow open/walk, `stat`, no-replace `rename_to` (Linux `renameat2`, macOS `renameatx_np`), `unlink`, streaming entries, bounded names, 0700 `create_directory`, metadata. Linux also exposes path/mount identity.
- `file_identity::{of_file, version_at, version_from_metadata}` and `entry_version::EntryVersion`: object identity, size, mtime, kind and Unix mode/uid/gid; intentionally excludes ctime to survive rename. This is not a content hash or recursive snapshot.
- Windows native-directory code already has relative handle operations, reparse controls and handle rename/disposition. **Production gating is incomplete:** `native_directory`/`file_identity` are currently `cfg(any(unix, test))`, and `windows_io` is Windows-test-only. Do not enable all test infrastructure blindly. Windows `names(maximum)` currently buffers the listing. Unix O_RDONLY directory handles also warrant tests for searchable/writable but unreadable parents.
- `recovery/resources.rs`: `capture_requests` preserves primary request order before alias dependencies; path/identity capture must agree with prepared effects. `SelectionIndex` implements Source/Exclusive/Shared/Container roles and bounded claims.
- Batch planning already bounds input (32,768 paths / 8 MiB), rejects roots, parent traversal and lexical ancestor overlap. Native aliases still require checking.
- `Runtime::admit_prepared`, `trash::run_prepared`, `batch::run_with_receipts_owned`: retain admission through actual worker and captured-object lifetime. Ordered `Receipts` live outside the worker stack and conservatively settle active slots after unwinding.
- `DirectoryEffects` preserves requested/physical reconciliation directories; `file_mutation::delete_effect` ensures permanent successes offer no Undo. Linux admission and other platform dispatch paths differ.
- Existing real-filesystem tests in `test_support/file_batch_outcomes.rs` include `owned_permanent_deletion_preserves_native_alias_binding_and_receipt_spelling` and `batch_waiter_loss_cannot_release_admission_while_the_worker_can_delete`.

An injectable private native-operation seam, similar to freedesktop trash's tests, can deterministically replace entries immediately before the real rename/unlink. Prefer that over sleeps/global switches. Keep source-included Rust tests under `test_support/`, not Cargo's auto-discovered `tests/`. No new renderer state or public IPC is needed solely for testing.

### Required acceptance matrix

- Existing leaf and parent replacement repros become green; add substitution in the **last precheck-to-atomic-move seam** so a stat-only pseudo-fix cannot pass.
- Mismatch rollback preserves original and replacement bytes/IDs; occupied restore destination remains untouched and produces exact uncertain residue.
- File/directory/dangling symlinks preserve targets; native non-UTF leaves and parents, hardlinks and requested alias receipt spelling remain correct.
- Container collision is refused before effects; rename failure plus successful/failed empty cleanup is classified correctly.
- Inject partial recursion after at least one actual unlink: uncertain residue, no suffix execution.
- Payload fully deleted plus cleanup failure: succeeded warning, suffix continues.
- Panic, waiter/renderer loss and captured-resource destruction retain admission until the worker settles; no destructive Drop cleanup.
- Deep/wide trees bound stack, memory and descriptors; cover mount and permission errors.
- Managed claims cover source, container and aliases; reject physical duplicate/conflicting selections.
- Native UI deletion removes only confirmed selected rows and offers no false Undo; include a corrected-behavior screenshot and filesystem identity evidence.
- Separate Windows/macOS native qualification before parity claims; independent reviewer should try to falsify each safety claim.

## Published PRs and integration dependencies

Fresh GitHub snapshot: [pr-status-2026-09-25.json](pr-status-2026-09-25.json). All PRs below were **OPEN**. All except #753 reported `REVIEW_REQUIRED`. “Checks” means checks returned for the current head, not a guarantee all future integration requirements have run.

| Issue / PR | Branch and head | Base | Current checks |
| --- | --- | --- | --- |
| #696 / [#738](https://github.com/xnmp/tauri-explorer/pull/738) | `fix/macos-cold-startup` `04258e40` | dev | 14 successful |
| #735 / [#741](https://github.com/xnmp/tauri-explorer/pull/741) | `refactor/deletion-trash-admission` `a2890ddb` | dev | 11 successful; Windows native smoke failed |
| #736 / [#744](https://github.com/xnmp/tauri-explorer/pull/744) | `feat/durable-move-retirement` `e0b3d751` | dev | 14 successful |
| #742 / [#746](https://github.com/xnmp/tauri-explorer/pull/746) | `fix/cold-recovery-admission` `62659783` | dev | 12 successful |
| #737 / [#747](https://github.com/xnmp/tauri-explorer/pull/747) | `fix/large-directory-main-thread` `b94ae493` | dev | 14 successful |
| #740 / [#750](https://github.com/xnmp/tauri-explorer/pull/750) | `refactor/inverse-trash-admission` `fe478fa3` | dev | 12 successful |
| #749 / [#751](https://github.com/xnmp/tauri-explorer/pull/751) | `fix/inverse-rename-admission` `5f968137` | dev | 11 successful; Ubuntu native smoke failed |
| #745 / [#752](https://github.com/xnmp/tauri-explorer/pull/752) | `test/window-chrome-cleanup` `41648508` | dev | 12 successful, including native platform checks |
| #748 / [#753](https://github.com/xnmp/tauri-explorer/pull/753) | `fix/listing-delivery-frame-gap` `7ff4f089` | fix/large-directory-main-thread | **Only 2 performance checks**, both successful |

The source stacks are:

```text
dev -> #738 startup -> #747 immutable listing -> #753 compact transport
dev -> #741 deletion admission -> #750 trash inverses -> #751 rename inverses -> #739 WIP
dev -> #746 cold initializer admission
dev -> #744 durable move retirement
dev -> #752 Windows fixture cleanup
```

Source ancestry and PR base are different: several stacked PRs still target dev. Recheck merge-bases against the actual remote tip before integration. After squash merges, transplant only the remaining dependent changes; avoid duplicate patches or accidentally dropping dependency work. Retarget #753 and require the full dev CI/review gates. Integrate the initializer and fixture lifecycle fixes before relying on fresh native acceptance of affected branches. Do not mark every stack “ready” from the table.

### Known failing gates

**#741 Windows:** prior failure was fixture removal `EBUSY` after the feature assertion succeeded. #752 moves fixture ownership to the existing native cleanup root and defers removal until actual app shutdown (`afterSession`/launcher completion). Errors remain fatal. It has 16 unit contracts, native TypeScript validation, independent review, and now successful Windows CI. The exact process retaining the original handle was not proven; do not invent that attribution.

**#751 Linux:** run `35848350837`, job `107139838784`, failed three spec files/four tests. Hostile-filename rename/trash, ordinary creation and watcher-probe writes all encountered **“Recovery evidence must be a private, singly linked regular file.”** Filename listing itself was correct. The common failure is recovery admission, not established escaping or watcher behavior.

This branch lacks #746 (`62659783`). Integrating that initializer fix is a plausible resolution, **not a proven diagnosis of the exact inode**. Rerun native CI after integration. If it persists, instrument evidence role, file type, uid, mode and nlink for `admission.lock`, `recovery.sqlite3`, `catalog/*`, and `locks/*`. The old `/tmp/rename-749-linux-ci.log` is lost; retrieve the GitHub job log again. Do not delete or repair the recovery root in fixtures to hide the intentional fail-closed condition.

## What has already been implemented

These are historical qualification results from committed evidence, not tests rerun on the September 25 WIP.

- **#696 startup:** complete snapshot publication replaces paced streaming while preserving observation handoff and latest-request semantics. Arch release measurements are committed; normal Mac Dock launch and half-bounce remain unverified. Evidence: `fix/macos-cold-startup:docs/reviews/arch-startup-822f8751.md/.json`.
- **#737 main thread:** immutable/raw Svelte listing revisions avoid deep proxy traversal. A separate 20-pair run measured small-directory startup 373.2→367.4 ms and 100k-directory startup 837.4→625.5 ms. Details-view nine-pair median frame gap 462→155 ms, completion 650→344 ms, Ctrl+End 156→103 ms; filtering/sorting about 199–215→18–19 ms. Earlier mislabeled view runs were rejected; final explicit all-view outcomes passed. Evidence: `fix/large-directory-main-thread:docs/reviews/arch-listing-737.md/.json`.
- **#748 transport:** borrowed Rust column serialization, optional uniform-column omission, exact common-path reconstruction or full paths. A validating API-boundary decoder restores ordinary immutable entries. Raw acquired observation is retained before decode so malformed transport can release its lease. Shared authored Rust/TS fixtures exercise actual native serialization. Historical checks: 2,506 unit tests passed/3 skipped, 29 performance tests, 1,270 active Rust tests/21 ignored, strict all-target Clippy, Svelte 0/0 and maps 502/502. Three sandbox-related Rust failures passed with the necessary permissions. Independent source/evidence review led to a fractional-size validation fix.
- **#735 admission:** prepared deletion/trash effects bind native paths and whole-intent managed resource claims. External permanent-delete substitution remains #739; managed admission alone does not solve it.
- **#736 retirement:** verified two-root artifact cleanup, journaled retirement and rename capability qualification. Evidence: `feat/durable-move-retirement:docs/reviews/move-retirement-native-2026-09-23.md/.json`. Supported-platform durable recovery qualification/default enablement remains separate work.
- **#742 cold initialization:** admission gate between independent recovery Coordinator initializers. Published and CI-green; not yet integrated into #751.
- **#740 inverses:** shared prepared Linux admission for Trash Redo, Copy Undo and exact restore, including parent creation, metadata/artifact and alias claims. Historical 1,281 Rust tests passed/22 ignored, strict Clippy, 10 native Arch cases and independent review. Evidence: `refactor/inverse-trash-admission:docs/reviews/inverse-trash-admission-2026-09-23.md/.json`. Native Windows/macOS guarantees are not established merely by ordinary CI.
- **#749 rename inverses:** shared `entry_execution.rs` admission/resolve/worker/finish boundary; physical native opposite paths; unrepresentable non-UTF receipt paths warn without minting lossy Undo. Incoherent captured parents/leaves fail before effects. Historical 1,291 Rust tests passed/22 ignored, both durable features, strict all-target/all-feature Clippy, seven Arch native cases in two specs and independent review. Evidence: `fix/inverse-rename-admission:docs/reviews/rename-admission-2026-09-23.md/.json`, ADR 0024. See unresolved CI gate above.
- **#745 fixtures:** cleanup ownership fixed and published as described above. This is test infrastructure, not a claim to have fixed an app filesystem lock.

### Latest performance evidence and its limits

The best retained comparison is #748, **against the already optimized #747 baseline**. Twenty measured launches per cell plus two excluded warmups, alternating AB/BA; nearest-rank percentiles:

| Directory | Baseline p50 / p95 | Compact transport p50 / p95 |
| --- | --- | --- |
| 100 files | 370.4 / 380.6 ms | 371.1 / 384.3 ms |
| 100,000 files | 653.1 / 705.8 ms | 594.5 / 616.5 ms |

Large-directory p50 improved about 9%; small startup was essentially unchanged. Conventional even-sample medians differ slightly (655.133→597.079 ms, 8.9%); don't mix percentile definitions or compound gains across unrelated runs.

One native baseline/candidate pair per view showed complete-count times Details 355→247 ms, List 351→250 ms, Tiles 350→266 ms; maximum rAF gaps 163→94, 174→97 and 155→113 ms. All six sessions passed exact 100k count, final-row selection/visibility, typed navigation away during load, and real external create/remove watcher outcomes. This establishes outcomes and direction, not a latency distribution. Keyboard round trips were 104→126, 103→78 and 124→72 ms: no consistent pure keystroke-latency claim.

Environment: Arch, Ryzen 9 5900X, release production features, fresh processes, warm uncontrolled OS caches, Xvfb/Openbox with software-rendering warnings. Session builds/tests stopped during measurement; background desktop load uncontrolled. Endpoint: native receipt after settings, command registration, complete listing and two frame opportunities. **Not screen presentation, first real input, normal Wayland launch, cold-disk startup, Mac half-bounce or Ghostty-level qualification.** Roughly 100 ms frame gaps remain.

Summed peak RSS was approximately 1.01–1.02 GB versus 1.08–1.11 GB; shared mappings were double-counted and sampling was every 25 ms. Baseline diagnostic response was 20,200,168 ASCII characters; body materialization 76/76/78 ms, explicit parse 35/34/36 ms, original `Response.json` wrapper 110/109/116 ms. These timings include scheduling/possible GC; they are not an exact GC/native CPU profile. Final binaries contained no diagnostic probes.

The committed `fix/listing-delivery-frame-gap:docs/reviews/arch-listing-748.json` retains **all 88 startup samples**, native/diagnostic reports, hashes, instrumentation patch, embedded runner source and rejected-run explanations. Screenshots: `screenshots/fix/listing-delivery-frame-gap/`. Recover harnesses from that JSON instead of assuming `/tmp` survives. A baseline watcher assertion using WebDriver `getText` was rejected because it returned the icon label; corrected checks retained DOM filename, displayed row, screenshot and removal outcomes without an application workaround.

Read evidence without switching the root checkout:

```sh
git show fix/listing-delivery-frame-gap:docs/reviews/arch-listing-748.md
git show fix/listing-delivery-frame-gap:docs/reviews/arch-listing-748.json
git ls-tree -r --name-only feat/durable-move-retirement docs/reviews
```

## Remaining work and re-entry sequence

The original seven issues are **#696, #735, #736, #737, #739, #740, #742**, all still open at this checkpoint. #739 has only a repro; the others have implementations awaiting integration/remaining qualification. Follow-ups #748, #749 and #745 are published. **[#743 recovery-context teardown timeout](https://github.com/xnmp/tauri-explorer/issues/743)** remains open and needs bounded reproduction plus correction or justified qualification. Older native flakes #709/#710/#715 are separate; don't silently conflate them with current failures. Broad platform recovery enablement is not finished.

1. Read this document and the current user-provided AGENTS instructions. Fetch current remote state, check root/worktree status and ancestry. Do not resume old `.claude/worktrees/issue-*` checkouts merely because their names resemble the current issues; some are stale implementations.
2. Reproduce #739's two red tests, inspect the current domain/admission/native-directory seams, and turn the reviewed plan into the smallest sound implementation. Keep Linux/Windows/macOS guarantees explicit. Preserve the ledger, native paths, alias claims and worker lifetime.
3. Add the deterministic final-seam and phase-outcome matrix. Obtain an independent adversarial reviewer for the safety claims, using GPT-5.6 Sol for bounded review work. Own shared seams centrally; don't fan out conflicting implementation agents.
4. Verify integration of #746 and #752 before diagnosing repeated downstream CI failures. Respect the dependency stacks and full review/native CI requirements. Resolve #743 with bounded scope. File further scope as issues instead of expanding this release indefinitely.
5. Perform relevant real-binary acceptance and supported-platform qualification, update lessons/maps/evidence, publish reviewable work. Close issues only after landing on dev. If UI work is merged, run `ALL_VIEW_MODES=1 npx playwright test` before ending that session.
6. Release only after the agreed critical fixes and integration gates are satisfied. Clearly separate implemented, merged, released and platform-qualified status in progress reports.

Testing reminders: browser mocks do not prove filesystem races or native IPC timing. Use Rust temporary-repo/filesystem tests and the small Tauri-binary suite. A runnable release needs `bun run build` then `cargo build --release --features tauri/custom-protocol`; bare Cargo release otherwise serves the dev URL. Native E2E requires the documented `VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle`, tauri-driver and WebKitGTK driver. Read `e2e-tauri/README.md`; communicate with app probes through acknowledged DOM tokens because WebKit execution worlds can differ. Record exact source, features and binary hash for performance claims.

Keep durable worktrees and evidence inside the repository or another persistent location; commit checkpoints early. Do not rerun an accepted large matrix without changed code or a concrete unresolved concern. No local test/build process from this checkpoint remains running after the recorded two-test result. This handoff does not pause or complete the persistent goal.
