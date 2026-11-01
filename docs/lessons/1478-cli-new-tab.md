# `--new-tab` command-line launches (#1478)

The first process and the Linux single-instance callback both read the command
line. They used to read `argv[1]` independently, so any leading flag (such as
`--new-tab`) silently dropped the path and opened the working directory. Both
now go through `launch_args::parse`: flags in any position, unknown `--flags`
ignored, `--` ends options, first positional wins.

`--new-tab` only matters to an already-running instance. The first process
opens its window at the path exactly as before; the flag travels through the
forwarded argv into `window_launch::LaunchRequest { path, newTab }`, and the
target window's `native-launch.ts` receiver calls `windowTabsManager.createTab`
instead of `openNewWindow`.

Choosing the target by `is_focused()` alone is wrong for this feature: a
terminal launch arrives while the terminal holds focus, so the old fallback
(first visible window in `HashMap` order) picked an arbitrary window. Explorer
window focus is now recorded in `FocusHistory` from `WindowEvent::Focused(true)`
(pruned on `Destroyed`), and `choose_target` prefers focused → most recently
focused → lowest-label visible Explorer window. Parked warm windows are hidden
and never eligible. With no visible Explorer window the request downgrades to a
window launch, since a tab needs a shown window to live in.

Routing is Linux-only (`tauri-plugin-single-instance` over D-Bus, per profile);
on macOS/Windows each launch is its own process and the flag has no effect.
Focus stealing prevention (GNOME/Mutter) may turn `set_focus` into an
attention request rather than raising the window; that limit is shared with the
existing new-window handoff.
