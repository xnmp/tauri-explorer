# Architecture Consolidation Handoff

This document provides context for refactoring the codebase to improve modularity and maintainability.

## Related Issues

- **tauri-explorer-5lbi** (P1) - EPIC: Architecture Improvements
- **tauri-explorer-1k9k** (P1) - Split explorer.svelte.ts God-object into focused stores

Run `bd show tauri-explorer-1k9k` for full details.

---

## Current State Assessment

### File Sizes (lines of code)

| File | Lines | Status |
|------|-------|--------|
| `src/lib/state/explorer.svelte.ts` | 448 | **God object - needs splitting** |
| `src/lib/components/FileList.svelte` | 898 | **Too large - needs splitting** |
| `src/lib/components/FileItem.svelte` | 532 | Large but acceptable |
| `src/lib/components/Sidebar.svelte` | 613 | Large but acceptable |

### Existing State Modules (good pattern to follow)

```
src/lib/state/
├── explorer.svelte.ts    # 448 lines - THE PROBLEM
├── clipboard.svelte.ts   # 1.3k - Already extracted, good pattern
├── settings.svelte.ts    # 1.8k - Good pattern
├── theme.svelte.ts       # 2.7k - Good pattern
├── panes.svelte.ts       # 1.5k - Good pattern
├── bookmarks.svelte.ts   # 2.0k - Good pattern
├── pane-context.ts       # 689 - Context provider
├── types.ts              # 1.7k - Shared types
├── navigation.ts         # 2.1k - Pure utility functions
└── selection.ts          # 2.4k - Pure utility functions
```

### Svelte Warnings (9 total)

Run `npm run check` to see them. Most are:
- `non_reactive_update` - Variables updated but not declared with `$state`
- `state_referenced_locally` - Props captured at initial value instead of reactively

---

## The God Object: explorer.svelte.ts

### Current Responsibilities (too many!)

The `createExplorerState()` function manages **9 distinct concerns**:

1. **Navigation** - currentPath, history, historyIndex, navigateTo, goBack, goForward, goUp
2. **Directory Loading** - entries, loading, error, refresh, navigateInternal
3. **View Options** - showHidden, sortBy, sortAscending, viewMode
4. **Selection** - selectedPaths, selectionAnchorIndex, selectEntry, clearSelection
5. **Dialogs** - newFolderDialogOpen, renamingEntry, deletingEntry
6. **Context Menu** - contextMenuOpen, contextMenuPosition
7. **File Operations** - createFolder, rename, confirmDelete
8. **Clipboard** - copyToClipboard, cutToClipboard, paste (delegates to clipboardStore)
9. **Undo** - undoStack, undo, executeUndo

### Current State Shape

```typescript
interface ExplorerState {
  // Navigation
  currentPath: string;
  history: string[];
  historyIndex: number;

  // Entries
  entries: FileEntry[];
  loading: boolean;
  error: string | null;

  // View options
  showHidden: boolean;
  sortBy: SortField;
  sortAscending: boolean;
  viewMode: ViewMode;

  // Selection
  selectedPaths: Set<string>;
  selectionAnchorIndex: number | null;

  // Dialogs
  newFolderDialogOpen: boolean;
  renamingEntry: FileEntry | null;
  deletingEntry: FileEntry | null;

  // Context menu
  contextMenuOpen: boolean;
  contextMenuPosition: { x: number; y: number } | null;

  // Clipboard & Undo
  clipboard: ClipboardState | null;  // Deprecated
  undoStack: UndoAction[];
}
```

---

## Recommended Refactoring Plan

### Phase 1: Extract Dialog State

Create `src/lib/state/dialogs.svelte.ts`:

```typescript
// Manages: newFolderDialogOpen, renamingEntry, deletingEntry
function createDialogStore() {
  let newFolderOpen = $state(false);
  let renamingEntry = $state<FileEntry | null>(null);
  let deletingEntry = $state<FileEntry | null>(null);

  return {
    get newFolderOpen() { return newFolderOpen; },
    get renamingEntry() { return renamingEntry; },
    get deletingEntry() { return deletingEntry; },
    openNewFolder: () => { newFolderOpen = true; },
    closeNewFolder: () => { newFolderOpen = false; },
    startRename: (entry: FileEntry) => { renamingEntry = entry; },
    cancelRename: () => { renamingEntry = null; },
    startDelete: (entry: FileEntry) => { deletingEntry = entry; },
    cancelDelete: () => { deletingEntry = null; },
  };
}
```

### Phase 2: Extract Context Menu State

Create `src/lib/state/context-menu.svelte.ts`:

```typescript
// Manages: contextMenuOpen, contextMenuPosition
function createContextMenuStore() {
  let isOpen = $state(false);
  let position = $state<{ x: number; y: number } | null>(null);

  return {
    get isOpen() { return isOpen; },
    get position() { return position; },
    open: (x: number, y: number) => { position = { x, y }; isOpen = true; },
    close: () => { isOpen = false; position = null; },
  };
}
```

