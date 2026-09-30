# ADR 0025: Linux volume discovery and mount authority

Status: Proposed

Governs: `src-tauri/src/files/linux_volumes.rs`,
`src-tauri/src/files/linux_volume_monitor.rs`,
`src-tauri/src/files/linux_mount_watch.rs`, `src-tauri/src/files/drives.rs`,
`src/lib/api/drives.ts`, `src/lib/state/drive-opening.ts`,
`src/lib/state/drives.svelte.ts`, `src/lib/components/FilesSidebarView.svelte`

## Context

A mount table can describe mounted filesystems but cannot expose an unmounted
removable volume. Opening such a volume introduces a privileged filesystem
effect: mounting may require desktop authorization and may finish even if the
client stops waiting. Discovery, mount authority, and navigation therefore need
separate contracts.

## Decision

### Authority and allowed targets

- Discovery is read-only. Only an explicit volume-open action requests mounting;
  startup and refresh must never mount devices.
- UDisks2 on the system D-Bus owns mounting and delegates authorization to the
  host's desktop policy (polkit). Explorer runs as the user, sends an empty
  mount-options dictionary, and does not elevate itself, supply credentials,
  select another user, invoke a shell, or weaken authorization policy.
- Before each mount, the backend requires an identity under
  `/org/freedesktop/UDisks2/block_devices/` and matches it against a fresh
  ObjectManager snapshot. A client-supplied label or filesystem path is not
  mount authority.
- Eligible objects expose both Block and Filesystem, have filesystem usage,
  are not marked HintIgnore, and refer to a drive reporting Removable,
  MediaRemovable, or a USB connection bus. USB hard disks remain eligible even
  when their removable flag is false. Existing operating-system mount-root
  exclusions apply to mounted objects. Unrelated objects and removed volumes
  are rejected before calling Filesystem.Mount.
- This boundary permits filesystem mounting only. Formatting, unlocking
  encrypted devices, arbitrary device commands, mount-option overrides, and
  unmount/eject operations require their own design and authority review.

### Identity, validation, and navigation

- UDisks object identity (`deviceId` on the wire) is independent of the
  filesystem path and remains the sidebar key across a mount transition. An
  unmounted volume has a null path (`Option<String>` in Rust, `string | null`
  in TypeScript); it must never enter navigation or
  mounted-root/disconnected-drive tracking (#888 replaced the former empty-string
  sentinel).
- Already-mounted volumes open directly. Otherwise the backend calls
  Filesystem.Mount and returns the service's path only after a successful reply.
  Returned paths must be UTF-8, absolute, and contain no NUL. This is syntactic
  validation, not a promise that a device cannot disappear before navigation.
- Preserve paths exactly. Decode byte escapes once only for udev by-label
  aliases; UDisks labels and mount paths are already decoded and can contain
  literal escape text. Names are display data, never reconstructed mount paths.
- Merge the original process mount-table snapshot with UDisks by device source
  and mount path. The newer UDisks mount state wins, including external unmounts,
  so one filesystem volume does not become two rows during refresh.

### Change detection (#888)

- One process-wide system-bus connection subscribes to UDisks2's ObjectManager
  `InterfacesAdded`/`InterfacesRemoved`, every object's `PropertiesChanged`, and
  the service's `NameOwnerChanged`, applying each signal to a cached
  `GetManagedObjects` snapshot. Discovery reads that cache; polling never opens
  a connection or queries the bus. A signal that cannot be applied exactly
  (invalidated properties, an unknown object) triggers a full refetch, and a
  30-second backstop refetch corrects any missed signal. A dedicated task drains
  both signal streams into an unbounded queue, because zbus stops reading the
  socket while a stream's bounded queue is full and a signal burst would
  otherwise stall the refetch reply behind it. A refetch that times out keeps
  the last snapshot and retries after five seconds; only a definite service
  error or `NameOwnerChanged` owner loss drops it.
- Mount-table drives UDisks never reports (rclone FUSE mounts, bind and manual
  block mounts) have a second change source: one task waits for the kernel's
  POLLPRI|POLLERR notification on `/proc/self/mountinfo` (proc(5)) and
  re-reads it, notifying only when the drives derived from the table change,
  so unrelated mounts such as tmpfs stay silent. If the file cannot be opened
  or registered for polling, no watch starts and the backstop poll covers the
  mount table.
