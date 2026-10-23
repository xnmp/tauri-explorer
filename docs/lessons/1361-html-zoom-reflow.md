# #1361 — HTML preview zoom reflowed instead of magnifying

#1352 implemented zoom with browser page-zoom semantics: the sandboxed frame was
laid out at `pane / scale` and painted scaled. For a responsive page, every
zoom step simply re-laid the page out at a new width, so it kept overflowing
the same way and the scrollbars looked stuck. Zooming out never revealed more of
it, and at 100% in a narrow dock a multi-column page collapsed to one column.

The fix scales a fixed desktop layout like an image: the frame lays out at
`max(1280, pane, pane / scale)` CSS px and zoom only scales its paint. A first
attempt used `max(1280, pane / scale)`, which still reflowed panes wider than
1280px when zooming in; a review caught it, and an E2E with a 1500px breakpoint
in a wide fullscreen pane now guards it. The pane
scrolls horizontally when magnified, while the frame scrolls vertically.

Height stays in CSS (`height: calc(100% / scale)` inside a canvas that fills
the viewport). Svelte's `bind:clientHeight` did not update when the horizontal
scrollbar appeared, which left the frame 8px taller than the visible area.

The E2E oracle is outcome-based: a responsive card grid keeps three columns in
its first row at Fit, 100% and smaller zooms, and the horizontal scroll range
shrinks as zoom decreases. Both checks fail on the #1352 implementation.
