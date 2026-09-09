# Architectural review completion ledger — #680

## Active scope — frozen 2026-09-09

The user explicitly narrowed execution: finish the already-started move-intent
contract, file further expansion as GitHub issues, and implement only
release-critical architectural fixes. This section supersedes the old requirement
that every new finding expands the same objective. Historical coverage below is
an audit record, not an unlimited implementation mandate.

The bounded remaining gates are:

1. **Finish the current checkpoint:** compile and test the immutable move schema,
   catalog reopening and operation-kind guards; independently review it. This does
   not enable an executable durable move feature.
2. **Resolve demonstrated release blockers:** data loss, permanent operation
   lockout, stale publication, leaked ownership, cross-platform compilation or
   core interaction regressions caused by this integration. Each needs a concrete
   reproduction and the smallest safe fix. The replacement journal capacity regression is addressed by opt-in feature
   gating; final acceptance of that fix is recorded in the current checkpoint.
3. **Validate the integrated result:** typecheck, architecture lint, complete source
   maps, unit/performance tests, Rust tests/Clippy and affected browser/native
   outcome tests. Repeat only for changed code or unresolved failures. Preserve
   previously recorded evidence and its platform/build limits.
4. **Qualify supported platforms and startup:** targeted Windows/macOS native
   smoke and actual release-build Mac first-frame/usable-input measurements remain
   acceptance gaps. Linux and bundle numbers cannot establish the half-bounce
   target. Missing hardware is a reported gate, not a reason to invent unrelated
   implementation work.
5. **Deliver a reviewable integration:** update evidence and PR status, isolate
   unrelated user files, and publish under the existing authorization when the
   environment allows it. Do not call the release accepted while gates remain open.

Deferred expansion is now tracked separately:

