# Tiles motion sampling must use controlled time

The dev CI failure was the Tiles Folder Peek animation probe in
`e2e/folder-peek-tiles.spec.ts`: all three WebKit attempts saw only two distinct
heights instead of more than two. The preceding palette change did not touch
Tiles or the probe. A 150ms animation cannot guarantee six intermediate samples
when real rAF delivery is throttled or the runner stalls.

The probe now installs Playwright's clock before navigation and pauses it after
the initial panel has settled. The page-side sampler still reads the actual
rendered VirtualList heights and ghost DOM on six rAF callbacks. The runner
advances 100ms of controlled time while that sampler is pending, then completes
the motion before checking settled layout. A deliberate 200ms wall-clock delay
before advancement guards against runner time consuming the animation.

Keep the original more-than-two-height assertion, inert/identity-free ghost
checks and instant reduced-motion checks. Lowering the height threshold would
allow an instantaneous layout jump to pass. No application behavior changes,
so no UI screenshot is required.
