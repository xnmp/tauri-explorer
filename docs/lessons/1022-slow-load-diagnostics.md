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

Design notes: the watchdog is the standard slow-operation shape (in-flight
registry, per-operation deadline timer, phase spans). The frontend owns the
threshold; native code only merges its own snapshot at write time, so the
fast path costs a trace object, a few clock reads and one cleared timer, and
the native side a registry insert and two relaxed atomics per entry. The
filesystem lookup reads the mount table only (mountinfo, `getfsstat` with
`MNT_NOWAIT`, `GetDriveTypeW`) because stat-ing the folder would hang
exactly when the diagnostic is needed. A native fallback writes a
native-only record if the renderer has not recorded a still-pending traced
listing after 7 s.

Review findings worth keeping: persistence must not run on the async
executor or the shared blocking pool (the log directory can itself be on the
hung mount, and the pool can be saturated by the hung listings), so records
go through one writer thread and an in-memory copy serves the report dialog.
Captures can arrive out of order, so precedence is explicit: a settled
outcome is never replaced by a late pending capture, and the frontend record
is never replaced by the native fallback. A pane settles its previous trace
when a new navigation starts, because a navigation queued behind a listing
that never returns otherwise never settles.

Reports: unlike the removed log tail (#595), these records are captured at
the moment of failure and are shown verbatim in Report Issue, opt-out per
report, with a note that they include folder paths.
