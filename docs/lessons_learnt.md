# Lessons Learnt

Gotchas, non-obvious behaviors, and key takeaways from closed issues.

---

## refactor/scm-as-its-own-activity-bar-panel-under-alt-m-g (#74): Two new chorded view-focus commands

**Key takeaways:**
- The activity-bar already had `files` and `scm` as separate `SIDEBAR_VIEWS`, but no keybinding switched between them — `Alt+M B` only toggled sidebar visibility. Splitting that into two new commands (`view.focusFilesSidebar` on Alt+M B, `view.focusScmSidebar` on Alt+M G) preserves toggle behaviour for users who want it (still available as the unbound `view.toggleSidebar`) while giving each view its own chord.
- Both commands ensure the sidebar is visible before flipping the active view, so a single chord reliably surfaces the panel even from a hidden state.

---

## feat/scm-tree-view-group-files-by-folder (#76): Snippet-based recursion

**Key takeaways:**
- Svelte 5 `{#snippet}` recursion is a clean way to render the SCM tree without an extra component file. The `treeNode` snippet recurses on `node.children` and renders folder rows + file rows side-by-side. Indent is computed via inline `padding-left: depth * 12` to keep the grid templates simple.
- Collapse state lives in a single `Set<string>` keyed by full directory path. Toggling clones the set rather than mutating in-place so Svelte's reactivity tracks the change.

---

## feat/scm-ignore-button-add-entry-to-gitignore (#77): Idempotent append in Rust

**Key takeaways:**
- `git_add_to_gitignore` reads `.gitignore` (treating "missing" as empty), checks for an existing exact-line match, and only appends when the entry is new — duplicate clicks are safe. The path is normalised relative to repo root (strips leading `./` and `/`) so the entry lands as expected when the user clicked a nested file.
- The button is only rendered for untracked rows because tracked changes can't be ignored without `git rm --cached` first; that's out of scope here.

---

## feat/scm-commit-button-enabled-with-empty-message (#79): Affordance follow-up

**Key takeaways:**
- The amend-no-edit behaviour landed with #78. The remaining bit was telling the user it's available — the placeholder now reads "leave empty + Enter to amend the previous commit" whenever there are staged files but the message is empty. Surface affordance live near where the user is about to act, not in a separate help panel.

---

## feat/scm-ctrl-enter-on-empty-message-does-amend-commit (and #79): Implicit amend-no-edit

**Key takeaways:**
- The Rust `git_commit` command already supports `amend=true` with an empty message — it falls back to the parent commit's message. The frontend was over-restricting the message-empty case. The fix: derive an `effectiveAmend` flag inside `scmStore.commit()` so any empty-message-with-staged-files invocation routes to amend automatically. Both Ctrl+Enter and the commit button benefit.
- The button label/tooltip needs three modes: `commit`, `amend` (toggle on), `amend-no-edit` (empty msg + staged). Splitting the derivation into `commitMode` keeps the conditional sprawl out of the template.

---

## fix/scm-file-row-expands-to-two-lines-on-hover: Two grid items in the same column collide

**Key takeaways:**
- Both `.file-dir` and `.row-actions` were being placed in the third grid column, but `.file-dir` had no explicit `grid-column` so it auto-flowed to col 3, while `.row-actions` declared `grid-column: 3`. Once `.row-actions` flipped from `display: none` to `flex` on hover, the implicit auto-row added a second row to fit both. Pinning `.file-dir` to the same column and toggling visibility (one in, the other out) keeps the row at a fixed height.

---

## feat/scm-confirmation-for-remove-restore: Same backend, different copy

**Key takeaways:**
- `gitDiscard` already routes untracked entries to filesystem `remove_file` (see `git.rs::git_discard`). The SCM panel only had a Discard button on tracked rows, so the disk-deletion behaviour was reachable but never exposed. Adding the same button to untracked rows surfaces the existing semantics — the only thing that needed to differ is the confirmation copy ("permanently deleted from disk" vs "changes reverted").
- Default-focusing the Cancel button on a destructive confirmation is a small but important accessibility detail; we focus it via `queueMicrotask` after rendering rather than relying on autofocus (which trips a lint rule).

---

## chore/improve-preview-pane-and-progress-dialog-screenshots (#82): Mock parity unlocks UI verification

**Key takeaways:**
- The SCM Ignore button shipped with no `git_add_to_gitignore` mock in `mock-invoke.ts`, so the agent-browser run that verified the button had to surface a real failure ("Unknown command"). The fix was a one-liner mock plus a `mockGitignored` set that filters subsequent `git_status` responses, so clicking Ignore now actually removes the row in dev/E2E. Treat mock-invoke parity as part of the feature when adding new Tauri commands.
- The Operations Manager's progress dialog can be driven directly from the devtools console (`operationsManager.startOperation(...)` + `updateProgress`) for screenshots/E2E. Worth remembering: not every UI surface needs a real backend trigger — store-level public methods are usable directly.

---

## fix/delete-confirm-reads-cleared-dialog-state (#80): Fire-and-forget needs captured args

**Key takeaways:**
- When you dismiss a dialog before kicking off the async work it represents, any path that reads dialog state inside the work is racing against the close. The right shape is: capture the inputs into local variables before closing, then pass them as arguments to the async callee. Reading from a store after the source modal has been torn down is the same class of bug as the cancellation tracking from issue #61.
- This was caught by an actual screenshot run: the merged #71 fix shipped with a placeholder screenshot, and the bug stayed invisible until the live capture surfaced "Delete failed: No entries selected for delete". Always run the UI for behavioural fixes.

---

## fix/delete-modal-lingers-move-progress-to-toast: Confirm closes the modal, work runs in background

**Key takeaways:**
- The dialog used to await `confirmDelete()` before closing, leaving it on screen for the duration of the actual delete (which can be ~1s for trash even on small files because of the system bus call). Closing the modal first and firing the async work as `void confirmDelete().then(...)` removes the lingering UI without changing the underlying delete logic.
- We surface progress and success/error via the existing `toastStore` (an info toast for ≥multi or directory deletes, success or error toast on settle). This is cleaner than re-opening the modal on error and removes the need for `deleting`/spinner state inside the dialog.

---

## fix/cut-indicator-persists-after-cross-tab-paste: Refresh broadcasts must reach inactive tabs

**Key takeaways:**
- The `directory-changed` and cross-window file-change handlers in `+page.svelte` only walked the active tab's left/right panes (`windowTabsManager.getExplorer(paneId)`). Other tabs in the same window held their own explorer instances watching their own paths but were never refreshed, so a paste in tab B left tab A's listing (and any cut indicator on the source row) stale.
- Adding `windowTabsManager.getAllExplorers()` and iterating it in both handlers fixes the cross-tab refresh path. The clipboard already broadcasts `null` after a cut-take, so once the source listing refreshes, the indicator naturally drops.

---

## investigate/preview-renders-faster-than-thumbnails (issue #69): Different pipelines, not a bug

**Question:** Why does the preview pane sometimes paint before the file-list thumbnail for the same image?

**Findings:**
- `PreviewPane` shows images via `convertFileSrc(path)` — a URL into the Tauri webview's asset protocol. The browser fetches and decodes the raw file natively. No Rust image processing on the hot path.
- `ThumbnailImage` calls `getMicroThumbnail` then `getThumbnailData` in `src-tauri/src/thumbnails.rs`, which decode → resize → re-encode → write a cache file → return the cache path. The browser then fetches that smaller file. On a cold cache, the Rust pipeline is strictly slower than the preview's "decode the original" path.
- Thumbnails are also gated by two semaphores (`microPool` cap 8, `fullPool` cap 4) for back-pressure on large grids. A late-mounted ThumbnailImage can wait behind queued peers; the preview pane has no such queue.

**Decision:** Not a bug. The thumbnail pipeline is deliberately heavier so the cached output is small and crisp at micro sizes (essential for tile grids with many images). The preview pane is the privileged "show one big image fast" path. We are not adding instrumentation or rerouting preview through the thumbnail cache — that would slow the common case. If we ever want preview ↔ thumbnail to share work, the right place is letting `getThumbnailData` short-circuit to `convertFileSrc` for full-size requests on small files.

---

## fix/cached-previews-update-when-file-changes: Bust mtime through both layers

**Key takeaways:**
- Two caches were hiding stale content: a path-keyed early-return inside `PreviewPane`, and the webview's URL-keyed cache for `convertFileSrc` output. Both needed to incorporate the FileEntry's `modified` (and `size`) so an external edit produces a fresh fetch.
- Changing the early-return to a composite `previewKey = path|modified|size` works because the explorer pane already refreshes entries on `directory-changed` events — the entry handed to PreviewPane therefore updates without any extra wiring on this side.

---

## feat/manual-hide-via-right-click-context-menu: Per-folder hide list piggybacks the dotfile dim

**Key takeaways:**
- Manually-hidden state is stored per-folder (`{folderPath: [name, ...]}`) and serialised through the same persisted-write-through pattern as bookmarks. The reveal toggle (`showManuallyHidden`) keeps the list separate from the existing dotfile filter (`showHidden`).
- All three views (`FileItem`, `ListView`, `TilesView`) need parity: hidden-entry styling existed only in `FileItem`. Issue #67 added it to the other two with the same `.hidden-entry { opacity: 0.55 }` rule. Mirroring view-mode behaviour stays a recurring trap (see project memory).

---

## feat/command-palette-sort-modifiers: piggyback existing toggle semantics

**Key takeaways:**
- `explorer.setSorting(field)` already toggles ascending/descending when called repeatedly with the same field. Wiring command palette entries straight to that means a second invocation flips direction without needing dedicated asc/desc commands. Adding "type" required only a new `SortField` branch in `sortEntries` (lex on extension, fall back to name).

---

## fix/recent-folders-list-shows-non-existent-paths: Lazy prune in the consumer

**Key takeaways:**
- The frecency/recent stores already had `pruneNonExistent`, but it was only called from QuickOpen — the sidebar's recents list never triggered it. Pruning belongs to the consumer surface, fired on a deferred `onMount` timer (so it doesn't compete with first-paint stat I/O) and on `visibilitychange` so externally-deleted paths clear up when the user tabs back to the window.

---

## fix/sidebar-removable-drives-update-on-eject: Watch the mount-base, not just poll

