# #975 acceptance evidence

The PNGs use synthetic mock files and a private headed WebKitGTK display.

- `sparse-tiles-130.png`: an 817 × 1361 CSS-pixel pane at 130% application zoom,
  window controls/sidebar/status hidden. A few files leave ample empty space;
  the workspace has no unnecessary horizontal or vertical scrollbar gutter.
- `overflow-final-entry.png`: a 500-entry Tiles directory at 130% application
  zoom, after wheel scrolling and Ctrl+End. `image-00498.png`, the actual final
  sorted file, is selected and visible; the legitimate vertical scrollbar is
  at the bottom. Screenshots retain the renderer's device pixel scale.

Before the fix, the new sparse-pane regression failed at 130% in both engines:
Chromium underfilled the available width by 0.609375 physical pixels and WebKit
reserved 9.703125 pixels. The final implementation uses fractional content-box
measurements and commits geometry outside ResizeObserver delivery.

Verification before publication:

- Complete pane outcome suite: 40/40 passed in Chromium and WebKit.
- Pane/domain/windowing unit contracts: 58/58 passed.
- Empty-pane geometry: 12/12 portrait/wide checks passed across all three modes
  and both engines, with zero scroll range and ≤0.03125px canvas underfill.
- Independent adversarial review confirmed sparse/island sizing, real dense
  scrolling, dense-to-single gutter removal, divider input, and cancellation.
  Its final WebKit probe recorded zero page errors across 12 fresh pages,
  48 live zoom updates and 24 viewport resizes.
- Type check: zero errors and warnings. Code map coverage: 589/589 source files.

The private display audit verified MiniBrowser, WebKitWebProcess and
WebKitNetworkProcess inherited the isolated X11 display, D-Bus session and XDG
profile. Earlier headed runs had native `setViewportSize` protocol failures
before navigation; reached application assertions and the screenshot cases
passed. Those setup failures were kept separate from product results.

The full all-view suite is recorded in the issue/PR verification comment.
