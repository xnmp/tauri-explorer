# Tile rows must settle within width delivery

FileList owns measured content width; TilesView consumes it for row chunking,
navigation and CSS tracks. Fullscreen removes Preview from flex layout, expanding
the Files area. Exiting restores the dock and shrinks that area. Updating width
without synchronously rendering left 11 narrow tracks where CSS auto-fill required
8. `flushSync` in FileList's ResizeObserver commits the measured width and row
chunking together before delivery returns, without hiding tiles or changing math.

The regression spec wraps native ResizeObserver delivery and samples actual CSS
tracks immediately after the application callback, before deferred Svelte work.
An independent browser CSS auto-fill grid supplies the expected tracks. Sampling
only after an awaited locator assertion would miss the stale layout. This proves
layout delivery, not presentation timing in a native Wayland compositor.