### Phase 3: Extract View Options State

Create `src/lib/state/view-options.svelte.ts`:

```typescript
// Manages: showHidden, sortBy, sortAscending, viewMode
// Could persist to localStorage like settings.svelte.ts does
function createViewOptionsStore() {
  let showHidden = $state(false);
  let sortBy = $state<SortField>("name");
  let sortAscending = $state(true);
  let viewMode = $state<ViewMode>("details");

  return {
    get showHidden() { return showHidden; },
    get sortBy() { return sortBy; },
    get sortAscending() { return sortAscending; },
    get viewMode() { return viewMode; },
    toggleHidden: () => { showHidden = !showHidden; },
    setSorting: (by: SortField) => { /* ... */ },
    setViewMode: (mode: ViewMode) => { viewMode = mode; },
  };
}
```

### Phase 4: Extract Undo State

Create `src/lib/state/undo.svelte.ts`:

```typescript
// Manages: undoStack
function createUndoStore() {
  let stack = $state<UndoAction[]>([]);

  return {
    get canUndo() { return stack.length > 0; },
    push: (action: UndoAction) => { stack = [...stack, action]; },
    pop: () => {
      const action = stack[stack.length - 1];
      stack = stack.slice(0, -1);
      return action;
    },
    clear: () => { stack = []; },
  };
}
```

### Phase 5: Slim Down Explorer State

After extraction, `explorer.svelte.ts` should only manage:
- **Navigation**: currentPath, history, historyIndex
- **Directory**: entries, loading, error
- **Selection**: selectedPaths, selectionAnchorIndex

This brings it from 448 lines to ~200 lines.

---

## FileList.svelte Refactoring

The 898-line FileList.svelte can be split:

1. **Extract `ColumnHeaders.svelte`** (~100 lines) - The sortable column headers
2. **Extract `ListViewItem.svelte`** (~50 lines) - The list view row
3. **Extract `TilesViewItem.svelte`** (~50 lines) - The tiles view item
4. **Extract `MarqueeSelection.svelte`** (~80 lines) - Drag selection logic
5. **Extract `DropZone.svelte`** (~60 lines) - Drop handling for file moves

---

## Key Patterns to Follow

### Pattern 1: Singleton Store with Getters

```typescript
function createStore() {
  let value = $state(initialValue);

  return {
    get value() { return value; },  // Getter maintains reactivity
    setValue: (v) => { value = v; },
  };
}

export const store = createStore();  // Singleton
```

### Pattern 2: Factory for Multi-Instance (like explorer)

```typescript
function createExplorerState() {
  // ... state and methods
  return { /* public API */ };
}

export { createExplorerState };
export type ExplorerInstance = ReturnType<typeof createExplorerState>;
```

### Pattern 3: Pure Utility Functions (selection.ts, navigation.ts)

```typescript
// No state, just pure functions
export function calculateSelection(entries, entry, selectedPaths, options) {
  // Pure calculation, returns new state
  return { selectedPaths: new Set([...]), anchorIndex };
}
```

---

## Testing After Refactoring

1. **Type check**: `npm run check`
2. **Unit tests**: `npm test` (if available)
3. **Manual testing**:
   - Navigation (back/forward/up)
   - File operations (create folder, rename, delete)
   - Selection (click, ctrl+click, shift+click, marquee)
   - Dual pane (switch panes, copy between panes)
   - View modes (details, list, tiles)
   - Context menu
   - Keyboard shortcuts

---

## Commands Reference

```bash
# View the issues
bd show tauri-explorer-5lbi
bd show tauri-explorer-1k9k

# Check types and warnings
npm run check

# Run dev server for manual testing
npm run dev

# Mark issue in progress
bd set-state tauri-explorer-1k9k in_progress

# Close issue when done
bd close tauri-explorer-1k9k -r "Split into dialogs.svelte.ts, context-menu.svelte.ts, view-options.svelte.ts, undo.svelte.ts"
```

---

## Success Criteria

1. **explorer.svelte.ts** reduced from 448 lines to ~200 lines
2. **No new Svelte warnings** introduced
3. **All existing functionality preserved**
4. **FileList.svelte** reduced from 898 lines to ~500 lines
5. **Clear separation of concerns** - each store has one responsibility
6. **Consistent patterns** across all state modules

---

## Suggested Kickoff Prompt

```
Read architecture_consolidation.md for context. Then refactor the codebase:

1. Extract dialog state from explorer.svelte.ts into dialogs.svelte.ts
2. Extract context menu state into context-menu.svelte.ts
3. Extract view options into view-options.svelte.ts
4. Extract undo stack into undo.svelte.ts
5. Update all component imports
6. Run npm run check after each extraction to catch issues early

Follow the patterns in clipboard.svelte.ts and settings.svelte.ts.
```
