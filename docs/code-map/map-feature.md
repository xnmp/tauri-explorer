# Code Map — Feature Clusters

Tauri v2 file explorer. Most tasks are feature-shaped and cut across
`component → store/state → api bridge → Rust command`. Each cluster lists files
in pipeline order, then FLOW lines naming the events/functions that connect them.
Paths relative to repo root. No line numbers (they go stale).

Central hubs (open these for almost anything): `src/lib/state/explorer.svelte.ts`
(per-pane store: entries, selection, navigation; `createExplorerState`),
`src/routes/+page.svelte` (SPA root: global shortcuts, store init, layout),
`src/lib/api/files.ts` (all IPC wrappers), `src/lib/api/mock-invoke.ts` (fake
backend for E2E/browser).

---

## View modes & virtualization

- `components/FileList.svelte` — dispatches to Details/List/Tiles by view mode
- `components/DetailsView.svelte` — virtual-scrolled table (columns, sort headers)
- `components/ListView.svelte` — CSS-grid columns view
- `components/TilesView.svelte` — auto-fill tile grid
- `components/VirtualList.svelte` — windowing engine (visible-range calc, spacers)
- `domain/virtual-layout.ts` — row/col geometry math for the virtualizer
- `composables/use-progressive-render.svelte.ts` — chunked reveal of large lists
- `composables/use-row-grid-view.svelte.ts` — shared virtualization wiring (rows, DnD, new-folder sentinel, scrollToIndex) behind List + Tiles
- `state/commands/view-commands.ts` — view.details/list/tiles, sort, columns cmds
- `state/sort-prefs.ts`, `state/folder-views.svelte.ts` — per-folder view+sort persistence
- `components/FileIcon.svelte` — shared icon renderer used by all 3 views (via `FileItem.svelte` for Details/List, `TilesView.svelte` for Tiles); linked-folder and git-repo-folder badge overlays live here so a display feature added once covers all views automatically
- `domain/file-types.ts` — `isGitRepoFolder` (icon-selection predicate for the git-repo folder badge, #463); backend flag set in `src-tauri/src/files/mod.rs::metadata_to_entry` (`FileEntry.is_git_repo`, one `.git`-exists stat per directory entry)
- `domain/relative-time.ts` — shared compact relative labels for file metadata, today's git commits, and PR comments
- FLOW: view mode lives on explorer store; `FileList` reads it, mounts one view; all three must change together for display features. Since Details/List/Tiles all route icons through `FileIcon.svelte`, icon-only features (like the git-repo badge) don't need per-view changes — the shared component is the single seam.

## Selection & marquee

- `composables/use-marquee-selection.svelte.ts` — drag-rect candidate set + hit-testing
- `composables/use-item-interactions.svelte.ts` — click/ctrl/shift selection, focus
- `state/selection.ts` — pure selection-set helpers (range, toggle)
- `composables/use-type-ahead.svelte.ts` — type-to-select by name prefix
- selection state stored on `explorer.svelte.ts` (`selectedPaths`, anchor)
- FLOW: pointer events in item-interactions/marquee → mutate explorer selection set → views highlight via `selectedPaths`.

## Directory listing & refresh/watcher events

- `state/directory-listing.ts` — `createDirectoryListing`: invoke + streamed-chunk accumulation, cancellation
- `state/pane-refresh.ts` — `createPaneRefresh`: re-list without UI flash (fingerprint diff)
- `state/refresh-manager.ts` — global debounce/dedup/rate-limit (`requestRefresh`)
- `state/pane-watch.ts` — per-pane watcher gate + local-mutation cooldown
- `composables/use-file-watchers.ts` — subscribes to `directory-changed` + cross-window channel
- `state/file-events.ts` — BroadcastChannel `explorer-file-changes` between windows
- `api/files.ts` — `watchDirectory`/`unwatchDirectory`, `listDirectory`, `startStreamingDirectory`
- `src-tauri/src/files/fs_watcher.rs` — notify watcher → emits event; `files/dir_listing.rs` — listing + streaming
- FLOW: `directory-changed` (fs_watcher.rs → use-file-watchers.ts) and cross-window `broadcastFileChange` both funnel through `requestRefresh` → pane `refresh()`. Refresh policy split across 3 layers — read header of `refresh-manager.ts` before touching.

## Navigation, address bar, breadcrumb, autocomplete

- `components/NavigationBar.svelte` — back/fwd/up/refresh + breadcrumbs per pane
- `components/BreadcrumbAutocomplete.svelte` — path-typing dropdown
- `components/NavigationHistoryMenu.svelte` — back/fwd history dropdown
- `domain/autocomplete.ts` — `parsePathInput`, `filterDirectorySuggestions`
- `domain/breadcrumb-truncation.ts` — collapse long crumb chains
- `domain/path.ts` — path parsing/join/parent (`parentDir`), WSL/UNC handling
- `state/navigation.ts` — history stack, navigate/back/forward
- FLOW: navigate mutates explorer.currentPath + history; breadcrumbs derived from currentPath; autocomplete lists dirs via `listDirectory`.

## Recycle Bin

- `components/FilesSidebarView.svelte`, `domain/recycle-bin.ts`, `api/open.ts` — sidebar action opens the native Recycle Bin and reports an IPC failure through `toastStore`.
- `src-tauri/src/system.rs` — `open_recycle_bin`: Linux probes `gio open trash:///`, then falls back to `xdg-open` on an absolute Freedesktop `Trash/files` directory; Windows and macOS retain their native shell launchers.
- FLOW: sidebar click → `openRecycleBinWithFeedback` → `open_recycle_bin` IPC → Linux URI probe/fallback; a terminal failure returns to the toast.

## Window tabs

- `components/WindowTabBar.svelte` — tab strip UI, drag-reorder, tear-off
- `state/window-tabs.svelte.ts` — `windowTabsManager`: tab list, active tab, per-tab explorer
- `state/window-tabs-persistence.ts` — save/restore tab sessions
- `state/closed-tabs.ts` — reopen-closed-tab stack
- `state/tab-transfer.ts` — drag tab across windows (`sendTabToWindow`, `initTabTransferListener`, screen-pos hit-test)
- `domain/tab-title.ts` — compute tab label from path
- `state/tab-display.svelte.ts` — tab title/icon derivation: git-root decoration, VS Code-style disambiguation, multi-pane joining
- `state/window-title.svelte.ts` — resolves launch-home context and synchronizes the OS window title with the active tab/pane directory
- `state/warm-window.ts`, `api/warm-pool.ts`, `src-tauri/src/warm_pool.rs` — pre-spawned windows for instant new-tab/window
- FLOW: each tab owns an `ExplorerInstance`; cross-window tab drag serializes a `TabSnapshot` via `sendTabToWindow` → listener claims it. Persistence via localStorage.

## Workspaces & split panes

- `components/PaneContainer.svelte`, `components/PaneLayoutView.svelte`, `components/ExplorerPane.svelte` — pane tree render + focus
- `domain/pane-layout.ts` — binary split-tree ops (`splitLeaf`, `removeLeaf`, `leafSiblingContext`, `leafInDirection`)
- `state/workspaces.svelte.ts` — saved workspace layouts (`workspacesStore`)
- `components/WorkspaceDialog.svelte` — save/load workspace UI
- `state/pane-context.ts`, `state/commands/pane-commands.ts` — active-pane resolution + split cmds (`Cmd+Alt+L/'/P/;`) and directional focus cmds (same cluster without Cmd, #501)
- FLOW: pane layout tree in explorer/window-tabs; split/close mutate the `PaneNode` tree; each leaf = one ExplorerInstance.

## Internal drag & drop (move/copy within app)

- `composables/use-pointer-drag.svelte.ts` — pointer-based drag, `createDragGhost`, multi-select ghost
- `composables/use-pointer-intent.svelte.ts` — distinguish click vs drag start
- `state/drag.svelte.ts` — `dragState` shared store (localStorage cross-window fallback)
- `composables/use-drop-target.svelte.ts` — dropzone highlight + accept logic
- `state/drop-operations.ts` — `handleFileDrop`/`handleFileDropMany`, source-path extraction
- `state/file-transfer.ts` — `performFileTransfer` (move vs copy decision)
- `composables/use-sidebar-drag.svelte.ts` — drag onto sidebar bookmarks
- FLOW: pointer-drag sets `dragState` → drop-target computes destination → `performFileTransfer` → `moveEntry`/`copyEntry` (files.ts → file_ops.rs). Branch: `fix/multi-file-drag-ghost-opacity`.

## External drag/drop (OS ↔ app)

- `composables/use-external-drag.svelte.ts` — start OS drag-out of files
- `composables/use-external-drop.svelte.ts`, `use-native-drop-target.svelte.ts`, `use-native-drop-handler.ts` — accept OS file drops
- `api/activate.ts` — window focus/activate on drop
- FLOW: Tauri `dragDropEnabled: false` (in-webview HTML5 DnD); native drop handlers translate OS payload → file transfer. See MEMORY.md DnD notes.

## Copy / paste / file-ops & progress

- `state/clipboard.svelte.ts` — in-app cut/copy path set
- `state/paste-operations.ts` — paste orchestration (conflict, dest)
- `state/pane-mutations.ts` — `createPaneMutations`: optimistic add/remove/rename on entries
- `state/operations.svelte.ts` — `operationsManager`: tracked long ops, `formatBytes`
- `components/ProgressDialog.svelte`, `components/JobsPanel.svelte`, `state/jobs.svelte.ts` — progress UI
- `components/ConflictDialog.svelte`, `state/conflict-resolver.svelte.ts` — overwrite/rename prompts
- `api/files.ts` (copyEntry, moveEntry, estimateSize, checkPathsExist), `api/os-clipboard.ts`
- `src-tauri/src/files/file_ops.rs` (copy/move/create), `src-tauri/src/progress.rs`, `src-tauri/src/clipboard.rs`
- FLOW: paste → estimate → conflict check → invoke copy with progress events → operationsManager updates ProgressDialog; on done `broadcastFileChange` + refresh.

## Rename flows

- `composables/use-inline-rename.svelte.ts` — inline edit field lifecycle
- `components/EntryName.svelte` — name label + inline rename input
- `components/BulkRenameDialog.svelte` — multi-file pattern rename
- `components/InlineNewFolder.svelte` — inline new-entry create (folder or file, per `explorer.newEntryKind`; #436)
- `state/rename-suggestion.svelte.ts`, `domain/ai-rename.ts`, `api/ai-rename.ts` — AI rename suggestions
- `api/files.ts` (renameEntry, createDirectory, createEmptyFile), `src-tauri/src/files/file_ops.rs` (`create_directory`, `create_empty_file`)
- FLOW: inline-rename commits → `renameEntry` → pane-mutations renames entry + `renameThumbnailCache` so thumb doesn't flash.
- New-entry FLOW: context menu / `file.newFolder`|`file.newFile` command → `explorer.startInlineNewFolder`|`startInlineNewFile` (sets `newEntryKind`) → InlineNewFolder row → `createFolder`|`createFile` → pane-mutations optimistic add + `broadcastFileChange`.

## Delete / trash / undo

- `components/DeleteDialog.svelte` — confirm permanent vs trash
- `state/undo.svelte.ts` — `undoStore` op-history stack
- `state/undo-helpers.ts`, `domain/undo-operations.ts` — invertible op descriptors
- `api/files.ts` (moveToTrash, moveMultipleToTrash, deleteEntryPermanent, restoreFromTrash)
- `src-tauri/src/files/file_ops.rs`
- FLOW: delete → trash → push inverse (restore) onto undoStore → Ctrl+Z pops and re-invokes.

## Thumbnails

- `components/ThumbnailImage.svelte` — img element + load/error/placeholder states; `decoding="async"` on both micro and full `<img>`s, no animated loading spinner (static SVG placeholder instead — a continuous CSS animation across many concurrently-loading tiles doubled the long-frame rate on WebKitGTK, #593)
- `components/FolderThumbnail.svelte` — folder collage from children
- `components/TilesView.svelte` — runs `domain/scroll-jank-monitor.ts` while scrolling and logs a `tiles-scroll-jank` diagnostic event only when a sampled window actually had long frames (#593)
- `domain/scroll-jank-monitor.ts` — pure rAF-gap sampler (long-frame count, worst gap, duration); rAF/cancel injected so it's unit-testable with synthetic frame timelines
- `state/thumbnail-cache.ts` — in-memory cache (`getThumbnailCache`, `renameThumbnailCache`)
- `api/thumbnails.ts` — getThumbnail/getThumbnailData/getMicroThumbnail/getVideoThumbnailData/getFolderPreview — per-item requests, deliberately not batched (a batched-IPC scheduler was tried and removed twice: it clumps responses into one main-thread burst and measures worse for scroll pacing than per-item dispatch even though it wins on raw throughput, #593)
- `domain/folder-preview.ts` — folder-preview shaping
- `src-tauri/src/thumbnails.rs` — disk cache, image/video decode; `with_decode_gate` bounds concurrent decodes to `cores/4` (2-8, `TAURI_EXPLORER_DECODE_PERMITS` override) and lowers decode-thread priority so decodes don't starve the webview compositor; `diag` module logs slow (>100ms) requests + rolling aggregates (#593); `files/dir_listing.rs` folder preview
- FLOW: ThumbnailImage requests via api/thumbnails → Rust cache lookup/generate (decode gated + priority-lowered) → data URL cached in thumbnail-cache.ts keyed by path. Rename preserves cache via `renameThumbnailCache`.

## Preview pane

- `components/PreviewPane.svelte` — text/image/diff/archive preview + syntax highlight; hand-rolled resize (width when docked right, height when docked top/bottom, #460); reads `settingsStore.resolvedPreviewPanePosition` (never the raw mode) for its own dock class
- `domain/preview-pane-position.ts` — pure dock-position validate/cycle (right/bottom/top, #460); `+page.svelte` column-stacks the pane for top/bottom. Also: `PreviewPanePositionMode` ("auto" | right/bottom/top), `resolveAutoDockPosition(width, height)` (aspect-ratio heuristic: wide → right, narrow-tall → top, else bottom) and `resolveEffectivePreviewPanePosition(mode, width, height)` (#467)
- `state/window-size.svelte.ts` — reactive `window.innerWidth/innerHeight` (`windowSizeStore`); `+page.svelte` syncs it on mount + `resize`. Feeds `settingsStore.resolvedPreviewPanePosition` for auto-dock (#467)
- `state/settings.svelte.ts` — `previewPanePosition` (raw stored mode, may be "auto") vs `resolvedPreviewPanePosition` (concrete right/bottom/top, the one layout code reads; #467)
- `domain/syntax-highlight.ts` — `highlightCode`, `highlightDiffLine` (hljs)
- `domain/diff.ts`, `domain/markdown.ts` — diff parsing, markdown render
- `api/files.ts` (readTextFile, readImageAsBlobUrl, listArchiveContents, gitDiff)
- `themes/syntax.css` — shared hljs token colors
- FLOW: selection change → PreviewPane fetches content by type → highlights → renders. 512KB read cap, 50KB highlight cap.

## Miller columns

- `components/MillerColumns.svelte` — multi-column cascading browser
- `state/commands/view-commands.ts` — `view.toggleMillerColumns`, millerLayers0-3
- reuses `explorer.svelte.ts` per-column listing + `directory-listing.ts`
- FLOW: each column is a listing of the selected dir in the prior column; layer count is a view command/setting.
- ISLAND (#434): in island mode with no sidebar the ACTIVE pane's columns are hoisted to a left island in `+page.svelte` (`millerAsLeftIsland`); `ExplorerPane.svelte` suppresses the inline copy via the same `settingsStore.islandMode` derived so they render exactly once (a divergent per-platform check double-mounted them).

## Git status badges

- `components/GitStatusBadge.svelte` — per-row M/A/? badge glyph
- `state/git-status.svelte.ts` — `gitStatusStore`: path→status map, `refresh()`
- `state/git-refresh.ts` — debounced git-status refresh
- `api/git.ts` (getGitStatus), `src-tauri/src/files/git_status.rs`
- FLOW: `git-status-changed` (git.rs emit) + `directory-changed` → gitStatusStore.refresh → badges re-derive; gated on `settings.showGitStatus`. For `\\wsl.localhost\…` dirs the badge path (`get_git_status`) delegates rev-parse+status to the distro's native git via `wsl.exe --exec` instead of shelling Git-for-Windows over 9P (#425); `gitStatusStore` dedups concurrent identical fetches (#426).

## Git SCM panel

- `components/ScmSidebarView.svelte` — staged/unstaged/untracked tree, commit box
- `components/ScmPanel.svelte`, `components/ScmDiffView.svelte` — panel shell + inline diff. ScmPanel renders docked/flat by default (like the miller bar); `island` prop opts into floating-island chrome (#434) — vibrancy alone no longer floats it.
- `components/GitGraphView.svelte` — commit graph / log; its filter popover
  carries an ephemeral file-path query through `state/git-graph-cache.ts` to
  `git_log`, so pagination filters the complete history instead of only rows
  already loaded in the browser (#529)
- `state/scm.svelte.ts` — per-pane stores via `getScmStore(paneId)` (#334): repo state, stage/commit actions; shared summary cache + `warmScmSummary`
- `state/git-summary-cache.ts` — shared per-repo `git_status` fetch (in-flight dedup + short TTL, #431): SCM `refreshSummary` (force), GitGraphView `fetchPage0Snapshot` + uncommitted-row selection route through it, so one `git-status-changed` is one working-tree scan, not several
- panel VISIBILITY is also per-pane (#434): `window-tabs.svelte.ts` `getPaneScmVisible`/`toggleScmInActivePane` on the pane node (falls back to the global `showScmPanel` default); the `view.toggleScmPanel` command (`view-commands.ts`) acts on the active pane only
- `domain/git-network-operation.ts`, `state/git-graph-refresh.ts` — F5 refresh bus plus importable `createReloader` concurrency state machine, local-change filter, real-commit paging counter, and shared network-operation phase state: GitGraphView registers its fetch+reload per pane; `gitGraph.refresh` dispatches to the active graph pane, while a per-pull IPC channel removes cancellation once protected local fast-forward begins and fails closed if that transition cannot be delivered (#432, #444, #528)
- `state/git-graph-nav.ts` — branch-line jump bus (#530): GitGraphView registers a per-pane selection stepper; `gitGraph.selectOlderOnLine` (Ctrl+Down) / `gitGraph.selectNewerOnLine` (Ctrl+Up) dispatch to the active graph pane. Row math is pure: `stepOnBranchLine` in `domain/git-graph.ts` follows `parents[0]` down and the nearest first-parent child up, so a jump steps over interleaved rows from other branch lines
- `state/git-palette.ts` — active-pane bridge from GitGraphView's current local branches, commits, and stashes to fuzzy command-palette targets (#520); checkout/merge/cherry-pick/rebase/stash actions reuse the graph action seam and a commit target selects/reveals its row. Commit targets are capped at the 50 most-recent loaded rows because CommandPalette is unvirtualized; ephemeral targets do not enter frecency.
- `domain/git-graph-undo.ts`, `state/git-graph-undo.ts` — bounded repository-scoped session ledger + active-pane Ctrl+Z request bus (#513). Successful branch/tag delete, branch rename, merge, and pull commands return immutable backend snapshots; confirmation consumes the latest matching entry, while Rust rechecks absent/exact refs or unchanged HEAD + clean worktree immediately before the inverse.
- `state/git-graph-file-history.ts` — SCM file-history handoff (#518): opens the owning pane's graph and sends its repository-relative file path straight to a matching mounted graph or buffers it through a keyed repo remount; pending paths are dropped when panes close
- `state/git-graph-cache.ts` — bounded per-repo graph snapshot cache + `warmGraphSnapshot`/`fetchPage0Snapshot` (moved out of GitGraphView so `git-warm.ts` imports state, not a component); retains the supported 12-tab graph fan-out for remounts. GitGraphView skips its redundant initial reload for a valid cache hit, while external watcher changes evict a repo's snapshots before remount (#433, #505, arch Finding 7)
- `domain/commit-panel.ts` — pure state machine + derivations for the git-graph uncommitted-node inline commit panel (#466): `buildStageFiles`/`groupStageFiles` (stage-status grouping, partial-stage handled), `canCommit`/`commitButtonLabel`, and the ephemeral message-editor transitions (idle→committing→idle, message preserved on failure). `state/commit-panel.svelte.ts` wraps these in a per-pane rune store (`getCommitPanelStore`) whose `begin()` guard survives close+reopen (`resetIfIdle()` no-ops while committing) so a second concurrent commit can't start. GitGraphView calls the store; stage/unstage/commit reuse `gitStage`/`gitUnstage`/`gitCommit` and refresh via `reload()` + `notifyLocalGitChange` (no private refresh stack — stage/unstage also `reload()` so the partial-stage double-count in `workingChanges` can't leave the header stale). Backend `git_commit` rejects a nothing-staged index (no spurious empty commit)
- `domain/scm-filter.ts` — fuzzy filter over the sidebar's pending files (#517): `filterScmEntries`/`filterScmSummary` score paths with the Quick Open scorer (`fuzzyScorePath`), so one query behaves the same in both places. ScmSidebarView owns only the query string; while it is non-empty every tree folder renders expanded (a match inside a collapsed folder reads as a dropped match) and `toggleFolder` no-ops so a click can't rewrite the saved collapse state invisibly. `scmEmptyState`/`showScmFilterInput` key off the pending count BEFORE the filter, so a query that outlives its rows (subfolder with no changes, watcher-clean tree) still reads "Working tree clean" and keeps its input mounted. Count badges follow the filter, `canCommit` deliberately does not (commits stay repo-wide).
- `git-graph-comparison.ts` — pure comparison-detail state machine: selecting a second commit produces an older→newer pair and every transition increments the generation that rejects stale file-list responses (#512).
- `domain/scm-tree.ts`, `domain/git-graph.ts`, `domain/git.ts` — tree grouping, graph layout (`groupRefChips(decorations, headBranch)` keeps remote/branch identity for tracking checkout (#432) and marks only the checked-out branch chip active when several sit on HEAD (#433))
- `api/git.ts`, `api/git-log.ts` (incl. `gitCheckoutTracking`, `gitSyncLocalBranches`, #432; `gitOpenPrs`, #449; safe graph undo snapshots/commands, #513); `src-tauri/src/git.rs`, `git_actions.rs`, `git_log.rs`, `git_common.rs`
- `src-tauri/src/github.rs` — `git_open_prs` (#449): origin remote → owner/repo → GitHub REST open PRs (ureq, optional GITHUB_TOKEN/GH_TOKEN), 120s/60s TTL cache, degrades to `[]` for non-GitHub/offline/rate-limit; graph renders `.ref-pr` chips (`indexPrsByBranch` in `domain/git-graph.ts`), click opens via GitHub-pinned `open_external_url`
- `domain/git-warm.ts` (pure: when to warm) + `state/git-warm.ts` (wiring) — pre-warm graph/SCM caches once a pane settles on a repo
- FLOW: scmStore invokes git stage/unstage/commit/diff/log → Rust git2 ops → `git-status-changed` emit refreshes panel + badges. GitGraphView has ONE generation-counted `reload()` (dirty-flag re-run, never dropped); actions call `reload()` + `notifyLocalGitChange`, and its watcher subscription filters `source:"local"` so an action's echo can't double-reload (#432). F5 fetches then reloads; with the `f5SyncsLocalBranches` setting it also fast-forwards behind-upstream locals (`git_sync_local_branches`), reporting diverged ones in a toast (#432). WSL UNC repos: `git_repo_root`/`git_status`/`git_diff` delegate to native git (`wsl.exe --exec`) without a libgit2 open/discovery over 9P first, falling back to libgit2 only on delegation failure (#425); the UNC PollWatcher uses a 15s interval to limit 9P stat load (#426). PERF (#431): `git_branch_authors` runs ONE revwalk over all tips (was O(branches×2000)) cached per repo by tip-OID signature; the graph caches per-commit file lists in a 50-entry LRU (`gitCommitFiles`, immutable per OID) and resumes deeper pages via `git_log`'s `cursor` (OID-based, gap-free, immune to woven-stash miscount) instead of skip-walking from tips. VISUAL (#433): `git_log` returns `head_branch` (HEAD's symbolic target) so only the checked-out chip highlights; a spinner "Loading more…" row shows while scroll-triggered `loadMore` is in flight; F5's `refreshWithFetch` blurs a mouse-focused commit row / tab so the keypress doesn't paint a `:focus-visible` white ring (keyboard Tab focus is untouched).

## Quick Open (Ctrl+P fuzzy file finder)

- `components/QuickOpen.svelte` — modal, streamed results, keyboard nav
- `domain/quick-open-search.ts` — trailing debounce at the recursive backend-search boundary; active-pane/recent/frecency matches remain local and synchronous, while the merged rendered result set stays bounded (#600, #651)
- `components/PickerQuickOpen.svelte` — variant used inside file picker
- `domain/fuzzy-score.ts` — match scoring/ranking
- `api/search.ts` — `startStreamingSearch`, `fuzzySearch`, `cancelSearch`
- `src-tauri/src/search.rs`, `search_cache.rs` — nucleo fuzzy engine, streaming emits, and a bounded short-lived cache of completed recursive listings (#651)
- FLOW: query → bounded local matches render immediately; trailing `quick-open-search` scheduler → startStreamingSearch → recursively-covered watched-root completed listing cache or cold backend walk → backend emits result chunks (race-safe: listener before invoke) → sorted by fuzzy-score → Enter navigates/opens. Quick Open installs separate recursive invalidation coverage only for cache-eligible roots, leaving pane/thumbnail refresh watches non-recursive; uncovered or unwatched roots walk fresh. Descendant filesystem changes invalidate affected ancestor/descendant caches. Removing any recursive registration rebuilds all surviving registrations; coverage transitions advance exact-root revisions so overlapping parent/child roots retain real OS coverage without evicting unchanged listings. Cancelled cold walks are not published.

## Content search (grep, Ctrl+Shift+F)

- `components/ContentSearchDialog.svelte` — query/results UI
- `composables/use-content-search.svelte.ts` — search lifecycle, streamed hits
- `domain/content-search-flatten.ts` — file→line-hit flattening for list
- `api/search.ts` — `startContentSearch`, `cancelContentSearch`
- `src-tauri/src/content_search.rs` — ripgrep-based grep, streaming
- FLOW: query → startContentSearch → backend emits per-file matches → flattened → click opens `openFileAtLine`.

## Command palette

- `components/CommandPalette.svelte` — searchable command list
- `state/commands.svelte.ts` — registry (`registerCommand`, `executeCommand`, frecency)
- `state/command-definitions.ts` — command type/category defs
- `state/commands/` — `file-commands.ts`, `view-commands.ts`, `navigation-commands.ts`, `pane-commands.ts`, `general-commands.ts`, `system-actions.ts`, `shared.ts`
- `state/frecency.svelte.ts` — recency+frequency ranking
- FLOW: commands registered at startup from `commands/*` modules plus active Git Graph targets from `git-palette.ts` → palette filters via fuzzy-score + frecency → `executeCommand(id)` runs action.

## Keyboard shortcuts

- `+page.svelte` — global keydown dispatch
- `state/keybindings.svelte.ts` — `keybindingsStore`: binding map, resolve
- `domain/keybinding-parser.ts` — parse "Ctrl+Shift+P" ↔ event
- `domain/keyboard.ts` — key event normalization
- `components/KeybindingsSettings.svelte`, `components/ShortcutCheatsheet.svelte` — edit + cheat sheet UI
- FLOW: keydown → keybindingsStore resolves binding → runs command id via `executeCommand`. Bindings persisted (localStorage).

## Settings

- `components/SettingsDialog.svelte` — all settings sections (largest UI file)
- `state/settings.svelte.ts` — `settingsStore` (persisted flags/values)
- `state/persisted.ts` — localStorage load/save helpers
- `domain/settings-migration.ts` — versioned migrations for the persisted blob; add an entry here whenever a DEFAULT flips, or existing installs keep the old value (#471/#506)
- `api/config.ts`, `src-tauri/src/config.rs` — JSON config file persistence (disk)
- `src-tauri/src/config_watch.rs`, `state/config-watch.ts`, `domain/config-reload.ts` — config autoreload (#599): the Rust watcher emits `config-file-changed`, `handleConfigFileChanged` routes it, `settingsStore.reloadFromDisk` adopts it, `decideConfigReload` rejects our own writes
- `plugins/settings-registry.svelte.ts` — plugin-contributed settings rows
- FLOW: settingsStore is source of truth; components read `settingsStore.<flag>`; changes persist to localStorage + optionally config file. Many features gated here (showGitStatus, thumbnails, etc.). The WHOLE object is persisted and load merges `{ ...DEFAULT_SETTINGS, ...saved }`, so a persisted key always beats its default — `settingsStore.init()` runs `migrateSettings` on settings.json (the store of record) to let a flipped default reach existing installs (#506).

## Sidebar (bookmarks / recent / drives)

- `components/Sidebar.svelte`, `components/FilesSidebarView.svelte` — sidebar shell + files tree
- `state/bookmarks.svelte.ts` — `bookmarksStore` (pinned folders)
- `state/recent-files.svelte.ts` — `recentFilesStore`
- `state/drives.svelte.ts` — `drivesStore` (mounted volumes)
- `domain/drives.ts`; `api/files.ts` (listDrives); `src-tauri/src/files/drives.rs`
- `state/sidebar-views.svelte.ts` — which sidebar sections are shown/expanded
- `components/sidebar-view-registry.ts` — sidebar-view id → icon + component (add a new section here)
- `composables/use-panel-resize.svelte.ts` — persisted drag-resize width (also used by SCM panel, miller columns)
- FLOW: sidebar sections read their stores; drives polled from `listDrives` (drives.rs); bookmarks/recent persisted in localStorage; drop-onto-sidebar adds bookmark.

## Context menu

- `components/ContextMenu.svelte` — right-click menu (largest component; all actions)
- `state/context-menu.svelte.ts` — open/close + position
- `state/context-menu-items.svelte.ts` — menu item list per context
- FLOW: right-click → context-menu store opens with items for the target → item runs command/op.

## Status bar

- `components/StatusBar.svelte` — selection count, item count, size totals
- reads `explorer.svelte.ts` (entries/selection) + `operations.svelte.ts` (formatBytes)
- FLOW: derived from active pane's entries + selectedPaths; live op status from operationsManager.

## Toasts & dialogs

- `components/ToastOverlay.svelte`, `state/toast.svelte.ts` — `toastStore` transient notices
- `state/dialogs.svelte.ts` — `dialogStore` generic dialog orchestration
- `domain/lazy-dialog.ts` — failure-safe dialog chunk loading (`loadDialogComponent`) + mount-crash recovery (`createDialogCrashHandler`); `+page.svelte` routes all 12 code-split dialogs through the loader and wraps each in `<svelte:boundary>` so a failed import (#584) or a component that throws while mounting (#585) resets the open-flag and toasts instead of soft-locking hotkeys
- `domain/theme-list.ts` — `dedupeThemesById`, last occurrence wins; applied in `theme.svelte.ts` `discoverThemes()` so a user theme reusing a built-in id overrides it instead of crashing ThemePicker's keyed each (#585)
- `components/Modal.svelte`, `components/modal.css` — modal shell
- `components/UserReportDialog.svelte`, `state/user-report-draft.svelte.ts`, `domain/user-report.ts`, `api/user-report.ts` — bug/feature draft UI, debounced persisted text-only drafts, preserved GitHub fallback, and report IPC
- `components/CrashNotice.svelte`/`state`+`api/crash.ts`, `UpdateNotice.svelte`+`api/update.ts`
- `src/hooks.client.ts` — installs global crash/error handlers before mount; `domain/crash-report.ts` — pure dedupe + log-tail→markdown
- FLOW: any store calls `toastStore.show(...)`; ToastOverlay renders queue.
- REPORT FLOW: `help.reportIssue` → `dialogStore` → `UserReportDialog` (text fields bind through `userReportDraftStore`'s debounced localStorage draft; picker + clipboard-image previews and failed-draft attachment retry cache remain in-session) → `submit_user_report` (`src-tauri/src/user_report.rs`, validates attachments, enriches with environment only — no log tail (#595), uploads selected images through `gh image`, appends the returned GitHub `user-attachments` Markdown, then runs `gh issue create`); a successful report clears the persisted text draft, background failures toast, attachment failures restore on the next open, and text-only CLI/relay failures use `userReportFallbackUrl`.

## Theming

- `state/theme.svelte.ts` — `themeStore` (active theme, apply)
- `themes/*.css` — theme variable sets (dark, light, ocean-blue, tahoe, …); `themes/index.css` aggregates
- `components/ThemePicker.svelte` — theme selection UI
- `domain/theme-from-palette.ts`, `src-tauri/src/palette.rs`, `plugins/theme-from-image/` — generate theme from image palette
- `state/window-backdrop.ts`, `state/window-appearance.ts`, `components/AnimatedBackground.svelte`, `background-animations/` (particles, starfield, registry) — window backdrop + animated bg
- FLOW: themeStore sets CSS vars / `data-theme`; `set_window_theme`/`set_window_backdrop` for native chrome. Theme application is imperative, not reactive, so anything that changes `settings.theme` behind the store's back must call `themeStore.syncFromSettings()` — config autoreload does (#599), as does `settingsStore.init()`. A `themes/*.css` edit re-runs `initTheme()` to re-inject and re-discover.

## Plugins

- `plugins/registry.svelte.ts` — `pluginRegistry` (register/enable)
- `plugins/api.ts` — `Plugin`/`PluginContext` contract (storage, jobs, toast, settings)
- `plugins/dialog-registry.svelte.ts`, `settings-registry.svelte.ts`, `fs-providers.ts` — extension points
- built-ins: `plugins/ai-organize/`, `ai-rename/`, `nano-banana/`, `theme-from-image/`, `upscale/`, `demo/`
- backend: `src-tauri/src/ai_organize.rs`, `ai_rename.rs`, `nano_banana.rs`, `gemini.rs`, `upscale.rs`, `fal.rs`, `plugin_job.rs` (shared job scaffolding: id alloc, output-path validation, timeout, complete/error events)
- shared UI: `plugins/plugin-dialog.css` (dialog chrome), `domain/available-filename.ts` (collision-free output name)
- FLOW: plugins register commands/settings/dialogs via PluginContext at startup; AI actions invoke Gemini-backed Rust commands (upscale invokes fal.ai's SeedVR2 queue API via `fal.rs`).

## Terminal panel

- `components/TerminalPanel.svelte` — embedded terminal UI
- `state/terminal.svelte.ts`; `domain/terminal-*.ts` (command, cwd-sync, keys, shell dialect/WSL path translation, theme)
- `api/terminal.ts`; `src-tauri/src/terminal.rs` — PTY spawn/write/resize/kill
- FLOW: terminal_spawn/write/resize (terminal.rs) ↔ TerminalPanel; cwd synced to active pane via terminal-cwd-sync.

## Archives, external apps, wallpaper, system

- `api/archive.ts`, `src-tauri/src/archive.rs` — zip compress/extract, list contents
- `src-tauri/src/files/external_apps.rs`, `api/files.ts` (openFileWith, openImageWithSiblings) — open-with
- `src-tauri/src/wallpaper.rs` (setAsWallpaper), `system.rs` (get_app_info, dirs), `portal.rs` (Linux portals)
- `src-tauri/src/files/shortcuts.rs` — .lnk/.desktop resolution

## Windows source installer

- `README.md` — documented one-command PowerShell invocation.
- `windows_install.ps1` — trusted Windows source-install entry point: prerequisite checks → existing checkout or temporary HTTPS clone → Tauri MSI build → explicit-UAC `msiexec`; reports `3010` as reboot-required success and removes temporary clones in `finally`.
- `tests/windows-install-script.test.ts` — Windows-only PowerShell invocation harness; exercises missing tools, existing and cloned checkouts, quoted MSI paths, UAC, cleanup, and reboot-required success without building or installing software.
- `docs/adr/0003-windows-installer-trust-boundary.md` — governs the installer download/trust, elevation, failure, reboot, and cleanup boundary.
- FLOW: README command or local `windows_install.ps1` → prerequisite/toolchain checks → checkout resolution → `bunx tauri build` → elevated `msiexec`; the Windows CI job runs the invocation harness against this seam.

---

## Cross-cutting

- **IPC pattern**: frontend `invoke("cmd", {args})` wrapped in `api/*.ts`; outside Tauri, `api/mock-invoke.ts` intercepts (detects `__TAURI_INTERNALS__`). Rust `#[tauri::command] async fn` registered in `src-tauri/src/lib.rs`.
- **Refresh manager** (`state/refresh-manager.ts`): single choke point. WHEN=refresh-manager, WHETHER=pane-watch, HOW=pane-refresh. Don't add a 4th gate.
- **Key event names**: `directory-changed` (fs_watcher.rs → use-file-watchers.ts → refresh), `git-status-changed` (git.rs → git-status.svelte.ts). Cross-window: BroadcastChannel `explorer-file-changes` (file-events.ts) and `explorer-drag-data` in localStorage (drag.svelte.ts).
- **Persistence**: UI/prefs via `state/persisted.ts` (localStorage: settings, keybindings, bookmarks, recent, tabs, drag). Durable config via `api/config.ts` → `config.rs` JSON files.
- **Cancellable backend tasks**: `src-tauri/src/task_registry.rs` — search/listing/copy/compress use cancel_* commands.
- **Warm pool**: pre-spawned windows (`warm_pool.rs` + `state/warm-window.ts`) for instant new window/tab.
- **Rule**: display features must update all three views (DetailsView/ListView/TilesView) via FileList.svelte.
