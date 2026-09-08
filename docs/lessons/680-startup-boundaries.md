# #680 — Startup boundaries and repository cleanup

- Budget the entire static Vite entry closure, deduplicating output files. A
  largest-chunk budget missed most of the cold-start payload, including code
  split into other eagerly imported chunks. Track raw bytes for parse input
  as well as gzip bytes; neither is a launch-time measurement.
- Runtime detection must not import the browser fixture backend. All detection
  callers, including lazy preview code, now use `api/common.ts`; only its
  browser branch dynamically imports `mock-invoke.ts`.
- Lazy-loading GitGraphView removed its render/action dependencies from normal
  file-browser startup. Keep the resolved constructor in an importable state
  cache with the importer injected from the component. Repeating `import()` on
  cached remounts inserted a loading placeholder even when the module and graph
  snapshot were cached. A MutationObserver regression test reproduced this.
- Shared commit-file caching belongs in state. The previous test copied the
  entire cache implementation and pinned source strings. It now imports the
  production factory and tests hits, eviction, repo isolation, and full OIDs.
- Empty directories are valid startup outcomes. Measure listing readiness
  independently from settings, commands, and the subsequent frame opportunity.
  Do not call this compositor paint or Dock-click latency. Main-window IPC
  receipt provides a separate Rust app-run-to-ready measurement on one clock.
- Window-manager disposal must inspect every cleanup group it awaits. A
  replacement-session cleanup failure overlapping disposal was awaited but
  ignored; the regression test failed before the fix.
- Architecture lint is useful only when CI runs it. Remove obsolete exceptions
  once a layering violation has been fixed, and keep orchestration out of domain.
- Every pane removal path must share the same resource owner. Workspace restore
  reused pane IDs but retained old SCM stores, commit drafts and graph requests.
  Reproduced through production stores before consolidating lifetime ownership.
- Pane ID is presentation identity, not an asynchronous consumer identity.
  SCM needs a unique store-instance token, permanent destruction distinct from
  temporary panel release, and a ledger containing both activations and prior
  unwatch work. A stale successful watch must release its acquired reference.
- Keyed component teardown must retain the mount's resource, not reevaluate a
  prop lookup whose registry entry has just disappeared. The browser reproduced
  an `onNavigate` cleanup exception that state-only tests could not observe.
- Native tests need isolated configuration when run locally. This workstation
  intentionally hides the status bar; native navigation helpers use its path
  for assertions. Temporary XDG config/data/cache roots exercise defaults
  without altering the user's preferences.

- Refcounted watch commands need per-owner ordering across IPC. Record an owner
  before awaiting acquisition, so destruction can drain and release it even if
  the native command completes late. Share that implementation across panes,
  thumbnails, Miller columns and drives.
- Invalidation must revoke pending cache writers too. Use invocation identity,
  not an unbounded permanent epoch map; an old finally block cannot remove a
  replacement request. Structured cache tuples prevent paths containing `|`
  from defeating repository eviction.
- A contribution disposer owns a registration invocation, not an ID or reused
  value. Preserve explicit core replacement APIs and reject plugin collisions.
- Do not keep teardown-critical membership solely in a reactive collection.
  In browser reproduction, direct registry close removed modal owner 2, then
  Svelte effect teardown of owner 3 read an earlier batch snapshot and restored
  owner 2. A plain Set is authoritative; a rune publishes only its current size.
  Detach before invoking a close callback so recursive cleanup cannot close the
  same owner twice.
- Terminal reservations are window-owned, claimed once, and cancelled before
  publication. Never hold the global terminal map lock while writing PTY input.
  Reap the owned shell separately from reader EOF: job-control descendants can
  hold the slave descriptor open. Full descendant termination is a separate
  platform policy and must not be claimed from a shell-only kill.
- Config atomic replacement follows the captured final symlink target. Open
  temporary files exclusively beside that target; predictable fs::write staging
  names can follow a planted symlink and truncate an unrelated file.
- Validate settings before exposing them to consumers, but retain unknown
  forward-version fields in a separate bounded persistence envelope. Bound
  aggregate workspace allocation before migrating legacy shapes.

- Cache freshness is end-to-end: invalidating a graph snapshot is insufficient
  if its replacement joins a summary scan started before the Git change. Revoke
  joinable scans on the shared change bus; preserve old consumers' promises but
  prohibit their publication. Never retain a failed summary as a clean tree.
- A queued reload must revoke `isCurrent` immediately, not when its execution
  begins. Component unmount also disposes the reloader; otherwise an old mount
  can fill the cache after its summary consumer has been cancelled.
- A live path token is not a probe token. Two owners can query the same path
  concurrently; latest-probe identity protects against reversed completions.
  Pending child paths cannot be assigned an ancestor repo root by inference:
  the child can be a distinct nested repository.
- Comparison keys are not filesystem paths. Preserve the original IPC argument
  and case-sensitive WSL suffixes; folding an entire UNC WSL path can target the
  wrong Linux directory.

- A null-prototype dictionary is safe for temporary construction, but Svelte
  does not deeply proxy it. Spread it into a plain object before publishing live
  pane state; spread retains `__proto__` as an own data property. Getter-only
  store tests missed the regression: a restored pane persisted graph changes
  while its screen stayed unchanged. Cover restored-state mutations with actual
  rendered outcomes, including both opening and closing the graph.

- A graph's pagination belongs to its displayed query and exact resolved branch
  walk. Changing filters before the reload debounce must not append a new
  query's page into old rows. Pending summary completion updates working-tree
  metadata without replacing an already appended tail.
- Busy flags belong to request invocations. An old pagination or same-PR check
  `finally` must not clear a replacement's indicator. Closing and reopening the
  same path/PR is a new lifetime even when its identifier is unchanged.
- Own immutable data at shared cache ingress, then reuse it with raw rune state.
  A readonly TypeScript getter alone does not stop mutation through a retained
  backend fixture or another consumer. Freeze nested parents, refs and walk
  arrays as well as the top-level graph snapshot.
- Superseded branch metadata must drain its replacement before resolving a
  hidden-remote query. Unknown coverage cannot silently become an unfiltered
  walk; a real later failure may reuse known coverage, but an obsolete success
  cannot skip a newer in-flight coverage read.
