# Quick Open in large directories

The active pane already holds direct children in memory, but a broad query can
match thousands of them. Matching a 5,000-entry array is cheap; rendering every
match as a Svelte row is not. Keep the final merged Quick Open list bounded at
the same limit as backend results so immediate local matching cannot turn into
a multi-thousand-node render.

Debouncing prevents searches for intermediate keystrokes, but separate paused
queries still used to walk the same recursive tree repeatedly. Reuse only a
fully completed walk, bound both its lifetime and size, and drop the cache for
watcher changes under its root. Cache only a root with an active watcher; an
unwatched root must keep walking fresh. Capture a per-root invalidation revision
before walking and compare it while holding the cache lock at publication, so a
change that races an in-flight cold walk cannot be overwritten by stale results
and an unrelated root's event cannot discard valid work. Never publish a
cancelled partial walk as a complete listing, and preserve cold-walk streaming
so the first useful matches still arrive before the full scan finishes.

The final watcher reference is also an invalidation boundary. Once the OS watch
is removed, changes during the unwatched gap are invisible; invalidate the
listing and advance its revision before a later watch can reuse it. This also
prevents a cold walk started in the old watch epoch from publishing after an
unwatch/rewatch cycle.

A pane's ordinary filesystem watch is deliberately non-recursive, while the
cached Quick Open listing spans the entire subtree. Cache eligibility therefore
requires a separate recursive invalidation watch for that search root. If that
coverage cannot be installed, walk fresh instead of caching. Keep the recursive
watch separate from pane, thumbnail, and Miller-column refresh watches so many
visible child folders do not create overlapping recursive watcher trees. Remove
the cache watch with the final ordinary watch reference.

Recursive cache roots themselves can overlap when different panes search a
parent and its child. A shared notify watcher cannot treat those registrations
as independent on Linux: unwatching the parent can remove descendant inotify
watches that the bookkeeping still attributes to the child. Rebuild every
surviving recursive registration after one is removed, and invalidate each
survivor's publication revision across that coverage transition. If any
registration cannot be restored, remove its cache eligibility and walk fresh.
