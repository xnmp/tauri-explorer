# Architectural review completion ledger — #680

Objective: implement the entire architectural review in `repo-health-review.md`,
including its remaining numbered recommendations and release acceptance matrix.
The earlier 121-file overhaul is the starting point, not the completion criterion.
No row is complete merely because its implementation exists or a mock agrees.

## Native forward ownership checkpoint

Five commands (create directory/file, rename, write new text, symlink) now reserve
native history before filesystem work and settle independently of the invoking
renderer. Explicit pending/reserved positions preserve admission order and
protect retained history capacity. Same-name rename preserves Redo, shared Undo
availability reflects pending participant work, and overlapping partial Redo
retains only its unfinished work. Typed worker uncertainty now reaches both
forward and inverse settlement; it cannot silently become a retryable no-effect
failure. Real filesystem regressions reproduce the classification and ordering
failures before their fixes.

Current focused evidence: 47 Rust history contracts, five forward filesystem
classification cases, 2,286 frontend tests plus 30 performance cases, and 74
Chromium outcomes across all file views. Source-map coverage is 403/403. Normal
startup JavaScript is 665,578 raw / 217,281 gzip bytes (47 gzip bytes above the
last checkpoint), within budget; no startup latency improvement is claimed.
The rebuilt Linux binary passes nine outcomes across four specs: the three new
forward cases plus shared inverse and ordinary/partial file-operation compatibility.
Native history exists before renderer publication, exact same-name rename preserves
Redo, and an accepted child rename completes after native window destruction with
exact bytes and the surviving window listing. Fresh normal builds exclude all
acceptance probes. See [the evidence record](reviews/native-forward-ownership-2026-09-08.json).

The full Rust suite now passes 599 library and nine integration tests (seven
ignored), with controlled Bash and isolated XDG data; all-targets recovery-feature
Clippy is clean. A reproduced crash-report overwrite now uses private staging,
complete no-replace publication and identities retained across consumption.
Five focused crash-report contracts pass, with independent review of the
publication and inverse-uncertainty boundaries. Independent GPT-5.6 Sol review
accepts the native evidence and its scoped lifetime claims.
This is acceptance of the five-command boundary. Remaining native batches,
durable recovery, identity, supported-platform acceptance and actual Mac startup
measurements remain required by the full review.

## Linux shared-history lifetime acceptance

Native acceptance now verifies shared inverse admission and settlement across
real windows. A second window cannot execute an already reserved inverse; both
receive matching passive Redo summaries after completion, and a stale entry ID
cannot execute again. Destroying the initiating native window after acceptance
does not abandon the inverse: the survivor receives settlement, performs Redo
and renders the actual renamed file. Both cases assert exact bytes and correlate
an external release with the admitted entry ID, direction, token and native PID.

The Linux run passes six outcomes across three specs, including the two new
cases and ordinary create/rename/trash plus partial Delete/Undo/Redo compatibility.
Focused validation passes 33 native history contracts and 21 frontend lifetime
contracts. Svelte, architecture and all-targets recovery-feature Clippy pass;
source maps cover 400/400 files. Independent GPT-5.6 Sol review accepts the
scoped native evidence and its stated limits.
Fresh normal frontend/native builds exclude the probes; startup JavaScript remains
665,401 raw bytes / 217,234 gzip bytes (two gzip bytes of build variance).
No startup latency improvement is claimed. See
[the acceptance record](reviews/file-history-lifetime-2026-09-08.json).

This closes the Linux native-window inverse-lifetime gate, not the full history
or architectural review. Same-window renderer replacement/crash, forward
mutation/history atomicity, artifact identity, durable transaction recovery,
Windows/macOS and the wider release acceptance matrix remain open.

## Partial-move recovery checkpoint

Cross-device moves now return a committed destination with an explicit recovery
receipt if source cleanup fails, including when cleanup already removed some
children. Paste, drag/drop, transfers, plugins and native history preserve that
effect, refresh the affected parents, report the incomplete operation and avoid
recording an inverse that could delete the last surviving copy. Safe siblings
remain undoable; incomplete cuts conservatively retain their original clipboard
selection. Overwrite copy/move share an exclusively reserved displaced-original
owner whose destructor never deletes user data. Rollback refuses destination
races and reports the retained original path.

