# Code Map — Playbook (task recipes)

Recurring task **shapes** for this repo. Find the closest shape, touch its files in order, heed its gotchas. Paths relative to repo root. If nothing fits, see **Fallback** at the bottom.

Cross-cutting truth: most features flow **component → store (`src/lib/state`) → api (`src/lib/api`) → Rust command (`src-tauri/src`)**. The central hub is `src/lib/state/explorer.svelte.ts` (per-pane listing/selection/navigation).

---

## 1. Add / change a command-palette command
1. `src/lib/state/commands/{file,view,pane,navigation,general}-commands.ts` — add a `Command` object (`id`, `label`, `category`, optional `shortcut`, `when`, `run`). Pick the module by domain; `general-commands.ts` is the catch-all.
2. `src/lib/state/command-definitions.ts` — only if you add a whole new command **module** (import + spread into `registerAllCommands`); existing modules auto-register.
3. `src/lib/state/commands.svelte.ts` — registry, frecency ranking, `CommandCategory`. Add a category label here if you invent one.
4. `src/lib/components/CommandPalette.svelte` — UI; usually untouched.
- Gotchas: `shortcut` on the command IS the keybinding (no separate wiring). `command-definitions.ts` runs `validateShortcutConflicts` — duplicate shortcuts throw. `when()` gates visibility/enablement.

## 2. Add / rebind a keyboard shortcut
1. Add/set `shortcut` on the command (recipe 1) — the normal path; supports chords like `"Alt+M E"`.
2. `src/lib/state/keybindings.svelte.ts` — default registration, user overrides (localStorage), `getDisplayShortcut`, super-key handling.
3. `src/lib/domain/keybinding-parser.ts` — parsing/matching (`parseShortcut`, `matchesShortcut`, chords). Only touch for new modifier/format semantics.
4. `src/routes/+page.svelte` — global keydown dispatch; some app-level shortcuts (not command-bound) live here.
5. `src/lib/components/KeybindingsSettings.svelte` / `ShortcutCheatsheet.svelte` — UI for editing/listing.
- Gotchas: chords are stateful; check `isChordShortcut`. A shortcut not on a command must be handled in `+page.svelte`.

## 3. Add a Tauri command end-to-end
1. `src-tauri/src/<module>.rs` (or `files/<module>.rs`) — write `#[tauri::command] pub async fn` (MUST be async — sync blocks the main thread).
2. `src-tauri/src/lib.rs` — register in `tauri::generate_handler![…]`.
3. `src/lib/api/<area>.ts` (e.g. `files.ts`, `git.ts`, `search.ts`) — wrap with `invoke<T>("command_name", { args })`; args are camelCase in JS, snake_case params in Rust.
4. `src/lib/api/mock-invoke.ts` — add a handler keyed by the command name to the handler map (~line 326+) so E2E/browser mode works.
5. Caller store/component.
- Gotchas: **mock-invoke is mandatory** or E2E breaks silently. Match arg names exactly (Tauri auto-cases). Long/streaming work → use `task_registry.rs` + `progress.rs`.

## 4. Persist a new setting
1. `src/lib/state/settings.svelte.ts` — add the field to the settings interface + defaults; it's the source of truth (booleans like `showHidden`, numbers like `zoomLevel`, enums like `viewMode`).
2. `src/lib/components/SettingsDialog.svelte` — add the UI control (large file).
3. `src/lib/api/config.ts` + `src-tauri/src/config.rs` — JSON persistence; usually automatic if you extend the settings blob, verify serialization.
4. Consumers read `settingsStore.<field>` reactively.
- Gotchas: plugin-contributed settings go through `src/lib/plugins/settings-registry.svelte.ts` instead. Add a matching command toggle via recipe 1 if it needs palette access.

## 5. Add a context-menu action
1. `src/lib/components/ContextMenu.svelte` — the big menu; add item + `when` predicate + handler (calls a store/api).
2. `src/lib/state/context-menu-items.svelte.ts` — ONLY for plugin-contributed items (registry with `when`/`handler`).
3. `src/lib/state/context-menu.svelte.ts` — open/position state; rarely touched.
4. Handler usually delegates to `state/operations.svelte.ts` or `pane-mutations.ts`.
- Gotchas: selection context comes from `explorer.svelte.ts`; predicate on `FileEntry[]`. Consider also adding the same action as a command (recipe 1) + shortcut.

## 6. Change view-mode behavior (Details / List / Tiles / Miller)
1. `src/lib/components/FileList.svelte` — dispatches to `DetailsView`/`ListView`/`TilesView` by `explorer.viewMode`.
2. `src/lib/components/DetailsView.svelte`, `ListView.svelte`, `TilesView.svelte` — **update ALL THREE** for display-affecting changes (columns, badges, icons, selection visuals).
3. `src/lib/components/MillerColumns.svelte` — a FOURTH surface; rendered separately by `ExplorerPane.svelte` (not via FileList). Easy to forget.
4. `src/lib/components/FileItem.svelte` / `EntryName.svelte` — shared row/name rendering used across views; change here to hit all at once.
5. `src/lib/state/commands/view-commands.ts` — view/miller/sort commands.
- Gotchas: Details is virtual-scrolled (`VirtualList.svelte`), List/Tiles are CSS grids — layout fixes differ per view. Miller is the commonly-missed fourth view.

