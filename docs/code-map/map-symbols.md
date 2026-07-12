# Code Map — Symbol Index

Lookup table for identifiers agents otherwise grep for. No line numbers. Paths relative to repo root. Verified against code (not docs) on 2026-07-11.

Conventions: stores live in `src/lib/state/`, domain logic in `src/lib/domain/`, IPC wrappers in `src/lib/api/`, Rust in `src-tauri/src/`. `.svelte.ts` = runes store; plain `.ts` = pure/helper module.

---

## (a) Svelte stores & state modules — `src/lib/state/`

Grep the export name; the singleton is usually `xxxStore` (a `$state` class instance).

| Export | File | Role |
|---|---|---|
| `windowTabsManager`, `generateId`, `extractFolderName` | window-tabs.svelte.ts | **Tab/window/pane-split manager** — tabs, split layout tree, active pane. Largest store. |
| `ExplorerInstance` (class) | explorer.svelte.ts | **Per-pane central store** — listing, selection, navigation, sort, view mode. Hottest file. |
| `settingsStore`, `Settings`, `TOGGLE_SETTINGS`, `THUMBNAIL_SIZE_CONFIG`, `generateToggleCommands`, `ColumnVisibility`, `PaneLayoutMode`, `NavBarButtons`, `IconTheme`, `ThumbnailSize`, `WindowsBackdrop` | settings.svelte.ts | All user settings + toggle-command generation. Persists `settings.json`. |
| `getScmStore(paneId)` | scm.svelte.ts | Per-pane git SCM panel state (staged/unstaged/commit box), #334. |
| `gitStatusStore` | git-status.svelte.ts | Per-file git status badges cache for the file list. |
| `commandsStore` helpers: `registerCommand(s)`, `getAllCommands`, `getAvailableCommands`, `getCommandsByFrecency`, `getRecentCommands`, `getCommand`, `getCommandShortcut`, `Command`, `CommandCategory` | commands.svelte.ts | Command palette registry + frecency ranking. |
| `registerAllCommands` | command-definitions.ts | Registers the full command set at startup. |
| `keybindingsStore`, `Keybinding`, `UserKeybindings` | keybindings.svelte.ts | User keybinding overrides; persists `explorer-keybindings`. |
| `bookmarksStore`, `Bookmark` | bookmarks.svelte.ts | Sidebar bookmarks. Config `bookmarks.json` / LS `explorer-bookmarks`. |
| `drivesStore` | drives.svelte.ts | Mounted drives/volumes for sidebar. |
| `recentFilesStore`, `RecentEntry` | recent-files.svelte.ts | Recent files list (LS `explorer-recent-files`). |
| `frecencyStore`, `computeFrecencyScore`, `FrecencyEntry` | frecency.svelte.ts | Frequency+recency scoring (LS `explorer-frecency`). |
| `workspacesStore`, `Workspace` | workspaces.svelte.ts | Saved workspaces (LS `explorer-workspaces`). |
| `themeStore`, `ThemeInfo` | theme.svelte.ts | Active theme + user themes. Persists `theme`. |
| `clipboardStore`, `ClipboardOperation`, `ClipboardContent` | clipboard.svelte.ts | In-app cut/copy clipboard. |
| `dialogStore`, `DialogType`, `PickerConfig`, `PickerOption` | dialogs.svelte.ts | Central dialog/picker open-state router. |
| `contextMenuStore`, `ContextMenuPosition` | context-menu.svelte.ts | Right-click menu position/visibility. |
| `contextMenuItems`, `ContextMenuItem` | context-menu-items.svelte.ts | Builds context-menu item list. |
| `conflictResolver`, `ConflictChoice`, `ConflictResult` | conflict-resolver.svelte.ts | Copy/move name-collision prompt state. |
| `emptyFolderResolver` | empty-folders.svelte.ts | "Delete empty folder?" resolution flow. |
| `manualHiddenStore` | manual-hidden.svelte.ts | User-hidden entries (LS `explorer-manual-hidden`). |
| `renameSuggestionStore` | rename-suggestion.svelte.ts | AI rename suggestion provider hookup. |
| `sidebarViewsStore`, `SidebarView`, `ALL_SIDEBAR_VIEWS` | sidebar-views.svelte.ts | Which sidebar tab (files/scm/etc.) is active. |
| `folderViewsStore`, `FolderViewOverride` | folder-views.svelte.ts | Per-folder view-mode override (`folder-views.json`). |
| `operationsManager`, `Operation`, `formatBytes`, `getOperationLabel` | operations.svelte.ts | Long-running file-op progress registry. |
| `jobsStore`, `Job`, `JobStatus` | jobs.svelte.ts | Background job tracking (zip/copy jobs). |
| `undoStore` | undo.svelte.ts | Undo stack for file operations. |
| `toastStore`, `Toast`, `ToastType` | toast.svelte.ts | Transient notifications. |
| `terminalPanelStore` | terminal.svelte.ts | Integrated terminal panel open/size state. |
| `homeDirectory` | home.svelte.ts | Cached home dir path. |
| `dragState`, `DragData` | drag.svelte.ts | Shared in-app drag payload (DnD via store, not dataTransfer). |
| `tabDragState`, `TabDragData`, `claimDraggedTab`, `initTabTransferListener` | tab-transfer.ts | Cross-window tab drag hand-off. |
| `windowTabsManager` persistence: `toLayoutTree`, `normalizePersistedState`, `migrateLegacyState`, `RestoreResult` | window-tabs-persistence.ts | Serialize/restore/migrate tab layout (LS `explorer-tabs`). |
| `createClosedTabsStore`, `ClosedTabsStore` | closed-tabs.ts | Reopen-closed-tab stack. |

