# #1691 — AppImage launches opened their own mount

AppImage's AppRun changes into `$APPDIR/usr` before exec'ing the binary, so a
launch with no path argument inherited `/tmp/.mount_tauri-XXXX/usr` as its cwd.
`system::is_launcher_artifact_cwd` only rejected `/` and the executable's own
directory (`usr/bin`), so the first tab opened inside the image.

The predicate now also rejects any cwd inside an AppImage mount: this
process's `$APPDIR`, or any `.mount_*` ancestor holding an `AppRun` entry.
The second check matters for single-instance handover (`window_launch`): a
second launch arrives with *its own* mount as cwd, which never matches the
running instance's `$APPDIR`. A `.mount_*` folder without `AppRun` and a
relative or root `$APPDIR` stay ordinary launch locations.
