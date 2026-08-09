# #604 — config autoreload follows individual symlink targets

Watching the canonical config directory does not make an inotify watcher see
writes made directly to the target of an individual symlinked file. Resolve
each reloadable config file and the `themes/` directory at watch time; when a
canonical target is external, watch its parent (or the themes directory) and
map events by canonical-path equality.

Dotfile managers can retarget links while the app is running. Re-resolve the
watch plan periodically, add watches for newly selected external roots, and
keep stale roots filtered by the current plan so a handover has no event gap.

The regression test must write through the external target, rather than the
symlink path: that is the filesystem event shape that the original config-root
watch silently missed.
