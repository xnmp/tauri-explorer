# 1709: animate the visible region, not the file-grid dimensions

The initial anchored reveal changed the live pane's width/height on every
animation frame. FileList synchronously commits its ResizeObserver width so
normal viewport changes cannot paint a stale grid. A large Tiles/List folder
therefore rebuilt layout and rows repeatedly during a 220 ms split.

Keep the live pane dimensions constant throughout the reveal and interpolate
its clip and position instead. Release the animation effect to settle the
underlying final size once. This preserves the existing DOM and text scale
without cloning rows or suspending watchers/input. Keep left/top positioning:
transforming a pane would change the coordinate space of pane-hosted fixed
overlays. The expensive descendant size observation no longer fires every frame.

An interrupted pane's bounding rectangle is now its held content size, not its
visible size. Compute its visible rectangle from the current clip when placing
the next divider; otherwise repeated/nested splits start from the wrong edge.
Carry ancestor clipping through new incoming panes as before.

Regression coverage observes actual file-view dimensions throughout paused
split progress. It fails on the old implementation for Details, List and Tiles
with 5,000 entries, and now requires zero intermediate resize deliveries and at
most one final delivery. Horizontal and vertical splits, visible clipped edges,
retained DOM/scroll, input and final-entry viewport intersection are covered.
Click a visible filename in these tests: a held wide Details row's center can
be beyond the clip, and `toHaveClass(/active/)` also matches `inactive`.

Independent warm-reveal measurements (three trials per view, same headless
software-compositor host) recorded source resize deliveries 5/5/3 → 0/0/0 for
Details/List/Tiles, with one settlement. Median Tiles main-thread work fell
215.64 → 87.72 ms and layout work 23.06 → 6.48 ms. Cold materialization remains
separate and was broadly unchanged; these are not desktop GPU FPS guarantees.
