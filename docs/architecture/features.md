# Feature Map & Data Flow

> Maps every feature to the exact files that implement it. For the high-level map, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Feature Map

### Navigation
| Feature | Files to change |
|---------|----------------|
| Directory navigation | `explorer.svelte.ts:navigateTo`, `navigation.ts`, `directory-listing.ts`, `files/dir_listing.rs:start_streaming_directory` |
| Back/Forward/Up | `explorer.svelte.ts:goBack/goForward/goUp`, `navigation.ts` |
| Breadcrumb bar | `NavigationBar.svelte` (also accepts file drops on segments) |
| Path editing + autocomplete | `NavigationBar.svelte` (editable path input) |
| Breadcrumb caret picker | `NavigationBar.svelte` (subdirectory dropdown on chevron click) |
| History management | `navigation.ts:pushToHistory` |

### Plugins (#142)
| Feature | Files to change |
|---------|----------------|
| Plugin API surface | `plugins/api.ts` (PluginContext, disposal tracking, storage) → [plugins.md](plugins.md) |
| Built-in registry + lifecycle | `plugins/registry.svelte.ts` (enable/disable, `initPlugins`), `pluginsEnabled` in `settings.svelte.ts` |
| Context-menu contributions | `state/context-menu-items.svelte.ts` registry, rendered in `ContextMenu.svelte` |
| Settings contributions | `plugins/settings-registry.svelte.ts` + descriptor-driven rows in `SettingsDialog.svelte` (Plugins section) |
| Virtual-fs providers | `plugins/fs-providers.ts` dispatch, routed in `api/files.ts`, `domain/virtual-path.ts` helpers |
| Jobs (source-tagged) | `state/jobs.svelte.ts` (`detail`/`source`), `JobsPanel.svelte` |
| Demo/reference plugin | `plugins/demo/index.ts` |

### Git Integration
| Feature | Files to change |
|---------|----------------|
| Git status indicators | `git_status.rs` (Rust command), `git-status.svelte.ts` (store), `FileItem.svelte` (badge), `ExplorerPane.svelte` (fetch trigger), `settings.svelte.ts` (toggle) |

### File Operations
| Feature | Files to change |
|---------|----------------|
| Create folder | `explorer.svelte.ts:createFolder`, `InlineNewFolder.svelte`, `files/file_ops.rs:create_directory` |
| Rename (inline) | `FileItem.svelte` (details), `ListView.svelte`/`TilesView.svelte` (list/tiles via `use-inline-rename.svelte.ts`), `explorer.svelte.ts:rename`, `files/file_ops.rs:rename_entry` |
| Rename (slow-click) | `FileItem.svelte:handleClick` (500ms timer after single-click on name of selected item) |
| Bulk rename | `BulkRenameDialog.svelte`, `dialogStore.openBulkRename()` |
| Delete (to trash) | `explorer.svelte.ts:startDelete/confirmDelete`, `DeleteDialog.svelte`, `lib.rs:move_to_trash` |
| Delete (permanent) | `files/file_ops.rs:delete_entry_permanent` |
| Copy/Move (paste) | `paste-operations.ts`, `clipboard.svelte.ts`, `files/file_ops.rs:copy_entry/move_entry` |
| Conflict resolution | `conflict-resolver.svelte.ts`, `ConflictDialog.svelte` — shows file size + date for source/destination |
| Progress tracking | `operations.svelte.ts`, `ProgressDialog.svelte` |
| Undo/Redo | `undo.svelte.ts`, `undo-helpers.ts`, `explorer.svelte.ts:undo/redo` |
| Open file | `files/external_apps.rs:open_file`, `FileList.svelte:handleDoubleClick` |
| Open with specific app | `files/external_apps.rs:open_file_with` |
| Open image with siblings | `files/external_apps.rs:open_image_with_siblings`, `FileList.svelte` |
| Create symlink | `ContextMenu.svelte:handleCreateSymlink`, `files/file_ops.rs:create_symlink` |
| Compress to ZIP | `ContextMenu.svelte:handleCompress`, `archive.rs:compress_to_zip` |
| Extract archive | `ContextMenu.svelte:handleExtractHere/handleExtractToFolder`, `archive.rs:extract_archive` |
| Open in terminal | `ContextMenu.svelte:handleOpenInTerminal`, `files/external_apps.rs:open_in_terminal` |
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
| Miller columns | `MillerColumns.svelte` — optional 1-3 ancestor columns panel (left of file list, directories only), resizable, draggable to bookmarks, supports drop-to-move/copy, auto-refreshes on filesystem changes, works with any view mode |
| File type icons | `FileIcon.svelte` — real devicon SVG paths (Python, TS, JS, HTML5, CSS3) + fallback labels, works in both small (details/list) and large (tiles) views |
| Details view | `DetailsView.svelte` (VirtualList + FileItem), `FileItem.svelte` |
| List view | `ListView.svelte` (CSS grid column-flow with configurable columns) |
| Tiles view | `TilesView.svelte` (CSS auto-fill grid with thumbnail images, progressive rendering) |
| Tiles size from palette | `command-definitions.ts` — tile size commands also switch view mode to tiles |
| Tiles scroll perf logging | `TilesView.svelte:handleScroll` — dev-only frame time metrics logged to console |
| Column resize (details) | `use-column-resize.svelte.ts`, `DetailsView.svelte` |
| Column visibility toggle | `DetailsView.svelte` (column header right-click menu), `settingsStore.columnVisibility` |
| List column count | `settingsStore.listViewColumns`, `ListView.svelte:effectiveListColumns` |

