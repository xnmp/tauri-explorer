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

The new Mac2 production harness uses only native accessibility actions and actual full-display screenshots. CoreGraphics measures physical-pixel/point calibration; a read-only Pillow oracle measures known PDF landmarks, with twelve negative-control tests. Its assertions cover fitted page size and centering, exact 130%/400% magnification plus pixel enlargement, trusted panning, mixed-size page navigation, fullscreen, a restored/resized owned window at app150% in all three docks, displayed corrupt-file errors without old page pixels, substantive 3:2 image replacement, and unchanged PDF bytes. Independent review corrected driver typing, resize admission, weak pixel oracles and page-readiness synchronization before publication. This harness is prepared for hosted execution; it is **not yet a macOS acceptance pass**. It covers sequential replacement and does not independently measure production worker cleanup.

## Windows native PDF outcomes

[Hosted run 36994174992](https://github.com/xnmp/tauri-explorer/actions/runs/36994174992) passed all **nine distinct PDF cases** against actual filesystem bytes in WebView2. The per-case runner outcomes and cleanup receipt identify checkout `c18bb30932015a4737745cc480351bcee0957c84`, the GitHub merge checkout for PR head `f47050901d7095a5e17b31f589bae93e11c073a1`. [Windows receipts](pdf-preview-2026-10-02/windows/) retain geometry, module-worker startup/termination, source preservation and each case's result. The workflow recorded a successful native build; it did not record a binary hash, so none is claimed.

The cases cover centered 130% zoom, trusted hand panning, pointer wheel anchors, fit and fullscreen at app zoom 100%/150%, all three mixed-size pages and internal navigation, initially hidden corners and keyboard navigation, resized top/bottom/right docks, image replacement, corrupt-file errors, and departed worker/font cleanup. Native wheel delivery is a DOM event; device wheel input remains covered by browser Playwright. External-handler and compositor-blur cases are Linux-only.

All 15 hosted screenshots were inspected individually. Their `native-windows` suffix distinguishes them from private Linux captures; measured Windows device pixel ratio was 1. Representative originals are also copied into `evidence/pdf-preview/`.

The **full Windows smoke suite failed** in the separate preview-resize test when its expected 150% app zoom was not reached. Its starting/final zoom was not captured in that Windows failure. Source ordering and an independent private Linux native reproduction support the inference that the test started from the PDF suite's persisted 150% instead of its assumed 100%: the unchanged test passes from 100%, fails after 150% with the same error and five trusted increments reaching 200%, and passes after the actual Reset Zoom command restores 100%. The exact modified spec also passes after starting at 150%, with every original outcome assertion retained; [the baseline diagnosis](pdf-preview-2026-10-02/windows/preview-resize-baseline.json) records source, binary and spec identities. Passing PDF cases are not a claim that the full required gate passed; hosted verification of the setup correction and production Mac PDF qualification are still pending.

## macOS accessibility discovery diagnostics

[Hosted run 36999439313](https://github.com/xnmp/tauri-explorer/actions/runs/36999439313) successfully built production checkout `34eaa94476d00f9e4d8ca70746359b898b074cec` (the merge checkout for PR head `89fd57848ed6948f583906952a432c029c530406`). Its actual bundled binary SHA-256 is `7a4d643838e663203d73741165a438376b19899c624fa906b927918a4df5c611`. Preparing the PDF fixtures before launch corrected the earlier missing listing: the navigation screenshot and XML both expose all five entries before PDF qualification begins.

The run then failed before PDF selection. After the actual Reset Zoom palette command, the screenshot still shows all five entries and the status still reports five items, but the XML snapshot contains only the selected child row. The PDF filename's XPath lookup consequently fails. This is an accessibility discovery failure; it does not establish a PDF rendering failure or a Mac acceptance pass. Independent inspection counted five rows before the palette and one afterward, and found no application-assigned persistent `inert` state.

The harness compares XML/XPath with native XCTest predicates and debug descriptions before opening the palette, while it is open, before clicking its selected result, and after closure. It retains screenshots, row/cell counts, table-scoped filename queries, focused-element attributes and query errors. Exact text selection uses the [documented native predicate strategy](https://appium.github.io/appium-mac2-driver/v4/reference/locator-strategies/) rather than serialized XML. All production pixel, geometry and source-preservation assertions remain required.

[Hosted run 37001395991](https://github.com/xnmp/tauri-explorer/actions/runs/37001395991) reached the actual PDF viewport after selecting its filename. Its production checkout is `944349c5d0e891e6588a161ffc4b7ad8cb921a18` and bundled binary SHA-256 is `03c592a32a558ea80da20fcf5f21229421b7d1533be4b429c91b761652287f71`. The post-palette probe finds the PDF by both native predicate and XPath, with all five rows exposed again. This does not isolate which diagnostic query or timing changed accessibility exposure, but it refutes a persistent missing listing in this run.

Pixel qualification then failed because the harness treated `macos: screenshots` as an array. The actual pinned4.2.0 response is a dictionary keyed by display ID, confirmed in the retained driver log and [the pinned upstream implementation](https://github.com/appium/appium-mac2-driver/blob/v4.2.0/WebDriverAgentMac/WebDriverAgentLib/Commands/FBScreenshotCommands.m). The harness now selects the measured ID from that dictionary and requires matching identity, main-display status and a nonempty payload before the unchanged calibrated pixel oracle. The full Mac outcome remains pending. [Native run37001395978](https://github.com/xnmp/tauri-explorer/actions/runs/37001395978) passed both Linux and Windows smoke jobs, including hosted verification of the preview-resize baseline correction.

## Partial production macOS pixel outcomes

[Hosted run37044383860](https://github.com/xnmp/tauri-explorer/actions/runs/37044383860)
verified eleven actual pixel outcomes: centered fit and130% document zoom,
mixed-size page navigation/return,400% native dragging, reset, fullscreen and
exit. Production checkout `74e6d223853759e0d25e036e0eb4e65234fe95f5` built
binary SHA-256 `56a62fa1c509db91a7bcee7ed0350dc05a1bcee86bdac49697c0fce2b4ea6110`.
[Reports and exact provenance](pdf-preview-2026-10-02/macos/) and eleven
unedited screenshots under the branch's `macos/` directory retain this partial
evidence.

The owned window was successfully resized. The subsequent app-zoom measurement
failed because NavigationBar's400px container rule hides its Up button in the
narrow pane. The corrected harness measures the fixture's fixed30px New Tab
control under normal root CSS zoom, preserving the100→150 and110→150 width
ratios and adding a height ratio. All PDF pixel/dock/error/replacement/source
assertions remain required.

This run did not reach150% app-zoom/dock outcomes, error/image replacement or
the final unchanged-source assertion. The recorded initial fixture hash is not
final source-preservation proof. The overall run and #730 platform acceptance
remain incomplete.

## Fractional native screenshot measurement

[Mac run37046617534](https://github.com/xnmp/tauri-explorer/actions/runs/37046617534)
confirmed the fixture's100→150% app zoom, then stopped at the narrow right dock.
Its fitted70-point square was about5.86 native pixels wide: strict-color matching
found only12 fully covered pixels in a4×3 box, while its antialiased footprint
remained centered with the expected size. This was a measurement failure; it
does not count as a complete native pass.

The oracle retains the16 strict-pixel minimum,85% solid-box density, full-display
and ICC calibration, and existing2-pixel fit/3-point center tolerances. It now
recovers edge coverage using the known fixture color on a white page and the
[standard source-over formula](https://www.w3.org/TR/compositing-1/#simplealphacompositing).
Only the connected footprint within two pixels of the verified solid box
contributes. Global horizontal and vertical boundary extents measure width and height separately;
verified solid pixels retain full coverage and interior gaps do not shrink a
wrong rectangular shape. Only outside boundary pixels receive fractional
correction. Their midpoint measures position. Negative controls cover fractional edges at1×/2×, all three
fixture colors, nonzero display origins, wrong size/aspect, tolerated solid tint, interior gaps, sheared landmarks, disconnected tinted
noise, gray pixels, and insufficient solid presence in addition to the existing
wrong-page, blank, crop, viewport, and scattered-color controls.

The native resize still reduces width by200 and height by60 points and requires
more than100/50 points of actual reduction. The604-point test window provides
enough fully covered pixels at150% zoom for the unchanged presence gate. This
test-only change does not enlarge a production minimum window size or alter
PDF rendering. [Offline regression](pdf-preview-2026-10-02/macos-oracle-regression.json) passes
all eleven previous native captures and eighteen WebKit proxy captures using
the unchanged fit, center, magnification and pan constraints. Independent
adversarial review also checks24 RGB tolerance corner cases and confirms the
three reproduced tint/gap/shear errors are fixed. These are oracle regressions,
not a fresh native Mac acceptance pass. Fresh native qualification is required
before platform acceptance.

## Combined current-dev qualification

Application source at local merge `1ece9560c1c72fc391e8a1d29d152359806d1737`
is byte-identical under `src/` and `src-tauri/` to rehearsal
`0b09afccc48a5f436231d567c503e65a92480215`. That combined build includes
#681, #820, #822 and the PDF changes on current dev. All1323 browser outcomes
pass across Details/List/Tiles. The unit run passes3183 unique tests after
rerunning sandbox-denied socket tests with network permission;3 existing cases
remain skipped. Fresh native Linux smoke passes139 executed outcomes in53spec
files;91 feature/profile cases are intentionally skipped. Four separate
installed-GTK OpenWith outcomes also pass. This ordinary Xvfb profile does not
execute the separate software-Sway PDF profile or qualify macOS.

The fresh no-hooks production bundle passes main/startup limits at92706 and
223801 bytes gzip, with no test-support chunk or E2E marker. Native binary
SHA256 is `600153b76044babcbcf90e3e125f487a6cd6beb92364e8746339de7b6e474074`.
The task's actual final-dev all-view run remains due after video issue #970.

The separate current-dev software-Sway PDF run now passes all **11 outcomes in
53 seconds**, including actual packaged module-worker startup, zoom/pan at
100% and 150% app zoom, mixed page sizes, links, resized docks, native blur,
errors and departed-worker cleanup. Its rebuilt custom-protocol binary is
`6252574db7d01540c94cb9c8e5e04f0d9182ce7f2081728e9abe9578eee1270a`.
[Qualification, build and cleanup receipts](pdf-preview-2026-10-02/linux-current-dev/)
record the exact combined source, unchanged harness identities, private
display/D-Bus/XDG admission and zero surviving owned processes or ports.
Sixteen fresh, unedited native captures replace the earlier Linux captures;
representative copies remain in `evidence/pdf-preview/`.

The fresh Mac run at PR head `5c4fa28471e96dcb22a15303d1987e35fa43380f`
([37050480381](https://github.com/xnmp/tauri-explorer/actions/runs/37050480381))
failed **before PDF selection**, so it does not qualify the corrected pixel
oracle. After the command palette closed, native predicate and XPath discovery
both omitted the PDF filename. The failure screenshot still shows all five
fixture rows, while XCTest's native description and serialized accessibility
tree expose only the selected `child` row. This distinguishes the failure from
a blank or incorrectly rendered PDF without establishing whether the omission
belongs to WebKit accessibility or XCTest's projection. The harness now owns
file-list focus and uses Control+Home and individually acknowledged Down keys
to select the exact requested filename. It retains every pixel, geometry,
error, replacement and source-preservation assertion; fresh hosted execution
is still required.

## Acceptance coverage follow-up

An independent audit found that the previous rendering fixture was exclusively
multipage, and the full browser suite did not expand the PDF spec to List/Tiles.
A real, separately authored single-page PDF now qualifies rendered pixels,
`1 / 1`, disabled page boundaries, centered fit, enlargement, fullscreen/exit,
fit reset and unchanged bytes. All **12 native Linux PDF outcomes pass in
56.7 seconds** on the unchanged current-dev binary `6252574d`. The exact updated
spec hash is `92eaf7d550440210730294968740867b2546b78683cfe78f59646cf36d9c246c`;
[receipts](pdf-preview-2026-10-02/linux-single-page/) identify the test-only copy,
fixture, application build and clean private process teardown. The original
eleven cases remain intact. The single-page screenshot is an inspected,
unedited capture from that run.

Three unconditional browser cases additionally select distinct PDFs in actual
Details, List and Tiles, acknowledge the first pending read, assert visible
`Loading PDF…`, then render the current single-page file before releasing the
old multipage response. The two documents have distinct center colors; current
red pixels, page count, file path and centered zoom remain correct after the
old response completes. Cancellation before bytes arrive prevents the old
worker from starting; separate loaded-document cases verify termination.
All **22 focused Chromium outcomes pass in 33.8 seconds**, and these three new
cases pass in the WebKit proxy in 11.4 seconds. Initial test-only failures
incorrectly required creation of the cancelled old worker; independent review
corrected that oracle before the final passes. Proxy rendering is not native
Mac qualification.

## Native dock boundary correction

[Mac run 37054032684](https://github.com/xnmp/tauri-explorer/actions/runs/37054032684)
successfully selects the PDF through acknowledged native keys. It passes the
previous eleven production pixel outcomes, actual 150% application zoom,
window resize, narrow-right fit and all six visible controls. It then fails
the test's right-dock midpoint assertion, before top/bottom and replacement
qualification. [Actual reports and failure geometry](pdf-preview-2026-10-02/macos-2c56/)
retain this partial result; it is not a full Mac pass.

The visible listing spans x360–385 and the preview x385–804. The native resize
splitter marks x385, while the inner Explorer pane reports width360 because
its 240-CSS-pixel minimum is intentionally scrolled inside a clipped outer
container at app150%. The old midpoint x540 therefore does not identify the
listing/preview boundary. Independent source and screenshot review confirms
this is a test measurement error. The native harness now checks the unique
displayed resize splitter: vertical boundary and alignment for right;
horizontal extent, boundary alignment and listing order for top/bottom. The
top handle overlays the last six native pixels, so its bottom edge is the
correct boundary. Sixteen imported-helper controls cover the actual failed
geometry, cross-dock misclassification, disconnected rectangles, clipping and
invalid coordinates. Pixel, fit, control visibility, page, replacement and
source assertions remain intact. Fresh hosted execution is still required.

## Screenshot captions

Actual captures live under `screenshots/fix/728-zooming-in-pdf-in-preview-isnt-centred/`; representative unchanged copies are in `evidence/pdf-preview/`. Linux captures use the light theme on the private output at 125%; Windows captures use the light theme on the disposable hosted display at device pixel ratio 1. Filename suffixes specify app zoom; unspecified screenshots use 150% app zoom. The Windows screenshots demonstrate the same corresponding outcomes described below.

- `pdf-fit-native-125-output-100-app.png`: whole first page at centered fit, both corner landmarks visible.
- `pdf-130-native-125-output-150-app.png`: centered130% document zoom with Explorer's compact controls; deliberate enlargement clips page edges equally.
- `pdf-active-pan-native-125-output-150-app.png`:400% while the primary pointer is held. Native geometry receipts separately assert the actual computed cursor is`grabbing`; the screenshot alone does not establish pointer-following motion.
- `pdf-panned-pane-native-125-output-150-app.png` and `pdf-panned-fullscreen-native-125-output-150-app.png`:460% after pan and pointer-anchored wheel zoom.
- `pdf-corner-before-native-125-output-150-app.png`, `pdf-corner-top-left-native-125-output-150-app.png`, `pdf-corner-bottom-right-native-125-output-150-app.png`:same400% page before/after reverse panning; initially hidden green/blue landmarks become visible.
- `pdf-reset-after-pan-native-125-output-150-app.png`:same page/app scale reset to centered fit after corner panning.
- `pdf-page-2-native-125-output-150-app.png`:landscape second page, purple center, compact2/3 navigation.
- `pdf-single-page-native-125-output-150-app.png`:real one-page document at fit, both page-boundary arrows disabled, centered red content and visible corner landmarks.
- `pdf-narrow-{top,bottom,right}-native-125-output-150-app.png`:actual resized native window, each dock retaining centered full-page fit and usable controls.
- `image-comparison-native-125-output-150-app.png`:matched SVG landmarks in the same pane/theme/app scale as PDF fit, showing Explorer-owned framing.
- `pdf-error-native-125-output-150-app.png`:actual malformed filesystem PDF produces a pane error with no stale page.
- `pdf-external-link-native-owned-handler.png`:actual private URI-handler window displays the exact link; remote-page loading is not claimed.

Still images demonstrate visible content and layout. Committed geometry receipts and runtime native WebDriver traces establish pointer motion, release, active cursor, page navigation and focus-loss outcomes.
