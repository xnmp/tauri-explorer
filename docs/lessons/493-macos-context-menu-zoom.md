# Context-menu coordinates under macOS zoom

`position: fixed` overlays under root CSS zoom do not share one coordinate
conversion across engines. The context menu must keep its Chromium engine check:
Chromium uses one division by zoom, while macOS WKWebView needs two divisions for
client and post-zoom-rect anchors. WebKitGTK's CSS-space rect is the separate
single-division case for `fixedFromRect`.

Regression coverage belongs in `tests/domain/zoom.test.ts`, using the pure
fixed-overlay converters at both zoom-in and zoom-out levels.