This checkpoint passes 2,281 frontend tests plus 30 performance cases (three
skipped), 577 Rust library tests plus nine integration tests (seven ignored),
and 74 Chromium outcomes across all three file views. Svelte, architecture and all-targets recovery-feature Clippy checks are clean;
source maps cover 399/399 files. A freshly rebuilt Linux binary passes six outcomes across four
specs, including real cross-filesystem source-cleanup failure with exact bytes
at both locations, a visible incomplete-paste message and rejected unsafe Undo.
Native acceptance first exposed read-only staged-directory publication failure;
a failing-before Rust regression now verifies publication and exact final mode,
and the corrected native case passes. See
[the checkpoint evidence](reviews/file-move-recovery-checkpoint-2026-09-08.json)
and [the native screenshot](../screenshots/refactor/repo-health-cleanup/partial-move-recovery.png).

Startup JavaScript is 217,236 gzip bytes, 383 above the preceding checkpoint.
No startup latency improvement is claimed. Durable transaction journals and
startup reconciliation, staging/source identity, indeterminate network-filesystem
outcomes, complete overwrite Undo, atomic forward/history recording and native
multiwindow/platform acceptance remain open. Parking sources before copying is
deferred until durable recovery can land with it: otherwise a crash can hide the
only source before any destination exists. Independent GPT-5.6 Sol review accepts the scoped guarantees and evidence with
these limits. This is a verified recovery boundary, not completion of the
comprehensive review.

## Preceding exclusive publication checkpoint

Ordinary copies and new text writes now build their complete payload in an
exclusively created destination-local staging directory. Shared native
no-replace rename protects the final destination for ordinary publication,
move, rename and Linux trash restore; recursive copy no longer truncates
existing files, merges existing directories or follows destination symlinks.
Four real-filesystem regression cases failed before this change and pass after
it. The complete Rust suite passes 566 library and nine integration tests
(seven ignored), including eight new staging/publication contracts and five
collision regressions. No frontend or startup payload change is involved;
no performance improvement is claimed.

All-targets Clippy is clean and source maps cover 398/398 files. A freshly
rebuilt Linux binary passes five native outcomes across ordinary create/rename/
trash, delayed create across navigation with a causal watcher update, and
partial Delete/Undo/Redo. These are compatibility checks; injected construction
failure and destination races are verified through actual Rust filesystem
tests. They do not verify cross-device cleanup recovery or native multiwindow
history ownership.
See [the publication checkpoint evidence](reviews/file-publication-checkpoint-2026-09-08.json).

This is a transaction prerequisite. Case-only renames retain the old platform
branch. Overwrite displacement, partial cross-device source cleanup, NFS
indeterminate publication, external staging-namespace replacement, artifact
identity and combined native forward/history admission remain open. Independent
review confirms ordinary destination protection and specifically identifies
the path-based staging ownership limit. Platform API inspection does not replace
Windows/macOS runtime acceptance. See ADR 0018 for the continuation.

## In-progress native history and mutation receipts

The current working tree moves shared file history into the native process and
uses `{ path, entry }` mutation receipts, where the committed path remains valid
as an operation result when presentation metadata is unavailable. See proposed
[ADR 0018](adr/0018-native-file-history.md). The old TypeScript executor now lives
only in the browser fixture backend.

Current integration checks pass 2,275 frontend cases plus 30 performance cases
(three skipped), 553 Rust library cases plus nine integration cases (seven
ignored), and 75 Chromium outcomes across the three file views. Svelte reports
zero errors/warnings; default and recovery-feature Clippy are clean; source maps
cover 397/397 files. A deterministic metadata-inspection regression fails before
the change and passes afterward. Startup JavaScript is 216,853 gzip bytes,
139 above the preceding checkpoint; no startup latency improvement is claimed.
The rebuilt Linux binary passes five outcomes across three specs: ordinary
create/rename/trash, delayed create across navigation with a causal watcher
update, and partial delete followed by Undo/Redo/Undo. These verify native
compatibility; metadata-failure injection is covered at the Rust receipt seam.
See [the checkpoint evidence](reviews/native-file-history-checkpoint-2026-09-08.json).

This work is not accepted as a complete file-history implementation. Remaining
boundaries include cross-device cleanup, partial writes/copy cleanup, overwrite
rollback and displaced-artifact recovery, native artifact identity, atomic
forward mutation/history admission, cross-window execution and renderer-loss
acceptance, and supported-platform verification. The proposed ADR records the
exact limits. The requirement table below continues to define the full goal.

## Preceding committed checkpoint

Checkpoint cfef0dc0 (2026-09-08): bulk trash and restore publish confirmed
per-path outcomes. Partial undo/redo retains only unfinished work, publishes
completed effects, and reserves an exact renderer-local history entry across
concurrent calls, new pushes and explicit clears. Linux restore atomically
refuses collisions and distinguishes successful payload moves from metadata
cleanup. Mixed local/network deletion preserves local trash recovery. Rename
teardown no longer reads a destroyed component-owned derivation.

