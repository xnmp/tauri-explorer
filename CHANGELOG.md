# Changelog

All notable changes to Tauri Explorer.

## v1.2.0 — 2026-07-11

### Added
- **Per-pane git graph** — Ctrl+Alt+G now toggles the commit graph *inside the active pane* instead of opening a separate window tab, so a graph can sit right next to a normal explorer pane in a split. Invoking it again from within the graph returns the pane to its file listing. Old saved graph tabs migrate automatically.
- **Drop files on the terminal** — dropping files onto the integrated terminal (or pressing Alt+T with a selection) types their shell-escaped paths at the prompt.
- **Syntax highlighting in diff views** via a shared highlight palette.

### Improved
- **Source Control panel**: summaries are cached per repo (switching panes/tabs no longer refetches and flashes), a loading skeleton shows while the first fetch runs instead of a premature "Not a git repository", row action glyphs are now uniform SVG icons, and hovered actions get a visible highlight (discard tints red).
- **Drag ghosts**: multi-file drags show a fanned stack with a count badge, and every drag ghost (single files included) is translucent so the drop target stays visible.
- **Git graph performance**: windowed rendering for large histories and instant repaint from a per-repo snapshot cache.
- **Active tab polish**: the hairline border traces the fillet curves as one continuous stroke and composites opaquely over the pane surface.

### Fixed
- Terminal: cwd sync no longer races fast tab switches; app shortcuts win over the shell while the terminal is focused; theme switches repaint reliably under WebKitGTK; Alt+M T toggles the terminal instead of only opening it.
- Multi-file drops recover from WebKitGTK's flattened uri-list; Super+Alt pane-split hotkeys work on Linux.
- Thumbnails: cache hits paint full-res immediately and survive layout shifts/remounts.
- Inline new-folder editor renders correctly inside the virtual list; marquee selection tracks the cursor under zoom; folder drop-target highlight no longer blinks; drive letters render as normal breadcrumbs.
- Security hardening: ZIP extraction guards against symlink zip-slip, `open_external_url` is host-pinned, AI job temp dirs are randomized, and vitest/vite were bumped past security advisories.

## v1.1.0 — 2026-07-05

### Added
- **AI rename autocomplete** — start a rename and the AI Rename plugin suggests a better filename right under the box; press Tab (or click the hint) to accept. Same privacy rules as the picker: nothing is sent without your Gemini key, content hint for text files only, and a settings toggle to turn it off.
- **Image preview: click to go front-and-center** — click the image in the preview pane for the fullscreen view (Left/Right step through siblings, +/− and Ctrl+wheel zoom, Esc or another click reverts).
- **Git graph, VSCode-parity pass** — commit details now expand inline below the clicked row (the graph stretches around them); clicking a changed file shows its diff right there; the synthetic *Uncommitted Changes* row is clickable too (staged files badged). Default shortcut **Ctrl+Alt+G**.
- **Theme from Image plugin** — right-click an image (or "Create Theme from Wallpaper") → median-cut palette → a generated theme in your themes folder, applied immediately.
- **VSCode-style Source Control panel** — compact rows, right-edge colored status letters, inline dimmed paths, pill count badges, primary Commit button.
- Command palette matching is token-based and word-order-agnostic ("git graph" and "graph git" both work), and a "Set Current View Mode as Default" command replaces the old implicit behavior.

