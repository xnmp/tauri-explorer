# Codebase Overview

Cross-platform file explorer with Windows 11 Fluent Design aesthetics.

**Stack**: Svelte 5 (runes) + SvelteKit frontend, Tauri + Rust backend (migrated from Python FastAPI)

**Structure**:
- `src/lib/components/` - UI components (ExplorerPane, FileList, Sidebar, dialogs)
- `src/lib/state/` - Reactive stores (explorer, clipboard, bookmarks, theme)
- `src/lib/domain/` - Pure domain logic (file types, sorting)
- `src/lib/api/` - TypeScript API client for Tauri commands
- `src-tauri/src/` - Rust backend (file operations, search, trash integration)

For detailed architecture, see [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).
