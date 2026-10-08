# Details column menu under interface zoom

## Placement contract

The Details header column-selection menu takes viewport-space mouse coordinates.
A fixed overlay must convert those through the shared engine-aware
`fixedFromClient` helper before assigning CSS left/top.
Measure the mounted menu in CSS space with offsetWidth/offsetHeight and clamp
against viewport dimensions converted through the same helper. Preserve column
visibility actions and the 100% placement control.

Regression proof belongs at the rendered Details header popup, not solely at
zoom arithmetic helpers. Exercise zoom above/below 100% and viewport edges.

## WebKit versions and event ownership

Playwright's Safari 26.4 proxy scales fixed offsets once, unlike the native
double-scale model retained by the shared helper. Select the helper's mode from
the mounted popup's offset response relative to its size response. Comparing
offsets to size scaling also accommodates older CSS-space rects. The synchronous
probe completes before paint; other overlays retain their existing conversion.

The header contextmenu event must stop at the header. Otherwise FileList opens
its background menu over the column controls. Assert that competing menu is
absent. Near the viewport edge, choose input inside the header, clear of WebKit's
non-overlay scrollbar; the popup itself must still fit entirely onscreen.