**Key takeaways:**
- Polling `list_drives` was the only refresh path and ran every 5s. Eject/insert latency was a function of the poll interval. Subscribing the drives store to the existing `directory-changed` fs-watcher event for the platform's mount-base directories (`/run/media/$USER`, `/media/$USER`, `/Volumes`) drops detection latency to roughly the OS notify granularity.
- We kept polling as a backstop because not every mount-base is guaranteed to exist (refused or absent), but tightened the interval to 1.5s so the watcher and the poll together comfortably hit the ~1s acceptance.

---

## feat/hide-empty-folders-in-miller-view: emptiness probe must respect the visibility rule

**Key takeaways:**
- Whether a folder counts as "empty" for the miller filter depends on `showHidden` — a folder containing only dotfiles is empty if hidden files are off, non-empty if they're on. The Rust `is_directory_empty` command takes `include_hidden` so the answer is computed once on the same rule the UI uses to display children.
- Probes are batched per column load and the `path -> isEmpty` cache is invalidated whenever `showHidden` flips, so toggling either preference produces consistent results without stale data.

---

## fix/rename-input-font-size-larger-than-file-row-font: `font: inherit` does not protect against later overrides

**Key takeaways:**
- ListView/TilesView's inline `.rename-input` started with `font: inherit` (good — picks up the row's 13px) but then explicitly set `font-size: var(--font-size-body)` (14px), reintroducing the mismatch. When mirroring a label's font into an input, hard-pin the size to match the label, not to a global token that may diverge.

---

## fix/multifile-progress-dialog-persists-after-cancel: Cancellation must dismiss UI separately from worker abort

**Key takeaways:**
- Marking an `Operation` as `"cancelled"` only stops the worker loop — the dialog row stays visible until something filters it out. Treat "remove from UI" and "signal cancellation to worker" as two responsibilities. We solved this by tracking `cancelledIds` in a separate `Set` so workers can keep polling `isOperationCancelled` after the row is removed from the visible list.

---

## fix/miller-folders-external-refresh: Cache invalidation needs registered watcher

**Key takeaways:**
- The Rust `fs_watcher` only emits `directory-changed` for paths registered via `watch_directory`. Components that listen to those events but don't register their visible paths will only see updates piggybacked off another consumer.
- Miller column ancestors must call `watchDirectory` when entering the visible window and `unwatchDirectory` when leaving (and on unmount). Refcounted watches make it safe to overlap with the explorer pane's own watch on the current path.

---

## fix/activity-bar-tests-flake-under-all-view-modes-parallelism: Scope role-based queries when multiple widgets share the same ARIA role

**Key takeaways:**
- The app has two independent widgets that both expose `role="tab"`: the window-tab strip (per open folder/pane) and the sidebar activity bar. Under `ALL_VIEW_MODES=1` with parallel workers, a prior test could leave a window-tab labelled "Explorer" in localStorage, which then satisfies `getByRole("tab", { name: /Explorer/i })` alongside the activity-bar tab — strict-mode violation.
- Fix: always scope the locator to its parent tablist (`getByRole("tablist", { name: "Sidebar views" })`), or use a structural selector like `.activity-button[data-view-id="files"]`. Same principle applies anywhere roles are reused at multiple layers of the UI.
- Wait for the structural anchor (the `activity-button`) before asserting visibility on role-based locators — under high parallelism, the sidebar shell is still mounting when `waitForLoadState("domcontentloaded")` resolves.

---

## fix/marquee-zoom-hit-test: CSS zoom breaks coordinate math when mixing viewport and container-relative spaces

**Key takeaways:**
- `clientX` and `getBoundingClientRect().left` are both in viewport pixels. To get a container-relative position in CSS space under zoom, subtract first then divide: `(clientX - rect.left) / zoom`. The wrong order (`clientX / zoom - rect.left`) shifts the result left at zoom > 1.
- Clamp bounds from `getBoundingClientRect()` (`.width`, `.height`) are also in viewport pixels — divide by zoom to get CSS-space bounds.
- When converting CSS-space marquee coordinates back to viewport for DOM hit-testing (`getBoundingClientRect()` rects), multiply by zoom: `marqueeRect.left * zoom + containerRect.left`.
- At zoom = 1 the bug is invisible since all transforms are identity. Always test selection features at a non-default zoom level.

---

## perf/marquee-selection-remaining-lag: Eliminate remaining marquee selection lag sources

**Key takeaways:**
- **Double rAF pipeline**: FileList had its own `requestAnimationFrame` wrapper around the composable's rAF-batched `move()`. Fix: add an `onFlush` callback to the composable's `move()` so the selection update runs inside the same rAF frame — one pipeline instead of two.
- **Forced layout per mousemove**: `getBoundingClientRect()` was called on every `mousemove` during drag. Fix: cache the rect at drag-start and refresh it only on `ResizeObserver` events.
- **Index-level dedup**: `selectByIndices` was called every frame even when the covered items hadn't changed. Fix: cache the last indices array and skip the call when identical.
- **Svelte 5 reactive Set gotcha**: In-place `Set.add()`/`.delete()` on a `$state` Set creates fine-grained `.has()` subscriptions on a specific proxy instance. If you later replace the entire Set (`state = new Set()`), those subscriptions become orphaned — the old proxy's `.has()` stops updating but components still read from it. Stick with full Set replacement + identity checks, not mixed mutation strategies.
- **macOS Ctrl+click**: `Ctrl+click` is intercepted by macOS as right-click (context menu). E2E tests using `{ modifiers: ["Control"] }` for multi-select must use `"Meta"` on macOS. Fix: platform-aware `MULTI_SELECT_MODIFIER` constant in test helpers.

---

## perf/marquee-selection-raf-throttle: Coalesce high-frequency pointer events to display refresh rate

**Key takeaways:**
- High-poll mice fire `mousemove` at 200+ Hz, but the screen only repaints at ~60 Hz. Synchronously updating a `$state` value on every event makes the reactive chain (`$state` → `$derived` → Svelte DOM update) run 3–4× more often than the user can ever see. On slower machines this manifests as rubber-band lag during marquee selection.
- Fix pattern: inside the event handler, stash the latest event on a scratch variable and schedule an rAF only if none is pending; inside the rAF, commit the value to `$state`. That coalesces N events per frame into one reactive flush, preserving the latest coordinates. Remember to `cancelAnimationFrame` on teardown (`end()`) so a pending frame doesn't fire after the drag is over.
- Orthogonal compositor win: position the overlay with `transform: translate(x, y)` instead of `left/top`, keep `will-change: transform`, and only mutate `width/height` inline. `transform` updates stay on the compositor thread; `left/top` on an absolutely-positioned element still triggers paint on the ancestor.
- Verify this kind of perf change with a contract test (see `tests/state/marquee-raf-throttle.test.ts`), not a screenshot — assert that N move() calls schedule exactly 1 rAF and the committed value matches the last event. A screenshot can't distinguish 60 Hz from 240 Hz updates.

---

## fix/reenable-native-drag-drop: External drops need Tauri's native handler

**Key takeaways:**
- `WebviewWindowBuilder::disable_drag_drop_handler()` had been added incidentally in a perf commit about `initialization_script`. With it disabled, Tauri does not intercept OS-level file drops, so `webview.onDragDropEvent` (wired in `use-external-drop.svelte.ts`) never fires. WebKitGTK's default then kicks in: the webview navigates to the `file://` URL and shows the picture full-screen with no way back.
- Removing `.disable_drag_drop_handler()` is safe: internal HTML5 DnD (bookmark reorder, file items, recent→bookmark) doesn't cross the OS boundary and keeps working. `tauri-plugin-drag` handles *outgoing* drags via a separate native API — orthogonal to the incoming handler.
- If the webview ever traps on a file URL again, `Ctrl+R` reloads it back to the app.

---

## fix/address-bar-hides-nav-buttons: Hide the whole navigation bar, not just the address portion

**Key takeaways:**
- Originally "hide address bar" only hid the breadcrumb container, leaving the back/forward/up buttons and the 40px bar around them still occupying vertical space — defeating the purpose. Fix: wrap the entire `.navigation-bar` in `{#if settingsStore.showAddressBar || explorer.showFilter}` so it unmounts completely when hidden. Keep it mounted when the filter is showing (Ctrl+F) so the filter still has somewhere to render, and use `justify-content: flex-end` via an `.address-bar-hidden` modifier to push it to the top-right.

---

## design/saturate-app-icon-colours: Bump chroma from the rendered PNG, not the SVG

**Key takeaways:**
- `icon.svg` in `src-tauri/icons/` is a separate blue-folder mock and is *not* what ships — the shipped icon is `icon.png`. Regenerate all platform sizes by resaturating `icon.png` (Pillow `ImageEnhance.Color(1.7)` + small contrast bump) then re-running the ico/icns/Square*Logo fan-out. If you edit the SVG thinking it's the source you'll waste a cycle.

---

## feat/switch-theme-command: Preview vs. commit on the theme store

**Key takeaways:**
- Live-preview UI needs a separate API from persist. Added `themeStore.previewTheme(id)` which only toggles `document.documentElement.data-theme`, leaving settings alone. The picker uses it on every arrow-key selection; Enter calls `setTheme` to persist, Escape re-applies the saved `originalThemeId` so the live preview is cleanly reverted. Replaces the old N-commands-in-palette approach with a single `view.switchTheme` entry.

---

## fix/spurious-text-highlighting: Default `user-select: none` on UI chrome

**Key takeaways:**
- Several components set `user-select: none` locally, but the body defaulted to `auto`, so shift-click across rows (e.g. miller columns, details view) could kick off a native text selection range spanning them — sticky, hard-to-clear, and visually jarring. Set `user-select: none` on `body` globally and explicitly re-enable `text` for inputs, textareas, `[contenteditable="true"]`, and `.preview-pane` (where users actually want to copy). Root-cause fix rather than a local patch per component.

---

## feat/allow-hiding-address-bar: New setting + command

**Key takeaways:**
- Added `showAddressBar: boolean` (default `true`) to `Settings`, a `toggleAddressBar` store method, a Settings dialog row, and a `view.toggleAddressBar` command so the feature is reachable from the command palette. The breadcrumb container is wrapped in `{#if settingsStore.showAddressBar}` — navigation buttons stay visible regardless, matching how other view toggles work.

---

## feat/drag-recent-bookmarks: Reuse existing Quick-Access drop target

