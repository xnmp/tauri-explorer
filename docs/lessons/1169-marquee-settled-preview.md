# #1169: Marquee drags stalled when the band crossed a single file

**Symptom:** drag selection felt less snappy than Thunar even after the
transform-only band (#1051), worst at the start of a drag.

**Measured on the real binary** (`e2e-tauri/probe/marquee-probe.spec.ts`,
WebKitGTK 2.54 in the NVIDIA shared-memory mode, Xvfb 1600×1000): the probe's
per-frame JS was 2ms and style+layout 1–2ms, yet with the preview dock open
the frame where the band first covered exactly one file took 400–460ms. A
MutationObserver attached for that frame showed the preview content being
replaced: with one file selected `PreviewPane` loaded it (IPC, decode, preview
re-layout), and the next frame's second file cleared it again. Every drag
that starts on the background passes through a one-file selection, so every
drag with the preview dock open hitched at its start.

**Fix:** the selection still updates every frame (the highlight and status
count stay live), but content-loading consumers read the *settled*
selection. `FileList` holds `explorer.beginSelectionGesture()` while the
marquee drags; `getSettledSelectedEntries()` returns the pre-drag selection
until the gesture ends, and `PreviewPane`/`PluginInspector` read it, so a drag
loads at most one preview, after release. The worst frame in the same
5,000-file probe fell to 98–129ms (frames that repaint many rows, below).
While dragging, `.content.marquee-active` also sets `pointer-events: none` on
entries: the real pointer stops hit-testing rows and drawing hover highlights
on every row it crosses.

**Gotchas:**
- Opening a folder selects its first entry, so the pre-drag preview is rarely
  empty; assert it keeps its pre-drag subject, not that it is blank.
- Synthetic `dispatchEvent` moves (the probe) never set `:hover`; hover and
  hit-test cost only shows with real input (`page.mouse`, WebDriver actions).
- `SvelteSet.has()` subscribes only to a *missing* key's set version, so
  every visible unselected row re-evaluates `isSelected` on every selection
  change. That cost about 2ms per frame here; it is not per-key, whatever the
  `selectedPaths` comment suggests.
- What remains is paint. Under Xvfb (software GL) any changed frame costs
  ~25ms, and repainting rows costs much more in List/Details: hiding the
  icons' CSS `drop-shadow` filters halved the p95 frame (80–120ms → 40–60ms)
  in a 5,000-file List view. That is the next lever if drags in large
  non-image folders still trail the pointer.
