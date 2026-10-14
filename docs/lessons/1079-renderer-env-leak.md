# 1079: app-set WebKitGTK renderer variables leaked to children

`webkit_renderer::apply()` sets `WEBKIT_*` variables in the app's own env, so every
child inherited them. Now `child_env` records only the variables the app set (never
user-set ones) and `scrub_command`/`scrub_pty`/`scrub_names` strip them at launch seams
(terminal, external_apps, Linux trash launcher via `AppLaunchContext::unsetenv`).
`TAURI_EXPLORER_WEBKIT_RENDERER_APPLIED` marks them so a self-restarted process does not
read inherited app choices as "set by the user". `opener::open` (xdg-open) has no env hook
and still inherits them.
