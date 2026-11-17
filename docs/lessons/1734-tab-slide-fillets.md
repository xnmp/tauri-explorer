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

- **Strip width moves one way.** The other tabs ease to their new width over
  the sliding tab's own duration (in 180ms, out 120ms) with the same
  ease-out cubic curve. They never take more room than the sliding tab frees,
  so the total moves one way. The strip layout (count plus active id) is
  deferred one frame on count changes, so it starts with the slide rather
  than a frame before it. Otherwise "+" dips, most visibly in WebKit at 125%
  and with 12 tabs. A 0ms close ease avoided the dip but jumped survivors up
  to 16px in one frame in the narrower islands strip.
- **The stepped harness stretches transitions unconditionally.** It used to
  stretch them only if a tab already had a transition when the hold started.
  On a loaded runner the strip had not enabled its width ease yet, so later
  transitions ran in real 180ms and read as one-frame snaps (WebKit, 4
  workers: 15 of 16 failures).
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

## Round 2 (narrow windows, WebKit)

- **The strip start is adaptive.** It starts over the content island only
  while every tab still fits at its comfortable width there
  (`tabStripStart`); otherwise it gives the band over the sidebar back, down
  to the window edge. The room is measured as if the strip started at the
  edge, so moving the start never changes its own input. A foot that then
  lands on any island, or straddles a gutter, squares the reached corners
  (`tabFootFor`), and only the active tab's shown span opens a seam
  (`tabShownSpan`, fades included).
- **A transient layout can clamp a scroll position.** Re-running an effect
  that removed and re-applied the strip padding forced a layout without it,
  and the browser silently clamped `scrollLeft` to 0. No ResizeObserver saw
  the transient. Derive effect triggers as booleans, and report values
  through callbacks instead of writing CSS from a teardown.
- **Reveal from the target layout, then glide.** Revealing the rendered,
  mid-slide strip scrolled one way and then back. `tabRevealScroll` computes
  the rest position (a fitting strip rests at 0). The list is then translated
  back by the distance scrolled, and that eases out. While it glides, the
  overflowing list keeps its scroll extent but pads its end by the shift, so
  the end of the strip, often the new tab and its fillet, stays whole.
- **WebKit leaves a scroller's inline-end padding out of `scrollWidth`.** An
  overflowing strip's end bleed lives on the tab list (its own padding), not
  on the viewport, or the last tab's fillet can never scroll into view.
- **Never observe a box your write resizes.** WebKit reports "ResizeObserver
  loop completed with undelivered notifications" when a callback's write
  resizes an observed box at or above the round's shallowest depth. Islands
  sit deeper (panes container at depth 9, split panes at 13) than the strip's
  scroller (depth 8). Observing them made the start's padding write loop, as
  in a dense split layout restored at 130%. The start observes only the title
  bar, main and main's children, and a MutationObserver handles split and
  island changes. The room is observed on `data-tab-room-box`, which neither
  the start nor the tabs can resize.
- **An effect that creates an observer must not track what its callback
  writes.** The room effect measured synchronously, so it tracked the room.
  Every change re-created the ResizeObserver mid-delivery, and the new
  observer's initial notification for a shallow box was skipped: a WebKit
  loop on every zoom change (`pane-viewport` divider tests). Untrack the
  initial measure.
- **Seam marks must forget a cleared state.** After a hidden or empty
  measurement, the "unchanged key" short-circuit kept a tab scrolled back
  into view from redrawing its seams.
- Title fades apply only when a title (or one of its parts) overflows
  (`.fits`). Inactive titles narrower than 24px (1.5× the fade) are hidden
  (`TAB_ICON_ONLY_BELOW = 64`).

## One painter per pixel at the seam (#1744 real-Mac review)

- **Every pixel has one painter, and ownership changes on device-pixel
  boundaries.** Two translucent layers meeting inside one anti-aliased pixel
  conflate into a visible seam, and a layer that both an island and the tab
  paint (a top border, an inset highlight, a shade) reads as a band or a
  hairline across the tab's foot. A seamed island now gives up its whole top
  border row between its corner tangents (`domain/island-outline.ts`): its
  clip-path removes that row and everything above the notch, the tab's fill
  repaints it, and the tab's SVG stroke draws the edge from tangent to
  tangent, over the tab. The island's own inset top highlight is dropped
  while seamed.
- **Corners stay CSS.** An SVG arc only approximates the engine's border
  rasteriser: WebKit draws a 1px CSS corner up to 17/255 heavier than a
  geometric ring, Chromium up to 11. The stroke takes over on the straight
  edge at the first whole device pixel past each arc, so every island's
  corners stay identical whether or not a tab opens into it.
- **The engines snap differently.** WebKit snaps box edges and border widths
  to device pixels; Chromium snaps to zoomed CSS pixels, then scales by the
  device pixel ratio (`DeviceGrid.unit`). At 125% on a 2x display an island
  at 47.5 visual px paints at device row 96 in Chromium and 95 in WebKit.
- **The clip-path reference box differs too.** Chromium resolves a
  `clip-path: polygon()` against the unsnapped layout box, WebKit against the
  snapped painted box; the polygon is written relative to each.
- **WebKit bounds a multi-child SVG `<clipPath>` by the clipped element's
  geometry bounding box.** A clip with a rect and a path cut away the lower
  half of the stroke at 110%/2x. Use one `<path>` child.
- **A nonzero strip shade painted its silhouette hole.** The shade's path
  ran outside the bar, so its hole beyond the bar rect was filled: a faint
  band along the foot in WebKit. Clip the shade to the bar.
- **The default layout's active tab must not stay opaque on the material.**
  It is the pane's surface layered over `--background-solid` (#243); under
  `[data-macos-material]` that solid read as a white card on glass over the
  translucent toolbar. On the material it adds only the navigation bar's
  surface over the title bar (already the pane's card), with no solid base.
- **Frozen frames in WebKit need one throwaway screenshot.** A held strip
  moves ~10px on WebKit's first `page.screenshot`, and the seam marks' frame
  loop stops with the paused animations. The matrix spec pauses, takes that
  screenshot, then dispatches `resize` so the marks follow before measuring.

Tests: `e2e/tab-outline-matrix.spec.ts` runs layout (islands, default) ×
platform (macOS with material, macOS without, Linux/Windows) × theme at rest
(1, 3 and 12 tabs), on hover and on stepped frames of opening and closing, at
100%/1x, plus every islands cell at 125%/2x. Each check compares the frame
with one layer changed: the island outline against its own CSS border, the
rows from one above the seam to four below against the tab body, the strip
shade below the base, and the shadow on each side. It fails on 478ca1ac.