### Search
| Feature | Files to change |
|---------|----------------|
| Quick Open (Ctrl+P) | `QuickOpen.svelte`, `files.ts:startStreamingSearch`, `search.rs` |
| Quick Open debug mode | `QuickOpen.svelte` + `settingsStore.quickOpenDebug` — shows name/frecency/dir score breakdown per result |
| Content search (Ctrl+Shift+F) | `ContentSearchDialog.svelte`, `files.ts:startContentSearch`, `content_search.rs` |
| Filenames-only toggle (Alt+F) | `ContentSearchDialog.svelte` — view-level collapse to one row per file, no re-search |
| Directory filter (Ctrl+F) | `NavigationBar.svelte` (filter bar UI), `explorer.svelte.ts:setFilter` (auto-selects first match) |
| Frecency ranking | `frecency.svelte.ts`, used by `QuickOpen.svelte` |

### Tabs & Windows
| Feature | Files to change |
|---------|----------------|
| Per-pane tabs | `window-tabs.svelte.ts`, `PaneTabBar.svelte`, `PaneContainer.svelte` |
| New tab (Ctrl+T) | `windowTabsManager.createTab()` |
| Close tab (Ctrl+W) | `windowTabsManager.closeActiveTab()` |
| Restore closed tab | `windowTabsManager.restoreClosedTab()` (persisted stack) |
| Tab reorder / move across panes | `PaneTabBar.svelte` (drag), `windowTabsManager.reorderTabs(paneId, …)` / `moveTabToPane()` |
| New window (Ctrl+N) | `command-definitions.ts:openNewWindow()` — creates `WebviewWindow` with URL params |
| Dual pane (Ctrl+\\) | `windowTabsManager.toggleDualPane()`, `PaneContainer.svelte` |
| Split ratio resize | `PaneContainer.svelte` mouse handlers, `windowTabsManager.setSplitRatio()` |
| Git commit graph (#51/#57/#58/#179) | `git_log.rs` (git_log/git_refs/git_commit_files via libgit2; weaves stashes in as pseudo-commits), `api/git-log.ts`, `domain/git-graph.ts` (`assignLayout` vertex/branch model: continuous first-parent-chain polylines, branch-owned colors with reuse, merge-edge snapping — behavioral parity with VSCode Git Graph, reimplemented not ported), `GitGraphView.svelte` (one SVG path per branch in a shared underlay so lines never break at row boundaries; synthetic “Uncommitted Changes” row, stash ring markers, combined local+remote ref chips), opened via the `git.showGraph` palette command into a per-pane git-graph tab (#56) |
| Crash reporting (#184) | `crash_report.rs` (panic hook → `<log dir>/crashes/`, take_crash_report consumes newest once, log_frontend_error, open_external_url), `api/crash.ts` (global onerror/unhandledrejection forwarding, pre-filled GitHub issue URL), `CrashNotice.svelte` banner in `+page.svelte`. Local files only — no telemetry |
| Update checker (#185) | `update_check.rs` (GitHub releases API via ureq, dotted-version compare), `api/update.ts` (once-a-day throttle in localStorage), `UpdateNotice.svelte` banner. Notification only — no auto-download |
| Shortcut cheatsheet + first-run hint (#186) | `ShortcutCheatsheet.svelte` (live effective bindings grouped by category, Ctrl+/ or `help.shortcuts` palette command), `FirstRunHint.svelte` (one-time banner, suppressed by default in mock env via `firstRunHintDismissed`) |
| Bug report + logs commands (#197) | `help.reportBug` palette command (pre-filled GitHub issue with version/OS via `bugReportUrl` in `api/crash.ts` + `get_app_info` in `system.rs`), `help.openLogs` navigates to the app log dir |
| Workspaces | `workspaces.svelte.ts`, `WorkspaceDialog.svelte` |
| Tab tear-off / cross-window move | `tab-transfer.ts` (localStorage marker + BroadcastChannel claim), `PaneTabBar.svelte` (drag handlers), `windowTabsManager.exportTab/adoptTab/removeTransferredTab`, label-keyed `tab-seed` in `openNewWindow` |
| System file picker (portal) | `portal.rs` (D-Bus FileChooser backend), `FilePicker.svelte` (?picker= mode; Ctrl+P fuzzy quick-open via `PickerQuickOpen.svelte` #190 — picks confirm in open mode, prefill in save mode, navigate for dirs), `packaging/` (.portal + .service) |

### Clipboard
| Feature | Files to change |
|---------|----------------|
| Internal clipboard | `clipboard.svelte.ts` |
| OS clipboard files | `os-clipboard.ts`, `clipboard.rs` |
| Paste image from clipboard | `clipboard.rs:clipboard_paste_image`, `files.ts:clipboardPasteImage` |
| Cross-window clipboard sync | `clipboard.svelte.ts` (Tauri events) |
| Visual feedback (badges) | `FileItem.svelte` (details: clipboard badge, cut opacity), `ListView.svelte`/`TilesView.svelte` (list/tiles: `.cut`/`.in-clipboard` CSS classes) |

### Thumbnails
| Feature | Files to change |
|---------|----------------|
| Thumbnail generation | `thumbnails.rs` |
| Progressive loading | `ThumbnailImage.svelte` (micro → full), `files.ts:getMicroThumbnail/getThumbnailData` |
| Cache management | Settings dialog, `thumbnails.rs:clear_thumbnail_cache/get_thumbnail_cache_stats` |
| Supported formats | `thumbnails.rs:SUPPORTED_EXTENSIONS` + `file-types.ts:THUMBNAIL_EXTENSIONS` (AVIF is Linux-only, via image avif-native/dav1d) |
| Folder previews (large/XL tiles) | `domain/folder-preview.ts` (selection spec), `thumbnails.rs:get_folder_preview` (bounded scan → image paths + fingerprint), `FolderThumbnail.svelte` (client-side composite over ThumbnailImage; per-folder fs watch while visible — the backend watcher is non-recursive, so this is what makes previews refresh on change), `TilesView.svelte` gate |
| Zip / unzip with progress | `archive.rs` (chunked writes, zip-progress/unzip-progress events, cancel_compress/cancel_extract), `pane-mutations.ts:runArchiveJob` (shared compress/extract), `operations.svelte.ts` ("compress"/"extract" types). Progress panel auto-hides per-operation after a short linger. |
| Markdown preview | `domain/markdown.ts` (marked + hljs, escaped raw HTML), `PreviewPane.svelte` (.preview-markdown) |
| ZIP content preview | `archive.rs:list_archive_contents` (top-level entries as `FileEntry`s), `files.ts:listArchiveContents`, `file-types.ts:isZipFile`, `PreviewPane.svelte` (renders in the shared `.preview-folder-list` folder format) |

### Embedded Terminal
| Feature | Files to change |
|---------|----------------|
| PTY backend | `terminal.rs` (portable-pty; spawn/write/resize/kill commands, per-window registry, killed via `on_window_destroyed` in `lib.rs` run loop; output streamed as `terminal-output-{id}` events) |
| Terminal panel | `TerminalPanel.svelte` (xterm.js + fit addon, lazy-imported on first open, stays mounted while hidden so the shell survives toggling), `state/terminal.svelte.ts` (visibility), `api/terminal.ts` |
| Toggle (Ctrl+\`) | hardcoded in `+page.svelte:handleKeydown` *before* the input-field guard (so it closes from inside the terminal); palette entry `view.toggleTerminal` in `commands/view-commands.ts` |
| Theming | `domain/terminal-theme.ts` (CSS vars → xterm theme object, re-applied on theme switch — xterm can't consume CSS vars) |
| cwd sync (base) | shell spawns at the active explorer's path; explicit header action writes `domain/terminal-command.ts:buildCdCommand` (POSIX quoting / cmd.exe `/d`) |
| Terminal follows explorer (#149) | `settingsStore.terminalFollowsExplorer` (default on). `$effect` on active pane's `currentPath` → `terminal_status` → `domain/terminal-cwd-sync.ts:decideCdSync` (skip if already there / queue if busy / write). Injected `cd` is Ctrl+U (0x15) + `buildCdCommand`. `TerminalPanel.svelte` |
| Busy detection (#149) | `terminal.rs:is_busy` — Unix compares `libc::tcgetpgrp(master fd)` with the shell pid (foreground pgrp != shell ⇒ busy); Windows optimistic (false). Exposed via `terminal_status` `{ busy, cwd }` |
| Queued cd (#149) | while a command runs, latest target is stored as `pendingCd`, a one-off toast shows, and a 500ms `terminal_status` poll flushes it once idle. `TerminalPanel.svelte` |
| Explorer follows terminal (#149) | `settingsStore.explorerFollowsTerminal` (default on). `terminal.rs:Osc7Scanner` parses OSC 7 (`ESC ] 7 ; file://host/path` BEL/ST, chunk-boundary safe, percent-decoded) in the reader thread → `terminal-cwd-{id}` event → active pane `navigateTo`. `lastShellCwd` is the loop guard for the other direction |
| ZDOTDIR shim (#149) | `terminal.rs:zsh_shim_files`/`install_zsh_shim` — zsh gets a VS Code-style shim dir (`dirs::cache_dir()/tauri-explorer/zsh-shim/`) whose `.zshrc` sources the user's files then adds a `chpwd` hook emitting OSC 7. Best-effort (degrades silently). fish emits OSC 7 natively; bash skipped (PROMPT_COMMAND unreliable) |
| Panel height | `settingsStore.terminalPanelHeight` (drag handle in `TerminalPanel.svelte`) |

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
        → Rust: files::dir_listing::start_streaming_directory
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
