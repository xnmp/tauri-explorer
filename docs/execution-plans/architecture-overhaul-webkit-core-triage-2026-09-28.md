# WebKit core triage for the local all-view gate (2026-09-28)

The local all-view browser suite passed 2,372 cases with 36 skips in 45.2
minutes, but the host retained 16 `WPEWebProcess` cores during its WebKit
half. These are processes from Playwright's bundled `webkit-2287`, not the
Tauri application's native WebKitGTK process. The 16 entries and their
timestamps are in the ignored local
`test-results/wpe-page-cores-20260928.log` (SHA-256
`11993f3df0f7768993894d830f5ed33e9e04678985cdfe6792587c56edb7a381`).
The passing test log is
`test-results/all-views-report-focus-fix-20260928.log` (SHA-256
`43355564793f64061445d3aff77fe2ee227a921ee6e6d4b239149aa2d8e0166d`).

Read-only `coredumpctl info` inspection found these faulting signatures:

| Cores | Signal and leading stack | Interpretation |
| --- | --- | --- |
| 12 | SIGABRT in glibc `abort` through `exit` or thread-local teardown | Native process teardown; the initiating corruption or trigger is unidentified |
| 1 | SIGABRT through Mesa `libgallium-26.1.5-arch1.1.so` during `exit` | Native graphics teardown |
| 1 | SIGSEGV on a Skia GPU worker through Wayland client and Mesa EGL libraries | Native graphics path |
| 2 | SIGSEGV in `posix_memalign` called from `libnvidia-gpucomp.so.610.43.03`, followed by NVIDIA EGL frames | NVIDIA graphics path |

An independent Sol reviewer separately checked all 16 PIDs and reached the
same classification. None of the faulting stacks identifies application
JavaScript. The passing run also logged Vite module-import errors and HMR
warnings near some cores; the available logs do not attribute those messages
to a particular dump or test case. A page can trigger a browser or driver
defect, so these stacks do **not** establish that the application is unrelated.

As a negative control, two Playwright WebKit browsers each opened, rendered and
closed 100 blank pages with a CSS transform and filter under the same host
libsoup 3.6.6 preload. The unsandboxed command exited 0 in about 50 seconds
and no new `WPEWebProcess` core was present after it. The ignored control log
is `test-results/webkit-blank-control-20260928.log` (SHA-256
`7d78d4329ae5794f02705553085cb050a6bf970a4ef8c6692cfad79476f69304`).
This control is much smaller than the 45-minute app suite and cannot prove
crash freedom or isolate the trigger. A first sandboxed attempt could not start
the browser and was interrupted; it provides no result.

The earlier `WPENetworkProcess` bootstrap failures are separate: two retained
network cores mapped bundled libsoup 3.6.5, while a 30-repeat local comparison
with system libsoup 3.6.6 passed without a network core. See
`test-results/webkit-crash-correlation.txt`. The 16 page-process cores above
occurred *despite* the libsoup preload.

W8.1 remains open. Its final published-`dev` browser run should retain
per-test timestamps and WebKit process/core diagnostics if any crash recurs,
then distinguish failing assertions from native browser crashes before changing
product logic. Neither the passing assertions nor this stack audit proves
crash-free WebKit stability.
