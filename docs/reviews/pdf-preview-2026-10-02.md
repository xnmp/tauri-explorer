# PDF preview acceptance: #728, #729 and #730

The platform iframe is replaced by a lazy, read-only PDF.js canvas surface. Explorer owns centered fit/zoom, measured pointer coordinates, bounded hand panning, annotation links, page controls and fullscreen behavior. A real three-page PDF supplies portrait/landscape geometry, green/blue corner landmarks and red/purple/orange page centers. The same bytes are used in browser and native verification; the native reader loads an actual filesystem file.

## Reproduce

Build with hooks and run on a private software Wayland compositor:

```sh
VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle --features e2e-hooks
TAURI_NATIVE_PRIVATE_CONFIG=e2e-tauri/wdio.pdf-preview.conf.ts python3 e2e-tauri/run-scaled-selection.py
```

The runner needs Sway/swaymsg, grim, wtype, Python GTK3 and the native driver prerequisites. `TAURI_NATIVE_SWAY` / `TAURI_NATIVE_SWAYMSG` select explicit compositor tool paths. The PDF spec requires the private runner and verifies the actual app and URI-handler environments; no host desktop, clipboard or browser is used. Ports default to owned 4520/4521 and fail closed if occupied. `TAURI_NATIVE_SELECTION_ARTIFACT_DIR` selects the runtime receipt directory, and `TAURI_NATIVE_PDF_GREP` selects scenarios.

For browser verification, run `WEBKIT=1 bunx playwright test e2e/pdf-preview.spec.ts`. Domain/store/API regressions are in `tests/domain/pdf-preview.test.ts`, `tests/state/pdf-preview.test.ts` and `tests/api/pdf-preview.test.ts`.

## Outcomes and limits

The final native run passed **11/11** against WebKitGTK 2.52.5 / Wry 0.55.1 on the private 125% scaled Wayland output, including the final readiness cancellation guard. Fit/130% center, exact 60px/50px pan and pointer wheel anchors were asserted at 100%/150% application zoom in pane and fullscreen. Native wheel delivery is a DOM WheelEvent; browser Playwright additionally sends device wheel input.

Further native assertions reach both initially hidden corners by native WebDriver reverse drags, reset at the same 150% app zoom, navigate all three actual page colors with page controls and keyboard, resize/dock top/bottom/right, and end a held pan on real document focus loss. The source SHA-256 remains unchanged. A dragged external link launches nothing; an ordinary zoomed click sends the exact URI to a disposable installed GTK handler, which displays it without fetching it. Source preservation, geometry, corner/keyboard and blur receipts are committed in [the receipt directory](pdf-preview-2026-10-02/).

Worker startup records actual packaged module-worker readiness. Departed documents must acknowledge termination and leave no PDF FontFaces. Browser regressions additionally cover stale binary/page/render responses, visible rejected-link errors, pointer cancellation, modal keyboard ownership and repeated open/close cleanup. A fullscreen coordinate regression failed before its correction (60px became 40px at app150); readiness-turn cancellation also failed before its guard. Independent review reproduced destination ordering, captured-link activation and font cleanup faults, then confirmed their corrections and inspected all 16 native screenshots.

The final PDF browser suite passes 38 outcomes across Chromium and WebKit. Neighboring image/fullscreen/preview-lifetime verification previously passed in the 52-case combined suite. The final unit suite passes 2,999 tests with 3 existing skips, plus 29 performance tests. Type checking reports 0 errors/warnings; native test TypeScript, Rust formatting/all-target clippy and 548/548 source-map coverage pass. The final no-hooks production build passes startup/main bundle budgets and contains no test-support/e2e marker; main gzip 91,443 bytes and startup gzip 220,662 bytes remain below their 239,791/277,378-byte limits.

**Native Windows/macOS rendering is unverified.** Browser WebKit is a useful rendering proxy, not native platform qualification. #730's supported-platform acceptance stays unchecked until those runs are available. The display scale is an owned software compositor output, not a physical monitor.

## Screenshot captions

Actual captures live under `screenshots/fix/728-zooming-in-pdf-in-preview-isnt-centred/`; representative unchanged copies are in `evidence/pdf-preview/`. All use the light theme on the private125% output. Filename suffixes specify app zoom; unspecified screenshots use150% app zoom.

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
