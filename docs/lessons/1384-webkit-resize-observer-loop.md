# The ResizeObserver loop at dense island startup was the frame sampler's

On WebKit against the production bundle, both "a dense island workspace never
overflows its splits from the first frame" tests in `e2e/pane-viewport.spec.ts`
failed every time with the page error "ResizeObserver loop completed with
undelivered notifications" (#1384). The dev server and Chromium passed.

The app did not cause it. With the sampler removed (or its snapshot replaced
by a function that reads no layout), the same startup on the same bundle ran
20 out of 20 times without the error. A standalone probe that only observes a
1px fixed `div` and calls `getBoundingClientRect()` in its callback reproduced
it with no app observer involved.

Mechanism: the bundle loads each lazy chunk's CSS through a `<link>`. While one
of those stylesheets is pending, WebKit builds no render tree, so the first
rendering update after `.pane-split` appears ran no layout. Its ResizeObserver
gather reported every target, including the sampler's probe, at 0 × 0. The
sampler's snapshot then read layout (`getBoundingClientRect`), which in WebKit
ignores pending stylesheets and forces the layout inside delivery. That gave the
probe its real 1–2px size. The probe is a child of `body`, the shallowest
observed node, so the engine could not deliver the change in that update and
reported the loop. Chromium never delivers the probe at 0 × 0. The dev server
injects CSS from JS modules, so no `<link>` was pending when sampling began.

Fix (`e2e/frame-sampler.ts`): skip the snapshot when the probe is reported at
zero size. That delivery belongs to an update that laid nothing out, so no frame
from it is painted. Taking a snapshot there forces the very layout it means to
observe. The `e2e-app-server: dev` opt-out on `pane-viewport.spec.ts` was
removed, so the spec runs on the bundle again.

Lessons:
- Before attributing a ResizeObserver loop to the app, remove the test's own
  observers and layout reads and run again. A harness observer that forces
  layout in its callback is enough to cause the loop.
- In WebKit, layout reads inside delivery (`getBoundingClientRect`,
  `getComputedStyle(...).width`) lay out while stylesheets are still pending,
  where the rendering update did not. A zero-size first report means the target
  was not laid out, not that it has zero size.