Frontend tests pass 2,267 cases plus 30 performance cases (three skipped).
Chromium passes 84 targeted file-operation, delete/restore, clipboard, drag/undo,
Miller-column and rename outcomes. Rust passes 517 library tests and nine
integration tests (seven ignored); Clippy is clean. Linux native acceptance
passes five outcomes across three specs, including real partial delete followed
by Undo/Redo/Undo with exact file contents and listing assertions.
Startup JavaScript is 216,714 gzip bytes, 631 above the prior checkpoint;
this is not a startup speedup claim. See
[the acceptance artifact](reviews/file-outcome-acceptance-2026-09-08.json).

Cross-window inverse admission, Windows shell restore completion, action-level
recovery capabilities for UNC copies/macOS, broader platform/product/soak
acceptance and actual Mac half-bounce measurements remain open. The comprehensive
review is **not complete**.

The branch has unpublished local commits after the published draft PR #684 tip
`2c2a8121`. Publication is waiting for explicit approval of the public destination
and payload after automatic approval review rejected prior pushes. No merge or
release acceptance is implied. The current table and newest sections describe
current scope; earlier checkpoint sections retain their historical counts and
limitations and must not be read as current status.

| Requirement | Required implementation and evidence | Current state |
| --- | --- | --- |
| Existing ownership overhaul | Retain pane/SCM/watch/drive/preview/terminal/contribution lifetimes, cache invalidation and persistence fixes; rerun appropriate suites after integration | Previous passing evidence recorded in review; integration acceptance pending |
| 1. Startup performance | Release Mac half-bounce recording, first presented frame and successful input, >=30 samples/scenario with p50/p95; cold, warm-cache, warm-window and restored optional surfaces; actionable profile-driven improvements | Instrumentation and payload budgets implemented; actual Mac measurements outstanding |
| 2. External jobs | Cancellation/timeout must stop local work and prevent late final-output publication; real worker/process/filesystem tests; adversarial verification | Worker draining, held staging files, serialized cancel/publication, bounded fal requests, and Nano child kill/reap implemented; 11 targeted Rust tests and independent review pass. Full integration pending; network calls can take up to their 30-second bound |
| 3. Long-session retention | Measure and bound refresh history/timers, validate config watch retention against ADR 0004, workspace/plugin churn and heap/load suite | Refresh inactive metadata capped at 1,024; 5,000-key regression. Config retarget registrations bounded after successful reconciliation; 9 Rust tests including actual Linux symlink handover, independently confirmed. Window-owned accepted plugin jobs independently confirmed; 5,000-job churn verifies exactly-once effects. Registry reentrancy fixes now cover teardown/retry/shutdown with four failing-before regressions and 5,001 mixed-plugin activation cycles through real contribution stores. Seven bounded browser load cases now pass without retries; 150-cycle graph tab/toggle heap deltas are +4.5/+2.2 MiB and 150 workspace replacement pairs are +3.45 MiB, with intermediate DOM/listener samples and independent evidence review. Native-window Git ownership/reclamation now has Rust interleaving and Linux binary acceptance; renderer reload reclamation now has generation-checked IPC, Rust contracts and two-cycle Linux binary acceptance; blank-renderer cleanup now has native termination hooks and Linux reclamation evidence; two-cycle same-process Linux crash recovery now passes with controlled reload; directory observations now share renderer ownership with exact Linux destruction/reload/crash reclamation, real cache-retirement contracts, canceled-reply cleanup and backend retries after failed final release; directory observation now recovers native faults and replaced roots with Linux UI acceptance and injected recursive-failure contracts; other-platform recovery, hours-long/native soak, native plugin combinations and broader native retention acceptance remain outstanding |
| 4. Orchestration | Extract coherent startup and graph state/policy owners; lifecycle behavior tests; preserve immediate core readiness and lazy features | Window settings/theme/plugin startup owner extracted; late settings teardown covered. Independent review exposed registry disposal missing active/in-flight contexts; fixed with terminal admission closure and shared disposal promise, independently confirmed. Inactive restored panes load on first activation (64-tab production regression failed before, passes after; independently confirmed). Graph history/pagination, PR/check/log and branch-metadata owners are extracted; request identity, immutable cache ingress and resolved branch walks have behavioral regression coverage and independent review. Commit-detail/inline-diff owner also implemented with mutation-time selection tokens and stage-side identity; 15 focused tests, Chromium/WebKit outcomes and native real-Git diff regression pass. Page dialog loading/rendering now lives in a typed WindowDialogs host with per-dialog demand and owned imports; cancelled/retired publication, real Svelte teardown, portal feedback and feature outcomes pass. Window keyboard routing now has pure policy, exact terminal command identity and owned modifier/chord subscriptions. Terminal focus requests survive lazy loading only while their originating interaction remains current. Page-session subscriptions and delayed work now have explicit teardown/rollback; pure launch policy preserves immediate navigation, and automatic warming follows configured core readiness. Domain/session/probe contracts and browser/native acceptance pass; ADR 0010 defines borrowed window-store versus page ownership |
| 5. API dependencies | Feature-owned wrappers replace files.ts aggregation and dispatch cycles; architecture guardrail; caller tests and unchanged typed IPC contracts | Feature owners migrated across production, tests, benches and E2E; files.ts now filesystem-only, sibling wrappers import common primitives. Contract guardrail, independent API review and architecture lint pass. Plugins access accepted work through PluginContext.jobs |
| 6. Input boundaries | Normalize directory/tab/window launch/warm/transfer seeds before live state or allocation; validate finite and consumer-compatible setting bounds; malformed/oversized/legacy cases | Shared seed validation and serialization/parse budgets, finite geometry, closed snapshot validation, acknowledged native handoff implemented with regression tests. Lazy restoration bounds initial inactive-directory fanout. Numeric consumer audit now has a shared domain rule set, strict direct/config validation and finite setter coercion; malformed fractions, sentinel gaps, and the 4-column command are fixed, with unit/browser outcomes and independent review. Window launch/transfer ownership now has unit, browser and real three-window acceptance (details below). Large active layouts now materialize the focused pane immediately and defer remaining panes in cancellable batches; current browser/native acceptance is recorded below. Missing, destroyed, hidden warm and real picker targets now have Linux binary source-retention acceptance. Destination closure during real handoff receipt, unready native targets with later app initialization, and duplicate-label asynchronous creation failure now pass Linux binary acceptance; Windows/Mac equivalents remain open |
| 7. Native identity | Verify equivalent separator/case/trailing-slash paths against real native watches; retain case-sensitive Linux/WSL semantics and native IPC arguments | Windows acceptance outstanding; shared owner already implemented |
| 8. Interaction consistency | Audit transition-all, semantic colors, address focus commands, theme controls; immediate pointer feedback, browser/native outcome coverage | 27 transition-all rules removed, 13 inactive aliases repaired, DnD uses semantic tokens. Ctrl+L targets active pane and respects hidden address bars/terminal ownership. Focused unit and Chromium address/theme/hover outcomes pass (all three file views). Independent review confirmed focus/transition contracts and exposed a white child-text override on bright accents; corrected to inherit on-accent color with a regression. Native maximize/restore and pointer-captured divider outcomes now pass, with stale-gesture and late-listener regressions and independent review. Graph detail expansion has a reproduced/fixed WebKit scrollbar feedback loop. The following checkpoint aligns the full graph header and metadata table, preserves complete reference access and restores native/custom button keyboard ownership in focused Chromium/WebKit, unit and integrated browser acceptance. File-list cursor/selection separation, off-screen Tab recovery and keyboard inline-editor return now have 111 Chromium outcomes and four Linux native outcomes, with backward native traversal limited by driver delivery. The wider theme/native interaction matrix remains pending |
| Platform release acceptance | Windows ConPTY, macOS PTY, config replacement/autoreload, watcher soak; native suites on supported platforms | Linux baseline passes; Windows/Mac outstanding |
| Product acceptance | Built-in themes, accessibility/keyboard behavior, narrow splits, view modes, DPI/zoom, preview formats and plugin failure combinations | Dense split viewport policy implemented with all three views, zoomed pointer/keyboard resizing, saved-layout preservation and Chromium/WebKit acceptance; Linux window/transfer regressions pass. Inline SCM/Miller minimum contributions, hoist/unmount shrink and continuous zoomed resizing now pass targeted browser/native acceptance. The focused resize migration is implemented; the wider themes/accessibility/platform matrix remains outstanding |
| Final integration | Typecheck, architecture lint, source maps, unit/perf/Rust/native/browser/load acceptance, screenshots, updated ADRs/report and issue; independent falsification of structural/performance claims | Outstanding |

Every completion update must name the actual production seam, regression or
measurement, result and limitations. Platform gates stay open until directly
verified; scaffolding a runner does not satisfy the gate. Additional defects
found while implementing a row belong to the same objective.

## Historical checkpoints

Earlier measurements, investigations and handovers are preserved in the
[checkpoint archive](reviews/architecture-review-history-2026-09-08.md).
They are historical evidence and do not supersede this ledger’s current gates.
