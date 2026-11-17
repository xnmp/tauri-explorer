# Tab seam marks: inline SVG updated in place (#1734)

The strip shade, tab fill, key shadow and edge highlight are long-lived
inline SVG elements in `TitleBar.svelte` (`[data-region="tab-key-shadow"]`,
`[data-region="tab-edge"]`). `composables/tab-seam-marks.ts` (lazy-loaded
for the startup bundle) rewrites their `d`, clip rects, gradient stops and
blur in place.

- Never animate through a per-frame `url(data:...)` mask or background:
  WKWebView drops the image while it changes, so the shape blinks.
- The strip shade is one path with a hole: counter-clockwise strip
  rectangles plus the clockwise tab silhouette, under the nonzero rule.
  The strip outside the tab viewport is drawn twice so overflow scrolling
  never leaves an unshaded wedge at the ends.
- Measure in the same frame the tab moves. The marks run a rAF loop while
  any title bar animation is running and for 3 quiet frames after, plus a
  ResizeObserver, capture `animationstart`/`transitionstart`/`scroll` and
  window `resize`. A rAF-only sampler in a test runs before the marks'
  callback and reports the previous frame; sample with a ResizeObserver
  probe instead (`e2e/tab-frames.ts`), which runs after rAF and layout,
  before paint.
- A tab narrower than about 18px would draw its outline as a 1px vertical
  sliver, so the edge stroke and shadows fade with the tab's width
  (`presence`). An active tab opens from a 34px seed, so it is drawn whole
  from its first frame; see `1734-tab-slide-fillets.md`.
- Performance: in software-rendered WebKit, repainting the shadow layer and
  re-clipping the seamed island each frame cost ~45ms. `will-change:
  opacity` on the SVG layers and on `[data-tab-seam]` composites them.
  Never `transform`/`will-change: transform` on an island: that makes it
  the containing block of fixed overlays.
