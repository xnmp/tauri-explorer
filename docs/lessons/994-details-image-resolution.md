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
columns and hide the file icon/name. The row's focus handler reveals its name
cell with nearest alignment; it does not change column widths or selection.
Keep the existing HTML-icon viewport assertions and a zoomed row-focus
regression to cover this interaction. Settings normalization tests must include
Resolution in the complete default-column object.

The native-suite TypeScript test invokes an external compiler and is not a latency
benchmark. Its child now has a 30-second process timeout and the enclosing test
has a 35-second deadline; the zero-exit assertion is unchanged. This avoids the
framework's five-second default rejecting a healthy compile on a slower host,
while retaining a finite bound for hung processes.
