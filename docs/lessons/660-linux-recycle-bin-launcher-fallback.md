# Linux Recycle Bin launcher fallback

`gio open trash:///` can spawn successfully while its desktop handler rejects
the URI. Waiting for `gio` only observes successful dispatch, not the later
handler result, so the Recycle Bin action must not send that URI at all.

Open an absolute `$XDG_DATA_HOME/Trash/files` through `xdg-open`, or use the
absolute `~/.local/share/Trash/files` default when the XDG variable is empty or
relative. If neither location can be resolved, return an error rather than
opening a path relative to the app's working directory.

#757 supersedes the `xdg-open` launch step: a directory MIME default can be
a terminal. Keep the absolute Trash directory resolution, then send its file
URI `trash:///` directly to FileManager1. If that service is definitively
unavailable, choose an installed graphical `FileManager` desktop entry for
the absolute Trash directory. See the #757 lesson.
