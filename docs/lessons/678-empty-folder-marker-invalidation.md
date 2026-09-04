# Empty-folder marker invalidation

The empty-folder cue is populated by a lazy, bounded-concurrency probe rather
than by directory listings. File-operation broadcasts therefore need to
invalidate the resolver for every affected directory, including the move
destination.

An invalidation must also supersede an in-flight probe. Otherwise a probe that
started before a move can complete afterward and put the old empty result back
in the cache. Keep the per-path version check when changing the resolver's
queue or reset behavior.
