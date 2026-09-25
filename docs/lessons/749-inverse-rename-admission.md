# #749: Rename history needs filesystem admission too

Native history ordering did not exclude managed filesystem writers: actual
Rename Undo/Redo could rename a source while another operation held a source or
destination read claim. Regressions against the native adapter failed before the
fix. Share entry admission, physical binding, worker completion and retirement
between forward commands and inverses; keep history policy in its existing layer.

Admission observes paths independently. An unmanaged alias change between source
and target capture can otherwise produce a cross-directory move. Reject mismatched
physical parents and changed leaf names before the worker starts. The deterministic
binding regression failed against the unchecked resolver.

Return physical refresh parents and bind the next directional history action to
that parent. Alias presentation is useful for selection, but is not future native
authority. Suppress an unrepresentable opposite with a warning rather than storing
a lossy UTF-8 path that could name an unrelated file.

Use the shared worker completion ledger: confirmed effects survive context cleanup
panics, and retirement failure must append its diagnostic without inviting replay.
A real-worker regression aborts the waiter during blocked context cleanup and
checks both source and target remain excluded until the worker releases ownership.
Existing same-name rename tests caught a refactor regression: derive refresh from
the settled effect, not merely an Ok result.
