# Session Handover

**Previous session summary:** Completed all P1 issues and ripgrep content search feature. All merged to main.

**Completed this session:**
- Ctrl+H shortcut for toggling hidden files (tauri-explorer-zgf)
- Hidden files preference persistence to localStorage (tauri-explorer-klo)
- Keyboard navigation: Arrow keys, Enter, Delete, F2 (tauri-explorer-ac7y)
- Tab persistence across sessions (tauri-explorer-qcq5)
- Ripgrep content search with Ctrl+Shift+F (tauri-explorer-evim, tauri-explorer-3a1q)

**Key context:**
- Branch: `main` (all features merged)
- All 68 tests pass
- Content search backend: `src-tauri/src/content_search.rs`
- Content search UI: `src/lib/components/ContentSearchDialog.svelte`

**Next steps (P2 issues):**
- Search results preview pane (tauri-explorer-en98)
- Tab reordering via drag (tauri-explorer-4x9f)
- Multi-file copy/cut support (tauri-explorer-jrfg)
- Recent files tracking (tauri-explorer-omkn, tauri-explorer-kwe)

Run `bd list --priority 2` to see all P2 issues.

---

## Architecture & Learnings

### State Management

```
src/lib/state/
├── window-tabs.svelte.ts   # Window-level tabs (each tab = full dual-pane state)
├── explorer.svelte.ts      # Per-pane file browser state
├── clipboard.svelte.ts     # Cut/copy/paste
├── settings.svelte.ts      # User preferences
├── theme.svelte.ts         # Theme management
└── command-definitions.ts  # Keyboard shortcuts
```

Pattern: Singleton managers using Svelte 5 runes (`$state`, `$derived`). Export a single instance.

### Component Hierarchy

```
+page.svelte
├── TitleBar (with WindowTabBar)
├── SharedToolbar
└── main-content
    ├── Sidebar
    └── PaneContainer
        ├── ExplorerPane (left)
        └── ExplorerPane (right)
```

### Backend (Rust/Tauri)

```
src-tauri/src/
├── lib.rs            # Tauri command registration
├── files.rs          # Directory listing, file ops
├── search.rs         # Fuzzy file NAME search (nucleo + jwalk)
├── content_search.rs # Ripgrep content search (streaming)
└── thumbnails.rs     # Image thumbnail generation
```

**Streaming pattern:** See `start_streaming_search` in search.rs:
- Returns search ID immediately
- Spawns background thread
- Emits `search-results` events with batched results
- Supports cancellation via `AtomicBool`

### Key Patterns

**Tauri v2 detection:**
```typescript
const isTauri = "__TAURI_INTERNALS__" in window;  // NOT __TAURI__ (v1)
```

**Mock invoke for browser testing:**
```typescript
// src/lib/api/files.ts - lazy detection with caching
let cachedIsTauri: boolean | null = null;
async function invoke<T>(cmd, args?) {
  if (cachedIsTauri === null) cachedIsTauri = isTauri();
  return cachedIsTauri ? tauriInvoke(cmd, args) : mockInvoke(cmd, args);
}
```

**Keyboard shortcuts:** Add to `command-definitions.ts`, handler called from `+page.svelte`.

### Testing Commands

```bash
bun run check        # TypeScript + Svelte
bun run test:run     # Unit tests (68 tests)
bun tauri dev        # Run Tauri app
npx playwright test  # E2E tests (browser mock mode)
```

### Workflow (from CLAUDE.md)

1. Create beads issue before modifying files
2. Create feature branch
3. Implement → commit → test-fixer → commit → code-simplifier → commit → ui-tester
4. Merge to main when tests pass and UI works

### Gotchas

- TitleBar `handleDragStart` intercepts mousedown - exclude interactive elements via `.closest()`
- Template `{@const}` isn't reactive - call functions directly in template for reactive updates
- Avoid `$effect` where `$derived` or direct function calls work
