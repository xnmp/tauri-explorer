# Naming the plugin profile owner

A refused plugin-profile owner used to say only "Another Tauri Explorer process
owns this plugin profile". #1427 showed the likely culprits are other
session-bus instances on the same profile (xvfb-run/dbus-run-session test runs,
native E2E runs against the real `~/.config`) that bypass single-instance D-Bus
routing, so the refusal must say which process holds
`<config>/tauri-explorer/.plugin-runtime.lock`.

`flock` and `LockFileEx` have no portable owner query (`/proc/locks` is
Linux-only and gives an inode, not a path). The owner therefore writes a
versioned text record (PID, acquisition time, executable, and on Linux the
`/proc/<pid>/stat` start ticks) into the lease file **after** taking the lock
(`installed_plugins/owner_record.rs`). Rules that keep it safe:

- Writing is best-effort and never affects ownership. A refused process only
  reads; it must never write, or it would erase the real owner's record.
- Truncate before writing, so a shorter record cannot keep a longer stale tail.
  A reader racing that truncate sees an empty or partial record and falls back.
- Reads are bounded (4 KiB) and strict: unknown keys, missing fields, PID 0 or a
  non-UTF-8 executable reject the whole record.
- Liveness: Linux requires `/proc/<pid>` to exist **and** its start ticks to
  match, which rejects a reused PID. Other Unix uses `kill(pid, 0)` (EPERM
  still means alive) with no reuse protection; the owner clears the record on
  release to narrow that window. Windows locks are mandatory byte-range locks,
  so a refused process normally cannot read the record at all and keeps the
  generic message.
- The record is diagnostic only. Mixed versions are expected: an older build
  holding the lock writes nothing, leaving a previous newer owner's record,
  which the liveness check rejects.

Lease IO failures (symlink, directory, open errors) keep the generic message;
only a held lock with a live record names the holder. `initialize` forwards a
named refusal into the queued startup errors instead of replacing it with the
constant text.

Evidence is the Rust contract output: a forked test child refused by its parent
names the parent's PID, and garbled/dead/reused-PID records fall back. The
mock-backend browser app never owns a profile, so it cannot screenshot a real
refusal.
