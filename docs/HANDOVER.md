# Session Handover

Continuing work on **ripgrep integration with Ctrl+Shift+F for content search**.

**Previous session summary:** Completed window-level tabs feature (each tab contains full dual-pane layout state). Fixed tab switching in Tauri app and reactive tab title updates. Merged to main.

**Key context:**
- Branch: `main` (clean, ready for new feature branch)
- All 68 tests pass
- Related issues: `tauri-explorer-3a1q` (ripgrep), `tauri-explorer-evim` (Ctrl+Shift+F dialog), `tauri-explorer-en98` (results preview)
- EPIC: `tauri-explorer-raf` (Search in Files)

**Current state:**
- Fuzzy file NAME search exists (`src-tauri/src/search.rs`) using nucleo + jwalk
- NO content search yet - this is the feature to build
- No search dialog UI exists

**User requirement:** Stream results with fzf-style fuzzy filtering:
```bash
rg --column --line-number --no-heading --color=always --smart-case -- "${*:-}" | fzf --ansi
```

**Next steps:**
1. Create branch `feature/ripgrep-search`
2. Add ripgrep integration to Rust backend (streaming results)
3. Create search dialog UI (Ctrl+Shift+F)
4. Integrate fzf-style fuzzy filtering on results
5. Show results with filename, line number, context preview

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
├── lib.rs          # Tauri command registration
├── files.rs        # Directory listing, file ops
├── search.rs       # Fuzzy file NAME search (nucleo + jwalk)
└── thumbnails.rs   # Image thumbnail generation
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
