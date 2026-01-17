# Session Handover

Continuing work on P1 issues after completing P0 keyboard shortcut fix.

**Previous session summary:**
- Converted 4 new_todo.md items to beads issues
- Fixed P0 bug: keyboard shortcuts broken when Caps Lock enabled
- Added Tauri API mocks for browser-based E2E testing

**Key context:**
- Branch: `feature/command-palette` with all recent feature work
- Beads issue tracker: use `bd` CLI for issue management
- Keyboard shortcuts now normalize keys to lowercase for consistent matching

**Completed this session:**
- tauri-explorer-gnvv [P0] - Fixed keyboard shortcuts (Caps Lock issue)
- Added mock-invoke.ts for E2E testing without Tauri backend
- Added keyboard.ts domain module with normalization utilities
- Added e2e/keyboard.spec.ts with comprehensive shortcut tests

**Current P1 issues (6 remaining):**
```
tauri-explorer-ldfx - Move tabs above pane level (window-level tabs)
tauri-explorer-ac7y - Keyboard navigation in file list
tauri-explorer-qcq5 - Persist tabs across sessions
tauri-explorer-klo  - Persist hidden files preference
tauri-explorer-zgf  - Ctrl+H shortcut for hidden files toggle
tauri-explorer-u5a  - Ctrl+Y/Ctrl+Shift+Z to redo
```

**Current state:**
- All tests passing (68 vitest + 21 keyboard tests)
- TypeScript check passes (0 errors, 10 warnings)
- E2E tests run with mock data in browser

**Next steps:**
1. Implement Ctrl+H shortcut for hidden files toggle (quick win)
2. Implement Ctrl+Y/Ctrl+Shift+Z for redo (quick win)
3. Add keyboard navigation in file list (arrows, Page Up/Down)
4. Persist hidden files preference (localStorage)
5. Persist tabs across sessions (localStorage)
6. Move tabs above pane level (architectural change - biggest)

**Relevant files:**
- `src/lib/domain/keyboard.ts` - keyboard utilities
- `src/lib/components/ExplorerPane.svelte` - pane-level shortcuts
- `src/lib/components/FileList.svelte` - file list keyboard handling
- `src/lib/state/settings.svelte.ts` - user preferences
- `src/lib/state/tabs.svelte.ts` - tab management
- `src/lib/api/mock-invoke.ts` - mock Tauri API for testing

---

## Architecture Overview

### State Management Pattern (Svelte 5 Runes)
```
src/lib/state/
├── explorer.svelte.ts   # Per-pane explorer state (entries, selection, navigation)
├── tabs.svelte.ts       # Tab management (each pane has tabs, each tab has an explorer)
├── panes.svelte.ts      # Dual-pane management (left/right, active pane)
├── clipboard.svelte.ts  # GLOBAL - shared clipboard across panes
├── dialogs.svelte.ts    # GLOBAL - rename/delete/new folder dialogs
├── context-menu.svelte.ts # GLOBAL - right-click context menu
├── undo.svelte.ts       # GLOBAL - undo stack for file operations
├── commands.svelte.ts   # Command registry for command palette
├── settings.svelte.ts   # User preferences (theme, sidebar, toolbar visibility)
└── theme.svelte.ts      # Theme management (light/dark/system)
```

**Key pattern:** Per-pane state (explorer) vs global state (clipboard, undo, dialogs). The explorer.svelte.ts exposes a `state` derived that merges core state with global store references for backward compatibility.

### Keyboard Shortcut Handling
```
src/lib/domain/keyboard.ts     # Key normalization utilities
+page.svelte                   # Global shortcuts (Ctrl+P, Ctrl+Shift+P, Ctrl+T, Ctrl+W, Ctrl+\)
ExplorerPane.svelte            # Pane-level (Ctrl+Z/C/X/V, Alt+arrows, F5, F6)
FileItem.svelte                # Item-level (F2, Delete, Ctrl+C/X)
FileList.svelte                # Ctrl+V paste handling
```

**Important:** Always normalize `event.key` to lowercase for modifier shortcuts to handle Caps Lock.

### Current Tab/Pane Hierarchy
```
+page.svelte
└── PaneContainer
    ├── ExplorerPane (left)
    │   ├── TabBar (tabs for this pane)
    │   ├── NavigationBar
    │   └── FileList (shows active tab's explorer)
    └── ExplorerPane (right, if dual-pane enabled)
```

**Note:** P1 issue tauri-explorer-ldfx proposes moving tabs to window level (above panes), so each tab contains the full dual-pane layout.

### Tauri Backend (Rust)
```
src-tauri/src/
├── lib.rs        # Plugin registration, trash commands
├── files.rs      # Directory listing, file operations, streaming
├── search.rs     # Fuzzy search with nucleo-matcher, streaming search
└── thumbnails.rs # Image thumbnail generation with caching
```

**IPC Pattern:** Frontend uses `invoke()` from `@tauri-apps/api/core`. For browser testing, mock-invoke.ts provides fake data.

---

## Testing Commands
```bash
bun run check          # TypeScript + Svelte check
bun run test:run       # All vitest tests (89 tests)
bun run bench:render   # Rendering performance benchmarks
npx playwright test    # E2E tests with mock data
npx playwright test e2e/keyboard.spec.ts  # Keyboard shortcut tests
```

## Beads Workflow
```bash
bd list --status open --priority P1  # See P1 issues
bd show <id>                          # Issue details
bd update <id> --status in_progress   # Start working
bd close <id> --reason "..."          # Close with explanation
bd create --title "..." --priority P0 --type bug  # Create new issue
```
