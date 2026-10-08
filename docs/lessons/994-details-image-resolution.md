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
