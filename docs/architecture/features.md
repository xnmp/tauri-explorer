# Feature Map & Data Flow

> Maps every feature to the exact files that implement it. For the high-level map, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Feature Map

### Navigation
| Feature | Files to change |
|---------|----------------|
| Directory navigation | `explorer.svelte.ts:navigateTo`, `navigation.ts`, `directory-listing.ts`, `files/dir_listing.rs:start_streaming_directory` |
| Back/Forward/Up | `explorer.svelte.ts:goBack/goForward/goUp`, `navigation.ts` |
| Breadcrumb bar | `NavigationBar.svelte` |
| Path editing + autocomplete | `NavigationBar.svelte` (editable path input) |
| Breadcrumb caret picker | `NavigationBar.svelte` (subdirectory dropdown on chevron click) |
| History management | `navigation.ts:pushToHistory` |

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
| Conflict resolution | `conflict-resolver.svelte.ts`, `ConflictDialog.svelte` |
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
| Details view | `DetailsView.svelte` (VirtualList + FileItem), `FileItem.svelte` |
| List view | `ListView.svelte` (CSS grid column-flow with configurable columns) |
| Tiles view | `TilesView.svelte` (CSS auto-fill grid with thumbnail images, progressive rendering) |
| Column resize (details) | `use-column-resize.svelte.ts`, `DetailsView.svelte` |
| Column visibility toggle | `DetailsView.svelte` (column header right-click menu), `settingsStore.columnVisibility` |
| List column count | `settingsStore.listViewColumns`, `ListView.svelte:effectiveListColumns` |

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
| Visual feedback (badges) | `FileItem.svelte` (details: clipboard badge, cut opacity), `ListView.svelte`/`TilesView.svelte` (list/tiles: `.cut`/`.in-clipboard` CSS classes) |

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
