# Linux Recycle Bin launcher fallback

`gio open trash:///` can spawn successfully while its desktop handler rejects
the URI. For the Recycle Bin action, wait for that short-lived probe and fall
back to `xdg-open` on an absolute `$XDG_DATA_HOME/Trash/files`, or the absolute
`~/.local/share/Trash/files` default when the XDG variable is empty or relative.
If neither location can be resolved, return an error rather than opening a path
relative to the app's working directory.
