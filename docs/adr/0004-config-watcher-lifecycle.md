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
refresh worker. The worker re-resolves symlink targets every two seconds.
`init_config_watcher` retains that handle in `CONFIG_WATCHER` for the process
lifetime; test callers retain their own handle. Dropping the handle wakes and
joins the worker, so no refresh callback outlives teardown.

Retargeting establishes all new native coverage before publishing the new plan
and removing obsolete watches. A failed registration leaves the previous plan
active for retry. Failed removals remain tracked separately from the current
plan and are retried; successful retargets do not retain historical roots.
Shared file parents and theme directories use stable recursive coverage so one
role cannot downgrade another role's watch. The current plan filters delayed
old-target events by canonical target equality. Callbacks run outside the
watch-state lock. Runtime watcher errors are logged with the config path;
access-only events remain filtered because they do not change config content.

## Consequences

- Retargets are eventually observed within the two-second refresh cadence.
- The watcher handle is the owner of both native watch lifetime and refresh
  worker shutdown; callers must retain it for as long as events are needed.
- Integration tests use this same lifecycle instead of a separate notify setup.
- Repeated retargets retain current coverage and outstanding failed removals,
  rather than every previously visited root. Replacement, failure/retry and
  teardown tests include a real Linux symlink handover.
