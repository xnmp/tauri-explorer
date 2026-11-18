# Files backend rules

`system::open_recycle_bin` (`src-tauri/src/system.rs`) and `search_cache.rs` sit
outside this directory but their rules are here. `image_resolution.rs` (#994):
see `src/lib/components/CLAUDE.md` § Details image metadata.

## Quick Open search cache and recursive watches (#600, #651, #1007; ADR 0013, ADR 0014)

The frontend half (20-row cap, debounce, stream invalidation) is in
`src/lib/state/CLAUDE.md` § Quick Open.

Completed walks are cached briefly in `search_cache.rs` only while the root has an active filesystem watcher and a separate recursive cache-invalidation watch was established successfully; pane/thumbnail refresh watches stay non-recursive to avoid overlapping subtree fan-out. Because recursive cache roots can overlap, removing one registration must rebuild all surviving registrations and advance their cache epochs; notify's Linux backend can otherwise silently remove descendant OS watches. Coverage transitions advance only the exact root's epoch before advertising cache coverage—filesystem-change invalidation remains ancestor/descendant-aware—so an in-flight walk from an uncovered gap cannot publish after coverage returns without evicting unchanged overlapping listings. All epoch allocation goes through the same bounded revision tracker, including first-time coverage transitions. Ending the final pane watch must remove the recursive coverage and advance that root's cache epoch because files can change before it is watched again. Unwatched or recursively-uncovered roots always walk fresh, cancelled walks are never published, and publication must retain the pre-walk per-root invalidation revision so a watcher event racing a cold walk cannot resurrect stale entries or an unrelated root's event discard valid work (#600, #651).

Quick Open cancellation must reach recursive watch admission, not only the tree
walk. Keep pending recursive demand tied to each search flag; a cancelled waiter
can leave before an uninterruptible native registration returns. The recursive
worker reconciles both cancellation and final pane-release identities before
recovery, and batches obsolete overlapping roots into one removal so they cannot
rebuild one another. Successful cache coverage remains pane-owned. Test this
through the real streaming command as well as the injected native watcher seam
(#1007, ADR 0013 and ADR 0014).

Recursive recovery must also check live demand before each individual root's
native registration: checking only around a multi-root recovery lets a blocked
first root hide cancellation of later roots. Preserve the captured demand
identity so final release/reacquisition cannot revive an obsolete operation.

### Real-watcher timing tests (#1152)

Real-watcher timing tests must also wait for the backend watch and frontend
listener to be ready, then acknowledge every filesystem write at the
application-side watcher callback before attributing listing counts to it. A
receipt-count increase alone is insufficient: require its backend observation
time to be at or after that specific write began so an older delayed event
cannot advance the protocol. Recursive (Quick Open) coverage can be mid-rebuild after an
overlapping root is released while still reporting healthy; arm it with
`arm_search_watch_for_test` before taking the revision a write must advance
(#1152).

## Trash and Recycle Bin (ADR 0019)

In-app `trash://` listing and restore: `src/lib/state/CLAUDE.md`.

- The external Recycle Bin launch (Trash view → "Open in System File Manager") is platform-specific and belongs in `system::open_recycle_bin`: Windows uses `shell:RecycleBinFolder`, macOS opens `~/.Trash`, and Linux requests the native `trash:///` view through FileManager1. On definite service unavailability, launch a registered graphical file manager for the absolute Freedesktop `Trash/files` directory (#660, #672, #757).
- Do not use generic `gio open trash:///` or `xdg-open` on `Trash/files` as proof of a graphical Trash view: the former can dispatch to a handler that rejects the URI asynchronously, while the latter can open a terminal as the directory MIME default. Treat uncertain FileManager1 responses as errors rather than launching a second manager (#660, #672, #757).

Windows Recycle Bin inventory must read `System.FileName` (`PKEY_FileName`)
from the Shell item. `trash::list()` supplies a `SIGDN_PARENTRELATIVE` display
name, which can omit registered extensions; joining it to the original parent
silently changes the restore destination. Query the enumerated Recycle Bin
namespace item: reopening its parsing path gives a filesystem item whose name
is the physical `$R...` payload. Keep the real Recycle Bin regression
covering ordinary, repeated and absent extensions (#1208, ADR 0019).

## Linux volumes (#677, #888; ADR 0025)

Linux removable-volume discovery combines a single mount-table snapshot with
UDisks2 filesystem objects (`files/linux_volumes.rs`), read from one cached
subscription (`files/linux_volume_monitor.rs`) that pushes `drives-changed`;
never reconnect or refetch per `list_drives` poll. Mount-table drives UDisks never
reports (rclone FUSE, bind and manual mounts) are pushed by the POLLPRI watch on `/proc/self/mountinfo`
(`files/linux_mount_watch.rs`), and GVfs Google Drive mounts by session-bus
MountTracker signals (`files/linux_gvfs_watch.rs`; gvfsd-fuse raises no inotify
events), so the 30 s poll stays a backstop. Only the UDisks monitor reports
`live`; the other sources' pushes omit it (#888). UDisks object identity
(`deviceId`) is separate from `Drive.path`: a null path means unmounted and must
never enter navigation or mounted-root tracking. Mount only on explicit opening, through
`state/drive-opening.ts` and `mount_drive`; discovery itself is read-only.
Decode hex escapes only in `/dev/disk/by-label` aliases, once. UDisks `IdLabel`
and returned mount paths are already decoded, and may contain literal `\x20`.
Keep isolated-bus regression tests on the production adapter; browser IPC
fixtures cannot prove native discovery or mount authorization (#677).

ADR 0025 governs Linux volume mount authority, eligible targets, path validation,
and mount timeout/concurrency behavior. For visual drive evidence, show each
claimed label and lifecycle state: an ordinary spaced label does not prove a
literal `\x20`, and removal alone does not prove post-mount deduplication or
service-unavailable fallback. Keep simulated outage screenshots paired with the
native isolated-D-Bus contract tests. Run the full Cargo format check after
registering a new module; formatting only its implementation misses module-order
changes in `files/mod.rs` (#677 / PR #726).
