# Architectural review completion ledger — #680

Objective: implement the entire architectural review in `repo-health-review.md`,
including its remaining numbered recommendations and release acceptance matrix.
The earlier 121-file overhaul is the starting point, not the completion criterion.
No row is complete merely because its implementation exists or a mock agrees.

Current checkpoint (2026-09-08): directory observation now recovers from native
callback faults, overflow/rescan and root replacement, and observes existing-file
content/metadata changes. Both visible failures were reproduced against
`c1791a9a` before the fix. Two shared, lazy native observation sources retain
renderer-owned leases, isolate partial recursive registrations, preserve healthy
siblings and retry unavailable coverage through the existing flush worker.

Eleven Linux native outcomes across six specs pass, including replacement,
preview updates, refresh coalescing and window/reload/crash reclamation. All 485
Rust unit tests plus nine integration tests pass serially (seven ignored), and
strict Clippy, native test TypeScript and architecture lint pass. Two unchanged
parallel Rust tests failed but pass individually; their nondeterminism is recorded
in the acceptance artifact. The preceding 2,159 frontend tests and 30 performance
cases were not rerun for this backend-only change.

The initial listing/watch handoff gap, ordinary directory-cache publication
races, Tab-driven focus/selection consistency, broader platform/product/soak
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
| 8. Interaction consistency | Audit transition-all, semantic colors, address focus commands, theme controls; immediate pointer feedback, browser/native outcome coverage | 27 transition-all rules removed, 13 inactive aliases repaired, DnD uses semantic tokens. Ctrl+L targets active pane and respects hidden address bars/terminal ownership. Focused unit and Chromium address/theme/hover outcomes pass (all three file views). Independent review confirmed focus/transition contracts and exposed a white child-text override on bright accents; corrected to inherit on-accent color with a regression. Native maximize/restore and pointer-captured divider outcomes now pass, with stale-gesture and late-listener regressions and independent review. Graph detail expansion has a reproduced/fixed WebKit scrollbar feedback loop. The following checkpoint aligns the full graph header and metadata table, preserves complete reference access and restores native/custom button keyboard ownership in focused Chromium/WebKit, unit and integrated browser acceptance. The wider theme/native interaction matrix remains pending |
| Platform release acceptance | Windows ConPTY, macOS PTY, config replacement/autoreload, watcher soak; native suites on supported platforms | Linux baseline passes; Windows/Mac outstanding |
| Product acceptance | Built-in themes, accessibility/keyboard behavior, narrow splits, view modes, DPI/zoom, preview formats and plugin failure combinations | Dense split viewport policy implemented with all three views, zoomed pointer/keyboard resizing, saved-layout preservation and Chromium/WebKit acceptance; Linux window/transfer regressions pass. Inline SCM/Miller minimum contributions, hoist/unmount shrink and continuous zoomed resizing now pass targeted browser/native acceptance. The focused resize migration is implemented; the wider themes/accessibility/platform matrix remains outstanding |
| Final integration | Typecheck, architecture lint, source maps, unit/perf/Rust/native/browser/load acceptance, screenshots, updated ADRs/report and issue; independent falsification of structural/performance claims | Outstanding |

Every completion update must name the actual production seam, regression or
measurement, result and limitations. Platform gates stay open until directly
verified; scaffolding a runner does not satisfy the gate. Additional defects
found while implementing a row belong to the same objective.

## Historical evidence (superseded by current checkpoints)

### Graph snapshot coverage before the native observation service

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

## Native window acceptance and Windows attach environment — 2026-09-07

The isolated Linux concurrent-child test passed; all five transfer/close cases
then passed with automatic warm priming both disabled and enabled. The final
rebuilt application passes **eight native outcomes** across transfer and warm
lifetime suites, including real watcher updates after transfer/close, rejected
warm navigation with fresh fallback, and abandoned claim expiry after source
closure (`/tmp/window-environment-native-final.log`). The earlier Linux creation
failure remains unreproduced, not explained away.

Source inspection and Microsoft's WebView2 environment contract identified a
configuration mismatch in Windows E2E: main alone had explicit CDP arguments while
fresh/warm descendants shared its data directory with default arguments. A
Windows-and-Cargo-feature-gated plugin now injects the exact main argument string
into every spawning page; shared child options preserve it, and Rust's measure
window uses the same helper. This addresses the concrete mismatch underlying the
`0x8007139F` hypothesis; **Windows feature-build/native verification is pending**.
Normal frontend output contains neither the injected global nor the option.

Launch failures now record the destination label, stage and underlying error in
the rotating application log. Late native errors after timeout remain observable;
retirement stays idempotent. Warm creation failures retain their label/payload.
The propagation regression fails before the configuration fix; four diagnostic
contracts fail before the logging change (`/tmp/window-environment-before.log`,
`/tmp/window-launch-diagnostics-before.log`). All 29 focused launch/appearance/
warm/focus/tear-off contracts pass, typecheck is clean, and Linux strict Clippy
passes all targets with the attach feature enabled. That Linux compilation does
not compile the Windows-only block. Independent source review confirms plugin
inference/order, accepted WindowConfig key, release gating and lifecycle behavior.

Final integrated frontend acceptance: **2,047 unit tests passed, three skipped,
plus 30 performance checks**, across 228 unit files
(`/tmp/native-acceptance-integrated-unit.log`).

Normal startup: **44 chunks, 640,677 raw bytes / 208,148 gzip bytes**, within budgets
(`/tmp/window-environment-bundle-final.log`). The small diagnostic-code increase
is not a startup speedup claim. Source maps cover 360/360 files. No UI work merged.

Remaining: published Windows acceptance, unreproduced Linux creation failure if
it recurs, native Git leases on crashed windows, page-session ownership, dense
viewport policy, workspace/plugin/native soak, full product/platform matrices,
and actual macOS release half-bounce measurements. The entire review remains open.

## Page-session ownership and foreground readiness — 2026-09-07

The page delegates imperative setup to `state/window-session.ts` and retains
rendering, reactive appearance and the paint/readiness observation. The session
records each acquired subscription separately, rolls back partial setup, continues
cleanup after an individual cleanup failure, and retires queued commands and
warm priming. `domain/window-launch-plan.ts` preserves query/cwd/home precedence,
child restoration and inherited view policy as pure logic. Initial tab navigation
still starts synchronously, independently of settings and plugins.

Automatic warm priming now follows configured foreground readiness instead of a
wall-clock delay from mount. With deliberately slow config reads, the actual old
page primes before readiness in both Chromium and WebKit; the same browser test
passes with the session owner (`/tmp/window-session-startup-before.log`,
`/tmp/window-session-browser-final.log`). Timing is captured in the app world so
driver scheduling cannot invent the ordering. The fixture's completion timeout
accommodates its injected three-second config latency; it is not a performance
threshold. Unit tests also reproduce queued registration after teardown and
priming before core readiness against the mechanically extracted prior logic.

Native E2E hooks live in a separately compiled opt-in module. Its listeners,
readiness and result publication retire with the page, including a delayed import
which resolves after disposal. Independent review exposed a request which could
resume after lazy loading and dispatch native work after teardown; a regression
failed before adding the acceptance check around those imports. Already accepted
navigation, mutation and transfer work remains with its existing domain owner.
Window-scoped stores retain their data lifetimes. [ADR 0010](adr/0010-page-session-and-core-readiness.md)
records these boundaries; this is not a claim to cancel every window operation
on page teardown.

Validation:

- **2,070 unit tests passed, three skipped, plus 30 performance checks** across
  231 unit files (`/tmp/window-session-full-unit.log`). The new subset has 23
  session, launch-policy and probe contracts.
- **26 Chromium/WebKit outcomes passed** for startup readiness, slow-config
  ordering, title synchronization, keyboard/terminal ownership and address/modal
  focus (`/tmp/window-session-browser-final.log`). The inspected
  `session-startup-ready.png` demonstrates usable navigation and selection after
  readiness; timestamps and assertions establish priming order.
- **12 rebuilt Linux native outcomes passed** across transfer/close, warm
  activation/fallback/abandoned-claim expiry, real watcher coalescing/adaptive
  cadence and config autoreload (`/tmp/window-session-native-final.log`).
- Typecheck zero errors/warnings; architecture lint clean; source maps 363/363.
  Normal startup graph: **42 chunks, 640,696 raw bytes / 207,786 gzip bytes**,
  within budgets (`/tmp/window-session-bundle-final.log`). The native test-hook
  modules and readiness markers are absent from normal release assets. These
  are payload and readiness-order results, not macOS presentation latency.
- Independent review confirmed launch/restoration parity, synchronous navigation,
  picker/parked behavior, setup rollback and delayed-work/probe retirement.

The page orchestration recommendation is implemented within ADR 0010's scope.
The broader review remains open: crashed-window native Git lease reclamation,
dense viewport policy, workspace/plugin/native soak, Windows and macOS platform
acceptance, the full product/theme/accessibility/DPI matrix, and actual macOS
release startup measurements still require work. No merge or publication occurred.


## Native Git window ownership — 2026-09-07

