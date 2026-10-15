# 1053 — context menu opened left of the pointer under zoom (Linux)

**Symptom:** at 120% zoom the file/folder context menu appeared well left of
(and above) the right-click point, worse further right/down.

**Cause:** `ContextMenu.svelte` converted the pointer with `clientToFixed`,
which divides by zoom² on every non-Chromium engine. Current WebKitGTK/Safari
scale `position: fixed` offsets once (like Chromium); only macOS WKWebView and
older WebKitGTK scale twice. The user-agent cannot tell these WebKit versions
apart, so the engine check put the menu at x/zoom² instead of x/zoom.

**Fix:** the menu now probes its own mounted node
(`probeSingleScaleFixedOffset` in `domain/zoom.ts`, the same probe the Details
column popup uses) and places itself with `fixedMenuPosition`, passing the
12 on-screen px edge margin (legacy double-scale engines previously kept 12 offset units). `submenuFlip` uses the probed mode too. Other overlays still
use the user-agent-based `clientToFixed`/`rectToFixed`.

**Tests:** `tests/domain/fixed-offset-scale.test.ts` (classifier for each
engine model, placement) and `e2e/context-menu-zoom-placement.spec.ts` (Tiles /
Medium at 120% and 80%, asserts the rendered menu box at the pointer). Run the
latter with `WEBKIT=1 ... --project=webkit`: Playwright's WebKit single-scales
fixed offsets like current WebKitGTK, so it fails (160px off) without the fix,
while Chromium passes either way.
