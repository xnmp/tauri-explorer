# Local Wry 0.55.1 patch

This directory is the published `wry` 0.55.1 crate, selected through
`src-tauri/Cargo.toml`'s `[patch.crates-io]`. Its crates.io checksum before the
patch was `186f9871daa55fd9c016578b810d149de58367113db7fb72b462d2323ce19514`.

The sole code change is in `src/webkitgtk/mod.rs`:
`InnerWebView::attach_ipc_handler` captures a `glib::WeakRef<WebView>` rather
than a strong `WebView`. A WebView owns its `UserContentManager`, so the old
manager signal closure's strong capture kept both GObjects alive after native
window destruction. On Linux the app retained one `WebKitSharedMemory`
descriptor per closed child window; its main renderer disappeared after the
399th close in the qualification fixture.

Remove the local patch after an upstream Wry release includes the equivalent
fix and a native Linux window-churn run confirms bounded descriptors and a
responsive main renderer beyond 399 child closes.

## Guard

`src-tauri/tests/vendored_wry_patch.rs` fails when `Cargo.lock` resolves `wry`
from a registry (Cargo only warns that an unused patch "was not used"), when
the locked version differs from this directory, or when the weak capture is
missing from `attach_ipc_handler` (#864).

## Tauri upgrade procedure

`tauri-runtime-wry` pins a Wry minor version (2.11.x → 0.55, 2.12.0 → 0.57).
When a Tauri upgrade requires a newer Wry:

1. Check whether that upstream release already captures the WebView weakly in
   `attach_ipc_handler`. If so, delete this directory and the
   `[patch.crates-io] wry` entry, and drop the guard test.
2. Otherwise replace this directory with the new published crate
   (`cargo download`/registry source), re-apply the `downgrade()`/`upgrade()`
   change, record the new pre-patch checksum above, and run the guard test.
3. Either way, confirm with a native Linux window-churn run beyond 399 child
   closes before release.

## Upstream

As of 2026-09-30 upstream `dev` and the 0.57.0 release still capture a strong
`webview` in `connect_script_message_received`, and no upstream issue or pull
request exists. Record its links here once filed; the reproduction and root
cause are in `docs/lessons/817-linux-webkit-ipc-retention.md`.