- [#685: durable moves and ordered move sessions](https://github.com/xnmp/tauri-explorer/issues/685).
- [#686: remaining mutation-family recovery admission](https://github.com/xnmp/tauri-explorer/issues/686).
- [#687: recovery retention policy and durable retirement](https://github.com/xnmp/tauri-explorer/issues/687).
  A safe shipping policy for currently enabled recovery remains gate 2 above.
- [#688: extended native soak and product qualification](https://github.com/xnmp/tauri-explorer/issues/688).

Further nonblocking findings go into issues. This pass does not add new features,
rewrite unrelated subsystems, or repeat accepted checks without a concrete reason.

## Publication and dev integration — 2026-09-09

The approved 43 commits through `d4b5d6e0` were pushed to draft PR #684. The
new dev qualification commit `e336d32c` then required four merge resolutions:
keep both sets of package scripts and native acceptance documentation, preserve
the new Mac qualification workflow, and assign its ADR the unused number 0021.

A regression test reproduced the runner's outdated startup marker. Qualification
now requires native foreground readiness and explicitly rejects builder/WebView-only
markers. All 21 qualification tests pass; typecheck, architecture lint and source
maps pass. Output-capture fixtures synchronously emit their proof bytes before
exiting, after a standalone process reproduction showed their buffered output
was absent. Production child-log capture is unchanged. Independent Sol review
verified the merge and readiness boundary. Native application code is unchanged
from the previously tested checkpoint.

The manually dispatched Linux/Windows native smoke run on `d4b5d6e0` is
[34326582874](https://github.com/xnmp/tauri-explorer/actions/runs/34326582874).
Its result must be recorded separately from later integration-head checks. The
PR stays draft; no merge into dev or release is authorized by this publication.

## Published integration qualification — `cb0c1717`

The published head passed both Rust test/strict-Clippy policies (1,154 default
and 1,152 opt-in library tests, plus nine integration tests each), code maps,
frontend typecheck/unit/bundle checks and the performance workflow. Those results
are acceptance evidence for that commit, not a measured end-user speedup.

The Mac qualification workflow accepted 30 native-readiness samples: cold p50
4,717.5 ms / p95 5,575.3 ms; warm activation p50 655 ms / p95 4,056 ms.
Its artifact identifies synthetic PR merge commit `52f9ca51d6ad3990b4bedccb355d825f405c2e00`,
profile `debug-custom-protocol-production-hooks`, and binary SHA-256
`4e4d2e7ae856a53b9df28e70dcb8f652694b680b15154d2129e44fc117925cbf`.
This shared-runner debug build also enables warm-window measurement during setup.
It does **not** establish release cold-only startup, first-input latency, or the
half-bounce target. [Mac run](https://github.com/xnmp/tauri-explorer/actions/runs/34327210833).

Qualification failures were reproduced in CI:

- Windows compiled the app and library tests, then the test executable exited
  before discovery with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139). Tauri's
  resource pipeline embeds the activation manifest in app binaries only.
  The build now uses MSVC linker manifest embedding, following the
  [upstream Tauri example](https://github.com/tauri-apps/tauri/blob/dev/examples/api/src-tauri/build.rs),
  to cover library tests too; GNU retains resource embedding. The existing v6
  Common Controls and DPI declarations are shared in one manifest. Native MSVC
  confirmation remains required. [Failing job](https://github.com/xnmp/tauri-explorer/actions/runs/34327210823/job/102387202049).
- Chromium's 777-test, single-worker suite exceeded the original 20-minute job
  budget and was cancelled before its failure summary. The long-path test's
  unrelated whole-panel height comparison failed three times in isolation; its
  file-column/row/containment assertions passed. Removing only that invalid
  comparison makes all three long-path tests pass, and all 41 Git graph tests
  pass in Chromium, including the previously timed-out PR-badge test. CI now
  divides the unchanged inventory into
  two single-worker shards and emits immediate line reports. The protected
  `frontend` check requires both shards and all frontend validations, including
  when a dependency fails or is cancelled. [Cancelled job](https://github.com/xnmp/tauri-explorer/actions/runs/34327210797/job/102387115696).

- Linux native CI reached only 26 of 36 isolated sessions before its 15-minute
  step cap, including 24 passing specs and one child-window setup failure before
  the Git ownership assertion. The hosted WebKitGTK sessions each took about
  30 seconds to start. The Linux step now allows 30 minutes within a 50-minute
  build/test job; individual contract timeouts are unchanged. The ownership
  fixture now explicitly primes and identifies a ready parked window, then
  requires activation of that exact handle before acquiring the observer. Its
  destruction/reclamation and surviving-window assertions remain intact. Native
  confirmation of this fixture change remains pending. [Linux job](https://github.com/xnmp/tauri-explorer/actions/runs/34327210823/job/102387202250).

- The full WebKit browser run also exceeded its 40-minute cap while still
  executing the 777-test inventory. It now uses the same two-shard single-worker
  approach with immediate line reports; the protected `webkit` check requires
  both shards. The original failed assertions still need exact diagnostic output
  from a completed run. [WebKit job](https://github.com/xnmp/tauri-explorer/actions/runs/34327210797/job/102387115351).

Local strict Clippy passes for Linux and Windows GNU after the manifest change;
formatting and 485/485 source-map coverage pass. The Chromium shards contain
389 and 388 tests, with no omissions or overlap. Independent review accepted
manifest embedding and the protected aggregate check; MSVC execution and CI
runtime margin remain unverified. The changed native fixture passes a scoped
strict TypeScript check. The suite's existing CommonJS/deprecated-resolution
configuration prevents a clean suite-wide check; that separate debt is filed
as [#690](https://github.com/xnmp/tauri-explorer/issues/690). Local WebKit cannot
launch because its cached bundle lacks ICU 74, so browser WebKit proof remains CI-owned.

The integration remains draft pending native/browser results and the explicit
startup acceptance gap. No architectural scope has been added.

## Completed CI run and fixture stabilization — `f1dedbeb`

The full browser/native inventories now finish within their job budgets. The
[main run](https://github.com/xnmp/tauri-explorer/actions/runs/34331161764)
passed frontend validation (2,409 unit tests, 30 performance tests, three skipped),
both Rust policies and strict Clippy, and code maps. Startup payload is 48 chunks /
219,516 gzip bytes. The separate performance workflow passed. These are validation
and payload results, not measured startup improvements.

Chromium shard 1 passed 388 tests and failed the repository-badge fixture;
shard 2 passed with one retry. WebKit reported three multi-selection focus
failures plus close/drag fixture failures. Trace inspection established stale
layout coordinates after the badge screenshot's CSS zoom reset, and a no-op
Shift+Tab in the WebKit selection-retention test. The patch uses device-density
screenshots without resizing, explicit departure before real Tab reentry,
capture of the actual close outro before Undo, and stable pointer targets before
drag measurement. Selection, exact restored-directory/tab lifetime, badge and
drag ownership assertions remain required. These changes need the next WebKit
run; local Chromium badge, close/drag and all-view file-focus checks pass
(32 tests total).
Independent review accepts the fixture contracts. Multi-selection backward-focus
qualification is tracked separately in [#692](https://github.com/xnmp/tauri-explorer/issues/692);
the existing Ctrl+End backward-departure assertions remain unchanged.

The [native run](https://github.com/xnmp/tauri-explorer/actions/runs/34331161762)
confirmed the Windows manifest fix: library tests now execute. Batch contracts
passed 24 tests and failed two. One byte-budget fixture used an invalid Windows
leaf component; it now uses bounded components with the same total byte count.
The other test indexed trash artifacts before asserting operation success.
Outcome-first diagnostics now expose the real result while still requiring exact
restoration. Its cause remains unresolved. Windows CI now collects every contract
family, lint and GUI results independently when prerequisites succeed, retaining
failure status. Final Windows GNU strict Clippy and the byte-limit regression
pass locally; cross-compilation does not qualify Windows runtime behavior.

Linux completed all 36 native specs: **32 passed, four failed** (six individual
test failures). The changed Git-watch fixture passed both destruction and reload
reclamation, including exact ready-window activation and survivor navigation.
Remaining failures are directory child readiness after successful native creation
and driver handle discovery, a renderer-crash fixture finding the earlier directory
test's surviving application process alongside its own, a terminal setup click rejected as non-interactable,
and three window-transfer/close cases with missing child handles or null creation
results. The terminal test did not reach its resize assertions. These failures
remain under diagnosis; the full native gate is not accepted. The PR remains draft.

The [Mac run](https://github.com/xnmp/tauri-explorer/actions/runs/34331161775)
accepted 30 samples with foreground-readiness p50 4,485.5 ms / p95 6,888.5 ms
and warm activation p50 706 ms / p95 7,170 ms. The artifact identifies synthetic
PR merge `3e94213a1f9c7e05e0079368339452c272ccdd34`, profile
`debug-custom-protocol-production-hooks`, and SHA-256
`a03f5ae980848f12660eed1e41e15f08b8583a6fdd22406fda85345e4e7dc50b`.
Warm measurement is enabled in this shared-runner debug profile. Release-build
cold-only startup, first-input latency and half-bounce acceptance remain open.

## Native session ownership and release startup qualification

The published `bdc804ff` passed both Chromium shards, the protected frontend
aggregate, Rust validation and source maps. WebKit and native run
[34335460231](https://github.com/xnmp/tauri-explorer/actions/runs/34335460231)
were still running when this follow-up was prepared; their results must be read
before integration acceptance.

The prior Linux log established that the directory-watch application's PID
survived its WebDriver session and contaminated a later single-process test.
The runner directly owns only tauri-driver on Linux; waiting for that child's
exit does not account for the application launched beneath WebKitWebDriver.
Linux smoke now captures a dedicated process group and waits for all members to
disappear, with bounded graceful/forced termination. Windows keeps its existing
direct-child ownership. Real subprocess regressions cover an exited group leader,
a descendant ignoring termination, an untouched sibling and failed fixture
readiness cleanup. The combined qualification set passed 28 tests; independent
review and a final five-test subprocess run passed with no fixture survivors.
The next real Linux native run must verify application inheritance and session
isolation; this subprocess evidence alone does not close the native gate.

Mac qualification now selects the actual release profile and measures 30 fresh
foreground launches without the extra warm-measure window, followed by 30
separate warm-probe launches of the same verified binary. Release log streaming
is explicitly enabled for the runner. Foreground-only samples retain readiness
and survival checks and report unmeasured warm durations as null. A regression
failed before optional warm measurement was implemented; all 23 parser/process
qualification tests now pass. Independent review accepts the implementation.
Linux and Windows GNU strict Clippy pass after the log-stream option; the Mac
runner passes scoped TypeScript checking and the build wrapper/WDIO config
bundle successfully. The existing suite-wide TypeScript limitations remain #690.

These changes are prepared for publication while the current run finishes.
Actual Mac release reports, matching binary identities across both scenarios,
presented-frame/input measurements and the half-bounce target remain outstanding.
No new product feature or architectural review scope has been added.

## Release stabilization — preceding checkpoint

The started immutable Move intent is complete: real catalog promotion/reopening
preserves its authority without touching user entries, and copy execution/history
rejects Move checkpoints. All 1,151 Rust tests passed (19 ignored) at that checkpoint.
No executable durable move phases are enabled. Further move work is #685.

Independent release triage found a concrete capacity regression in the new durable
copy path: each successful overwrite permanently retained a journal record, and
1,024 retained records could block all mutations using shared recovery admission.
Because artifact retirement is not yet implemented, `durable-copy-recovery` is now
an opt-in Cargo feature. Ordinary builds use staged overwrites with transient
source/target claims, the same observed copy staging, and exact Linux publication
receipts. Existing durable discovery/restore/history remain enabled. Committed
copy receipts survive ownership cleanup failure, which is returned as a warning.
Normal overwrite behavior does not retain the displaced original for durable Undo.

The independent reviewer found no further proven release-critical move regression.
Final verification passes: **1,154 library + nine integration Rust tests** in the
normal recovery policy, **1,152 library + nine integration Rust tests** with durable
copies enabled, 19 ignored library fixtures in each. Both strict Clippy configurations
pass with warnings denied; formatting, typecheck, architecture lint and full source-map
coverage (484/484, including untracked source) pass. CI now checks both policies.
The capacity regression fails on the 1,025th overwrite with the previous dispatch,
then passes all 1,025 with the gate. Three real native history cycles pass under both
policies. The cancellation fixture now acknowledges abort before releasing cleanup;
the watcher fixture uses precreated roots beneath its own private parent.
[Exact evidence](reviews/release-scope-freeze-2026-09-09.json) records the earlier
failures, final commands, hashes and limits. Earlier native recovery evidence qualifies the opt-in implementation;
it does not prove native GUI acceptance of this final default dispatch. Windows,
macOS and the Mac half-bounce measurement remain open gates. Existing experimental
profiles already at capacity still need explicit recovery/retirement support; this
change prevents normal builds from accumulating further permanent copy records.

## Windows compilation — release-critical follow-up

A full Windows GNU cross-check reproduced a Tauri WebView plugin configuration
inference error and strict all-target Clippy failures. The plugin now declares
its unit configuration. Portable recovery IPC/history stays available on every
platform; Unix journal authority is separated into `recovery/durable_model.rs`.
Windows qualification adapters remain compiled in tests without entering
production admission. Platform-only helper/import boundaries and the thumbnail
priority guard's lexical lifetime now compile cleanly on Windows.

Windows strict all-target Clippy passes with `e2e-webview2-attach`. Both Linux
strict Clippy configurations pass, as do **1,154 + nine** default Rust tests and
**1,152 + nine** opt-in tests (19 ignored library fixtures each). The initial
sandboxed test failures are retained in the evidence; complete suites pass with
local socket/cache permissions. Independent Sol review found no release blocker.
The moved durable validation body is byte-identical to the preceding checkpoint.
Formatting, diff checks and source-map coverage pass.

[Windows platform evidence](reviews/release-windows-platform-boundaries-2026-09-09.json)
records commands, logs, hashes and limits. This is compilation coverage, not
Windows runtime acceptance. Native Windows/macOS qualification and the Mac
half-bounce measurement remain open; no additional architecture scope was added.

## Native move reservation and path binding — preceding checkpoint

Forward moves now acquire the acknowledged renderer/history owner and Linux recovery
reservations for the source and target before dispatching filesystem work. A pure
`MovePlan` supplies both claims and execution bindings; `move_execution` retains the
reservation in the real blocking context and settles it only after worker cleanup.
Native history's Move adapter shares that executor. Parent aliases resolve during
admission, symlink leaves remain selected entries, and execution uses the admitted
physical paths. Metadata uses the requested destination spelling only while its
alias remains valid. Physical refresh parents and cleanup warnings return through
the existing outer history owner. Successful cleanup warnings retain the opposite;
incomplete source deletion still produces no unsafe opposite or automatic retry.

Two failing-before real-filesystem tests demonstrate that the previous move command
ignored live source-only and target-only reservations. Both now fail closed through
the production executor. Further tests cover normal moves, symlink leaves, parent
aliases and retargeting between admission and execution. The production inverse
adapter separately rejects a competing claim, then succeeds after its release.
The old unadmitted asynchronous move entry point is now a test-only seam.

Verification: **1,143 Rust tests passed, 19 ignored; 2,418 frontend unit/performance
tests passed, 3 skipped; four Chromium scenarios and two rebuilt Linux native
scenarios passed**. The full Rust suite was rerun on the final source after separating filesystem
execution from the pure plan; 29 focused move/history tests also pass. All-target
Clippy retains the eight existing warnings. Native acceptance performs actual cut/paste, two Undo/Redo cycles and
cross-filesystem source-cleanup failure with real byte assertions. It qualifies
in-app clipboard behavior, not the Xvfb system clipboard provider. Typecheck is clean;
bundle budgets pass at 48 startup chunks / 220,150 gzip bytes. No startup-time or
throughput claim is made. Independent Sol review accepts the reservation/path-binding
scope. [Move admission evidence](reviews/recovery-move-admission-2026-09-09.json)
records source/log/binary hashes and limits.

**This is managed-operation exclusion, not exact object or durable move authority.**
External source/physical-parent substitution, path-based frontend Move history,
ordered move sessions, durable overwrite/source parking and artifact retirement
remain open. Other mutation roots still need recovery admission. Windows/macOS and
all remaining release gates remain outstanding. The checkpoint remains local.

## Ordered native copy sessions — preceding checkpoint

Production paste/drop copies now submit one ordered native session. The native
owner inspects each source and destination immediately before its turn, presents
live conflicts, owns cancellation and request-local progress, and retains each
completed receipt outside child unwind boundaries. Cancel stops the remaining
selection while keeping the completed prefix undoable. Skip continues. On Linux,
source/target observations bind the conflict decision to the actual copied and
displaced objects; changed observations fail closed. Ordinary and replacement
inverses settle as one native history batch, including after renderer retirement.
Moves and cut-paste still use their previous renderer orchestration.

The renderer adapter fences prompt replies by owner, request, item and nonce;
it handles cancellation before native readiness and a subsequent conflict arriving
before the prior resolution acknowledgement. Prompt retirement cannot cancel its
replacement. Incremental copied entries preserve operation selection ownership,
so arriving metadata does not override newer user selection or navigation.

Copy dispatch no longer recursively counts a directory before beginning work.
Ordinary Linux copies reuse the anchored copier's buffer without per-entry durable
flushes; journaled replacements retain their durability barriers. This is a source
optimization, not a measured throughput or startup improvement. Production bundle
budgets pass at 48 startup chunks, 672,918 raw / 220,171 gzip bytes (+911 gzip bytes
from the preceding checkpoint); the copy orchestrator is loaded on demand.

Verification: **1,135 Rust tests passed, 19 ignored; 2,415 frontend unit/performance
tests passed, 3 skipped; seven rebuilt Linux native scenarios and nine Chromium
scenarios passed**. The browser copy scenarios cover Details, List and Tiles.
Native UI acceptance exercises mixed ordinary/replacement copies, grouped Undo/Redo
after source removal, and Cancel preserving only the completed prefix. Disabling
observation checks reproduces two failures where unreviewed bytes are published.
An initial full Rust run had one streaming-watch failure; its isolated rerun and
full repeat pass, but the original transient trigger is not established. Typecheck
is clean; all-target Clippy passes with eight existing warnings. Independent Sol
source review found no remaining blocker for this scope. Exact hashes and limits
are in [copy-session acceptance](reviews/recovery-copy-session-2026-09-09.json).

This completes the copy-session migration, not the full file-operation lifecycle.
Native move/grouped-rename migration, ordinary-copy/deletion recovery admission,
artifact retirement/retention, broader interruption and cross-filesystem acceptance,
Windows/macOS qualification and the full release matrix remain open. Linux entry
observations are bounded metadata, not recursive content hashes. macOS half-bounce
startup performance remains unmeasured. This checkpoint remains local.

## Native ordinary-copy publication identities — preceding checkpoint

Ordinary Linux copies now retain a native-only observation of their staged object,
physical destination path and opened parent. Staging starts under a resolved physical
parent; observed publication verifies that destination still matches and uses a
descriptor-relative no-replace rename. `copy_inverse` derives native history keys
from the physical publication, independently of the requested alias spelling.
Native action admission rejects inconsistent copy paths/parents or renderer-minted
observations. Serialized receipts and history omit these native identities.

Verified native Copy actions route Undo through the existing trash worker and
selection plan, checking the publication path, parent and entry version before
trash preparation and again through the prepared execution bindings. Restore now
returns a fresh native publication through the batch receipt ledger. Redo installs
that observation into its next inverse, including when it recreated a removed
destination parent. Trash artifacts and restored publications share the existing
32-MiB receipt budget; dropped recovery adds a warning without revoking success.

Verification: the full Rust library suite passes with isolated XDG directories and
local loopback access: **1,119 passed, 18 ignored**. Real subprocess tests exercise
copy/Undo/Redo cycles, destination aliases, parent recreation, substituted objects
and later edits. Disabling verified removal reproduces deletion of a substitute;
retaining the old publication after Redo reproduces an unusable subsequent Undo.
An additional mixed-receipt test verifies budget sharing and native-only serialization.
Independent Sol review confirmed the scoped contracts and prompted the alias-key
and fresh-Redo corrections. All five rebuilt Linux native recovery scenarios pass
in 8.5 seconds; these are regression evidence for existing IPC, not ordinary-copy
batch UI acceptance. Clippy has eight existing warnings. Bundle budgets pass
(45 startup chunks, 671,703 raw / 219,260 gzip bytes). Exact evidence is in
[publication acceptance](reviews/recovery-copy-publication-2026-09-09.json).

**At this preceding checkpoint, ordinary frontend history was still path-based.**
The new native constructor and inverse are exercised directly by real-filesystem
tests; paste/drop do not yet record these ordinary observations. The ordered native
session, one cancellation/progress owner and grouped history remain required.
EntryVersion is a bounded top-level observation, not a recursive content hash;
restored timestamps, xattrs, nested writes and inode reuse remain outside it.
Windows/macOS adapters and the remaining release gates are still outstanding.

## Returned results survive worker cleanup — preceding checkpoint

Production copy now gives effectful resources to an explicit worker context.
The worker reports its returned result into supervisor-owned storage before
destroying that context. Work and cleanup unwind separately: a cleanup panic
cannot erase a confirmed copy receipt or its exact replacement inverse, and a
work panic followed by a cleanup panic does not cause double-unwind termination.
Completion waits for cleanup; losing the async waiter does not stop running work.
Ordinary errors keep their type when cleanup succeeds. Failed work plus failed
cleanup reports uncertainty with both diagnostics. Successful work retains its
value and adds a bounded warning, including ordinary copies without replacement
metadata. Existing outer native history ownership still settles after renderer loss.

Verification: 507 focused Rust tests pass (13 ignored), including a failing-before
receipt-loss regression, a subprocess double-panic test, cancellation of the
async waiter during held cleanup, and an actual replacement whose preserved
inverse restores the original bytes. All five rebuilt Linux native recovery
scenarios pass in 8.9 seconds. These native scenarios cover integration and
renderer lifetime; injected cleanup faults are established by the Rust tests.
Independent Sol review confirms this scope. Clippy completes with eight existing
dead-code warnings. Production bundle budgets pass (45 startup chunks, 671,703
bytes raw / 219,258 gzip); this is not a startup-time measurement. Exact evidence
is in [worker acceptance](reviews/recovery-copy-worker-2026-09-09.json).

This preserves a **returned whole-work result**. A future grouped command still
needs per-item receipts outside its complete worker so a panic before returning
the group cannot erase completed children. Mixed ordinary/replacement planning,
one command-level progress/cancellation owner, grouped forward history and
paste/drop IPC migration remain open, as do the platform and release gates below.

## Retained replacement batch outcomes — preceding checkpoint

Deletion and replacement execution now share ordered native receipt storage while
retaining their own stop, artifact and outcome policies. The independent replacement
executor keeps its receipt ledger and pending children outside child unwinding:
confirmed receipts survive later panic, uncertainty or cancellation, and the untouched
suffix is explicitly retired before publication. Cleanup failure adds diagnostics
without replacing earlier receipts or the active error classification. Started-item
physical refresh projections survive failure and are deduplicated after owner release.

Production singleton replacements use the same group executor. Post-execution refresh
and inventory publication contain panic and preserve the actual results. Worker panic
now becomes an explicit WorkerFailed result at this boundary; command-level uncertainty
classification is unchanged. Native replacement receipt warnings are general completion
diagnostics, so cleanup failures are no longer mislabeled as inventory failures.
History and copy share one bounded warning collector; a failing-before regression
caught newline separators exceeding its rendered-output cap, now corrected.

Verification: 498 focused Rust tests pass (12 ignored), including real three-child
partial execution, pre/post-promotion panic, cancellation, stale sources, alias refresh,
failed suffix retirement, usable committed-prefix inverses, and grouped inventory
error/panic without receipt loss. The existing deletion and history tests remain green.
Independent Sol adversarial review accepts this internal runtime scope. All five
rebuilt Linux native recovery/lifetime scenarios pass against the production
singleton adapter, with matching binary checksums before/after that final run.
Clippy passes with eight existing dead-code warnings; format, diff and maps pass,
including 474/474 sources when untracked files are counted. Production bundle
budgets pass (45 static chunks, 671,703 bytes raw / 219,257 gzip); no startup-time
improvement is claimed. Exact source/log evidence and scoped limitations are in
[copy-ledger acceptance](reviews/recovery-copy-ledger-2026-09-09.json).

The mixed-plan outer worker, one command-level cancellation/progress registration,
grouped forward-history settlement and paste/drop IPC migration remain outstanding.
These internal receipt owners do not yet cover future grouped-command capture
destruction. Other mutation families, retirement, platform/product qualification,
Mac startup measurement and final integration remain required by the full review.

## Exact independent replacement preparation — preceding checkpoint

Native replacement preparation now builds every requested source/target/private-root
intent, atomically reserves the complete independent group, and binds every child's
exact paths, source/original versions and native parent before returning executable
children. Shared pure validation checks the complete durable record and encoded
manifest budget; promotion repeats these checks under admission. Failure while
binding retires every child, continuing after a sibling cleanup failure and retaining
bounded diagnostic detail. No preparation step creates a durable catalog intent or
changes user files. Versions are observed sequentially after admission: this is not
an atomic filesystem snapshot.

The production Linux singleton delegates to this group preparation. Cancellation
already observed at execution entry now retires the reservation before promotion;
a failing-before regression showed the old boundary created unnecessary durable
recovery work. Cancellation racing promotion still retains recovery evidence, and
a displaced original must finish publication. Real grouped tests verify independent
replacement/restoration, preserved inverse tokens after later cancellation or stale
source rejection, alias retargeting, object substitution, missing/invalid final
intents, cancellation during binding, and continued cleanup after one failed retire.

Verification: 488 focused Rust tests pass (12 ignored). Independent Sol adversarial
review accepts the preparation and singleton-execution contracts. All five rebuilt
Linux native recovery/lifetime scenarios pass, exercising production singleton
preparation. Binary checksums match before and after that final run. Clippy passes
with eight existing dead-code warnings; format, diff and maps pass, including
472/472 sources when untracked files are counted. Production bundle budgets pass
(45 static chunks, 671,703 bytes raw / 219,255 gzip). This is payload evidence,
not a startup measurement. Exact evidence is in
[copy-plan acceptance](reviews/recovery-copy-plan-2026-09-09.json).

Mixed ordinary/replacement planning, ordered overlaps, a panic-safe partial-result
ledger, one batch progress/cancellation owner, native grouped history and paste/drop
IPC migration remain open. Dropping an unexecuted prepared child abandons its
reservation for later native reclamation; this is not yet a complete batch executor.
Retention, other mutation families, platform/product qualification and measured Mac
startup remain required by the full review.

## Atomic independent-child admission — preceding checkpoint

Native recovery admission now commits a group of independent child reservations
in one SQLite transaction. Every child retains its own native owner and unique
generation, so replacement promotion and ordinary settlement remain composable.
Single-item admission uses the same path. All child paths/alias dependencies are
captured before admission; a managed revision change triggers full recapture.
Aggregate budgets cover the complete request/resource set. Cross-child write
intersections, including hardlinks and subtree overlap, are rejected before any
child is admitted; shared reads remain compatible.

Verification: 477 focused Rust tests pass (12 ignored), including atomic rollback
after a later duplicate ID, count/revision limits, unchanged user files, complete
recapture, independent durable promotion, and finishing an ordinary child while
its promoted sibling remains claimable. A real subprocess exits without Rust
destructors and its unpromoted children are reclaimed from native lock state.
An actual revision-overflow failure after owner-file creation returns no prefix;
a later healthy admission reclaims the orphan lock files. Independent Sol review
confirmed these scoped contracts. All five Linux native recovery/lifetime cases
pass against the rebuilt binary, whose before/after checksums match. Clippy passes
with the eight existing dead-code warnings; formatting and maps pass, including
471/471 production sources when untracked files are counted. Exact evidence is in
[batch-admission acceptance](reviews/recovery-batch-admission-2026-09-09.json).

This is an independent-child admission primitive. Ordered overlapping copy plans,
exact ordinary-copy inverse identity, one batch worker/cancellation owner, retained
partial outcomes and paste/drop integration remain implementation work. Existing
same-name/overwrite UI semantics must be preserved by that higher-level plan.
No whole-batch filesystem atomicity, external-writer exclusion, startup result,
platform qualification or full-review completion is claimed. The remaining
retention, operation, platform, product and integration gates below stay open.

## Completion diagnostics and prompt mutation refresh — preceding checkpoint

Native history execution now carries completion warnings independently of errors.
An inventory publication warning no longer prevents the next action in a batch
from executing. Copy/delete diagnostics, missing opposite receipts and retention
warnings use the same path; genuine failures still stop later effects and retain
the ordered partial-result partitions. Diagnostics preserve first-occurrence order
and bound content to 32 messages / 16 KiB UTF-8 including an omission marker.
Warning-only frontend completion preserves success and Redo; mixed replies retain
their actual error.

Native filesystem publication now preserves mutation origin through coalescing.
The existing refresh manager anchors a 150ms deadline at the first mutation request,
bypasses the watcher interval and waits for any active listing to finish. Later
watcher churn cannot move that deadline. Navigation and per-subscriber observation
guards remain in their existing owners; pure watcher traffic retains its debounce
and adaptive backoff.

Verification: 464 focused Rust tests pass (11 ignored), alongside 79 frontend tests
across 11 files. Final native acceptance
passes five recovery scenarios and two mutation-coalescing/external-watcher cases
against the same binary. The final detached Undo changed the named surviving row
from 22 to 24 bytes 241ms after gate release and 152ms after its fresh mutation
receipt. These are DOM observations in one Linux/Wry run, not first-paint, startup,
tail-latency or cross-platform guarantees. The held-listing test now uses canonical
native mutation admission and explicitly requires mutation receipts; its separate
external-write case verifies notify-only adaptive cadence. Independent Sol review
found and confirmed the fix for the initial deadline-postponement defect and
reviewed warning semantics and native evidence. Full current
checks and source/log/binary hashes are in
[warning/refresh acceptance](reviews/recovery-warning-refresh-2026-09-09.json).

Grouped replacement admission/history, ordinary-copy recovery admission, artifact
retirement/quotas, remaining mutation families, platform acceptance, longer soaks,
product matrices, measured macOS startup and final integration/publication remain
open. This checkpoint completes two prerequisites, not the architectural review.

## Production overwrite Undo/Redo — preceding checkpoint

Linux overwrite receipts now mint native Replacement actions with durable operation
ID, content revision and a non-authoritative refresh projection. Renderer input
cannot mint or deserialize replacement authority; completion replies expose only
the display path. Undo restores the retained original, Redo reapplies the independent
copy, and successful settlement retains the newly confirmed opposite revision.
Inspect does not stale this history. Stale/busy admission preserves an unchanged
inverse; interrupted execution consumes an uncertain inverse and preserves recovery
evidence. History clear/eviction does not retire durable artifacts.

The existing independently owned history supervisor captures refresh paths before
execution and publishes them once after settlement. The recovery worker publishes
inventory after releasing native ownership. A destroyed renderer's local history
is retired, while its accepted work still completes and surviving panes refresh.
The frontend reports native replacement completion through its separate presentation
type, without adding a renderer-executable replacement action.

Verification: 435 focused Rust tests pass (11 ignored), 27 focused frontend tests
pass, and all five Linux native Tauri cases pass. Native acceptance performs two
actual production overwrite Undo/Redo cycles with Inspect between each, then uses
the recovery dialog. Its fifth case gates Undo admission, destroys the child and
releases work externally; target/private-copy/source bytes, exact-ID recovery update,
unchanged surviving history and the refreshed 24-byte row are verified. Independent
Sol review caught an early screenshot of stale metadata; the strengthened visible
row assertion passes without a production change. Typecheck is clean; Clippy passes
with the eight existing dead-code warnings. Exact evidence and limitations are in
[overwrite-history acceptance](reviews/recovery-history-integration-2026-09-09.json).

Native grouped replacements, warning/failure separation before batch integration,
artifact discard/retirement and quotas remain required. Ordinary-copy and remaining
batch admission, cross-platform qualification, broader interruption/soak acceptance,
measured macOS startup and publication remain open. This checkpoint qualifies the
Linux single-replacement history path, not the full review or release.

## Repeatable replacement execution — preceding checkpoint

The durable executor now reapplies the retained independent copy after restoration,
without requiring the original source to survive. It persists ReapplyIntent before
parking the original and reuses verified native publication. Exact endpoint policy
rejects foreign targets and missing/modified copies; interrupted reapplication can
resume or restore the original. Directory permissions and dangling symlinks survive
repeated cycles.

Native history admission now distinguishes ownership generation from confirmed
content revision. Read-only Inspect may advance ownership without staling a native
history token; a completed restore/reapply cycle invalidates earlier content tokens
even after returning to Published. Revision and stable position are checked inside
the same admission critical section as native ownership. Pending effects require explicit
recovery. Counter exhaustion is fenced before effects begin.

Verification: 430 focused Rust tests pass (11 ignored helpers), including real
subprocess kills after both reapplication renames and after durable publication,
competing native owners, repeated cycles, source deletion, foreign occupants and
semantic history staleness. Independent Sol reviews confirmed the native boundary
and revision contracts. Process-kill coverage does not prove power-loss persistence.
See [reapplication evidence](reviews/recovery-reapplication-2026-09-09.json).

This is the native execution/admission foundation. Production overwrite Undo/Redo
history integration remains pending; its existing user warning remains accurate.
No new UI/native-app acceptance, startup measurement or publication is claimed.
All remaining review and release gates below remain required.

## Production Linux copy replacements — preceding checkpoint

The production `copy_entry` command now acquires acknowledged renderer ownership
and settles native forward effects in an independently owned task. Linux existing
destinations use the durable executor: captured source/target/root resources,
version validation, catalog promotion, private staging, displacement and verified
publication. Ordinary copy naming is preserved. Cancellation before durable work
keeps its ordinary result; interrupted durable work retains evidence and reports
uncertainty. After displacement, publication finishes without a cancellation point.
Task registrations release through worker unwinding.

The runtime attempts inventory publication from the same worker after its effect
owner releases, including a real copy whose reply waiter disappears and a worker
panic. Inventory failures now log a diagnostic and surface a committed-reply
warning without retrying effects. An independent review also exposed stale
physical-directory cache entries after copies through symlink aliases. A real
listing regression failed with the old 14-byte snapshot after a 12-byte replacement;
prepared ownership now retains and publishes the distinct physical parent through
the shared watcher/cache boundary, including failed execution.

Replacement receipts no longer enter ordinary path-only Copy history in single
transfers, paste or drop batches. Four failing-before frontend regressions cover
that invalid inverse and uncertain errors misclassified as simple cancellation.
Successful replacements remain counted as committed work and show their retained
original/Undo limitation. Ordinary copy grouping still uses existing frontend
history; native grouped copy ownership and overwrite Undo are not yet implemented.

Verification: 417 focused Rust tests pass (10 ignored), 79 frontend tests and six
Chromium clipboard/copy/job/grouped-drop outcomes pass, and the four-case Linux
native suite passes. Its new case dispatches the production
transfer/API/command path, observes the newly journaled ID in the live dialog,
then restores that exact operation while checking original/source/private payload
bytes. It bypasses clipboard and conflict-dialog interaction. Typecheck, format,
architecture, maps, Clippy and startup bundle budgets pass. Independent Sol reviews
cover the source, corrective tests, native logs, fixture bytes and screenshot.
Exact artifacts and limitations are in
[production-copy acceptance](reviews/recovery-production-copy-2026-09-09.json).

Overwrite Undo, discard/retirement, retention quotas, ordinary-copy and whole-batch
recovery admission, remaining mutation families, cross-platform acceptance and
measured macOS startup remain required. This is local integration work, not release
or full-review completion.

## Completed recovery ownership — preceding checkpoint

Ordinary admission and explicit recovery now share one effective conflict index.
Verified idle, error-free Published/Restored operations release public source and
destination paths while retaining exclusive root/payload namespace and physical
identity claims. Active owners, incomplete phases, recorded errors and missing
checkpoints retain full declared authority. Malformed checkpoints or substituted
owner locks fail admission. Explicit recovery checks its full resources against
peer effective claims before acquiring the exact owner and advancing generation.

Failing-before native regressions exposed the previous permanent public-path
lockout. Tests now cover hardlink and relocated-root aliases, live workers,
recovery/reservation contention, damaged records and two successive replacements
restored in safe order. A subprocess positively verifies that the persistent
admission gate remains held after the idle owner probe closes, keeping probe
descriptor use constant without admitting another effect owner.

Verification: 362 focused Rust tests pass (8 ignored). The rebuilt Linux native
suite passes all three cases, now also renaming the restored file through Explorer
and back while asserting real file bytes and refreshed listing names. The same
binary passes two controlled renderer-crash cycles. Typecheck (0 errors/warnings),
architecture lint, formatting, map coverage and all-target feature Clippy pass
(8 existing library dead-code warnings). Independent Sol review confirms the
ownership claims within the documented native-storage boundary. Exact evidence
is in [effective-claims acceptance](reviews/recovery-effective-claims-2026-09-09.json).

Production overwrite journaling is the next integration step; this checkpoint
does not connect ordinary copies to the durable executor. Overwrite Undo,
retention/retirement, remaining operations, cross-platform qualification and
measured macOS startup remain open. No publication or full-review completion is
claimed.

## Native recovery IPC and renderer lifetime — preceding checkpoint

Linux native acceptance now seeds an abandoned replacement through the real
Coordinator, reservation and replacement executor, then clicks Inspect/Restore
in the actual Tauri dialog. Filesystem assertions prove the original returns
home and both the copied source and privately retained copied payload survive.
This exposed a displayed recovery location that still named `root/original` after
restoration moved it away. The service now reports the artifact container and the
dialog labels it “Artifacts”; a failing-before service regression and real native
UI reproduction cover the correction.

IPC Channel ownership now belongs to the command adapter; the recovery runtime
accepts typed snapshot delivery. Test-only native registration IDs distinguish
channels across windows and renderer generations. An independent Sol review
caught the initial test's unsafe assumption that JavaScript channel IDs were
unique across those lifetimes; the final receipts and assertions use native IDs.
Two real renderer reloads and native child destruction drop deliberately unmanaged
channels without frontend unsubscribe. The surviving/replacement subscriptions
receive the exact operation generation advanced by native inspection, including
after old-session acquisition rejection and harmless stale release.

The retained GTK WebView crash controller additionally survives two externally
killed renderer processes in the same native application/window/WebView. It waits
for actual Channel destruction while the renderer is dead, before any reload or
JavaScript evaluation. New subscriptions then receive real durable-generation
updates. The external runner verifies both preserved payloads and native receipt
ordering; the screenshot demonstrates post-crash navigation and selection.

Verification: 353 focused Rust tests pass (7 ignored); all three native UI/lifetime
cases and the two-cycle native crash scenario pass against the same binary.
Typecheck, architecture lint, map validation, all-target feature Clippy and bundle
budgets pass. Startup still has 45 static chunks, 670,989 raw / 218,996 gzip bytes;
the recovery subscription and test probe are outside the static startup graph.
Sol independently reviewed the source, actual acceptance logs and screenshots.
Exact source/log/binary hashes and limitations are in
[native evidence](reviews/recovery-native-2026-09-09.json).

This qualifies Linux acknowledged recovery subscriptions and explicit restoration.
Real IPC interruption during initial registration/actions, forward production
replacement journaling, discard/retirement, overwrite Undo/retention, remaining
mutation families, Windows/macOS, longer soaks, product acceptance and measured
macOS half-bounce startup remain open. No full-review or release completion is
claimed; these changes remain local.

## Deferred recovery UI — preceding checkpoint

Recovery is now a page-owned lazy service, with notice, command-palette entry,
inspection/restore dialog, visible discovery errors and explicit reconnection.
Each page creates its own state; repeated disposal awaits the same cleanup and
late module loads cannot subscribe after teardown. Picker windows never construct
recovery, and parked warm windows wait for successful activation acknowledgement.
Foreground readiness starts background discovery after the existing paint
opportunity. An errored initial directory can independently enable recovery
without reporting successful startup.

The lightweight notice remains visible in a compact attention row when the status
bar is hidden. Shared lazy-dialog and modal ownership handle loading, failure and
closing. Accepted actions park focus before disabling/removing their trigger;
completion restores the surviving Inspect button only while the same modal and
focus still belong to the request. Delayed completion cannot steal focus from a
closed/reopened dialog. Browser regressions reproduced the original focus escape
and hidden-notice defects; a unit regression reproduced early repeated disposal.

Verification: 56 unit tests, 18 Chromium tests and 13 WebKit tests pass, including
all three explorer views and 320/768/1024/1440px recovery layouts. Checks cover
inspection and restore presentation, retry/reconnection, unavailable initial
navigation, usable file navigation during a held recovery import, dialog loading
failure and delayed-action focus. Type checking, architecture lint, map validation
and production bundle budgets pass. The 45-chunk static startup graph totals
670,989 bytes raw / 218,995 bytes gzip and excludes the recovery store, subscription
IPC and dialog. These are bundle/readiness contracts, not measured startup latency.

Sol independently reviewed source, actual logs and desktop/320px screenshots;
Luna found already-staged compatible WebKit libraries after its initial loader
failure. No packages or system files were changed. Exact source, logs, screenshot
hashes and acceptance limits are in
[UI evidence](reviews/recovery-ui-2026-09-09.json).

Browser fixtures replace the API port and do not prove native recovery effects or
Tauri Channel/Webview destruction. Native-binary IPC and renderer-teardown
acceptance are next. Forward production replacement journaling, discard/retirement,
overwrite Undo/retention, remaining mutations, platform/soak/visual qualification,
measured macOS half-bounce acceptance and publication remain open. Changes are
local, and the full architectural review is not complete.

## Recovery subscription lifecycle — preceding checkpoint

Linux recovery now registers subscribe/unsubscribe alongside list/inspect/restore.
One channel follows each exact acknowledged renderer lifetime. Monotonic decimal
client tokens survive module reloads and fence reordered registration, cancellation
and release; old callbacks and late acknowledgements cannot update a replacement
consumer. Retirement releases channels without waiting for another request. The
registry is bounded to 128 renderer lifetimes and uses weak retirement tasks.
Tauri channels themselves retain webview references until released; native owner
retirement, not merely the weak task, is what breaks that retention.

The owned blocking worker publishes successful inventory/inspection/restoration
results even if its requesting IPC awaiter disappears. Failed operations publish
fresh inventory when available without replacing the original error or retrying
file effects. This observes same-process recovery requests; it adds no polling or
cross-process filesystem observation. If no fresh inventory can be read, the
requesting caller gets the error and other subscribers retain their last snapshot.

A failing-before frontend regression demonstrated that an unrelated inventory
refresh erased inspected details and actions. Pending records now retain prior
inspection presentation only while their ID/generation is unchanged. Native
resolution still reclaims authority and validates endpoints before effects.

Verification: 352 native recovery, mutation, history, Git-watch and renderer-owner
tests pass (7 ignored), including cancelled discovery/awaiters, publication, failed
delivery and reference-cycle retirement contracts. Twenty-three frontend tests,
typecheck, architecture lint, all-target Clippy,
formatting and map coverage pass. Independent Sol review found no blocking issue.
Exact source/log evidence is in
[subscription evidence](reviews/recovery-subscriptions-2026-09-09.json).

At this preceding checkpoint, recovery-store startup and visible UI integration
were pending. Native binary IPC/GUI acceptance for subscriptions remains pending. Forward production
replacement journaling, discard/retirement, overwrite Undo/retention, remaining
mutation families, platform qualification and measured startup acceptance are
still required. These changes remain local; the full review is not complete.

## Backend recovery inspection and restoration — preceding checkpoint

Linux now has registered asynchronous list, inspect and restore commands through
the shared blocking runtime. Inventory validates bounded catalog/index evidence
without probing user volumes or offering actions. Explicit inspection claims the
exact native owner and generation before reopening the recorded root/manifest;
restoration claims again and revalidates native endpoints. Busy/stale requests
and changed evidence preserve entries. Restored originals keep their copied
payload privately; cleanup is still explicit pending work, and discard is not
advertised. Initial missing-index discovery shows immutable catalog evidence
without recreating the index or inventing ownership; later initialized-storage
failures stay errors rather than replacing a live view with revision zero.

Recovery IPC generations/revisions are now canonical decimal strings. A reproduced
numeric-serialization failure drove the lossless boundary; native claim/restore
and frontend ordering/action tests cover adjacent counters above JavaScript's
exact integer range. The original journal remains numeric and unchanged.

Verification: 237 Rust recovery/mutation tests pass (6 ignored), including real
native restoration through the production blocking runtime. Twenty frontend
tests, typecheck, architecture lint, all-target Clippy, formatting and maps pass;
Sol independently reviewed code and actual logs. Details and exact limits are in
[service evidence](reviews/recovery-service-2026-09-09.json).

At this preceding checkpoint, subscription/unsubscription, recovery-store
startup and visible UI integration remained incomplete. Forward production
replacement journaling, discard/retirement, overwrite Undo/retention and broader
operation/platform acceptance are still required. No native-binary IPC/GUI or
startup latency measurement was performed for this checkpoint. Changes are local.

## Linux restoration and publication retries — preceding checkpoint

Restoration now preserves the copied payload privately before returning the exact
original to an absent destination. A pure three-endpoint policy distinguishes
parking, restoring, completion and conflicting evidence; source availability is
irrelevant. Durable restoration intent precedes effects, exact owner/state checks
remain on retries, and completion repeats directory barriers even when native
restoration already happened. Nothing is deleted by restoration.

Real process-kill tests now resume after copy parking and original restoration.
Native file/tree/symlink cases cover collisions, modified data, source disappearance,
protected originals and interrupted replies. A failing-before regression exposed
parking a substituted target after permission preparation; a full endpoint recheck
now prevents it. A second regression exposed owner-unreadable copied directories.
Linux now pins them with O_PATH, prepares permissions through the exact descriptor,
and opens that same directory for synchronization. The guarded procfs fallback is
also tested after namespace replacement. Original permissions are never relaxed to
force a native move.

Verification: 989 Rust tests passed in the full run; two localhost tests passed
with loopback access after sandbox denial, for 991 accepted across runs (13 ignored
in the full run). All-target Clippy, formatting, maps, native ARM64 source/test
compilation and the shared Windows harness pass. Sol independently accepts the
Linux scope. Commands, hashes and limits are in
[restoration evidence](reviews/recovery-restoration-2026-09-09.json).

Publication retries now also reacquire finalized owner-unreadable Linux directories
through that descriptor adapter. Only an exact finalized, already-published copy
with a denied ordinary read-open enters permission preparation. The temporary mode
is the recorded staged version, so interruption stays recognizable; authority and
both named endpoints are rechecked before finalizing the retained directory.
A failing-before mode-000 regression now passes across six final modes. Persisted
`PublishIntent` reclaim/reopen completes modes 000 and 300; interrupted preparation
and source/original/root/target/private-publication substitutions have native tests.
The current focused recovery suite passes 201 tests (6 ignored), with all-target
Clippy, formatting, maps and independent Sol review passing. See the
[publication retry evidence](reviews/recovery-publication-retry-2026-09-09.json).
The 991-test full-run evidence above predates this focused follow-up.

Discard/retirement, overwrite Undo/retention, early/unindexed recovery and production
integration remain open. macOS owner-unreadable directory recovery lacks a safe
public reopen mechanism and runtime qualification. No power-loss, full platform, app-latency
or half-bounce result is claimed. These changes remain local.

## Indexed restart ownership and native reopen — preceding checkpoint

Abandoned operations with recognized checkpoints can now be claimed through their
exact native owner lock, immutable catalog and inspected journal generation. Busy
owners cause no write. Successful claims retain the same intent/state and allocate
a fresh generation; stale requests, damaged evidence and overlapping ownership
remain fenced. Claims do not reclaim unrelated reservations or probe user volumes.
Artifact reopening requires the recorded root identity and exact local manifest,
and creates or repairs nothing.

The real process-kill test now verifies that a second coordinator is refused while
the child is alive, then claims and reopens after death and finishes interrupted
displacement/publication. Source, published copy and displaced original retain
their expected bytes; immutable catalog and manifest remain unchanged. Native
contention, stale/lost replies, unavailable user files and malformed/unindexed
checkpoint cases have additional contract coverage.

Verification: 965 Rust tests passed in the full run; two localhost tests passed
with loopback access after sandbox denial, for 967 accepted across runs (13 ignored
in the full run). The focused recovery suite passes 177 tests. All-target Clippy,
formatting and maps pass; Sol independently accepts this scope. Commands, hashes
and limits are in [claim evidence](reviews/recovery-claim-2026-09-08.json).

Catalog-only/reservation-only evidence and interrupted root/manifest/staging still
need inspection and resolution; no `Planned` state is invented from missing evidence.
Restore/discard, retirement, overwrite Undo/retention, production integration and
the remaining review/platform/release matrix stay open. This is Linux native
process-recovery evidence, not power-loss or macOS startup acceptance. Changes
remain local.

## Native copy displacement and publication — preceding checkpoint

The executor now durably records intent before retaining an overwritten target
and publishing its independent staged copy. The original remains in the private
recovery root. Native no-replace renames classify both endpoints after errors or
success, repeat directory barriers, and record completion only after exact checks.
Directory publication restores its final permissions through a retained handle.
The operation format explicitly names `copyReplacement`; source-parking moves
cannot reuse its evidence contract.

Interrupted transfer intents can be retried by the same live executor, retaining
owner/catalog/checkpoint/generation validation. Native subprocess kills now cover
both transfers before completion checkpoints. Two failing-before regressions
reject hardlinked source payloads and stop permission finalization when authority
changes after publication. Sol's independent review found the latter ordering bug;
pre-effect revalidation fixes it while retaining final post-barrier checks.

Verification: 957 Rust tests passed in the full run; two localhost tests passed
with loopback access after sandbox denial, for 959 accepted across runs (13 ignored
in the full run). All-target Clippy, formatting, maps and shared-source Windows
compilation pass. Exact source hashes, commands and limits are in
[transfer evidence](reviews/recovery-transfer-2026-09-08.json).

Production callers, abandoned-operation claiming/reconciliation, restore/discard,
cleanup, overwrite Undo/retention and remaining operation families/platforms are
still required. Same-object metadata observations are not content hashes or atomic
tree snapshots. Process-kill evidence does not prove power-loss durability. No app
latency or Mac half-bounce result is claimed. These changes remain local.

## Anchored copy staging — preceding checkpoint

Replacement preparation can now build a private payload under durable
`StageIntent`, then record its observed version after filesystem barriers. The
copier uses retained directory handles, exclusive entry creation, streamed native
enumeration and one reusable transfer buffer. It copies regular files, directory
trees and literal symlinks, rejects special entries, bounds traversal/link sizes
and file reads, and checks cancellation between effects and chunks. File contents
sync individually; namespace barriers are batched at directory completion and
the outer parent. Requested root-directory permissions stay in the checkpoint
while the staged directory remains movable until publication.

The immutable intent now captures the source version. Two failing-before
regressions demonstrate that same-object writes and chmod after promotion must
not become the accepted source. Failed staging retains bounded UTF-8 diagnostics
without masking the native error if diagnostic persistence also fails. A real
subprocess kill during a multi-chunk copy leaves a partial private payload,
intact source/destination, discoverable intent and fenced overlapping paths.

Verification: 936 Rust tests passed in the full run; the two localhost tests
passed with loopback access after sandbox denial. That is 938 accepted tests
across runs, with 13 ignored in the full run. Sol independently accepts the
staging scope. Detailed evidence and limits are in
[staging evidence](reviews/recovery-staging-2026-09-08.json).

This code is not yet wired into production copy commands. Displacement,
publication, reconciliation, cleanup, overwrite Undo/retention and the remaining
operation roots/platform matrix are still required. Versions do not establish
an atomic recursive snapshot; copy metadata preservation currently covers
permissions, not ownership, extended attributes, ACLs or timestamps. Process
death is tested, power loss is not. Streaming/batching changes have no measured
application-latency claim, and the Mac half-bounce target remains unmeasured.

## Compact checkpoints and replacement preparation — preceding checkpoint

The journal now persists a catalog digest and mutable operation state instead of
rewriting the full immutable intent at every phase. A real 1,027-claim regression
has a catalog payload above 64 KiB and initial/next-phase journal payloads below
512 bytes. This is an encoded-payload result, not a latency, physical disk-write
or peak-memory measurement. Admission still validates the complete catalog.

The pure phase policy separates root, manifest, staging, displacement, publication
and resolution intent from observed completion. Phase CAS verifies the exact
native owner, catalog, previous state and generation; an exact committed retry
does not allocate another revision. Promotion checks the local manifest envelope
budget before publishing evidence. The concrete preparer durably records root
intent, creates and synchronizes its private directory, then records manifest
intent, publishes the exact local manifest and records preparation completion.
Retained native handles bind the full operation digest, including owner and
claims. Three reproduced regressions reject a different owner, changed claims
and a hardlink target alias before any manifest exists.

Verification: 916 Rust tests passed in the full run; two tests were denied
localhost socket access and passed when rerun with that access. That is 918
accepted tests across the runs, with 13 ignored in the full run. The focused
recovery run passed 141 tests, including real subprocess kill/reopen after root
creation and manifest publication. Sol independently accepts this scope. See
[checkpoint evidence](reviews/recovery-checkpoints-2026-09-08.json) for commands,
source hashes, compile checks and exact limits.

This prepares native artifacts but does not stage or replace user bytes. The
replacement executor, production command wiring, recovered-operation inspection
and resolution, overwrite Undo, retention and other mutation roots remain open.
Kill tests stop after completed effects, not inside syscalls or durability
barriers; power-loss durability is unproven. Windows compilation is not runtime
acceptance. The macOS half-bounce target remains unmeasured and changes remain
local.

## Durable reservation promotion — preceding checkpoint

Recovery now has shared durable authority with typed operation specifications and
states. Replacement artifact tokens remain independent of the native operation
ID, so their namespace can be prepared before ownership allocation. Catalog
validation binds each operation ID to its exact owner-lock name; a reproduced
malformed-catalog regression failed before that check and passes with it.

Promotion requires exclusive reservation ownership and rechecks its complete
stored authority. A bounded SQLite transaction checks capacity/revision before
catalog publication, then atomically changes reservation kind and generation.
Exact existing catalog evidence repeats file/directory durability barriers and
is revalidated by name and object identity. Interrupted publication retains
claims; an exact lost-commit reply can adopt the initial record without advancing
the revision. Failure returns the admission for retry, while the distinct durable
owner has no ordinary settlement capability. Worker cancellation preserves the
native lock through publication and leaves catalog authority after completion.

Verification: 890 Rust library tests pass (11 ignored), including real SQLite,
filesystem and native-lock interruption/cancellation contracts. A subsequent
11-test promotion run also passes, including a new native subprocess kill/reopen
regression at catalog-publication and database-commit boundaries. Sol independently
accepts the promotion infrastructure after the owner-binding and durability-retry
fixes. Exact commands, source hashes and limits are in
[promotion evidence](reviews/recovery-promotion-2026-09-08.json).

This is shared infrastructure, not delivered production artifact recovery. The
current typed operation variant is replacement; trash plans still need their
durable specification and per-item state transitions before integration. User-file effect
process-kill/disk-full recovery, reconciliation/UI, overwrite Undo, retention and
other mutation roots remain open. Windows checks cover shared source compilation,
not runtime durability; Windows still needs a writable sync handle and directory
barrier contract. Storage budgets are not peak process-memory budgets. Neither
power-loss durability nor macOS half-bounce performance is measured here.

## Whole-selection Linux trash planning — preceding checkpoint

The production batch setup now observes every requested source and nested parent
alias before choosing any destination. Destination failures cannot erase selected
ancestor claims. It then prepares every item's exact payload/final-info/staging
names, validates both fallback layouts and their directory actions against the
shared namespace index, and executes the aligned plans on the same owned worker.
Ordinary missing or destination-planning failures remain per-item outcomes;
semantic overlaps and aggregate bounds reject before filesystem effects.

The ledger and prepared selection share one immutable path vector. Identical
layout plans are interned by full value; shared dependency/container observations
are deduplicated without deduplicating source or exclusive artifact authority.
Preparation has a 32 MiB conservative plan budget plus a separate 32 MiB encoded
resource-index budget and 32,768 unique-claim ceiling. This is not a 32,768-item
promise: each ordinary item needs at least four claims, and layouts/aliases add
more. Transient capture allocations and other operation state have their own
bounds; 32 MiB is not a total process-memory claim.

Four reproduced regressions now reject aliased duplicate sources, an aliased
selected ancestor, deletion of another source's nested alias dependency, and an
ancestor whose destination preparation fails. Hardlink batch Undo, per-item
failures, late disappearance, collisions, shared-layout sizing and resource caps
have real filesystem/domain coverage. The complete Rust library suite passes
865 tests (11 ignored), and Sol independently accepts this scope. Detailed native,
compile and build evidence is recorded in
[selection evidence](reviews/recovery-trash-selection-2026-09-08.json).

Recovery reservations and durable artifact promotion are not yet connected to
this selection. Linux casefold/provider aliases still need stronger native
namespace identity; ordinary namespace observations cannot distinguish all such
aliases from distinct hardlinks. Cross-process races, crash reconciliation,
Windows/macOS and the full product/performance acceptance matrix remain open.
No deletion-latency or macOS half-bounce improvement is claimed.

## Hardlink-safe trash versions — preceding checkpoint

Linux trash preparation, move classification and Undo now share `EntryVersion`
with durable recovery. The pure object/version models and native capture live
under `files/`; trash does not depend on recovery infrastructure. Versions compare
object identity, size, mtime, type, mode and ownership while excluding ctime and
link count. Metadata receipts keep their strict ctime identity and content digest.

Two failing-before regressions exposed the old contract: deleting a second hard
link invalidated the first receipt, and executing one independently prepared link
invalidated its sibling's plan. Both now pass in all execution/restore orders.
Same-size writes with distinct mtimes, permission changes through sibling links,
direct directory changes, and post-rename changes remain rejected with source or
recovery evidence preserved. Full version checks also apply after restore.

Verification: 849 Rust tests passed in the main run; two localhost tests were
sandbox-denied and passed after rerunning with local socket access. That is 851
accepted tests across the runs, with 11 ignored. All-target Clippy passes with
unused-infrastructure warnings. Windows source/test cross-checks pass for the
shared recovery modules and restore adapter; these are not runtime acceptance.
Sol's independent adversarial review accepts the version contract. Exact evidence
is in [trash-version evidence](reviews/recovery-trash-version-2026-09-08.json).

These observations do not hash content or recursively snapshot directories.
Restored/coarse mtimes, extended metadata, nested descendant writes, identifier
reuse and check-to-rename races remain limits. The durable format gains required
Unix mode/ownership fields; it is unshipped and rejects records missing them.
Whole-selection admission and durable artifact promotion/reconciliation remain
open. No latency improvement or macOS startup acceptance is claimed.

## Prepared Linux trash execution — preceding checkpoint

Production Linux trash now separates read-only preparation from execution. An
owned item plan records the source, exact payload/final-metadata/staging names,
directory creation/open/repair steps and usable shared/personal destinations.
Preparation retries occupied names without creating files. Execution rechecks
source and directory identities, including mount IDs, and never invents a new
candidate. It preserves the Freedesktop fallback through metadata and payload
attempts, advancing only after confirmed no-source-effect cleanup. Uncertain
metadata or cleanup ends the operation rather than concealing retained evidence.

Two reproduced regressions are fixed: a source containing its own configured
trash destination is rejected before layout creation, and independently prepared
first-use operations can reuse an appeared private directory without following
links or introducing a permission repair. Sibling directory timestamps do not
invalidate a plan. The shared directory adapter captures mount identity through
the retained descriptor.

Verification: 348 filesystem Rust tests pass (7 ignored); all-target Clippy
passes with existing unused infrastructure warnings. Sol independently accepts
the revised prepared executor. Native smoke evidence and exact limitations are
recorded in [trash-plan evidence](reviews/recovery-trash-plan-2026-09-08.json).

This is per-item production preparation. Whole-selection planning, physical
cross-item overlap checks, aggregate plan budgets, recovery reservation binding,
alias-safe history and durable artifact promotion/reconciliation remain open.
Plans do not retain descriptors between preparation and execution; arbitrary
external namespace changes after validation and inode reuse remain limitations.
No startup or deletion latency improvement is claimed.

## Batch worker setup — preceding checkpoint

Linux trash context construction and whole-selection execution now share one
blocking job. Pooled and dedicated workers use the same read-only setup,
execution and cleanup boundary. An operation owner can remain with that job
through paused setup, caller cancellation and capture/context destruction;
confirmed sibling receipts and auxiliary refresh effects survive later panics.
This removes one blocking dispatch from Linux trash, with no measured latency
claim. Production trash still passes a unit owner: full recovery admission is
not connected by this change.

Verification: 335 filesystem Rust tests pass (7 ignored), including real trash
and exact-restore operations; all-target Clippy passes with existing unused
infrastructure warnings. Exact evidence and independent review are recorded in
[batch-setup evidence](reviews/recovery-batch-setup-2026-09-08.json).

The deletion audit requires a captured plan for source, payload, final metadata,
metadata staging and layout creation/permission-repair paths before mutation.
Execution must not choose an unclaimed fallback root or replacement candidate.
Retained metadata after cleanup failure needs durable recovery evidence before
ownership can retire. These remain implementation work; source-only admission
would not satisfy the deletion gate.

## Linux entry admission — preceding checkpoint

The five simple-entry command roots now acquire one lazy recovery reservation
before their owned filesystem worker runs. Tauri Runtime construction performs
no filesystem/SQLite work. The worker retains its reservation through execution
and capture destruction; settlement preserves confirmed receipts/history and
reports cleanup failure through the existing success-warning channel.

Independent review exposed two alias gaps. Execution now binds the captured
paths, and additional read claims protect every traversed parent symlink,
including aliases hidden inside literal symlink targets. Stable aliases retain
pane display paths while rename history owns the resolved path; both parents
refresh. A separate reproduced cold-initialization race now opens the gate
published by a competing initializer without recreating missing evidence.

Final verification: 829 Rust tests pass (11 ignored), all-target Clippy passes
with unused-infrastructure warnings, and eight real Linux native outcomes pass
across entry/history/navigation-lifetime suites with no skipped cases. Sol's
independent review accepts this scope. See
[entry-admission evidence](reviews/recovery-entry-admission-2026-09-08.json).
The test environment uses a temporary cache, clean shell startup and localhost
access; earlier environment failures are recorded rather than counted as passes.

This integrates Linux simple entries only. Deletion, transfers, inverse batches,
archives, plugins and Git mutation roots still need admission. Windows/macOS,
durable replacement/reconciliation/UI, retention and the complete release and
performance matrix remain open. The macOS half-bounce target is unmeasured.

## Integration and publication status

Production entry plans, Undo/Redo plans and worker ownership are implemented, with
[entry](reviews/owned-entry-plan-2026-09-08.json),
[inverse](reviews/owned-inverse-plan-2026-09-08.json) and
[worker](reviews/recovery-admission-workers-2026-09-08.json) regression evidence.
The five Linux simple-entry callers now acquire recovery reservations; remaining operation roots and other platforms do not. Journal/catalog
validation, Unix coordination and the shared lock/identity boundaries are foundation
work; Linux overwrite recovery, UI and exact Undo/Redo are integrated, while broader mutation adoption and retirement remain incomplete.

The latest changes remain local. Prior automatic approval review rejected public
pushes; no publication, merge or release acceptance is implied. Full checkpoint
narratives and their exact historical limits are in the
[archive](reviews/architecture-review-history-2026-09-08.md).

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
| File operation ownership and recovery | Native whole-intent copy/move/paste/drop/grouped rename, conflict revalidation, bounded progress/cancellation; exact inverse artifacts; durable discovery/reconciliation before source parking; overwrite Undo and explicit artifact retention; real crash and cross-filesystem acceptance | Five simple forward commands and selection deletion have native history ownership; the five Linux simple-entry commands now also hold recovery reservations, captured execution bindings and parent-alias read claims; Linux whole-selection source/alias observation and exact destination planning now have bounded resource checks and native acceptance, alongside exact trash identity and shared history; deletion recovery reservation is still open. Windows batch spelling validation is implemented and cross-compiled; runtime/physical-identity acceptance remains open. Explicit Linux recovery inventory/inspection/restore commands now use current native claims, with initial catalog visibility after index loss. UI subscription/startup wiring and explicit Linux native restore/reload/destruction/crash acceptance are implemented; production Linux overwrite journaling and single-replacement Undo/Redo are implemented and native-tested; warning/failure separation and atomic independent-child admission are implemented and tested; ordered paste/drop copy sessions and grouped ordinary/replacement history now pass Linux native acceptance; artifact retirement/retention, ordinary-copy recovery admission, ordered move/remaining forward batches and broader cancellation qualification are still implementation work; forward and inverse moves now share Linux recovery reservation and admitted path bindings, with Windows/macOS and real cross-filesystem acceptance outstanding. See ADRs 0018–0020 and the latest exact-trash/Windows admission evidence. |
| Product acceptance | Built-in themes, accessibility/keyboard behavior, narrow splits, view modes, DPI/zoom, preview formats and plugin failure combinations | Dense split viewport policy implemented with all three views, zoomed pointer/keyboard resizing, saved-layout preservation and Chromium/WebKit acceptance; Linux window/transfer regressions pass. Inline SCM/Miller minimum contributions, hoist/unmount shrink and continuous zoomed resizing now pass targeted browser/native acceptance. The focused resize migration is implemented; the wider themes/accessibility/platform matrix remains outstanding |
| Final integration | Typecheck, architecture lint, source maps, unit/perf/Rust/native/browser/load acceptance, screenshots, updated ADRs/report and issue; independent falsification of structural/performance claims | Outstanding |

Every completion update must name the actual production seam, regression or
measurement, result and limitations. Platform gates stay open until directly
verified; scaffolding a runner does not satisfy the gate. Additional findings are triaged against the frozen scope above; nonblocking
expansion goes to separate GitHub issues.

## Historical checkpoints

Earlier measurements, investigations and handovers are preserved in the
[checkpoint archive](reviews/architecture-review-history-2026-09-08.md).
They are historical evidence and do not supersede this ledger’s current gates.
