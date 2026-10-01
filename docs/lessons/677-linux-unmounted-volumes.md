# Linux removable volumes before mounting (#677)

A mount-table fix cannot discover a filesystem that has not been mounted.
Supplement `/proc/self/mountinfo` with UDisks2's ObjectManager on the system bus,
selecting filesystem-bearing removable/USB devices. USB HDDs often report
`Removable=false`; the drive's USB connection bus still identifies removable
storage. Never mount while polling.

A volume's UDisks object path is its identity across mount transitions, whereas
its filesystem path is empty until mounted. Sidebar keys use the identity and
mounted-root/disconnected-drive consumers exclude empty paths. Opening requests
Filesystem.Mount, preserves the returned path, and reports authorization/service
errors without navigating. Concurrent clicks are coalesced. A mount race with
another desktop client rechecks the object's mount points after an error.

Keep the original mount-table snapshot for merging by device source. Reading a
second table after the D-Bus query can lose the mapping for a just-unmounted
volume and leave both a stale mounted row and a new unmounted row. The newer
UDisks mount state wins; mount-table-only and cloud drives remain available if
the service is missing. The existing refresh loop picks up insertion/removal.

udev's by-label aliases encode bytes as `\xNN`, unlike mountinfo's octal path
escaping. Decode each alias once, including UTF-8 byte sequences; do not decode
UDisks labels or navigation paths, where literal `\x20` is valid text.

Runtime prerequisite for unmounted discovery/mounting: UDisks2 on the system
bus, with desktop authorization available when required. Systems without it
retain mounted-filesystem discovery. This does not add encrypted-volume unlock
or formatting support. Native regression tests use an isolated D-Bus service
and real Rust production adapters; browser screenshots prove the sidebar flow,
not hardware mounting or distribution-specific authorization policy.

API contracts: [Block](https://storaged.org/doc/udisks2-api/latest/gdbus-org.freedesktop.UDisks2.Block.html),
[Filesystem](https://storaged.org/doc/udisks2-api/latest/gdbus-org.freedesktop.UDisks2.Filesystem.html),
[Drive](https://storaged.org/doc/udisks2-api/latest/gdbus-org.freedesktop.UDisks2.Drive.html).
