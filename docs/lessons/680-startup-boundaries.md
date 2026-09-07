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
