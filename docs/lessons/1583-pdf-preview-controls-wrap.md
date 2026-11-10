# #1583 — PDF preview controls wrapped in a narrow preview pane

**Symptom.** At the 280px default preview width the PDF controls wrapped and left
the fullscreen button alone on a second row; narrower panes wrapped to three.

**Cause.** The bar needed about 286px (fixed 28px buttons, 8px gaps, padding) and
relied on `flex-wrap: wrap` to cope with anything narrower.

**Rule.** A toolbar is one row: choose its density from the width it actually
has. `pdfControlsDensity` (`domain/pdf-preview.ts`) maps the viewport's CSS-px
width (already measured by PdfPreview's ResizeObserver) to regular / compact
(≤330px) / minimal (<270px: zoom group removed; zoom stays on +/-/0, Ctrl+wheel
and the wider fullscreen bar). The page count truncates rather than wraps.

Do not use a CSS container query for this: WebKit (Playwright WebKit, the
WKWebView/WebKitGTK proxy) evaluates it against the root-`zoom`ed width, so at
130% a 240px pane matched as 312px and kept controls that do not fit. WebKit's
`scrollWidth` is also one px over `clientWidth` under root zoom with nothing
overflowing; measure clipping from control rects on both sides instead.
Tests: `e2e/pdf-preview-narrow-controls.spec.ts` (160–420px, 100/130%, run it with
`--project=webkit` too), `tests/domain/pdf-preview.test.ts`.