Every native Git lease now carries the concrete calling window's lifetime token.
`git_watch.rs` creates it lazily in the native window's Tauri resource table;
`lib.rs` uses the concrete-window `Destroyed` hook to retire it. Both admission
lookup and retirement use the same resource-table lock. Old native handles retain
the retired token even if their label is reused, and no global closed-label
registry accumulates with window churn. Renderer arguments cannot select another
window's identity, and foreign lease releases are idempotent no-ops.

`git_watch/service.rs` propagates the token through bounded acquisition/release
commands. Native destruction flips cancellation state and requests a nonblocking
wake; a coalesced flag survives inbox saturation. The worker reclaims retired
leases before recovery and retains observers still shared with live windows.
Registration that finishes after its owner retires is drained before an ACK can
be returned. Native event handling does not wait for registration or observer
destruction. Closing windows which never used Git does not start the worker.
[ADR 0009](adr/0009-git-observation-leases.md) records the contract.

The regression first failed against the unchanged worker behavior with ownership
arguments mechanically added to expose its missing retirement boundary
(`/tmp/git-owner-before.log`: unreleased observer timed out instead of dropping).
The new native test acquires a raw acknowledged lease with no frontend cleanup
owner, destroys its source window, checks the worker's unique-repository
reclamation diagnostic, and verifies the surviving main window still navigates.
The diagnostic proves native-hook-to-worker delivery; Rust DropSignal tests prove
direct observer destruction. Neither establishes completion of asynchronous
notify backend teardown or kernel watch/FD drainage.

Validation:

- **446 Rust tests passed, seven ignored** (`/tmp/git-owner-rust-full.log`).
  The final focused ownership/observation subset passed independently: **17 passed,
  one manual measurement ignored** (`/tmp/git-owner-independent-review.md`).
  Cases cover shared ownership, foreign releases, destruction before the first
  command, old/replacement native handles, blocked registration, and 128 pending
  acquisitions against the 64-slot inbox.
- **Five rebuilt Linux native outcomes passed** (`/tmp/git-owner-native.log`):
  destruction reclamation plus hidden graph invalidation, retained pagination,
  staged/unstaged real diffs, and observation recovery after root replacement.
- **11 focused frontend contracts passed** for graph coverage, ordered watch
  ownership and page-owned probes (`/tmp/git-owner-frontend-tests.log`). Typecheck
  has zero errors/warnings; strict Clippy across all targets, architecture lint and
  363/363 source-map coverage pass.
- Normal startup remains **42 chunks, 640,700 raw bytes / 207,786 gzip bytes**,
  within budgets (`/tmp/git-owner-bundle.log`). New native fixture operations and
  the page-session probe are absent from normal release assets. No launch-time
  speedup is claimed.
- Independent review found and prompted closure of the adapter admission gap;
  final worker/adapter interleavings and regression tests have no outstanding
  concrete defect. The current Tauri adapter uses installed version 2.11.2.

This closes native-window destruction ownership, not renderer crash/reload while
its native window remains alive. Windows/macOS destruction acceptance, large-tree
costs and native OS resource drainage remain open, alongside dense viewport work,
workspace/plugin soak, product/platform matrices and measured macOS release
startup. This batch has no user-visible layout change and needs no new screenshot.
No publication, merge or full-review completion is implied.


## Dense pane viewport ownership — 2026-09-07

`domain/pane-viewport.ts` separates saved layout preference from available space.
Two linear passes calculate descendant minima and place the constrained canvas,
including divider gaps. The window manager owns measured presentation state;
rendering, directional focus and dwindle consume its shared leaf rectangles.
`PaneContainer` reveals the active pane inside its own scrollable workspace.
`use-pane-dividers.svelte.ts` owns one captured pointer/keyboard resize lifetime,
using the existing coalesced-frame and tab-incarnation guards. Separator keys
preserve file selection and cancel pending chords while other global shortcuts
remain available. See ADR 0011 for contracts and limits.

Evidence:

- Before the fix, the dense 16-pane restoration test found the active file in
  the DOM but outside the viewport in both engines (`/tmp/pane-viewport-before.log`).
  After the fix it is reachable/selectable, focusing the opposite pane reveals
  its files, and the captured saved layout is unchanged.
- **46/46 Chromium/WebKit cases pass**: dense restoration; Details/List/Tiles at
  150% zoom in island mode; pointer ratios at 80%/150%; keyboard arrows/Home/End
  with unchanged per-pane selection and working palette; scroll-cancelled frames;
  existing directional focus, gesture lifetime and deferred materialization.
  Final log: `/tmp/pane-viewport-browser-accepted.log`. No page errors in the new
  viewport scenarios. Inspected proof: `screenshots/refactor/repo-health-cleanup/dense-pane-viewport.png`.
- An independent zoom diagnosis corrected the fixture, not production math.
  Ratio alone cannot detect measurement settlement after zoom. WebKit's settled
  canvas also differs from client dimensions because of scrollbar accounting.
  The final fixture observes changed, stable canvas geometry before sampling
  drag coordinates; the final 55% outcome assertion remains intact.
- **233 unit files: 2,080 passed / 3 skipped**, plus **30 performance tests**
  (`/tmp/pane-viewport-all-units.log`). Behavioral contracts cover descendant
  constraints, preference recovery, measured directional neighbors, 256-leaf
  linear extent, invalid measurements, local reveal and keyboard ownership.
- **6 real Linux outcomes pass**: native maximize/restore preserving navigation,
  concurrent children, acknowledged last-tab transfer, split tear-off, large
  active-layout transfer and window-specific close. Both native spec files pass
  against a fresh E2E-enabled binary (`/tmp/pane-viewport-native.log`). These are
  native integration regressions, not native zoom/assistive-technology acceptance.
- Typecheck: zero errors/warnings. Architecture lint clean; source-map coverage
  **366/366**. Normal startup graph: **42 chunks, 645,059 raw / 209,356 gzip bytes**,
  within existing budgets (`/tmp/pane-viewport-bundle.log`). This adds 4,359 raw /
  1,570 gzip bytes over the prior checkpoint; no startup latency improvement is
  claimed. Rust production code is unchanged in this batch.
- Independent adversarial review passed 33 focused tests and found no blocking
  defect in geometry, saved preference preservation, gesture retirement or
  keyboard routing (`/tmp/pane-viewport-independent-review.md`). Startup findings
  establish static ownership/complexity only. Persisted depth/node validation
  bounds recursive input before geometry is reached.

The 240 × 200 base leaf minimum does not account for wide optional SCM/Miller
panels. Their width contributions and resize ownership need further acceptance.
Before the first usable measurement, focus/dwindle retain their previous fallback.
This does not virtualize every retained pane, certify assistive technology, prove
native platform zoom equivalence, or satisfy the macOS half-bounce target.
Publication, merge, full review completion and the remaining ledger gates remain
open. Existing generated native screenshots were restored after the regression
run; the new dense viewport screenshot is retained.


## Optional panels and resize ownership — 2026-09-07

Mounted inline SCM/Miller panels now contribute their CSS width through unique
leases in the window-owned pane viewport model. Their widths add to the base
file-content minimum, and hidden/empty/hoisted panels release their contribution.
No visibility rules or persisted widths are duplicated in the manager, and no
presentation constraint rewrites saved tab ratios.

`domain/panel-width.ts` contains normalization, zoom conversion and keyboard
policy. `state/panel-resize.ts` owns coalesced publication and persistence;
`use-panel-resize.svelte.ts` adapts pointer capture and temporary global listeners.
Sidebar/SCM/Miller share one focusable handle component; Git author/date columns
retain their compact styling with the same owner. Capture failure rolls back;
blur, scroll, resize, root style/zoom changes and teardown retire captured work.
Cancellation retains only already-rendered width; release flushes the final move.

`resize-activity.svelte.ts` separately owns window-wide gesture leases. Automatic
workspace reveal pauses during manual resize, then reconciles after the gesture's
scroll listener and pointer capture have retired. This is separate from inline
width contribution because global Sidebar and hoisted panels change the measured
viewport without occupying space inside a pane.

Reproductions and independent findings:

- Original zoom tests failed in both engines: a 60px visual drag moved the Sidebar
  48px at 80% zoom and 90px at 150%. Blur left the old drag active; panel separators
  lacked keyboard sizing. `/tmp/panel-resize-before.log` records 12 failures.
- Optional-width regressions failed in all three views in both engines. An
  independent 800×600 repro measured Miller200 + SCM280 against275px of pane
  content: the file list was0px and a real click failed. `/tmp/panel-width-before.log`.
- Continuous inline resizing initially stopped after one frame. Instrumentation
  proved that the first panel width update grew canvas720→730, automatic reveal
  changed scrollLeft332→0, and captured scroll cancellation correctly retired the
  owner. The same issue reproduced for the global Sidebar. Shared activity fixes
  the coordination without suppressing real scroll cancellation.
- Independent review found a pointer-capture exception rollback gap, now fixed.
  Final review finds no remaining concrete ownership/layering defect;
  `/tmp/panels-independent-review.md`, 17 focused tests passed.
