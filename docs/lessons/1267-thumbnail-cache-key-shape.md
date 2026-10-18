# #1267: thumbnail-cache invalidation never matched

`invalidateThumbnailCache(path)` tested `key.startsWith(path + ":")`, but the cache is keyed by `ThumbnailImage`'s reload key, `${kind}:${path}:${backendSize}:${quality}`. The unit tests used a made-up `path:size:quality` shape, so they agreed with the buggy matcher and a crop never dropped anything.

- Match the path segment (`keyPath` in `state/thumbnail-cache.ts`): kind before the first `:`, size and quality after the last two. Paths may contain `:` (Windows drives), so never split on every colon.
- Dropping the entry is not enough for a mounted tile: its key is unchanged, so its load effect would not run again. Tiles subscribe through `subscribeThumbnailInvalidation` and reload when their path is invalidated.
- Tests must use the real key shape (`image:/dir/a.png:64:80`). `renameThumbnailCache` had the same stale assumption (and legacy-shaped tests); it now uses `keyPath` too and does not notify invalidation subscribers, since a rename keeps the pixels.
- Not covered: a load already in flight when the crop lands can still publish pre-crop pixels to the cache afterwards.
