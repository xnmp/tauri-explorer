# Architecture Review — 2026-07-04 (issue #155)

## Overall Assessment
The codebase is well-layered and disciplined for a project this size: pure `domain/`, reactive `state/`, a single IPC chokepoint (`api/files.ts`), and a genuinely clean plugin capability model. The main risks are concentrated in a few large stateful singletons and two duplicated subsystems (git status, view rendering) rather than pervasive rot. Most findings are maintainability tech-debt, not correctness bugs, and several already have tracking issues.

## P1 — Should address (highest impact-to-effort)

### 1. Two independent git-status backends (hidden duplication + drift risk)
`src-tauri/src/files/git_status.rs` shells out to the `git` CLI and parses `--porcelain -z` into `GitFileStatus`; `src-tauri/src/git.rs` uses libgit2 (`git2`) and produces a parallel `GitStatusCode` enum + `status_code()` mapper. Two status vocabularies, two repo-detection paths, two mappings that must be kept semantically identical. The frontend (`api/files.ts`) even declares both `GitFileStatus` and `GitStatusCode` as byte-identical string unions.
- **Change:** pick libgit2 as the single source of truth. Reimplement the per-directory badge query (`get_git_status`) as a thin projection over `git.rs`'s `git_status` summary, delete the CLI porcelain parser, and collapse the two enums into one type on both sides.

### 2. `window-tabs.svelte.ts` is doing too much (SRP) and leaks `any`
This ~950-line singleton owns tab CRUD, pane layout, persistence + v1→v2 migration, closed-tab stack, cross-window tear-off seeding, git-root title resolution, and tab-title disambiguation. It is the most-imported state module (73 call sites across 19 components) and carries all 7 `any` occurrences in `state/` (the `externalSeed` threading).
- **Change (incremental):** extract persistence+migration into `state/tab-persistence.ts`; extract git-root title resolution into `state/tab-titles.svelte.ts`; export and reuse `ExplorerSeed` from `explorer.svelte.ts` to delete every `any`. Leaves the manager as pure tab/pane orchestration (~400 lines).

### 3. Tabs are not a tagged union — impossible states representable (#56)
`PaneTab` carries `path`, `title`, and `explorerId` as flat strings; the live path actually lives in the explorer (`getTabLivePath` falls back to `tab.path`). This is the root cause of the `|| not ??` fallbacks and the v1-snapshot normalization helpers.
- **Change:** model a tab as `{ id; explorerId }` only (path/title derived from the explorer), or a discriminated union `{ kind: "live" } | { kind: "restoring"; path }`. Aligns with #56.

## P2 — Design concerns

### 4. View-mode rendering is triplicated (#128, #118)
`DetailsView`/`ListView`/`TilesView` repeat the same skeleton: identical `useItemInteractions`/`usePointerDrag` wiring, `useProgressiveRender` + visible-entry slicing, and the `ItemButton` + `EntryName` + `GitStatusBadge` inner block. `FileList.svelte` branches on `viewMode` in three places (marquee header height, marquee selection, scrollToSelected).
- **Change:** extract a `useFileView` composable (interactions + pointerDrag + progressive slice); push marquee-geometry differences behind a per-view descriptor (`{ itemSelector, scrollerSelector, headerHeight() }`). Unifying List/Tiles onto the Details virtualizer (#128) collapses two of the three.

### 5. `refresh-manager.ts` global module state vs. per-explorer refresh (#114)
`requestRefresh` keys on `dirPath` in module-global maps, while `explorer.svelte.ts` does its own generation-guarded refresh and `refreshAllPanes()` fans out separately — three refresh instigators, exactly what #114 tracks. The dedup lives in a global singleton no test can reset except `cancelPendingRefreshes()`.
- **Change:** make the refresh coordinator an injected collaborator of the explorer (like `pane-refresh.ts`), routing all three instigators through the per-pane `refresh()`.

### 6. Backend error handling is inconsistent across modules
`AppError` is the stated unified type, but `.unwrap()/.expect()` density varies wildly (git.rs, search.rs, file_ops.rs, thumbnails.rs, archive.rs). Commands that shell out (`terminal.rs`, `wallpaper.rs`, `clipboard.rs`) return ad-hoc `String` errors, so the frontend's `extractErrorKind` can never classify them.
- **Change:** finish the poisoned-lock recovery audit (#110 covered terminal/thumbnails/warm_pool); migrate shell-out modules to `AppError` so structured `kind` survives IPC.

## P3 — Improvement opportunities

- **IPC mock parity is manual and unverified.** No test asserts the mock-invoke command set matches `generate_handler!` in `lib.rs`, so a new command silently 404s browser E2E. Add a command-name parity test.
- **`fs-providers.ts` scheme collisions are silent** (last-writer-wins on the module-global map). Warn on collision.
- **`explorer.svelte.ts` `navigateInternal`** mixes the streaming-buffer micro-optimization with navigation logic; the throttled buffer belongs in `directory-listing.ts`.
- **`is_directory_empty` eager walk (#129):** fold `is_empty` into the directory listing payload lazily so Miller view doesn't fan out N invokes.
- **Plugin `events.listen` swallows all errors** (`.catch(() => {})`) — gate the silent catch on `!isTauri()`.

## What's working well
- **Plugin capability model** (`plugins/api.ts`): every side effect routes through a tracked `PluginContext` with reverse-order disposers; the activate/deactivate race is handled (`activating` map). Template for future extension surfaces.
- **Single IPC chokepoint** with uniform `ApiResult<T>` and structured `AppError` decoding; latched-positive Tauri detection.
- **Extracted-collaborator pattern** in `explorer.svelte.ts` keeps a large store testable without a god-object.
- **Rune discipline:** `$derived` for computed state; `$effect` reserved for genuine side effects.

## Recommended actions (prioritized)
1. Unify the two git-status backends onto libgit2; collapse `GitFileStatus`/`GitStatusCode` (P1-1).
2. Split `window-tabs.svelte.ts` into manager + persistence + titles modules; delete all `any` (P1-2).
3. Make `PaneTab` a tagged union / derive path from the explorer (P1-3, with #56).
4. Extract `useFileView` + per-view geometry descriptor; virtualize List/Tiles (P2-4, advances #118/#128).
5. Add a mock-invoke ⇆ `generate_handler!` command-parity test (P3).
6. Migrate shell-out modules to `AppError` (P2-6).