- Strengthened browser assertions check file names are in the viewport after
  explicit pane focus and before clicking; clicks cannot supply hidden scrolling
  assistance. Tests also cover unmount/hoist geometry shrink, malformed storage,
  stale leases/frames, capture failure, zoom mutation, continuous narrow-workspace
  drags and inverted Git columns.

Validation:

- **235 unit files: 2,089 passed / 3 skipped**, plus **30 performance tests**
  (`/tmp/panels-all-units-accepted.log`). The final identity guard keeps an old
  finish callback from cancelling a replacement started during publication;
  its reentrant behavior regression also passed independent review.
- The **160-case affected browser run** had **156 passed / 2 skipped / 2 failed**
  (`/tmp/panels-browser-final.log`). All 32 new panel cases and existing pane
  viewport scenarios pass across Chromium/WebKit, including all three file views.
  The two failures were existing WebKit PR/CI detail interactions; both passed
  once and then all six repeated isolated executions. A separate probe observed
  no reload from writing the evidence screenshot. This does not establish the
  wider-run cause or rule out an intermittent application defect. Keep the wider
  WebKit acceptance gate open (`/tmp/panels-webkit-diagnosis.md`). A ResizeObserver
  loop warning was also logged in the wider Git graph run; no clean full-run
  console or unconditional full-suite pass is claimed.
- **Seven real Linux outcomes pass**: narrow split/Miller/SCM/real-file interaction
  and keyboard selection, plus six window chrome/transfer regressions
  (`/tmp/panels-native.log`). The new test also passes independently with a
  contained fixture for its screenshot (`/tmp/panels-native-proof.log`). Native
  Windows/macOS and native zoom equivalence remain unverified.
- Typecheck: zero errors/warnings; strict architecture lint clean; source-map
  coverage **371/371**. Normal startup: **42 chunks, 648,778 raw / 210,727 gzip bytes**,
  within budgets (`/tmp/panels-bundle.log`), up 3,719 raw / 1,371 gzip from the prior
  checkpoint. No launch latency improvement is inferred from these sizes.
- New browser panel scenarios assert no page errors. Exercising Miller outside
  Tauri exposed its unguarded native event registration; it now checks the runtime
  and reports native registration rejection instead of leaving an unhandled
  promise. Local mutation subscriptions retain their existing ownership.
- Inspected screenshots: `inline-panels-{details,list,tiles}.png` and
  `native-inline-panels.png` in `screenshots/refactor/repo-health-cleanup/`.
  Previously committed images regenerated by the suites were restored.


Remaining scope: the Git graph gutter still uses its own automatic-width/mouse
resize path, and other custom resize surfaces need separate audit. Larger theme,
DPI and assistive-technology combinations, native Windows/macOS acceptance and
actual macOS half-bounce measurements remain open. No startup speedup or full
review completion is claimed. See ADR0012.


## Graph gutter automatic/manual sizing — 2026-09-07

The Git graph gutter now uses the shared panel resize owner with an explicit
controlled `.graph-clip` element. Private document mouse listeners and body style
overrides are gone; pointer capture, zoom conversion, coalescing, keyboard sizing
and teardown follow the same contracts as other panel controls. Pane dividers also
roll back their owner if native pointer capture fails.

`createPanelResize` now distinguishes an absent manual preference from a numeric
width. A live automatic source is derived while idle and bounded by the same
range as manual sizing (28–800px for the graph). During a gesture its displayed
origin is captured. No-op movement, untouched cancellation and clicks keep the
source automatic. An effective pointer or keyboard change pins the preference;
a move away and back still counts as an explicit choice. Retirement captures the
completed preference before publishing, so reentrant callbacks cannot substitute
a replacement gesture's result.

Before implementation, ten Chromium/WebKit regression cases failed: incorrect
zoom distance, missing keyboard range control, late persistence after graph
retirement, and pane-capture failure leaving resize state active. The original
failure log is `/tmp/graph-resize-before.log`.

Unit verification passes: 235 files / 2,092 tests (three skipped), plus 30
performance cases. Architecture lint is clean and source maps cover 371/371 files.
All 58 combined graph-gutter, shared-panel and pane-lifetime browser scenarios
pass in Chromium/WebKit. The graph test proves automatic topology changes and
manual preference restoration after closing/reopening the graph. Typecheck has
zero errors/warnings. The rebuilt Linux binary passes the real-file inline-panel layout and keyboard
regression. The normal startup graph is 42 chunks / 649,109 raw bytes / 210,846 gzip
bytes, within budget. This is payload acceptance, not measured macOS launch time.
The inspected keyboard screenshot shows the focused gutter control and preserved
commit selection; native evidence shows a real file reachable beside inline panels.

Independent review found no production blocker and prompted stronger browser
outcomes for topology changes and failed pointer capture. A diagnostic initially
mistook four lanes at 56px for stale width; the source uses 14px lanes, so that
observation was correct. The actual fixture error was deselecting every branch,
which removes the gutter. The replacement test uses a nonempty file-filtered
history and asserts lane-count changes before checking automatic/manual widths.

The related audit found remaining work in Details-column queued frame ownership,
Preview dock/axis lifetime, and Terminal pointer lifetime/counter-zoom conversion.
Preview and Terminal also persist full settings on raw pointer moves. These need
a shared bounded scalar gesture pattern with captured axis/model scale and a
separate durable commit; their existing implementations are not claimed migrated.
The wider WebKit PR/CI detail run failures from the preceding checkpoint, native
Windows/macOS matrices and measured macOS half-bounce startup remain open.


## Scalar resize ownership and controlled Terminal height — 2026-09-07

The former width-only implementation now composes three layers: pure bounded
scalar geometry (`resize-size`), captured gesture/draft ownership (`scalar-resize`),
and DOM capture/activity lifetime (`use-resize-owner`). Persisted fixed/automatic
widths adapt the core through `panel-resize` / `use-panel-resize`; externally owned
sizes use `use-controlled-size`. Existing Sidebar/SCM/Miller/Git controls consume
the same value contract. No compatibility copy of the old width geometry remains.

Terminal now uses the controlled adapter. Its counter-zoomed element has net CSS
zoom one, but its model height is multiplied by app zoom. The adapter therefore
supplies that app zoom as visual pixels per model unit. Integer normalization
happens before rendering as well as persistence. Primary pointer capture, blur,
zoom/scroll/resize cancellation, hiding, unmount, keyboard arrows and range bounds
share the same lifetime. Draft frames no longer replace the settings object or
save the whole configuration on every pointer sample; accepted retirement commits
once. A keyboard step during an active pointer gesture first retires that gesture,
then commits the distinct keyboard adjustment.

Controlled source/options supersession is checked synchronously before queued
publication, after DOM retirement before committing, and before key ownership is
interpreted. The reactive effect makes idle presentation reconcile promptly but is
not the correctness gate: an external value delivered just before pointer release
cannot be overwritten by an old draft. Automatic topology sources deliberately
retain captured-origin semantics. Source supersession is value-based; an external
A→B→A update coalesced before observation is not claimed as a distinct revision.

Before implementation, all 12 Terminal browser cases failed in Chromium/WebKit:
60px pointer movement became 48px at 80% and 90px at 150%, stale gestures survived
blur/hide, old pointer input overwrote an external height, and keyboard sizing was
unavailable. A later feature-disable/unmount regression also failed against the
actual pre-fix component in both engines. Independent review exposed four
synchronous source-retirement races and an axis-before-key ownership gap; their
new regressions failed before the core fixes and now pass.

Current verification: 236 unit files / 2,105 tests pass (three skipped), plus 30
performance cases. All 80 final Chromium/WebKit scenarios pass, including shared
panel/graph/pane resize contracts, Terminal feature-disable/unmount and existing
theme/close behavior. Typecheck has zero errors/warnings; architecture lint is
clean and maps cover 374/374 source files.

The rebuilt Linux binary passes a real-PTY resize case: populated scrollback,
two continuous pointer steps at 150% zoom, 60px measured visual growth, keyboard
geometry change and a subsequent command's echo plus executed output. Five
existing native Terminal behavior cases also pass; the OSC7 case is skipped
under bash. The new native case is Linux-only, not Windows/macOS acceptance.
The normal startup graph is 43 chunks / 650,380 raw bytes / 211,520 gzip bytes, within
budget. This is payload acceptance, not launch-time evidence. The inspected native
screenshot shows a live resized shell and executed command; browser mock-shell
screenshots are not used as proof of native terminal functionality.
Independent adversarial review accepts the final core and Terminal integration.

Preview and Details retain their custom resize implementations and remain next
migration work. Full release acceptance, prior wider WebKit detail failures,
Windows/macOS native acceptance and measured Mac half-bounce startup remain open.


## Keyed Details column sizing — 2026-09-07

Details now composes one controlled scalar owner with session-local column widths.
The column key changes only after the previous owner retires, so its published
width commits to the old column and pending frames cannot alter the replacement.
Pure `detail-columns` policy owns defaults, normalization, visibility projection
and bounds. Name retains its 150px minimum; other columns retain 80px minima.
The deliberate 4096px maximum bounds extreme layout and gives keyboard End a
finite destination. Widths remain local to the mounted Details view.

