# GVfs (Google Drive) locations have no trash and no stable staging identity

GVfs exposes every GIO backend through one FUSE mount, `fuse.gvfsd-fuse` at
`$XDG_RUNTIME_DIR/gvfs`. Its root is a virtual, read-only list of backend
mounts: `vfs_mkdir("/.Trash-$uid")` cannot map to any backend and returns
`ENOENT`. The Freedesktop planner put the trash for a Google Drive file at that
mount's top directory, so Move to Trash could never work. Copying into the home
trash is not an option either (ADR 0019 rules out a copy/delete fallback), and
the Google backend itself reports `access::can-trash = FALSE`, which is why
Nautilus only offers permanent deletion there. The trash planner now refuses a
source on that filesystem before probing any layout. The renderer opens the
permanent-delete confirmation when every selected entry is under
`/run/user/<uid>/gvfs/<backend>/`. The mount table stays the authority, so a
path the renderer misclassifies fails closed instead of being silently removed.

Permanent deletion normally captures the entry by renaming it into a fresh
`.tauri-delete-*` sibling and verifying its `EntryVersion` there. On GVfs that
capture proves nothing and can break the deletion:

- gvfsd-fuse returns `st_ino = 0` and libfuse substitutes its path-node id, so
  the inode is the namespace node, not the remote object.
- The staging folder and the rename are remote writes. On Google Drive the
  rename is a `files.update` (parents plus title). GVfs replaces its cached
  entry with the server's response, and `time::modified` comes from that
  entry's `updated` field, so the capture check can see a changed version and
  restore the item instead of deleting it.

On that filesystem, items are removed in place: the selection claims, the full
version and birth-time check immediately before removal, and the walk's depth-1
object admission all remain. A partial walk is reported as uncertain.

Sources checked: GNOME/gvfs `client/gvfsfusedaemon.c` (`file_from_full_path`,
`vfs_mkdir`, `vfs_rename`, `vfs_getattr`) and `daemon/gvfsbackendgoogle.c`
(`move`, `delete`, `query_info`). The Drive modification-time behaviour
was not observed against a live account. Tests use the `Capture::InPlace`
seam and fixture mount records with `fstype fuse.gvfsd-fuse`.

Undo of a copy onto GVfs (`trash_publication`) is still refused by the same
planner check. It now reports that the location has no trash instead of
`ENOENT`.