**Non-store state modules (plain `.ts`, imported by stores/panes):**

| Export | File | Role |
|---|---|---|
| `createDirectoryListing`, `DirectoryListingResult` | directory-listing.ts | Streaming directory-load orchestration (subscribes `directory-entries`). |
| `createPaneMutations`, `PaneMutations` | pane-mutations.ts | Create/rename/delete/move mutations for a pane. |
| `createPaneRefresh`, `entriesFingerprint` | pane-refresh.ts | Re-list pane after fs change; diff via fingerprint. |
| `createPaneWatch`, `MUTATION_COOLDOWN_MS` | pane-watch.ts | Wire fs-watcher → pane refresh with cooldown. |
| `requestRefresh`, `cancelPendingRefreshes` | refresh-manager.ts | Debounced global refresh scheduler. |
| `PasteSource`, `PasteContext`, `PasteResult` | paste-operations.ts | Paste (copy/move) execution + conflict handling. |
| `DropOptions`, `getDropSourcePath(s)` | drop-operations.ts | Resolve drop source paths for DnD. |
| `FileTransferOptions`, `FileTransferResult` | file-transfer.ts | Copy/move with progress (`copy-progress`). |
| `calculateSelection`, `selectByIndices`, `getSelectedEntries` | selection.ts | Selection math (range/toggle). |
| `HistoryState`, `pushToHistory`, `canGoBack/Forward`, `parseBreadcrumbs`, `getParentPath` | navigation.ts | Back/forward history + breadcrumb parsing. |
| `loadPersisted`, `savePersisted`, `writeConfigQueued` | persisted.ts | localStorage + serialized config-file writer. |
| `SortPref`, `saveSortPref`, `getSortPref` | sort-prefs.ts | Per-dir sort persistence (LS `explorer-sort-prefs`). |
| `initFileChangeListener`, `broadcastFileChange`, `FileChangeEvent` | file-events.ts | Cross-pane fs-change broadcast bus. |
| `notifyLocalGitChange`, `emitWatcherGitChange`, `GitChange` | git-refresh.ts | Git-status refresh triggers. |
| `getThumbnailCache`, `setThumbnailCache`, `renameThumbnailCache` | thumbnail-cache.ts | Front-end thumbnail data-URL cache. |
| `undoStore` helpers `getAffectedDirs`, `undoActionLabel` | undo-helpers.ts | Undo labeling/affected-dir calc. |
| `WARM_ACTIVATE_EVENT` (`"warm-activate"`), `warmMode`, `WarmActivatePayload` | warm-window.ts | Pre-warmed window activation (LS prefix `explorer-warm-`). |
| `explorerWindowAppearance` | window-appearance.ts | Titlebar/backdrop appearance flags. |
| `windowsBackdropEffects` | window-backdrop.ts | Windows mica/acrylic backdrop. |
| `saveFocusedWindowState`, `readFocusedWindowState` | focused-window.ts | Which window is focused. |
| `markStartup`, `reportFirstPaint` | startup-timing.ts | Startup perf marks. |
| Types `ViewMode`, `PaneId`, `WindowTab`, `PaneTab`, `TabPane`, `ExplorerTab`, `UndoAction`, `ExplorerCoreState` | types.ts | Shared state types. |

