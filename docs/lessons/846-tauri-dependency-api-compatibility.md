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

The `clipboard-rs` 0.3.5 macOS reader now asks AppKit for `NSURL` objects.
Our legacy `NSFilenamesPboardType` property-list writer no longer round-tripped,
so stable change-count plus file/token read-back could not prove Cut ownership.
First correct the fixture to create real files: the upstream external writer
ignores nonexistent paths. The fixture-only control `aa53e39e` still failed the
first ownership assertion on hosted macOS (job `110819003562`), establishing a
production incompatibility rather than a fabricated-path fixture failure.

Publish one prepared `public.file-url` pasteboard item per path, with the private
nonce as `NSData` on the first item, in one `writeObjects` batch after clearing
the pasteboard. Use Foundation URL conversion for Unicode and reserved filename
characters; reject empty, relative or NUL-containing paths before publication.
Keep the existing ordered file/token read-back and stable change-count proof.
An external replacement, even with identical paths, revokes the lease; the
counter does not promise to detect in-place additions to an existing owner.
The ignored hosted native test checks real Unicode and `%#?` files, URL decoding
and item order, nonce placement, invalid-input preservation, successive writes,
and ownership revocation by an independent identical-file writer.

The Open With feature landed during the dependency merge and added another DesktopAppInfo construction path. Its launcher must also use gio_unix::DesktopAppInfo with GIO 0.22; the old gio namespace fails the actual locked cargo check before the native launch contracts can run.
