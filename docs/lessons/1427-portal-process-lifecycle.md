# FileChooser portal process lifetime

The D-Bus-activated portal backend (`tauri-explorer --file-chooser-portal`)
never exited: setup served the bus name with a forgotten connection, and the run
loop prevented every `ExitRequested`. A process activated once lived for the
whole session, survived package upgrades running the unlinked binary
(`/proc/<pid>/exe … (deleted)`), and one that lost the bus-name race stayed
alive serving nothing.

Activated session services follow GApplication's hold/release plus inactivity
timeout: `portal/idle.rs` holds the process for each request and for each
picker window until it is destroyed (closing is asynchronous and outlives the
reply), arms a generation-checked timer when the last hold ends, then releases
the bus name **before** exiting so the next request activates a fresh, current
binary. Requests delivered before the release are still served. A replaced
executable skips the delay. A hold ends when the zbus handler returns, which is
before zbus writes the reply, so exit first awaits `graceful_shutdown()` (in-
flight dispatch keeps a strong connection reference; bounded) and only then
calls `app.exit(0)`; the run loop prevents only `ExitRequested { code: None }`
(last picker closed). zbus 5.19's builder `.name()` queued a second backend
despite its docs: request the name with `DoNotQueue` and exit on `NameTaken`.

The suspected plugin-profile lock contention was not the portal: plugin
initialisation has returned early in portal mode since the lock existed (#998),
and an isolated repro with a picker window open showed no lease file and a
normal instance taking ownership. `bootstrap_services_in` now refuses ownership
in portal mode for every entry point (including IPC-triggered retries), so a
future picker-side plugin call cannot change that. The lease is a `flock` on
`<config>/tauri-explorer/.plugin-runtime.lock`; `/proc/locks` names the holder
PID by inode when diagnosing a real refusal. A different session bus (e.g.
`xvfb-run`/`dbus-run-session` test runs on the real profile) bypasses
single-instance routing and can hold it.

Test the lifetime against the real binary on a private bus with private XDG
roots: `bun run test:portal-lifecycle` (needs `xvfb-run`; the idle delay is
shortened through the debug-only `TAURI_EXPLORER_PORTAL_IDLE_MS`).