Command sub-registries: `src/lib/state/commands/` → `file-commands.ts`, `general-commands.ts`, `navigation-commands.ts`, `pane-commands.ts`, `view-commands.ts`, `system-actions.ts`, `shared.ts` (view-mode/split/toggle command bodies).

---

## (b) Tauri commands — Rust fn → `.rs` file → JS wrapper (`src/lib/api/*`)

All are `#[tauri::command] pub async fn`. Wrapper column lists `wrapperFn` in the named api file; `invoke("<fn>")` matches the Rust fn name.

**Files/dir listing** — `src-tauri/src/files/`, wrapper `api/files.ts`
| Rust fn | .rs | Wrapper |
|---|---|---|
| list_directory | files/dir_listing.rs | fetchDirectory |
| start_streaming_directory / cancel_directory_listing | files/dir_listing.rs | startStreamingDirectory / cancelDirectoryListing |
| is_directory_empty / invalidate_dir_cache | files/dir_listing.rs | isDirectoryEmpty |
| create_directory / rename_entry / copy_entry / cancel_copy / move_entry | files/file_ops.rs | createDirectory / renameEntry / copyEntry / cancelCopy / moveEntry |
| read_text_file / write_text_file / read_image_data_url | files/file_ops.rs | readTextFile / writeTextFile / readImageAsBlobUrl |
| delete_entry_permanent / create_symlink / estimate_size / check_paths_exist | files/file_ops.rs | deleteEntryPermanent / createSymlink / estimateSize / checkPathsExist |
| get_home_directory | files/file_ops.rs | getHomeDirectory |
| list_drives | files/drives.rs | listDrives |
| resolve_shortcut | files/shortcuts.rs | resolveShortcut |
| open_file / open_file_at_line / open_file_with / open_image_with_siblings / open_in_terminal / list_installed_terminals | files/external_apps.rs | openFile / openFileAtLine / openFileWith / openImageWithSiblings / openInTerminal / listInstalledTerminals |
| watch_directory / unwatch_directory | files/fs_watcher.rs | watchDirectory / unwatchDirectory |
| get_git_status | files/git_status.rs | getGitStatus (also in api/git.ts) |

**Trash / system** — `system.rs`, wrappers `api/files.ts` & `api/crash.ts`
| move_to_trash / move_multiple_to_trash | system.rs | (files.ts deleteEntry/deleteMultipleEntries) |
| restore_from_trash | system.rs | restoreFromTrash |
| get_launch_cwd / log_startup_timing / set_window_theme / get_app_info / get_log_dir | system.rs | getLaunchCwd / logStartupTiming / setWindowTheme / getAppInfo / getLogDir |

**Search** — `api/search.ts`
| fuzzy_search / start_streaming_search / cancel_search | search.rs | fuzzySearch / startStreamingSearch / cancelSearch |
| start_content_search / cancel_content_search | content_search.rs | startContentSearch / cancelContentSearch |

**Git** — `api/git.ts` (status/CRUD), `api/git-log.ts` (history/actions)
| git_status / git_stage / git_unstage / git_discard / git_diff / git_commit | git.rs | gitSummary / gitStage / gitUnstage / gitDiscard / gitDiff / gitCommit |
| git_init / git_repo_root / git_add_to_gitignore / git_watch_repo / git_unwatch_repo | git.rs | gitInit / gitRepoRoot / gitAddToGitignore / gitWatchRepo / gitUnwatchRepo |
| git_log / git_refs / git_commit_files / git_commit_file_diff | git_log.rs | gitLog / gitRefs / gitCommitFiles / gitCommitFileDiff |
| git_checkout / git_create_branch / git_create_tag / git_cherry_pick / git_revert / git_merge / git_rebase / git_reset | git_actions.rs | gitCheckout / gitCreateBranch / gitCreateTag / gitCherryPick / gitRevert / gitMerge / gitRebase / gitReset |

**Thumbnails / palette** — `api/thumbnails.ts`
| get_thumbnail / get_thumbnail_data / get_micro_thumbnail / get_video_thumbnail_data / get_folder_preview / set_ffmpeg_path | thumbnails.rs | getThumbnail / getThumbnailData / getMicroThumbnail / getVideoThumbnailData / getFolderPreview / (files.ts setFfmpegPath) |
| clear_thumbnail_cache / get_thumbnail_cache_stats | thumbnails.rs | clearThumbnailCache / getThumbnailCacheStats |
| extract_palette | palette.rs | extractPalette |

