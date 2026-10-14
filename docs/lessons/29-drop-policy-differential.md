# #29: differential drop policy and gesture identity

Baseline: `origin/dev` at `773eb55a`. The executable oracle is
`tests/helpers/drop-policy.ts`; it imports no production routing. The production
runner is `tests/composables/drop-policy-differential.test.ts`. The historical full-visibility
reviewable expansion is [29-drop-policy-matrix.tsv](29-drop-policy-matrix.tsv):
3,159 source × target × modifier × transport × platform rows, 1,365 explicit
cross-window rows, twelve expired-identity rows (six per window scope), and 66
adversarial path rows, with dev outcome,
branch outcome and named intended difference. The TSV is a review artifact;
tests calculate expectations from the independent pure policy, not this file.
The seventh review adds 46 temporal orderings in `dropTemporalCases`; these
extend the static TSV with the event-producing gesture's policy.
The eighth review adds 26 pending-start/window-modal orderings (file and folder
sources across all thirteen target types) and ten outgoing Recent adapter rows
in `outgoingRecentCases`, with explicit platform Link-effect mappings.
The ninth review adds 2,457 delivery-order rows in `dropDeliveryCases` and 5,736
live-modality/completion rows in `dropModalCompletionCases`; these extend the
static TSV and run the real sidebar capture listener.

Sources: listing file, listing folder, Miller file, Miller folder, Recent
shortcut, sidebar bookmark reorder, external OS file, external URI-only drag, plain text,
plugin-specific DOM surface.
Targets: folder entry, breadcrumb, tab, bookmark, Quick Access, sidebar reorder
row, registered plugin target, dialog textarea, covered pane, listing background,
Miller background, unregistered plugin view, terminal. Modifiers: none, Ctrl, Option.
Platforms: Linux/WebKitGTK, macOS/WKWebView, Windows/WebView2.

`pane` is the SDK's actual source-kind string for Explorer file deliveries;
`external` means authoritative native filesystem paths without Explorer
provenance. A plugin-specific DOM payload is delivered to its DOM handler, not
the registered file handler. `text-insertion` in unit tests means uncancelled
browser default eligibility; the new report Playwright test asserts actual text.
`blocked` means the file adapter consumes the drop without transfer/delivery.
`terminal-insertion` records the ordered paths passed to the terminal's real
insertion seam, without a filesystem operation.

## Route semantics and policy rows

Rows below are ordered after payload/ownership admission. `C` means Option on
macOS and Ctrl on Linux/Windows. Other modifiers move. Sidebar reorder is a
bookmark-index-only HTML5 gesture, independent of every file source/consumer.
The reorder row is an ordinary bookmark destination for non-reorder sources.

| Source / route | Target | dev | branch / reason |
| --- | --- | --- | --- |
| Text or plugin DOM payload | Dialog textarea | Default cancelled | Text insertion eligibility; file adapters must leave non-file payloads untouched |
| Text or plugin DOM payload | Plugin | DOM handler receives it | Same handler delivery; ordinary default and propagation also untouched |
| Text or plugin DOM payload | Other built-in targets | No file outcome | Same; never borrow retained file state |
| Sidebar bookmark MIME | Reorder row | Reorder | Reorder; Quick Access and file adapters ignore this MIME |
| Sidebar bookmark MIME | Other targets | No file outcome | Same |
| Recent shortcut | Transfer / terminal targets | Link-only gesture rejects move/copy | Same across DOM, pointer, native start and native receiver; underlying directory is never transferred |
| Recent shortcut | Bookmarks / registered plugin | Pin on Bookmarks; no plugin capability | Pin or deliver `pane`; pointer drops on specific bookmark rows now pin like the Quick Access ancestor |
| External OS file, DOM only or native unavailable | Built-in transfer / plugin | No authoritative path; ignore | Same; never use `File.name`, text, or stale Explorer state |
| Explorer folder | Bookmark / Quick Access | Pin | Pin; native path multiset recovers Explorer identity and order |
| Explorer file / external file | Empty Quick Access | Ignore | Same |
| Explorer native file/folder | Folder / breadcrumb / tab / file bookmark / backgrounds | Move | Linux listing remains move-only; newly native Miller retains DOM rules, pointer drag-out honors C |
| External native file | Folder / breadcrumb / tab / bookmark / backgrounds | Move; C copies | Same |
| Explorer DOM file/folder | Folder / tab / Miller background | Move; C copies | Same |
| Explorer DOM file/folder | Breadcrumb / listing background | Move | Same |
| Explorer same-window pointer file/folder | Folder / breadcrumb / tab / file bookmark | Move; Option copies, including Windows dev bug | Move; C copies; Windows copy chord corrected to shared host policy |
| Explorer same-window pointer file/folder | Listing / Miller background | Move | Same |
| Ordinary filesystem payload | Terminal | Native/pointer insert paths; DOM-only ignores | Same; Recent remains link-only and does not insert |
| Admitted filesystem payload | Registered plugin target | Native fell through to transfer; pointer/DOM did not deliver host files | Deliver exactly once with `pane` or `external`; design29 capability |
| Filesystem payload | Unregistered plugin view | Native fell through to active directory; pointer/DOM ignored | Consume without transfer; plugin owns its surface |
| Filesystem payload | Dialog textarea / covered pane | Native could transfer; covered base content remained reachable | Consume without transfer; design29 modality |

For Linux Miller native delivery, breadcrumbs and listing backgrounds remain
move-only, while folder/tab/file-bookmark/Miller-background targets honor Ctrl.
For macOS/Windows pointer drag-out, native transfer targets honor the platform
copy modifier. Same-window pointer backgrounds stay move-only on both.

Transport cells do not invent native text or bookmark sessions. Those payloads
exercise their DOM owners under every adapter configuration. `native-rejected`
for Linux Explorer sources includes the surviving WebKit gesture's automatic
Wry events with `source:null`, followed by a possible DOM event. Rejection with
no automatic native event exercises DOM fallback in the lifecycle tests.
Non-Linux rejected cells exercise the HTML5 adapter fallback contract explicitly;
normal macOS/Windows listing/Miller source controls use pointer gestures. Native
accepted cells on those platforms drive the real pointer source past the viewport
boundary and through `startExternalDrag`. An external rejected/native-unavailable
cell supplies DOM Files only, which has no authoritative filesystem paths.

Cross-window rows instantiate independent source and receiver module graphs;
only native source metadata or shared storage can carry identity/policy across
them. The runner retains shared gesture history while those windows are alive
and drains source completion between rows. Clearing only storage would invent a
quota-loss boundary while leaving local gesture ordinals intact. Linux Recent
native cells feed the actual GTK URI-list carrier (the session URN) with
`source:null`; macOS/Windows cells remain synthetic receiver-provenance contracts.
Recent's actual sources never start an outgoing native file drag or export
filesystem URIs. `outgoingRecentCases` checks the HTML5 source, native-request
guard and actual macOS/Windows sidebar pointer source separately. No synthetic
event establishes physical effect negotiation with an OS destination.

Other intended design29 admission changes, covered by the companion domain and
lifecycle tables rather than normal disjoint-path Cartesian rows:

| Boundary | dev behavior | Intended branch rule / reason |
| --- | --- | --- |
| Malformed internal arrays, invalid filesystem paths | Could accept malformed/stale selection data | All-or-nothing validated absolute filesystem paths; reject without effects |
| Native subset, overlap or different multiplicity | First native path membership could adopt the full selection | Full multiset required; otherwise native payload stays external |
| Suspended, retired or disabled plugin registration | No registered-file capability | Consume; never transfer or deliver to a replacement target |
| Multi-selection native order | Native/persisted source fallback | Restore validated Explorer selection order; snapshot before await |
| Equivalent Windows separators in DOM tab/background no-op checks | Raw string comparisons could transfer to equivalent parent paths | Shared path equality/segment checks suppress equivalent-path no-ops |
| Native receiver IPC delay after rejected start | Could lose Explorer identity | Capture backend observation time and correlate the retained HTML5 interval |
| Expired/ambiguous source identity without verified Rust provenance | Could become an external copy/move | Cancel; identity eviction must never grant external authority |

The path rows cover literal POSIX backslashes and parents, case-only differences,
trailing separators, unresolved `..`, Windows UNC share identity, WSL suffix case,
and drive-relative source/target paths. Expected outcomes are literal table
values, without importing the production path helper. The TSV includes window
scope, both adversarial paths and the reason for every intended difference.
The matrix preserves primary-kind pinning. It is not a new mixed-selection
policy or an OS drag simulator.

## Root causes and fixes

1. A rejected Linux native start leaves a live HTML5 gesture, whose Wry events
   carry no Rust source. Correlate `source:null` with the HTML5 source and full
   path multiset. Capture Unix-millisecond observation time in the Wry observer,
   before IPC; retain eight gesture intervals across source-end/replacement.
   Frontend times use `Date.now()`, the same live wall clock as Rust SystemTime;
   origin-anchored monotonic browser time would diverge after clock adjustments.
   End-millisecond or backwards-clock ambiguity cancels uncorrelated observations;
   valid explicit Rust identity and receiver Enter snapshots still win. An
   observation outside the interval or an acknowledged native session cannot
   borrow the source. Receiver Enter snapshots survive later source end.
   A completed consumer receipt suppresses delayed native/DOM duplicates; native
   source completion alone is not a consumer receipt. Cross-window fallback uses
   the same bounded persisted history. Local records survive storage failures;
   a small rejected-start decision retains interval bounds so a peer missing the
   large path history cancels rather than classifying it as external. Replacing
   that decision first publishes a separate cancellation floor, preserving this
   protection after even one successor without evicting provable local history;
   monotonic ordinals prevent stale persisted copies from displacing new local
   gestures. Eviction publishes an observation floor: older observations cancel
   instead of becoming external transfers. DOM source timestamps suppress those
   expired gestures too. Consumer completion never shortens the physical HTML5
   interval. No elapsed-time suppression timeout.
2. Sidebar dragend and Quick Access took any retained source, including a pending
   plugin drop during bookmark reorder. Capture only Explorer file MIME, recover
   the event-bound source, and validate paths before pinning. Bookmark reorder
   uses bookmark MIME and never claims/finishes another filesystem gesture.
3. The window file adapter cancelled DOM defaults before checking MIME. Admit
   filesystem payloads first, across capture handlers and built-in DOM targets.
   Text/plugin DOM handlers receive untouched events, including while native
   handoff or a plugin consumer is pending. This follows conditional target
   cancellation and native editable-field behavior documented by
   [MDN drag operations](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/Drag_operations).
4. Sidebar clicks/Enter/Space bypassed pane ownership. The component delegates
   all folder/bookmark/Recent/drive navigation to `navigateFromSidebar`, which
   uses the same `dialogStore.isPaneBlocked(activePaneId)` gate as pane commands.
5. Managed image editors tracked plugin disposal only. Capture the caller before
   opening window ownership, bind its close callback to that specific editor
   session, and detach when the editor settles. Caller closure and pane retirement
   close the child synchronously without closing unrelated callers/replacements.
6. Additional defects found: old same-path DOM sessions adopted a successor's
   source; a stale event could defer on the successor's pending native decision
   and become valid on replay. Resolve event-bound identity, and tie pending
   decisions to that exact session before deferral. Completed DOM fallback also
   cannot be repeated by an already-observed but delayed automatic native event.

All five listed findings have failing-first matrix or targeted regressions.
Additional stale-session/pending-replay, delayed-observation, eviction, quota
merge, accepted-native clock-boundary and backwards-clock tests failed
before their fixes. Folder/breadcrumb/tab/listing/Miller/Quick Access/reorder
handlers were extracted into importable production seams, so the matrix drives
component-used logic rather than transcribing it into tests.

## Sixth review: shortcut authority, receiver lifetime and path semantics

1. Recent now starts `createHtml5FileDrag` with `link` authority. That policy is
   carried by DOM effect/MIME, persisted source metadata and Rust `Source`.
   The sixth-review native Link advertisement was removed in the eighth review:
   GTK3 Wayland maps Link to Copy, so it cannot enforce shortcut authority.
   DOM directory destinations and native receivers reject transfer; native
   terminal insertion also rejects Recent. Bookmarks and registered plugins
   remain eligible. Sidebar pointer sources carry the same policy and specific
   bookmark rows pin instead of losing the bookmark identity. The new Recent
   matrix rows and source-effect test failed before the fix.
2. Native receiver IDs are associated with stable labels during live runtime
   events and the platform snapshot callback, before delivery. Destroyed cleans
   queues and receiver identity through that recorded mapping, without calling
   the cleared runtime handle getter. The fake runtime regression failed by
   discarding the replacement receiver's first Drop. Independent review also
   found GTK's deferred Leave could run after destruction with a reused address;
   it now requires weak references to the original WebView and top-level window
   to remain valid and attached. `dispatch_deferred` checks that original
   receiver before observer/handler dispatch. Its failing-first fake lifetime
   regression verifies that a stale Leave never reaches the replacement.