The shared DOM owner identifies a gesture by both pointer ID and captured handle.
Clearing both before release rejects synchronous loss; checking both on later
move/release/cancellation rejects delayed events from an old handle after a
replacement has acquired the same pointer. A deterministic late-loss regression
failed in both engines before this fix. A stronger case establishes real Name
capture with mouse movement, requests Date capture using the live pointer ID,
then resumes real mouse movement: browser-generated old-target loss cancelled
the replacement before the fix, and both engines now retain Name=330/Date=210.
Only the ownership-transfer request in that case is programmatic.

Blur, hidden optional columns and unmount retire the owner. Column separators
are keyboard-focusable, expose their current range and share one declarative
handle snippet. Arrows/Home/End change only the focused column, preserve sorting
and selection, and retain immediate hover feedback. The original mouse/frame
loop and component window listeners are removed.

The old implementation failed blur, queued replacement-column and keyboard
regressions in both engines. Final Details acceptance passes all 20 scenarios,
including continuous visual movement at 80/150% zoom, hidden-width restoration,
key switching, real capture transfer, and usable file selection after unmount.
The full unit suite passes 2,108 tests in 237 files (three skipped), plus 30
performance cases. Typecheck has zero errors/warnings. Architecture lint is clean,
maps cover 375/375 source files, and startup payload remains within budget at
43 chunks / 651,306 raw bytes / 211,896 gzip bytes. These are payload measurements,
not evidence of launch-time or the macOS half-bounce target. Independent review accepts
the final key ordering, target identity, geometry and keyboard integration.

The combined browser run passes 92 scenarios, skips the Chromium-calibrated
virtualization case on WebKit, and fails one existing WebKit graph-filter setup
before any resize input. Three isolated repetitions pass in 16.7 seconds. This does not establish the
cause of the wider-run failure; it remains an integration acceptance item.
Preview still has its private resize implementation. Native Windows/macOS,
measured macOS half-bounce startup and full release acceptance remain outstanding.


## Preview sizing and teardown-safe persistence checkpoint — 2026-09-07

Preview now composes the shared controlled-size adapter with pure dock policy.
Right controls width; top/bottom control height with opposite growth directions.
Raw zero keeps its default encoding until an effective adjustment. Pointer and
keyboard calculations clamp to bounds without reinterpreting calculated zero as
that source sentinel. Drafts publish once per frame without per-pointer settings
writes; release commits final input, interruption keeps only published movement,
and source/options changes synchronously discard obsolete work. The separator
supports keyboard bounds, range semantics and immediate pointer feedback.
Fullscreen removes it after retirement; links and other interactive descendants
do not also trigger pane fullscreen on double-click.

Cross-axis docking and hiding after a published drag exposed a shared framework
boundary defect. Svelte teardown read historical settings, and the size setter's
whole-object update restored the old dock/visibility. Resource release now stays
synchronous while a returned, idempotent finalizer validates live source/options
after `tick()`. Handle retirement allows replacement input; owner disposal closes
admission. Input identity and reentrant callback checks prevent stale completion
or publication. This also fixes Terminal disable after a published drag. ADR0012
and lesson680 record the exact contract and demonstrated failure mechanism.

Before-fix evidence: 28 valid Preview contract cases failed against the private
implementation; six later dock/hide cases exposed the shared teardown defect;
the Terminal disable regression fails in both engines with the old teardown hook
restored. Source sentinel, superseded projection and reentrant disposal/publication
unit regressions also failed before their corresponding fixes. Fixture-only failures
from a nonexistent mock file and reload reseeding were corrected separately and
are not counted as product defects.

Final integrated browser acceptance passes all 148 cases across Chromium/WebKit,
including 38 Preview contract cases plus existing media, dock/fullscreen, Terminal,
Details, graph-gutter and panel outcomes. Full units pass 2,127 in 239 files (three
skipped) plus 30 performance cases. Typecheck has zero errors/warnings; architecture
lint is clean; maps cover 376/376 source files. Independent adversarial code review
accepts the final lifecycle and reentrant publication guards. Normal startup payload
is 44 chunks / 651,947 raw bytes / 212,210 gzip bytes, within budget. This is not
macOS launch-time evidence. Logs: `/tmp/preview-acceptance-browser.log`,
`/tmp/preview-acceptance-units.log`, `/tmp/preview-acceptance-check.log`,
`/tmp/preview-arch.log`, `/tmp/preview-bundle.log`.

The focused resize migration is implemented. Existing intermittent WebKit graph
filter and PR/CI detail failures remain wider integration items; a passing targeted
run does not establish their cause. Renderer crash/reload retention, broader
product/load/platform acceptance and actual Mac half-bounce measurements remain
open. The comprehensive review is not complete.


