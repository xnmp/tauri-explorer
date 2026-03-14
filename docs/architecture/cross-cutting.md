# Cross-Cutting Concerns

> Persistence, communication, theming, keyboard, drag-drop, and testing. For the high-level map, see [ARCHITECTURE.md](../ARCHITECTURE.md).

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
- `dark.css`, `light.css`, `ocean-blue.css`, `solarized-light.css`, `desert.css`, `hacker.css`, `aurora.css`, `horizon.css`
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
1. **Commands** defined in `command-definitions.ts` as arrays of `Command` objects (id, label, category, handler, optional shortcut, optional `when` guard)
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
Svelte 5 event delegation can break HTML5 DnD `drop` events in complex component trees. Workarounds:
1. **Shared drag state store** (`drag.svelte.ts`) — stores drag data in both `dataTransfer` and a reactive store + localStorage
2. **Native `addEventListener`** for sidebar bookmark drop zone (bypasses Svelte delegation)
3. Tauri requires `dragDropEnabled: false` (`disable_drag_drop_handler()` in Rust) for in-webview HTML5 DnD to work

### Internal DnD Flow
```
FileItem/ListView/TilesView dragstart
  → Sets dataTransfer types: application/x-explorer-{path,name,kind}
  → Calls dragState.start(data) (reactive store + localStorage)

Target (directory) dragover
  → Checks dataTransfer types OR dragState.readCrossWindow()
  → Shows visual feedback (blue = move, green = copy when Ctrl held)

Target drop / Source dragend
  → drop-operations.ts:getDropSourcePath() reads from dataTransfer or dragState
  → drop-operations.ts:handleItemDrop() (drop on directory) or handleBackgroundDrop() (drop on background)
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

### Rust Tests
- `files/dir_listing.rs` — Unit tests for `list_directory` (sorting, dir-before-file ordering)
- `files/file_ops.rs` — Unit tests for `create_directory`, `rename_entry`, `copy_entry`, `estimate_size`
- `clipboard.rs` — URI parsing, percent encoding/decoding tests

### Mock System
- `mock-invoke.ts` provides in-memory fake file system for all Tauri commands
- Enables running Playwright e2e tests against `vite dev` without Tauri runtime
- Mock file tree: `/home/user/{Documents,Downloads,Pictures,Music,Videos}`
