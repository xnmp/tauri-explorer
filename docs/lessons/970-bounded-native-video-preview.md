# #970 — native video playback without whole-file buffering

Tauri asset GET reads a complete file into a response; a custom protocol response also owns its bytes. Neither provides the bounded streaming contract required for large movies. Use a loopback-only HTTP/1 server and a random, renderer-owned capability, while retaining the native WebView decoder.

Register a provisional capability before opening the file. Disposal can then release it before preparation completes, without a release-before-registration race or unbounded tombstones. Acquire the bounded open-worker permit before changing the phase; otherwise overload strands a capability permanently in Preparing. Blocking workers retain admission until the filesystem call actually returns, even when the renderer cancels.

Each response opens its own anchored no-follow handle and validates identity, size and modification time against the pinned original. Positioned reads avoid the shared cursor of cloned file handles. Reads allocate at most 64 KiB and follow body backpressure. Retirement also races the connection driver: watching only the body cannot close a socket whose client stopped reading. Admission bounds apply to connections, streaming handles and blocking file workers separately.

The admitted revision is checked when each response opens. This is not an immutable movie snapshot: in-place writes during an existing response can still change its content. Reselect changed files; do not claim cancellation interrupts an operating-system file call.

Detach the video source synchronously before releasing its capability on selection, hide, revision replacement or component destruction. Media errors release the source too. Playback comes only from explicit user input. Consume owned keys while loading and repeated playback toggles without applying their effects; otherwise global Explorer shortcuts can fire. Honor modal ownership and the shared WebKitGTK Super tracker.

Codec support follows the native platform and installed decoders. Browser mock playback verifies UI behavior only. Qualify supported encoded files and unsupported sources with the actual binary, and record measured startup, seek, read bounds and process memory rather than inferring decoder memory from bounded HTTP chunks.

The Linux headless WPE Playwright proxy can advance time and report decoded dimensions while emitting transparent frames. A bare `<video>` reproduces this independently of Explorer. Keep decoded-color assertions; run those specs with `PW_VIDEO_HEADED=1` in WebKitGTK on a private Xvfb display. CI provides that display while other specs retain WPE. Timing and metadata alone do not prove that a video is visible.
