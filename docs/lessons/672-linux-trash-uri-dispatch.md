# Linux trash URI dispatch is not handler success

On Linux, a launcher exit status can cover only the handoff to the registered
desktop application. The application may reject `trash:///` after the launcher
has already exited successfully, so waiting longer on that process cannot make
the URI probe reliable.

Avoid the unobservable handoff: resolve the absolute Freedesktop
`Trash/files` directory and launch that path directly. Regression coverage
should make the old URI dispatch look successful and assert that it is never
selected.
