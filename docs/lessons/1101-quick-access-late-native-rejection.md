# #1101 — Quick Access pin lost when only dragend arrives before a late native rejection

On Linux, a listing/Miller folder drag hands off to a native drag start. While
that start is pending, DOM admission refuses completion (native may own it).
If WebKitGTK then delivers only `dragend` over Quick Access (no readable Drop),
and the start is rejected afterwards, nothing pinned the folder.

The earlier fix in PR #1098 synthesized a root-sidebar Drop through window
capture. It was reverted because it could not see cancellation: Escape with
stale hover, or a bookmark-row Drop that was already cancelled for a changed
destination, still pinned.

`listenSidebarDragEnd` now defers the pin itself (`deferUntilRejected`), and
only for a gesture known to have ended on that Quick Access:

- **Cancellation is captured at dragend.** Its `dataTransfer.dropEffect` must
  not be `"none"`. The HTML processing model reports `"none"` for a cancelled
  drag (Escape, release outside any accepting target). A page `keydown` Escape
  is not enough: GTK grabs the keyboard during a drag, so the page may never
  see it. An observed Escape on window capture refuses the deferral as well.
  Only directory sources defer, because Quick Access pins nothing else.
- **The end point is the evidence, not hover.** The dragend coordinates must
  be non-zero and hit-test inside Quick Access. Cached `isDragOver` only gates
  the immediate (already-decided) path, as before. A zero-coordinate dragend
  (the cancel shape) or an end point elsewhere defers nothing.
- **A deferred DOM Drop owns its gesture.** If window capture already deferred
  a readable Drop for this session (`dragState.hasDeferredDomDrop`), dragend
  stands aside. Otherwise a bookmark row removed before dragend lets the end
  point fall through to the Quick Access root, which would pin after the Drop
  itself was cancelled.
- **The destination identity is checked when the decision arrives.** The same
  `quickAccess` element must still be returned by the sidebar, connected, and
  so must the hit element. Otherwise the shared "destination changed" toast is
  shown. Re-owned Quick Access resolves to a non-sidebar target and pins nothing.
- **At most once.** The replay goes through `admitFileDrop`, so the gesture's
  completion receipt suppresses a later readable Drop or native delivery.
  Disposing the listener abandons any outstanding deferral.

Regression rows are in `tests/composables/drop-policy-differential.test.ts`
(search `#1101`). Each guard was mutation-checked: removing it fails at least
one row. That includes the drop effect, Escape, directory-only, zero
coordinates, end point containment, Quick Access identity and connection, row
connection, deferred DOM Drop ownership and disposal. A window modal opened
before the rejection resolves the live target as blocked.

Unverified: whether physical WebKitGTK reports the negotiated effect, rather
than `"none"`, on the dragend of a completed gesture that never dispatched
Drop. If it reports `"none"`, this path fails closed: nothing is pinned,
which is the pre-#1101 behaviour, and never a pin after cancellation.