**Key takeaways:**
- The Quick Access (bookmarks) region already had native dragover/drop listeners that bookmark any `dragState.current` where `kind === "directory"`. Making recent-location entries `draggable="true"` and populating `dragState.start({...})` on dragstart makes promotion Just Work — no new drop handler needed. Setting the `application/x-explorer-kind` data attribute keeps the existing dropEffect logic happy.
- Sidebar's document-level `dragend` listener is registered with `{ capture: true }` so it reads `dragState.current` BEFORE any drag source's bubble-phase `ondragend` can clear it. Drag sources then clear synchronously — no `setTimeout` needed. This replaces the earlier workaround pattern (see `fix/drag-to-bookmarks` below, which originally used `setTimeout(() => dragState.clear(), 0)` to work around the same race).

---

## feat/remove-recent-paths: Hover-reveal remove on recent entries

**Key takeaways:**
- The recent-locations list in the sidebar reused the `.folder-item .remove-bookmark` hover-reveal pattern from bookmarks. Swapped the `<button>` row for a `<div role="button" tabindex="0">` + inner close button so the nested interactive element is valid. Removal goes through `frecencyStore.remove(path)` which already handles persistence.

---

## fix/tab-bar-window-controls: Tab bar hosts the window controls

**Key takeaways:**
- `WindowTabBar` used to hide itself whenever `tabs.length <= 1`, which caused a layout jump the moment a second tab opened and meant the window controls (min/max/close) also disappeared when they're enabled. Gate on `tabs.length > 1 || settingsStore.showWindowControls` so the strip stays mounted whenever it's hosting the controls.

---

## fix/normalize-bare-drive-letter: Drive root must carry a separator

**Key takeaways:**
- Typing `e:` in the address bar used to leave the path without a trailing separator, and `parseBreadcrumbs` split on `/\\` treats `E:` as a regular segment — so "up one level" produced a bogus `/E:` POSIX path. Normalize bare drive letters (`/^[A-Za-z]:$/`) to `E:/` at the address-bar boundary so all downstream path logic (breadcrumbs, `getParentPath`) sees a real drive root.

---

## feat/sidebar-removable-drives: Platform-specific volume enumeration

**Key takeaways:**
- Linux user-mounts live under `/run/media/$USER` (systemd) or `/media/$USER` (udisks). Don't hardcode one — scan both and dedupe. Skip the `$USER` entry itself when scanning `/media`.
- macOS exposes every mount under `/Volumes`, including the root volume as a symlink to `/`. Read the symlink target to distinguish boot from removable.
- On Windows, detecting DRIVE_REMOVABLE reliably needs `GetDriveTypeW`. Without a winapi dep we fall back to a heuristic (C: is fixed, others are Unknown and still shown). Upgrade when needed.
- The drives store polls every 5s (no reliable cross-platform mount notifications) — cheap since `read_dir` on a handful of mount points is instant.

---

## fix/quickopen-hover-selection: Don't let initial hover override keyboard selection

**Key takeaways:**
- `onmouseenter` on a row fires the moment the popup renders over the cursor, silently overriding the initial top-result selection before the user can press Enter. Fix with a `mouseMoved` flag gated on `onmousemove` — reset to `false` on open and on arrow-key nav, so hover only wins after the user actually moves the pointer. **Important:** a bare `onmousemove` handler isn't enough — macOS WebKit fires a synthetic `mousemove` event (zero physical delta) when a new element renders under a stationary cursor. Compare `clientX/clientY` against the last recorded position so that only genuine coordinate changes set the flag.

---

## chore/drop-macos-intel-build: Dropped macos-13 Release Matrix Cell

**Key takeaways:**
- GitHub Actions `macos-13` (Intel Mac) hosted runners are routinely queued 2h+ with no pickup, blocking the `release` job (which `needs: build` across the whole matrix). Apple stopped selling Intel Macs in 2023 and macOS Tahoe (2025) is the last macOS supporting them, so the Intel .dmg has a vanishing audience. Dropped the cell; arm64 still ships a signed .dmg. If Intel Mac support becomes important again, reintroduce with a self-hosted or third-party runner rather than hosted `macos-13`.

---

## fix/ci-rollup-optional-deps: CI Rollup Optional Deps Fail on Non-Linux Runners

**Key takeaways:**
- `bun install` will migrate from an existing `package-lock.json` if one exists, and preserves the lockfile's platform-specific optional deps. Rollup ships platform-specific native binaries as optional deps; a lockfile generated on Linux only records `@rollup/rollup-linux-x64-gnu`, so non-Linux CI runners fail with `Cannot find module @rollup/rollup-darwin-arm64` / `@rollup/rollup-win32-x64-msvc`. Deleting `bun.lock` before `bun install` is not enough — `package-lock.json` also has to go. Because this project is bun-only, `package-lock.json` is removed from the repo and gitignored.

---

## fix/test-setup-stub-node25: Node 25 Native localStorage Breaks Test Stub

**Key takeaways:**
- Node 25 exposes a native empty `localStorage` global, so `typeof globalThis.localStorage === "undefined"` is false and `tests/setup.ts` skipped installing the functional stub. Any test that persists state (via `persisted.ts` / `drag.svelte.ts`) without its own `vi.stubGlobal` then crashed with `setItem is not a function`. Check for a functional `setItem` method, not mere existence.

---

## fix/arrow-select-first-v2: Arrow Select First (v2)

**Key takeaways:**
- The "select first item when nothing selected" check must come BEFORE the miller left/right directory navigation, otherwise ArrowLeft always triggers goUp() even with no selection. Also reuse the already-fetched `selected` variable in the miller right-arrow check instead of calling `getSelectedEntries()` again.
## fix/tab-flash-content: Tab Content Flash on New Tab

**Key takeaways:**
- New tabs flash empty because `createTab` creates a fresh explorer and immediately switches to it. The explorer's `navigateTo()` is async so entries arrive after the first render. Fix: seed the new explorer with the source tab's entries/sort/viewMode so it renders instantly. Also skip `loading = true` in `navigateInternal` when the path is already populated (seeded state).
## fix/preview-hidden-reactive: Folder Preview Hidden Files Reactivity

**Key takeaways:**
- Folder preview filtered hidden files inside `loadPreview()` which only runs on selection change. Toggling `showHidden` didn't update the preview. Fix: store raw entries in `previewFolderChildrenRaw` and use `$derived` to filter based on `settingsStore.showHidden`, making it reactive.
## fix/disable-slow-click-rename: Remove Slow-Click-to-Rename

**Key takeaways:**
- FileItem.svelte had Windows Explorer-style slow-click-to-rename: clicking an already-selected file's name after 500ms triggered rename. Removed entirely — rename is only via F2 or context menu now.

---

## fix/breadcrumb-caret-spacing: Tighter Breadcrumb Carets

**Key takeaways:**
- Breadcrumb caret buttons had `padding: 4px 5px` and container `gap: 2px`. Reduced to `padding: 4px 2px` and `gap: 0px` for tighter spacing between chevrons and folder names.
## feat/pageup-down-navigation: PageUp/PageDown Navigation

**Key takeaways:**
- Added PageUp/PageDown support in ExplorerPane alongside existing arrow key handling. Jumps by 8 items, clamped to list bounds. Supports Shift+PageUp/Down for range selection.
## fix/preview-line-limit: Preview Line Limit and Large File Performance

**Key takeaways:**
- Syntax highlighting the full 512KB of a large file (uv.lock, etc.) causes UI lag. Fix: truncate preview to 200 lines and only syntax-highlight content under 50KB. Show a truncation indicator.
## fix/folder-preview-hidden: Folder Preview Respects Hidden Files

**Key takeaways:**
- PreviewPane's folder listing used `result.data.entries` directly without filtering. MillerColumns correctly filtered hidden files but PreviewPane didn't. Filter based on `settingsStore.showHidden`.
## fix/arrow-select-first: Arrow Key Selects First Item

**Key takeaways:**
- When nothing is selected (`currentIndex < 0`), the `step === 0` early return for inapplicable arrows (e.g. left/right in details) prevented selecting the first item. Moved the "nothing selected → select first" check before the step calculation.
## fix/tab-open-flash: Tab Open Flash and Close Animation

**Key takeaways:**
- The slide-in animation on `.tab` replayed for ALL tabs whenever the tab bar re-rendered (e.g. on mount with 2+ tabs). Fix: track known tab IDs and only apply `tab-entering` class to genuinely new tabs. For close animation, use a `closingTabId` state + `setTimeout` to delay actual removal until the CSS animation completes.

---

## feat/miller-arrow-nav: Miller View Arrow Key Navigation

**Key takeaways:**
- In details view, `getArrowStep()` returns 0 for horizontal arrows. When miller columns are visible, left/right arrows should navigate directories (up/into) like yazi. The check must happen before the step=0 early return.

---

## feat/tab-open-animation: Tab Opening Animation

**Key takeaways:**
- CSS `@keyframes` with `max-width: 0 → 220px` + `opacity: 0 → 1` creates a Chrome-like slide-in. Use `animation-fill-mode: both` and `overflow: hidden` on the tab to clip content during expansion.

---

## fix/new-folder-empty-dir: New Folder in Empty Directory

**Key takeaways:**
- FileList's empty-state (`displayEntries.length === 0`) prevents any view component from rendering, so `InlineNewFolder` never mounts. Must check `isCreatingFolder` alongside empty state to render the inline input even in empty directories.
## fix/tiles-delete-lag: Tiles View Delete Lag and Thumbnail Flicker

**Key takeaways:**
- The progressive tile rendering `$effect` was resetting `tileRenderLimit` to `TILE_CHUNK` on every `displayEntries` change, including deletions. This caused all tiles to re-render from scratch (flicker). Fix: only reset on large entry count increases (new directory), not decreases (deletion) or small additions.
- The delete dialog overlay animation at 150ms felt sluggish. Reducing to 80ms makes it feel instant without losing visual smoothness.
## feat/text-file-preview: Text File Preview for Shell Scripts and Dotfiles

**Key takeaways:**
- `isTextFile()` only checked `ICON_CATEGORY_MAP` categories and a handful of hardcoded extensions. Files like `.sh` (in ICON_CATEGORY_MAP as "executable") and `.gitignore` (no extension via `getExtension()`) were missed. Added `KNOWN_TEXT_FILES` set for extensionless files and `EXTRA_TEXT_EXTENSIONS` set for additional extensions.
## fix/chord-key-leak: Chord Suffix Keys Leaking to Type-Ahead

