# #1937 — Edited files kept their stale thumbnail

**Symptom.** After a file's contents changed (edited elsewhere, overwritten by
paste/move, re-exported), its tile or row thumbnail kept the old image until
restart or LRU eviction.

**Cause.** The backend thumbnail caches already key on mtime + length, so a
fresh request regenerates. The frontend blob-URL cache and the shared
`thumbnail-loads` flights were keyed `${kind}:${path}:${size}:${quality}`, with
no content version, and only the image crop invalidated them. A refreshed
listing with a new mtime therefore produced the same key, and both the mounted
tile (`loadedKey`) and remounts reused the cached blob URL.

**Fix.** `thumbnailCacheKey` appends `@${thumbnailVersion(entry)}` (mtime ms +
byte length, no `:` so `keyPath` still parses) and `TileVisual`/`RowThumbnail`
pass the entry's version to `ThumbnailImage`. A version change is a new key: the
mounted tile reloads, nothing needs a new invalidation path, and caching a newer
version drops and revokes the older one. Explicit invalidation stays for the
crop (#1267), whose replacement can keep the same mtime and size.

**Rule.** Any frontend cache of content derived from a file must key on (or be
invalidated by) its content version, not its path alone.

Tests: `tests/state/thumbnail-cache.test.ts` (content-versioned keys),
`e2e/thumbnail-content-refresh.spec.ts` (fails with the component change reverted).
