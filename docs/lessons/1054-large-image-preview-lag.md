# #1054 — Large wallpapers made the Preview pane lag

**Symptom:** in a folder of 33–50 MP wallpapers (PNGs up to 7826×5220 / 47 MB)
with the Preview pane on, every arrow-key step was slow and the UI hitched.

**Measured cause:** the pane loaded the full-resolution original through the
asset protocol (`state/preview-image.ts` → `convertFileSrc`). On WebKitGTK a
7680×4320 PNG took 650–1550 ms per step to become ready, with main-thread
frame stalls up to 1.6 s. `img.decode()` did not keep that work off the main
thread. A ~2048 px rendition of the same image was ready in 60–290 ms.
(Scroll, marquee and context-menu lag in the same folder is a separate renderer
issue.)

**Fix:** this follows what Quick Look and Explorer's preview do. The pane shows
a display-sized rendition and loads full resolution only when asked.
- `get_preview_image` (`src-tauri/src/thumbnails/preview_rendition.rs`) reads
  only the header. It returns `original` in these cases:
  - the image already fits the requested edge (it never upscales);
  - it is animated (GIF, APNG, animated WebP);
  - it is AVIF or SVG, or another format the webview has to render itself;
  - it is a non-JPEG with an EXIF orientation tag, because webviews disagree
    about how to apply it.
- Otherwise it decodes once through the decode gate, area-downscales the image
  and caches a JPEG (q88, turbojpeg). It caches a PNG instead when any pixel is
  translucent. Before encoding, it rotates JPEG renditions upright according to
  their EXIF tag, because webviews apply that tag when they show the original.
- The cache is the tile-thumbnail cache, with a namespaced key built from path,
  mtime, length, edge and version. Writes are atomic and use the same inflight
  lock.
- Pruning now also triggers on bytes written. The old trigger was every 256
  writes, which suited small thumbnails but would let multi-MB renditions
  overshoot the cap by gigabytes.
- Cold generation, measured on the real wallpapers off the main thread: PNG
  400–690 ms, JPEG ~210 ms (helped by the DCT-scaled decode). A cache hit takes
  ~40 µs.
- Two cheaper choices replaced the first ones:
  - Area-averaging (`thumbnail_exact`) replaced Catmull-Rom (~1.2 s on 33 MP).
  - turbojpeg replaced the image crate's JPEG encoder (~300 ms for a 2048 px
    frame).
- `domain/preview-rendition.ts` picks the edge. It takes the surface's CSS size
  × devicePixelRatio × app zoom and quantises it to 1024, 2048 or 3072, so
  resizing the pane reuses one cached rendition.
- `domain/latest-only.ts` keeps one backend request in flight per pane. Of the
  requests waiting behind it, only the newest runs. Selections skipped while
  an arrow key repeats never queue decode work, so the image the user stops on
  doesn't wait behind them. A Tauri command can't be cancelled once its
  blocking task starts.
- Fullscreen and zoom need the original. When the viewer is already
  fullscreen, a load asks for the original directly. Otherwise
  `state/preview-resolution.ts` decodes the original off-screen while the
  rendition stays on screen, then swaps it in. It does this once per shown
  rendition, under the same preview-lifetime owner, so a stale load can't land
  on a newer file.
- Every rendition failure falls back to the original chain (asset protocol,
  then backend read). That covers a header that can't be read, a decode error,
  a pruned file, and a cache directory outside the asset scope.
- Plugin targets keep their existing flow: a 1024 px thumbnail in the pane and
  the original in fullscreen.

**The trap a mock E2E cannot catch: the asset scope skips dot-directories.**
The first version passed every test and still did nothing on Linux. Every
rendition got a 403 from the asset protocol, and the pane quietly fell back to
the original, after already paying for the backend decode.
- Tauri 2 scope globs default to `require_literal_leading_dot = true` on Unix
  (`tauri/src/scope/fs.rs`). As a result the configured `$HOME/**/*` never
  matches `~/.cache/tauri-explorer/...`. It also misses an `XDG_CACHE_HOME`
  outside `$HOME`.
- The fix is in `lib.rs` setup, before any window exists.
  `allow_rendition_assets` creates the `previews/` cache directory. It then
  calls `asset_protocol_scope().allow_directory(dir, false)` for both the given
  and the canonical spelling, because `is_allowed` canonicalises the request
  path.
- Do not disable `requireLiteralLeadingDot` globally. That would expose every
  dotfile under `$HOME` to the webview.
- `the_asset_scope_serves_renditions_under_a_dot_cache_directory` builds a
  scope shaped like the app's config, using `tauri::test::mock_app`. It
  asserts three things:
  - the configured glob alone rejects the rendition;
  - the helper admits it;
  - other dot-paths stay out.
- Any file the webview loads from a hidden directory needs the same check.

**Hardening from the adversarial review:**
- JPEG headers are read from a bounded 2 MiB prefix after the file-size check.
  image's `JpegDecoder::new` reads its whole input into memory.
- ICC profiles are embedded: PNG through the encoder, JPEG as APP2 segments
  after turbojpeg. CMYK/YCCK JPEGs keep the original.
- Alpha images are downscaled premultiplied. Plain box averaging bleeds the
  colour of transparent pixels into the edges.
- EXIF rotation happens after the downscale.
- JPEGs use 4:4:4 chroma.
- Renditions get their own `previews/` subdirectory and 300 MB budget, so they
  cannot evict tile thumbnails.
- The frontend skips the request for extensions that never get a rendition,
  and for virtual paths.
- The full-resolution swap re-checks that the viewer still wants it and that
  the load is current.

**Why the perf tests missed it:** `mock-invoke.ts` serves the same 128 px JPEG
for every image preview (`read_image_data_url` reuses the thumbnail mock), and
the browser suites run in Chromium. Nothing in the gated suites ever decoded a
multi-megapixel image on WebKitGTK. To catch preview cost, measure it in the
real app with real large files. Don't use the browser perf suites for it.
