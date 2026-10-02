# #756 native selection acceptance

## Scope and reproduction

Verify marquee selection against the actual Linux GTK/Wayland WebView and real filesystem listings. The basic coordinate matrix already passed at the current dev base. A separate live-scroll reproduction failed: at 125% compositor scale and 150% application zoom, the visible List band intersected `virtual-048.txt`, `virtual-051.txt` and `virtual-054.txt`, but selected `virtual-039.txt`. Independent verification also reproduced stationary-scroll publication and Details bottom-edge failures before their corrections.

The production fix remeasures live viewport rectangles when scroll/container geometry or virtual row identities/global indices change. The existing virtualizer publishes its coalesced scroll after Svelte settles the new DOM. Details uses an exclusive bottom boundary; all views reject zero-area bands.

## Reproduce

Install Sway/swaymsg, grim, wtype, Python GTK3 and the ordinary native test prerequisites. Build the real debug binary with hooks:

```sh
VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle
python3 e2e-tauri/run-scaled-selection.py
```

Use `TAURI_NATIVE_SWAY` and `TAURI_NATIVE_SWAYMSG` to select explicit tool paths. Optional `TAURI_NATIVE_DRIVER_PORT` / `TAURI_NATIVE_BACKEND_PORT` select distinct unoccupied task ports (runner defaults 4520/4521); ordinary native-suite defaults remain 4444/4445. `TAURI_NATIVE_SELECTION_GREP` selects individual scenarios.

The runner starts a new private software-rendered headless compositor, private D-Bus session, XDG profile and Wayland runtime. It clears inherited host connection aliases. It inspects actual compositor/virtual-keyboard environments; the spec verifies the app's actual private environment and exact owned Sway PID/output. It uses no host desktop, workspace or clipboard. Driver startup fails closed on occupied ports and requires both listeners to belong to the owned driver's process group at the exact IPv4 loopback endpoints. Unknown listeners are preserved.

The virtual keyboard has a populated symbol table but sends no keys: wtype compiles every queued symbol before its leading sleep, and teardown terminates it before the queued seed actions execute. This enables real native focus/blur and WebKitWebDriver key-value/modifier input. Its generated physical keycodes are not a physical US keyboard; acceptance concerns actual key values, modifiers and feature outcomes. Native document focus is asserted before and after cancellation.

## Evidence

Runtime outputs are under `e2e-tauri/logs/scaled-selection/`: compositor and keyboard environment checks, exact geometry matrix, and virtualized stationary/final selection reports. Screenshots are actual grim captures of only the private output `HEADLESS-2` under `screenshots/fix/756-drag-selection-hit-boxes-seem-broken-again-when-zoomed/`.

Each matrix record identifies compositor scale, application zoom, WebKitGTK version, display backend, actual DPR, pointer endpoints, marquee bounds, expected names and selected names. No devicePixelRatio override is used. The same owned application moves between 100% and scaled outputs without restart. Monitor-scale settings refer to private compositor outputs; no physical-monitor check is claimed.

Virtualized scenarios assert exact visible selected names and the full status-bar selection count, so hidden stale selections cannot satisfy acceptance. Details starts on genuine empty background, then real files arrive through the filesystem watcher before scrolling; no row DOM or hit-test state is fabricated.

The final full native run passed 56/56 cases. An additional Details downward-scroll scenario was then added; the focused upward/downward run passed 2/2. The committed suite therefore contains 57 distinct scenarios, with 48 scale/zoom/view/horizontal-direction combinations recorded in [the matrix](756-scaled-selection-matrix.json). The full matrix uses compositor scales 100%, 125%, 150% and 200%, app zoom 100% and 150%, all three views and both horizontal directions. Runtime was Sway 1.12-4, WebKitGTK 2.52.5 and Wry 0.55.1 on Wayland.

Browser verification passed 30 cases across Chromium and WebKit, with two existing WebKit overlay cases intentionally skipped. The final focused domain/driver suite passed 40 tests; the preceding full unit suite passed 2,963 tests with three existing skips, plus 29 performance tests. Type checking and map coverage passed. Before-fix runs independently failed live virtualized selection, stationary-scroll publication, exclusive bottom-edge and listener-ownership contracts.

An independent reviewer confirmed the production changes, private-display isolation, exact endpoint ownership, all 48 matrix records, both native run logs and all eight screenshots. No remaining acceptance blocker was found. Physical monitors were not tested.

### Screenshot captions

All images show actual private compositor output scale 125% and application zoom 150%, using the light theme. Each active/released pair shows neighboring misses alongside the selected files:

- Details: `selection-07.txt` selected.
- List: `selection-06.txt` and `selection-07.txt` selected.
- Tiles: `selection-00.txt` and `selection-01.txt` selected.
- Details virtualized upward scroll: `virtual-022.txt` and `virtual-023.txt` selected, 500 total files, status count exactly two.
- Details virtualized downward scroll: `virtual-023.txt` and `virtual-024.txt` selected, 500 total files, status count exactly two.

The active bands intersect only the selected rows, including partial edges. Still images demonstrate geometry and resulting selection; matrix assertions and native traces establish pointer following, release, mixed-scale movement and cancellation. Images are under the screenshot directory above and duplicated in `evidence/756/` for review.