## 7. Touch drag-and-drop
1. `src/lib/composables/use-pointer-drag.svelte.ts` — internal drag (ghost image, pointer tracking). *(currently modified on this branch)*
2. `src/lib/composables/use-drop-target.svelte.ts` / `use-native-drop-target.svelte.ts` / `use-native-drop-handler.ts` — drop zones & hit-testing (native vs synthetic).
3. `src/lib/composables/use-external-drag.svelte.ts` / `use-external-drop.svelte.ts` — OS-level file drag in/out; `use-sidebar-drag.svelte.ts` for sidebar reorder.
4. `src/lib/state/drag.svelte.ts` — shared drag state store (payload lives here, NOT in `dataTransfer`).
5. `src/lib/state/drop-operations.ts` / `file-transfer.ts` — move/copy resolution on drop.
- Gotchas: Svelte 5 event delegation breaks HTML5 `drop`; use native `addEventListener` + shared store (see `docs/lessons_learnt.md`). Playwright synthetic DnD does NOT validate real browser behavior.

## 8. Change refresh / file-watcher behavior
1. `src/lib/composables/use-file-watchers.ts` — subscribes to Tauri `"directory-changed"` events + cross-window BroadcastChannel.
2. `src/lib/state/refresh-manager.ts` — debounced `requestRefresh` / `cancelPendingRefreshes`.
3. `src/lib/state/pane-refresh.ts` / `pane-watch.ts` — per-pane refresh + watch registration.
4. `src/lib/state/git-refresh.ts` — git-status refresh coordination.
5. `src-tauri/src/files/fs_watcher.rs` — Rust notify watcher emitting `directory-changed`.
- Gotchas: event name string `"directory-changed"` is the seam — grep it. Watch out for cleanup races (`disposed` guard in use-file-watchers).

## 9. Thumbnail / preview pipeline change
1. `src/lib/components/ThumbnailImage.svelte` — img lifecycle, lazy load, error/fallback.
2. `src/lib/api/thumbnails.ts` — `getThumbnail`/`getThumbnailData`/`getMicroThumbnail`/`getVideoThumbnailData`/`getFolderPreview` invokes.
3. `src/lib/state/thumbnail-cache.ts` — in-memory cache/dedup.
4. `src-tauri/src/thumbnails.rs` — generation, disk cache (large; images + video frames).
5. `src/lib/components/FolderThumbnail.svelte` + `domain/folder-preview.ts` — folder collages.
6. `src/lib/components/PreviewPane.svelte` — the full preview panel (text/image/syntax).
- Gotchas: sizes/quality tiers come from `settings.svelte.ts` (`thumbnailSize`/`ThumbnailSize`). Mock `get_thumbnail*` in mock-invoke for E2E.

## 10. SCM panel / git-badge change
1. `src/lib/components/ScmSidebarView.svelte` (staging UI), `ScmPanel.svelte`, `ScmDiffView.svelte`, `GitStatusBadge.svelte` (per-file badge), `GitGraphView.svelte` (log/graph).
2. `src/lib/state/scm.svelte.ts` (staging/commit state), `git-status.svelte.ts` (per-file status store, badge source), `git-refresh.ts`.
3. `src/lib/api/git.ts` / `git-log.ts` — invokes.
4. `src/lib/domain/git-graph.ts`, `scm-tree.ts`, `diff.ts` — pure graph/tree/diff logic.
5. `src-tauri/src/files/git_status.rs`, `git.rs`, `git_actions.rs`, `git_log.rs`.
- Gotchas: badge visibility gated by `settings.showGitStatus`. Status event seam: `"git-status-changed"`. Graph rendering logic is in `domain/git-graph.ts`, not the component.

## 11. Sidebar section change (bookmarks / recent / drives)
1. `src/lib/components/FilesSidebarView.svelte` — main sidebar list (large); `Sidebar.svelte` shell.
2. `src/lib/state/sidebar-views.svelte.ts` — which sections show/order.
3. `src/lib/state/bookmarks.svelte.ts`, `recent-files.svelte.ts`, `drives.svelte.ts` (+ `domain/drives.ts`), `frecency.svelte.ts` (recency scoring).
4. `src-tauri/src/files/drives.rs` — drive/volume enumeration.
- Gotchas: recent-item count is a setting (`recentItemsCount`, 0 = hidden). Sidebar drag reorder uses `use-sidebar-drag.svelte.ts`.