### Fixed
- Context menus opened away from the cursor while zoomed (both the file menu's keep-on-screen clamp and the git-graph menu); now regression-guarded by a dedicated zoom E2E suite.
- Changing one pane's view mode no longer silently rewrites the global default.
- Terminal output no longer races listener registration on startup.
- Filesystem-watcher creation failure (e.g. inotify exhaustion) degrades to no live refresh instead of crashing the app at startup.
- Removed the one-time "Everything here is a keystroke away" panel.

### Security (pre-launch audit, all tiers implemented)
- Image decoding is hard-capped (16384px / 256MB / 200MB file) at every decode site — a crafted image header can no longer OOM the app.
- The Nano Banana integration no longer runs gemini with `--yolo`: tool auto-approval is restricted to `edit_image`, and filenames are staged under neutral names so they can never inject into the model command.
- Asset-protocol scope now denies credential directories (`.ssh`, `.gnupg`, `.aws`, …) on every platform; CSP tightened (`object-src 'none'`, `base-uri 'self'`); update-check URLs pinned to github.com; crash reports written `0o600`.

## v1.0.1 — 2026-07-05

### Fixed
- **macOS: app crashed instantly at launch** — Windows-only glob patterns in the asset-protocol scope broke scope parsing on macOS (caught by the new macOS launch-smoke CI). Scopes are now per-platform. If you tried v1.0.0 on a Mac, this is the release that actually opens.
- Marquee selection lost when releasing the mouse before the next animation frame (surfaced by the new WebKit test suite; timing-dependent on all platforms).

### Added
- Fuzzy quick-open (Ctrl+P) inside the system file-picker window (Linux portal mode).
- CI: full e2e suite under WebKit (macOS webview proxy), macOS launch smoke, real-binary Windows/Linux specs for clipboard round-trip and theme switching.

## v1.0.0 — 2026-07-05

First stable release.

### Added
- **Crash reporting (local only)** — panics are saved to `<log dir>/crashes/`; the next launch offers a pre-filled GitHub issue. Nothing is ever sent automatically.
- **Update checker** — once a day, a small notice appears when a newer release exists (notification only, no auto-download).
- **Keyboard shortcut cheatsheet** — `Ctrl+/` (or "Keyboard Shortcuts" in the palette) shows every live binding, including your custom rebinds.
- First-run hint pointing at `Ctrl+P` / `Ctrl+Shift+P`.
- MIT `LICENSE` file, README badges, CHANGELOG.

### Security
- Config files (which can hold plugin API keys) are written with owner-only permissions on Unix.
- AI plugins accept the `GEMINI_API_KEY` environment variable so the key never has to be stored on disk.

### Known limitations
- Binaries are not code-signed yet: macOS Gatekeeper and Windows SmartScreen will warn on first launch.
- Updates are manual (download from Releases); a built-in updater is planned.

## v0.9.0 — 2026-07-04

- Git graph parity polish: continuous branch curves, stash tracking, combined local+remote ref chips with up-to-date indicator, uncommitted-changes row, complex-merge rendering (#179).
- More prominent Chrome-style tab fillets (#157).

## v0.8.0 — 2026-07-04

- Git graph context actions: checkout, merge, rebase, create branch/tag, cherry-pick, revert, reset, copy hash (#173).
- Chrome-style live window detach when dragging tabs out (#176).
- Feature flags for terminal and git graph (#175).
- Streaming, cancellable large copy operations; large zip/unzip hardening (#174).
- Tab fillets curve into the pane like Chrome (#157).

## v0.7.0 — 2026-07-04

- Per-pane tabs with drag-and-drop between panes and windows (#140).
- Git commit graph view (#51/#56/#57/#58).
- Integrated terminal panel (#150).
- Virtualized List and Tiles views for large directories (#128).
- Git panel improvements (#156), adversarial-testing fixes (#167).

## v0.6.0 — 2026-06-25

- Command palette polish, quick open frecency, workspace management.
- Nano Banana and AI rename/organize extracted into plugins (#144/#145).

## v0.5.0 — 2026-06-24

- Plugin system, content search improvements, theme system expansion.

## v0.4.0 — 2026-06-13

- Windows support hardening (paths, clipboard, cross-device moves).
- Linux desktop portal (system file picker) backend.

## v0.3.0 — 2026-04-20

- Dual-pane mode, Miller columns, preview pane.

## v0.2.7 — 2026-03-11

- Details/List/Tiles views, fuzzy quick open, ripgrep content search.

## v0.1.0 — 2026-03-11

- Initial release: Tauri v2 + Svelte 5 file explorer with command palette.
