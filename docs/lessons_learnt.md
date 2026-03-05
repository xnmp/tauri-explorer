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

## Mock `create_directory` Missing Duplicate Check

**Key takeaways:**

- The inline new folder input has both `onkeydown` (Enter) and `onblur` handlers that call `confirmNewFolder()`. When Enter triggers `createFolder()` → sets `isCreatingFolder = false` → removes the input from DOM → `onblur` fires → `confirmNewFolder()` runs a **second time**. In the real Tauri app the OS rejects the duplicate (`EEXIST`), so this is harmless. But the mock had no such guard, silently creating two entries with the same path.
- Duplicate entries with the same `path` break Svelte's `{#each ... (key)}` rendering (VirtualList uses `entry.path` as key). This causes the entire file list to stop responding to clicks — selection, context menus, and navigation all fail.
- Mock API handlers should mirror real backend error semantics (idempotency, conflict detection) to avoid hiding bugs that only manifest in test environments.
- When an `onblur` handler does the same work as an `onkeydown` handler (common pattern for "confirm on Enter or blur"), the blur will always fire redundantly when Enter removes the element from DOM. Either guard against double execution or make the operation idempotent.

---

## Enter Key Leaking Through Modal Dialogs to Global Command Handler

**Key takeaways:**

- The DeleteDialog handles Enter via `onkeydown` to confirm deletion, but doesn't call `stopPropagation()`. The Enter event bubbles up to `+page.svelte`'s global `handleKeydown`, which matches the `file.openSelected` command (shortcut: Enter) and calls `navigateTo()` on the selected entry — the very folder being deleted. This causes "Path not found" because `navigateInternal` tries to list the now-deleted directory.
- The fix is architectural, not per-dialog: the global command handler should skip execution when any modal dialog is open (`dialogStore.hasModalOpen`). This is cleaner than adding `stopPropagation()` to every dialog's keydown handler, and correctly models the semantic that modal dialogs should trap keyboard interaction.
- Hardcoded shortcuts like `Ctrl+,` (settings) and `Ctrl+\` (toggle dual pane) are handled **before** the modal guard, so they remain functional regardless of modal state.
- When debugging event propagation bugs, `console.trace()` in the affected handler immediately reveals the call chain — in this case showing `handleKeydown → executeCommand → file.openSelected → navigateTo` as the unexpected caller.

---

## tauri-lgo0: "Unable to access folder" After Deleting a Folder

**Key takeaways:**

- `refresh()` called `navigateInternal(currentPath)` without handling failure. If the current directory was deleted (by another pane, externally, or via the delete handler), the backend returns `AppError::NotFound` and the UI shows an error instead of recovering. Fix: make `refresh()` async and fall back to the parent directory when `navigateInternal()` returns `false`.
- `navigateAwayIfNeeded()` was a synchronous function that fire-and-forgot an async `navigateTo()` call. This meant the navigation hadn't completed before any subsequent `refresh()` or `refreshAllPanes()` could run, creating a race condition where the stale `currentPath` was used. Fix: make it `async` and `await` it in both callers (`startDelete` and `confirmDelete`).
- In multi-pane setups, deleting a folder from one pane doesn't notify other panes that may be viewing the deleted path. The `refresh()` fallback is the safety net for this scenario.
## tauri-usui: Theme Selector Dropdown Uses Browser-Default Colors

**Key takeaways:**

- Native `<select>` elements inherit CSS custom properties for the closed/collapsed state, but `<option>` elements inside the dropdown render with browser/OS default colors (white bg, black text) unless explicitly styled.
- Fix: add `.theme-select option { background: var(--background-solid); color: var(--text-primary); }` so options match the active theme.
- This is a common issue with Tauri/WebKitGTK — always explicitly style `<option>` elements when using native `<select>` in themed UIs.

---

## WebKitGTK Native Form Controls Ignore CSS Backgrounds on Dark Themes

**Key takeaways:**

- **WebKitGTK renders native `<select>` with its own opaque white background** underneath any CSS `background` you set. Translucent `rgba()` backgrounds (like `--control-fill: rgba(255,255,255,0.08)`) composite over that white base, making the select appear white/light on dark themes. This does NOT reproduce in headless Chromium — always test in the actual Tauri app.
- **Fix 1: `color-scheme: dark`** — Add `color-scheme: dark` (or `light`) to each theme's `[data-theme="..."]` rule. This tells WebKitGTK to use dark native form control colors as a baseline. This is inherited, so setting it on the theme selector cascades to all form elements. Should be standard practice for all themes.
- **Fix 2: `appearance: none`** — For full CSS control over `<select>` styling, use `appearance: none; -webkit-appearance: none;` to disable native widget rendering entirely. This requires adding a custom dropdown arrow (e.g., inline SVG via `background-image`). This gives consistent cross-engine results.
- **Both fixes together are ideal:** `color-scheme` ensures any native controls you missed still look right, while `appearance: none` on specific controls gives pixel-perfect theming.
- **Playwright headless Chromium cannot reproduce WebKitGTK rendering bugs.** When debugging Tauri UI issues, always verify in the actual app. Use Playwright for functional testing only.

---

## backdrop-filter Creates Visible Color Seams on Padding Areas

**Key takeaways:**

- **`backdrop-filter` does NOT apply to an element's padding area** — only the content/child area gets the filter. If a parent has `backdrop-filter: blur()` and `padding-top: 6px`, the padding strip shows raw background without the filter, creating a visible color seam on dark themes.
- **Fix: use a spacer div instead of padding.** A child `<div>` with matching `background` (e.g., `var(--background-card)`) sits inside the parent's content area where `backdrop-filter` applies, eliminating the seam. Only render the spacer when needed (no titlebar + no toolbar).
- **`border` on `<body>` with `border-radius` also creates visible strips.** The border interacts with rounded corners to produce a colored band along the top edge. Fix: replace `border` with `box-shadow: inset 0 0 0 1px var(--surface-stroke)` — same visual frame, no layout impact.
- **Debugging tip: use dramatic debug values** (e.g., `background: red`, `padding: 50px`) to confirm whether CSS changes are actually reaching the Tauri webview. WebKitGTK caches aggressively and `:global()` Svelte styles may not propagate reliably to child components in Tauri — prefer scoping changes to the component file that Tauri IS updating.
- **Tauri's WebKitGTK may not pick up changes to all Svelte component files equally.** During this investigation, `+page.svelte` changes reflected immediately but `SharedToolbar.svelte` changes did not, even after full `rm -rf node_modules && bun install && bun run tauri dev`. When styling cross-component, keep changes in the parent file that's known to update.

---

## tauri-mfjv / tauri-zf0z / tauri-zmjd / tauri-sa5i: List/Tiles View CSS Bugs

**Key takeaways:**

- **Icon shift on selection**: Caused by border-left changing from 1px to 2px. Fix: always use `border-left-width: 2px` with `border-left-color: transparent` by default, switch to colored on select. Same pattern for tiles bottom border.
- **Marquee selection mismatch in list view**: FileList reused details-view constants (32px header/item height) for list view, which has different layout. Fix: use DOM-based hit testing with `getSelectedIndicesFromDOM()` instead of mathematical calculation.
- **View mode parity**: Any change to interaction behavior (borders, selection, drag-drop) must be tested in ALL three view modes (details, list, tiles).

---

## tauri-31co: Transparent Column Headers

**Key takeaway:** `--background-card-secondary` is semi-transparent across all themes. For elements that need an opaque background (like sticky column headers), use `--background-solid` instead.

---

## tauri-zqdp: Paste Conflict Dialog

**Key takeaways:**

- **Promise-based dialog pattern**: `conflictResolver.prompt()` returns a Promise that resolves when the user clicks a button. The dialog component calls `conflictResolver.resolve()` to fulfill the promise. This cleanly separates the async control flow from the UI.
- **"Apply to all" tracking**: Track a `globalChoice` variable alongside the loop. When `applyToAll` is true, set `globalChoice` and skip prompting for subsequent entries.
- **Rust overwrite parameter**: Both `copy_entry` and `move_entry` accept `overwrite: Option<bool>`. When true, existing targets are deleted before the operation.

---

## tauri-vjly: Progress Bar for File Operations

**Key takeaways:**

- **Frontend-driven progress is sufficient** for file-count-level tracking. The paste loop already processes files one-by-one, so tracking `(i + 1) / total` gives meaningful progress without needing Rust-side streaming.
- **Existing infrastructure**: The `operationsManager` + `ProgressDialog` were already built but not wired. When adding progress tracking, check if UI components already exist before building new ones.
- **`estimateSize()` API**: Already existed for pre-calculating total bytes. Use it for byte-level progress display alongside file-count progress.

---

## tauri-nxfi: Path Autocomplete

**Key takeaways:**

- **Debounce is essential**: Without debouncing, every keystroke triggers a full directory listing. 150ms debounce balances responsiveness with performance.
- **Generation counter pattern**: Use an incrementing `fetchGeneration` counter to discard stale async results. Before applying results, check that `gen === fetchGeneration`.
- **`onblur` vs suggestion clicks**: `onblur` fires before `onclick` on suggestion items. Fix: use `onmousedown` on suggestions (fires before blur) and `event.preventDefault()` on the dropdown container to prevent focus loss.

---

## tauri-p09o: Include recent/frecency paths in Ctrl+P search

**Problem:** Ctrl+P QuickOpen only searched under `~` via the Rust backend. Paths outside home (e.g. `/tmp/delete-debug`) never appeared even if recently visited.

**Key takeaways:**

- **Client-side injection for supplementary results**: Rather than modifying the backend to support multiple search roots, inject matching entries from client-side stores (recentFilesStore, frecencyStore) directly into search results. Filter to paths outside the backend's search root to avoid duplicates.
- **Show results immediately, don't wait for streaming**: External matches should be injected at search start, not only inside the streaming event handler. If the backend is slow or unavailable, users still see relevant results instantly.
- **Separate collection from matching**: Split external candidate logic into `getExternalCandidates()` (collect + dedup) and `matchExternalCandidates()` (filter by query). Reusable and testable.

---

## tauri-jsn1.8: True window transparency on Linux (WebKitGTK) — BLOCKED

**Key takeaways:**

- **`WEBKIT_DISABLE_COMPOSITING_MODE=1` kills transparency but prevents ghosting**: Removing it enables alpha rendering but causes wry #1524 — stale frames accumulate on every interaction, making the window progressively opaque. No clean app-side workaround exists.
- **`WEBKIT_DISABLE_DMABUF_RENDERER=1` is safe**: Fixes DMA-BUF protocol errors without affecting rendering.
- **CSS `backdrop-filter: blur()` does NOT blur the desktop**: Only operates within the DOM stacking context.
- **Tauri `windowEffects`/`window-vibrancy` don't support Linux**: Windows/macOS only.
- **`hyprctl dispatch setprop` opacity doesn't persist across focus changes** on Hyprland 0.53.3 despite using `"active inactive"` syntax and `lock`.
- **Hyprland setprop syntax quirks**: `opacity` accepts space-separated `"active inactive"` values. Properties like `activeopacity`/`inactiveopacity` return "prop not found" on real windows despite accepting dummy addresses. Use `dispatch setprop` not `setprop` directly.

---

## tauri-8gpm: New Window Inherits from Last Focused Window

**Key takeaways:**
- All Tauri WebviewWindows share the same `localStorage` (same origin). This means `windowTabsManager.init()` was restoring the **parent's saved tab state** instead of using the child window's URL-provided path. The URL params (`?path=...&viewMode=...`) were completely ignored.
- Fix: child windows (those with `?path=` URL param) pass `skipRestore=true` to `init()`, creating a fresh tab at the intended path instead of restoring saved state.
- General lesson: in multi-window apps with shared localStorage, saved-state restoration logic must distinguish between cold starts (restore) and child windows (use provided params).

---

## tauri-vup6: UI Facelift - Premium Polish

**Key takeaways:**
- CSS `color-mix(in srgb, var(--accent) 8%, transparent)` is an effective way to create accent-tinted selection backgrounds that adapt to any theme's accent color, avoiding hardcoded RGBA values per theme.
- When doing a comprehensive CSS-only facelift (tokens + themes + components), all changes should flow through CSS custom properties. This keeps the blast radius contained — no JS changes needed, and themes just override the variables.
- `--radius-pill: 999px` for pill-shaped elements (search bars, breadcrumbs, scrollbar thumbs) provides a significant premium feel upgrade with minimal code change.
- Uppercase section labels (`text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px`) dramatically improve visual hierarchy in sidebars and column headers.
- Replacing `border-bottom` with `box-shadow` on toolbars/status bars creates softer, more premium edges.
- New theme creation: when adding a theme (Aurora), remember to add the `@import` in `index.css` — the theme auto-discovery reads `[data-theme="..."]` selectors from imported CSS.
- Multi-layer shadows (`--shadow-card`) add depth without being heavy. Each theme should define its own shadow intensity based on its background darkness.

---
