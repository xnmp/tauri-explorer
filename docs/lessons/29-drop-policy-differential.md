# #29: differential drop policy and gesture identity

Baseline: `origin/dev` at `773eb55a`. The executable oracle is
`tests/helpers/drop-policy.ts`; it imports no production routing. The production
runner is `tests/composables/drop-policy-differential.test.ts`. The complete
reviewable expansion is [29-drop-policy-matrix.tsv](29-drop-policy-matrix.tsv):
2,592 source × target × modifier × transport × platform rows plus six expired
identity rows, with dev outcome,
branch outcome and named intended difference. The TSV is a review artifact;
tests calculate expectations from the independent pure policy, not this file.

Sources: listing file, listing folder, Miller file, Miller folder, sidebar
bookmark reorder, external OS file, plain text, plugin-specific DOM surface.
Targets: folder entry, breadcrumb, tab, bookmark, Quick Access, sidebar reorder
row, registered plugin target, dialog textarea, covered pane, listing background,
Miller background, unregistered plugin view. Modifiers: none, Ctrl, Option.
Platforms: Linux/WebKitGTK, macOS/WKWebView, Windows/WebView2.

`pane` is the SDK's actual source-kind string for Explorer file deliveries;
`external` means authoritative native filesystem paths without Explorer
provenance. A plugin-specific DOM payload is delivered to its DOM handler, not
the registered file handler. `text-insertion` in unit tests means uncancelled
browser default eligibility; the new report Playwright test asserts actual text.
`blocked` means the file adapter consumes the drop without transfer/delivery.

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
| External OS file, DOM only or native unavailable | Built-in transfer / plugin | No authoritative path; ignore | Same; never use `File.name`, text, or stale Explorer state |
| Explorer folder | Bookmark / Quick Access | Pin | Pin; native path multiset recovers Explorer identity and order |
| Explorer file / external file | Empty Quick Access | Ignore | Same |
| Explorer native file/folder | Folder / breadcrumb / tab / file bookmark / backgrounds | Move | Linux listing remains move-only; newly native Miller retains DOM rules, pointer drag-out honors C |
| External native file | Folder / breadcrumb / tab / bookmark / backgrounds | Move; C copies | Same |
| Explorer DOM file/folder | Folder / tab / Miller background | Move; C copies | Same |
| Explorer DOM file/folder | Breadcrumb / listing background | Move | Same |
| Explorer same-window pointer file/folder | Folder / breadcrumb / tab / file bookmark | Move; Option copies, including Windows dev bug | Move; C copies; Windows copy chord corrected to shared host policy |
| Explorer same-window pointer file/folder | Listing / Miller background | Move | Same |
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

The matrix intentionally preserves primary-kind pinning and existing target
no-op rules. It is not a new mixed-selection policy or an OS drag simulator.

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

## Acceptance still to run

Local verification after the final fix:

```text
bunx vitest run tests/state tests/plugins tests/composables tests/domain tests/api
Test Files  354 passed (354)
Tests       6063 passed (6063)

bun run check
website/api/report.js:2:26 Cannot find module '@vercel/blob' or its corresponding type declarations.
COMPLETED 1845 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS

CARGO_TARGET_DIR=/var/tmp/te-wt2/target-pdlg cargo test --offline --manifest-path src-tauri/Cargo.toml native_file_drag
test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 2166 filtered out

python3 docs/code-map/validate.py --coverage
coverage: 744/744 source files in map-folder.md
```

The check failure is the pre-existing dependency issue. No vendored crates were
changed, so the conditional Windows vendored-crate check was not required.
Independent adversarial review passed 2,708 focused tests and a separate
rejected-to-accepted successor probe; no remaining failure was reproduced.

Playwright is unavailable in this sandbox. Run Chromium and WebKit with all view
modes: `ALL_VIEW_MODES=1 npx playwright test` for these specs:

- `e2e/pane-dialogs.spec.ts` (new sidebar click/Enter and managed editor retirement outcomes)
- `e2e/plugin-file-drop.spec.ts` (new plugin-specific DOM text delivery)
- `e2e/user-report-draft-persistence.spec.ts` (new actual text insertion)
- `e2e/breadcrumb-drop.spec.ts`
- `e2e/miller-to-bookmarks.spec.ts`
- `e2e/miller-columns.spec.ts`
- `e2e/multi-item-dnd-undo.spec.ts`
- `e2e/image-editor.spec.ts`
- `e2e/pane-tabs.spec.ts`

Physical Linux rejected-start/automatic-Wry delivery remains a platform acceptance
probe, not a claim of native reproduction. Native file-drop/drag-out acceptance
on macOS and Windows also remains necessary. Use the private-display isolation
rules in AGENTS.md; never automate the user's active desktop.
