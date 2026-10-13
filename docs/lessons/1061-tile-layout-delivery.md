# Size the pane canvas in CSS, not from a deferred measurement

Leaving fullscreen Preview painted one frame of the Files tiles laid out for the
fullscreen width, clipped to the restored dock, then a second frame with
scrollbar gutters, before the settled grid (#1061).

The cause was above the file list. `PaneContainer` gave its workspace canvas
(`.pane-tree`) an explicit pixel width and height from `paneViewport.geometry`,
which is computed from the container's ResizeObserver measurement and committed
in the *next* animation frame. Whenever the workspace shrank (fullscreen exit,
docked Preview opening, window resize), the first layout after the change kept
the old canvas size (in the native reproduction the explorer pane stayed at its
fullscreen 1160 × 872 px inside an 880 × 834 px scrollport). That frame was presented as is, and the
oversized canvas also made the scrollport show scrollbars, so the next
measurement was 8 px short and produced a second wrong frame.

PR #1075's `flushSync` in FileList's ResizeObserver could not help: during the
stale frame the file list's width had not changed at all. Its test compared the
rendered tracks to a CSS probe of the same stale row width, so it passed.

The canvas now fills the scrollport through CSS (`flex: 1 0 0`, stretched
across) with an inline minimum from `paneMinima`, which needs no measurement.
Split children likewise paint the saved ratio as flex grow factors over
inline subtree minima (the divider is `box-sizing: border-box`, so it occupies
exactly the modelled gap). Flex resolution then applies the same clamp as
`paneGeometry`, in the layout pass that changes the viewport. The layout that
applies a viewport change therefore also sizes the panes, and the file list's
own ResizeObserver delivery settles the tile rows before paint. Measured
geometry still drives reveal, directional focus, divider input and ARIA
values, none of which is painted size.

Rule: never size painted layout from a ResizeObserver value committed in a
later frame. Express it in CSS from inputs that are known before layout.

Testing: `e2e/tiles-fullscreen-exit-frames.spec.ts` samples the tile grid and
pane widths in a ResizeObserver created after the app's observers, whose probe
changes size every animation frame, so it reports each frame after the app's
first-pass observer callbacks. It requires every frame after the change to
equal the settled grid, for fullscreen exits by Escape, double-click and image
click, docked Preview toggles, window resizes and a resize that makes a split
pane's minimum bind, in Chromium and WebKit. A sampler that only checks
consistency within one frame (tracks against a probe of the same width) cannot
see a stale frame.
