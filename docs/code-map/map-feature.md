# Code Map — Feature Clusters

Tauri v2 file explorer. Most tasks are feature-shaped and cut across
`component → store/state → api bridge → Rust command`. Each cluster lists files
in pipeline order, then FLOW lines naming the events/functions that connect them.
Paths relative to repo root. No line numbers (they go stale).

Central hubs (open these for almost anything): `src/lib/state/explorer.svelte.ts`
(per-pane store: entries, selection, navigation; `createExplorerState`),
`src/routes/+page.svelte` (SPA root: global shortcuts, store init, layout),
`src/lib/api/common.ts` (IPC primitives; feature wrappers live in sibling modules), `src/lib/api/mock-invoke.ts` (fake
backend for E2E/browser).

---

## View modes & virtualization

- `components/FileList.svelte` — dispatches to Details/List/Tiles; owns exact deferred cursor focus through each virtualized view
- `components/EntryCell.svelte` — shared List/Tiles gridcell interaction and roving focus attributes
- `components/DetailsView.svelte` — virtual-scrolled table (columns, sort headers); `domain/detail-columns.ts` + `composables/use-column-resize.svelte.ts` project session-local widths through one keyed scalar resize owner
- `components/ListView.svelte` — CSS-grid columns view
- `components/TilesView.svelte` — auto-fill tile grid
- `components/VirtualList.svelte` — windowing engine (visible-range calc, spacers)
- `domain/virtual-layout.ts` — row/col geometry math for the virtualizer
- `composables/use-progressive-render.svelte.ts` — chunked reveal of large lists
- `composables/use-row-grid-view.svelte.ts` — shared virtualization wiring (rows, DnD, new-folder sentinel, scrollToIndex) behind List + Tiles
- `state/commands/view-commands.ts` — view.details/list/tiles, sort, columns cmds
- `state/sort-prefs.ts`, `state/folder-views.svelte.ts` — per-folder view+sort persistence
- `components/FileIcon.svelte` — shared icon renderer used by all 3 views (via `FileItem.svelte` for Details and directly from List/Tiles); linked-folder and git-repo-folder badge overlays live here so a display feature added once covers all views automatically
- `domain/file-types.ts` — `isGitRepoFolder` (icon-selection predicate for the git-repo folder badge, #463); backend flag set in `src-tauri/src/files/mod.rs::metadata_to_entry` (`FileEntry.is_git_repo`, one `.git`-exists stat per directory entry)
- `domain/relative-time.ts` — shared compact relative labels for file metadata, today's git commits, and PR comments
- FLOW: view mode lives on explorer store; `FileList` reads it, mounts one view; all three must change together for display features. Since Details/List/Tiles all route icons through `FileIcon.svelte`, icon-only features (like the git-repo badge) don't need per-view changes — the shared component is the single seam.

## Selection & marquee

- `composables/use-marquee-selection.svelte.ts` — drag-rect candidate set + hit-testing
- `composables/use-item-interactions.svelte.ts` — click/ctrl/shift selection, focus
- `domain/file-list-navigation.ts` — pure cursor resolution and keyboard movement/selection intents
- `state/file-list-focus-context.ts` — inline editor keyboard completion borrows FileList focus ownership across row replacement
- `state/selection.ts` — pure selection-set helpers (path-anchored range, toggle)
- `composables/use-type-ahead.svelte.ts` — type-to-select by name prefix
- selection state stored on `explorer.svelte.ts` (`selectedPaths`, path anchor, independent path cursor)
- FLOW: pointer events in item-interactions/marquee → mutate explorer selection set → views highlight via `selectedPaths`.

## Directory listing & refresh/watcher events

- `src/test-support/watcher-listing-probe.ts` — E2E-only real-write/receipt protocol holds a listing without relying on WebDriver mid-flight observations.

- `state/git-repo-watch.ts` — shares ordered native lease acquisition/release across graph and SCM, retaining failed releases for retry.
- `state/git-graph-coverage.ts` — shares acknowledged observation across graph writers and retained snapshots, independent of mounted views; network polling roots read fresh.
- `src-tauri/src/git_watch.rs`, `git_watch/service.rs`, `git_watch/target.rs` — acknowledged unique native leases scoped to concrete windows and renderer generations; page replacement, renderer termination and native destruction reclaim them, while delayed old-session IPC is rejected; one worker owns shared observers and recovery/debounce deadlines; parent watches detect root replacement while filtering sibling activity.
- Native crash acceptance: `e2e-tauri/renderer-recovery.ts` controls two renderer terminations; `src-tauri/test_support/renderer_recovery.rs` retains the same GTK WebView and verifies reclaimed/reacquired ownership and working navigation after reload. `src-tauri/test_support/git_observation_probe.rs` attaches causal observation metadata to real Git events only in the opt-in recovery build.
- `api/native-resource-session.ts` + `src-tauri/src/renderer_owner.rs`, `renderer_owner/scope.rs`, `renderer_owner/termination.rs` — one acknowledged renderer incarnation shared by directory and Git leases; concrete native lifecycle retires both without blocking the UI thread.
- `state/directory-watch.ts` — generic ordered path-lease owner plus the directory adapter used by FolderThumbnail, MillerColumns and drives; teardown retains exact release identity and drains late acquisition.
- `src-tauri/src/files/directory_watches.rs` — pure directory lease/retirement policy with injected OS observation; shares registrations and retries/rebuilds failed forced cleanup without granting cache coverage to retired owners.

- `state/directory-listing.ts` — `createDirectoryListing`: invoke + streamed-chunk accumulation, cancellation
- `state/pane-refresh.ts` — `createPaneRefresh`: complete-listing reconciliation without UI flash
- `domain/directory-reconciliation.ts` — reconcile external listings with concurrent mutations and selected path identities
- `state/refresh-manager.ts` — global debounce/dedup/rate-limit (`requestRefresh`)
- `state/pane-watch.ts` — observed navigation tickets keep the old directory lease until commit, replay pending-target changes and gate refresh during navigation.
- `state/directory-events.ts` — shared ready-before-scan native event hub with acquisition retry and late-listener retirement.
- `composables/use-file-watchers.ts` — subscribes to `directory-changed` + cross-window channel
- `state/file-events.ts` — BroadcastChannel `explorer-file-changes` between windows
- `api/files.ts` — `watchDirectory`/`unwatchDirectory`, `listDirectory`, `startStreamingDirectory` (observed navigation or ordinary refresh)
- `src-tauri/src/files/fs_watcher.rs` — notify watcher → emits event; `files/dir_listing.rs` — listing + streaming
- `src-tauri/src/files/directory_cache.rs` — pure snapshot retention/publication policy, bounded by path count and retained allocation estimate; checked blocking scans in `dir_listing.rs` publish only complete results.
- `src-tauri/src/files/watch_observation.rs` — injected native observation generations and recovery; nonrecursive parent/root sharing, lazy recursive coverage, immediate fault invalidation and deadline-based retries (ADR 0013).
- FLOW: `start_observed_directory` establishes renderer-owned demand before scanning; the pane stages its returned lease before publishing entries. `directory-changed` (fs_watcher.rs → directory-events.ts → pane-watch.ts) and cross-window `broadcastFileChange` both funnel through `requestRefresh` → pane `refresh()`. Refresh policy split across 3 layers — read header of `refresh-manager.ts` before touching.
- Native mutation events bypass the watcher quiet period and retain priority through coalescing. The refresh manager fixes their 150ms deadline at the first mutation request, waits for any active scan, then reconciles without the watcher storm interval. Later watcher traffic cannot move that deadline. Contracts: `tests/state/refresh-manager.test.ts`, `tests/state/pane-watch.test.ts`, `src-tauri/test_support/fs_watcher_changes.rs`.

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

- `components/FilesSidebarView.svelte`, `state/recycle-bin.ts`, `api/open.ts` — sidebar action opens the native Recycle Bin and reports an IPC failure through `toastStore`.
- `src-tauri/src/system.rs` — `open_recycle_bin`: Linux launches an absolute Freedesktop `Trash/files` directory through `xdg-open` without dispatching `trash:///`; Windows and macOS retain their native shell launchers.
- FLOW: sidebar click → `openRecycleBinWithFeedback` → `open_recycle_bin` IPC → platform launcher; a terminal failure returns to the toast.

## Window tabs

- `domain/window-input.ts` — validates launch/warm/directory seeds and bounds storage parsing and producer serialization.
- `state/window-launch.ts` — fresh/warm launch coordination, destination-keyed seeds, created/error ownership, labelled failure diagnostics and late-child retirement.
- `state/window-handoff.ts` — correlated destination acknowledgement before source tab removal; late listener/timeout cleanup.
- `domain/window-launch-plan.ts` — pure query/cwd/home precedence and restoration policy.
- `state/window-session.ts` — page subscription/delayed-work ownership, rollback, and post-readiness warm priming; borrows window-scoped stores.
- `src/test-support/window-session-probe.ts` — opt-in page-owned native E2E dispatch and readiness with teardown-safe lazy imports/publication; native target, picker, unready and in-flight close fixtures cover rejected handoffs and duplicate-label creation ownership.
- `state/window-startup.ts` — owns settings → theme/readiness → plugins initialization; teardown revokes late startup.

- `state/repo-root-cache.svelte.ts` — bounded shared root probes for tab labels and Git warming, invalidated by existing file/Git buses.

- `components/WindowTabBar.svelte` — tab strip UI, drag-reorder, tear-off
- `state/window-tabs.svelte.ts` — `windowTabsManager`: tab list, layout, active pane, persistence orchestration; incarnation-bound transfer leases and native-close allocation guard
- `state/pane-sessions.ts` — reserves restored pane identities without opening inactive directories; activation materializes explorers, all removal paths share cleanup including SCM/commit/graph handoff stores
- `state/pane-activation.ts` — focused-first restoration with cancellable post-paint batches; `PaneLayoutView` leaves unmaterialized subtrees as placeholders without truncating saved layouts
- `state/pane-resize.ts` — coalesced divider drag lifetime; manager resize operations retain their original tab incarnation and `PaneContainer` remounts revived instances
- `state/window-tabs-persistence.ts` — save/restore tab sessions
- `state/closed-tabs.ts` — reopen-closed-tab stack
- `state/tab-transfer.ts` — drag tab across windows (`sendTabToWindow`, `initTabTransferListener`, screen-pos hit-test)
- `domain/tab-title.ts` — compute tab label from path
- `state/tab-display.svelte.ts` — tab title/icon derivation: git-root decoration, VS Code-style disambiguation, multi-pane joining
- `state/window-title.svelte.ts` — resolves launch-home context and synchronizes the OS window title with the active tab/pane directory
- `state/window-close.ts` — common titlebar, last-tab and native-close lifecycle; blocks transfer admission until destruction or recovery
- `state/window-chrome.ts` — native titlebar maximize observation with one in-flight read and owned late subscription cleanup
- `state/warm-activation.ts`, `state/warm-window.ts`, `api/warm-pool.ts`, `src-tauri/src/warm_pool.rs` — acknowledged warm-window activation, owned native reservations and expiring abandoned claims
- FLOW: each layout leaf identifies one pane session. `PaneLayoutView` keys its `ExplorerPane` by the owned explorer and injects it explicitly; the component captures it for the mount lifetime. Cross-window tab drag serializes a `TabSnapshot` via `sendTabToWindow` → listener claims it. Persistence via localStorage, validated before resource allocation.

## Workspaces & split panes

- `components/PaneContainer.svelte`, `components/PaneLayoutView.svelte`, `components/ExplorerPane.svelte` — pane tree render + focus
- `domain/pane-layout.ts` — binary split-tree ops and directional neighbor policy (`splitLeaf`, `removeLeaf`, `leafSiblingContext`, `paneInDirection`)
- `domain/pane-viewport.ts` → `state/pane-viewport.svelte.ts` — pure constrained canvas geometry and window-owned measurements shared by rendering, focus and dwindle; saved ratios remain preferences
- `composables/use-inline-panel-width.svelte.ts` — inline SCM/Miller mounts reserve tokenized width contributions; hidden/hoisted surfaces release them without changing saved layout
- `composables/use-pane-dividers.svelte.ts` — container-owned pointer/keyboard resizing, captured geometry and cancellation; `PaneContainer` locally reveals the active pane when the canvas overflows
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
- `domain/bookmark-drop-feedback.ts` — derives bookmark-drop feedback from the effective local or cross-window source kind.
- FLOW: pointer-drag sets `dragState` → drop-target computes destination → `performFileTransfer` → `moveEntry`/`copyEntry` (files.ts → file_ops.rs). Branch: `fix/multi-file-drag-ghost-opacity`.

## External drag/drop (OS ↔ app)

- `composables/use-external-drag.svelte.ts` — start OS drag-out of files
- `composables/use-external-drop.svelte.ts`, `use-native-drop-target.svelte.ts`, `use-native-drop-handler.ts` — accept OS file drops
- `api/activate.ts` — window focus/activate on drop
- FLOW: Tauri `dragDropEnabled: false` (in-webview HTML5 DnD); native drop handlers translate OS payload → file transfer. See MEMORY.md DnD notes.

## Copy / paste / file-ops & progress

- `state/clipboard.svelte.ts` — in-app cut/copy path set
- `state/paste-operations.ts` — paste orchestration (conflict, dest); explorer captures destination before clipboard waits and guards pane callbacks by navigation/lifetime.
- `state/pane-mutations.ts` — `createPaneMutations`: durable affected-parent/undo effects; navigation/lifetime-owned entry updates and exact editor-session completion
- Native history lifetime acceptance: `src/test-support/file-history-probe.ts` observes the production summary channel and dispatches real IPC; `src-tauri/test_support/file_history_gate.rs` holds accepted native work before filesystem execution only in opt-in recovery builds. `e2e-tauri/specs/file-history-lifetime.spec.ts` verifies actual shared inverse outcomes across windows; `e2e-tauri/specs/file-forward-history.spec.ts` verifies native rename history before renderer completion and accepted forward work after native window destruction.
- `src/test-support/file-mutation-probe.ts` — opt-in native hold between successful file IPC and renderer publication, with tokened release and teardown.
- `state/operations.svelte.ts` — `operationsManager`: tracked long ops, `formatBytes`
- `components/ProgressDialog.svelte`, `components/JobsPanel.svelte`, `state/jobs.svelte.ts` — progress UI
- `components/ConflictDialog.svelte`, `state/conflict-resolver.svelte.ts` — overwrite/rename prompts
- `api/files.ts` (copyEntry, moveEntry, estimateSize, checkPathsExist), `api/os-clipboard.ts`
- `domain/file.ts` (`FileMutationReceipt`) + `src-tauri/src/files/mutation.rs` — committed path separate from optional entry metadata; missing snapshots reconcile through the existing pane refresh.
- `src-tauri/src/file_mutation.rs` (`copy_inverse`) projects native ordinary-copy inverses from the physical `PublishedEntry`, not the receipt's alias spelling. `src-tauri/src/file_history/plan.rs` routes those observations through `files/trash.rs` (`trash_publication`); Linux selection preparation and execution verify parent and version. Restore reports a fresh native publication through `files/batch/model.rs`, bounded with trash artifacts, so `file_history/execution.rs` retains usable Undo after Redo recreates a parent. `src-tauri/test_support/file_history_publication.rs` exercises real copy/Undo/Redo and substitutions in an isolated subprocess. Ordinary frontend grouping still awaits the native batch-command migration.
- Their optional `recovery` describes destination publication with incomplete source cleanup. Transfer/paste/drop/plugin consumers publish the committed effects but cannot record a Move or Copy inverse; native history consumes an incomplete inverse without retry. `files/replacement.rs` retains displaced originals and refuses rollback collisions. Linux `e2e-tauri/specs/file-move-recovery.spec.ts` covers real cross-device cleanup refusal via tokened cut/paste probes.
- `src-tauri/src/files/publication.rs` — exclusive staging of new copy/write payloads and native atomic no-replace publication; destructive overwrite recovery and artifact identity remain separate transaction concerns.
- Explicit recovery requests: `src-tauri/src/files/recovery/commands.rs` binds asynchronous list/inspect/restore IPC to operation IDs and renderer sessions. `src-tauri/src/files/recovery/coordinator/inventory.rs` reads bounded private evidence; `src-tauri/src/files/recovery/service.rs` claims before user-volume inspection and reuses the native restoration executor, without advertising discard. Inventory/service contracts live in `src-tauri/test_support/recovery_inventory.rs` and `src-tauri/test_support/recovery_service.rs`. The existing `src/lib/api/file-recovery.ts`, `src/lib/domain/file-recovery.ts` and `src/lib/state/file-recovery.svelte.ts` carry lossless decimal counters. Subscription commands and deferred page-owned UI startup are registered; Linux native Inspect/Restore, post-restoration edits and acknowledged channel retirement across reload/destruction/crash have binary acceptance. Other platforms and pending initial IPC interruption remain open.
- Durable recovery (ADR 0020, integration incomplete): `src-tauri/src/files/recovery/mod.rs`, `src-tauri/src/files/recovery/journal.rs`, `src-tauri/src/files/recovery/model.rs`, `src-tauri/src/files/recovery/native_path.rs`, `src-tauri/src/files/recovery/storage.rs` and `src-tauri/src/files/recovery/locks.rs` provide bounded records/catalog and exact native ownership. `src-tauri/src/files/native_directory.rs` owns the platform directory boundary; `src-tauri/src/files/native_directory/unix.rs` shares anchored Unix access with Linux trash. The shared `src-tauri/src/files/recovery/file_lock.rs` guard uses Unix OS locks and `src-tauri/src/files/recovery/file_lock/windows.rs` byte-range locks while preserving readable nonce evidence; Windows runtime qualification remains open. Portable IPC/history contracts stay in `src-tauri/src/files/recovery/model.rs`; Unix executor authority lives in `src-tauri/src/files/recovery/durable_model.rs`. Unadmitted Windows recovery adapters compile in tests only. `src-tauri/src/files/object_id.rs` and `src-tauri/src/files/file_identity.rs` separate pure platform-tagged identity from handle capture; `src-tauri/src/files/entry_version.rs` shares rename-stable content/mode/ownership observations between recovery and trash; Windows capture preserves FileIdInfo's complete volume and file ID. These modules do not yet journal production replacements.
- Admission implementation (Linux entry commands wired): `src-tauri/src/files/recovery/coordinator.rs`, `src-tauri/src/files/recovery/resources.rs` and `src-tauri/src/files/recovery/context.rs` coordinate bounded read/write claims across processes, resolve missing-name conflicts through physical ancestor namespaces, and keep spawned mutation workers owning their reservation after caller teardown. SQLite namespace checks detect replacement within the ADR 0020 private-storage boundary.
- `src-tauri/src/files/recovery/coordinator/admission.rs` and `src-tauri/src/files/recovery/journal.rs` admit all independent children in one transaction, preserving separately promotable owners and unique generations. Aggregate grouped capture stays outside the gate and retries as a whole after managed changes. `src-tauri/test_support/recovery_batch_admission.rs` and `src-tauri/test_support/recovery_journal.rs` cover rollback, overflow/owner cleanup, independent promotion and process exit. Interactive copy requests use ordered per-child admission in `src-tauri/src/files/copy_session.rs`; speculative overlapping children are never prebound as independent work.
- Completed-operation ownership: `src-tauri/src/files/recovery/coordinator/claims.rs` supplies the same effective conflict index to ordinary admission and recovery claims. Idle error-free publication/restoration protects retained root/payload identities; active or incomplete work retains full authority. Claiming recovery checks its full resources against peers before acquiring the exact owner. `src-tauri/test_support/recovery_effective_claims.rs` and `src-tauri/test_support/recovery_effective_claims_adversarial.rs` cover physical aliases, process admission, corrupt evidence and successive restoration.
- `src-tauri/src/files/recovery/forward_copy/plan.rs` prepares every independent replacement against one atomic admission before exposing executable children. It binds exact physical paths and versions, shares durable-intent/manifest validation with promotion, and retires all children after preparation failure. `src-tauri/test_support/recovery_copy_plan.rs` covers real grouped effects/restoration and stale/cancelled preparation. Queued cancellation observed before promotion retires ownership without creating recovery artifacts; internal group execution retains receipts across later child panic; mixed transfer command integration remains outstanding.
- `src-tauri/src/files/batch/receipts.rs` shares ordered retained slots between deletion and replacement workers. `src-tauri/src/files/recovery/forward_copy/batch.rs` consumes prepared children, preserves confirmed receipts after a later panic/failure, retires the untouched suffix, and captures/deduplicates physical refresh before publication. Runtime single replacements use the same executor; post-execution inventory/refresh panics become bounded completion warnings. `src-tauri/test_support/recovery_copy_batch.rs` and `src-tauri/test_support/recovery_runtime.rs` cover partial effects, inverses, cancellation, cleanup errors and inventory failure. The ordered copy session now retains mixed ordinary/replacement outcomes outside its orchestration and settles one native history action.
- `src-tauri/src/files/worker.rs` provides explicit-context workers with a supervisor-owned whole-result cell. Production `file_mutation.rs` copy dispatch uses `CopyWork` and a bare function pointer, so the result reports before native context cleanup. Separate work/cleanup unwind boundaries preserve successful receipts and exact replacement history with warnings. `src-tauri/test_support/file_worker_completion.rs` and `src-tauri/test_support/file_mutation.rs` cover cleanup panic, blocked cleanup, aborted waiter, double-panic process survival and actual replacement restoration. Partial execution before a primitive returns still needs the grouped per-item ledger.
- Move ownership: `src-tauri/src/files/move_plan.rs` supplies both Linux recovery reservations and exact resolved source/target paths to `src-tauri/src/files/move_execution.rs`. Forward `file_mutation::move_entry` and the native history move adapter share that executor; physical refresh directories and cleanup warnings return to their existing outer owners. `src/lib/api/files.ts` consumes the session-fenced settled mutation reply. `src-tauri/test_support/file_move_recovery.rs` covers competing source/target reservations and alias binding. This is reservation integration; ordered move sessions, durable source parking and identity-bearing Move inverses remain open.
- Ordered copy sessions: `src/lib/state/copy-operations.ts` is lazily loaded by paste/drop copy paths and calls `src/lib/api/copy-session.ts` with `src/lib/domain/copy-session.ts` contracts. `src-tauri/src/files/copy_session.rs` + `src-tauri/src/files/copy_session/model.rs`, `src-tauri/src/files/copy_session/control.rs`, `src-tauri/src/files/copy_session/worker.rs` own a bounded ordered request, live conflict inspection, item/non-reused-nonce/renderer-fenced replies, one cancellation scope and external effect receipts. `file_mutation::copy_entries` settles one mixed ordinary/replacement inverse. Progress travels on the request channel with item identity; prompts occupy no blocking worker; Linux inspected versions bind anchored source reads, replacement admission and physical publication. Move-session migration remains open. Contracts: `src-tauri/test_support/copy_session.rs`, `src-tauri/test_support/file_history_publication.rs`, `tests/api/copy-session.test.ts`, `tests/state/copy-operations.test.ts`.
- Production copy: `src-tauri/src/file_mutation.rs` owns acknowledged copy command admission and history settlement. `src-tauri/src/files/file_ops.rs` keeps shared naming/progress and an owned task registration; Linux replacements use `src-tauri/src/files/recovery/forward_copy.rs` through the runtime's owned publication boundary. `src-tauri/test_support/recovery_forward_copy.rs` and `src-tauri/test_support/recovery_runtime.rs` cover actual effects, changed targets, aliases, waiter loss, panic and inventory failure. Legacy singleton receipts prevent ordinary Copy inverse recording for replacements in `src/lib/state/file-transfer.ts`. Paste/drop copies now use the lazy native session and its grouped ordinary/replacement history; move history remains renderer-owned. Overwrite Undo/Redo uses exact native replacement tokens; artifact retirement remains open.
- Windows directory/privacy primitives: `src-tauri/src/files/native_directory/windows.rs` uses retained handles for traversal, no-replace rename, removal and independent enumeration; `src-tauri/src/files/native_directory/windows_security.rs` applies protected descriptors during creation and validates explicit or inherited child policy through handles. Windows namespace durability, recovery caller integration and native runtime qualification remain open.
- Private recovery evidence: `src-tauri/src/files/recovery/private_storage.rs` and `src-tauri/src/files/recovery/private_storage/windows.rs` validate retained directory/file handles for coordinator, catalog and operation-owner callers. Catalog and owner logic compile on both platforms; their random names/nonces use the system RNG via `getrandom`. Whole-operation admission and Windows namespace durability remain unwired/unqualified.
- Replacement phase policy in `src-tauri/src/files/recovery/replacement_transition.rs` validates intent-before-effect progression independently of filesystem execution; `src-tauri/test_support/recovery_replacement_transition.rs` covers legal sequences, rejected skips and completed-retry error clearing. Journal checkpoints hold catalog digest plus mutable state; exact immutable catalog remains the authority for paths and claims.
- `src-tauri/src/files/recovery/replacement_artifact.rs` binds retained parent/root handles to the complete intent and publishes/verifies exact local manifests. `src-tauri/src/files/recovery/replacement_execution.rs` persists root/manifest/staging/displacement/publication/restoration intent before native effects; `src-tauri/test_support/recovery_replacement_artifact.rs` and `src-tauri/test_support/recovery_replacement_execution.rs` cover namespace substitution, evidence preservation and persisted ordering. `src-tauri/src/files/anchored_copy.rs` builds private payloads through directory handles with streamed entries, shared transfer buffer and captured source versions; `src-tauri/test_support/anchored_copy.rs` covers native copy contracts. `src-tauri/src/files/recovery/replacement_transfer.rs` retains the original and publishes the copy through no-replace renames; `src-tauri/src/files/recovery/rename_outcome.rs` classifies exact endpoints independently of syscall results. Their native/pure contracts live in `src-tauri/test_support/recovery_replacement_transfer.rs` and `src-tauri/test_support/recovery_rename_outcome.rs`. `src-tauri/src/files/recovery/replacement_restoration.rs` classifies exact restoration endpoints; `src-tauri/src/files/recovery/replacement_restore.rs` parks the copy before returning the original through no-replace native renames. Their contracts live in `src-tauri/test_support/recovery_replacement_restoration.rs` and `src-tauri/test_support/recovery_replacement_restore.rs`. `src-tauri/src/files/native_directory/permissions.rs` pins unreadable Linux copies for restoration and publication-retry permission preparation without revisiting their user path; `src-tauri/test_support/native_directory_permissions.rs` covers held-object substitution and procfs fallback. Forward production replacements use the shared runtime; artifact retirement remains pending. Explicit restore requests use the recovery service. `src-tauri/src/files/recovery/replacement_reapplication.rs` classifies retained-copy reapplication independently of the original source; the executor reuses native transfer and publishes a separate content revision. `src-tauri/test_support/recovery_replacement_reapplication.rs` and `src-tauri/test_support/recovery_reapplication_execution.rs` cover endpoint contracts, repeated transitions, atomic semantic history claims and subprocess death. Native Undo/Redo requests use `src-tauri/src/files/recovery/history.rs` to claim semantic history before invoking the executor; `src-tauri/test_support/file_history_replacement.rs` covers real native cycles, stale tokens, uncertainty and recovery retention independent of history eviction. Production receipts mint native-only Replacement actions; renderer replies carry display paths without recovery authority. Completion labels are covered by `tests/state/undo-helpers.test.ts`. Ordered mixed copy sessions now compose these tokens with ordinary-copy observations into one native batch inverse; move grouping remains pending.
- Durable promotion in `src-tauri/src/files/recovery/coordinator/promotion.rs` converts an exclusive reservation to a typed durable owner after catalog publication and SQLite kind-changing CAS; exact retries preserve evidence. `src-tauri/test_support/recovery_promotion.rs` covers interruptions, changed authority and worker cancellation. `src-tauri/src/files/recovery/coordinator/claim.rs` reacquires exact abandoned native locks and advances indexed checkpoints to a fresh generation; `src-tauri/test_support/recovery_claim.rs` covers competing/stale claims and damaged evidence, sharing `src-tauri/test_support/recovery_operation_fixture.rs` with promotion tests. Native transfer process-kill coverage claims and reopens the recorded root before completing transfers. Unindexed inspection, discard/retirement and production command integration remain pending.
- Catalog-only discovery in `src-tauri/src/files/recovery/coordinator.rs` opens existing app storage and its admission gate, validates immutable intent and returns no action capabilities; absent/corrupt SQLite and unavailable user volumes do not hide an intact catalog. `src-tauri/src/files/recovery/durable_model.rs` checks semantic roles, complete artifact ancestry, distinct identities, phase evidence and opened manifest roots; `src-tauri/src/files/recovery/native_path.rs` rejects other operating systems and oversized/malformed paths. Explicit native inspection and restoration use fresh coordinator claims through `src-tauri/src/files/recovery/service.rs` and `src-tauri/src/files/recovery/commands.rs`.
- `src-tauri/src/files/worker.rs` and `files/batch/mod.rs` share work-before-owner destruction for pooled and dedicated workers. Dedicated completion follows capture cleanup; unattributed cleanup failures propagate through `files/batch/model.rs`, `file_history/execution.rs`, `file_mutation.rs` and `domain/file-batch-outcome.ts`, preserving confirmed receipts and consuming uncertain inverse work. Linux entry commands carry actual recovery context; remaining mutation roots still need admission wiring.
- Recovery UI: `src/lib/domain/file-recovery.ts`, `src/lib/api/file-recovery.ts`, `src/lib/state/file-recovery.svelte.ts`, `src/lib/components/FileRecoveryDialog.svelte` and `src/lib/components/FileRecoveryNotice.svelte` keep inspection and choices revision-ordered with explicit discard confirmation. The lazy `src/lib/state/file-recovery-session.svelte.ts` is owned by `src/lib/state/window-session.ts`; foreground readiness or explicit command demand starts it, with parked windows waiting for successful activation. `e2e/file-recovery.spec.ts` covers responsive inspection/restoration display, hidden-status-bar access, errored initial navigation, chunk failures and focus across delayed actions. Linux native restoration and acknowledged-subscription lifetime acceptance are covered below; interrupted IPC and forward replacement integration remain required.
- Native recovery acceptance: `src-tauri/test_support/file_recovery_native.rs` seeds real durable replacements and observes actual Channel destruction with native registration IDs. `src/test-support/file-recovery-probe.ts` exposes tokened raw IPC leases; `e2e-tauri/specs/file-recovery.spec.ts` verifies restored filesystem payloads, renderer reload/destruction, stale-session rejection and delivery of fresh durable generations.
- `src-tauri/test_support/file_recovery_crash.rs` extends the retained GTK WebView controller in `src-tauri/test_support/renderer_recovery.rs`; `e2e-tauri/renderer-recovery.ts` kills two exact renderer processes and requires native recovery-channel release before reload and fresh IPC delivery afterward.
- `src-tauri/src/files/file_ops.rs` (copy/move/create), `src-tauri/src/progress.rs`, `src-tauri/src/clipboard.rs`
- FLOW: paste → estimate → conflict check → invoke copy with progress events → operationsManager updates ProgressDialog; on done `broadcastFileChange` + refresh.

## Rename flows

- `composables/use-inline-rename.svelte.ts` — inline edit field lifecycle
- `components/EntryName.svelte` — name label + inline rename input
- `components/BulkRenameDialog.svelte` — multi-file pattern rename
- `components/InlineNewFolder.svelte` — inline new-entry create (folder or file, per `explorer.newEntryKind`; #436)
- `state/rename-suggestion.svelte.ts`, `domain/ai-rename.ts`, `api/ai-rename.ts` — AI rename suggestions
- `api/files.ts` (renameEntry, createDirectory, createEmptyFile), `api/file-mutations.ts`, `src-tauri/src/file_mutation.rs` — native forward admission and settled history receipts; reusable filesystem primitives remain in `files/file_ops.rs`.
- FLOW: inline-rename commits → `renameEntry` → pane-mutations renames entry + `renameThumbnailCache` so thumb doesn't flash.
- New-entry FLOW: context menu / `file.newFolder`|`file.newFile` command → `explorer.startInlineNewFolder`|`startInlineNewFile` (opens an independently owned creation session) → InlineNewFolder row → `createFolder`|`createFile` → pane-mutations optimistic add + `broadcastFileChange`.

## Delete / trash / undo

- `components/DeleteDialog.svelte` — confirms explicit permanent deletion and explains mixed local/UNC disposition.
- `state/pane-mutations.ts` — submits one native deletion intent; removes only confirmed rows and reconciles confirmed/uncertain parents.
- `domain/file-history.ts`, `api/file-history.ts`, `api/native-resource-session.ts` — typed native history requests and ordered revisioned summary channel on the existing renderer acknowledgement.
- `state/undo.svelte.ts` — window projection captures expected native entry IDs, including the exact receipt of already queued local writes.
- `state/undo-helpers.ts` — action labels.
- `src-tauri/src/file_history/mod.rs`, `file_history/model.rs` — native admission and execution survive invoking renderer closure; shared entries settle surviving participants once.
- `src-tauri/src/file_history/forward.rs`, `src-tauri/src/file_mutation.rs`, `api/file-mutations.ts` — accepted create/rename/new-text/symlink and whole-selection deletion work settles native history before IPC results; forward and inverse slots preserve admission order across out-of-order completions. Other forward batches still require migration.
- `src-tauri/src/files/entry_plan.rs`, `src-tauri/src/files/file_ops.rs` — one owned plan supplies simple-entry command targets, refresh parents and rename history names; the filesystem worker rechecks collisions and consumes that exact request. Linux commands lazily admit through `src-tauri/src/files/recovery/runtime.rs`, execute captured paths and retain traversed parent-alias reads through publication. Other platforms and operation roots remain pending.
- `src-tauri/src/file_history/action.rs`, `file_history/execution.rs` — host capability normalization, affected parents and ordered partial inverse receipts.
- `src-tauri/src/file_history/plan.rs` — fixes inverse direction, paths and exact restore receipts before dispatch; invalid leaves remain in execution order, and panic refresh uses planned parents. Move execution and refresh derive the original parent from `source_path`, ignoring redundant legacy metadata. Recovery resource/admission wiring remains pending.
- `src-tauri/src/file_history/retention.rs` — shared final recovery budget includes entry overhead, grouped paths and opaque receipts; partial settlement preserves remaining work first and reports dropped inverse recovery.
- `src-tauri/src/diagnostics.rs` — shared bounded diagnostics for history and copy execution; completion warnings do not stop dependent batches; bounds and ordering are covered by `src-tauri/test_support/diagnostics.rs`. Only actual execution failures stop subsequent effects; the frontend presents warnings separately from errors.
- `api/mock-file-history.ts`, `api/mock-file-history-execution.ts` — browser-only history simulation, never native acceptance evidence.
- `domain/file-batch-outcome.ts`, `api/files.ts` — typed `succeeded`/`failed`/`uncertain`/`unstarted` receipts for `deleteEntries`; trash restore is native inverse work.
- `src-tauri/src/files/batch/mod.rs`, `files/batch/model.rs` — bounded, stable selection admission and worker-independent progress; pooled and dedicated workers share read-only setup/execution/cleanup handling, confirmed siblings survive a panic, uncertain work stops later attempts. Linux trash uses one pooled job for context construction and the whole selection; recovery reservation integration remains open.
- `src-tauri/src/files/trash.rs`, `files/trash_artifact.rs` — native exact deletion receipts and restore requests; known UNC removal carries a permanent-deletion warning. No inverse selects trash by original path or timestamp.
- `src-tauri/src/files/freedesktop_trash.rs`, `files/trash_mounts.rs` — Linux mount-aware trash placement, exclusive metadata publication and descriptor-relative no-replace moves with captured identity verification.
- `src-tauri/src/files/freedesktop_trash/plan.rs` — prepare exact source, payload, final/staged metadata and directory actions without mutation; mounted trash predeclares its personal fallback. Execution preserves those names and verifies object/mount identity, while safe first-use directory sharing does not introduce unplanned permission repair. Whole-selection reservation and durable artifact promotion remain open.
- `src-tauri/src/files/freedesktop_trash/selection.rs` — observes every selected source/alias before destination planning; shares exact layouts and bounds/indexes all candidates before running aligned item plans. `src-tauri/src/files/recovery/resources.rs` supplies the shared role-aware namespace policy. Recovery reservation and durable promotion remain open.
- `src-tauri/src/files/restore_parents.rs` — recreate Linux restore parents with conservative directory effects in the external batch ledger; native history carries them to refresh publication even when the requested leaf remains uncompleted.
- `src-tauri/src/files/windows_restore.rs`, `files/restore_outcome.rs`, `files/trash_outcome.rs` — Windows STA delete/restore with exact Shell receipt capture, source-verified completion and pure outcome classification.
- `src-tauri/src/files/windows_paths.rs` — ordinal DOS/UNC alias comparison and bounded component-aware batch validation, shared with native Shell source/destination verification.
- FLOW: delete → native whole-selection admission → per-path execution → native inverse for confirmed recoverable successes → settled reply → view reconciliation. Ctrl+Z reserves the exact history entry; uncertain paths are consumed, completed paths move to redo, failed/unstarted paths remain retryable (ADRs 0017/0018).

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

- `state/preview-lifetime.ts` — revision tokens and blob ownership across text/image/archive/directory/video loads and unmount.

- `components/PreviewPane.svelte` — text/image/diff/archive/CSV preview + syntax highlight; CSV uses shared column sizing, a single outer horizontal scroll surface, and virtualized data rows; shared controlled resize (width at right, height at top/bottom); pointer capture, dock-aware keyboard bounds and fullscreen retirement; reads `settingsStore.resolvedPreviewPanePosition` (never the raw mode) for its own dock class
- `domain/preview-size.ts` — resolved dock selects the raw dimension setting and bounded resize options; zero decodes only at the source.
- `domain/preview-pane-position.ts` — pure dock-position validate/cycle (right/bottom/top, #460); `+page.svelte` column-stacks the pane for top/bottom. Also: `PreviewPanePositionMode` ("auto" | right/bottom/top), `resolveAutoDockPosition(width, height)` (aspect-ratio heuristic: wide → right, narrow-tall → top, else bottom) and `resolveEffectivePreviewPanePosition(mode, width, height)` (#467)
- `state/window-size.svelte.ts` — reactive `window.innerWidth/innerHeight` (`windowSizeStore`); `+page.svelte` syncs it on mount + `resize`. Feeds `settingsStore.resolvedPreviewPanePosition` for auto-dock (#467)
- `state/settings.svelte.ts` — `previewPanePosition` (raw stored mode, may be "auto") vs `resolvedPreviewPanePosition` (concrete right/bottom/top, the one layout code reads; #467)
- `domain/syntax-highlight.ts` — `highlightCode`, `highlightDiffLine` (hljs)
- `domain/csv-preview.ts` — quoted CSV table parser; malformed input leaves PreviewPane on its existing text path (#666)
- `domain/diff.ts`, `domain/markdown.ts` — diff parsing, markdown render
- `api/files.ts` (readTextFile, readImageAsBlobUrl, listArchiveContents, gitDiff)
- `themes/syntax.css` — shared hljs token colors
- FLOW: selection change → PreviewPane fetches content by type → CSV parses to a shared-column virtual table or text highlights/renders. 512KB read cap, 200 CSV data-row cap, 50KB highlight cap.

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
- FLOW: `git-status-changed` (git_watch.rs emit) + `directory-changed` → gitStatusStore.refresh → badges re-derive; gated on `settings.showGitStatus`. For `\\wsl.localhost\…` dirs the badge path (`get_git_status`) delegates rev-parse+status to the distro's native git via `wsl.exe --exec` instead of shelling Git-for-Windows over 9P (#425); `gitStatusStore` dedups concurrent identical fetches (#426).

## Git SCM panel

- `components/ScmSidebarView.svelte` — staged/unstaged/untracked tree, commit box
- `components/ScmPanel.svelte`, `components/ScmDiffView.svelte` — panel shell + inline diff. ScmPanel renders docked/flat by default (like the miller bar); `island` prop opts into floating-island chrome (#434) — vibrancy alone no longer floats it.
- `components/GitGraphView.svelte` — commit graph / log; its filter popover
  carries an ephemeral file-path query through `state/git-graph-cache.ts` to
  `git_log`, so pagination filters the complete history instead of only rows
  already loaded in the browser (#529)
- `state/scm.svelte.ts` — per-pane stores via `getScmStore(paneId)` (#334): repo state, stage/commit actions; shared summary cache + `warmScmSummary`
- SCM activation uses `api/git.ts` → `git_directory_scope` in `src-tauri/src/git.rs` to resolve the requested directory's physical repository-relative location. Display aliases stay in the pane; filtering and shared summaries use the repository identity. Late scope replies follow the store's existing path generation.
- `state/git-summary-cache.ts` — shared per-repo `git_status` fetch (in-flight dedup + short TTL, #431): SCM `refreshSummary` (force), GitGraphView `fetchPage0Snapshot` + uncommitted-row selection route through it, so one `git-status-changed` is one working-tree scan, not several
- panel VISIBILITY is also per-pane (#434): `window-tabs.svelte.ts` `getPaneScmVisible`/`toggleScmInActivePane` on the pane node (falls back to the global `showScmPanel` default); the `view.toggleScmPanel` command (`view-commands.ts`) acts on the active pane only
- `domain/git-network-operation.ts`, `state/git-graph-refresh.ts` — F5 refresh bus plus importable `createReloader` concurrency state machine, local-change filter, real-commit paging counter, and shared network-operation phase state: GitGraphView registers its fetch+reload per pane; `gitGraph.refresh` dispatches to the active graph pane, while a per-pull IPC channel removes cancellation once protected local fast-forward begins and fails closed if that transition cannot be delivered (#432, #444, #528)
- `state/git-graph-nav.ts` — branch-line jump bus (#530): GitGraphView registers a per-pane selection stepper; `gitGraph.selectOlderOnLine` (Ctrl+Down) / `gitGraph.selectNewerOnLine` (Ctrl+Up) dispatch to the active graph pane. Row math is pure: `stepOnBranchLine` in `domain/git-graph.ts` follows `parents[0]` down and the nearest first-parent child up, so a jump steps over interleaved rows from other branch lines
- `state/git-palette.ts` — active-pane bridge from GitGraphView's current local branches, commits, and stashes to fuzzy command-palette targets (#520); checkout/merge/cherry-pick/rebase/stash actions reuse the graph action seam and a commit target selects/reveals its row. Commit targets are capped at the 50 most-recent loaded rows because CommandPalette is unvirtualized; ephemeral targets do not enter frecency.
- `domain/git-graph-undo.ts`, `state/git-graph-undo.ts` — bounded repository-scoped session ledger + active-pane Ctrl+Z request bus (#513). Successful branch/tag delete, branch rename, merge, and pull commands return immutable backend snapshots; confirmation consumes the latest matching entry, while Rust rechecks absent/exact refs or unchanged HEAD + clean worktree immediately before the inverse.
- `state/git-graph-file-history.ts` — SCM file-history handoff (#518): opens the owning pane's graph and sends its repository-relative file path straight to a matching mounted graph or buffers it through a keyed repo remount; pending paths are dropped when panes close
- `state/git-graph-component.ts` — caches the dynamically imported graph constructor; first opening loads the feature, later mounts render synchronously from the resolved constructor.
- `state/git-commit-files-cache.ts` — importable bounded commit-file LRU used by graph detail loads; working-tree and comparison diffs retain their separate paths.
- `state/git-graph-cache.ts` — bounded per-repo graph snapshot cache + `warmGraphSnapshot`/`fetchPage0Snapshot`; immutable payload ingress and resolved walk metadata preserve cached pagination. Retains the supported 12-tab graph fan-out for remounts; watcher changes invalidate writers and snapshots (#433, #505).
- `state/git-graph-query.svelte.ts` — mounted graph history/page owner using the existing reloader; partial log paint precedes summary, stale query/append cleanup cannot overwrite replacements, complete page zero alone enters the shared cache.
- `src/lib/state/git-graph-detail.svelte.ts` — Commit/comparison selection, current working-tree refresh and staged/unstaged inline diffs.
- `state/git-pr-session.svelte.ts` — same-repository badge refresh, PR checks and CI logs use invocation identity and immutable payloads; close/reopen and disposal revoke stale completion.
- `state/git-graph-branches.svelte.ts` — query/popover branch metadata requests coordinate current coverage; cold failure cannot silently cache an unfiltered graph under hide-remote-only, known coverage survives later failures.
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

- `domain/window-keys.ts`, `state/window-keyboard.ts` — window-key policy and owned subscriptions; main file-list entries route Open/Preview commands while ordinary/Miller buttons retain Enter/Space; accepted local file-list/custom-control keys retire chords, and terminal exceptions retain their exact command identity through dispatch. `domain/terminal-keys.ts` resolves that identity for both xterm and window routing.
- `state/deferred-focus.ts`, `state/terminal.svelte.ts` — cancellable terminal-opening focus across lazy loading; new interactions retire obsolete focus requests while queued insertions still arrive.
- `+page.svelte` — composes the window keyboard owner with active explorer and surface commands
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
- `domain/settings-numbers.ts` — Numeric preference consumer contracts shared by persisted validation and interactive setters.
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
- `domain/resize-size.ts` → `state/scalar-resize.ts` → `composables/use-resize-owner.svelte.ts` — bounded scalar drafts with captured axis/scale, frame identity and shared DOM lifetime; `state/panel-resize.ts` + `composables/use-panel-resize.svelte.ts` adapt fixed/automatic localStorage widths, while `composables/use-controlled-size.svelte.ts` adapts Terminal/Preview settings and keyed Details sizes with final-only persistence, source supersession and conditional post-teardown finalization
- `state/resize-activity.svelte.ts` — owns active panel gesture leases so geometry updates cannot trigger automatic reveal and cancel the resize that caused them
- `components/PanelResizeHandle.svelte` — shared Sidebar/SCM/Miller keyboard/pointer separator
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
- `src/test-support/lazy-dialog-lifetime.svelte.ts` — browser-only effect-lifetime fixture imported by E2E; absent from the production import graph.
- `components/WindowDialogs.svelte`, `composables/use-lazy-dialog.svelte.ts`, `state/lazy-dialog.svelte.ts` — typed lazy constructors with independent demand, one pending import per host/dialog, retained success and teardown-safe publication. The host includes plugin dialogs and portal feedback.
- `domain/lazy-dialog.ts` — shared failure containment and mount-crash recovery; the host wraps each dialog in `<svelte:boundary>`. Active failures roll back modal ownership and notify; cancelled requests and destroyed hosts cannot publish stale feedback.
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

- `state/owned-registry.ts` — invocation identity and duplicate policy shared by command, menu, dialog and filesystem contributions.
- `state/modal-ownership.svelte.ts` — contributed dialogs and shared Modal participate in the same input gate as built-in dialogs.

- `plugins/registry.svelte.ts` — `pluginRegistry` owns activation, retry and shutdown completion; context retirement precedes reentrant hooks
- `plugins/api.ts` — `Plugin`/`PluginContext` contract (storage, jobs, toast, settings)
- `state/plugin-jobs.ts`, `api/plugin-jobs.ts` — window-owned accepted job/event reconciliation and typed IPC; plugin disable removes contributions while accepted work retains its owner.
- `plugins/dialog-registry.svelte.ts`, `settings-registry.svelte.ts`, `fs-providers.ts` — extension points
- built-ins: `plugins/ai-organize/`, `ai-rename/`, `nano-banana/`, `theme-from-image/`, `upscale/`, `demo/`
- backend: `src-tauri/src/ai_organize.rs`, `ai_rename.rs`, `nano_banana.rs`, `gemini.rs`, `upscale.rs`, `fal.rs`, `plugin_job.rs` (shared job scaffolding: id alloc, output-path validation, timeout, complete/error events)
- shared UI: `plugins/plugin-dialog.css` (dialog chrome), `domain/available-filename.ts` (collision-free output name)
- FLOW: plugins register commands/settings/dialogs via PluginContext at startup; AI actions invoke Gemini-backed Rust commands (upscale invokes fal.ai's SeedVR2 queue API via `fal.rs`).

## Terminal panel

- `state/terminal-session.ts` — frontend resource owner for reserve/listen/spawn/kill; late completions drain before restart/disposal.

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
- **Key event names**: `directory-changed` (fs_watcher.rs → use-file-watchers.ts → refresh), `git-status-changed` (git_watch.rs → git-status.svelte.ts). Cross-window: BroadcastChannel `explorer-file-changes` (file-events.ts) and `explorer-drag-data` in localStorage (drag.svelte.ts).
- **Persistence**: UI/prefs via `state/persisted.ts` (localStorage: settings, keybindings, bookmarks, recent, tabs, drag). Durable config via `api/config.ts` → `config.rs` JSON files.
- **Cancellable backend tasks**: `src-tauri/src/task_registry.rs` — search/listing/copy/compress use cancel_* commands.
- **Warm pool**: pre-spawned windows (`warm_pool.rs` + `state/warm-window.ts`) for instant new window/tab.
- **Rule**: display features must update all three views (DetailsView/ListView/TilesView) via FileList.svelte.

Recovery delivery: `src-tauri/src/files/recovery/subscriptions.rs` owns exact-renderer channel lifetimes and monotonic client-token ordering; `src-tauri/src/files/recovery/runtime.rs` publishes list/inspect/resolve results from owned workers. `src-tauri/test_support/recovery_subscriptions.rs` and `src-tauri/test_support/recovery_runtime.rs` cover reordered release, cancellation, capacity and native publication. `src/lib/api/file-recovery.ts` retains token ordering and callback fences across JS module reloads; `src/lib/domain/file-recovery.ts` preserves inspected presentation only for unchanged pending generations. The page-session recovery UI is connected through `src/lib/state/file-recovery-session.svelte.ts`; unit ownership contracts are in `tests/state/file-recovery-session.test.ts`.

Planned move journal authority: `src-tauri/src/files/recovery/move_model.rs` owns the immutable resource/volume/artifact contract. `src-tauri/src/files/recovery/coordinator.rs` preserves planned records on reopen and rejects them from copy history execution; executable durable moves remain deferred in #685.

## Native release qualification

- `src-tauri/build.rs`, `src-tauri/windows-app-manifest.xml` — shared app/test Windows activation manifest; MSVC linker embedding prevents test harness loader failures before native contracts run.

- `e2e-tauri/native-qualification.ts` owns bounded process cleanup, binary identity, reports and native-ready/warm log parsing; `e2e-tauri/native-process-group.ts` retains Linux session descendants after the driver exits. `scripts/build-native-qualification.ts`, `scripts/qualify-macos-startup.ts` and `scripts/run-native-soak.ts` compose debug/release builds, separate Mac foreground-only/warm measurements and opt-in soak; `e2e-tauri/wdio.soak.conf.ts` selects `e2e-tauri/soak/native-soak.spec.ts`. Process/report contracts live in `tests/qualification/`. Native log timings do not establish presented-frame, Dock-bounce or first-input latency.
