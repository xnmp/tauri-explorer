# Tauri Explorer — Architecture Map

> High-level map of the codebase. Drill into subdocs for details.
>
> `website/` is the standalone showcase site (static HTML/CSS/JS, deployed to Vercel) — an interactive replica of the app UI where the marketing copy lives as a browsable fake filesystem, filling the browser viewport like a maximized window. No build step; edit and redeploy with `vercel deploy --prod` from `website/`. Site themes mirror the app palettes (light/dark/aurora/hacker/solarized) — toolbar theme menu, palette commands, or Ctrl+T. The site demos the app's features live, not as pictures: palette commands toggle every bar (sidebar/status/address/title + Zen Mode, persisted), a `screenshots/` folder renders as tiles with real thumbnails, an integrated terminal (Ctrl+\`) runs ls/cd/cat over the fake FS with explorer cwd-sync, the "Graph: this repo" tab opens an SVG commit graph of this repo's actual history, Ctrl+Shift+F greps the site's own copy, tabs are real (per-tab cwd), F2 renames inline, Ctrl+\ splits into dual panes with F5/F6 copy/move across (session-only FS mutations), plus type-ahead, sortable columns, right-click context menus, and toasts/tooltips guiding exploration. Perf: hero-image preload, idle-time prefetch of all screenshots, and cache headers in `website/vercel.json`.

## Stack

| Layer | Technology |
|-------|-----------|
| Desktop runtime | Tauri v2 (Rust + WebView) |
| Frontend | Svelte 5 (runes: `$state`, `$derived`, `$effect`) + TypeScript |
| Backend | Rust |
| Package manager | `bun` |
| Build | Vite 6, `@sveltejs/adapter-static` |
| Tests | Vitest (unit), Playwright (e2e: Chromium + WebKit proxy for the macOS webview — `WEBKIT=1 npx playwright test --project=webkit`), WebdriverIO real-binary smoke (Linux/Windows: boot, file ops, content search, terminal, warm windows, context-menu clipboard round-trip, theme switching, hostile-filename round-trip), macOS launch smoke (`.github/workflows/macos-smoke.yml`: boots the built app, asserts startup) |

**Dev commands:** `bun run start` (dev server), `npx vitest run` (unit tests), `npx playwright test` (e2e)

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Window (WebView)                │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  +page.svelte (root)                            │    │
│  │  ├── TitleBar (drag region + window controls)  │    │
│  │  ├── SharedToolbar (search, theme, win controls)│    │
│  │  ├── Sidebar (activity bar + files / SCM views) │    │
│  │  ├── PaneContainer                              │    │
│  │  │   ├── left pane                              │    │
│  │  │   │   ├── PaneTabBar (per-pane tab strip)    │    │
│  │  │   │   └── ExplorerPane                       │    │
│  │  │   │       ├── NavigationBar (breadcrumbs)    │    │
│  │  │   │       └── FileList (dispatcher)          │    │
│  │  │   │           ├── DetailsView → VirtualList  │    │
│  │  │   │           ├── ListView (CSS grid)        │    │
│  │  │   │           └── TilesView (CSS auto-fill)  │    │
│  │  │   └── right pane (if dual pane): PaneTabBar  │    │
│  │  │       + ExplorerPane                         │    │
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
│  │  ├── nano_banana.rs (AI image editing via gemini)│    │
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
| `src/lib/plugins/` | Build-time-bundled plugin system (contribution registries, fs providers) → [plugins.md](architecture/plugins.md) |
| `src/lib/themes/` | Bundled CSS themes → [cross-cutting.md](architecture/cross-cutting.md) |
| `src-tauri/src/` | Rust backend modules → [backend.md](architecture/backend.md) |
| `tests/` | Vitest unit tests |
| `e2e/` | Playwright e2e tests (browser + mocked IPC) |
| `e2e-tauri/` | WebdriverIO + tauri-driver smoke suite against the real binary (Linux + Windows only) |

---

## Deep Reference Docs

| Doc | Contents |
|-----|----------|
| [backend.md](architecture/backend.md) | All Rust modules, commands, types, caching, error handling |
| [frontend.md](architecture/frontend.md) | Entry point, state management, domain layer, API layer |
| [components.md](architecture/components.md) | Full component table + composables |
| [features.md](architecture/features.md) | Feature → file mapping, data flow patterns |
| [cross-cutting.md](architecture/cross-cutting.md) | Persistence, cross-window comms, theming, keyboard, DnD, testing |
| [plugins.md](architecture/plugins.md) | Plugin loading model (CSP rationale), PluginContext surface, adding a built-in plugin |
| [reference-deps.md](reference-deps.md) | API reference for key Rust dependencies (jwalk, grep-searcher, fs_extra, image, tauri-plugin-log) |

---

## Key Config Files

- `package.json` — scripts, dependencies
- `vite.config.js` — Vite config
- `svelte.config.js` — Svelte config
- `vitest.config.ts` — Vitest config
- `playwright.config.ts` — Playwright e2e config
- `e2e-tauri/wdio.conf.ts` — WebdriverIO config for the Tauri-binary smoke suite
- `src-tauri/tauri.conf.json` — Tauri window/build/security config
- `src-tauri/Cargo.toml` — Rust dependencies
# test
