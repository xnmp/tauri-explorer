# Architectural review completion ledger — #680

Objective: implement the entire architectural review in `repo-health-review.md`,
including its remaining numbered recommendations and release acceptance matrix.
The earlier 121-file overhaul is the starting point, not the completion criterion.
No row is complete merely because its implementation exists or a mock agrees.

Latest continuation: the native Git observation service below supersedes the
earlier cache checkpoint's open callback-recovery, SCM release and worktree-lock
filtering findings. The comprehensive review and platform/startup gates remain
open.

Git cache observation checkpoint (2026-09-07, continuing locally): the previous
Linux hidden-cache test did **not** prove cached-state invalidation. Its target
snapshot was absent, so reopening fetched fresh history. Requiring a published
snapshot first exposed Linux read-access invalidation; after correcting that,
the test reproduced a retained snapshot with zero Git watch references while
SCM was disabled. An external commit then remained absent on reopening.

The cache now acquires acknowledged listener/watch coverage before reading,
transfers the lease into retained snapshots, shares coverage among query
variants, and releases it on invalidation/LRU eviction. Disposed or superseded
queries release pending ownership immediately. UNC snapshots stay uncached:
their 15-second recursive polling does not justify persistent hidden-tree scans.
Native registration rejects unavailable repositories and partial registrations,
covers shared linked-worktree refs, and runs blocking registration/teardown off
the async runtime. Watch release carries the identity returned at acquisition,
so repository deletion cannot change its release key.

Independent review confirmed the conditional lease lifecycle and delivered-event
writer rejection, and exposed the registration/identity defects corrected here.
This is eventual invalidation: native coalescing/delivery can lag a mutation.
The 16-entry cache bounds completed retention, not simultaneous pending writers
or the number of OS directory watches inside each recursive repository watch.
Remaining native watcher work includes recovery after a callback error while
another mounted consumer holds a reference, mutation filtering for worktree
files ending in `.lock`/`~`, and resource/latency measurements on large repositories.
Unhealthy watches now invalidate snapshots and reject new cache coverage; this
fails closed for retention but is not automatic recovery of live observation.

Final batch evidence: 2,040 unit outcomes plus 30 performance cases passed;
the full Rust library run passed 436 tests (six ignored) with loopback access.
The rebuilt Linux native cache suite passed all three cases after the final
watch-key IPC change, including real hidden-cache invalidation with SCM disabled,
cached pagination and partial-file diffs. Chromium passed 18 graph-remount,
detached-HEAD and SCM outcomes. Typecheck has zero errors/warnings. The normal
startup graph is 44 chunks / 640,220 raw bytes / 208,010 gzip bytes, within budget;
this is a size check, not launch-time evidence. The new native screenshot shows
the external commit after reopening. macOS/Windows acceptance and the overall
architectural review remain open.

The final independent identity review confirmed native/API/graph/SCM key flow,
including SCM late-acquisition compensation. It also identified a pre-existing
SCM cleanup gap to consolidate next: direct SCM unwatch calls discard failed
`ApiResult`s and their identities, whereas the ordered graph watch adapter
retains identity after release failure. This batch fixes the acquired identity
contract; it does not claim comprehensive release-error recovery.

