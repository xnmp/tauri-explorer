# Component Reference

> Full list of Svelte components. For the high-level map, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## `src/lib/components/`

| Component | File | Purpose |
|-----------|------|---------|
| **TitleBar** | `TitleBar.svelte` | Custom decorationless title bar (drag region + window controls), visible only when window controls or the integrated title bar are enabled |
| **WindowTabBar** | `WindowTabBar.svelte` | Window tab strip (#228): tab buttons (closeable, reorderable, draggable across windows), new tab button, double-click rename for multi-pane tabs (saves the layout as a workspace). Shown with 2+ tabs or when the active tab is renameable |
| **SharedToolbar** | `SharedToolbar.svelte` | Search box, theme switcher, settings gear button, window controls (minimize/maximize/close) |
| **ThemeSwitcher** | `ThemeSwitcher.svelte` | Dropdown to select theme |
| **Sidebar** | `Sidebar.svelte` | Host shell: activity-bar icon strip + active view + resize handle (180-400px). Views switch instantly; inactive views stay mounted (hidden) so scroll/selection survive. Active view persists per-window. |
| **ActivityBar** | `ActivityBar.svelte` | VSCode-style narrow icon strip on the sidebar's leftmost edge. Each button corresponds to a registered `SidebarView`. |
| **FilesSidebarView** | `FilesSidebarView.svelte` | Explorer view: Bookmarks (system folders + user bookmarks with drag-to-reorder, custom icons for Repos/Code folders), Removable Drives, Recent locations (sorted by frecency score, excludes bookmarked paths, configurable count). |
| **ScmSidebarView** | `ScmSidebarView.svelte` | Source Control view: branch line, commit input (Enter commits, Shift+Enter newline, amend toggle), Merge / Staged / Changes / Untracked sections with hover actions (stage / unstage / discard). Empty state with Initialize Repository button when not a git repo. Arrow keys move row selection. Clicking a row opens `ScmDiffView` in the active pane. |
| **ScmDiffView** | `ScmDiffView.svelte` | Unified-diff viewer that replaces the `FileList` in the active pane when a SCM row is clicked (#55). Virtualized via `VirtualList` for large diffs, renders +/− gutters with old/new line numbers, shows a "Binary file changed" placeholder for binary diffs, header actions (Open File, Stage/Unstage, Discard). Escape or Back returns to the file list. |
| **VirtualList** | `VirtualList.svelte` | Shared DOM virtualizer. Details virtualizes by entry; List and Tiles chunk entries into row-major rows (`domain/virtual-layout.ts`) and virtualize by row (#128), so large folders keep only visible rows in the DOM |
| **PaneContainer** | `PaneContainer.svelte` | Hosts the `WindowTabBar` and the active tab's content: a `PaneLayoutView` tree for explorer tabs, `GitGraphView` for graph tabs |
| **PaneLayoutView** | `PaneLayoutView.svelte` | Recursive renderer for a tab's pane layout tree (#228): leaves render `ExplorerPane`s, splits render two children with a resizable divider (row or column) |
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
| **PreviewPane** | `PreviewPane.svelte` | Side panel: image/text/PDF/folder preview (with file icons) + file metadata |
| **StatusBar** | `StatusBar.svelte` | Bottom bar: item count, folder/file breakdown, total file size, selected count/size breakdown, current path |
| **QuickOpen** | `QuickOpen.svelte` | Ctrl+P fuzzy file search with frecency ranking |
| **CommandPalette** | `CommandPalette.svelte` | Ctrl+Shift+P command search |
| **ContentSearchDialog** | `ContentSearchDialog.svelte` | Ctrl+Shift+F grep-in-files using ripgrep backend |
| **SettingsDialog** | `SettingsDialog.svelte` | Settings UI with search filter: appearance, behavior, keybindings, thumbnail cache |
| **KeybindingsSettings** | `KeybindingsSettings.svelte` | Keybinding customization: search, record, conflict detection |
| **WorkspaceDialog** | `WorkspaceDialog.svelte` | Save/restore named tab layout snapshots |
| **BulkRenameDialog** | `BulkRenameDialog.svelte` | Multi-file rename with find/replace, regex, sequence patterns |
| **Modal** | `Modal.svelte` | Shared overlay primitive used by every dialog: backdrop, Escape, focus trap, focus restore, ARIA, z-index layer (`--z-modal`); standard card chrome in `modal.css` (`.modal-card`) |
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
| `use-drop-target.svelte.ts` | Shared drop-target logic (dragOver/leave/drop + visual state) used by views and MillerColumns |
| `use-item-interactions.svelte.ts` | Shared DnD source, context menu, clipboard state for all view modes (composes use-drop-target) |
| `use-external-drag.svelte.ts` | Dragging files OUT of the app to the OS |
| `use-external-drop.svelte.ts` | Files dropped INTO the app from OS |
