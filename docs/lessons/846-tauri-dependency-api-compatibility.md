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
