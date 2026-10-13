# Details image resolution

Source dimensions belong to a lazy backend header read, not the resized thumbnail
or a full renderer image decode. Keep directory listings unchanged and bound both
native IO and the frontend queue. Unsupported or damaged metadata is optional.

A cache-free mounted cell still needs change notifications: directory refresh
reconciliation reuses unchanged entry objects, and image replacement can preserve
size and mtime. Subscribe to the existing shared event stream and cancel the old
request before rereading; do not build another filesystem watcher or pane refresh
policy. Virtualized row destruction cancels queued IO and retires late replies.

The Details header context menu must stop propagation. Otherwise the pane's
background file menu also opens and intercepts clicks on column visibility.

Regression coverage pairs real Rust image files with browser assertions of the
rendered cells, hide/reload/show, change invalidation, and column resizing.

Adding another Details column also widens its focusable row. At 150% zoom,
native Tab focus can scroll an `overflow: hidden` ancestor toward the trailing
columns and hide the file icon/name. The row's focus handler reveals its outer edge only for visible keyboard
entry from outside the row grid. Revealing on every focus overrides FileList's
preventScroll calls and resets the user's horizontal position when clicking
Resolution or pressing ArrowDown. Keep pointer selection and internal cursor
moves stationary; preserve the existing ring/icon assertions and cover the
scrolled Resolution column through both actions in a new browser regression.
Settings normalization tests must include
Resolution in the complete default-column object.

The native-suite TypeScript test invokes an external compiler and is not a latency
benchmark. Its child now has a 30-second process timeout and the enclosing test
has a 35-second deadline; the zero-exit assertion is unchanged. This avoids the
framework's five-second default rejecting a healthy compile on a slower host,
while retaining a finite bound for hung processes.

A virtual cursor jump can unmount the old focused row before FileList focuses
its replacement. A null relatedTarget is not proof of external keyboard entry;
keep its preventScroll behavior and require a known external focus origin for
the native Tab reveal. Cover scrolled Ctrl+End/Home as well as mounted arrows.

When integrating the Length column, retain both complete settings defaults and
independent resize/visibility assertions. Persistence browser tests must not use
`seedSettings` across reload: its init script reapplies the seed every load and
can overwrite the saved preference. Use a fresh context or a one-time seed.