## 12. Window-tab change
1. `src/lib/components/WindowTabBar.svelte` — tab strip UI (large).
2. `src/lib/state/window-tabs.svelte.ts` — tab model, active tab, per-tab state (central, large).
3. `src/lib/state/window-tabs-persistence.ts` — save/restore across sessions; `closed-tabs.ts` (reopen-closed); `tab-transfer.ts` (drag tab across windows).
4. `src/lib/domain/tab-title.ts` — title derivation.
- Gotchas: each tab owns its own explorer/pane state; don't leak state across tabs. Persistence + closed-tabs must stay in sync.

## 13. Dialog / progress / long-op change
1. `src/lib/state/dialogs.svelte.ts` — active-dialog state machine (`DialogType`, `PickerConfig`).
2. Dialog component: `DeleteDialog.svelte`, `ConflictDialog.svelte`, `BulkRenameDialog.svelte`, `ProgressDialog.svelte`, `WorkspaceDialog.svelte`, or `Modal.svelte` (shell) + `modal.css`.
3. `src/lib/state/operations.svelte.ts` — file-op orchestration (delete/copy/move) that drives conflict/progress.
4. `src/lib/state/jobs.svelte.ts` + `components/JobsPanel.svelte` — background job tracking; `src-tauri/src/progress.rs` + `task_registry.rs` for cancellable Rust tasks.
- Gotchas: register a new dialog type in `dialogs.svelte.ts`. Progress needs Rust `emit` + a frontend `listen`; mirror in mock-invoke.

## 14. Selection behavior change
1. `src/lib/state/explorer.svelte.ts` — selection set, anchor, current index (source of truth).
2. `src/lib/state/selection.ts` — pure range/toggle helpers.
3. `src/lib/composables/use-marquee-selection.svelte.ts` — rubber-band candidate set + hit-testing.
4. `src/lib/composables/use-item-interactions.svelte.ts` — click/ctrl/shift/double-click semantics per item.
5. `src/lib/composables/use-type-ahead.svelte.ts` — type-to-select.
- Gotchas: all views share selection via explorer store — fix once, but verify visual highlight in Details/List/Tiles/Miller separately.

## 15. Address bar / breadcrumb / navigation change
1. `src/lib/components/NavigationBar.svelte` — address bar, breadcrumb, nav buttons (large).
2. `src/lib/components/BreadcrumbAutocomplete.svelte` + `domain/autocomplete.ts` + `domain/breadcrumb-truncation.ts`.
3. `src/lib/state/navigation.ts` — history (back/forward/up); `components/NavigationHistoryMenu.svelte`.
4. `src/lib/domain/path.ts` / `virtual-path.ts` / `wsl.ts` — path parsing/normalization.
- Gotchas: nav-button visibility from `settings.navBarButtons`. Path logic is platform-sensitive (WSL/Windows) — use `domain/path.ts`, don't hand-roll.

## 16. Perf: listing / render pipeline
1. `src/lib/components/VirtualList.svelte` — virtual scroller (Details); windowing math.
2. `src/lib/domain/virtual-layout.ts` — row/column layout math; `raf-coalesce.ts` — frame coalescing.
3. `src/lib/composables/use-progressive-render.svelte.ts` — chunked reveal of large listings.
4. `src/lib/state/directory-listing.ts` — listing ingestion/streaming into panes; `explorer.svelte.ts` consumes.
- Gotchas: Tiles/List don't use VirtualList — they can blow up on huge dirs differently. Measure before changing; check `startup-timing.ts`.

## 17. Perf: IPC / streaming
1. `src-tauri/src/files/dir_listing.rs` — directory read; batching/streaming to frontend.
2. `src-tauri/src/search.rs` (fuzzy/nucleo) + `content_search.rs` (ripgrep) — streamed results; `warm_pool.rs` / `src/lib/api/warm-pool.ts` — prewarmed windows.
3. `src/lib/api/search.ts` — result ingestion; `state/directory-listing.ts` — chunk assembly.
- Gotchas: streaming uses Tauri events, not a single invoke return — grep the event name. Cancellation via `task_registry.rs`.

---

## Fallback — nothing matched
Orient from these hubs (highest-traffic files):
- **`src/lib/state/explorer.svelte.ts`** — per-pane listing/selection/navigation; almost everything routes through it.
- **`src/routes/+page.svelte`** — SPA root: global shortcuts, store init, layout composition (TitleBar > SharedToolbar > Sidebar + PaneContainer > StatusBar + dialogs).
- **`src/lib/components/ExplorerPane.svelte`** — renders FileList OR MillerColumns per pane.
- **`src/lib/api/files.ts`** — every filesystem IPC call; grep here to find the command name, then `src-tauri/src/lib.rs` for the Rust side.
- **`src/lib/api/mock-invoke.ts`** — canonical list of all backend command names + their shapes (E2E fake backend).
- **`src/lib/state/pane-mutations.ts`** / **`directory-listing.ts`** — mutation + listing plumbing.
- Grep strategy: user-visible string → component; exported symbol → its module; event name (`"directory-changed"`, `"git-status-changed"`) → watcher/emitter pair; command name → `files.ts` + `lib.rs` + `mock-invoke.ts`.
