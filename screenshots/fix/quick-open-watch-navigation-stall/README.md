# Native navigation acceptance — issue #1007

The prepared base already includes #1028's recursive-worker isolation. The
before capture therefore uses a temporary regression mutation: retain the direct
watcher mutex across an uncancellable recursive-registration wait, restoring the
reported pre-isolation dependency. The final source was restored byte-for-byte
before the corrected run. This is a controlled mechanism reproduction, not a
claim that the prepared base still had that lock dependency.

Both runs use the real Tauri binary, an isolated Xvfb/Openbox display, isolated
D-Bus/XDG profiles, and the same synthetic tree: 4,096 branches each containing
a nested directory and a file (8,192 directories). The existing hook-build gate
holds native recursive registration until the test releases it, bounded at 20
seconds. App, driver, and window manager display/profile inheritance was checked;
Wayland was unset. No browser mock supplies directory entries or timings.

| Criterion | Evidence | Result |
| --- | --- | --- |
| Original prolonged Loading during recursive registration | `original-loading-state.png`, `measurements.json` | Navigation timed out at 15 seconds before gate release. The live native trace attributed 15,093 ms to `watch-lock`, with no entries scanned. The eventual post-observation listing took 270.541 microseconds. |
| Prompt unrelated navigation while recursive registration stays blocked | `navigation-during-recursive-registration.png`, `native-result.json` | Destination entry visible after 150 ms; the gate was still blocked and unreleased. Native test passed. |
| Separate observation wait from listing and recursive work | `measurements.json` | Corrected post-observation listing: 204.006 microseconds. Cancelled search stopped waiting after 60 ms; recursive registration, including the explicitly held gate, returned after 2,588 ms and skipped the cancelled root before native installation. |

The images are also committed under `evidence/1007-*.png` for PR review. Both
are below 700 KB. Screenshots illustrate the navigation criterion; deterministic
Rust tests prove cancellation cleanup, MaxFilesWatch failure/backoff/recovery,
lease compatibility, cache epochs and overlapping-root behavior.

Build with `VITE_E2E_HOOKS=1 VITE_E2E_NO_WARM_PRIME=1 bun run tauri build --debug
--no-bundle --features e2e-hooks`. On a private display/profile, set
`TAURI_EXPLORER_E2E_SEARCH_WATCH_GATE` to a fresh private gate path and run
`bun run test:e2e:tauri --spec e2e-tauri/specs/search-watch-isolation.spec.ts`.
The before mutation deliberately fails the unchanged navigation outcome test;
the fixed binary passes. The normal build omits the gate feature.
