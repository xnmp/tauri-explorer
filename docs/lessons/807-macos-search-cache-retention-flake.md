# 807 — Isolate exact cache-reuse assertions from older parent events

The real streaming-search integration test shares one watched parent between
several roots. On macOS, a filesystem event accepted by that parent watch can
be delivered after a later sibling root is registered. The watcher must treat
that event conservatively: if its path is now inside the registered root, it
invalidates the recursive search cache.

That behavior is safe, but it made the owner-retirement section attribute an
unrelated cache invalidation to retiring one of two owners. The product still
had a live lease and valid recursive coverage; the next query correctly chose
a fresh scan after the delayed event.

Exact scan-count assertions need an independent parent when they are measuring
lease retirement rather than watcher delivery. Keep the retirement fixture in
its own temporary directory. Do not suppress native events, weaken cache
invalidation, or wait for an assumed quiet period: event latency has no stable
time bound.