- Observe concurrently started promises together. Awaiting history before an
  already-running summary left the summary rejection unhandled when both
  failed. `Promise.all` observes both; separately revoke a partial-history
  callback when the combined request has already ended. Mock spies can observe
  their own returned promises and hide this defect, so rejection tests retain
  the production async wrapper boundary.

- Index-side identity matters for partially staged files. Path-only inline diff
  rendering showed the staged patch in both file groups; the native regression
  failed with two expansions where one was expected. Capture staged/unstaged
  identity, comparison generation and request identity, and revoke patches when
  a mutation changes the index/worktree meaning of that same path.
- A successful mutation does not own whichever detail panel exists afterward.
  Capture selection before awaiting mutation; refresh and close only that
  selection. A failed summary retains prior data instead of declaring it clean.
- Numeric preferences need consumer contracts, not only finite range checks.
  Fractional List columns were floored by virtual layout but emitted invalid
  CSS `repeat(2.5, ...)`; the four-column command independently clamped to three.
  Positive preview sizes below resize minima bypassed the zero-default sentinel.
  Use one typed rule set for persisted input, direct updates and setters, keeping
  continuous zoom/opacity/font values fractional while requiring integer counts.

- Native event delivery is not automatically window-local. Tauri `listen`
  defaults to `Any`, including events sent by `emitTo` to another label. A real
  three-window test showed every Explorer adopting the same transfer; the source
  removed its original tab but stayed open with its newly adopted replacement.
  Scope adoption and ACK listeners explicitly. Assert both destination adoption
  and unchanged unrelated windows; a single mocked callback cannot expose this.
- A persisted tab ID does not identify a live transfer owner. Reserve one lease
  per incarnation across the entire destination await; compare the captured
  snapshot before removal. Compare-and-clear drag IDs prevents stale UI cleanup,
  but does not by itself prevent a second destination adopting the same tab.
- Native creation constructor return is not creation success. Own both terminal
  creation events, delayed listener acquisition and seed cleanup. A caller timeout
  cannot cancel the native invocation: retain its terminal observer and retire
  an arbitrarily late child. Do not substitute a second grace-period timeout.
- Last-tab retirement must reject new ownership after native close dispatch,
  and restore commands must check availability before popping history. A guard
  immediately before an async native call alone cannot protect later allocations.
- A single-pane `ExplorerPane` intentionally lacks the `.active` CSS class.
  Native tests requiring that selector missed a correctly loaded child listing;
  use it only when the pane layout actually has multiple panes.
- Restoring a large active layout needs a separate activation schedule from its
  complete saved descriptors. Prioritize the focused pane, leave deferred subtrees
  unmounted, and cancel batches on ownership changes. A rejected native close must
  resume the surviving queue; closing its focused pane must activate the fallback.
- Initial directory loading invokes navigation completion too. Focus restoration
  must verify the actual active explorer before and after the render wait, or
  newly materialized background panes can take over the user's pane selection.
- A structural outro may retain inert DOM after its business resource is gone.
  Close the tab synchronously and let Svelte own animation cleanup; native tests
  must wait for the observable DOM removal instead of assuming it precedes the ACK.
- Terminal probe readiness must not match the shell's echoed command. Construct
  the marker inside the probe so it appears only after raw mode is established;
  otherwise a shortcut test can send its key to the shell before the application
  starts and incorrectly blame Explorer's key ownership.
- Native titlebar state observation must own late listener acquisition and query
  completion. Subscribe before the initial read, serialize/coalesce resize reads,
  and observe asynchronous unlisten failure even when the SDK types it as void.
- Persisted tab IDs do not define DOM/gesture lifetime. Key pane trees by their
  live tab incarnation and capture it in divider commits. Pointer capture belongs
  to the active divider; release, cancel, blur and unmount retire its queued frame.
- Xvfb provides an X server, not a window manager. Native maximize acceptance needs
  both. A real grouped Hyprland/Xwayland client ignored maximize and kept native
  state false; tile reflow changed geometry without maximizing it. An isolated
  Xvfb/Openbox fixture passed the unchanged state-and-geometry oracle immediately.

- Warm event dispatch is not activation success. Scope the receiver to its native
  label, require the actual navigation outcome before reveal, and acknowledge
  only after the claimed destination commits activation. Distinguish fresh and
  warm launch results; null must mean failure rather than successful reuse.
- Native spawn reservations and temporary claims need identity and bounded
  retirement. Anonymous counters let an expired spawn cancel its successor;
  shutdown must revoke pending registration, and claimed labels must not become
  claimable again. Cleanup must include native boot windows whose JS never ran.
- Do not hold the PTY control mutex during a blocking readiness poll. The reader's
  Arc already owns the stable master descriptor. Independent instrumentation
  reproduced a 43-second status-lock wait while the foreground command started
  and finished unobserved; releasing the guard before poll restored prompt status.
- A tab's presence does not imply its entry animation has finished. Browser drag
  fixtures must await actual animation completion before measuring centers. A
  count-only fixture targeted a zero-width third tab's old coordinates, then
  released over the second tab and incorrectly blamed correct hit testing.

- A shared lazy-dialog effect can attach duplicate callbacks when unrelated open
  flags change. Give each dialog its own demand effect and one host-owned import;
  closing cancels feedback while a successful constructor remains reusable.
  Capture failure relevance before rollback changes the flag. Portal windows need
  the same root toast surface for their existing import-failure recovery.
- Negative browser assertions can pass by waiting out the bug: an unwanted toast
  disappears after three seconds. Observe the operation settling, allow its render
  turn, then snapshot the count instead of retrying until feedback expires.
- Large fake-clock timer bursts can dominate a retention test under CI contention.
  Churn across repeated bursts above the production retention cap, preserving total
  keys and per-burst eviction/callback assertions, rather than extending timeouts.

- Terminal exceptions must retain the exact command ID from ownership through
  dispatch; a second broad lookup can select an unrelated conflicting binding.
  Retire chord prefixes when ownership moves to an editable/modal surface, pointer
  interaction, another window or a disposed listener owner.
