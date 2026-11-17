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

Seeking WebKit's stretched transition of the registered `--tab-px` reports
its end value after the first step. The transition still reads as running at
10%, so this looks like a seeking artifact, not app behaviour. WebKit contact
sheets of a compressed strip therefore show the other tabs snapping at
frame 2. Judge that case from Chromium, or from WebKit's first frame only.
