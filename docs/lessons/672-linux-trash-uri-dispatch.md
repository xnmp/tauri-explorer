# Linux trash URI dispatch is not handler success

On Linux, a launcher exit status can cover only the handoff to the registered
desktop application. The application may reject `trash:///` after the launcher
has already exited successfully, so waiting longer on that process cannot make
the URI probe reliable.

Avoid the unobservable handoff: resolve the absolute Freedesktop
`Trash/files` directory and launch that path directly. Regression coverage
should make the old URI dispatch look successful and assert that it is never
selected.

The earlier `xdg-open` absolute-path launcher was superseded by #757 because
its directory MIME default could be a terminal. FileManager1 now receives
`trash:///` directly; on the tested Thunar desktop this opens the native Trash
view. A graphical-file-manager fallback receives the absolute directory only
when the service is definitively unavailable. The old launcher integration
test was removed with that implementation; see the #757 lesson and current
unit/native checks.
