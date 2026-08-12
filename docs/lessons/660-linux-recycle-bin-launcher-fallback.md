# Linux Recycle Bin launcher fallback

`gio open trash:///` can spawn successfully while its desktop handler rejects
the URI. For the Recycle Bin action, wait for that short-lived probe and fall
back to `xdg-open` on `$XDG_DATA_HOME/Trash/files` (or
`~/.local/share/Trash/files`) when it fails. Return a failure only if neither
launcher succeeds so the sidebar can give the user an error toast.
