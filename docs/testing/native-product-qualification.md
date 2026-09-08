# Native product qualification matrix

This is a bounded, risk-based matrix for release qualification. It deliberately
does not form a full Cartesian product. The executable source of truth is
`NATIVE_QUALIFICATION_MATRIX` in `e2e-tauri/native-qualification.ts`; its contract
test rejects missing risks, duplicate rows, unobservable outcomes, or a browser
case marked as native acceptance.

| Case                     | Platform/backend         | Selected combination                                                                                  | User-visible outcome                                                               | Proof / release status         |
| ------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------ |
| Window + workspace churn | Linux / WebKitGTK        | repeated native windows, alternating real directories, refresh/palette interruptions                  | surviving window shows the requested path and usable file list                     | native WebDriver / required    |
| Window + workspace churn | Windows / WebView2       | repeated native windows, alternating real directories, refresh/palette interruptions                  | surviving window shows the requested path and usable file list                     | native WebDriver / required    |
| Plugin churn             | Linux + Windows          | demo plugin enable → invoke → disable between interruptions                                           | command appears, its success toast renders, then the command disappears            | native WebDriver / required    |
| Theme + accessibility    | Linux + Windows          | keyboard-only palette and first-attempt theme toggle                                                  | labelled listbox remains operable and the rendered theme changes                   | native WebDriver / required    |
| Preview                  | Linux + Windows          | real Markdown and text files across alternating directories                                           | Markdown heading and exact text content appear in the preview                      | native WebDriver / required    |
| DPI + zoom               | Linux + Windows          | required runner display scale (`SOAK_EXPECTED_DISPLAY_SCALE`) at 80%, 100%, and 150% application zoom | explorer and palette stay inside the viewport and usable                           | native WebDriver / required    |
| Native input             | Linux + Windows          | Escape/F5 interruption plus native keyboard selection                                                 | a real file row receives visible selection and shortcuts remain responsive         | native WebDriver / required    |
| Startup timing           | real macOS runner        | 30 embedded-binary cold launches plus `WARM_MEASURE=1` activation samples                             | every process reaches both markers, survives settling, and emits cold/warm p50/p95 | real process logs / required   |
| Expanded combinations    | browser projects         | extra themes, reduced motion, previews, and viewport sizes                                            | selected labels, previews, focus, and containment render                           | browser only / non-native      |
| Recovery adapters        | per implemented platform | added one capability at a time after implementation                                                   | recovery restores a usable explorer                                                | not implemented / not required |

## Run record

Archive the generated JSON together with the built binary identity and WDIO
artifact directory. For Linux and Windows, use the opt-in command documented in
`e2e-tauri/README.md`. The report records reproducible input, the platform and
WebView, asserted display scale, exact binary SHA-256/size/mtime, scenario timing
p50/p95, RSS baseline/final/peak, and failure screenshot paths. Sampling or
early-run failures still produce a failed report with nullable resource fields
and explicit run errors.

Browser Playwright remains useful for broader visual combinations but cannot
qualify native timing, resource, cache, watcher, or race claims. macOS currently
has no supported WebDriver route, so interaction cells stay explicit rather
than being silently reported as passed. The macOS workflow's 30 real-process
samples measure the instrumented setup and warm-show phases; they do not claim
Dock bounce or first-input latency unless a separate real-machine capture
records that seam.

If a qualification run exposes a defect, retain its seed/report/artifacts and
file a bounded bug for that observable failure. Adding a recovery row does not
make an unimplemented recovery feature a release requirement.
