# Lessons Learnt

Gotchas, non-obvious behaviors, and key takeaways from closed issues.

---

## tauri-explorer-rdra / tauri-explorer-za55: OS Clipboard Integration

**Key takeaways:**

- When implementing dual clipboard support (internal app clipboard + OS system clipboard), make sure UI guards check **both** sources. The paste handlers were gated on `clipboardStore.hasContent` which only checked the internal clipboard, silently blocking the OS clipboard fallback path that was already correctly implemented in `paste()`.
- `tauri-plugin-clipboard-x` requires both the Rust crate (`tauri-plugin-clipboard-x = "2"` in Cargo.toml) **and** the JS API bindings package (`tauri-plugin-clipboard-x-api` in package.json). Missing the npm package causes module resolution failures at build time.
- Context menus should always show "Paste" (like native file explorers) rather than conditionally hiding it — the paste handler already returns appropriate error messages when nothing is available.

---

## tauri-ygaq: Content Search Performance Optimization

**Key takeaways:**

- `grep-searcher`'s `Searcher::new()` allocates internal buffers. Creating one per file is wasteful -- create once per worker thread in the `walker.run(|| { ... })` closure (before the `Box::new(move |entry| { ... })` closure).
- `MmapChoice::auto()` is `unsafe` because the caller must ensure the file isn't mutated during search. In a read-only search context this is safe and provides significant speedup. On macOS the crate silently disables mmap regardless.
- `BinaryDetection::quit(b'\x00')` stops searching a file on first NUL byte. Combined with the extension-based `is_binary_file()` pre-filter, this is a two-layer defense against wasting time on binary files.
- `RegexMatcherBuilder` is cleaner than manually prepending `(?i)` and toggling between `RegexMatcher::new` vs `new_line_matcher`. Always set `.line_terminator(Some(b'\n'))` for consistency.
- Svelte 5 `$derived.by()` re-runs on every reactive dependency change. For content search with streaming batches, this caused O(total) work on every batch arrival. Solution: use a non-reactive backing array (`let allFlattened: T[] = []`) and only expose a reactive page slice (`let flattenedResults = $state<T[]>([])`).
- Adaptive batch intervals (50ms then 150ms) give fast first-paint while reducing steady-state event frequency.
- `floor_char_boundary()` (stable in Rust 1.93) is essential for truncating strings at valid UTF-8 boundaries.

---

## tauri-qbx6: PNG Image Previews Not Working

**Key takeaways:**

- The `image` crate's JPEG encoder doesn't handle RGBA (transparency) images. When generating thumbnails from PNG files, you must convert `DynamicImage::ImageRgba8` to `DynamicImage::ImageRgb8` before writing to JPEG format, otherwise the encoder may fail or produce corrupt output.
- Match on `DynamicImage::ImageRgba8(_) | ImageRgba16(_) | ImageRgba32F(_)` to cover all RGBA variants.

---

## tauri-1rzt: Laggy Image Previews

**Key takeaways:**

- In tiles view, every `ThumbnailImage` component fires its `$effect` on mount, causing N concurrent Tauri IPC calls for N images. `IntersectionObserver` with a `rootMargin` of `200px` defers loading until thumbnails are near the viewport, dramatically reducing initial load.
- The observer should be disconnected after first intersection (`observer.disconnect()` inside the callback) to avoid ongoing observation overhead.

---

## tauri-phud: Delete Multiple Selected Files

**Key takeaways:**

- The Rust backend already had `move_multiple_to_trash` using `trash::delete_all()` but it was never wired to the frontend. Always check existing backend capabilities before adding new commands.
- When extending a single-entity dialog to support multiple entities, adding a parallel array (`targetEntries`) alongside the existing `targetEntry` maintains backward compatibility while enabling batch operations.
- After batch deletion, remember to also clean up `selectedPaths` to remove references to deleted files.

---
