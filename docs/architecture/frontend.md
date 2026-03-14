# Frontend Architecture — Svelte 5 + TypeScript

> Deep reference for the frontend. For the high-level map, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Entry Point & Initialization

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

## State Management Layer

All state lives in `src/lib/state/`. Svelte 5 runes (`$state`, `$derived`, `$effect`) provide reactivity. Each store is a module-level singleton created by a factory function.

### Core Stores

#### `explorer.svelte.ts` — Per-Pane Explorer State
- **Factory:** `createExplorerState()` — creates one instance per pane
- **State:** `currentPath`, `history[]`, `historyIndex`, `entries[]`, `loading`, `error`, `sortBy`, `sortAscending`, `viewMode`, `selectedPaths`, `selectionAnchorIndex`, `isCreatingFolder`
- **Derived:** `displayEntries` (filtered by hidden + sorted), `breadcrumbs`, `canGoBack`, `canGoForward`
- **Key methods:** `navigateTo`, `goBack/goForward/goUp`, `refresh`, `selectEntry`, `createFolder`, `rename`, `paste`, `undo/redo`, `startDelete`, `setSorting`, `setViewMode`

#### `window-tabs.svelte.ts` — Window-Level Tabs
- **Singleton:** `windowTabsManager`
- **State:** `tabs[]`, `activeTabId`
- **Explorer registry:** `Map<string, ExplorerInstance>` keyed by `explorerId`
- **Key methods:** `createTab`, `closeTab`, `restoreClosedTab`, `getExplorer`, `getActiveExplorer`, `toggleDualPane`, `setSplitRatio`
- **Persistence:** `PersistedTabState` saved to localStorage on every tab change + every 30s

#### `settings.svelte.ts` — App Settings
- **Singleton:** `settingsStore`
- **Persistence:** Dual write-through: localStorage (sync) + `~/.config/tauri-explorer/settings.json` (async via `config.rs`)

#### `theme.svelte.ts` — Theme Management
- **Singleton:** `themeStore`
- Themes discovered at runtime from CSS `[data-theme="id"]` rules
- User themes loaded from `~/.config/tauri-explorer/themes/*.css`

#### `keybindings.svelte.ts` — Customizable Keyboard Shortcuts
- **Singleton:** `keybindingsStore`
- **Chord support:** Two-step shortcuts like "Alt+M T"
- **Key method:** `findMatchingCommand(event, isAvailable?)` — returns command ID, `"chord:waiting"`, or `undefined`

#### Other Stores

| Store | File | Purpose |
|-------|------|---------|
| `clipboardStore` | `clipboard.svelte.ts` | Cross-window clipboard with OS integration |
| `dialogStore` | `dialogs.svelte.ts` | Global dialog state, `hasModalOpen` for keyboard guard |
| `undoStore` | `undo.svelte.ts` | Undo/redo stack (rename, move, delete) |
| `bookmarksStore` | `bookmarks.svelte.ts` | Sidebar bookmarks, dual persistence |
| `toastStore` | `toast.svelte.ts` | Temporary notifications |
| `contextMenuStore` | `context-menu.svelte.ts` | Right-click menu position/visibility |
| `frecencyStore` | `frecency.svelte.ts` | Zoxide-style path ranking for QuickOpen |
| `recentFilesStore` | `recent-files.svelte.ts` | Last 50 opened paths |
| `operationsManager` | `operations.svelte.ts` | Copy/move progress tracking |
| `conflictResolver` | `conflict-resolver.svelte.ts` | Promise-based conflict resolution |
| `workspacesStore` | `workspaces.svelte.ts` | Named tab layout snapshots |
| `dragState` | `drag.svelte.ts` | In-app drag data + cross-window via localStorage |

### Pure State Utilities (no Svelte runes)

| File | Purpose |
|------|---------|
| `selection.ts` | Pure functions: `calculateSelection()`, `selectByIndices()` |
| `navigation.ts` | Pure functions: `pushToHistory()`, `parseBreadcrumbs()`, `getParentPath()` |
| `paste-operations.ts` | Paste orchestration: estimates size, handles conflicts, broadcasts changes |
| `directory-listing.ts` | Streaming directory listing management |
| `drop-operations.ts` | Drop handler logic: conflict resolution, move/copy execution |
| `sort-prefs.ts` | Per-directory sort preference persistence |
| `command-definitions.ts` | All ~50 commands with handlers, categories, shortcuts, `when` guards |

## Domain Layer

`src/lib/domain/` — pure functions and types with no framework dependencies.

| File | Contents |
|------|----------|
| `file.ts` | `FileEntry`, `DirectoryListing`, `SortField`, `sortEntries()`, `filterHidden()`, `formatSize()` |
| `file-types.ts` | `getFileType()`, `getFileIconColor()`, `isImageFile()`, `isTextFile()`, icon mappings |
| `nerd-icons.ts` | Nerd Font glyph/color mappings per extension |
| `keyboard.ts` | `normalizeKeyForShortcut()`, shortcut key constants |
| `keybinding-parser.ts` | Shortcut parsing, matching, chord support |
| `zoom.ts` | CSS zoom compensation for context menu positioning |

## API Layer

`src/lib/api/` bridges frontend ↔ Rust backend.

- **`files.ts`** — Wraps every Rust command in async function returning `ApiResult<T>`. Auto-detects Tauri vs browser environment.
- **`mock-invoke.ts`** — Browser E2E mock with in-memory file system
- **`os-clipboard.ts`** — Thin wrappers around clipboard Tauri commands

## Component Tree

See [components.md](components.md) for the full component reference.