3. `domain/path.ts::pathComparison(windows)` supplies one pure set of equality,
   parent and segment-containment rules to every branch-added/changed DOM,
   native and pointer no-op comparison. POSIX keeps literal backslashes/case;
   ordinary Windows comparisons share separator/case rules and preserve WSL's
   Linux suffix. Trailing separators and `.` retain directory identity.
   Unresolved `..` and drive-relative paths have no safe lexical identity and
   are rejected before transfer; collapsing `..` would guess through symlinks.
   This follows [POSIX pathname resolution](https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap04.html)
   and [Windows path formats](https://learn.microsoft.com/dotnet/standard/io/file-path-formats).
   Volume-specific aliases/case sensitivity remain backend responsibilities.

Further differences found by adversarial path rows: a native Miller/pointer
drag onto a tab now retains its prior DOM/pointer same-parent no-op rule, and
ambiguous destination paths are rejected instead of sent to transfer. Intentional
changes are named in `intendedDifferences`: platform path semantics/admission,
Recent plugin delivery/modality/bookmark-row parity, ordinary DOM defaults, pane
modality, registered/unregistered plugin ownership, Windows Ctrl copy policy,
new native handoff retaining DOM modifier rules, and expired-gesture cancellation.
Their exact applicability and reasons are in the executable oracle and TSV.

Independent review confirmed the changes and ran 4,678 focused tests. It found
the deferred GTK callback issue above, then verified the lifetime guard. No
remaining behavioral defect was reproduced; actual native effect negotiation
remains a platform acceptance check.

## Seventh review: retained sources and completion backlog

The failing-first frontend probe reproduced Recent bookmark drops moving the
folder instead of pinning, plugin delivery reporting `external` instead of
`pane`, and old explicit native provenance still authorizing transfers after
identity eviction (10 failures in the initial 22 temporal cases). A Rust probe
through the production completion seam also failed: with completion delivery
left queued, a later Enter/Drop for identical paths captured the cancelled
Explorer source. This is a deterministic callback-order regression; it does
not claim a physical native timing reproduction.

`dragState.start` now allocates a shared monotonic gesture sequence for every
HTML5/pointer gesture. Retained local consumers keep their original source,
while `latestSource` chooses the newer source across windows. Automatic GTK
events use observation time to select the newest matching HTML5 interval,
including live peer history, rather than requiring it to match local retained
state. A late reply only updates its own session; it cannot repair or rewrite
the receiver's already captured gesture.

The native completion callback retires `Registry.active` synchronously, then
queues only its frontend notification. Already captured receiver snapshots
remain valid; a subsequent external Enter cannot acquire completed identity.
Each Enter/Drop also snapshots `completedGestureSequence`, so an accepted
source whose start reply and HTML5 end are both backlogged cannot lend its
still-open frontend interval to a later external event. Failed starts retire
their native registration without advancing that marker: a newer rejected
Recent gesture remains eligible for automatic Wry recovery.
Rust source provenance requires the frontend's positive, JavaScript-safe
`gestureSequence` and preserves it in Enter/Drop events. Routing checks the
sequence against the last eight gestures even for an explicit matching source;
path verification no longer bypasses expiry. Sequence expiry also advances
through pointer-only successors and survives wall-clock changes. Automatic
source-less GTK observations retain the existing timestamp-floor admission.
Verified inferred sources also reject ambiguous end/start observations within
the same JS millisecond and backwards-clock intervals. They retain local proof
when only shared-storage quota/rejected floors advance; explicit Rust identity
and a previously admitted receiver snapshot use sequence expiry.

| Temporal ordering | Cases | Required outcome |
| --- | ---: | --- |
| Finished A retained with native reply pending; peer Recent B rejects native start; A's reply arrives after B Drop | 4 | B pins on bookmark or delivers plugin `pane`, for either A reply result |
| Same overlap, but A's reply arrives between B Enter and Drop | 4 | B retains its captured link-only identity |
| Cancelled listing completion notification backlogged behind later external same-path Enter, then delivered before Drop; start acknowledged/end delivered or both still pending | 12 | Platform copy modifier copies, or plugin receives `external` |
| Explicit old source delivered after eight HTML5 or pointer-only successor gestures in another renderer | 12 | Cancel without transfer or plugin delivery |
| Source completion arrives before delivery of the already captured Enter/Drop | 6 | Original listing policy and plugin `pane` survive |
| A newer same-path Recent gesture starts before delivery of the original captured events | 6 | Original listing policy wins, independently of the newer link-only source |
| A finishes and same-path Recent B starts in the same millisecond; delayed automatic event could belong to either | 2 | Cancel ambiguous inference without transfer or plugin delivery |

The Rust regression additionally verifies that pre-completion snapshots survive
while a later external Enter/Drop receives `source: null` and preserves Ctrl.
Malformed, zero, missing and non-JavaScript-safe native sequence values are
rejected before they can acquire provenance.
Independent review reproduced two additional failing-first Linux outcomes
before the completion-marker fix (`move` instead of `copy`, plugin `pane`
instead of `external`), plus same-millisecond successor misclassification.
The reviewer reran production-routing probes after the fixes. Native execution
on physical Linux/macOS/Windows desktops remains an acceptance check.

Final seventh-review verification:

```text
bunx vitest run tests/state tests/plugins tests/composables tests/domain tests/api --maxWorkers=2
Test Files  354 passed (354)
Tests       8123 passed (8123)

bun run check
website/api/report.js:2:26 Cannot find module '@vercel/blob' or its corresponding type declarations.
COMPLETED 1845 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo test --offline --manifest-path src-tauri/Cargo.toml native_file_drag
test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 2166 filtered out

Independent adversarial production-routing probes
Test Files  1 passed (1)
Tests       3 passed (3)

python3 docs/code-map/validate.py --coverage
coverage: 747/747 source files in map-folder.md
```

## Eighth review: deferred destination ownership and outgoing Recent

1. Deferred DOM fallback re-resolved the target, but the resolver gated modality
   only when a DOM ancestor carried `data-pane-id`. Window-strip tabs and other
   window chrome skipped that gate. `resolveDropOwner` now resolves every
   surface: a tab owns the active pane whose path `getTabPath` returns, pane
   content owns its marked pane, and remaining chrome owns the window. Deferred
   destination leases capture that owner and re-check live modality immediately
   before redispatch. A newly opened window modal covers every base target;
   another pane's modal does not cover the destination pane.
2. A `.modal-overlay` exemption was insufficient for registered dialog targets:
   ownership can change before Svelte applies `inert`/suspension. Independent
   review falsified pane-dialog coverage, older window-dialog coverage and
   unavailable window/pane surface admission. `modalOwnership.ownsInput` uses the
   same live top/availability predicate as the modal itself. Deferred registered
   targets require that input ownership even when an unavailable pane surface
   no longer blocks base content, retaining eligible active dialog drops.
   A window opening also requires window-scoped surface ownership, blocking pane
   dialog targets before the new window dialog mounts.
3. Dev's Recent HTML5 row exported only `application/x-explorer-kind`, with
   `effectAllowed = "link"`; its sidebar pointer source had no native handoff.
   Recent initially exported no `text/uri-list` or other standard filesystem payload
   (the visibility review below adds a private non-filesystem URI)
   and never starts an outgoing native file drag. Private Explorer MIME/state
   retain pinning and registered-plugin delivery. Frontend and Rust start
   boundaries reject link-only sources, with Rust admission before native path
   preparation, session registration or platform start.

Pending-start table (`dropTemporalCases`), each with both Miller file and folder
sources: drop on original surface → window ownership opens → native start
rejects. Every outcome must be blocked without redispatch, transfer, pinning or
plugin delivery:

| Original target | Owner | Expected |
| --- | --- | --- |
| Folder | Marked pane | Blocked |
| Breadcrumb | Marked pane | Blocked |
| Tab | Tab's active pane, or window strip without an explorer tab | Blocked |
| Bookmark | Window | Blocked |
| Quick Access | Window | Blocked |
| Sidebar reorder row | Window | Blocked |
| Registered plugin | Pane or window according to its location | Blocked |
| Dialog textarea | Owning modal surface; unregistered for files | Blocked |
| Covered pane | Marked pane | Blocked |
| Listing background | Marked pane | Blocked |
| Miller background | Marked pane | Blocked |
| Unregistered plugin view | Pane or window according to its location | Blocked |
| Terminal | Pane or window according to its location | Blocked |

Outgoing Recent table (`outgoingRecentCases`): HTML5 and direct native requests
on every backend, plus the actual sidebar pointer source on macOS/Windows.
These mappings describe the platform implementation, not physical reproduction.

| Platform backend | Native Link maps to | Dev filesystem URI export | Branch filesystem URI export | Branch native start |
| --- | --- | --- | --- | --- |
| GTK3 X11 | Link | None | None | Blocked |
| GTK3 Wayland | Copy | None | None | Blocked |
| AppKit | Link | None | None | Blocked |
| Windows OLE | Link | None | None | Blocked |

GTK3's [Wayland effect conversion](https://github.com/GNOME/gtk/blob/gtk-3-24/gdk/wayland/gdkdnd-wayland.c#L153-L164)
maps Link to Copy. Advertising only Link therefore does not provide a portable
filesystem shortcut contract; omitting the outgoing file payload restores dev.

Failing first: the deferred tab probes transferred behind actual window and
destination-pane ownership; the target table exposed sixteen redispatch failures
before the fix; Recent URI probes failed for all four backend mappings; Rust
accepted the shortcut source. The independent surface probes and permanent
   adapter regressions failed five coverage/availability cases, while their
two active-dialog controls passed. No physical Wayland reproduction was run.

Final eighth-review verification:

```text
bunx vitest run tests/state tests/plugins tests/composables tests/domain tests/api --maxWorkers=2
Test Files  354 passed (354)
Tests       8169 passed (8169)

bun run check
website/api/report.js:2:26 Cannot find module '@vercel/blob' or its corresponding type declarations.
COMPLETED 1845 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo test --offline --manifest-path src-tauri/Cargo.toml native_file_drag
test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 2166 filtered out

Independent adversarial production-routing probes
Test Files  1 passed (1)
Tests       7 passed (7)

python3 docs/code-map/validate.py --coverage
coverage: 747/747 source files in map-folder.md
```

## Ninth review: completion receipts and keyboard target scope

The failing-first expanded runner reproduced breadcrumb DOM completion followed
by a second automatic native transfer, and sidebar capture pinning after a
window-modal-blocked native drop. Shortcut target rows also failed for the tab
strip's new-tab button, toolbar and sidebar. The initial focused run reported
536 failures; most were newly exposed duplicate sidebar effects. Separate
cross-renderer receipt probes then failed all six HTML5/pointer rows: HTML5
receipt publication waited for the async handler, and pointer completion had no
persistent receipt at all.

Every file-drop completion now uses `dispatch-file-drop.ts::admitFileDrop`:
native routing, plugin delivery, DOM directory destinations (including
breadcrumbs), Quick Access DOM drops and capture-phase `dragend`, plus both
pointer adapters. It consumes blocked/no-op completions too, rejects DOM
completion during pending/accepted native handoff, and clears owned feedback
when a blocked drop is consumed. Destination resolution reads live ownership
immediately before admission. Sidebar capture additionally requires a connected
Quick Access element still owned by the sidebar; cached hover cannot authorize
a removed or newly registered plugin surface.

`dragState.claim` publishes its receipt before any consumer runs, through a
bounded shared history covering HTML5 and pointer gestures. Finish retires only
that source; eight successor gestures expire old identities rather than making
an evicted receipt eligible again. Existing HTML5 observation history retains
its delivered marker for delayed automatic Wry provenance. Independent review
found an introduced blocked-drop highlight cleanup regression; the shared
admission path now clears that feedback, and the independent probe passes.

Delivery order is an executable table dimension across all nine sources,
thirteen targets and three platforms: native-first, DOM-first, native delivery
after dragend, and DOM-only. Late delivery retains the actual pre-dragend
observation timestamp. Accepted/rejected native starts are independent rows;
DOM-only omits native start and delivery. Every row checks the complete effect
list, so duplicate transfers, pins and plugin delivery fail. The new named
`dom-first-pin-only-noop` difference makes one consequence explicit: a file's
DOM-first completion on the pin-only Quick Access ancestor is a no-op, and its
receipt prevents a late native event from turning it into a transfer.

The modality table opens window, destination-pane or other-pane ownership
between hover and completion. It covers seven file/reorder source classes on
all platforms and each delivery order, with actual document capture dragend;
three additional Quick Access rows complete through dragend alone. Pending
native-start/modal rows likewise dispatch capture dragend before rejection.
The runner keeps cached sidebar hover true during a blocked native completion
to exercise the reported stale-hover failure. Outcome labeling distinguishes
an uncovered pane from one covered by actual ownership instead of assuming the
`covered-pane` fixture name means it is still covered.

Keyboard scope now uses the marked pane for pane content, the active pane for
body/no-element events, and window scope for remaining chrome. Pane dialogs
therefore allow Ctrl+T from the new-tab button, toolbar and sidebar; window
modals continue to block it. Seven target-class rows assert actual command
execution under pane and window ownership. Existing background ownership tests
now use an explicit body target.

Independent adversarial verification passed 72 tests, including five probes:
late breadcrumb/native admission, stale sidebar hover under live window
ownership, retained pointer completion, blocked highlight cleanup, and stale
capture after receipt expiry. Permanent regressions also cover disconnected,
absent and re-owned Quick Access destinations. Physical native delivery remains
a platform acceptance check; these are deterministic production-routing tests.

Final ninth-review verification:

```text
bunx vitest run tests/state tests/plugins tests/composables tests/domain tests/api --maxWorkers=2
Test Files  354 passed (354)
Tests       16380 passed (16380)

bun run check
website/api/report.js:2:26 Cannot find module '@vercel/blob' or its corresponding type declarations.
COMPLETED 1845 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo test --offline --manifest-path src-tauri/Cargo.toml native_file_drag
test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 2166 filtered out

python3 docs/code-map/validate.py --coverage
coverage: 747/747 source files in map-folder.md
```

No commits were created. The check failure remains the known missing dependency.

## Tenth-review destination admission and clock corrections

Window-chrome focus previously selected window admission even when a command's
handler resolved a covered active pane. Commands now declare `scope` beside the
handler; pane operations default to the active pane, and cross-pane transfers
resolve the source plus their actual successor destination. Collapsing dual
panes declares every affected pane. A shared domain predicate admits both
keyboard routing (including fallback keys) and registry execution, so closing a
window command palette cannot authorize a mutation beneath a pane dialog.

Dialog input navigation eligibility also lives on each command declaration.
Native buttons retain Enter/Space activation before pane-dialog matching. New
Tab remains a window command: Ctrl+T from the tab strip works with a pane dialog
open, while a window modal blocks it. The executable table covers command scope
× seven focus targets × four modal states, plus the reported sidebar paste and
new-folder failures, three-pane destinations, palette dispatch, fallback keys
and rebound native-button activation.

HTML5 timestamps and platform observations previously used adjustable wall
clocks, with two persisted floors that could reject all fresh Linux external
traffic after rollback. Rust now captures `Instant` elapsed time and a random
process clock identity. Renderers sample that clock once against
`performance.now()`, carrying the full request/response interval as endpoint
uncertainty. No wall-clock comparison orders or expires a gesture. The
[High Resolution Time specification](https://www.w3.org/TR/hr-time-3/) describes
why monotonic clock realms must be correlated and cannot span separate runtimes.

Stored cross-window history/floors have authority only under the exact current
native process identity; legacy wall floors and prior-process records are
ignored. Sequence order governs history eviction and DOM expiry, with sequence
metadata replacing the DOM time stamp. Native listener setup waits for
calibration and cannot install after its owner retires. A source starting before
calibration cancels synchronously rather than exporting uncorrelated identity.

Failing-first runs reproduced both reported classes: the keyboard table and
sidebar regressions had 11 failures; the external plugin clock regressions had
two failures. Clock tables cover backward/forward corrections, zero/nine prior
gestures, and same-process/restarted receivers. Real calibration/admission tests
also cover distinct renderer epochs, invalid samples, uncertainty, and old
process observations. Independent review additionally reproduced and corrected
dual-pane scope, palette execution admission, and native-button ownership;
its final 194 tests passed. Independent clock probes exercised 0/80 ms IPC
latency, delayed observations and bounded identity expiry. Physical native
clock-correction delivery remains a platform acceptance check.

Final tenth-review verification:

```text
bunx vitest run tests/state tests/plugins tests/composables tests/domain tests/api --maxWorkers=2
Test Files  356 passed (356)
Tests       16488 passed (16488)

bun run check
website/api/report.js:2:26 Cannot find module '@vercel/blob' or its corresponding type declarations.
COMPLETED 1849 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo test --offline --manifest-path src-tauri/Cargo.toml native_file_drag
test result: ok. 22 passed; 0 failed; 0 ignored; 0 measured; 2166 filtered out

python3 docs/code-map/validate.py --coverage
coverage: 747/747 tracked source files in map-folder.md
```

Both new source files are also explicitly mapped (the validator counts tracked
files). No commits were created; the only check error is the known dependency.

## Acceptance still to run

Local verification after the sixth-review fixes:

```text
bunx vitest run tests/state tests/plugins tests/composables tests/domain tests/api
Test Files  1 failed | 353 passed (354)
Tests       1 failed | 8074 passed (8075)
Hook timed out in 10000ms: tests/plugins/pane-dialog-api.test.ts setup import

bunx vitest run tests/plugins/pane-dialog-api.test.ts
Test Files  1 passed (1)
Tests       8 passed (8)

bunx vitest run tests/state tests/plugins tests/composables tests/domain tests/api --maxWorkers=2
Test Files  354 passed (354)
Tests       8075 passed (8075)

bun run check
website/api/report.js:2:26 Cannot find module '@vercel/blob' or its corresponding type declarations.
COMPLETED 1845 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo test --offline --manifest-path src-tauri/Cargo.toml native_file_drag
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 2166 filtered out

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo check --offline --manifest-path src-tauri/Cargo.toml -p drag --target x86_64-pc-windows-gnu
Finished `dev` profile [unoptimized + debuginfo] target(s) in 20.62s

python3 docs/code-map/validate.py --coverage
coverage: 747/747 source files in map-folder.md
```

The check failure is the pre-existing dependency issue. The default parallel
suite reproduced the documented module-import setup timeout twice; its file
passed in isolation and the full suite passed with two workers. The vendored
drag Windows cross-check passed. The macOS cross-check is unavailable on this
Linux host: the Objective-C exception helper needs an Apple compiler/SDK (host
`cc` rejects `-arch` / `-mmacosx-version-min`). AppKit's Link constant exists in
the locked binding, but macOS native compilation/acceptance remains necessary.

Playwright was not run in this review. Run Chromium and WebKit with all view
modes: `ALL_VIEW_MODES=1 npx playwright test` and
`WEBKIT=1 ALL_VIEW_MODES=1 npx playwright test --project=webkit` for these specs:

- `e2e/pane-dialogs.spec.ts` (new sidebar click/Enter and managed editor retirement outcomes)
- `e2e/plugin-file-drop.spec.ts` (new plugin-specific DOM text delivery)
- `e2e/user-report-draft-persistence.spec.ts` (new actual text insertion)
- `e2e/breadcrumb-drop.spec.ts`
- `e2e/miller-to-bookmarks.spec.ts`
- `e2e/miller-columns.spec.ts`
- `e2e/multi-item-dnd-undo.spec.ts`
- `e2e/image-editor.spec.ts`
- `e2e/pane-tabs.spec.ts`
- `e2e/sidebar-recent.spec.ts`
- `e2e/terminal-panel.spec.ts`

Physical Linux rejected-start/automatic-Wry delivery remains a platform acceptance
probe, not a claim of native reproduction. Native file-drop/drag-out acceptance
on macOS and Windows also remains necessary. Use the private-display isolation
rules in AGENTS.md; never automate the user's active desktop.

The eleventh review found that folding case below the root on Windows suppressed
real transfers between case-distinct directories (NTFS per-directory case
sensitivity). Windows comparison keys now fold only the drive or UNC/WSL root;
a case-only difference below it is passed to the backend, as on dev.

## Regression: browser startup, rejected native start, and preview focus

The four browser regressions after 89242c4a had two independent causes:

- b50c4832 gated HTML5 payload creation on `dragClock.ready`, but
  `useExternalDrop.setup` calibrated only when Tauri was already present.
  The browser fixture started the app without Tauri, then injected its rejecting
  native boundary. Readiness became false, so dragstart exported no MIME and
  never reached `start_file_drag`. The folder, breadcrumb and tab destinations
  consequently received no file transfer. Initialize the clock during browser
  startup through the same mock-aware API used by the source. Keep the native
  clock admission gate and the completion receipts.
- 748e8ed5 narrowed active-pane input fallback to the document body. Clicking
  the shared preview can focus its `.preview-content`, outside the explorer's
  pane DOM. Escape therefore found no pane scope even though that preview
  displays the active pane. Resolve preview input to the active pane while
  keeping the tab strip, toolbar and sidebar as window-owned launchers.
  Destination-scoped command admission and tab-strip Ctrl+T remain unchanged.

The differential harness missed the drop regression twice: it mocked the
clock as permanently ready, and every Linux `native-rejected` row produced
automatic native Enter/Drop observations. A rejection does not guarantee those
observations. In addition, its `dom-only` delivery rows disabled native start,
so they could not represent rejected start followed exclusively by DOM delivery.

`dropRejectedDomCases` now separates attempted transport from observed delivery:
twelve rows cover listing/Miller file sources, folder/breadcrumb/tab destinations,
and plain/Ctrl modifiers. Both runners consume those same independent oracle
rows. The main runner suppresses native observations for DOM-only delivery.
`tests/composables/drop-clock-fallback.test.ts` additionally uses the real clock,
starts the listener in browser mode, injects the native boundary, starts the real
source, waits for rejection, and delivers through capture admission and the
component-used DOM destination seam. It checks transfer outcomes and attempts
a duplicate after dragend, which must still produce only one completion.

| Source (each) | DOM destination | Plain | Ctrl |
| --- | --- | --- | --- |
| Listing file / Miller file | Folder | Move | Copy |
| Listing file / Miller file | Breadcrumb | Move | Move |
| Listing file / Miller file | Tab | Move | Copy |

The clock regression and preview Escape test fail with their respective
production fixes reverted. Listener lifecycle fixtures wait for registration
before dispatching events, so their assertions still exercise late cleanup and
replacement registration after calibration.


## WebKit target visibility and stale HTML5 authority

`DataTransfer` at a target is a separate dimension from the source platform or
native transport. `dropVisibilityCases` expands every core, delivery-order,
rejected-start/DOM-only, expiry, receiver-window and path row under `full` and
`stripped`. Full preserves Chromium/WebView2 custom MIME; stripped projects only
`text/uri-list`, optionally with engine-derived `text/html`, after the actual
production dragstart. The runner uses a new target DataTransfer, so its source
binding cannot accidentally mask the projection. Pointer/native-only rows also
run twice; they keep their transport outcomes. Unrelated bookmark reorder,
text and plugin gestures retain their own DOM protocol.

`dropUriHtmlCases` explicitly covers both projections for rejected-start
folder/breadcrumb/tab drops and link-only Recent bookmark/plugin/breadcrumb
drops. The NavigationBar hover gate now calls the importable
`dragOverDirectory` seam using `acceptsFileDrag`; it previously required
`application/x-explorer-path`, so stripped visibility broke its own hover
admission even when the window capture handler cancelled dragover. Quick Access
completion also still required custom MIME and now uses the shared source-path
admission.

Recent sets custom path/name/kind/session/sequence/effect MIME and `effectAllowed`
to Link. It previously emitted no URI-list at all: stripping therefore left an
empty target payload, which HEAD's fallback could not accept. It now exports
only `urn:tauri-explorer:drag:<random-session>` as the standard URI carrier.
This contains no filesystem path; native drag start, directory mutation and
terminal insertion remain forbidden by its link policy.

HEAD's URI-shape plus live-state fallback had a reachable stale-source hole:
if dragend was missed, an external URI-only drag could adopt `latestSource()`
indefinitely, including across windows sharing the process clock. Matching a
file path or adding an age timeout cannot establish gesture identity. File
sources now carry a random session comment plus the ordered file URI list;
Recent carries its private session URI. `domSource` validates the complete
readable URI payload before returning a stripped source. Ordinary external URI
lists, even ones naming the exact same file, cannot borrow source authority.
The comment syntax follows [RFC 2483](https://www.rfc-editor.org/rfc/rfc2483.html).

`dropUriCases` asserts rejection across every target/platform with URI-list alone
and URI-list plus HTML: no source, missed local dragend, missed peer dragend,
retired source, mismatched clock, and mismatched session. Hover remains tentative:
its protected data store cannot expose a nonce, so lingering live state can still
cancel dragover. Readable Drop is the operation boundary and rejects the
unproven payload before capture dispatch. `acceptsFileDrop` applies that stronger
readable-data gate before folder/tab/Miller/Quick Access handlers cancel browser
default or propagation; hover continues to use `acceptsFileDrag`. This is gesture correlation, not a
security boundary against deliberate replay of an exact session-bearing payload.

`dropDeferredUriCases` covers a readable drop captured during pending native
start, then dragend, then native rejection. Its verified DataTransfer binding
permits replay after retirement without reopening arbitrary URI-list fallback.
Both window capture and destination routing must preserve that binding.

`dropStaleFilesCases` additionally covers unbound Files and Files plus URI-list
against retained sources. `domSource` now rejects those before reading retained
paths, closing the broader Files fallback hole exposed by the same review.

The static TSV above predates target visibility, external URI and deferred URI
rows; it is not regenerated or claimed to cover these dimensions. Their complete
executable expansion is in the independent oracle and production runner.

Failing-first evidence: expanded rows failed on HEAD for Recent, breadcrumb
hover, Quick Access completion and stale URI source adoption. With all HEAD
production changes temporarily reverted, the listing-file folder/plugin/terminal
stripped probe failed 79 rows (201 passed); production files were restored
byte-for-byte. The deferred replay regression failed before its bound-transfer
admission fix and now passes all 12 platform/target/visibility rows.

An independent isolated headless WebKit probe observed the old single file URI
as URI-list/HTML types with an empty readable URI, while the session-comment
payload retained readable data and custom MIME. Recent's private URN also
survived. This establishes same-window browser behavior, not native cross-window
or OS drag-out acceptance. [WebKit's URI sanitizer](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/DataTransfer.cpp) can omit the platform URL for
comment-prefixed lists; explicit native drag-out still receives unchanged file
paths, but rejected-native HTML5 OS export needs platform acceptance. If a
platform removes the session carrier, stripped DOM drops fail closed rather
than adopting lingering source paths.


Verification after restoration:

```text
bunx vitest run tests/state tests/plugins tests/composables tests/domain tests/api --maxWorkers=2
Test Files  364 passed (364)
Tests  26150 passed (26150)

bun run check
ERROR "website/api/report.js" 2:26 "Cannot find module '@vercel/blob' or its corresponding type declarations."
COMPLETED 1873 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS

bun run lint:arch
arch-lint: clean

bun run check:bundle
Gzip size:   91,615 bytes (89.5 KiB)
Startup JS:  62 chunks, 826,886 bytes raw / 276,609 bytes gzip
PASS: main chunk and full startup graph are within their budgets.
```

The final target-object refinement clones full visibility as well as stripped
visibility; its standalone differential run passed all 22,507 tests. The only
requested-check failure is the known missing `@vercel/blob` dependency.

## Twelfth-review Linux Recent native session resolution

Recent exports only `urn:tauri-explorer:drag:<session>` in `text/uri-list`.
WebKitGTK exports that carrier through GTK; vendored Wry strips `file://` only,
so the native receiver gets the URN unchanged with `source:null`. The runner
previously substituted the source's filesystem path, hiding a lost native
completion. Filesystem validation discarded the real URN, and an empty native
Enter could still suppress the matching DOM delivery.

Native resolution now identifies the singleton URN's exact HTML5 session before
validating paths. The existing observation interval, process clock, completion
sequence and bounded history remain authoritative; a delayed observation can
resolve the original source without adopting a replacement gesture. Only a
matching link-only session can substitute its complete ordered source paths.
An unresolved native event cannot take DOM ownership, and an empty native Drop
returns before completion admission or plugin dispatch.

Every Linux Recent native row now reads the actual production dragstart
URI-list and supplies `source:null`, across all target types, delivery orders
and both full/stripped target visibilities. Native-first pin/plugin rows assert
completion before any DOM fallback, because Wry may intercept delivery entirely.
Twelve additional rows cover empty, unrelated and mixed native payloads,
Enter-only versus Enter-and-Drop, and both target visibilities. Domain tests
cover malformed carriers, session/policy mismatch and complete ordered paths.
Outgoing Recent tests require exactly the session URN and no native start;
filesystem URI export remains forbidden.

Failing-first: the corrected Recent runner reproduced 120 failures. Reverting
all three production fixes after adding the empty-payload regressions reproduced
126 failures (2,515 passed, 19,902 skipped); the production files were restored
byte-for-byte. Independent adversarial verification passed 10 probes covering
empty/malformed events, Drop without Enter, original/replacement sessions,
retired observations and clock mismatch. Physical GTK delivery was inspected
through the vendored Wry code, not exercised on a native GUI in this review.

Final twelfth-review verification:

```text
bunx vitest run tests/state tests/plugins tests/composables tests/domain tests/api --maxWorkers=2
Test Files  364 passed (364)
Tests  26174 passed | 24 skipped (26198)

bun run check
ERROR "website/api/report.js" 2:26 "Cannot find module '@vercel/blob' or its corresponding type declarations."
COMPLETED 1873 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS

bun run lint:arch
arch-lint: clean

bun run check:bundle
Gzip size:   91,674 bytes (89.5 KiB)
Startup JS:  62 chunks, 827,403 bytes raw / 276,771 bytes gzip
PASS: main chunk and full startup graph are within their budgets.
```

The full run first exposed an incomplete bookmark-test platform mock; declaring
its existing Linux `isMac:false` contract corrected all six fixture failures.
No commits were created. The only requested-check failure is the known missing
`@vercel/blob` dependency.

## Thirteenth-review native intent, export and plugin ownership (native intent superseded below)

Review 13 exposed five gaps in the transport/lifecycle table. Each now has a
failing-first regression through production seams:

- GTK snapshots read `DragContext.selected_action` (suggested action only when
  no action has been selected), not Keymap's cached Ctrl state. AppKit uses its
  drag's modifier-filtered source operation mask; OLE negotiates from the
  callback's fresh key state and supported effects and returns that same effect.
  Unsupported AppKit/OLE actions cannot publish a file completion. The pure
  vendored `drag_drop_intent.rs` extractor is compiled and executed by
  `tests/helpers/platform-drag-intent.ts`, then its results feed the production
  receiver. Mid-drag Ctrl/Option changes initially failed four rows. Ordinary
  native modifier sources now offer `DragMode::CopyMove`; the Rust source-options
  regression failed first because the old source advertised Copy only. Actual
  pointer-source IPC also lacked modifier policy (20 failing rows); pointer
  sources now publish it. Linux HTML5 destination rules are classified separately
  from copy intent, preserving macOS/Windows pointer destination/hover behavior.
- Filesystem `text/uri-list` contains only valid file URIs. The random session
  token is HTML text, without a URL/link or filesystem path. Recent still exports
  only its session URN and cannot start a native file drag. The drag-out rows
  cover listing/Miller files/folders and Recent, with unavailable/rejected native
  startup. Old comment-prefixed source expectations failed first. Readable DOM
  admission accepts the exact HTML token or Recent URN; ordinary file URIs cannot
  adopt retained source state. The stripped runner projects the actual source
  HTML rather than inventing target markup; empty readable URI plus retained
  HTML is supported. The original headless WebKit probe confirmed only token
  visibility; it bypassed production publishing and admission. Review 16
  replaces it with actual file-list publishing and visible plugin delivery,
  including an HTML-only projection with all alternate formats removed.
- Sidebar dragend-only pending-start replay was added here, then removed in
  review 16 because it could override cancellation. See the known limit below.
- `pluginDomOwnership` defines ownership from host-issued component identities
  and mounted roots. Every contributed dialog/view/inspector/Preview section/editor
  tool is wrapped by `PluginContributionRoot`; the root is registered before
  child components and their actions mount. The nearest root owns its subtree.
  `registerFileDropTarget` throws before registering host chrome/body or another
  plugin's Inputs, and live predicates recheck ownership. Both reviewer scenarios
  failed first. The browser acceptance test attempts both invalid registrations
  before verifying the original two-file delivery remains intact.
- Plugin teardown closes all remaining dialogs owned by that opener's instance
  symbol. Managed-session cleanup still runs first, preserving its existing result
  semantics. A contributes/B opens unmanaged now closes on B disposal and releases
  pane blocking without unregistering A's contribution; this test failed first.

An independent reviewer falsified the first wrapper's lowercase component tag
and child-before-root action ordering. Both were corrected and verified through
real Chromium mounts, including nested A/B roots and unowned body checks. Further
native review found unsupported-action and pointer-policy integration gaps; their
regressions and guards are included above. No remaining transfer or duplicate
completion defect was found in the final review.

Relevant engine contracts:
[WebKit URI/HTML sanitizer](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/DataTransfer.cpp#L289-L316),
[GDK selected action](https://docs.gtk.org/gdk3/method.DragContext.get_selected_action.html),
[OLE callback effect negotiation](https://learn.microsoft.com/en-us/windows/win32/api/oleidl/nf-oleidl-idroptarget-dragover).
WebKit parses the entire URI-list value as a URL for native export, so an RFC-valid
comment prefix is still inappropriate here. Multi-file OS export retains the
engine's existing limitations; no physical Wayland/macOS acceptance run is claimed.

Thirteenth-review verification (uncommitted):

```text
bunx vitest run tests/state tests/plugins tests/composables tests/domain tests/api --maxWorkers=2
Test Files  364 passed (364)
Tests       26204 passed | 25 skipped (26229)

bun run check
ERROR "website/api/report.js" 2:26 "Cannot find module '@vercel/blob' or its corresponding type declarations."
COMPLETED 1876 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS

bun run lint:arch
arch-lint: clean

bun run check:bundle
Gzip size:   91,858 bytes (89.7 KiB)
Startup JS:  62 chunks, 829,373 bytes raw / 277,375 bytes gzip
PASS: main chunk and full startup graph are within their budgets.

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo test --offline --manifest-path src-tauri/Cargo.toml native_file_drag
test result: ok. 23 passed; 0 failed

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo check --offline --manifest-path src-tauri/Cargo.toml -p wry
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.50s

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo check --offline --manifest-path src-tauri/Cargo.toml -p wry -p drag --target x86_64-pc-windows-gnu
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.70s

rustc --edition=2021 --test src-tauri/vendor/wry/src/drag_drop_intent.rs -o /tmp/pdlg-wry-intent-tests
/tmp/pdlg-wry-intent-tests
test result: ok. 1 passed; 0 failed

Focused Chromium plugin/pane acceptance
44 passed (52.5s)
ALL_VIEW_MODES=1 plugin-file-drop.spec.ts
8 passed (13.6s)
WebKit file-drag-carrier.spec.ts
2 passed (6.5s)

python3 docs/code-map/validate.py --coverage
coverage: 754/754 source files in map-folder.md
```

The whole standalone Wry unit harness was additionally attempted, but its own
manifest requires uncached offline dev-dependency `glow 0.18.0`; testing Wry as
a non-workspace dependency also disallows dev-dependencies. Its new extractor
unit test therefore ran directly with `rustc`, and the same extractor is compiled
by every differential run. Linux/macOS physical drag negotiations and external
application export remain platform acceptance limits, not claimed successes.


## Fourteenth-review source-safe OS effects (historical; reverted below)

Native intent and acknowledgement must be different values. Reporting Move after
queueing delivery allowed an external source to delete data before any transfer,
including terminal/plugin/blocked destinations. Explicit outgoing CopyMove also
promised source deletion that no platform implements. All explicit native and
HTML5 filesystem sources now advertise Copy. In-app DOM/pointer moves remain
private operations; Copy-only native handoffs necessarily negotiate Copy.

Incoming OLE/AppKit return Copy/None from dedicated mappings while snapshotting
callback-time intent separately. X11 snapshots intent before changing its final
XdndFinished action to Copy and never requests GTK DELETE. Wayland needs a
selected-Copy gate for all non-Xdnd protocols (GTK3 Wayland destinations report protocol None): GTK3 advertises Copy/Move/Ask even with a Copy preference, and
non-Ask selected action cannot be changed after Drop. Reject Move/Ask/None before
delivery; finishing a selected Move with `del=false` alone is unsafe. Platform
contracts and negotiation/final-report table live in
`src-tauri/vendor/wry/TAURI_EXPLORER_PATCH.md`.

Native rejection/blocking is None. Tauri always admits queued delivery, so later
frontend blocking, terminal insertion and plugin delivery acknowledge Copy. The
frontend cannot retrospectively change that result. Differential rows explicitly
distinguish these layers and run the actual Rust effect mappings. Per-platform
unit tests cover Copy/None outputs, unsupported masks, Wayland selected-action
rejection and mid-drag action/modifier changes. A DOM row verifies public Copy
with an actual in-app Move outcome; outgoing source regressions failed first.


Fourteenth-review verification (uncommitted):

```text
CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo test --offline --manifest-path src-tauri/Cargo.toml native_file_drag
test result: ok. 23 passed; 0 failed

rustc --edition=2021 --test src-tauri/vendor/wry/src/drag_drop_intent.rs -o /tmp/pdlg-wry-intent-tests
/tmp/pdlg-wry-intent-tests
test result: ok. 4 passed; 0 failed

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo check --offline --manifest-path src-tauri/Cargo.toml -p wry -p drag --target x86_64-pc-windows-gnu
Finished `dev` profile [unoptimized + debuginfo] target(s) in 23.99s

CC_aarch64_apple_darwin=clang CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo check --offline --manifest-path src-tauri/Cargo.toml -p wry -p drag --target aarch64-apple-darwin
Finished `dev` profile [unoptimized + debuginfo] target(s) in 23.50s

bunx vitest run tests/state tests/composables --maxWorkers=2
Test Files  207 passed (207)
Tests       24441 passed | 33 skipped (24474)

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg bun run lint:arch
arch-lint: clean

python3 docs/code-map/validate.py --coverage
coverage: 756/756 source files in map-folder.md

bun run check
ERROR "website/api/report.js" 2:26 "Cannot find module '@vercel/blob' or its corresponding type declarations."
COMPLETED 1876 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS
```

The default macOS cross C compiler rejected Apple's flags; Clang passed the
installed aarch64-apple-darwin target check. Independent review falsified both
late Wayland action conversion and protocol==Wayland detection (GTK3 contexts
report None); the final non-Xdnd gate addresses both. Rejection explicitly emits
Leave before suppressing GTK's deferred callback. Final independent review found
no remaining blocker. Physical native/compositor interoperability was not run.


## Fifteenth-review restoration

Native effect, acknowledgement, advertised actions, copy/move intent and the
GTK drop gate/fallback are restored to `4fb58708`. The negotiated-action intent
extractor and selected-Copy gate from `b4bbba22` / `aca9841a` are removed. Those
changes made unmodified in-app native handoffs copy, rejected Recent plugin
drops on X11 when Copy was absent, and swallowed GTK bookmark/text DOM drops.
The thirteenth/fourteenth-review native-intent/effect descriptions and result
lines above record superseded work, not the current implementation.

GTK reads its cached Ctrl modifiers; AppKit reads Option; OLE reads callback
`grfKeyState`. Intent never comes from the source's Copy-only action offer.
Explicit native sources retain default `DragMode::Copy`. HTML5 filesystem
sources retain `effectAllowed=all`, and their DOM receivers retain the original
copy/move effects. Accepted AppKit/OLE native delivery retains Copy acknowledgement.
GTK retains `drop_finish(true)` for URI-list delivery, with no selected-action,
protocol or Copy-support gate, and returns false for a drop without URI-list so
WebKit's DOM handler can run. This restores the baseline GTK completion contract;
it does not assert a physically measured compositor effect.

The kept fixes are plain filesystem URI-list with session identity in HTML,
sidebar deferred-drop replay, plugin-owned target validation, and unmanaged
pane-dialog teardown with the opener. Their existing regression coverage stays.

`tests/helpers/platform-drag-intent.ts` compiles the actual restored modifier
expressions, GTK Drop callback body, OLE Enter/Over/Drop flow and accepted AppKit
Enter/Updated/Perform responses against inert platform adapters. Differential regressions assert native
handoff Move without a modifier, Recent plugin delivery through GTK without an
action-set gate, DOM bookmark reorder after GTK's no-URI fallback, external
Copy acknowledgement, and outgoing HTML5 actions. Rust source-option tests pin
outgoing Copy for every internal policy. These are callback/routing contracts,
not physical OS drag acceptance. The fixture also runs four Rust callback
regressions via `rustc --test`; its result can be printed with:

```sh
bun -e 'import { nativeCallbackTestResult } from "./tests/helpers/platform-drag-intent.ts"; console.log(nativeCallbackTestResult)'
```

The handoff regressions failed on all three platforms before restoration.
A separate compile of the actual pre-restoration GTK Drop body reproduced both
Recent-without-Copy rejection and consumed bookmark reorder; those same callback
contracts pass against the restored body. Independent review also falsified an
initial AppKit Updated coverage gap; the runner now checks every negotiation
phase and rejects an Updated-to-Move mutation.

## Known limits

On GNOME Wayland, Ctrl first pressed only after the native drag handoff may be
missed because GTK's cached modifier state can be stale during the native grab.
This is unverified on a physical desktop and is deferred to a follow-up; this
restoration deliberately does not fix it. Cached-modifier fixtures verify the
current contract and do not claim that mid-drag Wayland key changes are fresh.
Physical Linux/macOS/Windows compositor and external-application drag acceptance
remain unverified in this change.

## Sixteenth-review cancellation and production carrier acceptance

Restored `use-sidebar-drag-end.ts` exactly to its `4fb58708` behavior. A pending
native start no longer creates an independent synthetic root-sidebar Drop.
That replay could pin after Escape, or after a real bookmark-child Drop had
been cancelled because its destination was removed. Consumer receipts could
suppress duplicates of a successful drop but could not authorize a cancelled
one. Removed the `dropSidebarPendingCases` oracle rows accepting this replay.

Cancellation regressions use the production listing and Miller source adapters,
document capture dragend, and native-rejection routing. Escape rows cover a
rejection before Escape (with browser dragleave/zero-coordinate dragend),
between document dragend and source cleanup, and after source cleanup. Pending
rows keep stale sidebar hover deliberately. Destination-change rows remove the
bookmark child before or after document dragend and reject before or after
source cleanup. They require the cancellation notice and assert that neither
the child nor its Quick Access ancestor pins anything. Fourteen cancellation
rows now pass; before restoring the hook, eight of the initial ten rows failed
with an unwanted pin.

Independent review also forced bookmark removal and a fully settled rejection
between Drop and document dragend. That synthetic interleaving still pins through
the restored baseline fallback. It is not covered by the late-rejection safety
claim: the HTML drag processing model fires Drop and dragend sequentially in one
completion task, and no real-browser IPC interleaving was established here.
Exact restoration therefore does not prove cancellation safety under arbitrary
synthetic scheduling. Browser/native reentry remains unverified.

Known limit: if the browser delivers only dragend over Quick Access (no readable
Drop) while native startup is pending, and native startup rejects after dragend,
nothing is pinned. There is no trustworthy successful-drop signal in that
sequence. Keep the gesture cancelled rather than reconstructing a root-sidebar
Drop that can override Escape or destination-change cancellation. This edge
case is deferred for a separate issue.
Addressed by #1101 (fails closed; physical WebKitGTK unverified): see
`docs/lessons/1101-quick-access-late-native-rejection.md`.

`e2e/file-drag-carrier.spec.ts` now drags two selected real file-list entries to
the Demo plugin's registered target. The application's `createHtml5FileDrag`
publishes the payload; production admission and dispatch deliver the selection.
The assertions require a visible `pane` result with both paths in selection
order, preserved source entries, and no transfer toast. One row uses the
browser's ordinary projection; the other removes every format except the exact
production `text/html` after source publishing. That row tests stripped-type
admission on Chromium and WebKit and fails if production HTML publishing or
admission is removed. The former standalone HTML echo probe provided neither
of those guarantees; its historical two-pass result above is not production
acceptance evidence. Playwright is deferred to the user for this revision.