**Key takeaways:**
- Chord shortcuts (e.g. Alt+M E) work in two phases: prefix fires on window keydown, suffix fires on next keydown. But the FileList type-ahead handler fires on element bubble phase before the window listener, so it processes the plain suffix key (e/u/b) as type-ahead navigation. Fix: check `keybindingsStore.isChordActive` in type-ahead to skip processing when a chord is in progress.
## fix/light-theme-preview: Preview Pane Light Theme Support

**Key takeaways:**
- highlight.js CSS themes are global imports that define `.hljs` class colors. Importing `github-dark.css` made code unreadable on light themes. Solution: replace the global import with component-scoped CSS rules (`.hljs-light` / `.hljs-dark` wrappers) and detect the active theme's `color-scheme` property via `getComputedStyle(document.documentElement).colorScheme`.

---

## fix/hyprpaper-fill-mode: Hyprpaper Wallpaper Fit Mode

**Key takeaways:**
- Hyprpaper's `fit_mode` option in `hyprpaper.conf` defaults to `cover` (may crop the image), but `fill` stretches to fill the entire monitor without cropping. Use `fill` for the "Set as Wallpaper" context menu action since users generally expect the image to fill the screen completely.

---

## feat/miller-drag-drop: Miller Columns Drop Targets

**Key takeaways:**
- Miller columns drop-to-move uses the shared `useDropTarget` composable. Default drag = move (blue highlight), Ctrl+drag = copy (green highlight). The `handleFileDrop` utility handles conflict resolution, undo tracking, and toast notifications consistently with the main file list. Always take screenshots with `deviceScaleFactor: 2` and element-level `.screenshot()` for cropped, high-res captures of small UI regions.

---

## fix/scan-metadata-syscalls: Minimize Metadata Syscalls

**Key takeaways:**
- `metadata_to_entry` was calling `fs::metadata` (passed by callers) + `fs::symlink_metadata` internally = 2 syscalls per entry minimum, 3 for symlinks. Refactored to use `symlink_metadata` as the primary call everywhere. For non-symlinks (99% of entries), this is 1 syscall. For symlinks, it's 2 (symlink_metadata + fs::metadata to resolve target). Saves ~10K syscalls for a 10K-entry directory.

---

## fix/miller-double-filter: Don't Filter at Cache Level

**Key takeaways:**
- When a cache layer exists below a reactive derived filter, avoid filtering at the cache level. MillerColumns' `loadColumn` filtered to directories only before caching, then the `$derived` `filterEntries` filtered again. Removing the cache-level filter makes the cache truly raw and ensures all filtering is handled in one place (the reactive layer).

---

## fix/miller-stale-folders: Miller Columns Cache Invalidation

**Key takeaways:**
- Miller columns had an infinite-TTL local cache (`rawCache` Map) that was never invalidated by filesystem events. The main pane's `directory-changed` listener only refreshed `explorer.currentPath`, not ancestor directories displayed in Miller columns. Fix: listen to `directory-changed` in the MillerColumns component itself, delete affected cache entries, and reload visible columns. Also, don't pre-filter hidden files in the cache — store all directory entries and let the reactive `filterEntries` derived state handle visibility, so toggling `showHidden` works correctly.

---

## fix/remaining-sync-commands: Audit All Commands After Async Conversion

**Key takeaways:**
- When converting commands to async, audit the entire module — don't just convert the ones listed in a ticket. `create_directory` and `rename_entry` were missed in the initial pass because they do "small" I/O, but on network filesystems even `fs::create_dir` or `fs::rename` can block for seconds.

---

## fix/streaming-dir-listing: Parallel Directory Scanning with jwalk

**Key takeaways:**
- `fs::read_dir` + sequential `fs::metadata` calls are the bottleneck for large directories (100K+ files). `jwalk::WalkDir` with `max_depth(1)` parallelizes the `stat()` calls across a rayon thread pool, significantly reducing scan time. The sort still requires all entries, but the I/O-bound scan phase benefits most from parallelism. Extracting the scan into a shared `scan_directory_parallel` function also deduplicates the logic between `list_directory` and `start_streaming_directory`.

---

## fix/explorer-facade-god-object: Explorer Facade Cleanup

**Key takeaways:**
- Facade objects accumulate unused thin delegates over time. Audit usage before assuming methods are needed. In this case, `openNewFolderDialog`, `closeNewFolderDialog`, `cancelRename`, `cancelDelete`, `closeContextMenu`, `clearClipboard`, `canUndo`, `canRedo`, and `toggleHidden` were either never called on the facade or already accessed via their underlying stores. Removing dead delegates reduces API surface and makes it clear which operations actually require per-pane coordination.

---

## fix/view-component-duplication: View Interaction Composable

**Key takeaways:**
- DnD, context menu, and clipboard state logic was duplicated across FileItem, ListView, and TilesView (3x ~130 lines). Extract shared logic into a composable (`use-item-interactions.svelte.ts`) that accepts dependencies via a config object. Use a `selectOnContextMenu` flag to handle the difference between views that select on right-click (ListView/TilesView) and those that don't (FileItem/DetailsView where selection is handled upstream). Git status badges should be a shared component (`GitStatusBadge.svelte`) to ensure consistent rendering across views.

---

## fix/blocking-rust-commands: Async Tauri Commands

**Key takeaways:**
- All Tauri 2 commands that do filesystem I/O must be `async fn`. Sync commands run on the main thread and freeze the UI during large operations. Simply adding `async` to the function signature is sufficient — Tauri's macro handles running async commands on a thread pool. Tests calling async commands need `tokio::runtime::Runtime::new().unwrap().block_on(...)`.

---

## fix/extract-error-recursion: extractError Infinite Recursion

**Key takeaways:**
- Error extraction functions must have a safe fallback that doesn't recurse. The `extractError` function's fallback case called itself instead of `String(err)`, causing stack overflow for any non-structured error. Always ensure recursive functions have a base case that terminates.

---

## fix/remove-system-bookmarks: Removable System Folders

**Key takeaways:**
- System folders (Downloads, Documents, etc.) were hardcoded with no way to hide them. Persist hidden names in localStorage (`explorer-hidden-system-folders`) and filter the list. Use a `<div>` wrapper instead of `<button>` when a row needs a nested remove button — HTML doesn't allow `<button>` inside `<button>`.

---

## fix/recent-exclude-root: /home in Recent Locations

**Key takeaways:**
- `homeDir` defaults to `"/home"` before the async `getHomeDirectory()` resolves. The filter `e.path !== homeDir` only excludes the *user's* home dir (e.g. `/home/user`), not `/home` itself. Hardcode exclusions for `/home` and `/` since nobody wants to see these in recent locations.

---

## fix/miller-spacing: Miller Column Spacing

**Key takeaways:**
- New components should match existing components' spacing. Miller entries used 12px font/6px gap/3px padding while list view used 13px/8px/4px. Always reference the established component's CSS when building a similar one.

---

## fix/settings-ctrlf: Ctrl+F in Settings

**Key takeaways:**
- When adding a search filter to a dialog, also wire Ctrl+F to focus it. Users expect Ctrl+F to find things — not doing so feels broken.

---

## fix/recent-frecency-sort: Recent Folders Sorting

**Key takeaways:**
- `frecencyStore.entries` is in insertion order, not score order. Must sort explicitly by `getScoreMap()` when displaying.
- Recent folders should exclude bookmarked paths and system folders to avoid duplication with the Bookmarks section above.

---

## fix/drag-to-bookmarks: Drag to Bookmarks Race Condition

**Key takeaways:**
- Element-level `ondragend` fires before document-level `addEventListener("dragend", ...)`. The file item's `dragState.clear()` ran before the sidebar's document listener could read `dragState.current`. Fix: `setTimeout(() => dragState.clear(), 0)` to defer the clear until after all synchronous dragend listeners have fired.
- This is the same class of bug as tauri-0gre (Svelte 5 event delegation + DnD state machine). The sidebar uses native `addEventListener` because Svelte 5's delegation breaks DnD — but that means it runs after element handlers in the bubbling phase.

---

## fix/quickopen-debug-fuzzy: Fuzzy Scoring for Frecency Results

**Key takeaways:**
- Frecency/recent results used simple `name.includes(query)` matching while backend results used a proper fuzzy scorer. This caused frecency-sourced folders to rank lower than backend files with the same name match. Solution: apply the same fuzzy scoring algorithm (fzy/VS Code style) to frecency entries on the frontend.
- The `fuzzyScorePath` function scores against the basename at 1.5× weight vs full path, so filename matches naturally rank higher.
- Multiplying fuzzy score by 10 (`fuzzy * 10`) puts it in the same numeric range as the backend scores + name bonus.

---

## fix/quickopen-debug-settings: QuickOpen Score Breakdown

**Key takeaways:**
- `result.score` in QuickOpen already has frecency and name bonus baked in from `rankWithFrecency`. To show a proper breakdown, derive the base fuzzy score as `result.score - frecencyPts - nameScore`. Without this, the debug display double-counts or misses the backend search score entirely.
- Debug features should be Settings toggles, not hidden keyboard shortcuts. Users can't discover undocumented shortcuts.

---

## feat/miller-view: Miller Columns

**Key takeaways:**
- Miller columns work better as an optional panel alongside any view mode (details/list/tiles) rather than as a separate view mode. This avoids ViewMode type changes and lets users combine miller navigation with their preferred file display.
- Only show directories in miller columns — files are visible in the main view. Showing files would duplicate content and add clutter.

---

## fix/undo-paste + fix/undo-multi-drag: Paste Undo and Batch Undo

**Key takeaways:**
- Copy-paste operations were not undoable because no undo action was pushed. Added a `"copy"` undo type that trashes the copied file on undo.
- Multi-file operations pushed individual undo actions, requiring N Ctrl+Z presses. Added a `"batch"` undo type that wraps multiple actions and undoes/redoes them all at once.
- Single-file pastes should NOT be batched (push directly) to avoid unnecessary wrapper.

---

## feat/git-indicator-polish: Polished Git Indicators

**Key takeaways:**
- VS Code-style git indicators use colored text without background boxes — just the letter (M/U/A/D) in the appropriate color. This is more subtle and integrated than badge-style indicators with backgrounds.

---

## fix/breadcrumb-drop-move: Breadcrumb Drop Always Moves

