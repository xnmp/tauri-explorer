# Tab slides: flex-basis, fillets and bleed (#1734, #1708)

- Slide tabs with `flex-basis: calc(var(--tab-width) * t)` and `width:
  auto; min-width: 0` (`domain/tab-slide.ts`). WebKit ignores an animated
  `width` on a flex item that also has an explicit size, so the tab snapped
  to full width at the end of the slide.
- Scale everything that has a fixed size with the slide (`--tab-slide`, a
  registered `<number>` so keyframes interpolate): padding, the fillet
  (`calc(14px * var(--tab-slide))`), and fade the content in over the second
  half. A fixed 14px fillet on a 3px tab draws spikes.
- The tab viewport clips at its padding box. Give it `TAB_BLEED` (15px:
  fillet plus ring) of inline padding, cancelled by negative margins while
  the strip fits, so the first and last tab keep both fillets. Reveal the
  active tab with the same bleed (`tabRevealDelta`) when the strip
  overflows.
- Measure the tab space synchronously when the tab count changes; the
  ResizeObserver delivery alone can leave one frame sized for the old count.

Tests: `e2e/tab-overflow.spec.ts` (first/last fillets in fitting and
overflowing strips, a new tab slides from nothing) and the frame tests in
`e2e/floating-islands.spec.ts`. They play title bar animations at a tenth
of their speed: headless WebKit spends ~100ms mounting the new tab's pane
and otherwise shows only one or two frames of a 180ms slide.
