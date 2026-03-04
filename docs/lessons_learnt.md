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

## tauri-qz5t: Copy/Paste Folder with Files Not Working

**Key takeaways:**

- `fs_extra::dir::copy(src, dest, options)` with default `CopyOptions` copies `src` INTO `dest` as `dest/source_name/`. If `dest/source_name/` already exists, it fails because `overwrite` and `skip_exist` default to false.
- For same-directory copies (where collision handling renames to "name - Copy"), passing `target.parent()` to `fs_extra` still creates the original name, conflicting with the source. Fix: `fs::create_dir_all(target)` + `content_only = true` to copy contents directly into the renamed target.
- Same issue exists in cross-filesystem `move_entry` fallback.

---

## tauri-6yzm / tauri-o5ny: Paste Duplicates 3 Times

**Key takeaways:**

- Keyboard shortcuts can fire through multiple layers: component `onkeydown` → parent `onkeydown` → global `window.addEventListener("keydown")`. `preventDefault()` does NOT prevent bubbling. `stopPropagation()` is a band-aid, not a fix.
- The proper solution: have ONE canonical handler (the global keybinding system via `command-definitions.ts`) and remove all duplicates from component-level keydown handlers. Only keep handlers in components for shortcuts that need local state context (e.g., ArrowUp/Down for list navigation needs current selection index).
- For UI feedback (toasts) that was previously in the inline handler: use reactive state. `paste()` writes to `explorer.pasteResult`, and FileList observes it via `$effect`. This decouples feedback from the shortcut handler entirely.

---

## tauri-n5sr: Tiles View Drag Selection Mismatch

**Key takeaways:**

- Marquee selection using `getSelectedIndices(scrollTop, totalItems)` with `index = floor(marqueeTop / itemHeight)` only works for linear lists with fixed row height. CSS grid layouts (tiles view) need DOM-based hit testing using `getBoundingClientRect()` and AABB intersection.
- `getBoundingClientRect()` returns viewport-relative coordinates, automatically accounting for scroll position.

---

## tauri-phud: Delete Multiple Selected Files

**Key takeaways:**

- The Rust backend already had `move_multiple_to_trash` using `trash::delete_all()` but it was never wired to the frontend. Always check existing backend capabilities before adding new commands.
- When extending a single-entity dialog to support multiple entities, adding a parallel array (`targetEntries`) alongside the existing `targetEntry` maintains backward compatibility while enabling batch operations.
- After batch deletion, remember to also clean up `selectedPaths` to remove references to deleted files.

---

## tauri-fadw: Architecture Improvements Epic (10 tasks)

**Key takeaways:**

- `HashMap::new()` is not a const fn in Rust, so `Mutex::new(HashMap::new())` can't be used in `const fn`. Use `OnceLock` with lazy initialization instead for static registries.
- When consolidating keyboard shortcuts, make the resolver when-aware (pass an `isAvailable` predicate to `findMatchingCommand`) rather than relying on registration order. This allows the same key to have different bindings in different contexts.
- Replacing `window.dispatchEvent(new CustomEvent(...))` with a typed store (dialogStore) catches broken event names at compile time and makes dialog state observable in devtools.
- `explorer.state.X` indirection creates confusion when it mixes per-pane state with global store state. Promoting commonly-used fields to top-level getters (`explorer.currentPath` instead of `explorer.state.currentPath`) reduces coupling.
- When creating a shared error type (`AppError`), implementing `From<String>` and `From<io::Error>` eliminates most `.map_err()` calls, making the migration much less invasive.
- FileItem-level keyboard handlers easily fall out of sync with the global command system. Prefer a single source of truth for keyboard shortcuts.

---

## tauri-pghn / tauri-enf4: Themed Icons via CSS Variables

**Key takeaways:**

- To make inline SVG icons themeable, use `fill="currentColor"` and set the `color` CSS property via CSS custom properties. This allows a cascade: `color: var(--icon-file-tint, var(--file-icon-color, var(--text-secondary)))` where themes can override all icons at once (`--icon-file-tint`) or let per-extension colors shine through.
- CSS variables can control `display` property to toggle between UI variants (e.g., chevron vs powerline breadcrumbs) without JavaScript: `display: var(--breadcrumb-chevron-display, flex)`.
- When adding theme-specific features, use CSS variables with sensible defaults so existing themes continue to work without modification.

---

## tauri-vozb: Symlink Detection in Rust

**Key takeaways:**

- `fs::metadata()` follows symlinks, returning the target's metadata. Use `fs::symlink_metadata()` to detect symlinks themselves without following them.
- On Unix, `std::os::unix::fs::symlink()` creates symlinks. On Windows, need to distinguish between `symlink_file()` and `symlink_dir()`.

---

## tauri-2dgf: External Drop Modifier Keys

**Key takeaways:**

- Tauri's `onDragDropEvent` doesn't expose keyboard modifier state (Ctrl, Shift). To detect modifiers during external drops, track them globally via `keydown`/`keyup` listeners with `capture: true`.
- Use the same modifier convention as internal drags (default=move, Ctrl=copy) for consistency.