**Key takeaways:**
- Breadcrumb segments are navigation targets, not file manager targets. Dropping onto them should always move (never copy), regardless of Ctrl key state. Hardcode `isCopy = false` and `dropEffect = "move"`.

---

## fix/remove-sidebar-buttons: Sidebar Cleanup

**Key takeaways:**
- When removing UI sections (Home/Dual Pane buttons, This PC drives), also remove the associated state variables (`thisPcExpanded`, `drives`) and CSS classes to avoid dead code.
- The "Quick Access" label was renamed to "Bookmarks" and recent locations changed from clock icons to folder icons to match user expectations.

---

## fix/mock-paste-ops: Mock Paste Operations

**Key takeaways:**
- `estimate_size` mock was missing, silently breaking the paste flow in browser dev mode (thrown error caught by `ApiResult` pattern). Every new Tauri command needs a corresponding mock handler.
- `Ctrl+C/V` keyboard shortcuts don't work via `agent-browser press` in headless Chromium. Use `window.dispatchEvent(new KeyboardEvent('keydown', ...))` instead.
- To test conflict dialogs: need two directories with a file of the same name in the mock filesystem.

---

## fix/conflict-dialog-display: Conflict Dialog Details Missing

**Key takeaways:**
- `PasteSource` stripped metadata (size/modified) from `FileEntry` when creating the source array. When extending data interfaces, update ALL callsites that construct them — not just the consumer.
- Dates in `FileEntry.modified` are ISO strings — must format with `formatDate()` before display.
- Directory size is 0 in listings — guard the size display with `> 0` to avoid showing "0 B".

---

## fix/git-status-display: Git Indicators Not Showing

**Key takeaways:**
- View-mode-parity: when adding UI features, wire them into ALL three views (FileItem/details, ListView, TilesView). The git badges were only added to FileItem.
- Mock invoke must handle new commands — `mockCommands` in `mock-invoke.ts` throws on unknown commands, silently swallowing the feature in browser dev mode.
- `$effect` calling a store method that reads `$state` internally creates hidden dependencies. Wrap the call in `untrack()` to prevent infinite loops.

---

## chore/pin-dolt-port: Dolt Port Race Condition

**Key takeaways:**
- When multiple hooks call `bd` in rapid succession (e.g. 17 merges back-to-back), each `bd` invocation may auto-start a new dolt server on a random port if the previous port is unreachable. This creates competing instances that deadlock on the database lock. Fix: pin `dolt.port` in `.beads/config.yaml` so every invocation connects to the same deterministic port.

---

## chore/add-unit-test-hook: Pre-Commit Unit Tests

**Key takeaways:**
- Unit tests run in ~3s, fast enough for a pre-commit hook. This catches broken tests before they reach dev, unlike the previous setup which only checked that test files *exist* but never *ran* them.

---

## fix/undo-window-close: Cross-Window Tab Restore

**Key takeaways:**
- `closedTabStack` loaded from localStorage at module init becomes stale when another window adds entries. Before checking `canRestoreTab` or popping from the stack, always re-read from localStorage to pick up cross-window changes. Without this, Ctrl+Shift+T in window B can't see tabs closed in window A.
- **Never use `localStorage` in unit tests** — not even via `loadPersisted`/`savePersisted`. Node versions differ in whether `globalThis.localStorage` exists, is partial, or is undefined. The `setup.ts` stub only applies when it's fully undefined, so tests break on machines where Node provides a partial `localStorage`. Test the business logic (e.g. "stale array misses external writes, refreshed array doesn't") with plain data structures instead.

---

## fix/multi-file-drag-drop: Multi-File Drag and Drop

**Key takeaways:**
- `DragData` and `dataTransfer` only stored a single path. When dragging from a multi-selection, all selected paths must be serialized (via `application/x-explorer-paths` JSON and `DragData.paths`). Drop handlers must iterate over all paths rather than operating on a single source.

---

## fix/addressbar-responsive-icons: Responsive Nav Icons

**Key takeaways:**
- Use CSS `container-type: inline-size` on the navigation bar and a `@container (max-width: 400px)` query to hide navigation buttons when the content area is too narrow. This is more reliable than media queries because it responds to the actual component width, not the viewport.
- `agent-browser` can't resize the viewport. Use Playwright directly (`chromium.launch()` + `page.setViewportSize()`) to take screenshots at specific widths for responsive features.

---

## fix/terminal-shortcut-garbage + fix/revert-chord-prefix: Alt Chord Shortcuts

**Key takeaways:**
- Alt+M chord shortcuts were temporarily changed to Ctrl+M to avoid compose characters on Linux WebKitGTK, but the user preferred Alt+M. Reverted back. The compose character issue on Linux is accepted as a known limitation.

---

## fix/quickopen-filename-scoring: Filename Match Scoring

**Key takeaways:**
- When scoring search results that include both filename and path matches, filename matches need a dramatically higher weight (150-200) compared to path-only matches (30). Otherwise, frequently accessed subdirectories can outrank the parent that actually matches the query name. The scoring tiers: exact name=200, prefix=150, substring=100, path-only=30.

---

## fix/addressbar-folder-only: Address Bar Folders Only

**Key takeaways:**
- Address bar autocomplete is for navigation, which only targets directories. Filter to `e.kind === "directory"` in `fetchSuggestions()`. No need for sorting directories before files when files are excluded entirely.

---

## fix/new-folder-tile-size: New Folder Sizing in Tiles

**Key takeaways:**
- InlineNewFolder's tiles variant must inherit CSS variables (`--tile-icon-size`, `--tile-icon-scale`, `--tile-padding`) from the parent TilesView rather than hardcoding dimensions. Hardcoded `64px` icon size and `11px` font caused size mismatch in medium/large tile modes.

---

## fix/titlebar-disabled-margin: Top Margin When Title Bar Disabled

**Key takeaways:**
- The `window-top-spacer` div provides a drag region when the toolbar is hidden. But it should also be gated on `showWindowControls` — if the user has disabled window controls, they don't need a drag region and the spacer creates a visible gap above the address bar.

---

## fix/small-tiles-spacing: Reduce Spacing in Small Tiles Mode

**Key takeaways:**
- When tile sizes are controlled by CSS custom properties (`--tile-icon-size`, `--tile-min-col`), spacing (gap, padding) should also be parameterized rather than hardcoded. Use additional CSS custom properties (`--tile-gap`, `--tile-padding`) driven by the thumbnail size tier so that small tiles get a denser layout without affecting medium/large.

---

## tauri-explorer-gmpb: Material Design File Icons

**Key takeaways:**
- When adding new select/dropdown elements that reuse CSS classes (e.g., `.theme-select`), E2E tests using that class as a locator will break with "strict mode violation: resolved to N elements". Always add a distinguishing class (e.g., `.color-theme-select` vs `.icon-theme-select`).
- Nerd Font BMP codepoints (U+E000-U+F8FF) are safe to use with `\uXXXX` JS escapes. SMP codepoints (U+F0000+) require `String.fromCodePoint()` — stick to BMP for simplicity.
- The Symbols Nerd Font "Only" variant (~2.4MB TTF) contains just icon glyphs without text characters, ideal for file explorer icon rendering.

---

## tauri-explorer-rdra / tauri-explorer-za55: OS Clipboard Integration

**Key takeaways:**

- When implementing dual clipboard support (internal app clipboard + OS system clipboard), make sure UI guards check **both** sources. The paste handlers were gated on `clipboardStore.hasContent` which only checked the internal clipboard, silently blocking the OS clipboard fallback path that was already correctly implemented in `paste()`.
- `tauri-plugin-clipboard-x` requires both the Rust crate (`tauri-plugin-clipboard-x = "2"` in Cargo.toml) **and** the JS API bindings package (`tauri-plugin-clipboard-x-api` in package.json). Missing the npm package causes module resolution failures at build time.
- Context menus should always show "Paste" (like native file explorers) rather than conditionally hiding it — the paste handler already returns appropriate error messages when nothing is available.

---

## tauri-ygaq: Content Search Performance Optimization

**Key takeaways:**

- `grep-searcher`'s `Searcher::new()` allocates internal buffers. Creating one per file is wasteful -- create once per worker thread in the `walker.run(|| { ... })` closure (before the `Box::new(move |entry| { ... })` closure).
- `MmapChoice::auto()` is `unsafe` because the caller must ensure the file isn't mutated during search. In a read-only search context this is safe and provides significant speedup. On macOS the crate silently disables mmap regardless.
- `BinaryDetection::quit(b'\x00')` stops searching a file on first NUL byte. Combined with the extension-based `is_binary_file()` pre-filter, this is a two-layer defense against wasting time on binary files.
- `RegexMatcherBuilder` is cleaner than manually prepending `(?i)` and toggling between `RegexMatcher::new` vs `new_line_matcher`. Always set `.line_terminator(Some(b'\n'))` for consistency.
- Svelte 5 `$derived.by()` re-runs on every reactive dependency change. For content search with streaming batches, this caused O(total) work on every batch arrival. Solution: use a non-reactive backing array (`let allFlattened: T[] = []`) and only expose a reactive page slice (`let flattenedResults = $state<T[]>([])`).
- Adaptive batch intervals (50ms then 150ms) give fast first-paint while reducing steady-state event frequency.
- `floor_char_boundary()` (stable in Rust 1.93) is essential for truncating strings at valid UTF-8 boundaries.

---

## tauri-qbx6: PNG Image Previews Not Working

**Key takeaways:**

- The `image` crate's JPEG encoder doesn't handle RGBA (transparency) images. When generating thumbnails from PNG files, you must convert `DynamicImage::ImageRgba8` to `DynamicImage::ImageRgb8` before writing to JPEG format, otherwise the encoder may fail or produce corrupt output.
- Match on `DynamicImage::ImageRgba8(_) | ImageRgba16(_) | ImageRgba32F(_)` to cover all RGBA variants.

---

## tauri-1rzt: Laggy Image Previews

**Key takeaways:**

- In tiles view, every `ThumbnailImage` component fires its `$effect` on mount, causing N concurrent Tauri IPC calls for N images. `IntersectionObserver` with a `rootMargin` of `200px` defers loading until thumbnails are near the viewport, dramatically reducing initial load.
- The observer should be disconnected after first intersection (`observer.disconnect()` inside the callback) to avoid ongoing observation overhead.

---

## tauri-qz5t: Copy/Paste Folder with Files Not Working

**Key takeaways:**

