# Codebase Overview

Cross-platform file explorer with Windows 11 Fluent Design aesthetics.

**Stack**: Svelte 5 (runes) + SvelteKit frontend, Python FastAPI backend, Tauri + Rust for native integration

**Structure**:
- `src/lib/components/` - UI components (ExplorerPane, FileList, Sidebar, dialogs)
- `src/lib/state/` - Reactive stores (explorer, clipboard, bookmarks, theme)
- `src/lib/domain/` - Pure domain logic (file types, sorting)
- `src-python/` - FastAPI file operations API
- `src-tauri/` - Rust trash integration, window management

For detailed architecture, see [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).
