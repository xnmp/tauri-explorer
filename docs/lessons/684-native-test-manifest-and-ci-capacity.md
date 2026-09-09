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
