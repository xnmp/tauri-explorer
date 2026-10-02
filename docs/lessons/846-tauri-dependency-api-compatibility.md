# #846: Coordinate Tauri upgrades across package and native APIs

The grouped Rust upgrade resolved Tauri 2.12.0 while the frontend lock still
selected `@tauri-apps/api` 2.11.0. The Tauri CLI rejected every native smoke
build before compilation. Upgrade the frontend API and its lock together
with the native Tauri minor version.

The native build also exposed two source changes: gtk-rs 0.22 moved
`DesktopAppInfo` into the Linux `gio-unix` crate, and Tauri added
`WindowEffectsConfig.interactive`. Preserve the platform effects through
struct defaults rather than exhaustively spelling optional fields.

Tauri 2.12 requires Wry 0.57, so Cargo silently bypassed our Wry 0.55.1
patch. The existing vendored-Wry guard reproduced that failure. Wry 0.57
still strongly captures the owning WebView in its GTK IPC signal callback.
Re-vendor the published 0.57 crate and preserve the weak capture required
by #817; do not remove the patch just because compilation succeeds.
The guard must resolve exactly one path-sourced Wry at the vendored version.

On this host, the initial compiler run hit a `/tmp` quota while compiling
bundled SQLite. A worktree-local `TMPDIR` on the disk filesystem and bounded
compiler jobs avoid that infrastructure failure without changing dependencies.
Real filesystem tests need a separate short canonical disk temporary root outside
Git: nesting their fixtures in the worktree changes repository discovery and
path-budget preconditions. The host tmpfs quota also affects recovery fixtures.

The `clipboard-rs` 0.3.5 macOS reader asks AppKit for `NSURL` objects.
First correct the native fixture to create real files: the upstream external
writer ignores nonexistent paths. The fixture-only control `aa53e39e` still
failed the first ownership assertion on hosted macOS (job `110819003562`).
That established a production failure, but did not isolate its cause.

Publishing ordered `public.file-url` items still failed with real Unicode files.
Combined native diagnostics showed that `NSURL.fileURLWithPath` converted NFC
`é` to NFD `e` plus a combining accent before publication. The private nonce
and stable change count were correct; only the exact original-path read-back
failed. Normalizing that proof alone would remain broken: the coordinator's
next snapshot also compares paths byte-for-byte and would drop Cut ownership.

Use `NSURLComponents` with a file scheme, empty host and the original path to
preserve its spelling through URL publication and `clipboard-rs` read-back.
Foundation supplies the percent encoding; escape literal semicolons in its
`percentEncodedPath` as `%3B` for legacy `NSURL` compatibility, as required by
[Apple's documentation](https://developer.apple.com/documentation/foundation/nsurlcomponents/percentencodedpath).
The locked Tauri configuration defaults to macOS 10.13, so latest-host parsing
alone is insufficient. Keep Unicode and existing percent escapes intact.

Publish one prepared file-URL item per path, with the private nonce as `NSData`
on the first item, in one `writeObjects` batch. Reject empty, relative or
NUL-containing paths before replacing the pasteboard. Keep the existing ordered
original-path/token read-back and stable change-count proof. An external
replacement, even with identical filesystem files, revokes the lease; the
counter does not promise to detect in-place additions to an existing owner.
The hosted ignored fixture covers NFC and NFD, `%#?`, semicolons, a directory,
ordered exact paths, nonce placement, invalid-input preservation, successive
writes and independent external replacement. The external writer itself may
normalize paths, so its read-back is checked against its own native URL wire
and the original files' ordered device/inode identities.

[Retained native proof](../reviews/846-macos-clipboard/README.md) records the
negative controls, constructor experiment and complete five-path positive
probe. Final admission also requires the full application's ignored native
fixture after removing the diagnostic instrumentation.

The Open With feature landed during the dependency merge and added another DesktopAppInfo construction path. Its launcher must also use gio_unix::DesktopAppInfo with GIO 0.22; the old gio namespace fails the actual locked cargo check before the native launch contracts can run.

The final dependency admission also exposed a PDF test setup timeout. On the
unchanged production tree, hosted WebKit job `111050049114` spent 24.3 seconds
on thirty successful Zoom-in clicks; 22.8 seconds were mouse actionability
waits. The pan and wheel-anchor outcomes passed before the final Fit action
ran out of the existing 30-second deadline. A constrained local run reproduced
that deadline exhaustion before setup finished.

Keep normal pointer coverage for the initial Zoom-in action and the complete
130% zoom case. For the 400% pan precondition, activate the focused native
button with Enter after the first click and its 110% assertion. Playwright's
[locator.press](https://playwright.dev/docs/api/class-locator#locator-press)
sends real keyboard input; it does not inject zoom state. Retain the deadline,
400% readiness, pointer pan/cancellation, 460% wheel anchor, Fit geometry and
selected-file assertions. Paired controls cover headless WebKit, private
headed WebKitGTK and Chromium with retries disabled.
