# #982: crop editor controls and opening responsiveness

The shared dialog stylesheet themes secondary buttons only when they opt into
`btn secondary`. Plain `btn` left the crop controls on native gray chrome and
inherited a 100px minimum width for every zoom button. Override only the compact
crop toolbar sizes and retain explicit themed action variants.

Show the already loaded preview immediately while the immutable source capture
is pending. This display is provisional: save remains disabled until the owned
capture and its original dimensions are ready. Freeze that preview with the
opening path/name; never use its geometry or bytes for native save authority.

A raster image's load event already establishes intrinsic dimensions. Do not
wait for a second full-resolution decode just to read those dimensions. SVG is
different: WebKit can report layout-dependent dimensions for a connected image,
so its independent intrinsic-viewport decode remains necessary.

A bounded four-panel mask replaces the 20,000px selection shadow. Cache gesture
geometry before crop writes and refresh on image resize and every ancestor's
scroll event (scroll does not bubble). Disable the crop card's entrance transform:
it changes image coordinates without a resize notification. Independent probes
found both ancestor-scroll and entrance-transform stale-coordinate failures.

Fractional app zoom and device scale also make WebKit's scrollWidth and
clientWidth round differently. Measure the border box, subtract its borders, and
reserve fit independently of zoom scrollbars. During the redesign, a guessed
initial 640×360 stage and content-box observation created scrollbar/fit feedback
and deferred ResizeObserver notifications. Hide
the image until its real fit measurement is ready, and assert that
the fitted view actually cannot scroll instead of subtracting those rounded
metrics. Keep zoomed scrolling available and map through measured image bounds.

Independent original/current Chromium and WebKit drag fixtures both sustained
approximately 60fps; no severe drag lag was reproduced. A Chromium burst trace
confirmed 100 synchronous layouts inside pointer input dispatch before and zero
after. That does not establish native capture latency or a frame-rate speedup.
