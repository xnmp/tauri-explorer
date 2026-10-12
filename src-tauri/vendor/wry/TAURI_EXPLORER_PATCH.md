# Local Wry 0.57.0 patch

This directory is the published `wry` 0.57.0 crate, selected through
`src-tauri/Cargo.toml`'s `[patch.crates-io]`. Its crates.io checksum before the
patch was `a819957a01b3119af85e638a38d242af76dbc87d130dca67bfd0441072e21ff0`.
The published archive records upstream Git revision
`792d0359ba6501a4fc360ece17de2ae42329a47c` in `.cargo_vcs_info.json`.
All files match the published 0.57.0 crate except this provenance document,
the weak-capture and drag snapshot changes below, and one trailing-space cleanup in `SECURITY.md`; the IPC callback retains 0.57.0's fallible
request construction and missing-URI handling.

The IPC ownership change is in `src/webkitgtk/mod.rs`:
`InnerWebView::attach_ipc_handler` captures a `glib::WeakRef<WebView>` rather
than a strong `WebView`. A WebView owns its `UserContentManager`, so the old
manager signal closure's strong capture kept both GObjects alive after native
window destruction. On Linux the app retained one `WebKitSharedMemory`
descriptor per closed child window; its main renderer disappeared after the
399th close in the qualification fixture.

Remove the IPC ownership change after an upstream Wry release includes the equivalent
fix and a native Linux window-churn run confirms bounded descriptors and a
responsive main renderer beyond 399 child closes. The drag snapshot bridge also
needs an upstream replacement before the vendored crate can be removed.

## Drag callback snapshots (TraceExplorer #29)

`drag_drop_snapshot` observes each platform callback before its ordinary Wry
handler queues a Tauri event. It carries the top-level native window identity
and callback-time copy intent from the negotiated action: GDK selected action
(with suggested action fallback before selection), AppKit's modifier-filtered
`draggingSourceOperationMask`, and OLE's effect negotiated from the callback's
`grfKeyState` and supported effects. All three use `drag_drop_intent.rs`, a pure
extractor also compiled by the differential runner. Never query GTK's cached
Keymap or AppKit's global NSEvent modifier cache during a drag grab. The host captures source metadata and keeps
a per-window FIFO; later Tauri delivery must match the original event before
the enriched payload is published. Missing/mismatched snapshots are discarded.
Never replace this with a keyboard query during queued Tauri dispatch: Windows
`DoDragDrop` buffers those events until the drag loop returns.

The bridge lives in `src/lib.rs` and each platform's `drag_drop.rs`. The host
depends directly on the same patched Wry version; keep `Cargo.toml`'s direct
dependency aligned when upgrading. Targeted host regressions are in
`src-tauri/test_support/native_file_drag.rs`.

GTK's deferred Leave uses weak references to the original WebView and top-level
window. Both must remain alive and attached before `dispatch_deferred` admits
the original receiver ID. A raw GTK address can be reused after Destroyed, so a
deferred callback must never look up a replacement receiver by that address.
The host also records native-ID-to-label mappings before queued delivery and
clears all mapped queues/receiver identity by label at Destroyed, when Tauri's
runtime no longer exposes the native handle.

## Guard

`src-tauri/tests/vendored_wry_patch.rs` fails when `Cargo.lock` resolves `wry`
from a registry (Cargo only warns that an unused patch "was not used"), when
the locked version differs from this directory, or when the weak capture is
missing from `attach_ipc_handler` (#864).

## Tauri upgrade procedure

`tauri-runtime-wry` pins a Wry minor version (2.11.x → 0.55, 2.12.0 → 0.57).
When a Tauri upgrade requires a newer Wry:

1. Check whether that upstream release already captures the WebView weakly in
   `attach_ipc_handler`. If so, the local IPC change and its guard can be
   retired after qualification. Retain the vendor
   and drag snapshot bridge until an equivalent callback-time metadata API exists.
2. Otherwise replace this directory with the new published crate
   (`cargo download`/registry source), re-apply the `downgrade()`/`upgrade()`
   change and the drag snapshot bridge, update the host's direct Wry dependency,
   record the new pre-patch checksum above, and run both the guard and native drag tests.
3. Either way, confirm with a native Linux window-churn run beyond 399 child
   closes before release.

## Upstream

Reported upstream on 2026-10-01:
[tauri-apps/wry#1871](https://github.com/tauri-apps/wry/issues/1871).
The report includes the ownership cycle, direct Wry reproduction instructions,
our executed diagnostic results, and the equivalent weak-capture diff against
upstream `dev` revision `cab3eace983007a16f132c14a34d0a220c707bea`.
That revision and the 0.57.0 release still capture a strong `webview` in
`connect_script_message_received`.

Keep the local patch and guard until an upstream release includes the fix
and passes the native Linux window-churn qualification described above.
The diagnostic root cause is recorded in
`docs/lessons/817-linux-webkit-ipc-retention.md`.
