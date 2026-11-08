# #1532 — Icon drop-shadow filter cost Tiles scroll frames

**Symptom.** In the native WebKitGTK build, Tiles scrolling over 1,596 tiles ran
at p95 ~105 ms per frame with built-in icons, against ~24 ms for plugin `<img>`
icons with `filter: none` (#1530).

**Cause.** Every built-in icon carried `filter: drop-shadow(0 2px 2px ...)`
(`.icon-cat` in `FileIcon.svelte`, `.classic-large` in `FolderIcon.svelte`).
WebKitGTK re-rasterizes a CSS filter for every visible tile on every scroll
frame; an SVG `<filter>` inside the artwork is re-rendered per paint the same
way, so moving the blur into the SVG does not help.

**Fix.** No icon carries a CSS filter. Large artwork bakes its shadow: each
glyph is drawn twice, first as a `<g class="baked-icon-shadow">` offset by
2 CSS px (1.5 units on the 48-unit viewBox, 0.75 on 24, 4 on 128) with every
colour flattened to black at `opacity: 0.2`, then the glyph itself. A copy
preserves the glyph's own alpha (fill-opacity/opacity), which is what a
drop-shadow's mask uses; only the blur is dropped. 16px rows draw no shadow.

**Startup budget.** Duplicating eleven glyphs inline added ~200 B gzip to a
startup graph with 39 B of headroom. The large category artwork therefore
moved to the lazy `components/icons/LargeFileArt.svelte` (seam
`icons/large-file-art.svelte.ts`, mirroring #1491's special folder art), which
renders its `art()` snippet once as the shadow and once as the glyph. The Tiles
renderers' imports in `view-loaders.svelte.ts` await it, so tiles paint their
icons in their first flush; other large surfaces load it on first use. Net
startup gzip fell by ~360 B.

**Guards.** `e2e/icon-shadow-filter.spec.ts` asserts computed `filter: none`
on every icon slot and descendant (and ancestors to the row) in Details, List
and Tiles for all four packs, and that each icon still paints;
`tests/components/icon-baked-shadow.test.ts` checks the shadow copy precedes the
glyph and that no icon component's `<style>` declares a `filter`.

**Not measured here.** The native WebKitGTK frame medians need the real binary;
headless Chromium cannot rank WebKitGTK filter rasterization.
