# TraceExplorer #61: marquee selection and range anchors

Plugin `setSelection` used `explorer.selectPaths`, which always reset the range
anchor and moved the cursor to a primary selected path. Built-in marquee
`selectByIndices` only replaces the selected set, preserving both even when the
cursor is unselected. Keep that policy in pure `state/selection.ts`, forwarding
`{ keepAnchor: true }` through the pane. Advertise `selectionAnchor` so older
hosts retain the existing two-argument behavior. The pane's `focusedPath` getter
still reports the selected cursor or first selected entry without moving it.
