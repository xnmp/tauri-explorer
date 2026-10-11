# Slow folder loads: capture while stuck (#1022)

A user saw a pane stuck on FileList's "Loading..." state with no way to say
why. The spinner covers everything from `navigateInternal` setting
`loading` to the listing being published, so the diagnostic has to follow
the whole path, frontend and native, and it has to be taken *while* the load
is pending: the worst case never finishes, and a record written on
completion would never exist.

Root-cause candidates visible in the code, each now a named phase:

- **queued** — `directory-listing.ts` runs one scan per pane at a time. A
  watcher-triggered refresh stuck on a slow mount holds the queue, so the
  next navigation in that pane waits behind it even if its own folder is
  local. Records name the blocking listing (`queuedBehind`) and, when it is
  still in the native registry, its native phase (`blocker`).
- **watch-lock / watch-register** — `fs_watcher.rs` registers OS watches
  while holding the process-wide watcher mutex. A mount that blocks
  `inotify_add_watch` stalls watch registration for every pane and window.
- **root-metadata** — `stat` of the folder itself on a hung network or
  FUSE mount.
- **read-dir** — enumeration; entries listed stays 0 until it returns.
- **entry-metadata** — per-entry `lstat`, symlink-target `stat`/`read_dir`
  and the `.git` probe for every subfolder (skipped only for UNC roots, not
  for sshfs/NFS/rclone). One symlink into a dead mount stalls the whole
  listing; `stalledEntries` names it while it is pending.
- **blocking-queue** — waiting for a Tokio blocking-pool thread.
- **serialize / ipc-reply** — Tauri encodes a command's return value after
  the command returns, so for a huge folder the encoding and the webview's
  receive/decode happened outside the native trace and were blamed on the
  last scan phase. `TracedReply` keeps the trace open until the reply is
  encoded (`serialize`); when the native command settled long before the
  frontend's `native` phase ended, the culprit is the IPC reply itself.

Design notes: the watchdog is the standard slow-operation shape (in-flight
registry, per-operation deadline timer, phase spans). The frontend owns the
threshold; native code only merges its own snapshot at write time, so the
fast path costs a trace object, a few clock reads and one cleared timer, and
the native side a registry insert and two relaxed atomics per entry. The
filesystem lookup reads the mount table only (mountinfo, `getfsstat` with
`MNT_NOWAIT`, `GetDriveTypeW`) because stat-ing the folder would hang
exactly when the diagnostic is needed. Symlinks are followed only while
the walk is on a known local-disk or in-memory filesystem (`~/nas ->
/mnt/nfs` reports NFS), never inside the mount being diagnosed and never
below an `autofs` trap, and the probe runs on a helper thread with a
timeout so it cannot stall the record writer. A native fallback writes a
native-only record if a *watched* listing (a navigation, not a background
refresh) is still pending after 7 s, and settles that record when the
listing finishes; refreshes are traced only so a navigation queued behind
one can name it, and arming them filled the 20-record store with stale
pending records that pushed out the real stuck navigation.

Review findings worth keeping: persistence must not run on the async
executor or the shared blocking pool (the log directory can itself be on the
hung mount, and the pool can be saturated by the hung listings), so records
go through one writer thread and an in-memory copy serves the report dialog.
Captures can arrive out of order, so precedence is explicit: the frontend
record always outranks the native fallback (the native command finishing
does not mean the pane got its reply), and within one source a settled
outcome is never replaced by a late pending capture. A pane settles its previous trace
when a new navigation starts, because a navigation queued behind a listing
that never returns otherwise never settles; an auto-enter descent that a
newer navigation superseded is dropped rather than resumed with a settled
trace. The settled-beats-pending rule is re-checked against the file on
disk, because the in-memory map forgets records after 20. The renderer
record's shape is pinned by a fixture both the TS and Rust tests read:
`persist()` swallows IPC rejections, so a renamed field would silently
disable recording.

Reports: unlike the removed log tail (#595), these records are captured at
the moment of failure and are shown verbatim in Report Issue, opt-out per
report, limited to the last 24 hours, with a note that they include folder
paths (the slow folder, folders loading alongside or ahead of it, mount
points). Individual file names (stalled or slowest entries) stay in the
local record; the public text has only their counts and timings.