**Archive** — `archive.rs`, wrapper `api/archive.ts`
| compress_to_zip / cancel_compress / extract_archive / list_archive_contents / cancel_extract | archive.rs | compressToZip / cancelCompress / extractArchive / listArchiveContents / cancelExtract |

**Clipboard** — `clipboard.rs`, wrappers `api/files.ts` & `api/os-clipboard.ts`
| clipboard_has_image / clipboard_paste_image | clipboard.rs | clipboardHasImage / clipboardPasteImage |
| clipboard_has_files / clipboard_read_files / clipboard_write_files | clipboard.rs | osClipboardHasFiles / osClipboardReadFiles / osClipboardWriteFiles |

**Terminal** — `terminal.rs`, wrapper `api/terminal.ts`
| terminal_reserve_id / terminal_spawn / terminal_write / terminal_resize / terminal_kill / terminal_status | terminal.rs | terminalReserveId / terminalSpawn / terminalWrite / terminalResize / terminalKill / terminalStatus |

**AI** — `api/ai-rename.ts`, `api/ai-organize.ts`, nano-banana plugin
| ai_suggest_filenames | ai_rename.rs | suggestFilenames |
| ai_suggest_destination | ai_organize.rs | suggestDestination |
| start_nano_banana_job | nano_banana.rs | startNanoBananaJob (files.ts); UI `src/lib/plugins/nano-banana/` |

**Config / themes** — `config.rs`, wrapper `api/config.ts` (+ persisted.ts)
| read_config_file / write_config_file / list_user_themes / write_theme_file / get_config_dir | config.rs | readConfigFile / writeConfigFile / listUserThemes / writeThemeFile |

**Misc / lifecycle**
| Rust fn | .rs | Wrapper |
|---|---|---|
| check_for_update | update_check.rs | api/update.ts checkForUpdate |
| take_crash_report / log_frontend_error / open_external_url | crash_report.rs | api/crash.ts takeCrashReport / logFrontendError / openExternalUrl |
| set_as_wallpaper | wallpaper.rs | files.ts setAsWallpaper |
| picker_respond | portal.rs | files.ts pickerRespond (native file-picker portal) |
| warm_pool_begin_spawn / _cancel_spawn / _register / _claim / _discard / _shutdown | warm_pool.rs | api/warm-pool.ts warmPool* |

---

## (c) Events — name → emitter → listener

Static event names (Tauri `emit`/`listen`; app uses a shared-state pattern, so few):

| Event | Emitter | Listener |
|---|---|---|
| `directory-changed` | files/fs_watcher.rs | composables/use-file-watchers.ts, components/MillerColumns.svelte, FolderThumbnail.svelte, state/drives.svelte.ts |
| `directory-entries` | files/dir_listing.rs | api/files.ts → state/directory-listing.ts (streaming rows) |
| `search-results` | search.rs, content_search.rs | api/search.ts → composables/use-content-search.svelte.ts, components/QuickOpen.svelte |
| `content-search-results` | content_search.rs | api/search.ts → use-content-search.svelte.ts |
| `copy-progress` | files/file_ops.rs (via progress.rs) | state/file-transfer.ts, state/paste-operations.ts |
| `zip-progress` / `unzip-progress` | archive.rs (progress.rs) | api/archive.ts → state/pane-mutations.ts |
| `git-status-changed` | git.rs | state/git-status.svelte.ts, state/scm.svelte.ts, state/git-refresh.ts, components/ScmSidebarView.svelte |
| `nano-banana-complete` / `nano-banana-error` | nano_banana.rs | api/files.ts, plugins/nano-banana/index.ts |
| `tauri-explorer-update-check` | update_check.rs | (single-window update ping) |
| `warm-activate` (`WARM_ACTIVATE_EVENT`) | state/warm-window.ts | warm-window.ts / +page.svelte |

**Dynamic per-id channels** (`format!` in Rust): `terminal-output-{id}`, `terminal-cwd-{id}`, `terminal-exit-{id}` (terminal.rs → api/terminal.ts / components/TerminalPanel), and streaming listing uses `dir{NN}` internal channels (dir_listing.rs).

---

## (d) Composables — `src/lib/composables/` → used-by

