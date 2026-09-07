# ADR 0002: Window-tab teardown owns asynchronous pane work

Status: Accepted

Governs: `src/lib/state/pane-sessions.ts`, `src/lib/state/window-tabs.svelte.ts`,
`src/lib/state/window-launch.ts`, `src/lib/state/tab-transfer.ts`

## Context

Creating a pane starts a directory load without blocking rendering, while
destroying an explorer removes its directory-listing listener asynchronously.
If a test environment closes after `WindowTabsManager.dispose()` returns but
before either task finishes, late diagnostic output can reach a closed Vitest
worker RPC channel and fail an otherwise green run.

## Decision

The window-tab manager delegates pane resource ownership to one framework-free
`createPaneSessions` instance. Layout and presentation stay in the manager;
resources are keyed by the same pane IDs as layout leaves. There is no second
explorer identity or component-created fallback resource.

The session owner tracks asynchronous pane work that it starts or destroys:

- It retains each initial `initialLoad` or `navigateTo` promise started while
  registering an explorer.
- It retains cleanup promises for explorers removed by pane close, tab removal,
  or pane collapse until those promises settle.
- `dispose()` waits for all registered and removed-explorer cleanup promises
  and for the initial-load promises pending when disposal begins to settle.
- Repeated `dispose()` calls share the first in-flight teardown, including
  cleanup started by synchronous restore or initialization paths.
- Cleanup failures are propagated only after both groups have settled. The
  first rejected explorer cleanup is rethrown; initial-load failures remain
  settled because their own navigation path owns their user-facing handling.
- Synchronous restore and initialization paths cannot await replaced explorer
  cleanup. They catch and report that failure through the application console
  boundary, so it cannot become an unhandled rejection.
- Pane-removal cleanup that rejects before disposal has a chance to observe it
  is likewise reported through that boundary.
- Close, tab removal, collapse, restore and disposal all synchronously detach
  pane-specific SCM, commit-panel and graph-handoff registrations before IDs can
  be reused. SCM permanent destruction drains pending activations and event
  registration, removes its subscriber, and compensates any late acquired watch.
  Temporary panel release remains reusable. Shared scan cancellation uses a
  store-instance token so an old component cannot cancel its replacement.
- A keyed `ExplorerPane` captures its injected explorer at mount. Cleanup must
  not reread a registry/prop lookup after the parent has removed the pane.

## Cross-window ownership

A source tab reserves one transfer lease per live tab incarnation before any
native await. Persisted IDs are insufficient because restoration can reuse them.
The lease captures an isolated snapshot, completes only once after destination
adoption, and preserves source edits that the destination did not receive.
Cancellation and failed delivery release the reservation. Pointer cancellation
must not release an already-dispatched native operation's lease; that operation
owns release when it settles. Reordering, Escape and component unmount release
undispatched leases and their window-local drag markers.

Fresh launch seeds are keyed by destination label, taken once by that window,
and bounded against the receiver's JSON character limit before serialization.
The launch owner waits for native `created`/`error`; tear-off also requires the
existing correlated adoption acknowledgement. A timed-out creation remains
observed until its native task terminates, so arbitrarily late creation is
retired rather than escaping cleanup. This observation can remain pending if
Tauri's native invocation never terminates.

Adoption and acknowledgement listeners are explicitly scoped to their window
label. Tauri's default `Any` listener receives even events emitted to another
label; an `emitTo` call alone does not establish destination isolation.

After adoption, a last-tab source detaches its pane ownership synchronously.
A replacement tab opened before native-close dispatch keeps the window alive.
After dispatch, incoming creation/adoption/restoration is rejected because the
native close cannot be recalled. A rejected native close restores availability;
restoration guards run before consuming closed-tab history.

## Consequences

Large active layouts materialize through a cancellable pane activation queue.
The focused pane opens synchronously; subsequent batches open at most four panes
after a paint opportunity. Saved descriptors remain complete, and pane sessions
remain the only resource owner. Readiness controls recursive rendering so an
entire deferred subtree occupies one placeholder. Switching or retiring ownership
cancels scheduled callbacks by job identity. Refused native close resumes the
surviving layout; explicit focus and close fallback must be usable synchronously.
Background load completion cannot claim the active pane's DOM focus.

Tab close mutates ownership immediately. Svelte owns the short, reduced-motion-aware
visual outro; no deferred UI callback may later close a replacement with the same ID.

Pane DOM lifetime uses the live tab incarnation, not its persisted ID. Restoring
the same saved tab therefore retires its old component tree and pointer capture.
Divider commits retain that incarnation and verify the split still exists before
changing a ratio; unchanged branches retain identity. A divider owns its captured
pointer and one scheduled frame, retiring both on release, cancellation, blur or
unmount. High-frequency pointer movement is handled locally rather than broadcast
to a window-level handler on every split node.

Callers that need deterministic teardown must await `manager.dispose()`.
Vitest registers factory-created managers and drains them after each test, so
legacy tests cannot leave asynchronous explorer work alive when their worker
closes. Disposal may therefore complete later than before, but it cannot leave
sibling cleanup or load work running after a cleanup failure has already been
observed.

The regression tests must hold cleanup and load promises independently, proving
that one rejected cleanup does not make disposal settle before the other work,
including cleanup started by a pane-removal operation.
