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
- UDisks emits frequent `PropertiesChanged` for unrelated drive data. Compare
  the derived volume list before notifying, or every window refreshes on SMART
  updates.
- A slow backstop turns coalesced refreshes into lost updates. A push that
  arrives while a `list_drives` read is in flight must trigger one trailing
  re-read; returning the in-flight promise leaves a stale list for 30 s.
- Only slow the poll while pushes are live. macOS, Windows, browser mode, and
  Linux without UDisks have no push source; the frontend asks
  `drive_updates_live` after it starts listening, and the event's `live` flag
  switches the cadence afterwards.
- After a mount, resync the monitor before returning. The mount reply can
  overtake the monitor's processing of its `PropertiesChanged` signal, so the
  sidebar's immediate refresh would otherwise show "Not mounted".

`Drive.path` is now `Option<String>` / `string | null`, replacing the `""`
sentinel, and `device_id` is serialized as `deviceId`.