Latest checkpoint (2026-09-07): window keyboard routing and terminal opening focus
have explicit owners; graph mutations invalidate caches before publishing fresh
history. Page dialogs have a typed host and owned lazy imports; CI retention
coverage uses bounded fake-clock bursts. Warm activation and
native pool retirement have explicit ownership and acknowledgements; terminal
readiness polling no longer holds the control mutex while waiting. Validation below supersedes earlier
checkpoint counts. The foundation is published in **[draft PR #684](https://github.com/xnmp/tauri-explorer/pull/684)**
against `dev` (implementation commit `fd06b3c6`); this does not complete the review
or authorize merge/release. Historical handovers
below record the state at their own checkpoint.

| Requirement | Required implementation and evidence | Current state |
| --- | --- | --- |
| Existing ownership overhaul | Retain pane/SCM/watch/drive/preview/terminal/contribution lifetimes, cache invalidation and persistence fixes; rerun appropriate suites after integration | Previous passing evidence recorded in review; integration acceptance pending |
| 1. Startup performance | Release Mac half-bounce recording, first presented frame and successful input, >=30 samples/scenario with p50/p95; cold, warm-cache, warm-window and restored optional surfaces; actionable profile-driven improvements | Instrumentation and payload budgets implemented; actual Mac measurements outstanding |
| 2. External jobs | Cancellation/timeout must stop local work and prevent late final-output publication; real worker/process/filesystem tests; adversarial verification | Worker draining, held staging files, serialized cancel/publication, bounded fal requests, and Nano child kill/reap implemented; 11 targeted Rust tests and independent review pass. Full integration pending; network calls can take up to their 30-second bound |
| 3. Long-session retention | Measure and bound refresh history/timers, validate config watch retention against ADR 0004, workspace/plugin churn and heap/load suite | Refresh inactive metadata capped at 1,024; 5,000-key regression. Config retarget registrations bounded after successful reconciliation; 9 Rust tests including actual Linux symlink handover, independently confirmed. Window-owned accepted plugin jobs independently confirmed; 5,000-job churn verifies exactly-once effects. Six bounded graph load cases now pass, including 25-cycle tab/toggle heap deltas of +3.5/+1.3 MiB, with independent evidence review. Workspace/plugin churn, scaled soak and native retention acceptance remain outstanding |
| 4. Orchestration | Extract coherent startup and graph state/policy owners; lifecycle behavior tests; preserve immediate core readiness and lazy features | Window settings/theme/plugin startup owner extracted; late settings teardown covered. Independent review exposed registry disposal missing active/in-flight contexts; fixed with terminal admission closure and shared disposal promise, independently confirmed. Inactive restored panes load on first activation (64-tab production regression failed before, passes after; independently confirmed). Graph history/pagination, PR/check/log and branch-metadata owners are extracted; request identity, immutable cache ingress and resolved branch walks have behavioral regression coverage and independent review. Commit-detail/inline-diff owner also implemented with mutation-time selection tokens and stage-side identity; 15 focused tests, Chromium/WebKit outcomes and native real-Git diff regression pass. Page dialog loading/rendering now lives in a typed WindowDialogs host with per-dialog demand and owned imports; cancelled/retired publication, real Svelte teardown, portal feedback and feature outcomes pass. Window keyboard routing now has pure policy, exact terminal command identity and owned modifier/chord subscriptions. Terminal focus requests survive lazy loading only while their originating interaction remains current. Window-session page orchestration remains open |
| 5. API dependencies | Feature-owned wrappers replace files.ts aggregation and dispatch cycles; architecture guardrail; caller tests and unchanged typed IPC contracts | Feature owners migrated across production, tests, benches and E2E; files.ts now filesystem-only, sibling wrappers import common primitives. Contract guardrail, independent API review and architecture lint pass. Plugins access accepted work through PluginContext.jobs |
| 6. Input boundaries | Normalize directory/tab/window launch/warm/transfer seeds before live state or allocation; validate finite and consumer-compatible setting bounds; malformed/oversized/legacy cases | Shared seed validation and serialization/parse budgets, finite geometry, closed snapshot validation, acknowledged native handoff implemented with regression tests. Lazy restoration bounds initial inactive-directory fanout. Numeric consumer audit now has a shared domain rule set, strict direct/config validation and finite setter coercion; malformed fractions, sentinel gaps, and the 4-column command are fixed, with unit/browser outcomes and independent review. Window launch/transfer ownership now has unit, browser and real three-window acceptance (details below). Large active layouts now materialize the focused pane immediately and defer remaining panes in cancellable batches; current browser/native acceptance is recorded below. Additional rejected-target native scenarios remain open |
| 7. Native identity | Verify equivalent separator/case/trailing-slash paths against real native watches; retain case-sensitive Linux/WSL semantics and native IPC arguments | Windows acceptance outstanding; shared owner already implemented |
| 8. Interaction consistency | Audit transition-all, semantic colors, address focus commands, theme controls; immediate pointer feedback, browser/native outcome coverage | 27 transition-all rules removed, 13 inactive aliases repaired, DnD uses semantic tokens. Ctrl+L targets active pane and respects hidden address bars/terminal ownership. Focused unit and Chromium address/theme/hover outcomes pass (all three file views). Independent review confirmed focus/transition contracts and exposed a white child-text override on bright accents; corrected to inherit on-accent color with a regression. Native maximize/restore and pointer-captured divider outcomes now pass, with stale-gesture and late-listener regressions and independent review. Wider theme/native interaction matrix pending |
| Platform release acceptance | Windows ConPTY, macOS PTY, config replacement/autoreload, watcher soak; native suites on supported platforms | Linux baseline passes; Windows/Mac outstanding |
| Product acceptance | Built-in themes, accessibility/keyboard behavior, narrow splits, view modes, DPI/zoom, preview formats and plugin failure combinations | Targeted baseline passes; wider matrix outstanding |
| Final integration | Typecheck, architecture lint, source maps, unit/perf/Rust/native/browser/load acceptance, screenshots, updated ADRs/report and issue; independent falsification of structural/performance claims | Outstanding |

Every completion update must name the actual production seam, regression or
measurement, result and limitations. Platform gates stay open until directly
verified; scaffolding a runner does not satisfy the gate. Additional defects
found while implementing a row belong to the same objective.

Latest integration checkpoint: typecheck zero errors/warnings; 214 unit files,
1,943 unit tests and 30 performance tests pass (three unit cases skipped).
Architecture lint is clean; maps cover **343/343** source files after adding the
window-launch owner (`python3 docs/code-map/validate.py --coverage`). The preceding
full Rust run passed 433 tests, six ignored, using isolated XDG roots; this
frontend pass has not changed Rust.

Chromium and WebKit each pass nine graph history/PR/filter outcomes, four detail
comparison/commit outcomes and two numeric settings outcomes. A rebuilt embedded
native binary passes three graph cases: external-commit cache invalidation,
pagination beyond the retained 300-commit first page, and independent staged /
unstaged diffs of one real file. The latter regression failed before the fix
(two identical expansions instead of one). The final combined native integration run passes **19/19** across seven specs
after the mutation-refresh invalidation fix: six terminal process/input cases,
one terminal key-ownership case, two pane/SCM restoration cases, two watcher
coalescing cases, three event-stream cases, three real-Git graph cases and two
config-autoreload cases. The real-Git test also verifies that unstaging retires
the open patch and reopening reads the changed working-tree diff.

An earlier following pane spec lost its WebDriver session. Isolated pane
acceptance then passed 2/2, and two fresh isolated graph → pane sequences passed
4/4 each. The initial disappearance remains unexplained; no production change
was made for it. These are checkpoints, not release acceptance.

Publication: the earlier foundation report was verified on issue #680. This
completion pass is published in [draft PR #684](https://github.com/xnmp/tauri-explorer/pull/684)
on `refactor/repo-health-cleanup`; the published report does not claim these
pending rows are complete. The draft links this ledger as its remaining-work contract.

## Continuation handover — 2026-09-07

- Goal remains active: implement the **entire** review. No commit, push, merge or
  release yet. The published issue report covers the earlier foundation.
- Preserve staged work on `refactor/repo-health-cleanup`. Leave the user's
  `AGENTS.md`, `docs/AI-native-ideas.md`, `docs/gotcha-study/` and
  `screenshots/_issue-refs/` untouched. Stage only owned changes; never bulk
  restore generated screenshots over unrelated evidence.
- Graph history, pagination, PR/check/log and branch metadata now have fixed
  repository state owners. Cache ingress freezes owned snapshots once; live
  history and cached page zero share immutable payloads. Pagination retains the
  exact branch exclusions used by page zero and never republishes its tail into
  the bounded shared cache. Partial history paints before the summary; paired
  failures are observed, and callbacks after a failed request cannot publish.
- Independent review found and led to fixes for superseded branch coverage,
  mutable cached data, stale same-PR checks and same-repo badges. Regressions
  also reproduce old pagination cleanup hiding a replacement spinner, new
  filters appending into old rows before debounce, and abandoned summary
  rejection. Final paired-failure review is independently confirmed (20/20 focused cases).
- Graph detail extraction is complete and independently confirmed. The owner
  reuses comparison transitions and captures index/worktree side, invocation and
  mutation-time selection. Failed scans retain prior files; accepted mutation
  refresh revokes pending and settled patches before reading the changed tree.
  Preview routing, commit editor and native mutation policy remain composed in
  the component. Native and browser outcome tests exercise that integration.
- Remaining code: warm launch result/activation ownership; larger page orchestration;
  viewport policy for layouts too dense to fit their minimum pane sizes. Large-layout activation and tab motion
  are implemented in the latest continuation below. Window transfer ownership
  and numeric consumer contracts are implemented and verified below.
- Native handoff needs real two-window acceptance: picker/hidden/unready targets,
  asynchronous creation failure, adoption and source retention. Unit ACK tests
  do not prove Tauri routing. Windows path aliases/ConPTY/config watches and
  macOS launch/PTY remain unverified. Machine availability is still unanswered.
- Native integration is complete and the driver is free. The serial load
  suite has completed 6/6 at `/tmp/review-current-load.log`. Independent
  evidence review confirms the bounded outcomes below. Graph/numeric reviews
  and read-only tab-transfer ownership audit are complete; no agent is editing
  source. The transfer audit found the concrete next work listed below.
  Ports: root 1420, agent 1437, load runner 1430. Run measured load acceptance
  without concurrent builds or browser/native workloads.
- Latest logs: `/tmp/graph-overhaul-full-unit.log`,
  `/tmp/graph-overhaul-check5.log`, `/tmp/graph-overhaul-native-build.log`,
  `/tmp/graph-overhaul-native.log`, `/tmp/graph-pane-native-isolated.log`,
  `/tmp/graph-pane-native-sequence.log`,
  `/tmp/graph-pane-native-sequence-repeat.log`. Reproductions:
  `/tmp/graph-query-before.log`, `/tmp/graph-query-filter-before.log`,
  `/tmp/graph-query-shared-before.log`, `/tmp/graph-query-ended-before.log`,
  `/tmp/graph-page-zero-rejection-before.log`, `/tmp/git-pr-session-before.log`,
  `/tmp/git-graph-branches-before.log`. Current detail/numeric logs:
  `/tmp/git-graph-detail-final.log`, `/tmp/graph-detail-native-before.log`,
  `/tmp/graph-detail-native-after.log`, `/tmp/graph-detail-chromium.log`,
  `/tmp/graph-detail-webkit.log`, `/tmp/numeric-settings-before.log`,
  `/tmp/numeric-settings-after.log`, `/tmp/numeric-explorer-final.log`,
  `/tmp/numeric-settings-{chromium,webkit}-final.log`,
  `/tmp/graph-numeric-check.log`, `/tmp/graph-numeric-unit.log`,
  `/tmp/review-current-native-build.log`, `/tmp/review-current-native.log`.
- New visually inspected evidence: `graph-pagination-oldest-commit.png` and
  `native-graph-pagination.png` in the branch screenshot directory. The native
  image shows real commit `pagination history 001`; `native-graph-partial-diff.png`
  shows the correct working-tree patch and `numeric-settings.png` four List
  tracks with a selected directory. Browser assertions and
  native scrolling establish that it is reached after cached remount.
- Earlier lazy restoration acceptance passed 9/9 Chromium cases across view
  modes and 6/6 WebKit cases. Registry listeners initialize only on accepted
  plugin work; startup has no unused job-listener IPC. Aggregate heap/load and
  workspace/plugin/platform acceptance remain open.

## Numeric consumer audit

`domain/settings-numbers.ts` now owns the following contracts. A mapped type in
`state/settings.svelte.ts` requires a rule for every numeric Settings key.
Persisted/config/direct-update input is strict; interactive setters clamp finite
values and ignore non-finite input. Continuous presentation values stay fractional.

| Preference | Consumer contract |
| --- | --- |
| zoomLevel | 50–200 continuous CSS zoom |
| backgroundOpacity, windowsBackdropOpacity | 0–100 continuous alpha |
| backgroundBlur | 0–20 continuous CSS pixels |
| listViewColumns | Integer 0 (auto) or 1–6; CSS grid and virtual row grouping agree |
| listColumnMaxWidth | 100–600 positive CSS pixels |
| previewPaneWidth | 0 (default 280) or 160–600 |
| previewPaneHeight | 0 (default 240) or 120–600 |
| terminalPanelHeight | 96–800; interactive resizing rounds pixels |
| recentItemsCount | Integer 0–20 |
| millerLayers, millerLayersPreferred | Integers 0–3 and 1–3; global and per-pane setters share coercion |
| previewFontSize | 8–28 continuous CSS pixels; the UI setter retains rounding |
| settingsVersion | Nonnegative safe integer migration stamp |

The regression checks fail against the pre-fix production store: fractional
counts and one-pixel panes were accepted, `4 Columns` became 3, and a generic
NaN update entered live state. After the fix, unit tests and actual Chromium /
WebKit computed-grid, selection, navigation and preview outcomes pass. This
completes the numeric consumer audit; it does not close the separate native
window-input and cross-platform acceptance rows.

## Load acceptance and next implementation boundary

All six existing load cases passed on their first attempt with no concurrent
build or native/browser acceptance workloads. Independent source/log review
confirms the following bounded evidence:

- 25 graph-tab open/close cycles: retained renderer JS heap after forced GC
  25.1 → 28.5 MiB (+3.5 MiB). Twenty-five graph toggles: 24.7 → 25.9 MiB
  (+1.3 MiB). Both pass the +25 MiB gate. This does not establish leak freedom,
  a long-duration retention slope, native resource use or workspace/plugin churn.
- A 5,000-commit backing graph paints its first **300** commits in 102 ms, then
  pages to all 5,000 with at most 48 mounted commit rows; deep selection takes
  48 ms. The prior log label suggesting all 5,000 initially rendered was
  corrected. DOM-row bounds do not certify every scroll frame's CPU cost.
- Twelve distinct graph tabs switch to the correct repository in 44–64 ms
  (mean 50 ms); last-three opens average 232 ms versus first-three 288 ms.
  The separate cache-remount regressions establish no redundant history read;
  this load test alone cannot distinguish cache reuse from a fast mock refetch.
- Real CDP rate=4 throttling: six switches 77–126 ms, detail selection 82 ms.
  These pass fixed budgets, not a measured same-run slowdown ratio.
- Eight 1,000-commit tabs and four directory round-trips survive the 256 MiB V8
  old-space cap. This is not a 256 MiB total-process/RSS ceiling.

Normal production bundle after integration: 621,678 B static JS / 199,820 B gzip
across 42 entry-closure chunks; main chunk 290,770 B / 85,389 B gzip. All budgets
pass (`/tmp/review-current-bundle.log`). About 28% below the original static JS
closure; no native launch-time improvement is inferred.

## Window ownership continuation — 2026-09-07

Implemented production ownership across the manager, pointer UI, native transport
and fresh-window launcher:

- `beginTabTransfer` reserves one lease per live tab incarnation, captures an
  isolated bounded snapshot, and permits one source removal only after adoption.
  Restoring the same persisted ID, source edits, disposal and repeated completion
  invalidate removal. Cancellation releases the reservation; an accepted native
  operation retains it through pointer release/unmount until its own settlement.
- Drag markers now belong to a transient source-window store with a UUID. No
  other window reads the marker; explicit screen routing and Tauri events perform
  transfer. Compare-and-clear, captured pointer/child identities and component
  teardown retire the right marker, ghost, RAF and listeners.
- `window-launch.ts` owns label-keyed directory/tab seeds, native creation outcome
  and correlated adoption. Same-path concurrent opens cannot overwrite seeds.
  Constructor errors, asynchronous errors, listener acquisition races and timeout
  all retire owned resources. Native work is uncancellable: timed-out creation
  remains observed until its terminal event so an arbitrarily late child closes.
- `windowSeedFitsBudget` checks exact JSON character cost with an early aggregate
  stop before whole serialization. It rejects cycles/deep/non-JSON input and is
  shared by the source snapshot, native message and launch envelope boundaries.
- A last-tab transfer detaches source resources synchronously. A new tab before
  native-close dispatch keeps the source window alive. After dispatch, incoming
  ownership is rejected until close fails; restore commands guard before popping
  closed-tab history.
- Native adoption and ACK listeners are label-scoped. The three-window regression
  exposed Tauri's default `Any` listener semantics: every Explorer adopted a
  message emitted to `main`, including the source, which removed its original but
  retained a newly adopted replacement. Scoped listeners fix the root cause.

Evidence:

- Restored-ID/source-edit/disposal regressions failed 4/4 before the lease fix;
  old marker cleanup failed the replacement-drag test; path-keyed launch seeds
  failed 2/10 launch tests. Native-close dispatch and overlapping reservations
  each have a failing pre-fix production-seam test. Logs are under
  `/tmp/window-tab-transfer-before.log`, `/tmp/tab-drag-before.log`,
  `/tmp/window-launch-before.log`, `/tmp/window-close-before.log`, and
  `/tmp/window-transfer-reservation-before.log`.
- Final unit integration: **214 files, 1,943 tests + 30 perf tests passed**,
  three skipped (`/tmp/window-final-unit.log`). Typecheck reports zero errors and
  warnings; architecture lint is clean.
- Chromium and WebKit each pass **4/4** pointer lifetime outcomes, including a
  second drag of the same tab after reorder/cancellation, replacement gestures
  and component unmount. Logs: `/tmp/window-tab-drag-lease-chromium.log` and
  `/tmp/window-tab-drag-lease-webkit.log`.
- Rebuilt embedded Tauri acceptance passes **3/3** native cases: concurrent
  same-path children retain independent navigation; last-tab source closes after
  the target adopts while a third window remains unchanged; split-tab tear-off
  preserves both directories. The destination also observes a real subsequent
  filesystem write. The routing defect failed before the listener fix at
  `/tmp/window-native-diagnostic2.log`; final result is `/tmp/window-native-final.log`.
  Screenshot: `screenshots/refactor/repo-health-cleanup/native-window-transfer.png`.
- Independent adversarial review confirmed the final integrated ownership and
  routing contracts after finding the overlapping-transfer and history-pop
  defects. Its separate focused run passed 35/35. Low residual: if Tauri's native
  creation invocation never terminates, its associated drain observer remains
  retained; abandoning it on a second timer would permit orphan creation.

These outcomes do not prove picker/hidden/unready target rejection through the
native backend, Windows window behavior, macOS half-bounce readiness, or the
remaining release matrix. Those gates stay open.

Final combined native integration passes **22/22 across eight specs** on the
rebuilt embedded binary (`/tmp/window-integration-native.log`): terminal/process
and key ownership, pane/SCM restoration, watcher coalescing, stream listeners,
real-Git graph behavior, config autoreload and multiwindow transfers. The new
window screenshot also demonstrates the split adoption after this combined run.
No Rust source changed in this continuation; the preceding 433-pass/6-ignored
Rust run remains the latest Rust evidence.

Normal production bundle: **625,407 B raw / 201,620 B gzip**, 43 startup-closure
chunks; main chunk **292,781 B / 86,139 B gzip**. Budgets pass at
`/tmp/window-final-bundle.log`. This is a payload measurement, not a macOS
first-frame or input-latency result.

Current handover: all owned source/test/docs/evidence changes are staged. Map
coverage passes **343/343**; the only unstaged tracked file is the user's `AGENTS.md`. Nine test-generated images were
backed up under `/tmp/window-integration-generated-evidence`, then restored to
their pre-run indexed versions; the new native-window screenshot is retained. The user's `AGENTS.md` and protected unrelated files
remain untouched. No commit, push, merge or new issue publication has occurred.
The full goal remains active. Next source work is the delayed tab-close identity
and entrance-ID retention defects, then visible-pane allocation and larger page
orchestration, alongside the remaining ledger acceptance.


## Pane materialization and tab motion continuation — 2026-09-07

The tab strip now closes its manager-owned tab synchronously. Svelte owns the
short structural entrance/outro lifetime, honors reduced motion, and needs no
historical ID set or deferred close callback. Mounting the populated strip avoids
animating initial restored tabs. Chromium and WebKit each pass three acceptance
cases, including same-ID workspace replacement, restore during a slowed outro,
and no initial animation. Logs: `/tmp/window-tab-close-final-{chromium,webkit}.log`.

Large active layouts retain all saved descriptors. `pane-activation.ts` opens the
focused pane immediately, then at most four reserved panes per post-paint batch.
Small layouts remain synchronous. The manager owns readiness, pane sessions own
resources, and the renderer substitutes one placeholder for an entirely deferred
subtree. Tab switches, restoration, disposal and native close cancel pending work.
Explicit focus and focused-pane removal open the requested/fallback pane immediately.
Rejected native close resumes the surviving layout; interactions during close cannot
restart its queue. Initial background directory completion cannot steal active pane
identity or DOM focus across a render wait.

Independent review found the close rejection, unmaterialized fallback and activation
during pending close defects. Each failed against production manager code before
its fix (`/tmp/pane-activation-{fallback,closing}-before.log`). Browser diagnostics
separately reproduced background load completion changing active pane identity
(`/tmp/pane-materialization-focus-diagnostic.log`). The final independent review confirms those fixes and passes 33 focused activation,
session, disposal and validation cases. Initial descriptor traversal remains O(layout
nodes), although the rendered subtree is bounded. A synchronous explorer-constructor
exception could leave a reservation unmaterialized; this remains an exceptional
constructor-failure limitation, not a measured production occurrence.
These are lifecycle contracts, not claims that all thousands of permitted panes fit on screen or finish within a
fixed time. Minimum-size/overflow policy remains open.

Current checkpoint: **215 unit files, 1,949 passed / 3 skipped**, plus **30 performance
checks**; type check has zero errors/warnings and architecture lint is clean.
Logs: `/tmp/pane-activation-full-unit.log`, `/tmp/pane-activation-final-check.log`,
`/tmp/pane-activation-arch.log`. Normal production startup closure is **630,808 B raw /
203,801 B gzip across 43 chunks**, within budgets (`/tmp/pane-activation-bundle.log`).
This does not establish macOS half-bounce timing. Chromium and WebKit each pass **3/3 pane-materialization** and **3/3 tab-close**
cases on the current focus implementation. The controlled initial browser frame
contains one explorer, six ancestor splits and six deferred-subtree placeholders;
all 64 saved panes eventually materialize with unchanged descriptors. Ordinary
navigation still gives actual DOM focus to the new selected entry, refuting a
source-only concern about that guard. Logs:
`/tmp/pane-materialization-all-{chromium,webkit}.log` and
`/tmp/window-tab-close-post-focus-{chromium,webkit}.log`.
The materialization screenshot shows progressive allocation; at this density its
file content is clipped and it is not proof of pixel usability. Code-map coverage
passes **344/344**. Rebuilt native window acceptance passes **4/4** (`/tmp/pane-activation-native-accepted.log`),
including eight distinct real directory markers and a later filesystem watcher
publication. The initial failures were test assumptions: tab DOM persists through
its owned outro, and the status path belongs to the global status bar rather than
each pane. This native test proves eventual contents/focus/watch ownership, not an
exact first-frame count. Binary build: `/tmp/pane-activation-native-build.log`.
Initial combined native integration passed 22/23; the terminal key probe failed
because its readiness marker also appeared in echoed Python command text. A
failure diagnostic reproduced the premature-readiness oracle. Constructing the
marker inside the probe makes only runtime output satisfy the wait; isolated
native acceptance passes 1/1 (`/tmp/terminal-key-native-accepted.log`). Final combined
integration passes **23/23 across eight native suites** in 64 seconds
(`/tmp/pane-integration-final.log`): terminal6, terminal key ownership1, pane lifetime2,
watch coalescing2, listener streams3, real-Git cache/detail3, config autoreload2 and
window transfer4. The driver is released. Generated existing acceptance images
were restored to their indexed checkpoint after inspection; new pane/tab evidence
is retained. All implementation and new tests in this continuation are staged;
no commit, push or merge has occurred. The unrelated user files remain untouched.

The source and evidence remain local and uncommitted. The entire review goal stays
active. Next work includes the remaining code owners above, workspace/plugin churn,
scaled/native retention, native rejected-target scenarios, and Mac/Windows release
acceptance. Preserve unrelated user files identified in the earlier handover.

The subsequent window-chrome and divider pass below addresses the late native
listener/query and stale resize-frame findings. Central native-close admission
remains open: the titlebar's close button bypasses manager admission, and compositor
close requests have no common manager hook.

## Window chrome and divider ownership continuation — 2026-09-07

`window-chrome.ts` now owns maximize-state observation. The former component
implementation was extracted unchanged and failed three behavioral regressions:
late publication after retirement, a late subscription without cleanup, and 100
resize notifications starting 100 overlapping native reads
(`/tmp/window-chrome-before.log`). The owner subscribes before reading, keeps one
read in flight plus a coalesced trailing read, rejects superseded results, and
observes asynchronous unsubscribe failures despite Tauri's void callback type.
Six tests cover retirement, coalescing, read recovery and unsubscribe failure.

Divider gestures now have an importable owner (`pane-resize.ts`) with captured
geometry and a single queued frame. Manager operations capture the live tab
incarnation; same-ID restore, a different active tab, removed splits and disposal
cannot accept old updates. `PaneContainer` keys DOM lifetime by that incarnation,
so same-ID workspace revival retires the prior DOM and capture. Ratio updates
preserve unchanged branches and exact no-op roots; non-finite input is ignored.
This reduces allocations along a changed tree path; finding a split is still
O(layout nodes), so this is not a constant-time claim.

The divider uses local pointer capture instead of one global mousemove/up listener
per mounted layout node. This follows the W3C Pointer Events capture/release model:
https://www.w3.org/TR/pointerevents3/#pointer-capture . Primary pointer identity,
button state, pointerup/cancel/lost capture, blur and unmount define its lifetime.
Pending frames cannot outlive that gesture, and captured geometry avoids layout
reads on every move. Independent source review confirms the ownership contracts
and passes 40 focused tests. Browser acceptance passes **7/7 in Chromium and 7/7
in WebKit**, including actual captured dragging outside the divider, persistent
geometry, both usable listings, buttonless hover after release, and hostile late
frames. WebKit did not emit lostpointercapture after the test programmatically
released it; that case verifies capture then explicitly delivers the event to test
the production handler. It does not prove automatic platform event delivery.

Current complete unit checkpoint: **218 files, 1,963 passed / 3 skipped**, plus
**30 performance checks** (`/tmp/chrome-resize-full-unit.log`). Type checks and
architecture lint pass. A later finite-overflow guard passes its focused tests;
final bundle/native integration still needs the current pointer-capture build.
New source and tests are staged. Code-map coverage passes **346/346** after adding
`window-chrome.ts` and `pane-resize.ts`.

Native maximize acceptance now passes on an isolated **Xvfb/Openbox** display:
`/tmp/chrome-isolated-native.log` is 1/1, including real native maximize state,
changed geometry, restored geometry and real file navigation. The original host
was independently verified as grouped/tiled Hyprland/Xwayland, where native state
stayed false. Tile reflow had changed geometry without maximizing, so the strong
state-and-geometry oracle was preserved. The test retains portable IPC diagnostics;
all experimental compositor manipulation was removed.

`e2e-tauri/with-window-manager.sh` starts one owned Openbox process, waits for its
process and advertised EWMH readiness, propagates the test exit status, and retires
the process on exit. Independent review confirms those contracts; a real isolated
command exiting 7 preserved exit 7. Linux CI installs Openbox/x11-utils and uses
that same fixture under xvfb-run, with the same 15-minute step timeout as Windows.
The developer's existing desktop/grouped windows are untouched. Local tools came
from the repository's pinned Nix input (`/tmp/chrome-isolated-tools.log`).

Final unit run remains **1,963 passed / 3 skipped + 30 performance checks**
(`/tmp/chrome-resize-final-unit.log`); type checks and architecture lint are clean.
Normal startup closure is **632,852 B raw / 204,535 B gzip over 43 chunks**; main
chunk 295,293 B / 87,032 B gzip, within budgets (`/tmp/chrome-resize-bundle.log`).
The current pointer-capture source is embedded by
`/tmp/chrome-resize-final-native-build.log`. Combined native integration passes **24/24 across nine suites** in 59 seconds
(`/tmp/chrome-resize-native-integration.log`) on its isolated display. All prior
23 native outcomes remain green, with maximize/restore added. The driver, Openbox
and Xvfb fixture have exited. Generated existing images were restored to their
indexed checkpoint; the new chrome and resize screenshots were inspected and retained.
Durable final browser pointer results are **7/7 per engine** at `/tmp/pane-pointer-final-{chromium,webkit}.log`; new evidence is `pane-resize.png`
and `native-window-maximized.png` in the branch screenshot directory.

Remaining code priorities: central native-close admission (TitleBar directly calls
native close; compositor close requests have no manager admission hook), broader
page orchestration, dense-layout viewport policy, workspace/plugin churn and native
retention. Installed Tauri's onCloseRequested wrapper awaits the handler and then
calls destroy unless prevented; a future common close owner must account for that
without recursive close events or unsupported implicit destroy permissions. The
window-chrome observation owner does not solve close admission. Entire review goal
remains active; no commit, push or merge. Preserve all earlier staged work and the
user's unrelated files.


## Common window-close owner — 2026-09-07

`window-close.ts` now owns titlebar, last-tab and native close requests. Manager
admission closes synchronously before native work can yield; new tabs, restores,
transfers and duplicate transfer acknowledgements cannot enter a closing window.
The owner snapshots persistence before one terminal destruction, recovers the
surviving layout after rejection, and retires late native subscriptions/callbacks.
Disposal prevents pending dispatch or later recovery. Last-tab removal retains its
pre-dispatch opportunity for a newly opened tab to keep the window alive.

The extracted legacy path failed both admission regressions
(`/tmp/window-close-before.log`). Independent adversarial review confirms
single-flight dispatch, failure/retry, disposal and stale callback contracts.
The receiver regression now explicitly waits for visibility IPC to begin before
closing admission; both new and duplicate handoffs then produce no ACK.
Tauri's installed SDK and official window API agree that close emits a request
while destroy bypasses that request. Native callbacks explicitly prevent the SDK's
default destruction, and the application capability now permits terminal destroy.
Reference: https://v2.tauri.app/reference/javascript/api/namespacewindow/ .

Validation: **220 unit files, 1,973 passed / 3 skipped, plus 30 performance checks**
(`/tmp/window-close-final-unit.log`); type check has zero errors/warnings
(`/tmp/window-close-final-check.log`), architecture lint is clean and indexed map
coverage is **347/347**. Normal startup closure is **633,622 B raw / 204,848 B gzip
across 43 chunks**, within budgets (`/tmp/window-close-bundle.log`). These payload
figures do not establish the Mac half-bounce target.

The rebuilt native binary (`/tmp/window-close-native-build.log`) passes **5/5**
window transfer/close cases in 13.4 seconds on isolated Xvfb/Openbox
(`/tmp/window-close-native-accepted.log`). Both titlebar close and real native
close API retire their requested child; the surviving main window receives actual
filesystem changes after each close and still navigates. Unit tests and SDK review
establish observer participation/single-flight behavior; native destruction alone
cannot uniquely establish those details. WebKit sometimes returns no-such-window
from the close-button click because destruction wins the response race. The test
accepts only that protocol error and still requires actual handle disappearance.
The inspected `native-window-close.png` shows the surviving listing with both
post-close files. The older regenerated transfer image was restored to its indexed
checkpoint. No commit, push or merge has occurred.

Native test setup also exposed a separate API ambiguity: successful warm-window
consumption makes `openNewWindow` return null, just like failure. Startup's
NO_WARM_PRIME flag does not prevent later launch replenishment, so a repeated
open-pair fixture can legitimately return [null, freshLabel]. Independent source
and log review confirmed this; the close case uses known fresh windows. Next work
should give warm/fresh launch outcomes an explicit contract and audit warm
activation lifetime/acknowledgement, including the detached-window reposition
caller that currently expects a native handle. Do not change that return type
without migrating the drag consumer. Larger page orchestration, dense-layout
viewport policy, workspace/plugin churn/native retention, rejected native targets,
and Mac/Windows release gates remain open. The entire review goal remains active.


## Warm-window ownership and final publication checkpoint — 2026-09-07

`window-launch.ts` returns a discriminated fresh/warm result; null consistently
means failure. The drag consumer retains the native handle only for fresh
tear-offs. `window-handoff.ts` supplies correlated, label-scoped acknowledgements
for transfer and warm activation, including negative replies and safe cleanup.
`warm-activation.ts` owns subscription acquisition, navigation, reveal, commit,
acknowledgement and retirement. It waits for successful requested navigation
before visibility and checks lifetime across asynchronous boundaries. Navigation
now returns its real success result. Failed warm activation retires its destination
and permits immediate fresh fallback. The page disposes the activation owner.

`warm_pool.rs` owns label-specific spawn reservations, ready windows, timed claims,
activated windows and failed retirements. Native watchdogs expire abandoned boot
and claim ownership. Shutdown revokes registrations and includes native windows
whose frontend never booted. Late activation cannot commit an expired claim and
preserves the watchdog's authority to destroy it. Independent adversarial review
reproduced and confirmed fixes for reservation reuse, claim expiry, acknowledgement
cleanup and the final deadline/watchdog race. Nineteen pool tests pass; the final
independently extracted watchdog regression passes as well.

Native integration exposed a separate real terminal defect: `wait_pty_readable`
held the shared master mutex through blocking poll. Independent instrumentation
measured a 43.03-second lock wait, missing the entire foreground process. The
reader's Arc retains the stable descriptor; dropping the lookup guard before poll
restores prompt status and resize access. The existing real busy-process test now
passes in 2.07 seconds. No test-only production timing workaround was introduced.
A browser drag fixture also measured an entering, zero-width tab; it now awaits
actual animation completion before capturing geometry.

Verification at publication:

- Unit suite: **1,988 passed, 3 skipped in 221 files**, plus **30 performance
  checks** (`/tmp/warm-unit-accepted.log`). Type check: zero errors/warnings
  (`/tmp/warm-final-check-verified.log`). Architecture lint and source maps pass,
  **348/348** files. Whitespace checks and `cargo fmt --all -- --check` pass.
  All-target Clippy with the CI `avif` feature and warnings denied passes
  (`/tmp/review-final-clippy.log`).
- Normal startup payload: **636,196 B raw / 205,939 B gzip over 44 chunks**,
  within the enforced budgets (`/tmp/warm-final-bundle-verified.log`). These are
  payload measurements, not Mac launch-time evidence.
- Full Rust library suite: **430 passed, 6 ignored**, with `SHELL=/bin/bash`, an
  isolated XDG cache and `--test-threads=1`
  (`/tmp/warm-rust-release-check.log`). Final watchdog correction separately passes
  **19/19 pool tests** (`/tmp/warm-pool-watchdog-final.log`) and independent
  extracted-code regression (`/tmp/warm-deadline-retirement-final.log`).
- Full Linux native integration: **28 outcomes across 10 suites**
  (`/tmp/warm-terminal-native-final.log`). After the final watchdog correction,
  the rebuilt binary passes **all 3 warm-window outcomes** in 33.1 seconds
  (`/tmp/warm-final-native-acceptance.log`): real requested directory, real failed
  navigation/fresh fallback, and abandoned claim expiry with surviving-window
  watcher activity. Native runs use isolated Xvfb/Openbox.
- Tab close/drag browser outcomes: **14/14 across Chromium and WebKit**
  (`/tmp/warm-tab-browser-final.log`), with structural motion enabled.
- Screenshot `native-warm-lifetime.png` records the surviving listing after claim
  expiry. Regenerated earlier screenshots are restored to their accepted index
  checkpoints. Test logs under `/tmp` are local diagnostics, not published CI
  artifacts; reproducible commands/specs and screenshots are committed.

Known verification limitation: the terminal shell-shim test mutates process-wide
`SHELL`; an interactive zsh profile also attempted a gitstatus download in the
isolated cache. The full Rust result above is explicitly serial with a known
shell. Default-profile/parallel shell test isolation remains follow-up work.

The remaining release scope is unchanged: Mac release half-bounce recordings and
p50/p95 over at least 30 launches per scenario; larger page orchestration;
dense-layout viewport policy; workspace/plugin churn and native resource retention;
rejected native transfer targets; Windows path/watch/ConPTY and Mac acceptance;
the wider theme/accessibility/DPI/product matrix; final integration and independent
acceptance. None is completed by creating the draft PR. Do not merge or close
#680 until the ledger's requirements are satisfied.

Continuation: preserve the user's unrelated `AGENTS.md`, `docs/AI-native-ideas.md`,
`docs/gotcha-study/` and `screenshots/_issue-refs/`. Production and acceptance changes
belong to `refactor/repo-health-cleanup`. The entire-review goal remains active.


## Page dialog ownership and CI retention fixture — 2026-09-07

`WindowDialogs.svelte` composes the twelve lazy dialogs, contributed dialogs,
crash boundaries, and window-level feedback. The page now owns layout and passes
its file-refresh callback; constructor props are inferred from the actual dynamic
imports instead of `Component<any>`. `use-lazy-dialog.svelte.ts` tracks only each
dialog's own demand, while `state/lazy-dialog.svelte.ts` owns pending imports,
successful constructors and retirement. Close/reopen shares one pending import;
closed requests cannot publish failure feedback, successful constructors remain
mounted for local state/outros, and host destruction suppresses late results.
Portal mode now renders the toast that its failed-import recovery already needs.

A real delayed Theme Picker import, cancelled before opening Quick Open, reproduced
an obsolete error toast on the old page loader (`/tmp/dialog-owner-before.log`).
The corrected test snapshots feedback after the failure's render turn; retrying
an absence assertion could hide this bug by waiting for the toast to expire.
The same regression passes with the new owner. The real Svelte parent-lifetime
fixture is under `src/test-support/`, imported only by E2E and absent from the
production graph; it verifies that neither import resolution nor rejection can
publish after parent destruction. Independent review confirms all these contracts
and preservation of lazy imports, crash recovery, portal mode and feature wiring.

Validation:

- **222 unit files, 1,996 passed / 3 skipped**, plus **30 performance checks**
  (`/tmp/dialog-owner-full-unit.log`); eight new owned-loader cases and the nine
  existing failure-containment cases pass. Final type check has zero errors/warnings
  (`/tmp/dialog-owner-final-check.log`); architecture lint and whitespace checks pass;
  source maps cover **352/352** files.
- **14 Chromium/WebKit outcomes** for modal input, theme selection and lazy failure
  recovery (`/tmp/dialog-owner-browser.log`), plus **44** for bulk rename, conflict
  resolution, jobs, picker output and lazy failures (`/tmp/dialog-owner-features.log`).
  These runs overlap on the six lazy-failure cases; they are not 58 unique outcomes.
- **4/4 real Svelte parent-lifetime outcomes** across Chromium and WebKit
  (`/tmp/dialog-owner-host-lifetime.log`). The inspected `dialog-load-lifetime.png`
  shows usable Quick Open results after the cancelled Theme Picker failure.
- Normal startup graph remains **44 chunks**, **636,724 B raw / 206,581 B gzip**,
  within budgets (`/tmp/dialog-owner-bundle.log`). The 642-byte gzip increase is
  measured overhead for ownership and typed host composition, not a startup-time
  improvement claim. Mac half-bounce measurements remain outstanding.

Published CI at `ddd38d69` passed Rust, source maps, macOS launch smoke and both
performance jobs, but frontend unit acceptance timed out in the 5,000-directory
retention regression. Independent diagnosis reproduced a 2.94–3.06-second isolated
fake-clock drain versus 5.745 seconds under CI contention. The test now processes
5,000 distinct keys in four 1,250-key bursts, each above the 1,024 retention cap,
and asserts the cap after each settlement. All callbacks and final cleanup remain
covered; production refresh logic is unchanged. The whole 12-case file now takes
637 ms (`/tmp/refresh-retention-ci-after.log`); full unit/performance acceptance
passes. Independent review confirms no retention contract was lost. This resolves
the fixture cause; the next pushed commit still needs its own CI result.

Remaining page work: keyboard routing and window-session setup/teardown still
live in `+page.svelte`; inspect their ownership before extracting them. Dense pane
viewport policy, workspace/plugin/native retention, platform and product matrices,
and actual Mac launch measurement remain open as specified by the table above.


## Keyboard ownership, deferred focus and graph mutation publication — 2026-09-07

The page composes `state/window-keyboard.ts`; `domain/window-keys.ts` owns the
ordered routing policy. Both xterm and the window use `getTerminalCommand` from
`domain/terminal-keys.ts`, and dispatch retains the exact eligible command ID.
Previously an unrelated earlier-registered command could steal an allowed
terminal shortcut during a second broad lookup. Missing/unavailable commands
now leave the key with the terminal. Blur, disposal, editable/modal ownership and
pointer interaction retire unfinished chords. The listener owner observes command
failures and releases every subscription and tracked modifier on disposal.

Four original routing regressions failed on the mechanically extracted old page
handler; three further ownership-transition regressions failed before their
correction. The production matcher is exercised directly, not transcribed.
The 19 routing cases cover conflicting shortcuts/chords, availability, surface
precedence, terminal-owned suffixes, focus transitions and disposal.

Terminal opening focus is a one-shot request in `state/deferred-focus.ts`, owned
by `TerminalPanelStore`. New keyboard/pointer input or window blur cancels it;
consumption also defers to any modal that opened programmatically. The initial mounted
xterm consumes the same request as subsequent visible-panel opens. Queued path
insertions still arrive even when focus permission has expired. Restart claims
focus at the action, while asynchronous shell completion and layout callbacks
never claim it. Deferred fitting is cancelled on effect teardown.

The held-animation-frame regression failed in both Chromium and WebKit before
the fix. Independent review then found the same race across the first lazy import:
all four delayed-import dialog/filter cases failed before request ownership.
Existing Alt+T acceptance caught two additional boundaries: the initial effect
can run before xterm mount, and older navigation can restore listing focus during
the import. The consumer also runs immediately after `term.open`; eligibility
tracks newer input and modal ownership, not DOM-element identity. These are
separate failure modes and tests, not a blanket autofocus suppression.

Published CI at `2c2a8121` confirmed unit, type, architecture, bundle, Rust,
macOS launch-smoke and performance checks. Its wider frontend suite exposed a
persistent detached-HEAD cached-remount failure. Diagnosis reproduced the exact
failure: graph handlers reloaded and published fresh history, then sent a local
notification that evicted it. All seven graph mutation refresh paths now use
`refreshAfterGitMutation`, invalidating old snapshots/writers before refresh.
The existing delayed-backend remount test and a real-cache behavior test verify
that post-mutation history remains immediately available. Local invalidation
from other surfaces remains enabled.

CI also exposed unresolved native acceptance work:

- The coalescing test's first WebDriver observation returned after its held
  listing completed. Its fourth filesystem event was observed after the trailing
  listing started, correctly requiring a third listing. Backend observation times
  prove the fixture interleaving; production coalescing must not discard it.
  Rewrite the test's write/acknowledgement protocol before claiming acceptance.
- The transfer suite returned `[null, null]` from opening two children; subsequent
  null-label failures cascade from that setup. Diagnose launch/pool outcomes and
  test setup before asserting native transfer acceptance.
- Windows hidden-graph acceptance retained history after an external commit.
  Graph roots and watcher event keys both derive from the backend workdir key;
  an 8.3-alias mismatch is not established. Registration/readiness and watcher
  coverage during hidden-cache retention need actual event/owner instrumentation.
  Seeing the new file in a directory listing does not prove Git-event delivery.
- Windows warm/transfer failures include WebView2 creation HRESULT `0x8007139F`;
  subsequent missing-window failures cascade from those creation failures.
  Isolate native resource pressure before attributing them to application logic.
  WebKit's remaining tab-reorder failure passed retry; retain it as an intermittent
  interaction issue rather than counting a retry as proof of absence.

Final validation and publication details follow below. The full-review goal
remains active; native CI failures, page session orchestration, dense layout,
long-session/platform/product matrices and actual Mac half-bounce measurement
remain outstanding. Preserve the user's unrelated files as above.


Validation for this batch:

- **224 unit files, 2,027 passed / 3 skipped**, plus **30 performance checks**
  (`/tmp/window-keyboard-integrated-unit-final.log`). Final type check reports
  zero errors/warnings; architecture lint and whitespace checks pass. Source maps
  cover **355/355** files. The focus owner has 11 behavior cases in addition to
  19 routing cases and the new graph mutation/cache contract.
- **38/38 final terminal/keyboard outcomes** across Chromium and WebKit
  (`/tmp/window-keyboard-focus-final.log`), including six delayed layout/import
  cases. The formerly intermittent cold Alt+T opening passes **20/20 repeats**
  (`/tmp/window-keyboard-opening-repeat.log`).
- The integrated 74-case browser matrix passed graph detached/remount, pagination,
  modal-input and all three file-view filter cases; its one cold Alt+T failure
  led to the final correction and repeat run above
  (`/tmp/window-keyboard-graph-browser-final.log`). An earlier run was interrupted
  by a dev-server reload during Svelte sync; the stable rerun passed 62/62 before
  the subsequent cold-import work. These overlapping runs are not additive.
- **4/4 stage/unstage/commit browser outcomes** across Chromium/WebKit
  (`/tmp/graph-mutation-commit-browser.log`). The inspected
  `graph-mutation-remount.png` captures the retained detached indicator.
- Rebuilt real Tauri acceptance: **9 passed / 1 skipped across three suites**
  (`/tmp/window-keyboard-native-final.log`, build log
  `/tmp/window-keyboard-native-build-final.log`). This covers real PTY byte/input,
  conflicting terminal shortcuts, retained shell session and cwd sync, hidden
  graph external invalidation on Linux, deep Git pagination, and independent
  staged/unstaged diffs. The native screenshot shows the terminal-toggle result
  with both tabs and the sidebar preserved. Browser screenshots prove routing
  against the mock; they do not establish shell startup.
- Normal startup graph: **44 chunks, 638,654 B raw / 207,363 B gzip**, within
  enforced budgets (`/tmp/window-keyboard-bundle-final.log`). This is a payload
  measurement, not launch latency or proof of the Mac half-bounce target.
- Independent review confirmed final exact-command dispatch, chord retirement,
  deferred focus/modal priority and cleanup, plus all seven graph mutation
  refresh placements and their cache/query-generation behavior.

Continuation priority: fix the native coalescing fixture with an acknowledged
write protocol; instrument Windows Git watch readiness and coverage during hidden
cache retention; isolate native window creation failures. Then resume page session
ownership, dense-layout policy and the outstanding long-session/platform/product
matrix. Mac hardware preference is still unanswered; local work does not depend
on it. Keep the PR draft and #680 open. No merge/release acceptance is implied.

## Native Git observation service — 2026-09-07

The old native watcher registry combined a global mutex, per-burst timer threads
and callbacks which could become permanently unhealthy while another panel still
held a reference. SCM separately discarded failed unwatch results. A repository
key also could not make retried releases idempotent across ownership generations.

`git_watch.rs` now adapts Tauri to a lazy service; `git_watch/service.rs` owns a
bounded command inbox, unique lease IDs, shared native observers and all debounce
and recovery deadlines on one dedicated worker. Callbacks set per-generation
atomic flags and attempt a nonblocking wake only when those flags become dirty.
The worker scans entries in place, retries failed invalidation delivery, and
re-discovers/reinstalls failed observation with bounded exponential delay while
leases remain. Final release removes observation and its deadlines. Shutdown
rejects late acknowledgements and joins the worker. SCM now uses the same ordered
frontend owner as graph/cache consumers, retaining failed releases for retry.
[ADR 0009](adr/0009-git-observation-leases.md) records the contracts and limits.

`git_watch/target.rs` separates discovery and event policy. Worktree `Cargo.lock`
and backup-named files now invalidate normally; only temporary Git metadata is
filtered. Non-recursive parent watches detect root movement/replacement and
exclude unrelated siblings. Private/shared worktree metadata coverage and complete
registration acknowledgement remain required. The native cache test replaces a
repository with a new inode while its graph stays mounted, verifies two subsequent
real commits, then verifies the new lockfile appears when returning to the listing.

Evidence:

- Both SCM release-failure regressions fail against the prior implementation
  (`/tmp/scm-release-before.log`). The worktree-lock regression fails against
  the actual previous Rust predicate (`/tmp/git-worktree-lock-before.log`).
- Ten service/target contracts pass, including failure during registration,
  cancellation during blocked acquisition, shared-reference recovery, stale
  callbacks, emission retry, idempotent release across recreated observers,
  real directory movement, linked worktrees and final cleanup.
- Full frontend suite: 2,042 passed, three skipped, plus 30 performance tests.
  Full final Rust library suite: 439 passed, seven ignored. The extra ignored
  case is the explicit native cost measurement below, run independently.
- Rebuilt Linux native suite: four passed, including root replacement and
  returning to the file listing (`/tmp/git-service-listing-outcomes.log`).
  Chromium: 18 graph/SCM outcomes passed (`/tmp/git-service-browser-outcomes.log`).
- Typecheck zero errors/warnings; `cargo clippy --all-targets -- -D warnings`
  and formatting pass. Normal startup graph: 44 chunks, 640,144 raw bytes /
  207,956 gzip bytes, within budgets. This is payload evidence, not launch time.
- Independent review found no concrete defect in the final lease, callback,
  queue, recovery, parent-watch, shutdown and SCM ownership contracts.

The independent verifier ran `cargo test --manifest-path src-tauri/Cargo.toml
measure_retained_observation_fanout --lib -- --ignored --nocapture`: 12 real
repositories with 1,000 directories each. Initial acquisition p50/p95 was
10.886/11.703 ms; shared acquisition 0.116/0.158 ms. All 24 leases released in
0.602 ms, retaining zero observer objects. Service spawn returned in 0.076 ms.
This one Linux debug run used hot metadata and sequential requests; its 12-sample
p95 is effectively the maximum. Observer objects are not kernel watch descriptors.
It establishes sharing/cleanup and this fixture's cost, not memory, idle CPU,
event throughput, queue contention, cold disk, UNC or other-platform performance.

Next: repair the native coalescing fixture's write/receipt protocol, finish native
window failure/reclamation acceptance, and resume page-session, dense-layout and
long-session/product/platform work. Native Git lease reclamation on a crashed
window remains separate from acknowledged frontend cleanup and process shutdown.
Large or remote native registration can still delay that dedicated worker until
the OS call returns. Actual macOS release startup recordings remain outstanding.
Keep PR #684 draft and issue #680 open.

## Native watcher coalescing acceptance — 2026-09-07

The coalescing fixture now holds the first real directory-listing result while
an E2E-only application-side coordinator performs three sequential real backend
writes. Each write subscribes before IPC and requires a fresh same-directory
frontend receipt with a backend observation timestamp at or after that write.
The driver verifies distinct acknowledgements inside the held interval, exactly
one trailing listing, and all three filenames in the rendered result. WebDriver
no longer has to observe the app during an arbitrary five-second hold.

The protocol has a 15-second deadline, explicit cancellation on probe replacement,
and listener/timer cleanup. A stalled IPC response cannot retain the hold after
its receipt arrives. Already-running backend write IPC is not cancellable; timeout
releases the fixture and reports failure rather than claiming the mutation stopped.
Production refresh policy is unchanged. Receipt timestamps are captured in the
application callback; receipt-count increases alone cannot acknowledge older
backend events.

Validation: 43 focused watcher/refresh/protocol contracts pass across six files;
typecheck and architecture lint pass. Both real Linux native watcher cases pass
on the final rebuilt fixture (`/tmp/watcher-protocol-native-final.log`), including
adaptive cadence recovery. Independent review confirmed ordering and cleanup.
A normal build excludes the helper entirely (a literal build flag prevents an
otherwise orphaned dynamic chunk); startup remains 44 chunks and 640,144 raw bytes
/ 207,954 gzip bytes, within budgets (`/tmp/watcher-protocol-bundle-final.log`).
These are local Linux outcomes, not Windows/macOS acceptance or launch measurements.

The review remains open. Next native work is isolated child-window creation and
failure/reclamation diagnostics, followed by page-session ownership and the
remaining retention, viewport, product/platform and macOS startup gates.
