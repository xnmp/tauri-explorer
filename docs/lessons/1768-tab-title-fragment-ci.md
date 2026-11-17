# #1768: a stepped frame must be paused before it is inspected

The title-fragment test (`e2e/floating-islands.spec.ts`, #1744) compares a
held tab-slide frame with the same frame with the title hidden. It needs the
frame to hold still across its screenshots. Shipped with a retry loop that
waited for stillness, it failed every retry of the closing case on CI
Chromium. 6x CDP CPU throttling (`Emulation.setCPUThrottlingRate`) reproduced
it locally, in the opening cases too.

`steppedFrames` (`e2e/tab-frames.ts`) holds animations, it does not stop them.
Held Web Animations play at a 1e-6 rate, and the tab strip's CSS transitions
are stretched 1000x but still run in real time. A slow runner's screenshots
outlast that, so whole pixels move. `onStep` now runs with every running
title bar animation paused (`pause()`, then `ready`, then two frames), and
they resume afterwards. Three engine effects had to be handled before that
check held:

- **Stale raster (Chromium).** The first frame of a closing tab could keep
  a raster of its title whose antialiasing differed by up to 56/255 from any
  repaint, with identical geometry and animation state. Hiding the title for
  the reference frame forces that repaint, so the shown frame is repainted
  first.
- **WebKit's first screenshot of a held slide** resolves the strip's
  `--tab-px` transitions to their end values. They stay there; setting
  `currentTime` again does not bring them back, and later screenshots move
  nothing. The strip moved 10 to 70px. It is not the caret-hiding style
  (`caret: "initial"` changes nothing). A throwaway screenshot before
  `onStep` takes that step first.
- **Cost.** WebKit screenshots and frames are slow (about 0.5s per inspected
  step). The test steps only to the slide's end and has its own timeout.

Checks: the stillness assertions are exact (box equal, pixels equal), with
no retries. All three cases pass `--repeat-each=5` under 6x throttling in
Chromium and four parallel workers in WebKit. With the product's title gate
removed, the opening cases still fail in both engines.
