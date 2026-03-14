# Tauri Explorer — Architecture Map

> High-level map of the codebase. Drill into subdocs for details.

## Stack

| Layer | Technology |
|-------|-----------|
| Desktop runtime | Tauri v2 (Rust + WebView) |
| Frontend | Svelte 5 (runes: `$state`, `$derived`, `$effect`) + TypeScript |
| Backend | Rust |
| Package manager | `bun` |
| Build | Vite 6, `@sveltejs/adapter-static` |
| Tests | Vitest (unit), Playwright (e2e) |

**Dev commands:** `bun run start` (dev server), `npx vitest run` (unit tests), `npx playwright test` (e2e)

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Window (WebView)                │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  +page.svelte (root)                            │    │
│  │  ├── TitleBar / WindowTabBar                    │    │
│  │  ├── SharedToolbar (search, theme, win controls)│    │
│  │  ├── Sidebar (quick access, bookmarks, drives)  │    │
│  │  ├── PaneContainer                              │    │
│  │  │   ├── ExplorerPane (left)                    │    │
│  │  │   │   ├── NavigationBar (breadcrumbs)        │    │
│  │  │   │   └── FileList (dispatcher)              │    │
│  │  │   │       ├── DetailsView → VirtualList      │    │
│  │  │   │       ├── ListView (CSS grid)            │    │
│  │  │   │       └── TilesView (CSS auto-fill)      │    │
│  │  │   └── ExplorerPane (right, if dual pane)     │    │
│  │  ├── PreviewPane (optional)                     │    │
│  │  ├── StatusBar                                  │    │
│  │  └── Overlay Dialogs                            │    │
│  └─────────────────────────────────────────────────┘    │
│                         │                               │
│                    invoke() IPC                          │
│                         │                               │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Rust Backend (src-tauri/src/)                  │    │
│  │  ├── files/ (dir listing, CRUD, external apps)  │    │
│  │  ├── search.rs (fuzzy search, streaming)        │    │
│  │  ├── content_search.rs (ripgrep-based grep)     │    │
│  │  ├── thumbnails.rs (image thumbnail cache)      │    │
│  │  ├── clipboard.rs (OS clipboard)                │    │
│  │  ├── archive.rs (zip compress/extract)          │    │
│  │  ├── wallpaper.rs (set desktop wallpaper)       │    │
│  │  ├── config.rs (JSON config persistence)        │    │
│  │  ├── error.rs (unified AppError type)           │    │
│  │  └── task_registry.rs (cancellable tasks)       │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## Key Directories

| Path | Contents |
|------|----------|
| `src/routes/+page.svelte` | SPA entry point, global keyboard handler, layout |
| `src/lib/components/` | All Svelte components → [components.md](architecture/components.md) |
| `src/lib/state/` | Reactive stores (Svelte 5 runes) → [frontend.md](architecture/frontend.md) |
| `src/lib/domain/` | Pure functions and types (no framework deps) → [frontend.md](architecture/frontend.md) |
| `src/lib/api/` | Frontend ↔ Rust bridge + mock for e2e → [frontend.md](architecture/frontend.md) |
| `src/lib/composables/` | Reusable behavior (marquee, column resize, DnD) → [components.md](architecture/components.md) |
| `src/lib/themes/` | Bundled CSS themes → [cross-cutting.md](architecture/cross-cutting.md) |
| `src-tauri/src/` | Rust backend modules → [backend.md](architecture/backend.md) |
| `tests/` | Vitest unit tests |
| `e2e/` | Playwright e2e tests |

---

## Deep Reference Docs

| Doc | Contents |
|-----|----------|
| [backend.md](architecture/backend.md) | All Rust modules, commands, types, caching, error handling |
| [frontend.md](architecture/frontend.md) | Entry point, state management, domain layer, API layer |
| [components.md](architecture/components.md) | Full component table + composables |
| [features.md](architecture/features.md) | Feature → file mapping, data flow patterns |
| [cross-cutting.md](architecture/cross-cutting.md) | Persistence, cross-window comms, theming, keyboard, DnD, testing |

---

## Key Config Files

- `package.json` — scripts, dependencies
- `vite.config.js` — Vite config
- `svelte.config.js` — Svelte config
- `vitest.config.ts` — Vitest config
- `playwright.config.ts` — Playwright e2e config
- `src-tauri/tauri.conf.json` — Tauri window/build/security config
- `src-tauri/Cargo.toml` — Rust dependencies