- `fs_extra::dir::copy(src, dest, options)` with default `CopyOptions` copies `src` INTO `dest` as `dest/source_name/`. If `dest/source_name/` already exists, it fails because `overwrite` and `skip_exist` default to false.
- For same-directory copies (where collision handling renames to "name - Copy"), passing `target.parent()` to `fs_extra` still creates the original name, conflicting with the source. Fix: `fs::create_dir_all(target)` + `content_only = true` to copy contents directly into the renamed target.
- Same issue exists in cross-filesystem `move_entry` fallback.

---

## tauri-6yzm / tauri-o5ny: Paste Duplicates 3 Times

**Key takeaways:**

- Keyboard shortcuts can fire through multiple layers: component `onkeydown` → parent `onkeydown` → global `window.addEventListener("keydown")`. `preventDefault()` does NOT prevent bubbling. `stopPropagation()` is a band-aid, not a fix.
- The proper solution: have ONE canonical handler (the global keybinding system via `command-definitions.ts`) and remove all duplicates from component-level keydown handlers. Only keep handlers in components for shortcuts that need local state context (e.g., ArrowUp/Down for list navigation needs current selection index).
- For UI feedback (toasts) that was previously in the inline handler: use reactive state. `paste()` writes to `explorer.pasteResult`, and FileList observes it via `$effect`. This decouples feedback from the shortcut handler entirely.

---

## tauri-n5sr: Tiles View Drag Selection Mismatch

**Key takeaways:**

- Marquee selection using `getSelectedIndices(scrollTop, totalItems)` with `index = floor(marqueeTop / itemHeight)` only works for linear lists with fixed row height. CSS grid layouts (tiles view) need DOM-based hit testing using `getBoundingClientRect()` and AABB intersection.
- `getBoundingClientRect()` returns viewport-relative coordinates, automatically accounting for scroll position.

---

## tauri-phud: Delete Multiple Selected Files

**Key takeaways:**

- The Rust backend already had `move_multiple_to_trash` using `trash::delete_all()` but it was never wired to the frontend. Always check existing backend capabilities before adding new commands.
- When extending a single-entity dialog to support multiple entities, adding a parallel array (`targetEntries`) alongside the existing `targetEntry` maintains backward compatibility while enabling batch operations.
- After batch deletion, remember to also clean up `selectedPaths` to remove references to deleted files.

---

## tauri-fadw: Architecture Improvements Epic (10 tasks)

**Key takeaways:**

- `HashMap::new()` is not a const fn in Rust, so `Mutex::new(HashMap::new())` can't be used in `const fn`. Use `OnceLock` with lazy initialization instead for static registries.
- When consolidating keyboard shortcuts, make the resolver when-aware (pass an `isAvailable` predicate to `findMatchingCommand`) rather than relying on registration order. This allows the same key to have different bindings in different contexts.
- Replacing `window.dispatchEvent(new CustomEvent(...))` with a typed store (dialogStore) catches broken event names at compile time and makes dialog state observable in devtools.
- `explorer.state.X` indirection creates confusion when it mixes per-pane state with global store state. Promoting commonly-used fields to top-level getters (`explorer.currentPath` instead of `explorer.state.currentPath`) reduces coupling.
- When creating a shared error type (`AppError`), implementing `From<String>` and `From<io::Error>` eliminates most `.map_err()` calls, making the migration much less invasive.
- FileItem-level keyboard handlers easily fall out of sync with the global command system. Prefer a single source of truth for keyboard shortcuts.

---

## tauri-pghn / tauri-enf4: Themed Icons via CSS Variables

**Key takeaways:**

- To make inline SVG icons themeable, use `fill="currentColor"` and set the `color` CSS property via CSS custom properties. This allows a cascade: `color: var(--icon-file-tint, var(--file-icon-color, var(--text-secondary)))` where themes can override all icons at once (`--icon-file-tint`) or let per-extension colors shine through.
- CSS variables can control `display` property to toggle between UI variants (e.g., chevron vs powerline breadcrumbs) without JavaScript: `display: var(--breadcrumb-chevron-display, flex)`.
- When adding theme-specific features, use CSS variables with sensible defaults so existing themes continue to work without modification.

---

## tauri-vozb: Symlink Detection in Rust

**Key takeaways:**

- `fs::metadata()` follows symlinks, returning the target's metadata. Use `fs::symlink_metadata()` to detect symlinks themselves without following them.
- On Unix, `std::os::unix::fs::symlink()` creates symlinks. On Windows, need to distinguish between `symlink_file()` and `symlink_dir()`.

---

## tauri-2dgf: External Drop Modifier Keys

**Key takeaways:**

- Tauri's `onDragDropEvent` doesn't expose keyboard modifier state (Ctrl, Shift). To detect modifiers during external drops, track them globally via `keydown`/`keyup` listeners with `capture: true`.
- Use the same modifier convention as internal drags (default=move, Ctrl=copy) for consistency.

---

## tauri-ti0l: File-Based Config Persistence

**Key takeaways:**

- For Tauri apps, `dirs::config_dir()` gives the platform-appropriate config directory (`~/.config` on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows).
- Write-through persistence (save to both localStorage sync and config file async) provides the best of both: instant state for the UI and durable storage on disk.
- When migrating from localStorage to file-based storage, check the config file first, then fall back to localStorage for migration.

---

## tauri-5hlj / tauri-ksp2: Address Bar "/ >" Prefix and Triangles

**Key takeaways:**

- Breadcrumb separators rendered as literal "/" text before the first segment created a confusing "/ >" prefix. Replacing the root crumb's text content with an inline SVG folder icon is cleaner and matches native explorer conventions.
- When using SVG icons inline in Svelte, use `fill="none"` with `stroke="currentColor"` so they inherit the text color from CSS.

---

## tauri-8ytw / tauri-j9aa: Context Menu Not Appearing on Second Click / Missing for Files

**Key takeaways:**

- The ContextMenu backdrop's `oncontextmenu` re-dispatch logic ran `elementFromPoint()` synchronously after calling `contextMenuStore.close()`. But Svelte's reactive DOM updates are batched — the backdrop element was still in the DOM when `elementFromPoint` ran, so it hit the backdrop again instead of the underlying element. Fix: wrap re-dispatch in `requestAnimationFrame` to let Svelte flush DOM removal first.
- The list and tiles view modes rendered file entries as plain `<button>` elements in `FileList.svelte` without `oncontextmenu` handlers. Only the details view (via `FileItem.svelte`) had context menu support. Always audit all view modes when adding interaction features.

---

## tauri-jmcg: Symlink Double-Click Opens Terminal Instead of Navigating

**Key takeaways:**

- **Critical Rust gotcha:** On Unix, `DirEntry::metadata()` is equivalent to `symlink_metadata()` — it does NOT follow symlinks. So a symlink pointing to a directory returns `kind: "file"` because symlinks themselves aren't directories. Use `fs::metadata(entry.path())` to follow the symlink and get the target's metadata.
- Always provide a fallback to `entry.metadata()` for broken/dangling symlinks where `fs::metadata()` will fail.
- This affected both `list_directory` and `start_streaming_directory` — when fixing metadata-related bugs, audit all code paths that read file metadata.

---

## tauri-gkwz: Can't Drag Folders in Tiles View

**Key takeaways:**

- The `FileItem.svelte` component (used in details view) had full drag-and-drop support (`draggable="true"`, `ondragstart`, `ondragover`, `ondragleave`, `ondrop`), but the list and tiles views in `FileList.svelte` rendered entries inline without any drag attributes or handlers. Feature parity across view modes requires explicit wiring of all interaction handlers.
- Per-entry drop target state (using objects keyed by entry path) avoids the problem of a single boolean flag being shared across all entries, which would cause all items to highlight when dragging over any one of them.

---

## tauri-nweq: Cross-Window Drag Doesn't Refresh Source Window

**Key takeaways:**

- The HTML5 `dragend` event fires on the source element regardless of whether the drop target is in the same window, a different window, or even a native file manager. Use `ondragend` to clean up drag state and trigger a refresh of the source pane's directory listing.
- Both `FileItem.svelte` (details view) and `FileList.svelte` (list/tiles views) need the `ondragend` handler — same view-mode parity issue as context menus and drag-start.

---

## tauri-vmpc: Copy/Cut Freezes Window ($effect Infinite Loop)

**Key takeaways:**

- **Svelte 5 `$effect` + store mutation = infinite loop.** If an `$effect` calls a store method that internally reads `$state` (e.g., `toasts.filter(...)` for deduplication), Svelte tracks that `$state` as a dependency of the effect. When the store writes to the same `$state`, the effect re-runs, calling the store again — infinite loop.
- **Prefer imperative toast calls over reactive watching.** Instead of `$effect(() => { if (clipboardChanged) toastStore.show(...) })`, call `toastStore.show(...)` directly where the state change happens (e.g., inside `copyToClipboard()`). This is simpler, avoids reactive pitfalls, and makes the data flow explicit.
- **If you must call a store from `$effect`, wrap it in `untrack()`.** `untrack(() => toastStore.show(...))` prevents Svelte from tracking the store's internal reads as dependencies of the effect.
- **Synchronous Tauri commands block the main thread.** All Tauri 2 commands that do blocking I/O (subprocess spawning, file reads) should be `async fn` to run on a worker thread instead of the main thread.
- **Playwright + Chromium headless: `keyboard.press("Control+c")` hangs.** Chromium's native clipboard implementation blocks in headless mode. Use `page.evaluate(() => el.dispatchEvent(new KeyboardEvent(...)))` instead to test keyboard shortcuts that involve Ctrl+C/X/V.

---

## Mock `create_directory` Missing Duplicate Check

**Key takeaways:**

- The inline new folder input has both `onkeydown` (Enter) and `onblur` handlers that call `confirmNewFolder()`. When Enter triggers `createFolder()` → sets `isCreatingFolder = false` → removes the input from DOM → `onblur` fires → `confirmNewFolder()` runs a **second time**. In the real Tauri app the OS rejects the duplicate (`EEXIST`), so this is harmless. But the mock had no such guard, silently creating two entries with the same path.
- Duplicate entries with the same `path` break Svelte's `{#each ... (key)}` rendering (VirtualList uses `entry.path` as key). This causes the entire file list to stop responding to clicks — selection, context menus, and navigation all fail.
- Mock API handlers should mirror real backend error semantics (idempotency, conflict detection) to avoid hiding bugs that only manifest in test environments.
- When an `onblur` handler does the same work as an `onkeydown` handler (common pattern for "confirm on Enter or blur"), the blur will always fire redundantly when Enter removes the element from DOM. Either guard against double execution or make the operation idempotent.

