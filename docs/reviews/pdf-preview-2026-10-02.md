# PDF preview acceptance: #728, #729 and #730

The platform iframe is replaced by a lazy, read-only PDF.js canvas surface. Explorer owns centered fit/zoom, measured pointer coordinates, bounded hand panning, annotation links, page controls and fullscreen behavior. A real three-page PDF supplies portrait/landscape geometry, green/blue corner landmarks and red/purple/orange page centers. The same bytes are used in browser and native verification; the native reader loads an actual filesystem file.

## Reproduce

Build with hooks and run on a private software Wayland compositor:

```sh
VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle --features e2e-hooks
TAURI_NATIVE_PRIVATE_CONFIG=e2e-tauri/wdio.pdf-preview.conf.ts python3 e2e-tauri/run-scaled-selection.py
```

The runner needs Sway/swaymsg, grim, wtype, Python GTK3 and the native driver prerequisites. `TAURI_NATIVE_SWAY` / `TAURI_NATIVE_SWAYMSG` select explicit compositor tool paths. The Linux PDF spec requires the private runner and verifies the actual app and URI-handler environments; no host desktop, clipboard or browser is used. Ports default to owned 4520/4521 and fail closed if occupied. `TAURI_NATIVE_SELECTION_ARTIFACT_DIR` selects the runtime receipt directory, and `TAURI_NATIVE_PDF_GREP` selects scenarios. Windows uses the same actual-file suite only on disposable GitHub-hosted runners, with native WebView2 screenshots; platform-specific external-handler and compositor-blur cases remain Linux-only.

For browser verification, run `WEBKIT=1 bunx playwright test e2e/pdf-preview.spec.ts`. Domain/store/API regressions are in `tests/domain/pdf-preview.test.ts`, `tests/state/pdf-preview.test.ts` and `tests/api/pdf-preview.test.ts`.

## Outcomes and limits

The final native run passed **11/11** against WebKitGTK 2.52.5 / Wry 0.55.1 on the private 125% scaled Wayland output, including the final readiness cancellation guard. Fit/130% center, exact 60px/50px pan and pointer wheel anchors were asserted at 100%/150% application zoom in pane and fullscreen. Native wheel delivery is a DOM WheelEvent; browser Playwright additionally sends device wheel input.

Further native assertions reach both initially hidden corners by native WebDriver reverse drags, reset at the same 150% app zoom, navigate all three actual page colors with page controls and keyboard, resize/dock top/bottom/right, and end a held pan on real document focus loss. The source SHA-256 remains unchanged. A dragged external link launches nothing; an ordinary zoomed click sends the exact URI to a disposable installed GTK handler, which displays it without fetching it. Source preservation, geometry, corner/keyboard and blur receipts are committed in [the receipt directory](pdf-preview-2026-10-02/).

Worker startup records actual packaged module-worker readiness. Departed documents must acknowledge termination and leave no PDF FontFaces. Browser regressions additionally cover stale binary/page/render responses, visible rejected-link errors, pointer cancellation, modal keyboard ownership and repeated open/close cleanup. A fullscreen coordinate regression failed before its correction (60px became 40px at app150); readiness-turn cancellation also failed before its guard. Independent review reproduced destination ordering, captured-link activation and font cleanup faults, then confirmed their corrections and inspected all 16 native screenshots.

The final PDF browser suite passes 38 outcomes across Chromium and WebKit. Neighboring image/fullscreen/preview-lifetime verification previously passed in the 52-case combined suite. The final unit suite passes 2,999 tests with 3 existing skips, plus 29 performance tests. Type checking reports 0 errors/warnings; native test TypeScript, Rust formatting/all-target clippy and 548/548 source-map coverage pass. The final no-hooks production build passes startup/main bundle budgets and contains no test-support/e2e marker; main gzip 91,443 bytes and startup gzip 220,662 bytes remain below their 239,791/277,378-byte limits.

**Windows native PDF scenarios pass; macOS qualification remains pending.** Browser WebKit is a useful rendering proxy, not native Mac qualification. #730's supported-platform acceptance stays unchecked until the Mac run and remaining native gate are resolved. The Linux display scale is an owned software compositor output, not a physical monitor.

## Rebase qualification and supported-platform work

After rebasing onto dev `abb4e8fbeadcd1845d58c9bf07be2dc436cf7688f`, application source `909e0a0265a54633ba9233aea139764da832e6b3` passed the unchanged 19 Chromium and 19 WebKit PDF outcomes. The local Chromium font service initially aborted with `EDQUOT` while allocating shared memory through `/tmp`; a temporary local Playwright config removed `--disable-dev-shm-usage` to use the available `/dev/shm`. All 19 tests then passed without application or committed browser-test changes. CI keeps its normal launch flags.

Fresh private Linux native verification passed **11/11 in 57.8 seconds**. The rebuilt binary SHA-256 is `f5dc9b1194af117f281b4bd8dbb4dbe992ae94bbbdc630a9e1b6f697742b9b07`; [build provenance](pdf-preview-2026-10-02/native-build-rebase.json) identifies the exact application source. Refreshed screenshots were inspected and copied into `evidence/pdf-preview/`, and the receipt directory now includes measured listing/preview bounds and each control's visible geometry. Dock placement is asserted relative to the actual listing container: a tall bottom dock can correctly begin above the window midpoint.

