# Fullscreen text preview size and wheel zoom (#1039)

The fullscreen Preview pane sets `zoom: calc(1 / var(--app-zoom))` so a
fixed-position surface covers the visible viewport under the root UI zoom
(#236). That cancellation is right for images but shrinks text: at 150% app
zoom the fullscreen text rendered at two thirds of its docked size, which looked
"very small" after arrowing from an image to a text file.

Text, markdown and code (`textZoomable` in `PreviewPane.svelte`) therefore zoom
themselves back by `--app-zoom` and by the wheel zoom (`--fs-text-zoom`), using
CSS `zoom` on the content element so headings, padding and reflow scale together.
CSV (fixed-pixel virtual rows), folders, PDF and video are deliberately excluded.

Because the plain wheel is the zoom gesture, the fullscreen text scrolls by
Up/Down keys (`scroll` action) or its scrollbar. Zoomed text must not use the
image "pan" mapping, or Left/Right stop stepping between files:
`fullscreenKeyAction(..., "text")`.

Measure the rendered size with a `Range` rect of the first glyph, not
`getComputedStyle().fontSize`, which ignores CSS `zoom`.
