# Component Reference

> Full list of Svelte components. For the high-level map, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## `src/lib/components/`

| Component | File | Purpose |
|-----------|------|---------|
| **TitleBar** | `TitleBar.svelte` | Custom decorationless title bar, only visible when >1 tab. Contains `WindowTabBar` |
| **WindowTabBar** | `WindowTabBar.svelte` | Tab strip: tab buttons (closeable, reorderable), new tab button |
| **SharedToolbar** | `SharedToolbar.svelte` | Search box, theme switcher, window controls (minimize/maximize/close) |
| **ThemeSwitcher** | `ThemeSwitcher.svelte` | Dropdown to select theme |
| **Sidebar** | `Sidebar.svelte` | Home button, dual-pane toggle, Quick Access (system folders + user bookmarks with drag-to-reorder), This PC (drives). Resizable (180-400px) |
| **PaneContainer** | `PaneContainer.svelte` | Manages single/dual pane layout with resizable divider |
| **ExplorerPane** | `ExplorerPane.svelte` | Self-contained pane with NavigationBar + FileList + ContextMenu + dialogs. Handles arrow-key navigation |
| **NavigationBar** | `NavigationBar.svelte` | Back/Forward/Up/Refresh buttons, breadcrumb bar with editable path input and autocomplete |
| **FileList** | `FileList.svelte` | View mode dispatcher. Handles: marquee selection, type-ahead, background click/context menu, background drag-and-drop |
| **DetailsView** | `DetailsView.svelte` | Column headers with sort/resize, VirtualList with FileItem rows |
| **ListView** | `ListView.svelte` | CSS grid column-flow with configurable columns |
| **TilesView** | `TilesView.svelte` | CSS auto-fill grid with thumbnail support, progressive rendering |
| **FileItem** | `FileItem.svelte` | Single row in details view. Inline rename, drag source, drop target |
| **FileIcon** | `FileIcon.svelte` | File/folder icon. Supports three themes: default (SVG), material (Nerd Fonts), minimal |
| **VirtualList** | `VirtualList.svelte` | Generic virtual scrolling for fixed-height items |
| **ThumbnailImage** | `ThumbnailImage.svelte` | Progressive image loading: micro → full thumbnail, lazy via IntersectionObserver |
| **InlineNewFolder** | `InlineNewFolder.svelte` | Inline editable placeholder for creating new folders |
| **ContextMenu** | `ContextMenu.svelte` | Right-click menu with all file operations |
| **PreviewPane** | `PreviewPane.svelte` | Side panel: image/text/PDF preview + file metadata |
| **StatusBar** | `StatusBar.svelte` | Bottom bar: item count, selected count + size, current path |
| **QuickOpen** | `QuickOpen.svelte` | Ctrl+P fuzzy file search with frecency ranking |
| **CommandPalette** | `CommandPalette.svelte` | Ctrl+Shift+P command search |
| **ContentSearchDialog** | `ContentSearchDialog.svelte` | Ctrl+Shift+F grep-in-files using ripgrep backend |
| **SettingsDialog** | `SettingsDialog.svelte` | Settings UI: appearance, behavior, keybindings, thumbnail cache |
| **KeybindingsSettings** | `KeybindingsSettings.svelte` | Keybinding customization: search, record, conflict detection |
| **WorkspaceDialog** | `WorkspaceDialog.svelte` | Save/restore named tab layout snapshots |
| **BulkRenameDialog** | `BulkRenameDialog.svelte` | Multi-file rename with find/replace, regex, sequence patterns |
| **ProgressDialog** | `ProgressDialog.svelte` | Copy/move progress (appears after 1.5s delay), cancellable |
| **ConflictDialog** | `ConflictDialog.svelte` | Overwrite/Skip/Cancel for file conflicts, with "Apply to all" |
| **DeleteDialog** | `DeleteDialog.svelte` | Delete confirmation |
| **ToastOverlay** | `ToastOverlay.svelte` | Toast notifications from `toastStore` |
| **AnimatedBackground** | `AnimatedBackground.svelte` | Optional canvas-based animated background |

## Composables (`src/lib/composables/`)

| File | Purpose |
|------|---------|
| `use-column-resize.svelte.ts` | Resizable column headers in details view |
| `use-marquee-selection.svelte.ts` | Rubber-band selection rectangle with DOM-based hit testing |
| `use-type-ahead.svelte.ts` | Type-ahead: typing characters jumps to matching file name |
| `use-inline-rename.svelte.ts` | Shared inline rename logic for list/tiles views |
| `use-external-drag.svelte.ts` | Dragging files OUT of the app to the OS |
| `use-external-drop.svelte.ts` | Files dropped INTO the app from OS |
