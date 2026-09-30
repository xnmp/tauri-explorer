# Subscribe to UDisks2 once; do not reconnect per poll (#888)

Every window polled `list_drives` every 1.5 s, and on Linux each call opened a
fresh authenticated system-bus connection and ran `GetManagedObjects`. The
standard client pattern (GIO's `GDBusObjectManagerClient`, as used by udisks
and GVfs) is one connection, a subscription to ObjectManager
`InterfacesAdded`/`InterfacesRemoved` plus `PropertiesChanged`, and a cached
snapshot the signals keep current. `linux_volume_monitor.rs` does that and
pushes `drives-changed` to the frontend.

Gotchas:

- Subscribe before the first `GetManagedObjects`, or a change between the two
  is lost until the backstop.
- A UDisks restart emits no `InterfacesRemoved`; watch `NameOwnerChanged` for
  the service and drop or refetch the cache on owner loss or gain.
- zbus reports a lost socket as one `Err` item on each `MessageStream`, and
  the stream ends after it. Treat either as disconnection and reconnect;
  holding the connection does not keep the stream alive.
- zbus stops reading the socket while any `MessageStream` queue holds its
  limit (64 messages). If the worker awaits `GetManagedObjects` without
  draining its streams, a signal burst stalls the reply until it times out.
  Drain the streams on their own task into an unbounded channel.
- A discovery timeout is not an outage. Keep the last snapshot and retry soon.
  Dropping it hides every unmounted volume until the next event or backstop.
- UDisks emits frequent `PropertiesChanged` for unrelated drive data. Compare
  the derived volume list before notifying, or every window refreshes on SMART
  updates.
- A slow backstop turns coalesced refreshes into lost updates. A push that
  arrives while a `list_drives` read is in flight must trigger one trailing
  re-read; returning the in-flight promise leaves a stale list for 30 s.
- UDisks never reports rclone FUSE mounts or bind/manual mounts. Watch `/proc/self/mountinfo`
  for POLLPRI|POLLERR, as systemd and libmount do, or the slow backstop
  regresses them from 1.5 s to 30 s. Register it with Tokio's `AsyncFd`
  (edge-triggered), settle briefly, clear readiness *before* re-reading, and
  compare the derived drives, not the raw table. Regular files cannot join
  epoll, so the registration error doubles as the degrade signal. Real mounts
  need an `unshare --user --map-root-user --mount` namespace to test.
- Only slow the poll while pushes are live. macOS, Windows, browser mode, and
  Linux without UDisks have no push source; the frontend asks
  `drive_updates_live` after it starts listening, and the event's `live` flag
  switches the cadence afterwards.
- After a mount, resync the monitor before returning. The mount reply can
  overtake the monitor's processing of its `PropertiesChanged` signal, so the
  sidebar's immediate refresh would otherwise show "Not mounted".

`Drive.path` is now `Option<String>` / `string | null`, replacing the `""`
sentinel, and `device_id` is serialized as `deviceId`.