---

## Enter Key Leaking Through Modal Dialogs to Global Command Handler

**Key takeaways:**

- The DeleteDialog handles Enter via `onkeydown` to confirm deletion, but doesn't call `stopPropagation()`. The Enter event bubbles up to `+page.svelte`'s global `handleKeydown`, which matches the `file.openSelected` command (shortcut: Enter) and calls `navigateTo()` on the selected entry — the very folder being deleted. This causes "Path not found" because `navigateInternal` tries to list the now-deleted directory.
- The fix is architectural, not per-dialog: the global command handler should skip execution when any modal dialog is open (`dialogStore.hasModalOpen`). This is cleaner than adding `stopPropagation()` to every dialog's keydown handler, and correctly models the semantic that modal dialogs should trap keyboard interaction.
- Hardcoded shortcuts like `Ctrl+,` (settings) and `Ctrl+\` (toggle dual pane) are handled **before** the modal guard, so they remain functional regardless of modal state.
- When debugging event propagation bugs, `console.trace()` in the affected handler immediately reveals the call chain — in this case showing `handleKeydown → executeCommand → file.openSelected → navigateTo` as the unexpected caller.

---

## tauri-lgo0: "Unable to access folder" After Deleting a Folder

**Key takeaways:**

- `refresh()` called `navigateInternal(currentPath)` without handling failure. If the current directory was deleted (by another pane, externally, or via the delete handler), the backend returns `AppError::NotFound` and the UI shows an error instead of recovering. Fix: make `refresh()` async and fall back to the parent directory when `navigateInternal()` returns `false`.
- `navigateAwayIfNeeded()` was a synchronous function that fire-and-forgot an async `navigateTo()` call. This meant the navigation hadn't completed before any subsequent `refresh()` or `refreshAllPanes()` could run, creating a race condition where the stale `currentPath` was used. Fix: make it `async` and `await` it in both callers (`startDelete` and `confirmDelete`).
- In multi-pane setups, deleting a folder from one pane doesn't notify other panes that may be viewing the deleted path. The `refresh()` fallback is the safety net for this scenario.
## tauri-usui: Theme Selector Dropdown Uses Browser-Default Colors

**Key takeaways:**

- Native `<select>` elements inherit CSS custom properties for the closed/collapsed state, but `<option>` elements inside the dropdown render with browser/OS default colors (white bg, black text) unless explicitly styled.
- Fix: add `.theme-select option { background: var(--background-solid); color: var(--text-primary); }` so options match the active theme.
- This is a common issue with Tauri/WebKitGTK — always explicitly style `<option>` elements when using native `<select>` in themed UIs.

---

## WebKitGTK Native Form Controls Ignore CSS Backgrounds on Dark Themes

**Key takeaways:**

- **WebKitGTK renders native `<select>` with its own opaque white background** underneath any CSS `background` you set. Translucent `rgba()` backgrounds (like `--control-fill: rgba(255,255,255,0.08)`) composite over that white base, making the select appear white/light on dark themes. This does NOT reproduce in headless Chromium — always test in the actual Tauri app.
- **Fix 1: `color-scheme: dark`** — Add `color-scheme: dark` (or `light`) to each theme's `[data-theme="..."]` rule. This tells WebKitGTK to use dark native form control colors as a baseline. This is inherited, so setting it on the theme selector cascades to all form elements. Should be standard practice for all themes.
- **Fix 2: `appearance: none`** — For full CSS control over `<select>` styling, use `appearance: none; -webkit-appearance: none;` to disable native widget rendering entirely. This requires adding a custom dropdown arrow (e.g., inline SVG via `background-image`). This gives consistent cross-engine results.
- **Both fixes together are ideal:** `color-scheme` ensures any native controls you missed still look right, while `appearance: none` on specific controls gives pixel-perfect theming.
- **Playwright headless Chromium cannot reproduce WebKitGTK rendering bugs.** When debugging Tauri UI issues, always verify in the actual app. Use Playwright for functional testing only.

---

## backdrop-filter Creates Visible Color Seams on Padding Areas

**Key takeaways:**

- **`backdrop-filter` does NOT apply to an element's padding area** — only the content/child area gets the filter. If a parent has `backdrop-filter: blur()` and `padding-top: 6px`, the padding strip shows raw background without the filter, creating a visible color seam on dark themes.
- **Fix: use a spacer div instead of padding.** A child `<div>` with matching `background` (e.g., `var(--background-card)`) sits inside the parent's content area where `backdrop-filter` applies, eliminating the seam. Only render the spacer when needed (no titlebar + no toolbar).
- **`border` on `<body>` with `border-radius` also creates visible strips.** The border interacts with rounded corners to produce a colored band along the top edge. Fix: replace `border` with `box-shadow: inset 0 0 0 1px var(--surface-stroke)` — same visual frame, no layout impact.
- **Debugging tip: use dramatic debug values** (e.g., `background: red`, `padding: 50px`) to confirm whether CSS changes are actually reaching the Tauri webview. WebKitGTK caches aggressively and `:global()` Svelte styles may not propagate reliably to child components in Tauri — prefer scoping changes to the component file that Tauri IS updating.
- **Tauri's WebKitGTK may not pick up changes to all Svelte component files equally.** During this investigation, `+page.svelte` changes reflected immediately but `SharedToolbar.svelte` changes did not, even after full `rm -rf node_modules && bun install && bun run tauri dev`. When styling cross-component, keep changes in the parent file that's known to update.

---

## tauri-mfjv / tauri-zf0z / tauri-zmjd / tauri-sa5i: List/Tiles View CSS Bugs

**Key takeaways:**

- **Icon shift on selection**: Caused by border-left changing from 1px to 2px. Fix: always use `border-left-width: 2px` with `border-left-color: transparent` by default, switch to colored on select. Same pattern for tiles bottom border.
- **Marquee selection mismatch in list view**: FileList reused details-view constants (32px header/item height) for list view, which has different layout. Fix: use DOM-based hit testing with `getSelectedIndicesFromDOM()` instead of mathematical calculation.
- **View mode parity**: Any change to interaction behavior (borders, selection, drag-drop) must be tested in ALL three view modes (details, list, tiles).

---

## tauri-31co: Transparent Column Headers

**Key takeaway:** `--background-card-secondary` is semi-transparent across all themes. For elements that need an opaque background (like sticky column headers), use `--background-solid` instead.

---

## tauri-zqdp: Paste Conflict Dialog

**Key takeaways:**

- **Promise-based dialog pattern**: `conflictResolver.prompt()` returns a Promise that resolves when the user clicks a button. The dialog component calls `conflictResolver.resolve()` to fulfill the promise. This cleanly separates the async control flow from the UI.
- **"Apply to all" tracking**: Track a `globalChoice` variable alongside the loop. When `applyToAll` is true, set `globalChoice` and skip prompting for subsequent entries.
- **Rust overwrite parameter**: Both `copy_entry` and `move_entry` accept `overwrite: Option<bool>`. When true, existing targets are deleted before the operation.

---

## tauri-vjly: Progress Bar for File Operations

**Key takeaways:**

- **Frontend-driven progress is sufficient** for file-count-level tracking. The paste loop already processes files one-by-one, so tracking `(i + 1) / total` gives meaningful progress without needing Rust-side streaming.
- **Existing infrastructure**: The `operationsManager` + `ProgressDialog` were already built but not wired. When adding progress tracking, check if UI components already exist before building new ones.
- **`estimateSize()` API**: Already existed for pre-calculating total bytes. Use it for byte-level progress display alongside file-count progress.

---

## tauri-nxfi: Path Autocomplete

**Key takeaways:**

- **Debounce is essential**: Without debouncing, every keystroke triggers a full directory listing. 150ms debounce balances responsiveness with performance.
- **Generation counter pattern**: Use an incrementing `fetchGeneration` counter to discard stale async results. Before applying results, check that `gen === fetchGeneration`.
- **`onblur` vs suggestion clicks**: `onblur` fires before `onclick` on suggestion items. Fix: use `onmousedown` on suggestions (fires before blur) and `event.preventDefault()` on the dropdown container to prevent focus loss.

---

## tauri-p09o: Include recent/frecency paths in Ctrl+P search

**Problem:** Ctrl+P QuickOpen only searched under `~` via the Rust backend. Paths outside home (e.g. `/tmp/delete-debug`) never appeared even if recently visited.

**Key takeaways:**

- **Client-side injection for supplementary results**: Rather than modifying the backend to support multiple search roots, inject matching entries from client-side stores (recentFilesStore, frecencyStore) directly into search results. Filter to paths outside the backend's search root to avoid duplicates.
- **Show results immediately, don't wait for streaming**: External matches should be injected at search start, not only inside the streaming event handler. If the backend is slow or unavailable, users still see relevant results instantly.
- **Separate collection from matching**: Split external candidate logic into `getExternalCandidates()` (collect + dedup) and `matchExternalCandidates()` (filter by query). Reusable and testable.

---

## tauri-jsn1.8: True window transparency on Linux (WebKitGTK) — BLOCKED

**Key takeaways:**

- **`WEBKIT_DISABLE_COMPOSITING_MODE=1` kills transparency but prevents ghosting**: Removing it enables alpha rendering but causes wry #1524 — stale frames accumulate on every interaction, making the window progressively opaque. No clean app-side workaround exists.
- **`WEBKIT_DISABLE_DMABUF_RENDERER=1` is safe**: Fixes DMA-BUF protocol errors without affecting rendering.
- **CSS `backdrop-filter: blur()` does NOT blur the desktop**: Only operates within the DOM stacking context.
- **Tauri `windowEffects`/`window-vibrancy` don't support Linux**: Windows/macOS only.
- **`hyprctl dispatch setprop` opacity doesn't persist across focus changes** on Hyprland 0.53.3 despite using `"active inactive"` syntax and `lock`.
- **Hyprland setprop syntax quirks**: `opacity` accepts space-separated `"active inactive"` values. Properties like `activeopacity`/`inactiveopacity` return "prop not found" on real windows despite accepting dummy addresses. Use `dispatch setprop` not `setprop` directly.

---

## tauri-8gpm: New Window Inherits from Last Focused Window

**Key takeaways:**
- All Tauri WebviewWindows share the same `localStorage` (same origin). This means `windowTabsManager.init()` was restoring the **parent's saved tab state** instead of using the child window's URL-provided path. The URL params (`?path=...&viewMode=...`) were completely ignored.
- Fix: child windows (those with `?path=` URL param) pass `skipRestore=true` to `init()`, creating a fresh tab at the intended path instead of restoring saved state.
- General lesson: in multi-window apps with shared localStorage, saved-state restoration logic must distinguish between cold starts (restore) and child windows (use provided params).

---

## tauri-vup6: UI Facelift - Premium Polish

**Key takeaways:**
- CSS `color-mix(in srgb, var(--accent) 8%, transparent)` is an effective way to create accent-tinted selection backgrounds that adapt to any theme's accent color, avoiding hardcoded RGBA values per theme.
- When doing a comprehensive CSS-only facelift (tokens + themes + components), all changes should flow through CSS custom properties. This keeps the blast radius contained — no JS changes needed, and themes just override the variables.
- `--radius-pill: 999px` for pill-shaped elements (search bars, breadcrumbs, scrollbar thumbs) provides a significant premium feel upgrade with minimal code change.
- Uppercase section labels (`text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px`) dramatically improve visual hierarchy in sidebars and column headers.
- Replacing `border-bottom` with `box-shadow` on toolbars/status bars creates softer, more premium edges.
- New theme creation: when adding a theme (Aurora), remember to add the `@import` in `index.css` — the theme auto-discovery reads `[data-theme="..."]` selectors from imported CSS.
- Multi-layer shadows (`--shadow-card`) add depth without being heavy. Each theme should define its own shadow intensity based on its background darkness.

---

## tauri-jsn1 (EPIC): Advanced Theme Engine

**Key takeaways:**
- CSS `color-mix(in srgb, var(--bg) calc(var(--opacity) * 100%), transparent)` is the best pattern for per-section transparency tokens. Each section (sidebar, toolbar, content, titlebar, statusbar) gets its own `--*-opacity` variable defaulting to 1.
- The `--theme-icon-pack` and `--theme-bg-animation` pattern works well: themes declare preferences via CSS variables, the app reads them with `getComputedStyle().getPropertyValue()`. User settings override theme suggestions.
- Canvas-based animated backgrounds must handle: `requestAnimationFrame` pause on `document.hidden`, window resize with `devicePixelRatio`, and `prefers-reduced-motion` media query.
- Tauri asset protocol requires `"assetProtocol": { "scope": { "allow": ["**"] } }` in tauri.conf.json for loading local filesystem images in `<img>` or CSS `background-image`.
- When applying CSS blur to a background layer, extend the element beyond viewport edges (`inset: -20px`) to prevent transparent seams at the border.
- Window transparency on Linux/WebKitGTK is blocked by ghosting artifacts (wry #1524). `WEBKIT_DISABLE_COMPOSITING_MODE=1` prevents ghosting but blocks all transparency. No reliable workaround exists as of 2026-03.

---

### tauri-explorer-kxa9 — Marquee selection lag from tile card surfaces

- **`box-shadow` transitions on many elements are a performance killer.** When dozens of elements toggle state per frame (e.g. during marquee drag selection), animated `box-shadow` can't be GPU-composited and forces expensive CPU repaints on every frame.
- **`color-mix()` in frequently-toggled styles adds cost.** Per-element `color-mix()` on borders/backgrounds during rapid state changes compounds the repaint expense.
- **Git bisect is invaluable for CSS performance regressions.** The bug was not in the DOM hit-testing logic (initial suspicion) but in a styling commit — only bisecting across commits confirmed the real cause.
- **Keep tile/grid item styles minimal.** Avoid transitions on `box-shadow` and `transform` for elements that participate in bulk selection. Instant state changes are visually fine and much cheaper.

---

## tauri-explorer-9djf: Architecture Improvements (Tech Debt)

**Key takeaways:**
- **Tauri `#[tauri::command]` macro generates hidden `__cmd__*` items** at the module where the function is defined. When splitting a monolithic Rust file into submodules, `pub use` re-exports only re-export the function — not these hidden items. The `generate_handler![]` macro in `lib.rs` must reference the full submodule path (e.g., `files::file_ops::rename_entry`), and the submodules must be `pub`.
- **Svelte scoped styles don't affect child components.** When extracting view-specific templates into child components (e.g., ListView.svelte from FileList.svelte), CSS classes like `.cut` and `.in-clipboard` must be added to the new component — they won't inherit from the parent's stylesheet. E2E tests across all view modes caught this.
- **Always run ALL_VIEW_MODES=1 E2E tests** when refactoring view-mode-specific code. The default fast mode only tests details view, so regressions in list/tiles views go undetected.
- **Extracting shared composables pays off.** The `useInlineRename` composable eliminated ~80 lines of duplicated rename logic between FileItem and FileList. The `drop-operations.ts` module eliminated ~120 lines of duplicated drag-and-drop conflict resolution code.
- **Structured error serialization (`{kind, message}`)** is better than flat strings for frontend error handling. When changing serialization format, every `String(err)` in catch blocks becomes `[object Object]` — must update all 37 call sites simultaneously.

