# Tab slides: flex-basis, seed, fillets and bleed (#1734, #1708)

- Size a sliding tab from the stylesheet: `flex-basis` and `width` are
  `--tab-grown`, which goes from `--tab-seed` to the live `--tab-width` as the
  registered `<number>` `--tab-slide` goes from 0 to 1. Keyframes resolve
  `var()` once, while the strip can resize a tab mid-slide. WebKit also
  ignores an animated `width` on a flex item that has an explicit size.
- **A new active tab never grows from nothing.** Growing from zero left a
  frame with no visible active tab, followed by an empty silhouette. The
  active tab's seed is `min(--tab-width, 34px)`: its padding and icon, with
  whole fillets, full-strength outline and the island seam from the first
  frame. The title is revealed by the tab's own clip as it grows. Inactive
  tabs (opened in the background) still grow from nothing, with padding and
  content scaled by the slide.
- A seed appears before the other tabs have eased narrower. In a compressed
  strip it overflowed and scrolled every tab sideways for a few frames.
  While the strip fits, its tabs may flex-shrink inside a list capped at the
  viewport width, so they share the seed's room in that frame. An
  overflowing strip scrolls instead.
- A closing tab slides out with its own sized keyframes (WebKit does not
  recompute var()-derived styles on a removed node), and it drops `.active`
  and `aria-selected` as the outro starts. Its neighbour therefore owns the
  island in the same frame.
- The tab viewport clips at its padding box. Give it `TAB_BLEED` (15px:
  fillet plus ring) of inline padding, cancelled by negative margins while
  the strip fits, so the first and last tab keep both fillets. Reveal the
  active tab with the same bleed (`tabRevealDelta`) when the strip
  overflows.

Tests: `e2e/tab-overflow.spec.ts` covers first/last fillets, seeded growth,
and "+" riding behind the tab. `e2e/floating-islands.spec.ts` covers exactly
one fused active tab on every frame of open (3 and 8 tabs), close, click and
Ctrl+Tab; a strip that never shifts sideways; and whole fillets from frame 1.

Frames are stepped deterministically (`e2e/tab-frames.ts`): Web Animations
are held and seeked 15ms per step, and CSS transitions are stretched ×1000.
Wall-clock playback flaked on CI, because headless WebKit spends ~100ms
mounting a new tab's pane.

**WebKit screenshots perturb running tab animations; they do not show app
behaviour.** An earlier note here blamed WebKit's seeking for tabs snapping at
frame 2. That was wrong. Without screenshots, seeked and real-time WebKit
trajectories match Chromium to about 0.3px. `page.screenshot` jumps a running
`--tab-px` transition and paints that state before any script runs. The
JS-written seam marks therefore lag the tab in that one captured frame,
which looks like a shape about 1.25× off at 125% zoom. Assert motion from
`steppedFrames` geometry. Treat WebKit contact sheets as illustration and
judge frame-exact claims from Chromium sheets.

## Visual QA follow-ups (#1744 review)

- **Strip width moves one way.** On open, the other tabs ease over the new
  tab's duration and curve. On close they jump (`--tab-width-ease: 0ms`), and
  flex-shrink hands them the room the outro releases. The strip layout
  (count plus active id) is deferred one frame on count changes, so it starts
  with the slide rather than a frame before it. Otherwise "+" dips, most
  visibly in WebKit at 125% and with 12 tabs.
- **Stacking.** Title bar children are positioned so they paint above the
  strip shade layer. Each tab is `isolation: isolate`, with its hover/active
  `::before` at `z-index: -1`, so the pill never covers the title or icon.
  Hover stays transition-free (#503).
- **Titles clip and fade, never re-ellipsize.** A right-edge mask fade on the
  title keeps the text from reflowing every frame of a slide. Compact tabs keep
  their icon anchored at the left padding (no centring), so the icon-only
  crossing (`TAB_ICON_ONLY_BELOW`) does not move it.
- **Overflow is an overlay.** The scroll buttons are absolutely positioned over
  the viewport's edge fades, so crossing into overflow shifts no tab.
- **The fused tab stands on a flat stretch of one island.** In Floating
  Islands, the strip starts over the content island
  (`composables/tab-strip-start.ts`, `tabStripPadding`), so the first tab's
  fillet clears the island's rounded corner. A tab spanning two content
  islands (split panes, preview) squares their facing corners
  (`data-tab-square`) and bridges the gutter (`gutterRowsFor`). In dark themes
  only a rounded corner's edge highlight differs from the surface, so pixel
  tests must scan the whole corner zone, not one interior pixel.
- A faint step beside the fused tab in light themes is the tab's lift-shadow
  gradient, not a path edge.