| Export | File | Used by |
|---|---|---|
| useColumnResize | use-column-resize.svelte.ts | DetailsView.svelte |
| useContentSearch | use-content-search.svelte.ts | ContentSearchDialog.svelte |
| useDropTarget | use-drop-target.svelte.ts | MillerColumns.svelte |
| useExternalDrop | use-external-drop.svelte.ts | use-native-drop-handler.ts |
| startExternalDrag | use-external-drag.svelte.ts | (drag-out to OS) |
| useFileWatchers | use-file-watchers.ts | +page.svelte |
| useInlineRename | use-inline-rename.svelte.ts | EntryName.svelte |
| useItemInteractions, isInClipboard, isClipboardCut | use-item-interactions.svelte.ts | FileItem, ItemButton, ListView, TilesView |
| useMarqueeSelection | use-marquee-selection.svelte.ts | FileList.svelte (marquee candidate set + hit-testing) |
| useNativeDropHandler | use-native-drop-handler.ts | +page.svelte |
| resolveDropTarget(_AtPoint), adjustForPointerZoom | use-native-drop-target.svelte.ts | use-native-drop-handler.ts |
| usePointerDrag, createDragGhost | use-pointer-drag.svelte.ts | FileItem, ItemButton, ListView, MillerColumns, TilesView (drag ghost) |
| usePointerIntent | use-pointer-intent.svelte.ts | CommandPalette, ContentSearchDialog, QuickOpen |
| useProgressiveRender, nextProgressiveState | use-progressive-render.svelte.ts | (large-list staged render) |
| useSidebarDrag | use-sidebar-drag.svelte.ts | FilesSidebarView.svelte |
| useTypeAhead | use-type-ahead.svelte.ts | FileList.svelte |
| useWindowLifecycle | use-window-lifecycle.ts | +page.svelte |

---

## (e) Key domain functions/types — `src/lib/domain/`

| Symbols | File |
|---|---|
| `FileEntry`, `FileKind`, `DirectoryListing`, `SortField`, `sortEntries`, `filterHidden`, `isSystemHidden`, `formatSize` | file.ts |
| `getFileType`, `getExtension`, `getFileIconColor`, `isImageFile`, `isVideoFile`, `isTextFile`, `isShortcut`, `IconCategory`, `formatDate` | file-types.ts |
| `fuzzyScore`, `fuzzyScorePath`, `filenameMatchScore`, `scoreCommand`, `commandFrecencyPoints` | fuzzy-score.ts |
| `parseShortcut`, `matchesShortcut`, `eventToShortcutString`, `formatShortcut`, `isChordShortcut`, `parseChord` | keybinding-parser.ts |
| `normalizeKeyForShortcut`, `matchesShortcutKey`, `SHORTCUT_KEYS`, `SPECIAL_KEYS` | keyboard.ts |
| `parsePathInput`, `filterDirectorySuggestions`, `MAX_SUGGESTIONS` | autocomplete.ts |
| `truncateBreadcrumbs`, `measureCrumbWidth`, `Breadcrumb` | breadcrumb-truncation.ts |
| `PaneNode`, `PaneLeaf`, `PaneSplit`, `splitLeaf`, `splitNode`, `leafIds`, `SplitDirection` | pane-layout.ts |
| `VirtualRow`, `chunkIntoRows`, `autoFillColumns`, `computeOffsets`, `firstVisibleIndex`, `lastVisibleIndexExclusive` | virtual-layout.ts |
| `parseVirtualPath`, `isVirtualPath`, `virtualScheme`, `virtualBreadcrumbs` | virtual-path.ts |
| `parseUnifiedDiff`, `DiffLine`, `ParsedDiff` | diff.ts |
| `flattenBatch`, `rebuildAllFlattened`, `highlightMatch`, `FlattenedResult` | content-search-flatten.ts |
| `assignLayout`, `branchPath`, `groupRefChips`, `GRAPH_PALETTE`, `GraphLayout` | git-graph.ts |
| `gitStatusLetter` | git.ts |
| `buildTree`, `collectPaths`, `ScmTreeNode` | scm-tree.ts |
| `highlightCode`, `hasLanguageSupport`, `highlightDiffLine` | syntax-highlight.ts |
| `getNerdIcon`, `FOLDER_ICON`, `DEFAULT_FILE_ICON` | nerd-icons.ts |
| `selectPreviewImages`, `isPreviewImageName`, `FolderPreview`, `MAX_PREVIEW_IMAGES` | folder-preview.ts |
| `isMac`, `isWindows`, `usesPointerDrag`, `usesHtml5Drag`, `isCopyModifier` | platform.ts |
| path utils: `joinPath`, `parentDir`, `basename`, `samePath`, `expandTilde`, `toNativeSeparators`, `isDriveRoot` | path.ts |
| `disambiguateTabTitles`, `gitTabDisplay` | tab-title.ts |
| `buildTheme`, `themeIdFromName`, `hexToRgb`, `luminance` | theme-from-palette.ts |
| `buildTerminalTheme`, `TerminalTheme` | terminal-theme.ts |
| `isShellReservedKey`, `isHardcodedAppShortcut`, `SHELL_CRITICAL_CTRL_KEYS` | terminal-keys.ts |
| `decideCdSync`, `buildCdCommand`, `buildCdSyncSequence` | terminal-cwd-sync.ts, terminal-command.ts |
| `findNextWordBoundary`, `findPrevWordBoundary` | word-boundary.ts |
| `isWslPath`, `isWslHome` | wsl.ts |
| `detectViewportZoomCoords`, `clientToFixed`, `getZoomFactor` | zoom.ts |
| `renderMarkdown` | markdown.ts |
| `showTitleBar`, `showWindowTabBar` | titlebar.ts |
| `createRafCoalescer` | raf-coalesce.ts |