---

## tauri-ti0l: File-Based Config Persistence

**Key takeaways:**

- For Tauri apps, `dirs::config_dir()` gives the platform-appropriate config directory (`~/.config` on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows).
- Write-through persistence (save to both localStorage sync and config file async) provides the best of both: instant state for the UI and durable storage on disk.
- When migrating from localStorage to file-based storage, check the config file first, then fall back to localStorage for migration.

---

## tauri-5hlj / tauri-ksp2: Address Bar "/ >" Prefix and Triangles

**Key takeaways:**

- Breadcrumb separators rendered as literal "/" text before the first segment created a confusing "/ >" prefix. Replacing the root crumb's text content with an inline SVG folder icon is cleaner and matches native explorer conventions.
- When using SVG icons inline in Svelte, use `fill="none"` with `stroke="currentColor"` so they inherit the text color from CSS.

---

## tauri-8ytw / tauri-j9aa: Context Menu Not Appearing on Second Click / Missing for Files

**Key takeaways:**

- The ContextMenu backdrop's `oncontextmenu` re-dispatch logic ran `elementFromPoint()` synchronously after calling `contextMenuStore.close()`. But Svelte's reactive DOM updates are batched — the backdrop element was still in the DOM when `elementFromPoint` ran, so it hit the backdrop again instead of the underlying element. Fix: wrap re-dispatch in `requestAnimationFrame` to let Svelte flush DOM removal first.
- The list and tiles view modes rendered file entries as plain `<button>` elements in `FileList.svelte` without `oncontextmenu` handlers. Only the details view (via `FileItem.svelte`) had context menu support. Always audit all view modes when adding interaction features.

---

## tauri-jmcg: Symlink Double-Click Opens Terminal Instead of Navigating

**Key takeaways:**

- **Critical Rust gotcha:** On Unix, `DirEntry::metadata()` is equivalent to `symlink_metadata()` — it does NOT follow symlinks. So a symlink pointing to a directory returns `kind: "file"` because symlinks themselves aren't directories. Use `fs::metadata(entry.path())` to follow the symlink and get the target's metadata.
- Always provide a fallback to `entry.metadata()` for broken/dangling symlinks where `fs::metadata()` will fail.
- This affected both `list_directory` and `start_streaming_directory` — when fixing metadata-related bugs, audit all code paths that read file metadata.

---

## tauri-gkwz: Can't Drag Folders in Tiles View

**Key takeaways:**

- The `FileItem.svelte` component (used in details view) had full drag-and-drop support (`draggable="true"`, `ondragstart`, `ondragover`, `ondragleave`, `ondrop`), but the list and tiles views in `FileList.svelte` rendered entries inline without any drag attributes or handlers. Feature parity across view modes requires explicit wiring of all interaction handlers.
- Per-entry drop target state (using objects keyed by entry path) avoids the problem of a single boolean flag being shared across all entries, which would cause all items to highlight when dragging over any one of them.

---

## tauri-nweq: Cross-Window Drag Doesn't Refresh Source Window

**Key takeaways:**

- The HTML5 `dragend` event fires on the source element regardless of whether the drop target is in the same window, a different window, or even a native file manager. Use `ondragend` to clean up drag state and trigger a refresh of the source pane's directory listing.
- Both `FileItem.svelte` (details view) and `FileList.svelte` (list/tiles views) need the `ondragend` handler — same view-mode parity issue as context menus and drag-start.

---

## tauri-vmpc: Copy/Cut Freezes Window ($effect Infinite Loop)

**Key takeaways:**

- **Svelte 5 `$effect` + store mutation = infinite loop.** If an `$effect` calls a store method that internally reads `$state` (e.g., `toasts.filter(...)` for deduplication), Svelte tracks that `$state` as a dependency of the effect. When the store writes to the same `$state`, the effect re-runs, calling the store again — infinite loop.
- **Prefer imperative toast calls over reactive watching.** Instead of `$effect(() => { if (clipboardChanged) toastStore.show(...) })`, call `toastStore.show(...)` directly where the state change happens (e.g., inside `copyToClipboard()`). This is simpler, avoids reactive pitfalls, and makes the data flow explicit.
- **If you must call a store from `$effect`, wrap it in `untrack()`.** `untrack(() => toastStore.show(...))` prevents Svelte from tracking the store's internal reads as dependencies of the effect.
- **Synchronous Tauri commands block the main thread.** All Tauri 2 commands that do blocking I/O (subprocess spawning, file reads) should be `async fn` to run on a worker thread instead of the main thread.
- **Playwright + Chromium headless: `keyboard.press("Control+c")` hangs.** Chromium's native clipboard implementation blocks in headless mode. Use `page.evaluate(() => el.dispatchEvent(new KeyboardEvent(...)))` instead to test keyboard shortcuts that involve Ctrl+C/X/V.

---
