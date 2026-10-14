# #1051: Marquee band must be transform-only, not a resized element

Drag-selecting in a large folder of pictures trailed the pointer on Linux even
though the rAF-throttled hit test (#47, #756) cost about 1ms per frame. A
real-binary probe (`e2e-tauri/probe/`, a synthetic drag over 5,000 4K JPEG
tiles under Xvfb) put the median frame at 22-26ms on a quiet host and at
90-100ms while the host's cores were busy, against the idle 16-17ms with the
band hidden by CSS in the same sessions. Stripping the band's background and
border changed nothing, while freezing its width/height (translate only)
restored idle frame times: the cost was resizing a composited layer every
frame, which WebKitGTK reallocates and repaints over the tiles beneath.
Background thumbnail decoding for the same folder multiplies that cost
because it competes for the same cores, so picture folders feel it first.

The band is now five fixed-size layers (`.marquee-rect` fill plus four
`.marquee-edge` lines) whose only per-frame change is `transform`. The pure
geometry lives in `domain/marquee-rect.ts`: the fill is the container's size
and scales down to the band; each edge is a container-length 1px line that
scales along its length only. The base must be container-sized, not 1px:
engines rasterise a layer at whole device pixels, so at 130% zoom a 1px base
rounds to one device pixel and the scaled fill painted 1.3× too small while
`getBoundingClientRect()` still reported the right box. App hit-testing never
reads the band element; test probes that do must read `.marquee-rect` through
`getBoundingClientRect()`, which includes transforms. Size the base from the
container's client box (`clientWidth`/`clientHeight`), which is what
`width/height: 100%` resolve against: a bounding rect includes a classic
scrollbar on `.content` (Details with a preview dock), and a base taken from
it painted a pane-tall band several pixels short of its bottom edge. Never
reintroduce `width`/`height` writes or a border on the band.

Verify with a rendered drag, not a CSS source check: assert the layers'
layout boxes stay container-sized while their rendered boxes frame the drag,
and sample screenshot pixels at a fractional zoom (`e2e/png-pixels.ts`),
because DOM geometry cannot see a mis-rasterised layer. Drag a pane-tall band:
a 60px band hides a scrollbar-sized base error inside the tolerance. Headless
Chromium hides scrollbars; the classic-scrollbar case needs its own spec with
`ignoreDefaultArgs: ["--hide-scrollbars"]`, which Playwright only accepts at
file level. Scope real-binary timing probes to one WebDriver session at a
time; a second launch while the first driver still owns port 4444 reports
"Maximum number of active sessions".

When a test waits for a drag to settle, poll every side of the band, not only
the far corner. For an up-left drag the right and bottom edges are the anchor,
so a zero-size fill still sitting at the press point satisfies them. CI's
WebKit job read the layers about 40ms after Playwright's synthetic moves,
before the rAF-throttled update ran, and failed on the left edge by the whole
drag width. Measure the drag start from the listing's client box too: at 130%
zoom WebKit's Details view grows a horizontal scrollbar under the bounding
rect's bottom edge.
