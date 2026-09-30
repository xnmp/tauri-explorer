# #876 — Clipboard platform code behind a backend seam

`clipboard.rs` interleaved four platforms and about seven mechanisms, so the
file-clipboard coordinator (#835, #871) could only be tested by an ignored
Xvfb test that set private fields.

- `src-tauri/src/clipboard/backend.rs` is the seam. `ClipboardBackend` is the
  worker-owned file-list half (`read_files`, `write_files`, `owner_token`,
  `selection_owner`, `cut_unavailable_reason`); `ClipboardReader` covers the
  stateless text/image reads, which stay off the worker so terminal paste
  never queues behind a slow file-list write.
- The coordinator verifies ownership itself: after a write it admits Cut only
  when `owner_token()` returns the token it just wrote. The defaults return no
  token and refuse Cut, so a backend fails closed until it proves ownership.
  #877 adds Wayland/Windows/macOS Cut by overriding those two methods in its
  own backend module; the coordinator does not change.
- Backends are created on the worker thread and need not be `Send`, so a
  future backend can hold a `wl-copy --foreground` child or a recorded
  sequence number as plain state.
- The failed-Copy-mirror baseline (OS paths and, on X11, the selection owner)
  is now observed after a failed write instead of before every Copy. A
  successful Copy costs no OS read (it was an extra PowerShell spawn per Copy
  on Windows). The baseline therefore means "the clipboard as our failed write
  left it": a change observed later still makes the external list win.
  Failures cluster, so the read right after a failed write can fail too. The
  baseline then falls back to the list last observed before the write. Without
  that fallback, the first successful read showed the older list and displaced
  the accepted Copy (adversarial review of PR #916). The Windows file-list read
  now stops on a clipboard exception, so a clipboard locked by another process
  is reported as a failure rather than as an empty list.
- An external Copy made between our failed write and the baseline read is
  absorbed into the baseline. That window is concurrent with our own failure
  and so is ambiguous either way. Owner identity (X11) still detects a new
  owner after the baseline.
- `fake_backend.rs` simulates the OS clipboard and other programs; coordinator
  and worker behaviour is tested on every platform in default CI. The ignored
  X11 test (`env -u WAYLAND_DISPLAY xvfb-run -a cargo test -- --ignored
  clipboard_coordinator_x11`) still covers the real formats, token and owner.
- `tauri-plugin-clipboard-x` had no caller and is removed with its capability.
