# #912 — Keep process starts off the ordered file-clipboard path

The Windows native smoke `context-clipboard.spec.ts` "copy + background paste
duplicates the file on disk" failed again after #715 (runs `36427823976` and
`36687149741` attempt 1): `native listing did not contain 2 match(es) for
original`. The retained diagnostics showed only `original.txt` on disk as
well as in the listing 15 s after Paste, with the background context menu
still open. `handlePaste` closes the menu only after `explorer.paste()`
returns. The paste therefore had not finished. No copy reached disk, so the
watcher and listing were not lagging. The listing wait had observed the
right outcome.

Paste waits for the ordered native clipboard snapshot (#835). The worker had
to run three serial PowerShell processes before the copy could start: the
renderer's startup snapshot read, Copy's mirror write and Paste's snapshot
read. Worker instrumentation (`file clipboard job=… queued/started/finished`)
on the Windows runner measured this chain. In an isolated 30-session loop,
each `powershell -STA` + WinForms start took 0.35–0.6 s, and the first one in
the job took 2.8 s. Paste-to-listing took 0.43–2.89 s. In the full suite, the
same processes took p50 0.74 s and up to 1.8 s. Successful full-suite runs
recorded Paste-to-listing times of 0.5–6.8 s. The two failures are the tail
of this sum, where the 15 s budget ran out. Each session spawned about 16 such
processes, because every snapshot (startup, reconcile, the cross-window
notify, Paste and Cut claim) was a PowerShell read.

The fix is in the product, not in the wait. Windows file-list reads and writes
now use the Win32 clipboard directly. Reads use `GetClipboardData(CF_HDROP)`
with `DragQueryFileW`. Writes use one `OpenClipboard`/`EmptyClipboard` session
that sets a `DROPFILES` block and the private token format. The memory blocks
are zero-filled `GHND` allocations, so the token read-back's NUL-padding rule
still applies. A clipboard that another process keeps open is retried for
about one second, matching the retry budget WinForms used. If it is still
held, the read fails rather than reporting "no files". Text and image reads are
off the Paste path and still use PowerShell. Lengthening the timeout would
only have hidden a user-visible Paste that took several seconds.

Verification: the `DROPFILES` encoder has unit tests on the Windows Rust job.
The ignored `native_clipboard_ownership_round_trip` test covers the real
write, read-back, Cut ownership and external `Set-Clipboard` replacement. The
before and after 30-session loops are in the PR.

When a native wait times out, first check whether the operation's own effect
exists on disk. Here it did not. That ruled out the watcher and listing, and
pointed to the work the operation was queued behind.
