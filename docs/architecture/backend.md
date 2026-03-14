# Backend Architecture — Rust (`src-tauri/`)

> Deep reference for the Rust backend. For the high-level map, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Entry Point: `src-tauri/src/lib.rs`

The `run()` function:
1. Sets WebKit env vars for Wayland compatibility
2. Detects launch CWD and home directory
3. Injects `window.__LAUNCH_DATA__` into the webview as a synchronous JS global (avoids IPC roundtrip on startup)
4. Creates the window programmatically (decorationless, transparent, shadow disabled, drag-drop handler disabled for in-webview HTML5 DnD)
5. Registers all Tauri commands via `invoke_handler`
6. Initializes plugins: `tauri-plugin-opener`, `tauri-plugin-shell`, `tauri-plugin-drag`, `tauri-plugin-clipboard-x`, `tauri-plugin-log`

## Modules

### `files/` — File Operations Module

Split into focused submodules. Shared types live in `mod.rs`.

#### `files/mod.rs` — Shared Types
- **Types:** `FileEntry { name, path, kind, size, modified, is_symlink, symlink_target }`, `FileKind { File, Directory }`, `DirectoryListing { path, entries, listing_id }`
- **Helper:** `metadata_to_entry()` — converts `std::fs::Metadata` + path into `FileEntry`
- Re-exports submodules as `pub mod dir_listing`, `pub mod file_ops`, `pub mod external_apps`

#### `files/dir_listing.rs` — Directory Listing & Caching
- **Commands:**
  - `list_directory(path)` — cached (5s TTL, 50 entry LRU), returns sorted entries (dirs first, case-insensitive name sort)
  - `start_streaming_directory(path)` — returns first 100 entries immediately, streams remaining via `directory-entries` Tauri event in batches of 100
  - `cancel_directory_listing(listing_id)` — cancels active streaming via `TaskRegistry`
  - `invalidate_dir_cache(path)`

#### `files/file_ops.rs` — CRUD Operations
- **Commands:**
  - `get_home_directory()` → home dir path
  - `create_directory(parent_path, name)` → `FileEntry`
  - `rename_entry(path, new_name)` → `FileEntry`
  - `copy_entry(source, dest_dir, overwrite)` — generates "name - Copy" suffix on conflict, uses `fs_extra` for recursive dir copy
  - `move_entry(source, dest_dir, overwrite)` — tries `fs::rename` first (same filesystem), falls back to copy+delete for cross-filesystem
  - `read_text_file(path, max_bytes)` — 1MB default limit, UTF-8 validation
  - `write_text_file(path, content)` — creates new file only (no overwrite)
  - `delete_entry_permanent(path)`
  - `create_symlink(target_path, link_path)` — platform-aware (Unix vs Windows)
  - `estimate_size(paths)` → `{ fileCount, totalBytes }` — recursive walk for progress estimation

#### `files/external_apps.rs` — External App Launching
- **Commands:**
  - `open_file(path)` — opens with system default via `opener` crate
  - `open_file_with(path, app)` — opens with specific app
  - `open_image_with_siblings(path)` — detects image viewer via `xdg-mime`, passes sibling images for navigation
  - `open_in_terminal(path, terminal)` — auto-detects terminal (ghostty, kitty, alacritty, etc.) with per-terminal argument handling

### `lib.rs` — Trash Operations
- `move_to_trash(path)` — cross-platform via `trash` crate
- `move_multiple_to_trash(paths)` — batch delete
- `restore_from_trash(paths)` — finds most recently deleted matching item
- `get_launch_cwd()` — returns stored launch directory

### `search.rs` — Fuzzy File Search
- Uses `nucleo-matcher` (same fuzzy algorithm as Neovim's Telescope) and `jwalk` for parallel directory walking
- **Commands:**
  - `fuzzy_search(query, root, limit)` — one-shot, returns up to `limit` results
  - `start_streaming_search(query, root, limit, boost_prefix)` — streams results via `search-results` events, supports prefix boosting for frecency
  - `cancel_search(search_id)`
- Skips `.git`, `node_modules`, `__pycache__`, `target`, `build`, `dist`, etc.
- Safety cap of 500,000 entries for non-streaming path

### `content_search.rs` — Ripgrep Content Search
- Uses `grep-regex`, `grep-searcher`, `grep-matcher`, and `ignore` crates (the same libraries as ripgrep)
- **Commands:**
  - `start_content_search(query, root, case_sensitive, regex_mode, max_results)` — parallel file walking with `WalkBuilder`, emits `content-search-results` events
  - `cancel_content_search(search_id)`
- Returns `ContentSearchResult { path, relativePath, matches: [{ lineNumber, column, lineContent, matchStart, matchEnd }] }`

### `thumbnails.rs` — Image Thumbnail Generation
- Two-tier progressive loading: micro (16×16) + full (128×128)
- Cache: `~/.cache/tauri-explorer/thumbnails/`, keyed by SHA-256(path + mtime + size + cache_version)
- **Commands:**
  - `get_thumbnail(path, size)` → cached file path
  - `get_thumbnail_data(path, size)` → base64 data URI (more efficient for display)
  - `get_micro_thumbnail(path)` → 16×16 data URI, also pre-warms full cache
  - `clear_thumbnail_cache()` → bytes cleared
  - `get_thumbnail_cache_stats()` → `{ count, totalSize, path }`
- Supports: jpg, jpeg, png, gif, webp, bmp

### `clipboard.rs` — OS Clipboard (Linux-specific)
- Shells out to `wl-paste`/`wl-copy` (Wayland) or `xclip` (X11) for MIME-aware clipboard
- Reads `x-special/gnome-copied-files` (GNOME/XFCE) and `text/uri-list` (KDE) formats
- **Commands:**
  - `clipboard_has_files()` → bool
  - `clipboard_read_files()` → `string[]` (parsed file:// URIs)
  - `clipboard_write_files(paths)` → bool (writes gnome-copied-files format)
  - `clipboard_has_image()` → bool (checks MIME types)
  - `clipboard_paste_image(directory)` → saved file path (reads PNG from clipboard, saves as timestamped file)

### `archive.rs` — ZIP Operations
- Uses `zip` crate with deflate compression
- **Commands:**
  - `compress_to_zip(paths)` → ZIP file path (auto-names based on selection)
  - `extract_archive(archive_path, extract_here)` → extraction directory path

### `wallpaper.rs` — Desktop Wallpaper
- Auto-detects: Hyprland/hyprpaper, Sway/swaybg, GNOME, KDE, XFCE, MATE, feh fallback
- **Command:** `set_as_wallpaper(path)`

### `config.rs` — Config File Persistence
- Config directory: `~/.config/tauri-explorer/`
- **Commands:**
  - `read_config_file(filename)` → JSON string (empty string if not found)
  - `write_config_file(filename, data)`
  - `get_config_dir()` → path string
  - `list_user_themes()` → `[(filename, css_content)]` from `~/.config/tauri-explorer/themes/`

### `error.rs` — Unified Error Type
- `AppError` enum: `NotFound`, `PermissionDenied`, `AlreadyExists`, `InvalidPath`, `Io`, `Other`
- Implements `Serialize` as `{ kind, message }` JSON object

### `task_registry.rs` — Cancellable Task Registry
- Thread-safe registry (`AtomicU64` counter + `Mutex<HashMap<u64, Arc<AtomicBool>>>`)
- Used by: streaming directory listing, streaming search, content search
- API: `start()` → `(id, cancelled_flag)`, `cancel(id)`, `cleanup(id)`