---

## tauri-explorer-ryv1: New Todo Batch (March 2026)

**Key takeaways:**
- **Same-dir paste conflict**: The `isSameDir` check in paste-operations.ts was gated on `isCut`, causing copy-to-same-dir to show the conflict dialog. The Rust `copy_entry` already handles this via `generate_copy_name()` — the fix was removing the `isCut &&` gate so same-dir copies skip the dialog.
- **Pruning stale entries**: localStorage stores (frecency, recent-files) never validated path existence. Added `check_paths_exist` Rust command for batch validation. Fire-and-forget pattern: call `pruneNonExistent()` when UI opens without awaiting.
- **Marquee selection performance**: `getBoundingClientRect()` on every tile per mousemove is expensive. Two-fold fix: (1) RAF-throttle the selection update, (2) cache item rects per drag session since items don't move during marquee.
- **highlight.js tree-shaking**: Use `highlight.js/lib/core` with individual language imports to avoid bundling all 190+ languages. Register extension aliases with `registerAliases()` for file-extension-based detection.
- **Space as preview toggle hotkey**: Spacebar conflicts with text input. Must add a `when` guard checking `document.activeElement.tagName !== "INPUT"` etc. to prevent firing during typing.

---

## tauri-explorer-ggbb: Ctrl+P Quick Open typing broken

**Key takeaways:**
- **Svelte 5 `$effect` + store mutation = infinite loop**: Calling `pruneNonExistent()` inside `$effect` reads the store's `$state(entries)` array, making it a reactive dependency. When prune modifies entries, the effect re-runs, resetting `query = ""`. Fix: wrap store calls in `untrack()`. This is a recurring Svelte 5 gotcha — always audit what a called function reads internally.

---

## tauri-explorer-zden: Resizable preview pane

**Key takeaways:**
- **Multiple `.resize-handle` elements**: When both sidebar and preview pane have resize handles with the same class, Playwright's strict mode fails. Scope locators to the parent: `page.locator(".preview-pane").locator(".resize-handle")`.
- **CSS resize pattern**: Use `mousedown`/`mousemove`/`mouseup` with `user-select: none` on the resizing state to prevent text selection during drag. Remove listeners in `mouseup` to avoid leaks.

---

## feat/preview-pane-polish: Preview Pane Visual Polish

**Key takeaways:**
- **`--subtle-fill-tertiary` is nearly invisible**: At `rgba(255, 255, 255, 0.04)`, it provides no meaningful visual differentiation. Use `--background-card-secondary` or `--subtle-fill-secondary` for visible surface distinction.
- **`color-mix()` for tinted badges**: `color-mix(in srgb, var(--accent) 12%, transparent)` creates a theme-aware tinted background that adapts to any accent color — useful for status badges and pills.

---

## User Theme `--font-family` Can Break Input Rendering in WebKitGTK

**Key takeaways:**
- Setting `--font-family: "JetBrains Mono", monospace` in a user theme CSS file caused input text and caret to become invisible in the command palette and address bar. Removing the variable restored normal behavior.
- The root cause: "JetBrains Mono" (plain) was not installed — only the Nerd Font patched variant "JetBrainsMono Nerd Font" (no space, different name). The CSS fell back to generic `monospace`, which triggered a WebKitGTK rendering bug where inputs lose their caret and typed text.
- **Always use the exact `fc-list` font family name** in CSS, not the upstream project name. Nerd Font variants use concatenated names (e.g., `"JetBrainsMono Nerd Font"` not `"JetBrains Mono"`).
- User theme CSS variables (`--font-family`, `--selection-bg`, etc.) defined in `[data-theme="..."]` selectors do cascade correctly to the app — the issue was purely a font resolution failure triggering a WebKitGTK input rendering bug.

---

## tauri-explorer-r5yc: Tilde expansion in QuickOpen and address bar

**Key takeaways:**
- **Async home directory**: `getHomeDirectory()` returns a promise. Cache the result in component state at init time rather than awaiting on each use.
- **QuickOpen path navigation**: If query starts with `/` or `~`, Enter should navigate directly instead of selecting a search result. Add the path-check before the result-selection logic.

---

## tauri-plugin-log `.target()` vs `.targets()` — Stdout Leaks in Release Builds

**Key takeaways:**
- **`tauri-plugin-log` v2 defaults include `Stdout`**: The `Builder::default()` starts with `[Stdout, LogDir]` as default targets.
- **`.target()` (singular) appends; `.targets()` (plural) replaces.** Calling `.target(TargetKind::Webview)` adds Webview to the existing defaults — you end up with Stdout + LogDir + Webview. To suppress stdout, you must use `.targets([...])` to replace the entire list.
- **`cfg!(debug_assertions)` was never the problem.** The guard was correct but irrelevant — stdout was coming from the default target list, not the conditional block.
- Three commits tried to fix this before finding the root cause. When a "simple" fix doesn't work, question the API semantics, not just the conditional logic.

---

## fix/context-menu-close-on-cut-copy: Context menu not closing after Cut/Copy

**Key takeaways:**
- **Consistency check for handlers**: When adding new context menu actions, always include `contextMenuStore.close()`. Most handlers had it, but `handleCut` and `handleCopy` were missed because they were added separately from the pattern established by `withSelectedEntry()`.

---
