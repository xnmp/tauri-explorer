# Tauri Explorer — Architecture Reference for AI Agents

> This document is the single source of truth for understanding how the entire codebase fits together. It maps every feature to the exact files that implement it, describes data flow, state management patterns, and inter-component communication. Read this before changing any code.

## Table of Contents

1. [Stack & Build System](#stack--build-system)
2. [High-Level Architecture](#high-level-architecture)
3. [Rust Backend (`src-tauri/`)](#rust-backend-src-tauri)
4. [Frontend Entry Point & Initialization](#frontend-entry-point--initialization)
5. [State Management Layer](#state-management-layer)
6. [Domain Layer](#domain-layer)
7. [API Layer](#api-layer)
8. [Component Tree](#component-tree)
9. [Feature Map (feature → files)](#feature-map)
10. [Data Flow Patterns](#data-flow-patterns)
11. [Persistence Model](#persistence-model)
12. [Cross-Window Communication](#cross-window-communication)
13. [Theming System](#theming-system)
14. [Keyboard Shortcuts & Command System](#keyboard-shortcuts--command-system)
15. [Drag and Drop](#drag-and-drop)
16. [Testing](#testing)

---

## Stack & Build System

| Layer | Technology |
|-------|-----------|
| Desktop runtime | Tauri v2 (Rust + WebView) |
| Frontend framework | Svelte 5 (runes mode: `$state`, `$derived`, `$effect`) |
| Language | TypeScript (frontend), Rust (backend) |
| Package manager | `bun` |
| Build tool | Vite 6 + `@sveltejs/vite-plugin-svelte` |
| Test runner | Vitest (unit), Playwright (e2e) |
| Bundler | `@sveltejs/adapter-static` (SSG for Tauri) |

**Key config files:**
- `package.json` — scripts, dependencies
- `vite.config.js` — Vite config
- `svelte.config.js` — Svelte config
- `vitest.config.ts` — Vitest config
- `playwright.config.ts` — Playwright e2e config
- `tsconfig.json` — TypeScript config
- `src-tauri/tauri.conf.json` — Tauri window/build/security config
- `src-tauri/Cargo.toml` — Rust dependencies

**Dev commands:**
- `bun run start` — runs `scripts/dev.sh` (starts Tauri dev)
- `bun run test` — Vitest unit tests
- `bun run test:e2e` — Playwright e2e tests

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Window (WebView)                │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  +page.svelte (root)                            │    │
│  │  ├── TitleBar / WindowTabBar                    │    │
│  │  ├── SharedToolbar (search, theme, win controls)│    │
│  │  ├── Sidebar (quick access, bookmarks, drives)  │    │
│  │  ├── PaneContainer                              │    │
│  │  │   ├── ExplorerPane (left)                    │    │
│  │  │   │   ├── NavigationBar (breadcrumbs)        │    │
│  │  │   │   └── FileList → FileItem / VirtualList  │    │
│  │  │   └── ExplorerPane (right, if dual pane)     │    │
│  │  ├── PreviewPane (optional)                     │    │
│  │  ├── StatusBar                                  │    │
│  │  └── Overlay Dialogs (QuickOpen, CommandPalette,│    │
│  │      Settings, ContentSearch, etc.)             │    │
│  └─────────────────────────────────────────────────┘    │
│                         │                               │
│                    invoke() IPC                          │
│                         │                               │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Rust Backend (src-tauri/src/)                  │    │
│  │  ├── files.rs (dir listing, CRUD, streaming)    │    │
│  │  ├── search.rs (fuzzy search, streaming)        │    │
│  │  ├── content_search.rs (ripgrep-based grep)     │    │
│  │  ├── thumbnails.rs (image thumbnail cache)      │    │
│  │  ├── clipboard.rs (OS clipboard via wl-copy)    │    │
│  │  ├── archive.rs (zip compress/extract)          │    │
│  │  ├── wallpaper.rs (set desktop wallpaper)       │    │
│  │  ├── config.rs (JSON config persistence)        │    │
│  │  ├── error.rs (unified AppError type)           │    │
│  │  └── task_registry.rs (cancellable background   │    │
│  │      tasks for dir listing, search, content     │    │
│  │      search)                                    │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## Rust Backend (`src-tauri/`)

### Entry Point: `src-tauri/src/lib.rs`

The `run()` function:
1. Sets WebKit env vars for Wayland compatibility
2. Detects launch CWD and home directory
3. Injects `window.__LAUNCH_DATA__` into the webview as a synchronous JS global (avoids IPC roundtrip on startup)
4. Creates the window programmatically (decorationless, transparent, shadow disabled, drag-drop handler disabled for in-webview HTML5 DnD)
5. Registers all Tauri commands via `invoke_handler`
6. Initializes plugins: `tauri-plugin-opener`, `tauri-plugin-shell`, `tauri-plugin-drag`, `tauri-plugin-clipboard-x`

### Modules

#### `files.rs` — File Operations
- **Types:** `FileEntry { name, path, kind, size, modified, is_symlink, symlink_target }`, `FileKind { File, Directory }`, `DirectoryListing { path, entries, listing_id }`
- **Commands:**
  - `list_directory(path)` — cached (5s TTL, 50 entry LRU), returns sorted entries (dirs first, case-insensitive name sort)
  - `start_streaming_directory(path)` — returns first 100 entries immediately, streams remaining via `directory-entries` Tauri event in batches of 100
  - `cancel_directory_listing(listing_id)` — cancels active streaming via `TaskRegistry`
  - `invalidate_dir_cache(path)`
  - `create_directory(parent_path, name)` → `FileEntry`
  - `rename_entry(path, new_name)` → `FileEntry`
  - `copy_entry(source, dest_dir, overwrite)` — generates "name - Copy" suffix on conflict, uses `fs_extra` for recursive dir copy
  - `move_entry(source, dest_dir, overwrite)` — tries `fs::rename` first (same filesystem), falls back to copy+delete for cross-filesystem
  - `open_file(path)` — opens with system default via `opener` crate
  - `open_file_with(path, app)` — opens with specific app
  - `open_image_with_siblings(path)` — detects image viewer via `xdg-mime`, passes sibling images for navigation
  - `open_in_terminal(path, terminal)` — auto-detects terminal (ghostty, kitty, alacritty, etc.) with per-terminal argument handling
  - `read_text_file(path, max_bytes)` — 1MB default limit, UTF-8 validation
  - `write_text_file(path, content)` — creates new file only (no overwrite)
  - `delete_entry_permanent(path)`
  - `create_symlink(target_path, link_path)` — platform-aware (Unix vs Windows)
  - `estimate_size(paths)` → `{ fileCount, totalBytes }` — recursive walk for progress estimation

#### `lib.rs` — Trash Operations
- `move_to_trash(path)` — cross-platform via `trash` crate
- `move_multiple_to_trash(paths)` — batch delete
- `restore_from_trash(paths)` — finds most recently deleted matching item
- `get_launch_cwd()` — returns stored launch directory

#### `search.rs` — Fuzzy File Search
- Uses `nucleo-matcher` (same fuzzy algorithm as Neovim's Telescope) and `jwalk` for parallel directory walking
- **Commands:**
  - `fuzzy_search(query, root, limit)` — one-shot, returns up to `limit` results
  - `start_streaming_search(query, root, limit, boost_prefix)` — streams results via `search-results` events, supports prefix boosting for frecency
  - `cancel_search(search_id)`
- Skips `.git`, `node_modules`, `__pycache__`, `target`, `build`, `dist`, etc.
- Safety cap of 500,000 entries for non-streaming path

#### `content_search.rs` — Ripgrep Content Search
- Uses `grep-regex`, `grep-searcher`, `grep-matcher`, and `ignore` crates (the same libraries as ripgrep)
- **Commands:**
  - `start_content_search(query, root, case_sensitive, regex_mode, max_results)` — parallel file walking with `WalkBuilder`, emits `content-search-results` events
  - `cancel_content_search(search_id)`
- Returns `ContentSearchResult { path, relativePath, matches: [{ lineNumber, column, lineContent, matchStart, matchEnd }] }`

#### `thumbnails.rs` — Image Thumbnail Generation
- Two-tier progressive loading: micro (16×16) + full (128×128)
- Cache: `~/.cache/tauri-explorer/thumbnails/`, keyed by SHA-256(path + mtime + size + cache_version)
- **Commands:**
  - `get_thumbnail(path, size)` → cached file path
  - `get_thumbnail_data(path, size)` → base64 data URI (more efficient for display)
  - `get_micro_thumbnail(path)` → 16×16 data URI, also pre-warms full cache
  - `clear_thumbnail_cache()` → bytes cleared
  - `get_thumbnail_cache_stats()` → `{ count, totalSize, path }`
- Supports: jpg, jpeg, png, gif, webp, bmp

#### `clipboard.rs` — OS Clipboard (Linux-specific)
- Shells out to `wl-paste`/`wl-copy` (Wayland) or `xclip` (X11) for MIME-aware clipboard
- Reads `x-special/gnome-copied-files` (GNOME/XFCE) and `text/uri-list` (KDE) formats
- **Commands:**
  - `clipboard_has_files()` → bool
  - `clipboard_read_files()` → `string[]` (parsed file:// URIs)
  - `clipboard_write_files(paths)` → bool (writes gnome-copied-files format)
  - `clipboard_has_image()` → bool (checks MIME types)
  - `clipboard_paste_image(directory)` → saved file path (reads PNG from clipboard, saves as timestamped file)

#### `archive.rs` — ZIP Operations
- Uses `zip` crate with deflate compression
- **Commands:**
  - `compress_to_zip(paths)` → ZIP file path (auto-names based on selection)
  - `extract_archive(archive_path, extract_here)` → extraction directory path

#### `wallpaper.rs` — Desktop Wallpaper
- Auto-detects: Hyprland/hyprpaper, Sway/swaybg, GNOME, KDE, XFCE, MATE, feh fallback
- **Command:** `set_as_wallpaper(path)`

#### `config.rs` — Config File Persistence
- Config directory: `~/.config/tauri-explorer/`
- **Commands:**
  - `read_config_file(filename)` → JSON string (empty string if not found)
  - `write_config_file(filename, data)`
  - `get_config_dir()` → path string
  - `list_user_themes()` → `[(filename, css_content)]` from `~/.config/tauri-explorer/themes/`

#### `error.rs` — Unified Error Type
- `AppError` enum: `NotFound`, `PermissionDenied`, `AlreadyExists`, `InvalidPath`, `Io`, `Other`
- Implements `Serialize` (serializes to string for Tauri IPC)

#### `task_registry.rs` — Cancellable Task Registry
- Thread-safe registry (`AtomicU64` counter + `Mutex<HashMap<u64, Arc<AtomicBool>>>`)
- Used by: streaming directory listing, streaming search, content search
- API: `start()` → `(id, cancelled_flag)`, `cancel(id)`, `cleanup(id)`

---

## Frontend Entry Point & Initialization

### `src/routes/+page.svelte`

This is the single page of the SPA. On mount:

1. **Theme:** `themeStore.initTheme()` — loads user themes from config dir, discovers bundled themes from CSS, applies saved preference
2. **Launch data:** Reads `window.__LAUNCH_DATA__` (injected by Rust) for CWD and home dir. URL params (`?path=&viewMode=`) override for child windows
3. **Tab initialization:** `windowTabsManager.init(defaultPath, isChildWindow, overridePath)` — restores tabs from localStorage or creates fresh tab
4. **Settings & bookmarks:** Async load from config files (`settingsStore.init()`, `bookmarksStore.init()`)
5. **Commands:** `registerAllCommands()` — registers all command palette commands and their default keybindings
6. **External drop:** `useExternalDrop` — handles files dropped from OS file manager
7. **File change listener:** `initFileChangeListener` — listens for cross-window file change broadcasts via `BroadcastChannel`
8. **Global keyboard handler:** `handleKeydown` — routes keyboard events through `keybindingsStore.findMatchingCommand()` which supports chord shortcuts (e.g., "Alt+M T")

### Layout structure (in template):
```
theme-background-layer (custom wallpaper/theme background)
AnimatedBackground (optional canvas animation)
main.explorer
  TitleBar (only shown when multiple tabs)
  SharedToolbar (or spacer)
  main-content
    Sidebar (if enabled)
    PaneContainer
  StatusBar (if enabled)
QuickOpen, CommandPalette, ContentSearchDialog, SettingsDialog, WorkspaceDialog, BulkRenameDialog, ProgressDialog, ConflictDialog
```

---

## State Management Layer

All state lives in `src/lib/state/`. Svelte 5 runes (`$state`, `$derived`, `$effect`) provide reactivity. Each store is a module-level singleton created by a factory function.

### Core Stores

#### `explorer.svelte.ts` — Per-Pane Explorer State
- **Factory:** `createExplorerState()` — creates one instance per pane
- **Type:** `ExplorerInstance` (return type of factory)
- **State:** `currentPath`, `history[]`, `historyIndex`, `entries[]`, `loading`, `error`, `sortBy`, `sortAscending`, `viewMode`, `selectedPaths`, `selectionAnchorIndex`, `isCreatingFolder`
- **Derived:** `displayEntries` (filtered by hidden + sorted), `breadcrumbs`, `canGoBack`, `canGoForward`
- **Key methods:**
  - `navigateTo(path)` — loads directory via streaming API, pushes history, tracks frecency
  - `goBack()`, `goForward()`, `goUp()`, `refresh()`
  - `selectEntry(entry, { ctrlKey, shiftKey })` — delegates to pure `selection.ts`
  - `selectAll()`, `clearSelection()`, `selectByIndices()`
  - `createFolder(name)`, `rename(newName)`, `confirmDelete()`
  - `copyToClipboard()`, `cutToClipboard()`, `paste()` — uses `clipboardStore` + `paste-operations.ts`
  - `undo()`, `redo()` — delegates to `undoStore`
  - `startDelete(entries)` — respects `confirmDelete` setting, may show dialog
  - `startInlineNewFolder()`, `startRename(entry)` — inline editing in file list
  - `setSorting(field)`, `setViewMode(mode)`, `toggleHidden()`
- **Cross-dependencies:** Uses `toastStore`, `dialogStore`, `clipboardStore`, `undoStore`, `settingsStore`, `frecencyStore`, `recentFilesStore`, `contextMenuStore`, `broadcastFileChange`

#### `window-tabs.svelte.ts` — Window-Level Tabs
- **Singleton:** `windowTabsManager`
- **State:** `tabs[]` (each `WindowTab` has left/right panes, active pane, dual-pane flag, split ratio), `activeTabId`
- **Explorer registry:** `Map<string, ExplorerInstance>` keyed by `explorerId`
- **Key methods:**
  - `init(path, skipRestore, overridePath)` — restores from localStorage or creates fresh
  - `createTab(path?)`, `closeTab(id)`, `closeActiveTab()`, `restoreClosedTab()` (Ctrl+Shift+T, persisted stack of 20)
  - `setActiveTab(id)`, `nextTab()`, `prevTab()`, `reorderTabs(from, to)`
  - `getExplorer(paneId)`, `getActiveExplorer()`
  - `setActivePane(id)`, `switchPane()`, `toggleDualPane()`, `setSplitRatio(ratio)`
  - `save()` — persists to localStorage key `explorer-tabs`
- **Persistence:** `PersistedTabState` saved on every tab change + before window close + every 30s

#### `settings.svelte.ts` — App Settings
- **Singleton:** `settingsStore`
- **Settings:** `showToolbar`, `showSidebar`, `showHidden`, `showWindowControls`, `showPreviewPane`, `confirmDelete`, `zoomLevel`, `terminalApp`, `backgroundOpacity`, `navBarButtons`, `showStatusBar`, `iconTheme`, `backgroundImage`, `backgroundBlur`, `columnVisibility`, `listViewColumns`, `listColumnMaxWidth`, `viewMode`
- **Persistence:** Dual write-through: localStorage (sync) + `~/.config/tauri-explorer/settings.json` (async via `config.rs`)
- **Init:** Loads from config file first, falls back to localStorage, migrates if needed

#### `theme.svelte.ts` — Theme Management
- **Singleton:** `themeStore`
- **State:** `currentThemeId`, `themes[]` (discovered at runtime from CSS)
- **How themes work:** Each theme is a CSS rule on `[data-theme="id"]` with `--theme-name`, `--theme-description`, `--theme-order` custom properties. Bundled themes are in `src/lib/themes/*.css`, imported via `src/lib/themes/index.css`. User themes are loaded from `~/.config/tauri-explorer/themes/*.css` and injected as `<style>` elements.
- **Methods:** `setTheme(id)`, `initTheme()` (loads user themes, discovers all themes, applies)

#### `keybindings.svelte.ts` — Customizable Keyboard Shortcuts
- **Singleton:** `keybindingsStore`
- **State:** `defaultShortcuts` (from command definitions), `userShortcuts` (overrides from localStorage)
- **Chord support:** Two-step shortcuts like "Alt+M T" — first keypress enters chord-waiting mode (1.5s timeout), second keypress completes
- **Key method:** `findMatchingCommand(event, isAvailable?)` — returns command ID, `"chord:waiting"`, or `undefined`
- **Persistence:** localStorage key `explorer-keybindings`

#### `clipboard.svelte.ts` — Cross-Window Clipboard
- **Singleton:** `clipboardStore`
- **State:** `content: { entries, operation: "copy"|"cut" } | null`
- **Cross-window sync:** Broadcasts via Tauri inter-window events (`emit`/`listen`)
- **OS clipboard integration:** `osClipboardWriteFiles()` writes gnome-copied-files format, `readOsFiles()` reads from OS clipboard
- **Methods:** `copy(entries)`, `cut(entries)`, `clear()`, `take()`, `updatePath(oldPath, newEntry)`

#### `dialogs.svelte.ts` — Global Dialog State
- **Singleton:** `dialogStore`
- **File operation dialogs (mutually exclusive):** `newFolder`, `rename`, `delete`
- **Overlay dialogs (independent):** `quickOpen`, `commandPalette`, `settings`, `contentSearch`, `workspace`, `bulkRename`
- **`hasModalOpen`:** computed from all dialog states, used to suppress keyboard shortcuts

#### `undo.svelte.ts` — Undo/Redo Stack
- **Singleton:** `undoStore`
- **Action types:** `rename { path, oldName, newName }`, `move { sourcePath, destPath, originalDir }`, `delete { paths, parentDir }`
- **Undo:** rename → rename back, move → move back, delete → restore from trash
- **Redo:** re-applies the original operation

#### Other Stores

| Store | File | Purpose |
|-------|------|---------|
| `bookmarksStore` | `bookmarks.svelte.ts` | User-pinned sidebar folders, dual persistence (localStorage + config file) |
| `toastStore` | `toast.svelte.ts` | Temporary notifications (info, success, error, clipboard), auto-dismiss |
| `contextMenuStore` | `context-menu.svelte.ts` | Position + visibility of right-click menu |
| `frecencyStore` | `frecency.svelte.ts` | Zoxide-style path ranking (score = Σ 1/(hours_since + 1)), used by QuickOpen |
| `recentFilesStore` | `recent-files.svelte.ts` | Last 50 opened files/directories, shown in QuickOpen |
| `operationsManager` | `operations.svelte.ts` | Copy/move progress tracking with cancellation, shows ProgressDialog after 1.5s delay |
| `conflictResolver` | `conflict-resolver.svelte.ts` | Promise-based conflict resolution (overwrite/skip/cancel + apply-to-all) |
| `workspacesStore` | `workspaces.svelte.ts` | Named snapshots of tab layout (up to 20), persisted to localStorage |
| `dragState` | `drag.svelte.ts` | In-app drag data, uses localStorage for cross-window communication |

### Pure State Utilities (no Svelte runes)

| File | Purpose |
|------|---------|
| `selection.ts` | Pure functions: `calculateSelection()` (click/ctrl/shift), `selectByIndices()`, `getSelectedEntries()` |
| `navigation.ts` | Pure functions: `pushToHistory()`, `canGoBack/Forward()`, `getBackPath/ForwardPath()`, `parseBreadcrumbs()`, `getParentPath()` |
| `paste-operations.ts` | Orchestrates paste: estimates size, tracks progress, handles conflicts, broadcasts file changes |
| `directory-listing.ts` | Manages streaming directory listing: initial batch + event listener for remaining chunks |
| `sort-prefs.ts` | Per-directory sort preference persistence (localStorage, 200 entry cap) |
| `persisted.ts` | localStorage helpers: `loadPersisted<T>()`, `savePersisted()`, `removePersisted()` |
| `undo-helpers.ts` | Helper functions for undo: `getAffectedDirs()`, `undoActionLabel()` |
| `pane-context.ts` | Svelte context for pane navigation (used by Sidebar, FileList, FileItem to navigate the active pane) |
| `focused-window.ts` | Tracks last-focused window state in localStorage for Ctrl+N inheritance |
| `file-events.ts` | Cross-window file change notification via `BroadcastChannel` |
| `commands.svelte.ts` | Command registry: `registerCommand()`, `executeCommand()`, `getAllCommands()`, `getAvailableCommands()`, tracks recent commands |
| `command-definitions.ts` | Defines all ~50 commands with handlers, categories, shortcuts, and `when` guards |

---

## Domain Layer

`src/lib/domain/` contains pure functions and types with no framework dependencies.

| File | Contents |
|------|----------|
| `file.ts` | `FileEntry`, `DirectoryListing`, `SortField`, `sortEntries()`, `filterHidden()`, `formatSize()` |
| `file-types.ts` | `getFileType()` (human name), `getFileIconColor()`, `isImageFile()`, `isTextFile()`, `isPdfFile()`, `formatDate()`, icon category mapping |
| `nerd-icons.ts` | Nerd Font glyph/color mappings per extension + special filenames (for material icon theme) |
| `keyboard.ts` | `normalizeKeyForShortcut()`, `matchesShortcutKey()`, common shortcut key constants |
| `keybinding-parser.ts` | `parseShortcut()`, `matchesShortcut()`, `matchesShortcutString()`, `formatShortcut()`, chord parsing (`parseChord()`, `isChordShortcut()`) |
| `zoom.ts` | `getZoomFactor()`, `adjustForZoom(x, y)` — compensates for CSS zoom on context menu/dialog positioning |
| `content-search-flatten.ts` | Flattens grouped content search results for display |

---

## API Layer

`src/lib/api/` bridges frontend ↔ Rust backend.

#### `files.ts` — Primary API Client
- Wraps every Rust command in an `async` function returning `ApiResult<T> = { ok: true, data: T } | { ok: false, error: string }`
- Auto-detects Tauri vs browser environment (cached after first call)
- **Functions map 1:1 to Rust commands:** `fetchDirectory`, `startStreamingDirectory`, `createDirectory`, `renameEntry`, `deleteEntry`, `deleteMultipleEntries`, `restoreFromTrash`, `copyEntry`, `moveEntry`, `openFile`, `openFileWith`, `openImageWithSiblings`, `openInTerminal`, `readTextFile`, `writeTextFile`, `fuzzySearch`, `startStreamingSearch`, `cancelSearch`, `startContentSearch`, `cancelContentSearch`, `estimateSize`, `getThumbnail`, `getThumbnailData`, `getMicroThumbnail`, `clearThumbnailCache`, `getThumbnailCacheStats`, `createSymlink`, `clipboardHasImage`, `clipboardPasteImage`, `setAsWallpaper`, `compressToZip`, `extractArchive`, `readConfigFile`, `writeConfigFile`, `listUserThemes`

#### `mock-invoke.ts` — Browser E2E Mock
- `isTauri()` — checks for `__TAURI_INTERNALS__` (Tauri v2)
- `mockInvoke<T>()` — fake implementations of all commands with in-memory file system
- Used when running Playwright tests against `vite dev` (no Tauri runtime)

#### `os-clipboard.ts` — OS Clipboard File Operations
- `osClipboardHasFiles()`, `osClipboardReadFiles()`, `osClipboardWriteFiles()` — thin wrappers around custom Tauri commands in `clipboard.rs`

---

## Component Tree

### `src/lib/components/`

| Component | File | Purpose |
|-----------|------|---------|
| **TitleBar** | `TitleBar.svelte` | Custom decorationless title bar, only visible when >1 tab. Contains `WindowTabBar`. Handles window dragging via `appWindow.startDragging()` |
| **WindowTabBar** | `WindowTabBar.svelte` | Tab strip: tab buttons (closeable, reorderable), new tab button |
| **SharedToolbar** | `SharedToolbar.svelte` | Search box, theme switcher, window controls (minimize/maximize/close) |
| **ThemeSwitcher** | `ThemeSwitcher.svelte` | Dropdown to select theme |
| **Sidebar** | `Sidebar.svelte` | Home button, dual-pane toggle, Quick Access (system folders + user bookmarks with drag-to-reorder), This PC (drives). Resizable (180-400px). Drag folder to Quick Access to bookmark |
| **PaneContainer** | `PaneContainer.svelte` | Manages single/dual pane layout with resizable divider. Contains two `ExplorerPane` instances + optional `PreviewPane` |
| **ExplorerPane** | `ExplorerPane.svelte` | Self-contained pane: gets explorer from `windowTabsManager.getExplorer(paneId)`, provides it via Svelte context. Contains `NavigationBar` + `FileList` + `ContextMenu` + `NewFolderDialog` + `DeleteDialog`. Handles arrow-key navigation with view-mode-aware step calculation |
| **NavigationBar** | `NavigationBar.svelte` | Back/Forward/Up/Refresh buttons (configurable), breadcrumb bar with editable path input and autocomplete, caret picker (click chevron to see subdirectories) |
| **FileList** | `FileList.svelte` | Three view modes: details (VirtualList), list (CSS grid column-flow), tiles (CSS auto-fill grid). Handles: marquee selection, type-ahead, column resize, drag-and-drop, inline rename for list/tiles views |
| **FileItem** | `FileItem.svelte` | Single row in details view. Inline rename, slow-click-to-rename, drag source, drop target (directories), clipboard visual feedback, symlink badge |
| **FileIcon** | `FileIcon.svelte` | Renders file/folder icon. Supports three themes: default (SVG), material (Nerd Fonts), minimal |
| **VirtualList** | `VirtualList.svelte` | Generic virtual scrolling component for fixed-height items. Renders only visible items + buffer. Uses Svelte 5 generics |
| **ThumbnailImage** | `ThumbnailImage.svelte` | Progressive image loading: micro thumbnail → full thumbnail, with intersection observer for lazy loading |
| **InlineNewFolder** | `InlineNewFolder.svelte` | Inline editable placeholder in file list for creating new folders (details/list/tiles variants) |
| **ContextMenu** | `ContextMenu.svelte` | Right-click menu: Open, Set as Wallpaper, Cut/Copy/Paste, Rename, Delete, Bookmark, Extract/Compress, Create Symlink, Open in Terminal, View mode selector with list columns submenu |
| **PreviewPane** | `PreviewPane.svelte` | Side panel showing image preview (via asset protocol), text preview (first 512KB), PDF preview (iframe), file metadata |
| **StatusBar** | `StatusBar.svelte` | Bottom bar: item count (folders + files), selected count + total size, current path |
| **QuickOpen** | `QuickOpen.svelte` | Ctrl+P fuzzy file search. Uses streaming search API, ranks by frecency, shows recent files when query is empty |
| **CommandPalette** | `CommandPalette.svelte` | Ctrl+Shift+P command search. Fuzzy-matches all registered commands, shows recent commands first |
| **ContentSearchDialog** | `ContentSearchDialog.svelte` | Ctrl+Shift+F grep-in-files. Uses ripgrep backend, shows matches grouped by file with line previews |
| **SettingsDialog** | `SettingsDialog.svelte` | Settings UI: appearance, behavior, keybindings tab, thumbnail cache management |
| **KeybindingsSettings** | `KeybindingsSettings.svelte` | Keybinding customization: search, record new shortcut, conflict detection, reset individual/all |
| **WorkspaceDialog** | `WorkspaceDialog.svelte` | Save/restore named tab layout snapshots |
| **BulkRenameDialog** | `BulkRenameDialog.svelte` | Rename multiple files at once with find/replace, regex, sequence number patterns |
| **ProgressDialog** | `ProgressDialog.svelte` | Shows copy/move progress (appears after 1.5s delay), supports cancellation |
| **ConflictDialog** | `ConflictDialog.svelte` | Overwrite/Skip/Cancel dialog for file conflicts during paste, with "Apply to all" option |
| **DeleteDialog** | `DeleteDialog.svelte` | Confirmation dialog for delete operations |
| **NewFolderDialog** | `NewFolderDialog.svelte` | Dialog for creating new folders (used when inline creation isn't available) |
| **RenameDialog** | `RenameDialog.svelte` | Standalone rename dialog (currently superseded by inline rename) |
| **ToastOverlay** | `ToastOverlay.svelte` | Renders toast notifications from `toastStore` |
| **AnimatedBackground** | `AnimatedBackground.svelte` | Optional canvas-based animated background (particles, starfield) |

### Composables (`src/lib/composables/`)

| File | Purpose |
|------|---------|
| `use-column-resize.svelte.ts` | Resizable column headers in details view. Tracks column widths, generates `grid-template-columns` CSS |
| `use-marquee-selection.svelte.ts` | Rubber-band selection rectangle. Handles mousedown→mousemove→mouseup, calculates selected indices, supports both index-based (details) and DOM-based (list/tiles) hit testing |
| `use-type-ahead.svelte.ts` | Type-ahead selection: typing characters jumps to matching file name |
| `use-external-drag.svelte.ts` | Handles dragging files OUT of the app to the OS |
| `use-external-drop.svelte.ts` | Handles files dropped INTO the app from OS (via Tauri `onDragDropEvent`) |

---

## Feature Map

### Navigation
| Feature | Files to change |
|---------|----------------|
| Directory navigation | `explorer.svelte.ts:navigateTo`, `navigation.ts`, `directory-listing.ts`, `files.rs:start_streaming_directory` |
| Back/Forward/Up | `explorer.svelte.ts:goBack/goForward/goUp`, `navigation.ts` |
| Breadcrumb bar | `NavigationBar.svelte` |
| Path editing + autocomplete | `NavigationBar.svelte` (editable path input) |
| Breadcrumb caret picker | `NavigationBar.svelte` (subdirectory dropdown on chevron click) |
| History management | `navigation.ts:pushToHistory` |

### File Operations
| Feature | Files to change |
|---------|----------------|
| Create folder | `explorer.svelte.ts:createFolder`, `InlineNewFolder.svelte`, `files.rs:create_directory` |
| Rename (inline) | `FileItem.svelte` (details), `FileList.svelte` (list/tiles), `explorer.svelte.ts:rename`, `files.rs:rename_entry` |
| Rename (slow-click) | `FileItem.svelte:handleClick` (500ms timer after single-click on name of selected item) |
| Bulk rename | `BulkRenameDialog.svelte`, `dialogStore.openBulkRename()` |
| Delete (to trash) | `explorer.svelte.ts:startDelete/confirmDelete`, `DeleteDialog.svelte`, `lib.rs:move_to_trash` |
| Delete (permanent) | `files.rs:delete_entry_permanent` |
| Copy/Move (paste) | `paste-operations.ts`, `clipboard.svelte.ts`, `files.rs:copy_entry/move_entry` |
| Conflict resolution | `conflict-resolver.svelte.ts`, `ConflictDialog.svelte` |
| Progress tracking | `operations.svelte.ts`, `ProgressDialog.svelte` |
| Undo/Redo | `undo.svelte.ts`, `undo-helpers.ts`, `explorer.svelte.ts:undo/redo` |
| Open file | `files.rs:open_file`, `FileList.svelte:handleDoubleClick` |
| Open with specific app | `files.rs:open_file_with` |
| Open image with siblings | `files.rs:open_image_with_siblings`, `FileList.svelte` |
| Create symlink | `ContextMenu.svelte:handleCreateSymlink`, `files.rs:create_symlink` |
| Compress to ZIP | `ContextMenu.svelte:handleCompress`, `archive.rs:compress_to_zip` |
| Extract archive | `ContextMenu.svelte:handleExtractHere/handleExtractToFolder`, `archive.rs:extract_archive` |
| Open in terminal | `ContextMenu.svelte:handleOpenInTerminal`, `files.rs:open_in_terminal` |
| Set as wallpaper | `ContextMenu.svelte:handleSetAsWallpaper`, `wallpaper.rs:set_as_wallpaper` |

### Selection
| Feature | Files to change |
|---------|----------------|
| Click/Ctrl+Click/Shift+Click | `selection.ts:calculateSelection`, `explorer.svelte.ts:selectEntry` |
| Select all (Ctrl+A) | `explorer.svelte.ts:selectAll` |
| Marquee (rubber-band) selection | `use-marquee-selection.svelte.ts`, `FileList.svelte` |
| Type-ahead selection | `use-type-ahead.svelte.ts`, `FileList.svelte` |
| Arrow key navigation | `ExplorerPane.svelte:getArrowStep` (view-mode-aware step sizes) |

### View Modes
| Feature | Files to change |
|---------|----------------|
| Details view | `FileList.svelte` (VirtualList + FileItem), `FileItem.svelte` |
| List view | `FileList.svelte` (CSS grid column-flow with configurable columns) |
| Tiles view | `FileList.svelte` (CSS auto-fill grid with thumbnail images) |
| Column resize (details) | `use-column-resize.svelte.ts`, `FileList.svelte` |
| Column visibility toggle | `FileList.svelte` (column header right-click menu), `settingsStore.columnVisibility` |
| List column count | `settingsStore.listViewColumns`, `FileList.svelte:effectiveListColumns` |

### Search
| Feature | Files to change |
|---------|----------------|
| Quick Open (Ctrl+P) | `QuickOpen.svelte`, `files.ts:startStreamingSearch`, `search.rs` |
| Content search (Ctrl+Shift+F) | `ContentSearchDialog.svelte`, `files.ts:startContentSearch`, `content_search.rs` |
| Frecency ranking | `frecency.svelte.ts`, used by `QuickOpen.svelte` |

### Tabs & Windows
| Feature | Files to change |
|---------|----------------|
| Window tabs | `window-tabs.svelte.ts`, `WindowTabBar.svelte`, `TitleBar.svelte` |
| New tab (Ctrl+T) | `windowTabsManager.createTab()` |
| Close tab (Ctrl+W) | `windowTabsManager.closeActiveTab()` |
| Restore closed tab | `windowTabsManager.restoreClosedTab()` (persisted stack) |
| Tab reorder | `WindowTabBar.svelte` (drag), `windowTabsManager.reorderTabs()` |
| New window (Ctrl+N) | `command-definitions.ts:openNewWindow()` — creates `WebviewWindow` with URL params |
| Dual pane (Ctrl+\\) | `windowTabsManager.toggleDualPane()`, `PaneContainer.svelte` |
| Split ratio resize | `PaneContainer.svelte` mouse handlers, `windowTabsManager.setSplitRatio()` |
| Workspaces | `workspaces.svelte.ts`, `WorkspaceDialog.svelte` |

### Clipboard
| Feature | Files to change |
|---------|----------------|
| Internal clipboard | `clipboard.svelte.ts` |
| OS clipboard files | `os-clipboard.ts`, `clipboard.rs` |
| Paste image from clipboard | `clipboard.rs:clipboard_paste_image`, `files.ts:clipboardPasteImage` |
| Cross-window clipboard sync | `clipboard.svelte.ts` (Tauri events) |
| Visual feedback (badges) | `FileItem.svelte` (clipboard badge, cut opacity) |

### Thumbnails
| Feature | Files to change |
|---------|----------------|
| Thumbnail generation | `thumbnails.rs` |
| Progressive loading | `ThumbnailImage.svelte` (micro → full), `files.ts:getMicroThumbnail/getThumbnailData` |
| Cache management | Settings dialog, `thumbnails.rs:clear_thumbnail_cache/get_thumbnail_cache_stats` |

### Sidebar & Bookmarks
| Feature | Files to change |
|---------|----------------|
| Quick Access folders | `Sidebar.svelte` (hardcoded system folders) |
| User bookmarks | `bookmarks.svelte.ts`, `Sidebar.svelte` |
| Drag folder to bookmark | `Sidebar.svelte` (native DnD listeners, dragend-based detection for WebKitGTK) |
| Bookmark reorder | `Sidebar.svelte` (drag-to-reorder), `bookmarksStore.reorderBookmarks()` |
| Sidebar resize | `Sidebar.svelte` (180-400px, persisted to localStorage) |

### Settings
| Feature | Files to change |
|---------|----------------|
| Settings persistence | `settings.svelte.ts`, `config.rs` |
| Settings UI | `SettingsDialog.svelte` |
| Keybinding customization | `KeybindingsSettings.svelte`, `keybindings.svelte.ts` |
| Zoom (Ctrl+=/-/0) | `settingsStore.zoomIn/zoomOut/zoomReset`, `+page.svelte` ($effect applies to `document.documentElement.style.zoom`) |
| Background opacity | `settingsStore.backgroundOpacity`, `+page.svelte` (sets `--bg-opacity` CSS var) |
| Custom wallpaper | `settingsStore.backgroundImage/backgroundBlur`, `+page.svelte` theme-background-layer |

---

## Data Flow Patterns

### Directory Navigation Flow
```
User action (click breadcrumb / enter path / arrow + Enter)
  → explorer.navigateTo(path)
    → dirListing.load(path, callbacks)
      → API: startStreamingDirectory(path)
        → Rust: files::start_streaming_directory
          → Returns first 100 entries immediately
          → Spawns thread for remaining entries (emits "directory-entries" events)
      → Frontend: sets coreState.entries, starts streaming listener
    → Pushes to history, records frecency + recent files
    → Auto-selects first entry
    → Calls onNavigateCallback (focuses selected item in DOM)
```

### Paste Flow
```
User: Ctrl+V
  → explorer.paste()
    → Check clipboardStore.content (internal)
      → OR clipboardStore.readOsFiles() (OS clipboard)
      → OR clipboardHasImage() (image paste)
    → pasteEntries(sources, isCut, context, onComplete)
      → estimateSize(paths) for progress bar
      → operationsManager.startOperation()
      → For each source:
        → Check for naming conflict
        → If conflict: conflictResolver.prompt() → ConflictDialog → user choice
        → moveEntry() or copyEntry() via API
        → undoStore.push() for moves
        → operationsManager.updateProgress()
      → broadcastFileChange(affectedDirs)
      → Refresh panes
```

### Keyboard Shortcut Flow
```
window keydown event
  → +page.svelte:handleKeydown()
    → Skip if input field or modal dialog open
    → keybindingsStore.findMatchingCommand(event, isAvailable)
      → Check if chord prefix is active (waiting for suffix)
      → Check chord prefixes first
      → Check single-key shortcuts
      → isAvailable: checks command's `when()` guard
    → If "chord:waiting": suppress event, show status
    → If command found: executeCommand(commandId)
      → commands.svelte.ts: looks up handler, calls it, tracks as recent
```

---

## Persistence Model

| Data | Storage | Key | File |
|------|---------|-----|------|
| Tabs | localStorage | `explorer-tabs` | `window-tabs.svelte.ts` |
| Closed tabs | localStorage | `explorer-closed-tabs` | `window-tabs.svelte.ts` |
| Settings | localStorage + config file | `explorer-settings` / `settings.json` | `settings.svelte.ts` |
| Bookmarks | localStorage + config file | `explorer-bookmarks` / `bookmarks.json` | `bookmarks.svelte.ts` |
| Theme | localStorage | `theme` | `theme.svelte.ts` |
| Keybindings | localStorage | `explorer-keybindings` | `keybindings.svelte.ts` |
| Sort prefs | localStorage | `explorer-sort-prefs` | `sort-prefs.ts` |
| Frecency | localStorage | `explorer-frecency` | `frecency.svelte.ts` |
| Recent files | localStorage | `explorer-recent-files` | `recent-files.svelte.ts` |
| Workspaces | localStorage | `explorer-workspaces` | `workspaces.svelte.ts` |
| Sidebar width | localStorage | `explorer-sidebar-width` | `Sidebar.svelte` |
| Focused window | localStorage | `explorer-focused-window` | `focused-window.ts` |
| Drag data | localStorage | `explorer-drag-data` | `drag.svelte.ts` |
| Thumbnails | file system | `~/.cache/tauri-explorer/thumbnails/` | `thumbnails.rs` |
| Config files | file system | `~/.config/tauri-explorer/` | `config.rs` |
| User themes | file system | `~/.config/tauri-explorer/themes/*.css` | `config.rs`, `theme.svelte.ts` |

---

## Cross-Window Communication

| Channel | Mechanism | Used for |
|---------|-----------|----------|
| Clipboard sync | Tauri `emit`/`listen` events (`app://clipboard-sync`) | Clipboard content shared between windows |
| File changes | `BroadcastChannel` (`explorer-file-changes`) | Notify other windows to refresh after file operations |
| Drag data | localStorage (`explorer-drag-data`) | Share drag source info between webview windows (dataTransfer unreliable cross-window in Tauri) |
| Focused window state | localStorage (`explorer-focused-window`) | Ctrl+N inherits path/viewMode from last focused window |
| New window | `WebviewWindow` constructor with URL params (`?path=&viewMode=`) | Child windows open at specific path |

---

## Theming System

### Bundled Themes (`src/lib/themes/`)
- `dark.css`, `light.css`, `ocean-blue.css`, `rapture.css`, `solarized-light.css`, `desert.css`, `hacker.css`, `aurora.css`, `cosmic-dusk.css`, `horizon.css`
- All imported via `index.css`
- Each theme is a `[data-theme="id"]` CSS rule containing CSS custom properties

### Theme CSS Custom Properties (key ones)
- `--background-mica`, `--background-solid`, `--background-card`, `--background-card-secondary`
- `--text-primary`, `--text-secondary`, `--text-tertiary`
- `--accent`, `--text-on-accent`
- `--divider`, `--surface-stroke`, `--surface-stroke-flyout`
- `--subtle-fill-secondary`, `--subtle-fill-tertiary`
- `--control-fill`, `--control-fill-secondary`, `--control-fill-tertiary`
- `--system-critical`, `--system-caution`, `--system-success`
- `--icon-folder` (folder icon color)
- `--theme-name`, `--theme-description`, `--theme-order` (metadata, quoted strings)
- `--theme-icon-pack` (optional: "material" or "minimal")
- `--theme-background-image` (optional CSS background for theme)

### User Themes
- Drop `.css` file in `~/.config/tauri-explorer/themes/`
- Must contain `[data-theme="your-id"]` rule with `--theme-name` property
- Auto-discovered at startup via `listUserThemes()` + `discoverThemes()`

---

## Keyboard Shortcuts & Command System

### Architecture
1. **Commands** are defined in `command-definitions.ts` as arrays of `Command` objects (id, label, category, handler, optional shortcut, optional `when` guard)
2. **Registered** via `registerCommands()` into the command registry (`commands.svelte.ts`)
3. **Default shortcuts** registered with `keybindingsStore.registerDefaults()`
4. **User overrides** loaded from localStorage, can be null (unbind) or custom string
5. **Matching:** On keydown, `keybindingsStore.findMatchingCommand()` checks chord state, then iterates commands, checking effective shortcut + `when` guard

### Hardcoded Shortcuts (in `+page.svelte`, not customizable)
- `Ctrl+,` — Open settings
- `Ctrl+\` — Toggle dual pane
- `Escape` — Close any modal dialog

### Chord Shortcuts
- `Alt+M E` — Toggle sidebar
- `Alt+M B` — Toggle toolbar
- `Alt+M U` — Toggle status bar
- `Alt+M T` — Open terminal here

### Command Categories
- **navigation:** goBack, goForward, goUp, goHome, refresh
- **file:** newFolder, rename, bulkRename, delete, openSelected, copyToOther, moveToOther
- **edit:** copy, cut, paste, undo, redo, pasteAsTextFile, pasteImage
- **selection:** selectAll, clearSelection
- **view:** details/list/tiles, toggleSidebar/Toolbar/WindowControls/PreviewPane/DualPane/Hidden/StatusBar, switchPane, toggleTheme, zoom, listColumns
- **bookmarks:** addCurrent, removeCurrent
- **general:** quickOpen, commandPalette, contentSearch, newWindow, openTerminal, workspaces, recentFiles

---

## Drag and Drop

### Known Limitation
Svelte 5 event delegation can break HTML5 DnD `drop` events in complex component trees. The codebase uses two workarounds:
1. **Shared drag state store** (`drag.svelte.ts`) instead of relying solely on `dataTransfer.getData()` — stores drag data in both `dataTransfer` and a reactive store + localStorage
2. **Native `addEventListener`** for sidebar bookmark drop zone (bypasses Svelte delegation)
3. Tauri requires `dragDropEnabled: false` (`disable_drag_drop_handler()` in Rust) for in-webview HTML5 DnD to work

### Internal DnD Flow
```
FileItem/FileList dragstart
  → Sets dataTransfer types: application/x-explorer-{path,name,kind}
  → Calls dragState.start(data) (reactive store + localStorage)

Target (directory) dragover
  → Checks dataTransfer types OR dragState.readCrossWindow()
  → Shows visual feedback (blue = move, green = copy when Ctrl held)

Target drop / Source dragend
  → Reads path from dataTransfer first, falls back to dragState.readCrossWindow()
  → Checks for naming conflict → conflictResolver.prompt()
  → Executes moveEntry or copyEntry
  → Pushes to undoStore (for moves)
  → Refreshes all panes, broadcasts file change
```

### External DnD (OS → App)
- `use-external-drop.svelte.ts` handles Tauri's `onDragDropEvent`
- Default: move. Ctrl held: copy
- `+page.svelte:handleExternalDrop()` executes the operation

### Sidebar Bookmark DnD
- Drag a folder to Quick Access to bookmark it
- Uses native `addEventListener` + `dragend` detection (WebKitGTK workaround: polls cursor position)
- Bookmark reordering uses standard HTML5 DnD within the bookmark list

---

## Testing

### Unit Tests (`tests/`)
- `tests/domain/file.test.ts` — `sortEntries`, `filterHidden`, `formatSize`
- `tests/domain/keyboard.test.ts` — Key normalization
- `tests/domain/keybinding-parser.test.ts` — Shortcut parsing and matching
- `tests/state/frecency.test.ts` — Frecency scoring
- `tests/state/keybindings.test.ts` — Keybinding store logic
- `tests/state/window-tabs.test.ts` — Tab management
- `tests/setup.ts` — Test environment setup

### E2E Tests (`e2e/`)
- `navigation.spec.ts` — Breadcrumbs, back/forward, path editing
- `keyboard.spec.ts` — Keyboard shortcuts, arrow navigation
- `selection.spec.ts` — Click, Ctrl+Click, Shift+Click, marquee selection
- `file-operations.spec.ts` — Create folder, rename, delete, copy, move, undo
- `keybindings-settings.spec.ts` — Keybinding customization UI
- `new-features.spec.ts` — Various feature tests
- `performance.spec.ts` — Cold start, large directory rendering, scroll FPS

### Performance Tests (`tests/perf/`)
- `directory-scan.bench.ts` — Directory listing performance
- `content-search.bench.ts` — Content search performance
- `render.bench.ts` — Frontend rendering benchmarks

### Rust Tests
- `files.rs` — Unit tests for list_directory, create_directory, rename_entry, copy_entry, estimate_size
- `clipboard.rs` — URI parsing, percent encoding/decoding tests

### Mock System
- `mock-invoke.ts` provides in-memory fake file system for all Tauri commands
- Enables running Playwright e2e tests against `vite dev` without Tauri runtime
- Mock file tree: `/home/user/{Documents,Downloads,Pictures,Music,Videos}`