Native Preview acceptance passes one real Linux scenario in four seconds against
the rebuilt binary (`/tmp/preview-resize-native-run6.log`). It verifies continuous
30/60px visual growth at 150% zoom, independent dock dimensions, a published bottom
draft interrupted by keyboard-selected docking while the pointer remains held,
inert late input, fullscreen filling the 1280×900 viewport, exact restoration,
keyboard bounds and readable real markdown throughout. The inspected screenshot
is `screenshots/refactor/repo-health-cleanup/native-preview-resize.png`. Active hide
is covered in the browser suite, not this native scenario. Earlier native retries
exposed a test-only root-rect assumption (GTK's fixed-layout html has zero height)
and the separate Preview command availability bug below; the fullscreen pane itself
matched the actual viewport.

The native setup also exposed a command-policy defect (fixed in the following checkpoint): Preview's command
`when` rejects focused text inputs, including the palette's own search. A browser
regression now fails in Chromium and WebKit; ordinary Space editing passes. The following checkpoint removes the duplicate input gate, retaining shared
keyboard routing as the input-ownership boundary.


## Preview command availability checkpoint — 2026-09-07

Removed Preview's DOM-focus condition from command metadata. Palette search and
explicit execution now remain available while the palette's own input has focus.
Shared `resolveWindowKey` still protects text inputs, contenteditable, modals and
terminal-owned input before keybinding lookup, including custom bindings. No second
availability or input-routing abstraction was introduced. Removed the obsolete
unit-test document stub that existed only to satisfy this predicate.

The new browser regression fails in Chromium and WebKit before the fix; its Space
editing/file-toggle companion already passes. After the fix all 14 command/address
cases pass across both engines, and 44 command-registry/definition/keyboard unit
contracts pass. Typecheck has zero errors/warnings. Independent review confirms
availability and input-ownership contracts. Logs: `/tmp/preview-command-before.log`,
`/tmp/preview-command-after.log`, `/tmp/preview-command-units.log`,
`/tmp/preview-command-check.log`. The earlier full resize/unit acceptance remains
recorded in the preceding checkpoint; these focused counts do not represent a new
full-suite run.


The rebuilt native scenario also passes (one scenario, 4.9 seconds,
`/tmp/preview-resize-native-final.log`). Initial opening uses normal Space;
full-word palette search then hides and reopens Preview after all zoom/dock/
fullscreen/keyboard checks, with the real markdown marker restored. The earlier
native setup failed this exact palette search before guard removal. Architecture
lint and 376/376 map coverage remain clean. Final normal startup payload is
44 chunks / 651,836 raw bytes / 212,142 gzip bytes, within budget
(`/tmp/preview-command-bundle.log`). These results do not establish Mac startup
latency or complete the remaining release gates.


## Renderer generation and native Git reclamation checkpoint — 2026-09-07

The existing native-window owner outlived a reloaded renderer. An acknowledged
lease with no frontend cleanup survived replacement indefinitely even though the
same native window returned a usable listing. The new real-binary regression fails
before the fix while native-window destruction still passes
(`/tmp/git-renderer-before.log`). This is a distinct boundary from the already
implemented native-window retirement and observer runtime recovery.

`git_watch/scope.rs` now owns a generation and cancellable observer owner beneath
the concrete window resource. Tauri page-load Started advances and retires existing
ownership. The frontend lazily acknowledges `git_watch_session` once per JS realm;
watch/unwatch must carry that session. Native lookup under the retirement locks
rejects delayed obsolete acquisition and treats obsolete release as an idempotent
no-op. Requests already sent to the worker retain the cancelled old owner. Close
is terminal; late page callbacks cannot reopen a destroyed native window. Windows
without Git ownership allocate neither a slot nor a worker on page load. No idle
polling was added. ADR0009 records the single-app-Webview-per-Window assumption,
committed-load event mapping and the separate blank-crash boundary.

Verification:

- 19 targeted Rust Git-watch tests pass, one ignored. New generation and native
  adapter contracts cover old-owner rejection, observer disposal, replacement
  release isolation, repeated page starts without Finished, unused-window laziness,
  concrete-window independence and close followed by a late load event. Existing
  held-registration and saturated-inbox cancellation contracts also pass.
- Full Rust library: 448 pass, seven ignored (`/tmp/git-renderer-full-rust.log`).
  Strict all-target Clippy passes (`/tmp/git-renderer-clippy.log`).
- Full frontend: 2,130 pass in 240 files, three skipped, plus 30 performance cases
  (`/tmp/git-renderer-full-units.log`). API contracts cover lazy concurrent handshake,
  retry after acknowledgement failure, release identity and failure to adopt a
  replacement generation after watch rejection. Typecheck has zero errors/warnings.
- Independent Linux binary verification: six scenarios pass across native-window
  and Git-cache suites (`/tmp/git-renderer-native-independent.log`). The reload test
  repeats twice with the same native handle and real `survivor.txt` listing, requiring
  a new worker reclamation log after each previously acknowledged lease. Existing
  hidden-cache invalidation, pagination, diff and recovery remain healthy.
- Native reclamation evidence is a repo-qualified worker log after accepted work;
  Rust tests separately observe actual observer disposal. This is not an OS-handle
  census or a native overlap/crash race test. Independent architectural review
  confirms generation, delayed IPC, terminal close and lazy-startup contracts.
- Architecture lint and maps377/377 pass. Startup remains within budget at 44 chunks /
  651,970 raw bytes / 212,228 gzip bytes (`/tmp/git-renderer-bundle.log`). This measures
  payload, not elapsed launch time or the Mac half-bounce target.

A crash followed by reload is reclaimed at page replacement. A renderer that stays
blank after crashing still requires native WebKitGTK/WebView2/Apple termination
handling and platform acceptance. Larger repository cost, watcher OS-resource census,
scaled retention, full integration and actual Mac startup measurements remain open.


The native window suite also passes its final evidence run (2/2 in 2.7 seconds,
`/tmp/git-renderer-native-evidence.log`). The inspected
`screenshots/refactor/repo-health-cleanup/native-renderer-reload.png` demonstrates
post-reload listing usability; it is supporting UI evidence, not proof of resource
reclamation by itself. The Git-cache suite's automatically regenerated historical
screenshots were restored to avoid unrelated image churn.


## Native renderer termination checkpoint — 2026-09-07

This supersedes the earlier blank-renderer limitation above. The native Git
adapter now listens to WebKitGTK/WebView2 process termination; Apple connects its
Tauri termination hook. Linux/Windows defer per-Webview registration until the
first Git session request. UI-thread registration records success before sending
an acknowledgement, so cancellation cannot lose an installed handler or duplicate
it on retry. The native acquisition helper also rejects direct IPC before listener
installation. Callbacks capture only a weak owner, advance the generation and wake
the existing worker without waiting for its blocking observation teardown.

- The pre-fix Linux test killed only WebKit renderer descendants of the exact test
  executable with its isolated XDG configuration. The acknowledged unique-repo
  observer remained retained for ten seconds while the application process lived
  (`/tmp/git-renderer-crash-before.log`). After the fix, two independent executions
  pass the same blank-page reclamation contract (`/tmp/git-renderer-crash-fixed-1.log`
  and `...-fixed-2.log`). No DOM or reload request is issued during the blank phase.
- Linux native window/reload and cache regression suites pass six cases
  (`/tmp/git-renderer-regression.log`). Ordinary reload now reacquires a fresh unique
  repository each cycle and requires its real post-acquisition filesystem mutation
  to arrive through the native watcher. Delayed events from older roots cannot
  satisfy that assertion. This is ordinary reload coverage, not crash recovery.
- The direct-IPC registration contract fails before the native guard and passes
  afterward (`/tmp/git-termination-guard-before.log`). Final Rust library validation
  passes 449 tests, seven ignored (`/tmp/git-termination-full-rust-final.log`);
  strict all-target Clippy passes (`/tmp/git-termination-clippy-final.log`).
  Typecheck, architecture lint and three focused frontend Git-session contracts pass.
  Source maps cover 378/378 production files.
- Independent review confirms UI-thread installation/acknowledgement ordering,
  weak callback ownership, platform exit filtering and acquisition enforcement.
  Installed Wry source confirms that destroying a Webview before queued registration
  drops the callback and its oneshot sender, causing an error rather than a hanging
  acknowledgement. That race has source-level verification, not a new native test.
- Windows WebView2 calls compile in an isolated API check using the exact production
  registration body and a matching controller wrapper. This is not a full Windows
  application build: MinGW is absent and the Nix cache could not supply it.
  Windows and Apple runtime crash/lifecycle acceptance remain outstanding.

WebKitWebDriver deletes its automation session after the renderer crashes. The
attempt to reload the surviving application therefore failed with `invalid session
id` (`/tmp/git-renderer-crash-final.log`). Same-process crash recovery and possible
delayed termination notifications against recovered ownership remain an explicit
acceptance gap. The native PID check establishes process existence, not continued
UI responsiveness. Repo-qualified worker logs establish lease reclamation; they are
not an OS watch-handle census. Native Webview recreation inside a surviving Window
would require moving the installation identity to that new incarnation.

No Mac half-bounce claim follows from these checks. Workspace/plugin churn, scaled
soak, broader product/platform acceptance and final integration remain open.


Final guarded-binary acceptance also passes the blank-crash case (1/1,
`/tmp/git-renderer-final-guard-crash.log`) and native-window/reload cases (2/2,
`/tmp/git-renderer-final-guard-window.log`). After each ordinary reload, the test
requires native delivery for a fresh repository's mutation, navigates to that
repository and asserts the created file is visible. The inspected updated
`native-renderer-reload.png` shows `observed-after-reload-2.txt` in the recovered
ordinary-reload session; it is not crash-recovery evidence. The four historical
Git-cache screenshots regenerated by their runner were restored unchanged.


## Plugin lifecycle and workspace retention checkpoint — 2026-09-07

The registry now publishes real activation completion before invoking a plugin,
marks failed/cancelled activation retired before cleanup hooks, and publishes its
shared shutdown drain before active hooks can re-enter it. Active deactivation
removes the entry and context before the hook, permitting a fresh registration of
the same command/provider without collision or stale cleanup. Four production-import
regressions failed before the fixes: recursive disposal/duplicate job teardown,
enabled-but-inactive self re-enable, lost retry after partial activation failure,
and shutdown completing while activation remained held. Logs:
`/tmp/review-plugin-reentrancy-before.log`,
`/tmp/review-plugin-activation-before.log`.

Independent review accepts the final lifecycle behavior. The final focused plugin
and job suite passes 66 tests; mixed-plugin churn performs 5,001 activations using
real context/command/menu/settings/provider/dialog stores, including concurrent
plugins and repeated partial activation failure. It asserts visible singleton
effects, full contribution retirement and exactly-once job-owner disposal. This
checks resource contracts, not native AI services or every built-in plugin pairing.
Full frontend validation passes 2,135 tests in 241 files (three skipped), plus 30
performance cases (`/tmp/review-retention-full-units.log`). Typecheck reports zero
errors/warnings; architecture lint and maps 378/378 pass. Startup payload remains
within budget: 44 chunks, 651,987 raw / 212,258 gzip bytes
(`/tmp/review-retention-bundle.log`); this is not a native startup measurement.

A new UI-driven load test saves/restores single-pane and split/graph workspaces via
the real palette/dialogs. Every transition asserts restored tab/pane counts, the
correct repository graph and actual directory contents. At 150 cycles, all three
churn cases pass without retries (`/tmp/review-final-scaled-churn.log`):

| Workload | Post-warmup JS heap | Final JS heap | Delta |
| --- | --- | --- | --- |
| 150 graph-tab open/close cycles | 25.2 MiB | 29.7 MiB | +4.5 MiB |
| 150 graph toggles | 25.4 MiB | 27.6 MiB | +2.2 MiB |
| 150 expanded/base workspace replacement pairs | 26.58 MiB | 30.03 MiB | +3.45 MiB |

Workspace post-GC samples at cycles 0/25/50/75/100/125/150 were
26.58/28.98/29.90/30.90/30.29/29.72/30.03 MiB. DOM nodes/listeners varied, including
9,838/764 at cycle 75 and a return to the baseline 4,624/362 at cycle 125; the final sample was
4,726/366. This run does not show monotonic DOM retention. Counters are diagnostics,
not a separately enforced budget, and pending asynchronous work can affect samples.
All cases enforce the existing +25 MiB retained-renderer-heap cap. These are bounded
mock-browser workloads with forced Chromium GC, not proof of leak freedom, a native
resource census, hours-long soak, or Mac launch latency.

The shared tab-creation load helper now waits for a newly active stable tab ID.
Counting DOM tabs is invalid while closed tabs remain mounted for keyed outros.
Earlier diagnostics also overlapped development-source/generated-output changes;
those runs cannot establish a product navigation defect. Final measurement ran with
source and generated SvelteKit output frozen. No product navigation workaround or
relaxed memory budget was introduced.


The remaining four load cases also pass without retries
(`/tmp/review-final-remaining-load.log`), completing all seven bounded load cases:
12 graph tabs, 5,000-commit pagination with bounded DOM, actual 4x CPU throttling,
and survival under a 256 MiB V8 old-space cap. Independent verification confirms
all outcomes and scope. The final workspace image run passes separately (one cycle,
`/tmp/review-workspace-retention-image.log`); inspected
`screenshots/refactor/repo-health-cleanup/workspace-retention.png` shows the restored
split, populated graph and directory listing. The screenshot run does not replace
the 150-cycle measurement. Every load runner stopped and released port1430.


Chromium and WebKit integration also passes all 28 plugin/pane/workspace outcomes
without retries (`/tmp/review-retention-browser.log`): enabling and invoking commands,
context-menu effects, virtual directory contents, disabling contributions, split/tab
closure, pane restoration and saved-workspace reopening. These are details-view
checks; broader view/theme/accessibility/native matrices remain open. Backend source
is unchanged by this checkpoint, so prior Rust/native evidence is retained rather
than represented as a fresh native integration run.


## Rejected native tab-transfer destinations — 2026-09-07

`e2e-tauri/specs/window-transfer-rejection.spec.ts` exercises the existing
`sendTabToWindow` / `beginTabTransfer` handoff through actual Tauri routing and its
normal acknowledgement timeout. It never supplies a synthetic acknowledgement.
The rebuilt Linux binary passes both cases (four destination scenarios) in 47.5
seconds (`/tmp/window-transfer-rejection-native-final-5.log`):

- A nonexistent label rejects the transfer.
- A real child is destroyed, confirmed absent by native lookup, and rejects it.
- A ready parked warm window is confirmed present and natively invisible. It
  rejects the transfer; activating that exact label afterward still reveals just
  its one original warm-directory tab/pane.
- A real native Webview running the picker route lists the requested directory,
  has no Explorer tabs and remains unchanged after the transfer times out.

After every rejection, the source retains its stable active tab ID, active path,
two panes and both original file listings. A unique file written afterward appears
without an explicit refresh. This establishes continued automatic listing updates;
it does not attribute watcher cadence to backend observation timestamps. The
inspected `native-window-transfer-rejection.png` shows both preserved panes and
all post-rejection markers.

The page-owned opt-in probe adds native destination lookup and picker creation;
normal release assets contain neither operation. Picker creation exercises the
actual picker page, not a desktop portal request or pending portal-token registry.
No native permissions or production handoff behavior changed. Independent review
accepts the bounded ownership assertions. Initial fixture runs corrected a wrong
picker-title expectation and an overly broad ancestor-listing query that caused
thousands of WebDriver property requests. The final query reads only the requested
column in one DOM operation, and the picker has its own test deadline. Those
failures did not establish a product regression or justify a relaxed timeout.

All 81 focused window/session contracts pass
(`/tmp/review-rejected-target-units.log`). Typecheck reports zero errors/warnings;
architecture lint and map coverage 378/378 pass. The ordinary startup graph remains
44 chunks / 651,987 raw / 212,255 gzip bytes
(`/tmp/review-rejected-target-bundle.log`), within existing budgets. Source changes
are confined to opt-in test support; these are not new startup latency measurements.

This closes the four named Linux destination scenarios. Exact split geometry,
destination closure during receipt/adoption, unready destination routing, native
asynchronous creation failure and Windows/macOS acceptance remain separate gaps.


The same rebuilt binary also passes all five existing transfer/close scenarios
(`/tmp/window-transfer-lifetime-regression.log`) and all three warm-window lifecycle
scenarios (`/tmp/warm-window-lifetime-regression.log`): functional concurrent
children, acknowledged last-tab removal, split/large-layout adoption, isolated
closure, warm navigation, fresh fallback and abandoned-claim expiry. Thus this
checkpoint passes ten native cases across three sequential isolated suites.
Historical screenshots regenerated by the regression runs are restored unchanged.

A separate integrated WebKit graph/filter/panel/preview run passes 74 cases with
two skips (`/tmp/graph-panels-webkit-integrated.log`). It does not reproduce the
earlier interaction failures, and it still emits ResizeObserver loop warnings.
Neither the intermittent-failure cause nor the observer warning is considered
resolved by this passing run.


## Graph detail scrollbar feedback checkpoint — 2026-09-07

The wider WebKit run reproduced a concrete layout issue: expanding commit metadata
publishes its measured height into the absolute graph canvas, makes the vertical
scrollbar appear, and narrows the same measured detail from 928 to 920 pixels during
one ResizeObserver delivery. The browser defers a notification and reports a loop
error. The instrumented observer trace at `/tmp/graph-ro-probe.log` identifies the
Svelte size binding and both measurements.

`GitGraphView.svelte` now uses `overflow-y: scroll` on its existing graph scroller,
reserving scrollbar space before expansion. There is no new observer, timer, state
owner or deferred SVG/row update. A three-candidate browser probe
(`/tmp/graph-scrollbar-candidates.log`) refutes `scrollbar-gutter: stable` alone in
the tested WebKit with this custom scrollbar: it and the original auto overflow
both still narrow the detail and emit the warning. Scroll overflow establishes
920-pixel width before expansion and emits none. The header retains visible
overflow so its branch-filter popover remains usable. Classic scrollbars now keep
their track space even in short graphs; header column alignment against that space
is an existing separate concern, not claimed fixed here.

`e2e/git-graph-detail-layout.spec.ts` exercises actual commit metadata and PR details
at 1280px/100% and 900px/150%. It compares physical panel/row rectangles and the full
ordered row/SVG-vertex center sequence, with same-center stash rings deduplicated.
It also captures browser errors before navigation. Reverting only the CSS makes
the WebKit commit-metadata case fail on the reproduced error; the narrow PR case
still passes, so it is complementary geometry coverage rather than an independent
reproduction (`/tmp/graph-scrollbar-regression-before.log`). The restored final fix
passes all four cases (`/tmp/graph-scrollbar-regression-after.log`). Independent
review accepts both the causal fix and strengthened geometry assertions.

Integrated Chromium/WebKit acceptance passes **154 cases / two skipped** in 3.7
minutes (`/tmp/graph-scrollbar-integrated-final.log`), with all-view-mode graph,
filter, panel and preview resize coverage. No ResizeObserver loop warning appears
in that run. This supersedes the observer-warning gap in the preceding checkpoint;
it does not establish the cause of the earlier intermittent PR/CI/filter interaction
failures or general WebKit stability. The inspected `graph-detail-layout.png` shows
expanded rendered commit metadata with subsequent rows and graph vertices aligned. Historical
images regenerated by the integrated suite are restored unchanged.

The production change is CSS only. Native platform timing, filesystem and Rust
acceptance remain the prior checkpoints; no new native startup or throughput claim
is made. The final verification also retains zero typecheck errors/warnings, clean
architecture lint and source-map coverage 378/378.

Startup payload validation remains within budget: 44 chunks / 651,983 raw /
212,259 gzip bytes (`/tmp/graph-scrollbar-bundle-final.log`); the main chunk is
302,314 raw / 89,815 gzip bytes. These are build payload sizes, not launch latency.

## Graph header, reference access and button keyboard checkpoint — 2026-09-07

`GitGraphView.svelte` now derives one full table width from the graph gutter,
message minimum and every visible metadata column. Rows and header use that same
geometry, including the complete Parent column; the parent flex container can
shrink with its pane, and the header projects the scroller's horizontal offset.
Filtering transfers vertical and horizontal ownership to the replacement
scroller, while hiding columns clamps the retained scroll position. This removes
the previous intrinsic-width/ResizeObserver feedback path without adding a private
observer or timer. Before the fix, three WebKit basic-alignment cases missed by
8–12 physical pixels (`/tmp/graph-header-before.log`); the separate Chromium 150%
failure was fixture backdrop-click interference, not a geometry reproduction.
All six Parent-column cases then failed their initial alignment check before any
horizontal scroll, by 48–90 physical pixels, corresponding to the same 60 CSS-pixel
width difference at 80%, 100% and 150% zoom
(`/tmp/graph-header-scroll-acceptance.log`).

The message cell still clips visual overflow to protect the metadata columns, but
its compact “all references” button exposes the complete branch, remote, tag,
stash and PR set through the existing single menu owner. Reference entries lead
into the existing scoped action menu or PR detail. The owner retains its trigger,
focuses the first item, restores trigger focus on Escape, and retires on row
virtualization or horizontal scroll. Long names wrap within a bounded scrolling
menu rather than changing row geometry.

The shared keyboard policy now gives an actual `BUTTON` unmodified Enter/Space
activation before Explorer command routing and cancels a pending chord. The
exception requires both the event modifiers and the keybinding store's existing
tracked-Super state to be clear, because WebKitGTK can report a held Super key
without setting `metaKey` on Enter. Modified shortcuts therefore continue through
the ordinary command matcher. The window listener also recognizes an accepted key
on `[role="button"]` through `defaultPrevented`, using the same retirement contract
already used for separators. The failing-before native
button run records two failures (`/tmp/window-keyboard-button-before.log`); the
custom-role regression records one (`/tmp/window-keyboard-custom-before-2.log`).
The WebKitGTK Super regression records one failure with 26 passing cases before
the tracked-modifier guard (`/tmp/window-keyboard-super-before.log`). Independent
read-only review found the final policy, listener and regression consistent with
the modified-shortcut preservation claim.

Focused evidence is **78/78 keyboard units** across three files
(`/tmp/graph-keyboard-final-units-2.log`) and **22/22 targeted browser cases** across
Chromium and WebKit (`/tmp/graph-header-targeted-frozen.log`). The browser cases
cover 80%, 100% and 150% zoom; resize and filter scroller replacement; column
hide/show and horizontal clamping; complete reference disclosure and scoped
actions; trigger focus/retirement; and commit-row Enter selection. Independent
read-only reviewers accepted the source and requested an explicit row-focus and
unchanged status-path assertion; both are present in the final test. Typecheck has
zero errors/warnings (`/tmp/graph-header-check-final-2.log`), architecture lint is
clean (`/tmp/graph-header-arch-final-2.log`), and maps cover 378/378 source files
(`/tmp/graph-header-maps-final-2.log`). The inspected `graph-header-layout.png` and
`graph-references-access.png` show aligned metadata and access to a clipped PR.

The integrated Chromium/WebKit matrix passes **172 cases with two skips** in 5.1
minutes (`/tmp/graph-header-integrated-final.log`) without ResizeObserver warnings.
It covers the graph, filter, panel and preview resize surfaces represented by that
matrix; it is not the full product matrix. The post-Super browser keyboard rerun
passes **4/4 cases** in 9.6 seconds (`/tmp/graph-keyboard-browser-final.log`).
This does not provide fresh native Windows/macOS runtime acceptance. Native
platform soak, the full accessibility /
theme / DPI / preview product matrix, final integration and actual Mac half-bounce
measurements remain outstanding; the architectural review is **not complete**.

The completed production bundle remains within budget: 44 chunks / 652,348 raw /
212,367 gzip bytes, with the main chunk at 302,647 raw / 89,908 gzip
(`/tmp/graph-header-bundle-final.log`). Relative to checkpoint `8654e3ab`, this is
+365 raw and +108 gzip bytes. It is a payload measurement, not native launch
latency or evidence for the Mac half-bounce target.


### Native creation ownership and rejected handoffs (2026-09-07)

`window-launch.ts` previously retired every JavaScript constructor handle after
`tauri://error`. Tauri addresses these handles by label: duplicate-label creation
fails without replacing the existing native window, so that retirement closed an
unrelated live destination. The real binary failed the new preservation assertion
before the fix (`/tmp/window-collision-native-before.log`), as did the domain
boundary regression. Listener throw/rejection tests also failed against the old
owner (`/tmp/window-creation-drain-before.log`).

The launcher now separates retirement intent from native ownership. Only
`tauri://created` grants ownership. Timeout, failed handoff and listener failure
clear the launch seed and retain surviving terminal observers; a later creation
forces one `destroy()`, while a native error ends the drain without addressing
that label. Forced rollback bypasses an unaccepted child's close-request handler.
Partial dependency overrides allow the native collision test to control only UUID
allocation and warming while using actual construction, storage and handoff.

Verification:

- **66/66** launcher, handoff, close admission, transfer, warm and probe contracts
  pass (`/tmp/window-creation-all-contracts-final.log`).
- **5/5** real Linux rejection cases pass in 1m13.4s
  (`/tmp/window-creation-native-accepted.log`): missing/destroyed/hidden targets,
  actual picker, unready native destination, closure during actual handoff receipt,
  and asynchronous duplicate-label creation failure. They verify retained source
  tab identity/layout/path plus subsequent filesystem updates. The collision case
  also verifies the original target handle/state and its subsequent filesystem
  update. Inspected `native-window-collision-source.png` and
  `native-window-collision-target.png` record both surviving windows.
- The same rebuilt binary passes **5 transfer + 3 warm-window cases**
  (`/tmp/window-creation-native-final.log`). That earlier combined run also contains
  a rejected unready fixture result; the accepted five-case rerun supersedes it.
- The unready fixture initially tried script evaluation and then an exact
  `about:blank` URL match. Installed Wry intentionally skips initial navigation for
  that URL, so WebKit has no initialized document and reports an empty URL. The
  final driver matcher accepts that real state and navigates the same handle to
  the app, requiring the exact native label and original single tab/pane/path.
  The isolated corrected case passes in 12.3s (`/tmp/window-unready-native.log`).
- Independent Sol source/evidence review **CONFIRMED** ownership and all three
  new native outcomes. Type checking has zero errors/warnings, architecture lint
  is clean and source maps cover 378/378 files.

This is Linux debug-binary acceptance, not Windows/Mac runtime or startup timing.
An unavailable created observer cannot safely reclaim a future window by label;
the installed SDK registers creation handlers synchronously in its local array.
A failed destroy remains diagnostic: retrying by a potentially reused label is
unsafe. Existing-destination adoption followed by lost ACK still has a documented
duplication possibility; these rejection cases do not prove exactly-once transfer.
The full release integration, platform/soak/product matrix and Mac half-bounce
measurements remain outstanding.

Production bundle verification passes at 44 startup chunks / 652,465 raw /
212,418 gzip bytes; the main chunk is 302,764 raw / 89,963 gzip
(`/tmp/window-creation-bundle.log`). The new native failure probe strings are
absent from normal production output. This is +117 raw / +51 gzip startup bytes
from the preceding checkpoint and carries no native launch-time claim.


## Same-process Linux renderer-crash recovery — 2026-09-07

The opt-in `e2e-renderer-recovery` feature retains the original GTK WebView while
an external controller signals verified renderer descendants through Linux
pidfds. WebKitWebDriver loses its session on renderer death; this controller
therefore owns the same native view throughout both crashes and reloads.
It does not add automatic recovery policy to normal application builds.

Acceptance passed two cycles in native PID 55829 and GTK object
`0x55b0ee989d30`. Renderer sessions advanced 0 → 2 → 4 and leases 1 → 2 → 3.
For each cycle, the repository-qualified old-owner reclamation diagnostic
preceded reload. Fresh-realm readiness, the exact obsolete-session rejection,
stale-release success, and continued new-owner observation were required.
The new marker appeared after navigation through the actual address control.

The opt-in native observer records the backend observation time and exact
notify paths before waking its worker. The real Git notification carries this
metadata only in the recovery fixture; ordinary subscribers still receive the
existing `GitChange` contract. Acceptance requires the unique written marker's
absolute path and backend observation time at or after that write began.
A delayed earlier notification cannot satisfy this predicate.

Evidence:

- [Structured two-cycle result](reviews/renderer-recovery-acceptance-2026-09-07.json).
- [Inspected recovered listing](../screenshots/refactor/repo-health-cleanup/native-renderer-crash-recovery.png)
  shows `observed-after-crash-2.txt` in repository-2.
- Native acceptance exits 0; existing native window destruction, ordinary
  reload, and blank-renderer crash tests pass 3/3 on the same binary.
- Git notification contracts pass 7/7; Rust Git observation contracts pass
  20 cases (one ignored). Typecheck has zero errors/warnings, architecture lint
  is clean, and maps cover 378/378 source files.
- Feature-build Clippy passes with warnings denied. Independent Sol source and
  runtime review confirms the controlled Linux recovery outcomes.
- Normal startup payload: 44 chunks, 652,471 raw / 212,413 gzip bytes;
  main chunk 302,764 raw / 89,965 gzip. All 65 built JavaScript files exclude
  recovery probe markers. These are payload measurements, not launch timing.

The initial feature build exposed an unsupported Tauri lookup; the public
`get_webview_window` API fixes it. The first runtime run reached renewed watch
coverage but failed its navigation assertion because the harness assumed the
single pane had the split-mode `.active` class. Requiring a single pane and
selecting its actual controls corrected the fixture; no production navigation
change was needed. Independent Sol review confirmed the source correction.

Scope remains Linux debug-binary controlled recovery. This does not establish
Windows/macOS behavior, hours-long native retention, a user-facing automatic
recovery experience, or Mac half-bounce startup. Those release gates remain open.


## File-entry keyboard correction and native retention finding — 2026-09-08

The 25-spec Linux integration run passed 22 specs and failed three. Two trash
failures came from isolating XDG data on tmpfs while fixtures lived on the home
filesystem; the application correctly rejected an unwritable filesystem-root
trash directory. Both file-operation specs pass with a same-filesystem profile.
The preview failure also reproduced in a clean, single-spec run and was an
application regression from `1cf4e04b`.

All three file-list views use native button entries. The global native-button
activation exemption incorrectly swallowed their configurable Enter/Open and
Space/Preview commands. Routing now distinguishes actual main-list entries
from ordinary controls. Independent Sol review exposed two necessary refinements:
Miller-column folder buttons share `.entry-item` but own native navigation, and
Space accepted by filename type-ahead must not also dispatch Preview. Both are
covered by the final predicate and local-consumption guard.

Verification: two production routing regressions failed before the fix; 34
routing contracts pass afterward. Chromium passes 27 file-entry/graph cases,
including all three views, real UI rename followed by multiword type-ahead,
Miller Enter/Space navigation, address editing, selected directory Open, Preview
and graph-button ownership. The rebuilt native debug binary passes the original
Markdown preview/zoom/dock/fullscreen/pointer/keyboard scenario in five seconds.
Its [inspected screenshot](../screenshots/refactor/repo-health-cleanup/native-preview-resize.png)
shows the real Markdown result. No Windows or macOS runtime acceptance is implied.

The independent review also identified an existing focus/selection split: Tab
can focus an unselected main-list row while selection-based commands retain a
different target. This needs a deliberate composite-list focus policy; narrowing
the shortcut exception to selected rows would merely hide that issue. Keep this
specific case in the open keyboard/accessibility product matrix.

A new native retention reproduction pins the app PID/executable/start time and
matches Linux inotify descriptors by device and inode. It proves a child watch
is acknowledged and receives a real filesystem mutation, destroys that window,
then checks OS-watch removal while retaining the directory. The unchanged
filesystem watcher fails: child-1 retains fd 15 / watch 3, device `0x10306`,
inode `0xc2003a`, after native destruction. The fixture is retained until the
assertion ends, so kernel deletion cleanup cannot mask the leak. Initial probe
qualification caught and corrected Linux's internal 12:20 device-number encoding
versus userspace `stat.dev`; the final failure occurs at teardown, not acquisition.

This is a reproduced outstanding defect, not completed soak acceptance.
`files/fs_watcher.rs` currently counts paths without concrete window/renderer
ownership. The next change must cover destruction, reload/crash, pending
acquisition, stale release, shared paths and recursive search-cache epochs using
consistent native lifetime ownership. The new reproduction remains local work
until that fix and adversarial/native verification are complete.

Final keyboard checkpoint checks: typecheck has zero errors/warnings,
architecture lint is clean, source maps cover 378/378 production files, and the
normal bundle passes at 44 startup chunks / 652,565 raw / 212,451 gzip bytes
(main 302,858 raw / 90,007 gzip). This adds 94 raw startup bytes relative to
`5b58b943`; no launch-latency improvement is claimed. The focus/selection split
also exists before `1cf4e04b`: main-row events already flowed to the same
selection-based command owner then. Restoring that contract does not resolve
the separate composite-list focus policy.

## Shared directory/Git renderer ownership — 2026-09-08

`renderer_owner.rs` owns the concrete Tauri resource slot, renderer generation,
native termination registration and nonblocking retirement fan-out. Both APIs
share `native_resource_session`; directory-only use does not start Git's worker.
`directory_watches.rs` owns opaque leases, shared registration, exact release
authority and cleanup retries through an injected observer. `fs_watcher.rs` runs
blocking notify work off the async executor and reuses its existing flush thread.
`createPathWatch<L>` consolidates ordered frontend ownership, including retrying
a failed destroy without reopening the disposed owner.

Retirement immediately makes cache eligibility false. Maintenance advances the
root epoch before reacquisition can advertise coverage, and preserves the existing
recursive overlap rebuild policy. A failed final unwatch retains release identity
and backend cleanup intent, disables cache reuse, and eventually retries/rebuilds
without requiring a discarded component to run again. Git request cancellation
now remains observable until the successful reply is consumed; one canceled
request cannot remove another lease on the same repository.

Evidence in [the acceptance artifact](reviews/directory-ownership-acceptance-2026-09-08.json):

- Before: exact first-child inotify registration remained ten seconds after native
  destruction; the directory was retained throughout the assertion.
- After: three native child cycles retain zero matching registrations, while the
  main window receives a causal filesystem write and renders the refreshed listing
  each cycle. Same-window reload removes the unmanaged raw lease and reacquires a
  distinct lease/descriptor. External renderer termination reclaims both Git and
  the exact raw-directory descriptor while the application process remains alive.
- Five native outcomes across three specs pass in 14 seconds. The directory probe
  matches PID/executable/start time and inode/device; it never deletes fixtures to
  make descriptor checks pass or issues DOM commands against the crashed renderer.
- Eighteen directory policy tests, six renderer scope tests, and seventeen Git
  service tests pass (one Git measurement ignored). The real Quick Open integration
  covers shared-owner preservation and final retirement during a gated cold walk,
  rejects stale publication, and verifies a fresh listing after rewatch.
- Full Rust: 470 passed, seven ignored; strict Clippy passes all targets. The first
  full run's three terminal failures came from interactive Zsh/powerlevel10k waiting
  for gitstatusd. An isolated XDG profile with `SHELL=/bin/bash` passes the full suite.
- Frontend: 242 files, 2,159 passing tests, three skipped, plus 30 performance cases.
  Typecheck has zero errors/warnings; architecture lint passes; maps cover 381/381.
  Native test helpers also pass their explicit TypeScript check.
- Independent Sol review reproduced the two cancellation/retry failures, tested
  isolation, and confirmed the final source and native evidence.

Normal startup payload is 44 chunks / 652,792 raw bytes / 212,545 gzip bytes;
main chunk 302,858 raw / 90,004 gzip. Both budgets pass. Compared with the preceding
keyboard checkpoint this adds 227 raw startup bytes; no launch-time improvement
is claimed. This removes leaked native observations and blocking executor work,
but does not establish the Mac half-bounce target or hours-long resource bounds.

Remaining directory observation work includes recovery after native callback
errors/root replacement and retrying unavailable recursive cache observation.
Windows/macOS native equivalents, wider product acceptance and final release
integration remain open. The controlled same-WebView two-crash recovery harness
was updated for the shared session/log contract but has not been rerun in this
checkpoint; ordinary reload and actual blank-crash cleanup were tested directly.

## Directory observation recovery — 2026-09-08

`watch_observation.rs` separates desired roots, physical registrations, native
generations and health from renderer lease identity. `fs_watcher.rs` adapts its
notices to existing cache epochs and trailing refresh delivery. Direct roots
share nonrecursive parent registrations; recursive Quick Open observation starts
only on demand. A callback fault or rescan immediately disables healthy coverage.
Recovery uses the existing worker, and future retry deadlines avoid repeated
filesystem mutex acquisition during an outage.

Every failed recursive registration can be partial, including a descendant's
PathNotFound. Recovery discards the candidate and excludes that root for the
attempt; untested roots precede successful trees to limit repeated healthy-tree
walks under stable registration outcomes. Changing failures can require more walks. Later successful incremental additions
invalidate only the restored root. Overlapping-root removal still reconstructs
survivors. Valid events received during registration are latched for a catch-up
refresh after activation, while faults prevent activation. A callback accepted before retirement can finish
a conservative invalidation; it cannot publish data or restore replacement health.
ADR 0013 records the boundary and its limits.

Evidence in [the acceptance artifact](reviews/directory-recovery-acceptance-2026-09-08.json):

- Before: moving the watched directory and recreating its path left replacement
  contents absent after 27.6 seconds. An independent same-file Markdown overwrite
  produced no causal watcher receipt after 25.6 seconds.
- After: the same mounted pane shows the replacement inode's files, observes later
  writes, excludes a ghost file written into the retained displaced tree, and
  preserves a separate window's causal refresh. Existing-file overwrite updates
  the selected Markdown preview and its 8 KiB metadata.
- Six native specs / eleven outcomes pass in 51 seconds, including the existing
  refresh/coalescing and directory/Git lifetime regressions. A second two-case run
  passes and captures inspected [replacement](../screenshots/refactor/repo-health-cleanup/native-directory-replacement.png)
  and [updated preview](../screenshots/refactor/repo-health-cleanup/native-directory-content-update.png)
  screenshots. These are correctness outcomes, not startup benchmarks.
- Thirteen injected observation contracts cover faults, rescans, stale callbacks,
  registration interleavings, parent sharing, partial recursive installation,
  overlap, deadline backoff and bounded healthy-tree re-registration. Two added
  lease contracts cover health gating and cleanup deadlines.
- Full serial Rust: 485 unit plus nine integration tests pass, seven ignored.
  The default parallel run failed unchanged panic-report and active-rev-parse
  cancellation tests; both pass in isolation. Their nondeterminism remains open.
  An earlier sandbox run denied the two relay tests' loopback sockets; the final
  run permits local sockets and uses isolated XDG roots with Bash.
- All-target Clippy with warnings denied, native test TypeScript, strict
  architecture lint and 382/382 source-map coverage pass. Frontend source and
  its preceding unit/performance/payload measurements are unchanged in scope;
  no new launch-time or memory benchmark is claimed.

Independent Sol review accepts this Linux/backend checkpoint with no blocking
defect. It confirmed the core contracts and evidence, and required the callback
interleaving and stable-registration qualifications recorded above. Native
error/rescan injection and large-tree recovery cost remain unmeasured.

Follow-up inspection identified two ordinary listing boundaries outside this
checkpoint: its five-second cache can accept an old in-flight scan after
invalidation, and path existence/type probes still run before the blocking scan
adapter. The initial listing also precedes native watch registration, leaving an
unobserved handoff gap. These need reproducible, domain-level contracts before
claiming comprehensive directory consistency. Windows/macOS equivalents, large
native-tree/long-session measurements and final release acceptance remain open.
