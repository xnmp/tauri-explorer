# #503: CSS transition time is hover latency

## Symptom

Hover highlights across file views, sidebar navigation, and window tabs felt
laggy even though pointer movement did not trigger expensive JavaScript or a
Svelte re-render.

## Root cause

The affected surfaces animated their hover paint for 80–150 ms. Browser
profiling showed active CSS transitions while the main thread remained idle:
Details and List entries and sidebar rows settled for 80 ms, Tiles entries for
120 ms, and inactive-tab feedback for 150 ms.

## Fix and regression seam

High-frequency pointer highlights now paint immediately. One-shot structural
motion, including tab entrance and closure, remains animated because it conveys
a state change rather than acknowledging continuous pointer input.

The regression test must use a real browser hover and inspect the rendered
paint plus active animations. A JavaScript timing test is the wrong seam: this
bug occurs after event handling, entirely inside the browser's CSS animation
pipeline.