The new Mac2 production harness uses only native accessibility actions and actual full-display screenshots. CoreGraphics measures physical-pixel/point calibration; a read-only Pillow oracle measures known PDF landmarks, with five negative-control tests. Its assertions cover fitted page size and centering, exact 130%/400% magnification plus pixel enlargement, trusted panning, mixed-size page navigation, fullscreen, a restored/resized owned window at app150% in all three docks, displayed corrupt-file errors without old page pixels, substantive 3:2 image replacement, and unchanged PDF bytes. Independent review corrected driver typing, resize admission, weak pixel oracles and page-readiness synchronization before publication. This harness is prepared for hosted execution; it is **not yet a macOS acceptance pass**. It covers sequential replacement and does not independently measure production worker cleanup.

## Windows native PDF outcomes

[Hosted run 36994174992](https://github.com/xnmp/tauri-explorer/actions/runs/36994174992) passed all **nine distinct PDF cases** against actual filesystem bytes in WebView2. The per-case runner outcomes and cleanup receipt identify checkout `c18bb30932015a4737745cc480351bcee0957c84`, the GitHub merge checkout for PR head `f47050901d7095a5e17b31f589bae93e11c073a1`. [Windows receipts](pdf-preview-2026-10-02/windows/) retain geometry, module-worker startup/termination, source preservation and each case's result. The workflow recorded a successful native build; it did not record a binary hash, so none is claimed.

The cases cover centered 130% zoom, trusted hand panning, pointer wheel anchors, fit and fullscreen at app zoom 100%/150%, all three mixed-size pages and internal navigation, initially hidden corners and keyboard navigation, resized top/bottom/right docks, image replacement, corrupt-file errors, and departed worker/font cleanup. Native wheel delivery is a DOM event; device wheel input remains covered by browser Playwright. External-handler and compositor-blur cases are Linux-only.

All 15 hosted screenshots were inspected individually. Their `native-windows` suffix distinguishes them from private Linux captures; measured Windows device pixel ratio was 1. Representative originals are also copied into `evidence/pdf-preview/`.

The **full Windows smoke suite failed** in the separate preview-resize test when its expected 150% app zoom was not reached. Its starting/final zoom was not captured in that Windows failure. Source ordering and an independent private Linux native reproduction support the inference that the test started from the PDF suite's persisted 150% instead of its assumed 100%: the unchanged test passes from 100%, fails after 150% with the same error and five trusted increments reaching 200%, and passes after the actual Reset Zoom command restores 100%. The exact modified spec also passes after starting at 150%, with every original outcome assertion retained; [the baseline diagnosis](pdf-preview-2026-10-02/windows/preview-resize-baseline.json) records source, binary and spec identities. Passing PDF cases are not a claim that the full required gate passed; hosted verification of the setup correction and production Mac PDF qualification are still pending.

## Screenshot captions

Actual captures live under `screenshots/fix/728-zooming-in-pdf-in-preview-isnt-centred/`; representative unchanged copies are in `evidence/pdf-preview/`. Linux captures use the light theme on the private output at 125%; Windows captures use the light theme on the disposable hosted display at device pixel ratio 1. Filename suffixes specify app zoom; unspecified screenshots use 150% app zoom. The Windows screenshots demonstrate the same corresponding outcomes described below.

- `pdf-fit-native-125-output-100-app.png`: whole first page at centered fit, both corner landmarks visible.
- `pdf-130-native-125-output-150-app.png`: centered130% document zoom with Explorer's compact controls; deliberate enlargement clips page edges equally.
- `pdf-active-pan-native-125-output-150-app.png`:400% while the primary pointer is held. Native geometry receipts separately assert the actual computed cursor is`grabbing`; the screenshot alone does not establish pointer-following motion.
- `pdf-panned-pane-native-125-output-150-app.png` and `pdf-panned-fullscreen-native-125-output-150-app.png`:460% after pan and pointer-anchored wheel zoom.
- `pdf-corner-before-native-125-output-150-app.png`, `pdf-corner-top-left-native-125-output-150-app.png`, `pdf-corner-bottom-right-native-125-output-150-app.png`:same400% page before/after reverse panning; initially hidden green/blue landmarks become visible.
- `pdf-reset-after-pan-native-125-output-150-app.png`:same page/app scale reset to centered fit after corner panning.
- `pdf-page-2-native-125-output-150-app.png`:landscape second page, purple center, compact2/3 navigation.
- `pdf-narrow-{top,bottom,right}-native-125-output-150-app.png`:actual resized native window, each dock retaining centered full-page fit and usable controls.
- `image-comparison-native-125-output-150-app.png`:matched SVG landmarks in the same pane/theme/app scale as PDF fit, showing Explorer-owned framing.
- `pdf-error-native-125-output-150-app.png`:actual malformed filesystem PDF produces a pane error with no stale page.
- `pdf-external-link-native-owned-handler.png`:actual private URI-handler window displays the exact link; remote-page loading is not claimed.

Still images demonstrate visible content and layout. Committed geometry receipts and runtime native WebDriver traces establish pointer motion, release, active cursor, page navigation and focus-loss outcomes.
