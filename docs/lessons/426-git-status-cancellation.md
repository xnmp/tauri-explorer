# Issue 426: cancelling abandoned Git status scans

Git status requests are shared work, not component-local work. A pane leaving a
directory cannot cancel by path: another pane, the graph, or the SCM view may
still await the same scan. Give each backend scan a caller-generated task ID,
track frontend consumers explicitly, and cancel only after the final owned
consumer releases it.

Setting a cancellation flag does not interrupt `std::process::Command::output`.
Long-running Git children must be spawned with piped output drained
concurrently, polled for cancellation, and terminated as a process tree. The
result must also be discarded after cancellation so a late completion cannot
repopulate a cache for a directory no pane tracks.

Keep cancellation request-specific. The SCM task registry also serves other Git
operations, so cancel-all or cancel-by-path can terminate unrelated mutations.
Libgit2 status collection has no comparable child process to kill; check its
flag before and after collection so a cancelled scan never publishes a result.
