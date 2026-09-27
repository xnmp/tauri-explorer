# 807 — Isolate exact cache-reuse assertions from older parent events

The real streaming-search integration test shares one watched parent between
several roots. The observed macOS-only extra scan is consistent with a
filesystem event from
that shared parent being delivered after a later sibling root is registered.
The watcher must conservatively invalidate the recursive search cache when a
delivered path is inside a currently registered root. The CI trace did not
record event identity or delivery time, so this delayed-event mechanism remains
plausible rather than proven.

Regardless of which shared-parent event caused the invalidation, the
owner-retirement section could attribute unrelated fixture activity to retiring
one of two owners. The product still had a live lease and recursive coverage;
the extra scan alone did not show that owner retirement removed either.

Exact scan-count assertions need an independent parent when they are measuring
lease retirement rather than watcher delivery. Keep the retirement fixture in
its own temporary directory. Do not suppress native events, weaken cache
invalidation, or wait for an assumed quiet period: event latency has no stable
time bound.
