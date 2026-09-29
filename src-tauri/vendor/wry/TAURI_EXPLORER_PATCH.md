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