- Lazy terminal mounting, shell completion and animation frames are asynchronous
  work, not permission to take focus. Own a one-shot opening request and cancel
  it on newer input. Consume after xterm creates its input as well as on later
  opening revisions: an initial Svelte effect can run before onMount assigns a
  nonreactive resource. Queued path insertion must not carry its own late focus.
- Git graph mutation notifications invalidate the shared snapshot cache, even
  when emitted locally. Notify before reloading/publishing post-mutation history;
  notifying afterward evicts the fresh snapshot and breaks immediate tab remount.
- A cache regression must prove its cache precondition. Visible graph rows did
  not prove snapshot publication: Linux Access notifications invalidated the
  read itself. Requiring the actual snapshot exposed both that loop and missing
  observation while hidden. Disable unrelated SCM coverage in this native case.
- [notify Access events](https://docs.rs/notify/latest/notify/enum.EventKind.html)
  describe non-mutating access. Ignore them for Git refresh; honor
  [rescan flags](https://docs.rs/notify/latest/notify/struct.Event.html#method.need_rescan)
  even without paths. A linked worktree needs its common Git directory for
  shared refs as well as private HEAD/index. Every registration must succeed
  before acknowledging cache coverage.
- Snapshot retention owns observation independently of mounted components.
  Subscribe and acquire before reading, transfer the same lease on publication,
  and revoke pending writers on delivered changes. Native coalescing still
  permits a delivery interval; a browser mock cannot establish native timing.
- Release a native watch by the identity returned at acquisition. Rediscovering
  a deleted/moved repository during release can produce a different key and
  leak the old recursive watch. Keep display/navigation paths separate from
  resource identity, including SCM's late-acquisition compensation.
- A shared repository key cannot make release retries idempotent: an earlier
  caller's duplicate release can decrement a later caller. Return unique native
  lease IDs, and keep the repository root separately for display and events.
- Native watcher errors need recovery while existing consumers remain mounted.
  Own observers, retries and debounce deadlines in one service; callbacks only
  mark their generation dirty/broken and wake a bounded inbox. Retire old
  generation flags, retry failed invalidation delivery, and release the observer
  and timers with the final lease. SCM must reuse the ordered owner rather than
  discard failed `ApiResult` cleanup responses.
- Root replacement requires watching its parent as well as the tree itself.
  Keep parent watches non-recursive and filter unrelated siblings. A real native
  regression must replace the root with a new inode, observe subsequent changes
  without remounting, and verify the listing when returning from the graph.
- Temporary Git lock filtering must be scoped to metadata. Worktree `Cargo.lock`
  and backup-named files remain user data and must invalidate summaries.

### Native multiwindow acceptance: preserve the WebView2 environment

The Windows attach build configured CDP browser arguments only on the main Rust
window. JS-created fresh/warm windows shared its data directory but omitted those
arguments. CI logged immediate WebView2 `0x8007139F` failures during concurrent
creation. Microsoft's [environment creation reference](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl?view=webview2-1.0.3595.46)
identifies mismatched options within a shared browser process as a cause of
`ERROR_INVALID_STATE`. Disabling automatic warm priming did not establish a
single-window invariant: new-window misses and successful warm claims still
prime or replenish the pool.

The feature-gated Rust plugin now injects the exact main-window argument string
into every spawning page, JSON encoded. The shared child-window options preserve
it for both fresh and warm creation, and the Rust measure window uses the same
helper. The installed public TS constructor type omits `additionalBrowserArgs`,
but the Rust `create_webview_window` command consumes `WindowConfig`, whose
camelCase deserializer accepts that field. Portal pickers are Linux-only. Normal
builds exclude the injection and frontend option; no generic runtime browser-args
setting or new IPC was added. Windows native verification remains required.

The earlier Linux `[null, null]` result remains unreproduced locally: the isolated
pair and all five transfer cases pass, with automatic warm priming both disabled
and enabled. Current native acceptance also passes all three warm lifetime cases,
including abandoned-claim expiry. Do not call the Linux failure fixed from this.
Launch diagnostics now retain destination labels, failure phases and native error
payloads (including errors delivered after timeout) in the application log, so a
future failure can distinguish geometry, construction, listener registration,
native rejection, timeout and failed retirement. Warm creation logs its label and
error too; cleanup ownership is unchanged.

### Automatic warm priming must follow foreground readiness

A 1.5-second timer started at page mount can create an optional WebView while
settings and the foreground listing are still initializing. A three-second config
fixture reproduced the wrong order on the actual old page in Chromium and WebKit.
The session now starts that timer only after the existing settings/commands/listing
and paint-opportunity readiness signal. Its command microtask and timer retire
with page teardown, and partial setup rolls back acquired subscriptions.

Record startup/prime ordering in the application world. Driver observations can
arrive late, and a five-second completion timeout is too short for a deliberately
slow three-second config read plus priming delay and browser startup. The test's
15-second wait only bounds completion; recorded ordering is the assertion.
An inspected screenshot demonstrates usable navigation/selection, not timing.

Moving E2E hooks out of the page also exposed a lazy-import boundary: removing
listeners does not prevent a callback already waiting on an import from dispatching
later. Re-check session ownership after import and before accepting work. Once a
transfer has been accepted, its existing domain owner must finish or cancel it;
simply suppressing its post-await completion can strand adoption halfway.


### Native leases need an owner beyond frontend cleanup

A unique lease ID makes release idempotent but does not reclaim it when a renderer
vanishes. Git leases now carry a native-window cancellation token. Keep that token
in the concrete Window resource table, not a label registry: native labels can be
reused, and retained old Window handles must stay retired. Tauri's table is keyed
by resource IDs, so find/create the single typed resource under its table lock.
The Destroyed handler must find/create **and retire** under that same lock; dropping
the lock between lookup and retirement admits a racing command.

Retirement must not depend on successfully enqueuing a cleanup message. Flip the
token, set a coalesced reclamation flag, and attempt a nonblocking wake. A full
inbox guarantees another worker turn. Check the token again after synchronous
registration, because its IPC receiver can outlive its destroyed source window.
A native E2E with an intentionally unowned frontend lease verifies destruction
reaches reclamation while another window stays usable; blocked-install and
queue-saturation Rust tests prove the relevant interleavings. Do not equate an
Observer drop with completion of notify's asynchronous OS resource teardown.


### Saved split ratios are preferences, not viewport geometry

Immediate-child CSS minima can hide entire descendants in dense restored trees.
Compute subtree minima before placing the tree, and share the resulting rectangles
with directional focus and split placement. Keep viewport measurements outside
persistence: shrinking a window must not overwrite the user's preferred ratios.
A local scrollable canvas keeps the active pane reachable without scrolling the
application chrome. One container-owned divider gesture removes per-node global
listeners and retires pending frames when the workspace geometry changes.

Resizing a separator with arrow keys must also respect the window's file-list
listeners. An accepted local key cancels a pending global chord; file selection
ignores separator targets, while unhandled global commands remain available.
For zoomed pointer tests, wait for the canvas measurement to change after zoom
and settle before sampling rectangles. WebKit scrollbar accounting can make the
settled canvas smaller than clientWidth/clientHeight, so equality is not portable. The ratio can remain 50% across two different
measurement generations, so waiting for that ratio does not establish readiness.


### Optional width and manual resize must share the workspace policy

A leaf minimum alone does not protect its file list. In the reproduced narrow
pane, 200px Miller plus 280px SCM consumed all 275px of available pane content,
leaving a zero-width file list. Fixed inline panels must contribute their actual
width to the window-owned presentation model. Use mount-scoped tokens, so stale
cleanup cannot erase replacement contributions. Hoisted panels are already
subtracted from the viewport and must not contribute again.

Manual resize also needs coordination with automatic reveal. A 15px pointer move
expanded the inline panel and canvas, then reveal reset scrollLeft from 332 to 0;
the owner's scroll listener correctly cancelled the gesture. The same bug occurs
when resizing the global Sidebar. A shared gesture activity lease pauses automatic
reveal until release/cancel; removing scroll cancellation would conceal the race
and allow stale captured geometry. Keep contribution and activity separate: global
panels affect viewport size without contributing to a leaf minimum.

Test actual visual drag distance at multiple CSS zoom levels, continuous moves
with a frame accepted between them, pointer-capture failure, and file visibility
before clicking (Playwright clicks can scroll hidden content into view). In a
fixture that manually scrolls after resizing the viewport, first wait for the new
canvas measurement: otherwise late automatic reveal can undo the fixture's scroll
before the drag even starts.


### Automatic size is derived presentation until the user adjusts it

The Git gutter's old private mouse listeners used visual deltas as CSS widths,
persisted late movement after unmount, and offered no keyboard path. Its shared
resize owner now distinguishes an absent manual preference from a numeric width.
Do not initialize automatic width by copying a reactive source into a fixed field:
it must keep following topology while idle. Capture its displayed width for a
gesture, and establish a manual preference only after an effective adjustment.
A move away and back still establishes that preference; a click or untouched
cancellation does not. Capture the completed preference before publishing retirement, so a reentrant
callback cannot substitute the replacement gesture's value.

A handle's DOM parent is not always its controlled surface: the graph gutter
handle lives in the header, while the sized clip is in the body. Pass that sized
element explicitly when measuring zoom scale. Also install capture cleanup before
calling setPointerCapture and roll back on failure, including pane dividers.


### A reactive effect cannot guard an external value at pointer release

Terminal's counter-zoom cancels the element's visual CSS zoom, but its model
height is still multiplied by app zoom. A 60px drag previously grew it by 48px at
80% and 90px at 150%. Supply the model-to-visual scale explicitly instead of
inferring it from the counter-zoomed element. Keep the draft out of settings and
commit only on retirement; otherwise every pointer sample replaces and saves the
whole settings object.

An external size can arrive after a published draft and immediately before
pointer release, blur, restart or a key. Waiting for a Svelte effect to cancel the
gesture lets those synchronous paths commit the old draft over the new value.
Check source/options before queued publication and at the commit boundary after
releasing DOM/activity ownership. Keyboard must first retire superseded ownership,
then decide whether the current axis handles the key and derive its step from
the current value. An old-axis key must retire the obsolete gesture even if the
new axis rejects that key. Keep automatic graph topology's captured-origin policy
explicit so external settings protection does not break automatic/manual sizing.

Native xterm scrollback must be verified through visible history navigation.
xterm 6 owns its scroll model internally, so `.xterm-viewport.scrollTop` and
`scrollHeight` do not establish whether shell history exists. Populate real PTY
output, use Shift+PageUp, and assert that earlier output replaces the latest rows.


### A keyed resize owner needs both model and DOM identity

Retire the active scalar gesture before switching the column key used by its
read/commit callbacks. Otherwise a final draft can commit to the replacement
column, even when its queued frame itself was cancelled. Keep pending movement
separate from published work and project only the active draft into the grid.

Pointer IDs alone do not identify the captured element. Once a shared owner
serves multiple handles, browser-generated loss from the old target can arrive
after the replacement captures that same pointer. Clear pointer and handle before
release; check both against each incoming move/up/cancel/lost-capture event. The
regression needs an initial real move to establish the old capture: transferring
before that first move has no old capture to lose and misses the defect.


### Framework teardown can read historical settings

A published Preview drag followed by a cross-axis dock change restored the old
dock. Hiding Preview or disabling Terminal similarly restored visibility. Browser
regressions reproduced this in Chromium and WebKit. Instrumentation showed the new
settings were applied and persisted before teardown's size commit read the old
snapshot. Svelte's destruction context deliberately exposes historical signal
values; the settings setter's whole-object read/modify/write then restored them.

Release capture, listeners, frames and activity synchronously, but return a
conditional, exactly-once persistence finalizer. Run it after Svelte's public
`tick()` boundary and reread live settings/options. Changed source/dock means
obsolete work; unchanged size source on hide preserves the last published draft.
Do not retain a component-derived dock selector in this callback. Keep separate
handle retirement and permanent owner disposal, and invalidate pending completion
on replacement input. Tests must assert the requested dock/hidden state survives,
not merely that cleanup ran. The Terminal regression also fails with the old
teardown hook restored and passes with the shared finalizer.


### Command availability must not depend on the palette's input focus

Preview's command metadata rejected INPUT/TEXTAREA/contenteditable focus to protect
its Space shortcut. The same predicate was used by palette discovery/execution,
so searching for the command hid it precisely when the user wanted to invoke it.
Remove the metadata focus guard: the shared window-key policy already rejects
ordinary shortcuts while editing or inside a modal. Keep `when` for feature/model
availability. The regression opens and closes readable Preview content through the
focused palette, then verifies Space edits a path and toggles Preview after focus
returns to files. It fails in both browser engines before the guard removal.


### A native window can outlive the renderer which owns its watches

A real-binary test acquired a Git lease without frontend cleanup, then reloaded the
same native window. The new page remained usable but the old observer never retired;
native window destruction still reclaimed it. Window identity alone was too broad.

Keep a renderer generation inside the concrete window slot. Advance and retire at
committed page-load Started; require an acknowledged generation on watch/unwatch IPC.
Rotating only the owner is insufficient: a delayed old-page command would otherwise
look up the new owner and acquire against its lifetime. Work captured before the
boundary must retain the old cancellation token. Old releases are idempotent and
cannot affect a replacement. Native close is terminal even after a late load event.

The frontend caches its acknowledged session per JS realm; only a failed handshake
can retry. A rejected watch cannot renew the generation and adopt another page's
lifetime. Page hooks inspect existing slots so sessions without Git stay lazy.
Test repeated same-window reload, not only closing the window or application. A
blank process crash without reload requires a separate native termination signal.


### Native listener acknowledgement must survive cancellation

Linux WebKit renderer death leaves the native Window alive, so neither JavaScript
cleanup nor window destruction is sufficient. Register a native termination handler
before acknowledging Git ownership. On WebView2, only main-renderer/browser exits
invalidate the owning document; subframes, GPU failures and unresponsiveness do not.

An async OnceCell initializer can be cancelled after it schedules native registration,
losing the successful-install state and duplicating handlers on retry. Record success
inside the serialized UI callback itself, check again there before installation, and
only then acknowledge through the oneshot channel. Native handlers should capture a
weak owner; acquisition must enforce registration even if a raw IPC caller bypasses
the JS handshake. Read the current generation after registration, because loading or
closing may have happened while the request waited on the UI thread.

WebKitWebDriver destroys its automation session when a renderer crashes. A passing
blank-page cleanup assertion followed by an invalid-session error on reload is not
crash-recovery evidence. Assert cleanup through native diagnostics without any DOM
calls, retain the recovery gap, and test ordinary reload separately. Use fresh unique
repository roots when proving renewed observation, so delayed old-root events cannot
satisfy the new mutation's receipt assertion.


### Publish plugin retirement before external hooks

Two production-registry tests reproduced reentrant shutdown recursion and a plugin
that became enabled in settings but inactive after its deactivate hook re-enabled
it. Publish the shared shutdown promise before invoking hooks. On ordinary disable,
remove the active entry and dispose its context before calling deactivate; otherwise
re-enable either sees the stale active marker or collides with the old provider
scheme. Registration identity then prevents old disposal from erasing replacements.
Keep the fs-provider collision in the regression, not only command existence.


The same rule applies before activation starts: a resolved placeholder promise
lets synchronous shutdown inside activate finish before held activation work.
Publish the real completion first while preserving immediate activation side
effects. Mark failed activation cancelled before cleanup hooks, so their retry
requests wait for its full cleanup instead of joining the failed operation.

Load helpers must identify a newly active tab by stable ID, not DOM count: keyed
outros retain closed tab elements temporarily. Freeze source **and generated**
SvelteKit output during browser retention measurements. A concurrent `bun run check`
runs `svelte-kit sync`, which can invalidate the page and make a test's navigation
failure look like a product lifecycle defect.


### Break resize feedback at the layout dependency

The wider WebKit graph suite emitted ResizeObserver loop errors when commit
metadata expanded. Instrumenting each observer's creation, targets and deliveries
identified Svelte's inline-detail size binding: publishing the detail height grows
the absolute graph canvas, introduces its vertical scrollbar and narrows the same
measured detail from 928 to 920 pixels during one delivery. This is an actual
layout dependency, not evidence that every ResizeObserver needs a timer.

Reserve the graph's scrollbar width with `overflow-y: scroll`. A three-candidate
browser probe found that `scrollbar-gutter: stable` alone did not reserve this
custom scrollbar in the tested WebKit; both it and the original `auto` overflow
still changed width and emitted the warning. `scroll` made the width stable before
expansion. Keep the existing height binding and immediate SVG/row updates.

Do not mirror overflow onto the graph header: its nested branch-filter popover
extends below the header and would be clipped. The header's existing scrollbar
column offset is a separate alignment concern. Verify actual panel/row geometry
and capture page errors in both engines; an isolated passing click test does not
establish that the wider intermittent PR/filter failures have been explained.

References: [CSS overflow scrolling](https://www.w3.org/TR/css-overflow/#valdef-overflow-scroll)
and [ResizeObserver processing](https://www.w3.org/TR/resize-observer/#html-event-loop).


### Share graph column geometry and retain control ownership

A graph header outside its scroller must account for the native scrollbar's
width. Binding the header to that viewport alone introduced another WebKit loop:
its last measured width became the parent flex item's intrinsic minimum, and a
pane shrink converged one scrollbar-width per observer delivery. `min-width: 0`
on the graph removes that intrinsic constraint. Keep the header overflow visible
for the existing filter popup and project horizontal scrolling with a margin;
a transform would change the fixed backdrop's containing block.

Refs, stash labels and subjects must occupy one message cell. Independent flex
siblings displace metadata after the subject shrinks to zero. Share the derived
table minimum between header and body, including every visible metadata column,
and retain a usable message region through native horizontal table overflow.
Share OID geometry too: the former Parent header was 120px, while a later `.oid`
rule silently overrode its row cells to 60px. Compare all visible rows and both
edges of all metadata cells, including Parent, at several zoom levels.

Clipping that message cell makes a later PR unreachable even if the whole table
scrolls. An all-reference disclosure reuses the existing menu owner, coordinates,
backdrop and scoped actions. It lists stashes, attached remote labels, remote-only
refs, tags, branches and PRs without per-row measurement or scrollbars. Retain the
original trigger through reference-to-action transitions; Escape restores it,
while scrolling or virtual-row retirement closes the anchored menu.

Do not classify native buttons as generic text inputs to fix Enter interception:
that would suppress modified shortcuts too. Native unmodified Enter/Space must
reach the browser's activation default and retire a pending Explorer chord.
For custom controls, accept only their directly handled keys with preventDefault;
the window owner then honors that acceptance just as it does splitter input.
Without both boundaries, graph buttons lose their native click and commit-row
Enter can also activate the explorer's retained file selection. Production-owner
regressions reproduced both conflicts before the fixes.

Freeze generated SvelteKit output as well as source during browser acceptance.
Vitest startup also regenerates that output: an independent unit rerun reloaded
an active WebKit page and detached its graph. That run is not product evidence.

References: [Flexbox automatic minimum size](https://www.w3.org/TR/css-flexbox-1/#min-size-auto)
and [WAI button keyboard interaction](https://www.w3.org/WAI/ARIA/apg/patterns/button/).


### Native creation ownership

A Tauri `WebviewWindow` returned by its JavaScript constructor is a label proxy,
not proof that a native window was created. A duplicate-label error leaves the
existing native window intact; calling `close()` or `destroy()` on the failed
proxy addresses that existing window. The native regression reproduced its
unintended closure before the launcher fix.

Establish ownership only on `tauri://created`. Failure clears this invocation's
launch seed immediately, but retirement waits for ownership. Creation timeout,
failed handoff and listener-acquisition failure retain surviving terminal
observers: late success destroys the owned rejected child once, while native
error ends the drain without addressing that label. Use `destroy()` for rollback
of an owned child, because `close()` is an interceptable request. Never claim
reclamation if the creation observer itself cannot be installed; no safe label
operation can recover native identity in that case.

The installed Tauri creation listeners register synchronously in a local array.
Their returned promise does not represent IPC readiness. The broader injectable
contract still needs to handle a throw or rejection without discarding a
success observer that was installed independently.

For an unready native fixture, Tauri runtime Wry deliberately omits `with_url`
when the requested URL is `about:blank`. WebKit therefore exposes a native
window with an empty initial URL and no initialized document. Script evaluation
can fail with “Could not parse script result.” Inspect the native URL through
WebDriver, allow that empty state, and load the actual app through WebDriver
navigation. Require the same handle to publish the requested Tauri label and
original tab/pane/path afterward; a newly replenished warm window must not be
mistaken for the unready target.


## Native button semantics and file-entry commands

Main file entries are native buttons, but Enter and Space belong to the
configurable Open and Preview commands. A blanket native-button exemption in
window keyboard routing disabled both after a row was clicked. Classify the
actual `.file-list .entry-item` event target: Miller-column buttons share
`.entry-item` yet own their navigation, and nested rename buttons must retain
native activation. Respect default prevention from the file list too: Space
continues a nonempty filename type-ahead buffer and must not also open Preview.
Verify all three views and real native input, alongside the graph/button
regressions that motivated the exemption. Two production routing contracts and
the native preview case failed before this correction.

Native observation must outlive ordinary page cleanup safely. Directory watch
counts keyed only by path leaked exact Linux inotify registrations when a child
window was destroyed; JavaScript disposal never ran. Directory and Git leases
now share one renderer incarnation stored in the concrete Tauri Window resource
table, with one acknowledged native termination listener. Page replacement,
native destruction and renderer termination revoke the token before asynchronously
reclaiming resources. Window labels and raw path counts are not release authority.

Acquisition cancellation also includes a reply successfully queued but never
consumed. Git's old send-error cleanup missed that interleaving; request ownership
must remain revocable until the awaiting caller consumes the lease. Filesystem
replies similarly retain a drop guard until consumption. A failed final release
commits cleanup intent: revoke cache eligibility, retain identity for idempotent
retry, and schedule backend cleanup even if the frontend owner disappears.

Retirement tests must keep watched directories present until exact descriptor
absence is proven; deleting fixtures first allows the kernel to hide leaks.
Cache tests additionally need real overlapping/shared watches and a gated cold
walk across retirement. Tauri's [resource table](https://docs.rs/tauri/2.11.2/tauri/struct.ResourceTable.html)
provides the concrete native ownership boundary; notify's [watcher contract](https://docs.rs/notify/8.2.0/notify/trait.Watcher.html)
is implemented behind the testable directory lease policy.

Directory lease ownership does not establish continued observation health. Native
root watches follow an inode: rename the directory away, recreate the same path,
and the pane can stay on the displaced tree forever. Register the root's parent
non-recursively, share physical parent/root roles, and rebuild after root lifecycle
changes. Preserve a separate healthy sibling and the displaced tree in native
acceptance so navigation, fixture deletion and broad refreshes cannot mask failure.

Ignoring Modify(Data/Metadata) also leaves selected previews and entry metadata
stale. The native regression overwrites an existing Markdown file, requires a
watcher timestamp at or after that write, then checks new visible content. A file
creation test cannot prove this contract.

Treat every recursive watch failure as potentially partial, including
PathNotFound: a descendant can disappear after earlier watches were installed.
Discard the candidate and exclude its failed root for that attempt. Try untested
roots before rewalking successful trees, then restore failed roots incrementally.
Generation faults must revoke cache eligibility before asynchronous recovery.
Latch valid callbacks during registration as well as errors, so a mutation
observed before activation still triggers a catch-up refresh. An explicit cache
epoch invalidation precedes coverage; restoration follows successful activation.

Removing a directory cache entry does not invalidate an in-flight scan's right to
publish. Give each miss an opaque permit, replace that authority on a newer miss,
and remove it on invalidation or eviction. A gated real scan must demonstrate
both invalidation-before-publication and older-completion-after-newer-read;
testing only a cache hit after an explicit removal misses both races. Weak permit
identities allow canceled requests to be reclaimed without historical tombstones.
Count retained Vec/String allocations as well as paths, and prepare that weight
on the blocking pool before taking the cache lock. This bounds cached snapshots,
not response ownership, in-flight scans, allocator overhead or process RSS.

With jwalk 0.9, opening the root can fail inside a successful root entry's
`read_children.error()`; checking iterator `Err` alone still reports unreadable
folders as empty. Preserve the underlying error kind, and keep root metadata
inside the blocking scan boundary. Entry-level errors can produce a useful
partial result, but that result must not enter the ordinary listing cache.

Preserve the requested root when converting metadata errors: `std::io::Error`
knows the error kind but does not carry the path passed to `fs::metadata`.
Failed navigation retains the prior breadcrumb, so omitting the requested path
also removes the user's only context for the error. Assert both typed failure
and target context, then verify recovery after recreating the directory.

Initial directory navigation needs observation before its snapshot read. Installing
an OS watch after listing, or the window event listener after tab initialization,
leaves a write that can stay invisible until an unrelated later change. A combined
native observed-listing command keeps its lease under a drop guard during the scan;
the pane stages that lease before callbacks and retires the prior lease only when
its new path commits. Pending changes belong in the existing pane watcher policy,
with commit/rollback replay through the common refresh scheduler.

A scheduler's in-flight directory is not coverage for every pane showing that
path. Only subscribers that actually accepted that flush can suppress older
notifications. A pane deferring refresh for navigation explicitly returns `false`;
crediting it with a sibling's scan loses the deferred change. The real-pane
interleaving regression failed even after adding per-subscriber keys, until
participation itself became explicit.

### File-list cursor and selected entries have different identities

Making every file row a native Tab stop allowed focus and command targets to
separate: Tab focused Archive while Enter opened selected Downloads. A collection
needs one cursor Tab stop and internal arrow navigation. Keep the selected set
independent so returning with Tab does not destroy multi-selection. Range anchors
must identify paths, not display indices, or sorting/insertion changes the anchor.
Rename must migrate matching selected, cursor and anchor paths while preserving
newer user changes made during the asynchronous operation.

For virtualized focus, reveal the exact entry through the view-owned scroller,
synchronize its rendered window, then focus a verified index/path target after
render. Cancel stale coalesced scroll work before the programmatic jump. The
viewport supplies a Tab fallback when the cursor row is unmounted. A `.selected`
query cannot identify the moving endpoint of a multi-selection.

Browser focus helpers must target the body collection boundary. Details has
independent sort/resize controls inside FileList but before its body grid; Tab
from before the whole component correctly visits those controls first. Assert
actual focus before executing Open so a test does not mistake a sort-header
activation for failed file navigation.

WebKitGTK WebDriver can deliver trusted Shift+Tab keydown as `Unidentified`, with
`shiftKey=true` and `defaultPrevented=false`. Both the convenience chord helper
and explicit Shift-held action order reproduced it; plain Tab delivered `Tab`
and moved DOM focus. Capture actual keyboard/focus events before changing app
routing to compensate for an automation failure. Native forward Tab traversal
and browser backward traversal have distinct evidence scopes.


### Filesystem success and pane publication have separate lifetimes

Capture destination and navigation identity before the first await, including
clipboard reads. Successful work remains real after its pane navigates or closes;
undo and affected-parent notifications must survive, while entry/selection/editor
updates need their original owner. A dialog type or path is insufficient identity
when the same path can be reopened. Direct operations must not borrow whichever
global dialog happens to be active. Bulk undo parents come from the input paths,
not from the pane that happens to display them.

A fixed mutation cooldown cannot distinguish an own-write echo from an unrelated
external write. Dropping refreshes silently loses the latter even with a path-
specific timer. Existing coalescing and unchanged-listing suppression provide a
correct confirming refresh. The watcher may beat the mutation IPC reply, so
optimistic insertion must also be idempotent by path.

Disabling an inline rename input during submission can blur it permanently on an
asynchronous error. Keep it read-only and focusable; apply error/finally/focus
completion only to the opening that submitted it. Test actual keyboard retry.

Vite can emit an orphan dynamic-import chunk when its false guard is an imported
constant folded after chunk extraction. Use a literal environment expression at
the opt-in test import and inspect all normal production JavaScript, not just the
startup graph, before claiming the test fixture is absent from release assets.

### Partial filesystem outcomes must survive failed commands

Bulk trash and restore are best-effort operations. Return confirmed per-path
successes alongside failures, then use only the successful paths for row removal,
undo and parent invalidation. A mixed local/network selection must apply location
policy per item; one UNC path must not permanently delete its local siblings.

Undo/redo reserves one exact history entry before its first await. New actions
must not be removed by a late completion, and a partial inverse must retain only
unfinished work for retry. A new push discards the obsolete redo branch, but an
already-admitted redo still owns its unfinished work unless history was explicitly
cleared. Test rejected calls, partial receipts, intervening pushes and clears
through the public history API.

Linux trash restoration has a commit boundary before metadata cleanup. The trash
crate can successfully rename a payload and then return an error removing its
`.trashinfo`; treating that error as failed restoration repeats completed work.
An atomic no-replace rename establishes both collision safety and the durable
outcome. Cleanup failure is logged separately. Ignore metadata-only records when
selecting a later restore, using `symlink_metadata` so broken symlinks remain
valid payloads. Process-isolate temporary XDG settings; mutating the parent Rust
test process environment can silently send parallel tests to the wrong trash.

A component-owned `$derived` is not a safe asynchronous ownership predicate after
the component is destroyed. Stack attribution of `derived_inert` showed rename's
blur completion reading its retired submission derivation. A plain getter over
the existing session/submission identities remains reactive during rendering and
can safely answer the same guard during teardown. Assert successful Enter and
click-away rename outcomes as well as absence of that exact warning.

Returning an application receipt with an own `error` field directly from
`browser.execute` can make WebKitWebDriver treat it as a protocol error. Return
the encoded JSON string and parse it in the runner, so an expected per-file
failure remains assertion data. Keep token/status checks on the application-side
DOM receipt; transport retries must never redispatch accepted filesystem work.

## Native history and mutation receipts

A successful filesystem mutation must not become an error because its later
`FileEntry` lookup failed. Carry the committed path separately from nullable
presentation metadata; make the post-commit receipt constructor infallible.
Consumers must record paths and count successes even when no snapshot can be
inserted optimistically. Rename clipboard bookkeeping can rekey its last-known
snapshot without inventing new metadata.

Capture a renderer generation before awaiting native listener installation.
Reading it afterward lets an old realm adopt its replacement and overwrite the
replacement's history channel. Likewise, Undo waiting on a local history push
must use that push's exact receipt: a later shared channel update can already
name an unrelated newer entry before the awaiting continuation runs.

Browser history simulation cannot verify the native admission authority. The
Linux compatibility fixture here covers ordinary file commands, delayed create
navigation and partial Delete/Undo/Redo. Shared-window inverse ownership and
composite transaction recovery remain separate required acceptance cases.

## Exclusive publication is a prerequisite, not a complete transaction

An absent-path check does not grant ownership. The old recursive copy could
truncate an occupied file, merge an occupied directory, or follow an occupied
directory symlink; `rename` could replace a destination created after preflight.
Four actual-filesystem tests reproduced these failures. Create new payloads
exclusively in reserved destination-local staging, then publish with the native
no-replace primitive. Share that primitive with Linux trash restore.

Keep displaced user originals out of auto-deleting staging. A cross-device move
can publish its destination and then partially delete its source before failing;
that is not an unapplied operation. Also distinguish final-name collision
protection from identity ownership: another same-user process can replace the
staging namespace, and NFS can report a failed rename after committing it.
Those cases require explicit artifact identity and indeterminate/retained
outcomes before claiming complete recovery.

## A partially completed move is not a failed copy

After destination publication, recursive source removal can fail after deleting
some children. Returning an ordinary error lets overwrite rollback destroy the
new destination and can make history retry an already-applied inverse. Return
the committed destination plus explicit recovery details; retain the displaced
original, reconcile both parents, and offer neither a Move nor Copy inverse for
that effect. A Copy inverse is also unsafe: the destination may hold the last
surviving copy of the removed source children.

Do not solve this by parking the source before a long copy without durable
journaling and startup reconciliation. That introduces a crash window where
the only source is hidden and no destination exists. The interim receipt must
be honest about incomplete work, including the progress operation status and
cut clipboard, while the persistent recovery owner is implemented.

Read-only copied directories need a distinct publication boundary on Unix:
renaming a directory between parents can require owner write to update `..`.
Temporarily make only the unpublished copied root readable/writable, retain a
handle, publish without replacement, then restore exact permissions through the
handle. Do not make the source writable to get a cleanup-failure test to pass.
The real Linux cross-device acceptance caught this before source cleanup ran;
`file_publication` now reproduces the original failure independently.

- Forward history must reserve its order before starting native work. A completed
  older Redo cannot append above a newer admitted forward merely because its
  filesystem operation finished later. Active positions must also be excluded
  from retained-history eviction, or a no-effect attempt can discard valid Undo.
- Partial Redo needs a fresh public retry ID and causal lineage to its original
  reservation. Only forwards admitted during that reservation preserve its
  unfinished work; subsequent independent forwards invalidate the retry.
- A blocking-worker panic can already have changed files. Converting JoinError
  to an ordinary string error hides uncertainty from outer async supervision.
  Preserve typed worker failure through forward and inverse adapters, consume
  uncertain inverses without retry, and reconcile both confirmed and potential
  affected parents. Exact same-name rename is a separate successful no-effect
  outcome and must preserve Redo after normal filesystem validation.
- Crash-report filenames are publication identities, not just timestamps.
  Whole-second names let concurrent caught panics overwrite diagnostics. Stage
  complete private content before exposing a discoverable name; reserve its
  identity across both unseen and consumed states so later reports cannot
  replace earlier `.seen` evidence.

Native deletion batches need progress outside their blocking worker. A panic
must not erase earlier confirmed effects, and uncertain work must not be
retried as a known failure. Admit the full selection before execution; preserve
stable per-path outcomes and derive the inverse only from confirmed successes.
Tests now exercise real write/remove effects followed by worker loss.

Do not use a double slash as a platform-independent UNC test. Linux `//` paths
are local, while Windows extended local `\\?\C:\...` paths are also not network
shares. Use native path prefixes for destructive decisions. The Linux regression
proves the old rule permanently removed its fixture instead of creating a Trash
item, and verifies exact-byte restoration with the corrected rule.

Every delete entry point must present returned failures. The confirmation-free
`startDelete` path previously discarded `confirmDelete`'s error string, hiding
partial and uncertain outcomes. Its regression calls the public Explorer method
and observes both the retained rows and the uncertainty toast.

### Complete refreshes reconcile both entries and selection

A real child-window deletion cleared surviving-pane rows but left its status
bar reporting a selected file. Membership belongs to complete directory state,
so reconcile selection/cursor/anchor there instead of patching the status bar.
The read can race local receipts: merge against its starting snapshot so a
concurrent create/rename is not erased, then schedule a fresh observation through
`pane-watch`/`refresh-manager`. Metadata-null receipts can change selection alone;
snapshot identities too and provisionally preserve newly assigned missing paths.
Do not reconcile against filtered visibility or incomplete stream chunks. Compare
all FileEntry fields directly, preserve equal array identity, and avoid repeatedly
copying the streaming buffer or constructing directory-sized fingerprint strings.

### Windows Shell batches require their own apartment and completion proof

`trash::list` and `trash::delete` initialize thread-local STA state. Reusing a
Tokio blocking thread can encounter an existing MTA or leave an STA for unrelated
work. Construct the apartment, enumerate inventory and execute a whole batch on
one fresh worker; retain a bounded worker permit through resource destruction.
Native task ownership must cover the asynchronous permit wait too. Keep the
per-item ledger outside the worker so panic cannot erase confirmed siblings.

`PerformOperations` success alone does not prove a move. Inspect the abort query
and require an actual source-matching root `PostMoveItem` with `S_OK`; other
nonnegative Shell statuses can mean skipped or merged work. Descendant callbacks
cannot impersonate the root. Reject overwrite/merge transfer flags, disable
connected-item expansion, and report an alternate actual path without inferring
its cause. Use the same ordinal path comparison for inventory lookup and outcome
checking; raw case-sensitive keys fail after the Shell canonicalizes casing.
Only DOS-drive verbatim prefixes may collapse onto ordinary drive spellings.
Linux tests and a Windows-target compile cannot prove Windows Shell behavior;
keep real post-queue collision and relative-symlink tests in Windows acceptance.
