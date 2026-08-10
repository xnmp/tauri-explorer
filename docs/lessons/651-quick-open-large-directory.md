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
unwatched root must keep walking fresh. Capture an invalidation revision before
walking and compare it while holding the cache lock at publication, so a change
that races an in-flight cold walk cannot be overwritten by stale results. Never
publish a cancelled partial walk as a complete listing, and preserve cold-walk
streaming so the first useful matches still arrive before the full scan finishes.