---

## (f) Keyboard-shortcut handling points

| Where | Symbol / role |
|---|---|
| `src/routes/+page.svelte` | `handleKeydown` / `handleKeyup` — **global app shortcuts**, dispatches to commands via `keybindingsStore` |
| state/keybindings.svelte.ts | user-override resolution; matches events → action ids |
| domain/keybinding-parser.ts, domain/keyboard.ts | parse/match/format shortcut strings (pure) |
| state/commands.svelte.ts (`getCommandShortcut`) | command → bound shortcut |
| components/KeybindingsSettings.svelte | rebind UI (captures keydown) |
| Per-widget keydown (nav within widget): FileList, ExplorerPane, QuickOpen, CommandPalette, ContentSearchDialog, ContextMenu, BreadcrumbAutocomplete, NavigationBar, ScmSidebarView, GitGraphView, WindowTabBar, EntryName, Modal, dialogs (Delete/BulkRename/Workspace/Settings) | local handlers |
| composables use-type-ahead.svelte.ts | type-to-select in file list |
| domain/terminal-keys.ts | which keys the integrated terminal keeps vs. app |

---

## (g) Settings & persistence keys

**Config files** (Rust config dir, via `writeConfigFile`/`readConfigFile` → config.rs):
| File | Owner |
|---|---|
| `settings.json` | settings.svelte.ts |
| `bookmarks.json` | bookmarks.svelte.ts |
| `manual-hidden.json` | manual-hidden.svelte.ts |
| `folder-views.json` | folder-views.svelte.ts |
| `plugin.ai-rename.json` | plugins/ai-organize/index.ts |
| user theme files | config.ts writeThemeFile / listUserThemes |

**localStorage keys** (via persisted.ts `loadPersisted`/`savePersisted`, mostly `explorer-*`):
| Key | Owner |
|---|---|
| `explorer-tabs` | window-tabs.svelte.ts (layout/tab state) |
| `explorer-keybindings` | keybindings.svelte.ts |
| `explorer-frecency` | frecency.svelte.ts |
| `explorer-recent-files` | recent-files.svelte.ts |
| `explorer-workspaces` | workspaces.svelte.ts |
| `explorer-bookmarks` | bookmarks.svelte.ts |
| `explorer-manual-hidden` | manual-hidden.svelte.ts |
| `explorer-sort-prefs` | sort-prefs.ts |
| `explorer-sidebar-active-view` | sidebar-views.svelte.ts |
| `explorer-folder-views` | folder-views.svelte.ts |
| `explorer-hidden-system-folders` | FilesSidebarView.svelte |
| `explorer-warm-*` | warm-window.ts |
| `theme` | theme.svelte.ts |
| `explorer-bg`, `explorer-bg-rgba` | background/theme (LS) |
| `mockUpdateAvailable`, `mockCrashReport`, `mock-opened-url`, `mock-picker-response` | E2E mock hooks (mock-invoke.ts) |

**Toggle settings**: `TOGGLE_SETTINGS` + `generateToggleCommands` in settings.svelte.ts define every boolean setting and its palette command — grep here for a checkbox/toggle feature.
