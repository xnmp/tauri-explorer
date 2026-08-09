# ADR 0004: Config watcher lifecycle and symlink refresh

Status: Accepted

Governs: `src-tauri/src/config_watch.rs`

## Context

Config files and theme directories may be symlinks into a dotfiles checkout.
Platform watcher backends do not reliably report writes made directly to those
external targets when only the config directory is watched. A target can also
be retargeted while the app is running.

## Decision

`watch_config_changes` owns the native watcher and a process-independent
refresh worker. The worker re-resolves symlink targets every two seconds and
adds watches for newly resolved external roots. `init_config_watcher` retains
that handle in `CONFIG_WATCHER` for the process lifetime; test callers retain
their own handle, and dropping it asks the worker to stop on its next cadence.

Existing external watches are deliberately not removed during a retarget.
An editor can still write an old target during the handover. The current watch
plan filters those stale events by canonical target equality, so retaining the
old native watch avoids a blind interval without producing a reload for the
wrong config file. Runtime watcher errors are logged with the config path;
access-only events remain filtered because they do not change config content.

## Consequences

- Retargets are eventually observed within the two-second refresh cadence.
- The watcher handle is the owner of both native watch lifetime and refresh
  worker shutdown; callers must retain it for as long as events are needed.
- Integration tests use this same lifecycle instead of a separate notify setup.
