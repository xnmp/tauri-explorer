# #970 native video acceptance

Actual Tauri binary on Linux, WebKitGTK 2.52.5, private Xvfb/Openbox/D-Bus/XDG profile. Test data are synthetic encoded videos; every PNG is an unedited application capture. Qualified production source: `b51f40fb20d6b451c433bf39e4d6ea4489ab09e3`. Binary SHA-256: `58843d2c7f6bd5e36bce0326afc8c2c6bb4e0b84ce67880e9a9ffc4afa7ba80e`.

The six native cases passed: explicit controls and decoded red/blue seeking; right/top/bottom docks at 150%; selection/hide capability revocation and file-handle cleanup; changed-file revision replacement; large-file playback/performance; invalid-container error and release. Fullscreen control centers are tested for actual hit targets, beyond viewport bounds. `suite-cleanup.json`, `unload.json`, `revision.json`, `native-fullscreen-controls.json` and `csp.json` retain actual outcomes.

Three durable lifecycle cases also passed against the unchanged binary: actual List/Tiles decoded red-to-blue seeking and source revocation; unsupported-source cleanup; Ctrl+N activation of the parked window at the requested path followed by native destruction of its playing owner. Closing the child has no frontend release call: backend window retirement independently invalidates its capability (HTTP 404) and drains all source handles/counters. Hidden parked windows admit no video lease before activation. The corresponding outcomes and `lifecycle-source-identities.json` retain the exact verified test/helper hashes.

## Large-file measurement

The fixture contains 1,265,205,529 allocated bytes of encoded VP8/WebM, 960 × 540 at 12 fps, duration 348 seconds. It has no sparse padding. The standard native decoder uses exact HTTP 200/206 responses, 64 KiB positioned reads, and a shared per-capability 1 MiB burst / 16 MiB/s transfer budget. Cancellation consumes no unadmitted bandwidth.

| Outcome | Measured |
| --- | ---: |
| Selection to metadata | 244 ms |
| Distant seek to decoded frame | 513 ms |
| 10.5 seconds of continuous media advancement | 10,557 ms wall time |
| Paused observation | 30 seconds, 31 unchanged samples |
| Total native bytes read across the complete probe | 87,232,038 (6.895% of file) |
| Largest read chunk | 65,536 bytes |
| Peak combined app + all owned WebKit RSS increase | 169,168,896 bytes (161.33 MiB) |
| Retired resources | 0 leases, open workers, streams, connections and source handles |

`large-file-performance.json` contains all 216 RSS observations over 43.3 seconds, stable process identities, raw accepted response headers/timestamps, actual buffered intervals, media state, read counters and cleanup. Playback reported only `playing`, with no `waiting`, `stalled` or media-error events. Reads and current time remain unchanged throughout the paused soak.

Independent verification recomputed every per-process total and the peak. The earlier unpaced probe exceeded the unchanged 256 MiB increase budget: 329,023,488 bytes (313.78 MiB), retained in `unpaced-memory-failure.json`. The paced observation is longer and includes sustained playback and a paused soak.

This is incremental RSS, not absolute application memory: the debug-build baseline was 1,599,533,056 bytes including both foreground and parked WebKit processes. Results qualify this encoded fixture on Linux. Codec support follows each platform; audible output, every codec and native macOS/Windows decoding are not claimed. The transfer policy limits very high sustained bitrates; it is not a universal decoder-memory bound. Browser-reported buffered intervals do not establish resident-byte counts.

## Capture captions

- `native-seek-blue.png`: Details/right dock, 100%, actual VP8 seek to the blue frame at 0:04 / 0:06.
- `native-fullscreen-blue.png`: the decoded blue frame and usable fullscreen controls, with hit-test assertions.
- `native-dock-right-150.png`: the actual player and controls at 150% app zoom.
- `native-invalid-container.png`: actual unsupported-format error, external-open option and disabled playback controls.
- `native-large-continuous-playback.png`: the actual large-file decoder during sustained playback. Timings, state and resource measurements accompany the pixels.
- `native-list-seek-blue.png`, `native-tiles-seek-blue.png`: actual native seek outcomes through List and Tiles selection.
- `native-activated-warm-seek-blue.png`: actual decoded seek after activation of the preloaded native window.

The complete issue screenshots, including paused red, all three docks, initial large-file decoding and distant seek, live in `screenshots/feat/970-ability-to-watch-videos-in-the-preview-pane/`. `capture-identities.json` records their SHA-256 identities.

## Automated checks

- 337 unit files: 3,212 passed, 3 intentionally skipped; 29 serial frontend performance contracts passed separately.
- 23 Rust media contracts passed, including real TCP ranges, independent positioned cursors, scope/identity rejection, stalled-client retirement, bounded admission, shared byte pacing and 1,024 cancelled waiting ranges.
- Strict Rust Clippy passed for all targets with qualification hooks enabled. Svelte checking reports zero errors/warnings; architecture and code-map validation pass.
- 15 final Chromium and 15 private-display WebKitGTK player outcomes passed, covering all three views, all docks, narrow/150% layouts, decoded seeking, fullscreen hit targets, terminal overlap, modal ownership, error/revision cleanup, late admission and thumbnail independence.
- Release bundle check passed: main gzip 92,839 bytes; startup graph gzip 225,031 bytes. No qualification module or E2E marker appears in any of the 90 emitted scripts.

Actual Windows/macOS decoding is outside these Linux receipts. Their normal builds and platform tests are tracked by the PR's hosted checks.
