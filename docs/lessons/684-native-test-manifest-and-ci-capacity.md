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
contracts now load. The initial diagnosis that the byte-budget fixture failed
because of a long leaf was not established: bounding components did not fix the
Windows failure. `temp_dir()` already ended in a separator, and appending another
made the path invalid under the admission grammar. The syntactic fixture now
uses an explicit absolute root and bounded components, preserving the exact raw
byte count and duplicate-input boundary independently of the runner environment.
A separate trash
test indexed artifact metadata before checking the mutation result, hiding the
real failure behind a missing-key panic. Assert outcome and apartment contracts
first, then require exact artifacts and restored bytes. Missing metadata alone
does not prove that deletion succeeded.

The completed Windows run exposed `COPYENGINE_S_DONT_PROCESS_CHILDREN`
(`0x00270008`) with an exact Recycle Bin item in `PostDeleteItem`. Admit this
specific status alongside `S_OK` only with a nonempty item locator; other
nonnegative HRESULTs are not generic success. The regression fails before the
classifier fix and passes after it. Native MSVC confirmation remains required.

The Git trash caller also supplied ordinary forward-slash paths to the Windows
Shell parser, which returned `E_INVALIDARG`. Rebuild native path components at
the Shell boundary without lossy Unicode conversion; keep caller-visible paths
and exact inverse-artifact authority unchanged. Legacy inventory tests resolve
the surviving parent before comparing path keys, preserving deleted symlink
leaves while accounting for temp-directory aliases. These changes still require
Windows native execution; cross-compilation is not runtime evidence.

Windows directory and Git watcher failures require raw registration/event
diagnostics before changing path matching or recovery policy. Keep first-load
and refresh-count assertions intact. Debug-only logs record source identity,
paths, event classification, activation and recovery; Windows smoke enables the
existing debug log level. No canonicalization or new watcher work is introduced.

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