- GVfs Google Drive entries under `$XDG_RUNTIME_DIR/gvfs` have a third source.
  The gvfsd-fuse directory raises no inotify events when a GVfs mount appears
  or disappears, so a directory watch cannot observe it. Instead one task
  subscribes on the session bus to `org.gtk.vfs.MountTracker`
  `Mounted`/`Unmounted` (sender `org.gtk.vfs.Daemon`, path
  `/org/gtk/vfs/mounttracker`), re-derives the Google Drive entries after a
  short settle, and notifies only when they change. Without a session bus no
  watch starts and the backstop poll covers GVfs.
- Every source emits `drives-changed` to every window. Only the UDisks monitor
  reports liveness (`{ live }`); mount-table and GVfs pushes carry no `live`
  field, so an older liveness value cannot overwrite a newer one when events
  from different sources interleave. While `live`, the frontend polls
  `list_drives` only every 30 seconds as a backstop. Without a UDisks
  subscription (browser mode, macOS, Windows, Linux without a system bus or
  UDisks) it keeps the 1.5-second poll. The frontend reads the initial state
  from `drive_updates_live` (`Result<bool, AppError>`) after it starts
  listening, and ignores that answer if a liveness push has arrived since.
- Linux has no frontend mount-directory watches; the backend sources above
  replace them. macOS still watches `/Volumes`.
- Mount requests reuse the subscription's connection and resynchronize it
  before returning, so the caller's next discovery reflects the outcome. Mount
  authority still comes from a fresh snapshot, never the cache.

### Failure, concurrency, and effect uncertainty

- System-bus connection and discovery each have a two-second deadline. Missing
  or failed UDisks discovery retains mounted-filesystem and cloud discovery.
  The subscription retries an unreachable or lost bus every five seconds and
  picks up a restarted UDisks service from `NameOwnerChanged` on the same
  connection.
  Mount requests surface understandable service or authorization errors and
  must not navigate on failure.
- Each sidebar opener coalesces repeated clicks on the same pending identity
  and clears its pending state when the request settles. Other windows and
  desktop clients remain independent; UDisks arbitrates concurrent mounts.
- Recheck current mount points after a mount error. If another client already
  mounted the same eligible volume, return its valid path; otherwise propagate
  the error. Do not blindly retry the privileged operation.
- A mount request has a 120-second client deadline. Timeout, dropped IPC, or
  process exit does not establish that the server cancelled or rolled back the
  effect. The timeout message directs the user to refresh before retrying;
  subsequent discovery reconciles the actual mount state. No automatic unmount
  or file-operation undo receipt is manufactured.
- Non-Linux callers cannot use the mount command. Windows, macOS, and cloud
  volumes retain direct navigation through their existing paths.

## Why UDisks2

UDisks supplies typed filesystem objects before mounting, stable object
identities, desktop authorization, and an explicit mount-path result. It is
already accessible through the existing zbus dependency. A mount-table-only
implementation misses unmounted devices; invoking mount with elevated shell
commands would duplicate authority and option validation owned by the desktop
service. Generic URI opening does not give Explorer the resulting path needed
for its own navigation.

UDisks remains optional for mounted discovery. Hosts without it cannot discover
or mount unmounted filesystems through this boundary; they retain their existing
mounted and cloud volumes. Policy remains owned by the host distribution and
desktop, rather than by Explorer configuration.

## Verification

`src-tauri/tests/linux_removable_volumes.rs` exercises the production adapter
against an isolated D-Bus service: read-only discovery, mount success and errors,
stable identity, stale mount-table snapshots, removal, missing service, and label
handling, plus the subscription: pushed mount/unmount/removal/insertion on one
connection with no refetch, a change racing the first snapshot, a signal burst
during a refetch, a timed-out refetch, post-mount resync, the backstop, bus
loss and recovery, and a service restart without reconnecting.
`src-tauri/tests/linux_mount_watch.rs` (opt-in, in a private user and mount
namespace) proves a real bind mount and unmount are pushed promptly while tmpfs
mounts stay silent; unit tests in `linux_mount_watch.rs` cover the change
detection and the degraded (unpollable) path.
`tests/state/drives-push.test.ts` covers the frontend's push handling and poll
cadence. Existing mount-table and cloud unit tests preserve fallback behavior.
`tests/state/drive-opening.test.ts` and `unmounted-drive-roots.test.ts` assert
navigation admission, errors, coalescing, and mounted-root semantics. Browser
specs assert the rendered sidebar and provide acceptance images; browser service
fixtures demonstrate presentation, not host authorization or physical mounting.
