# #846 dependency compatibility verification

Tauri 2.12.0 requires Wry 0.57.0. The published Wry archive has SHA-256
`a819957a01b3119af85e638a38d242af76dbc87d130dca67bfd0441072e21ff0`.
The migrated vendor tree matches that archive apart from the documented
weak IPC capture, its provenance note and one Markdown trailing space.

The existing vendored-Wry test fails before the migration because Cargo
resolves registry Wry instead of the 0.55.1 patch; all three guard tests pass
afterward. The original Linux build also reproduced the missing
`gio::DesktopAppInfo` compiler error. Original macOS/Windows CI logs report
the missing `WindowEffectsConfig.interactive` field. The repair selects the
new Unix GIO API and default native effect fields.

## Native lifetime experiment (2026-10-02 UTC)

`probe.rs` uses the actual Wry crate, a shared native WebContext and a custom
URI scheme. Each visible child sends real IPC only after two animation frames,
then its native GTK window and Wry view are destroyed. The probe observes the
process's actual `WebKitSharedMemory` descriptors after each close and rejects
growth greater than 16. Its main window must still deliver real IPC afterward.

The same source was linked against the migrated patched Wry and against the
pristine published 0.57.0 crate. Both use the same Wry features
(`os-webview`, `linux-body`, `x11`) and GTK 0.18 with `v3_24`.
The pristine control fails after child close 17: baseline 1 descriptor grows
to 18. The patched result is recorded in `patched-result.txt`.

The weak-widget check establishes GTK disposal only. It cannot establish
GObject finalization; the sensitive descriptor check supplies the retention
evidence. An initial HTML/about:blank fixture observed zero descriptors and
also passed on pristine Wry, so that fixture was rejected as retention proof.

Each run used a separate Xvfb + Openbox display, X11 backend, isolated XDG
config/cache/data/runtime and private D-Bus session. Before churn, the wrapper
verified the probe, window manager and WebKit helper environments. The two
environment audit files record those process identities. Only the wrapper's
owned process groups were stopped; the user's desktop and clipboard were not
used. `private-display.py` contains the executed isolation wrapper.

This is a bounded native Wry lifetime diagnostic. It does not replace the
four-hour application qualification or hosted Windows/macOS runtime checks.

## Other checks

- Full-feature Clippy: `avif,durable-recovery,e2e-renderer-recovery,e2e-hooks`,
  all targets, `-D warnings`: passed.
- Rust tests with `avif,durable-recovery,e2e-hooks`: 1,605 unit tests and all
  integration suites passed; 44 platform/interactive tests ignored.
- Rust tests with `avif`: 1,607 unit tests and all integration suites passed;
  44 platform/interactive tests ignored.
- Tauri CLI embedded debug build with Rust/frontend E2E hooks: passed,
  including the JS/native minor-version check. No GUI was launched by it.
- Frozen Bun install, frontend typecheck and frontend production build: passed.
- Rust formatting and code-map coverage: passed.

Compiler scratch initially hit the host `/tmp` user quota. Using a worktree
temporary root avoided quota but changed nonrepo discovery and path-budget
fixture preconditions. Full Rust suites passed with the task-owned short
canonical disk root outside Git; no assertions or production logic were
changed to accommodate that infrastructure failure.

## Replaying

Compile `probe.rs` against the application's built Wry and GTK rlibs, using
its target dependency/native library search directories. Alternatively use a
small Cargo package with GTK 0.18 (`v3_24`) and Wry pointing at
`src-tauri/vendor/wry`, default features disabled and `os-webview`,
`linux-body`, `x11` enabled. Point the same manifest at the published Wry
0.57.0 source for the negative control.

From the repository root, run `private-display.py` with `PROBE_BINARY` set
to that executable and `PROBE_PROFILE` set to a unique leaf name. Artifacts
go under ignored `qualification-results/<profile>/`. The wrapper checks
process isolation before enabling the 450-cycle loop and tears down only its
owned groups on success, failure or interruption.
