# Linux Trash can open a terminal through the directory MIME default (#757)

The Recycle Bin sidebar action passed the absolute Freedesktop `Trash/files`
directory to `xdg-open`. On the reporter's Arch setup, `inode/directory`
resolved to `kitty-open.desktop` (`Exec=kitty +open %U`). A private Xvfb
reproduction showed `xdg-open` exit successfully and create a Kitty window
at `Trash/files`; the exit status did not mean a graphical file manager opened.
The public #757 screenshot shows that same directory in a terminal. #723 and
#733 report the same symptom.

Use `org.freedesktop.FileManager1.ShowFolders` with `trash:///` to address a
file manager's native Trash view directly. On this host it activated Thunar's
`Trash - Thunar` view with a visible Restore control, even while Kitty remained
the default directory handler. If that service is definitively unavailable,
select an installed desktop entry
explicitly categorized `FileManager`, reject terminal entries, and launch it
with the absolute Trash directory file URI. Accept both URI-capable (`%U`, as
in Thunar) and file-capable (`%F`) desktop entries; passing only `gio::File` to applications
that advertise `supports_files` skips Thunar entirely. Do not fall back to
generic directory MIME dispatch.
Treat a D-Bus timeout or uncertain reply as an error rather than starting a
second manager that might duplicate a delayed window.

The private-display reproduction and FileManager1 proof are in
`/tmp/alpha-trash-diagnostic/` and `/tmp/alpha-filemanager1-diagnostic/`.
An initial `trash:///` diagnostic lost its screenshot to a disk quota error;
a later private Thunar window capture confirmed the native Trash view and
Restore control. The previous file-URI implementation was also exercised
through the rebuilt Tauri debug app and opened Thunar's ordinary `Trash/files`
directory. The rebuilt debug app's native-URI route opened `Trash - Thunar`;
selecting only the disposable probe and clicking Restore returned its exact
bytes to the original path and removed its Trash payload and metadata.
Redacted screenshots are in `screenshots/fix/linux-trash-native-view/`. This
is local debug-binary proof on Arch/Thunar; the exact published release asset
still needs the same Trash/restore smoke before admitting testers.
