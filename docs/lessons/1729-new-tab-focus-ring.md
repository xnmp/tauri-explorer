# #1729 — Ctrl+T flashed the keyboard focus ring (WKWebView)

WebKit treats script focus that follows any key press as `:focus-visible`.
The new tab's restored row focus runs right after Ctrl+T, so after a pointer
selection the new row drew the full keyboard ring for a few frames. Chromium
instead inherits the state from the previously focused element, and neither
Playwright engine reproduces WebKit's key-press heuristic.

Fix: `state/row-focus-ring.ts` records, on every row `focusin` in `FileList`,
whether that row matched `:focus-visible`. Restore-type focus only — a pane's
first load (`NavigationFocusRequest.complete(restore)` is true for the
`"initial"` load reason: new tab, split, restored tab) and
`FileList.handleViewLayoutChange` — passes `focusVisible: rowFocusRing.shown`
through FileList's `scrollToEntry` seam. Ordinary navigation (sidebar,
breadcrumb, Back) and keyboard movement pass no option: applying the recorded
state there took the ring away from a keyboard user who had last clicked a row,
and forced one on a mouse click on Back after arrow keys. Before any row had
focus, or where `:focus-visible` cannot be evaluated, `shown` is undefined and
the browser decides. The record is window-global because the restoring row
belongs to a different tab than the recorded one.

Second cause found on dev: with retained tabs (#1173) the new tab never
restored row focus at all. Its navigation focus request captured the source
tab's still-focused row; retaining that tab made the row inert and
`PaneContainer` blurred it (#1703), so focus fell to the body while the old row
stayed connected, and the request's "focus is still ours" check (which only
accepted a *disconnected* previous owner) rejected it. `focusStillOwned` in
`state/deferred-focus.ts` also accepts an owner inside an `[inert]` subtree.

Testing: assert the `focusVisible` option the app requests by wrapping
`HTMLElement.prototype.focus` in an init script, plus the resulting
`:focus-visible` match, which both engines honour for the explicit option.
`e2e/new-tab-selection.spec.ts` covers click-then-Ctrl+T and
arrows-then-Ctrl+T in every view mode, in Chromium and WebKit.
