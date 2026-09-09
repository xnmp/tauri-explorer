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

Native sessions also share persisted tab layouts. The Windows transfer rejection
fixture restored eight panes from the preceding timed-out spec, then split to
nine while waiting for exactly two. Establish a fresh single-pane tab through
the normal New Tab action before constructing the left/right fixture; retain the
source identity, contents and watcher assertions for every rejected handoff.

A Mocha timeout does not cancel an async test body. The timed-out large-layout
test continued navigating and tearing off its tab while the next test navigated
the same window. The log shows the source navigation at 10:07:32.254 overwritten
by the prior body's pane-7 navigation at 10:07:32.516. This explains the later
token/path timeout; it is not a StatusBar bug (the app has one active-explorer
StatusBar). Keep the navigation contract intact and diagnose the first timeout
before changing product navigation or transfer behavior.

Collect all independent Windows contract families even after one fails, retain
a failing final exit status, and run lint and GUI smoke when their build/driver
prerequisites succeeded. Never turn these checks into `continue-on-error` gates.

The completed `a5fced4b` run confirmed deletion receipts and Git trash paths,
then exposed the same `0x00270008` on restore-side `PostMoveItem`. Its exact
destination is authoritative only when it matches the request; do not generalize
this to every nonnegative status. Native restore tests must still prove bytes,
directory descendants and symlinks after the classifier accepts the callback.

Windows notify maps `FILE_ACTION_MODIFIED` to `Modify(Any)`, whereas add/remove
and rename have distinct actions. An active root modification does not establish
identity loss. During registration, however, a nonrecursive parent may be the
only observer and its root timestamp change may cover child churn. Capture the
callback's receipt state: retain a catch-up while pending, or deliver a root
invalidation if activation wins before the dirty latch. Ignoring that race loses
the notification. Preserve the same protection for recursive filename caches.
See [FILE_NOTIFY_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-file_notify_information)
and [ReadDirectoryChangesW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw).

Copied-root watcher regressions must require receipt of the exact post-recovery
write before accepting a service invalidation. Merely draining a channel is not
enough: delayed native copy events can arrive afterward and falsely satisfy it.

FilePicker's old private slash splitting turned a drive path into `/C:\\...`.
Reuse the cross-platform breadcrumb parser, retain drive/UNC roots, and assert
the path returned by Select as well as the columns. Browser mock coverage does
not establish real Windows or network directory contents.

The terminal-resize native test must create its own nonempty directory. A
persisted startup directory can be empty or removed by an earlier spec. Tauri
application logs also live outside the checkout: copy only the configured app's
`logs` directory into artifacts, or existing frontend launch diagnostics are lost
when WebKitWebDriver does not forward the application stdout.

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

An existing file row can still be unusable when its entire file area lies beyond
the native viewport. At an 800px window, leading Miller and SCM widths can exceed
the remaining workspace width. Revealing the whole oversized pane's leading edge
then hides its file names. Reuse the mounted inline-width leases to reveal the
file area, preserving minimum sizes, saved ratios, manual scrolling and resize
coordination. Browser acceptance must bound the actual filename text rectangle
inside the workspace/window and select it in all three views; checking only that
the file-list rectangle intersects its pane missed this failure.

The terminal fixture's exact entry can exist without `.explorer-pane.active`: that
class renders the active border only in multi-pane layouts. Select the unique
fixture path directly, then retain visibility, click and real PTY outcome checks.

Windows Shell restore receipts can return a long parent spelling when the queued
request used its 8.3 alias. Retain the queued parent Shell item on the STA and
compare the callback parent canonically, then compare the requested and returned
leaf using native ordinal case folding. The existing absolute-path match remains
valid too. Do not feed relative leaf names to `WindowsPathKey`, which only accepts
fully qualified paths: independent review caught that making every match false.
Collision-renamed leaves and unproven destinations remain uncertain. See
[IShellItem::Compare](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishellitem-compare)
and [CompareStringOrdinal](https://learn.microsoft.com/en-us/windows/win32/api/stringapiset/nf-stringapiset-comparestringordinal).

The restore destination parent needs the same Shell parsing-name normalization as
the source filesystem path. Sending a supported verbatim DOS parent directly to
`SHCreateItemFromParsingName` fails with `E_INVALIDARG` before the move is queued.
Preserve the requested path spelling for matching while normalizing only the
Shell API argument. Legacy inventory diagnostics must include same-parent
candidate names: filtering only by the expected leaf hides any display-name
reconstruction mismatch. Diagnostic capture in native tests must be best-effort,
including normal-path checkpoints; a failed driver call or missing fixture path
must not replace the original feature failure.
