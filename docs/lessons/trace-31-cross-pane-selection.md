# TraceExplorer #31: cross-pane selection without focus transfer

Built-in Details/List/Tiles share `FileList.handleClick`, but pane focus also
changes independently through native row focus before click and through the
pane's bubbling click handler. Skipping the selection handler's explicit
`.focus()` alone does not preserve active-pane shortcut ownership.

Keep modifier policy in `domain/workspace-selection.ts` and apply it across
mousedown capture (capture the focus owner for the cross-pane additive
entry gesture), focusin (return DOM focus to that owner) and explicit click
focus. End pointer ownership at mouseup, keyboard input, blur or drag start.
Do not cancel mousedown: that can suppress HTML5 drag acquisition. Preserve
the drag handlers and editable controls. Shift retains range selection and normal pane activation.
Plain clicks replace only the target pane's selection; other pane selections
remain available for split-pane operations, as before.

Combine selections through `window-tabs.getCombinedSelection`, using only the
active explorer tab's layout leaves. Do not use `getAllExplorers`, which includes
hidden tabs. Preserve `getSelectedEntries`' per-pane listing order; focused pane
comes first and wins duplicates, then other panes follow layout visual order.
The plugin method is optional and its runtime capability is `combinedSelection`.

Browser regression specs are in `e2e/cross-pane-selection.spec.ts` for all three
built-in view modes. They must be run by the lead on a private test port because
the implementation worktree cannot bind sockets. The dedicated
`playwright.cross-pane.config.ts` uses port 14331. TraceExplorer's SDK declaration
and harness live in its separate checkout and require their own follow-up update.

Custom plugin buttons retain their existing focus semantics through
`FileViewPane.select`; this change covers the built-in file listings. The
combined API still includes selections held by plugin-backed panes.
