# #1014: going back to a large image showed the spinner again

**Symptom:** you preview a large image, step to another one, then come back.
The spinner appeared again, as if the first image had never been loaded.

**Cause:** `PreviewPane.svelte` kept no record of the images it had shown, so
every selection ran the whole load again:
- First, a `get_preview_image` request. It goes through the pane's latest-only
  runner (`domain/latest-only.ts`), so it waits behind the rendition decode
  that is still running for the image you just left. A cold PNG rendition
  takes 400–690 ms.
- Then a fresh asset fetch and off-screen `img.decode()`, or a backend read of
  up to 32 MB through the blob fallback.

Either step easily passes the 150 ms spinner deferral. The backend's rendition
disk cache did not help, because the wait is in front of it, in the queue and
the webview decode.

**Fix:** `state/preview-image-cache.ts` is one per pane and is cleared on
unmount.
- It remembers each image the pane showed, keyed by:
  - path;
  - `cacheBust` (mtime, size and local preview revision);
  - what the image is (`original` or `edge:N`).
- On a revisit `loadPreview` consults it synchronously, before any await. A
  hit shows the image in the same update, with no request, so the spinner and
  `aria-busy` never flip.
- A rendition request also accepts a remembered original. An original request
  (fullscreen) never accepts a rendition.
- The fullscreen/zoom upgrade checks the cache first, and the original it
  swaps in is remembered too.

**Ownership:** blob URLs move from `preview-lifetime` to the cache, through
`disownBlob`, at the moment of publication (the load is ready and current).
- From then on the lifetime never revokes them.
- Showing a cached image calls `clearBlob()`, which releases anything the
  lifetime still holds (an audio cover-art blob, for example).
- The cache revokes a blob on eviction, and only when no other entry shares
  the URL. It also revokes on `clear()`. The existing E2E check that "every
  image blob is revoked when the pane unmounts" still holds because of this.

**Bounds:** at most 16 entries and 48 M decoded pixels, least recently used
evicted first.
- The most recent entry, the one on screen, is never evicted, even when it is
  larger than the whole budget.
- Storing a new version of a file drops that file's older versions straight
  away.

**Test seam:** `e2e/preview-image-revisit.spec.ts` gives one image a 1.5 s
mock read and counts the reads. It then samples every animation frame across
the revisit. If the cache is reverted, the revisit shows `aria-busy="true"`
and the spinner, and makes a second read.
