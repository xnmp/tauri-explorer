# #684 — Native test manifests and browser CI capacity

A Windows app can build successfully while `cargo test --lib -- --list` exits
before discovery with `STATUS_ENTRYPOINT_NOT_FOUND`. Tauri's resource embedding
covers app binaries; a library test executable needs the Common Controls v6
activation manifest too. For MSVC, disable Tauri's resource manifest and embed the
shared XML through generic `/MANIFEST:EMBED` and `/MANIFESTINPUT` linker arguments,
as in [Tauri's API example](https://github.com/tauri-apps/tauri/blob/dev/examples/api/src-tauri/build.rs).
Do not use `rustc-link-arg-tests` for library unit tests. Gate MSVC switches on the
Cargo target OS/environment, preserving GNU resource embedding and DPI metadata.
Cross-compilation does not establish Windows loader acceptance: run native test
discovery, contracts, and the app smoke suite.

A 777-test Chromium suite exceeded a 20-minute CI job cap with one worker. The
interrupted HTML/dot reporter never emitted the failing assertions. Split across
runners while retaining one worker per runner, and enable the line reporter for
immediate failure evidence. Keep the existing protected check as a fail-closed
aggregate of validation and every shard; renaming jobs alone can silently weaken
branch protection. Verify that shard inventories are disjoint and cover the full
suite. Diagnose actual failures independently of the job budget.

The #500 long-path regression compared whole commit panels containing different
commit summaries. At 700px a summary wraps independently of the filename, adding
21px even though the file row and column have identical heights. Compare the
file row/column geometry and containment, which are driven by the tested input;
do not attribute unrelated metadata wrapping to file-path truncation.

The native Git-observer destruction fixture must establish its child renderer
before testing observer ownership. Prime and acknowledge the parked window,
require activation of that exact label/handle, and only then acquire the lease.
A null result from fresh-window creation timeout does not exercise reclamation.
Keep the acquisition, exact native destruction, backend reclamation log and
surviving-window navigation assertions; do not alter product deadlines to make
the fixture pass. Budget the suite separately for all isolated native sessions:
36 sessions at roughly 30 seconds startup each cannot fit in a 15-minute step.

Windows execution subsequently confirmed that library test discovery and batch
contracts now load. A byte-budget fixture still failed because its 1,024-byte
path used an invalid Windows leaf component; use valid, bounded components while
preserving the raw byte count and duplicate-input boundary. A separate trash
test indexed artifact metadata before checking the mutation result, hiding the
real failure behind a missing-key panic. Assert outcome and apartment contracts
first, then require exact artifacts and restored bytes. Missing metadata alone
does not prove that deletion succeeded.

Collect all independent Windows contract families even after one fails, retain
a failing final exit status, and run lint and GUI smoke when their build/driver
prerequisites succeeded. Never turn these checks into `continue-on-error` gates.

Animation tests must establish their target lifecycle before browser round trips
consume it. For rapid tab-close Undo, capture Svelte's public `outrostart`, then
inspect animations in a microtask after that task registers them. Hold the exact
outro, restore the directory, finish the old animation, and require only the two
live tabs to remain. Merely slowing currently running animations after awaiting
the directory can miss the whole 120ms transition. For drag coordinates, use
Playwright's trial pointer action to wait for stable targets; an immediate
`getAnimations()` snapshot can precede intro registration.

The Playwright WebKit trace for multi-selection retention showed Shift+Tab left
the focused row unchanged; the following Tab then correctly left it. Selection
and the sole row tab stop were intact. Establish departure with the existing
preceding-focus-target helper for the selection-retention test, assert departure
immediately, then use real Tab to verify reentry. This does not qualify backward
traversal in production WebKit, nor identify the native WebKitGTK WebDriver key
delivery defect as the cause of this different protocol's behavior.

Linux session cleanup must own the application below the driver process, too.
CI showed an exact application PID from the directory-watch worker still alive
in a later session, where it broke a renderer-crash test's single-process
precondition. Linux starts only tauri-driver directly; WebKitWebDriver launches
the application. Stopping and awaiting only tauri-driver therefore cannot prove
application cleanup. Start the Linux session in a dedicated process group,
terminate that group, and bound checks of the group's disappearance even after
its leader exits. Signal only the captured session group, never every process
whose executable matches the app. Real subprocess tests must preserve an
unrelated sibling and clean up even when their readiness check fails. A child
`exit` event can precede stdout drain; wait for stream completion with a bound
and synchronously emit fixture proof bytes.

The Mac qualifier previously forced a debug build and an extra warm-measure
window during startup. Separate release foreground-only samples from warm-probe
samples, verify the same binary hash in both reports, and remove `WARM_MEASURE`
from the environment instead of setting it to `0` (native code checks presence).
Release builds ordinarily omit stdout logging; explicitly enable the existing
readiness log stream for qualification. This still measures native readiness,
not presentation or first input, and fresh launches do not flush OS caches.
