# Comprehensive Codebase Review — 2026-06-11

Multi-agent review of the full codebase (10 specialist reviewers + 3 adversarial verification passes).
Scope: all of `src/` (~30k lines Svelte/TS), all of `src-tauri/src/` (~6.4k lines Rust), tests, e2e, CI, config, repo hygiene.

**Verification status legend:** ✅ = independently re-verified by an adversarial agent (several empirically, with scratch repos / executed snippets). Unmarked findings were verified once by the original reviewer tracing real code paths.

---

## Executive summary

The codebase is structurally healthier than its size suggests — the layering claimed in the docs is real (single enforced IPC boundary, pure `domain/`, consolidated file-transfer orchestration). The serious problems cluster in five places:

1. **Two confirmed data-loss bugs** in `file_ops.rs` overwrite handling, reachable from real drag-and-drop flows.
2. **A systemic emit-before-listen event race** between Rust streaming threads and frontend listeners — already discovered and fixed in QuickOpen (the comment documents it), but the same bug ships in directory listing and content search.
3. **Refresh/navigation races** in `explorer.svelte.ts`, including silent truncation of large directories to 100 entries on every watcher refresh.
4. **A safety net with holes**: type check currently fails, CI runs no unit tests / type check / clippy, and ~15 unit test files are tautological simulations that import no production code.
5. **Windows support is substantially broken** despite being a CI target: path domain functions, cross-device moves, clipboard, search depth ranking all fail on backslash paths or Win32 error codes.

---

## P0 — Critical: data loss / data corruption

- ✅ **[BUG] `src-tauri/src/files/file_ops.rs:199-216`** — `move_entry` with `overwrite=true` **permanently destroys the source** when source == target (moving an item into its own parent): `target = dest_dir.join(source_name)` equals the source path, so `remove_file`/`remove_dir_all(&target)` deletes the source before the rename, which then fails NotFound. **Reachable**: paste and tab-drop are guarded, but `use-drop-target.svelte.ts:52-57` (drop onto a folder entry, e.g. dropping a file onto its own parent folder shown in the other pane), `NavigationBar.svelte:152-159` (drop onto current-dir breadcrumb), and `use-pointer-drag.svelte.ts:150-155` only guard `sourcePath === targetPath` — `performFileTransfer` then finds the source itself as a "conflict", shows the overwrite dialog, and clicking Overwrite destroys the file. Fix: reject when canonicalized source == target before any removal, and add same-parent guards in the three frontend flows.
- ✅ **[BUG] `file_ops.rs:141-153`** — same hole in `copy_entry` with `overwrite=true`: source removed at 145-148, then the copy of the now-deleted source fails (file: NotFound; dir: source tree replaced by an empty dir). Reachable via the same drop flows with the copy modifier held.
- ✅ **[BUG] `file_ops.rs:145-148, 203-206`** — overwrite is **non-transactional**: the existing target is removed *before* the copy/rename, so any mid-operation failure (ENOSPC, permissions, unreadable source) irreversibly destroys the destination. Fix: copy to a temp name in the destination dir, then atomically swap.
- **[BUG] `src/lib/components/FileList.svelte:219,243`** — background drop guards use `target.closest(".file-item")`, but List/Tiles items render with classes `list-item`/`tile-item entry-item` (ItemButton.svelte:43), so in **List and Tiles views a drop onto a folder is handled twice**: once moving into the folder, then the bubbled drop moves the same source into the current directory. Same double-handling in `MillerColumns.svelte:346 vs 323`. Fix: match `.entry-item` or stopPropagation in `use-drop-target.svelte.ts:37`.
- **[BUG] `src-tauri/src/archive.rs:17,72`** — `compress_to_zip` / `extract_archive` are **sync commands**, so zipping/extracting large archives freezes the entire UI for the duration (violates the project's async-command rule). Several other commands share this (see P1 blocking cluster).

## P1 — High: wrong behavior users will hit

### Event races (systemic — one root cause, three sites)

- ✅ **[BUG] `src-tauri/src/files/dir_listing.rs:232-253` + `src/lib/state/directory-listing.ts:72-82`** — emit-before-listen race: the backend thread emits its first `directory-entries` chunk immediately (the 5ms sleep is *after* each emit), while the frontend registers its listener only after the invoke resolves — early chunks and even the `done` event are silently dropped for large directories (missing entries, stuck spinner). **QuickOpen.svelte:218-240 contains the smoking-gun comment** ("Must be called BEFORE starting the search… race: backend thread emits before invoke returns") — the team already hit and fixed this race there but not here.
- ✅ **[BUG] `src-tauri/src/content_search.rs:88-124` + `ContentSearchDialog.svelte:251-258`** — same race in content search: fast-completing searches lose results and leave `loading` stuck true, which permanently disables the Search button (`:407`).
- **Fix for all three**: register the listener (filtered by listing/search id) *before* invoking, as QuickOpen does — or have the backend wait for an ack.

### Navigation / refresh races

- ✅ **[BUG] `src/lib/state/explorer.svelte.ts:295,321`** — `refresh()` passes no-op `onEntries`/`onDone` to `dirListing.load`, but directories >100 entries return only the first batch in the invoke result and stream the rest — so **every watcher-triggered refresh of a large directory truncates the listing to 100 entries**, even when nothing changed.
- ✅ **[BUG] `explorer.svelte.ts:172-224`** — `navigateInternal` has no generation guard, no post-await path check, no abort: rapid A→B navigation applies whichever result resolves last (stale A clobbers B). The listingId guard in directory-listing.ts protects streamed chunks only, not the initial result.
- ✅ **[BUG] `explorer.svelte.ts:295-331`** — `refresh()` doesn't re-check `currentPath` after the await, so a watcher refresh racing a user navigation overwrites the new directory's listing with the old directory's contents and re-watches the old path.
- ✅ **[BUG] `src/lib/state/window-tabs.svelte.ts:228,279`** — `restoreFromState()`/`init()` call `explorers.clear()` without `destroy()` (unlike `closeTab`), leaking backend fs-watcher refcounts (fs_watcher.rs refcounts are explicit, so the OS watch lives forever); and `explorer.destroy()` (`:864`) never calls `dirListing.cleanup()`, leaking the Tauri event listener for every closed tab even on the correct path.

### Windows support (supported target, CI runs windows-latest)

- ✅ **[BUG] `src/lib/domain/path.ts:44-47`** — `parentDir` only splits on `/`: `parentDir("C:\Users\foo")` → `"/"` (verified by execution). Up-navigation jumps to a bogus root on Windows. `basename` (`:57-62`) returns the entire string for backslash paths, breaking fuzzy filename weighting and copy/move naming.
- ✅ **[BUG] `file_ops.rs:221`** — cross-device move detection compares `e.raw_os_error()` (Win32 `ERROR_NOT_SAME_DEVICE` = 17 on Windows) against `libc::EXDEV` (CRT errno 18), so **C:→D: moves always fail** instead of taking the copy+delete fallback. Use `io::ErrorKind::CrossesDevices`.
- **[BUG] `path.ts:46`** — `parentDir("C:/Users")` → bare `"C:"`, the exact malformed form `normalizePathInput`'s own doc says breaks downstream logic; UNC paths unhandled.
- **[BUG] `src/lib/domain/undo-operations.ts:64-71`** (+ `explorer.svelte.ts:413,594`, redo path reconstruction) — hardcoded `"/"` splits/joins on Windows backslash paths produce garbage API calls. Use the domain path helpers (once fixed).
- **[BUG] `src-tauri/src/search.rs:155-156`** — depth computed by counting `'/'`, but `strip_prefix` yields `\`-separated paths on Windows → every entry counts as depth 1, breaking depth ranking.
- **[DEBT] `src-tauri/src/clipboard.rs` / `wallpaper.rs`** — Linux-only implementations registered unconditionally; on Windows clipboard file ops silently return false/empty and wallpaper always errors.

### Git integration

- ✅ **[BUG] `src-tauri/src/files/git_status.rs:106-124`** — `git status --porcelain` prints **repo-root-relative** paths (verified in a scratch repo), but the code keys statuses by the first path segment and the frontend looks up by browsed-directory entry names — so **git badges only work at the repo root and vanish in every subdirectory**.
- ✅ **[BUG] `src-tauri/src/git.rs:46` vs `src/lib/api/files.ts:987`** — backend serializes `"Conflicted"`, TS union says `"Conflict"`: conflicted files in the SCM panel render a blank status letter with no color (ScmSidebarView's `statusLetter` switch has no default). The mock never emits it, so tests can't catch it.
- **[BUG] `git_status.rs:36-49`** — porcelain v1 quotes/octal-escapes non-ASCII paths by default (`core.quotepath=true`), so files with non-ASCII names never match — no badges. Use `-z` or `-c core.quotepath=false`.
- **[BUG] `git.rs:699-709`** — leading-edge-only 200ms debounce drops trailing events, so the final change in a burst (end of `git add -A`) never emits `git-status-changed` — stale UI.
- **[BUG] `git.rs:420`** — `repo.workdir().unwrap()` panics on bare repos, reachable from `git_stage`.
- **[BUG] `src/lib/state/git-status.svelte.ts:14-16,41-43`** — singleton store keyed by file name only: in dual-pane, the last fetch wins and same-named files in the other pane show wrong-directory badges.

### Search / content search

- ✅ **[BUG] `content_search.rs:232-260` + `content-search-flatten.ts:133-138`** — `matchStart`/`matchEnd`/`column` are UTF-8 **byte** offsets consumed as JS UTF-16 indices: highlights shift on any line with non-ASCII text before the match (verified empirically: `"héllo wörld match here"` highlights `"tch h"`).
- **[BUG] `content_search.rs:106-147`** — invalid regex (typed in regex mode) is swallowed: command returns Ok, empty `done` emitted, user sees "0 results" instead of an error.
- **[BUG] `content_search.rs:233-266`** — zero-width regex matches (`a*`, `()`) don't advance `byte_offset`: 50 duplicate matches at the same column per file.
- **[BUG] `content_search.rs:185-188`** — `MmapChoice::auto()`: a file truncated by another process mid-search raises SIGBUS and **crashes the whole app**; prefer `never()` for a long-lived GUI.
- **[BUG] `src/lib/domain/fuzzy-score.ts:27-43`** — lowercasing can change string length (Turkish `İ`), misaligning indices; verified crash: `fuzzyScore("̇", "İ")` throws. Also (`:96`) unclamped length penalty returns negative scores for genuine deep matches (verified: −0.42), which `score > 0` callers drop; and (`:71-78`) the non-consecutive max branch is dead code, discarding stronger matches.

### Keyboard / keybindings

- ✅ **[BUG] `src/lib/domain/keybinding-parser.ts:148-153`** — pure-`Meta+X` bindings can never match (`eventCtrl = ctrlKey || metaKey` makes the ctrl check fail), and `Ctrl+Meta+P` incorrectly matches a plain `Ctrl+P` binding. Currently dead-in-practice (no Meta bindings shipped; the recorder folds Meta into "Ctrl"), but it blocks ever shipping proper macOS Cmd bindings and Win-key combos trigger unrelated shortcuts.
- **[BUG] `src/routes/+page.svelte:101-120`** — hardcoded Ctrl+J / Ctrl+, / Ctrl+\ handlers run **before** the `isInputField || hasModalOpen` guard: they fire while typing in rename inputs or with modals open (Ctrl+, in a rename input opens Settings and blur-commits the rename).

### Rename / inline editing

- ✅ **[BUG] `file_ops.rs:67-72`** — case-only renames (`foo`→`Foo`) always rejected on case-insensitive filesystems (Windows/macOS): `target.exists()` sees the source itself.
- **[BUG] `src/lib/components/FileItem.svelte:59-61` + `ItemButton.svelte:55`** — `ondblclick` has no `isRenaming` guard: double-clicking to select a word inside the rename input opens the file / navigates into the folder mid-rename.
- **[BUG] `src/lib/components/EntryName.svelte:26-30`** — the focus `$effect` tracks entry identity, so any silent refresh during a rename (file watcher, other pane's dragend) wipes the user's typed name and re-selects.

### Other high

- **[BUG] `src-tauri/src/files/external_apps.rs:184-190`** — Linux `open_file` executes the desktop-file basename as a binary (`Command::new("org.gnome.TextEditor")`), not in PATH for most modern handlers, with no fallback — opening text files fails outright for GNOME-style defaults. Use `gio launch`/`gtk-launch` or fall back to `opener::open`.
- **[BUG] `src-tauri/src/config.rs:38-43`** — config writes are non-atomic `fs::write`: crash mid-write corrupts settings.json and the frontend silently falls back to defaults (user data loss). Write temp + rename.
- **[BUG] `src-tauri/src/clipboard.rs:61-84`** — percent-decoder pushes each byte as a Latin-1 char, mangling UTF-8: pasting files with non-ASCII names from other file managers yields wrong paths.
- **[BUG] `file_ops.rs:364-377`** — `estimate_path_size` follows symlinks with no cycle guard: `ln -s . self` causes exponential re-walking; uncancellable hang.
- **[BUG] `src/lib/components/TilesView.svelte:63-81`** — the progressive-render `$effect` reads `tileRenderLimit` which `renderMore` writes, so after the first rAF chunk it renders the entire directory in one frame — the chunking defeats itself.
- **[BUG] blocking cluster** — many commands run blocking work on the async runtime or are sync: `fuzzy_search` (walks 500k entries inline), `extract_archive`/`compress_to_zip`, `set_as_wallpaper` (incl. 200ms sleep), `config.rs` IO, `clipboard.rs` `Command::output()`, `external_apps.rs` (~4 sequential subprocesses), trash ops in `lib.rs`, `git_status.rs` subprocess calls, fs_extra copies in `file_ops.rs` (multi-GB copies tie up tokio workers, uncancellable despite task_registry existing). Fix pattern: async + `spawn_blocking` + cancellation flags.

---

## Security

Threat model note: the webview loads only local app code, so most of these are defense-in-depth — but they cost little to fix.

- **[HIGH] `src-tauri/src/nano_banana.rs:100-116`** — `source_path`/`output_path` interpolated **unquoted** into the `gemini --yolo /edit …` command string (the prompt *is* escaped, proving shell-like parsing): a path with a quote/space can inject directives into an auto-approving agent. Pass structured args.
- **[MEDIUM] `src-tauri/tauri.conf.json`** — `"csp": null` (no CSP at all) + asset protocol scope `["**/*", "$HOME/**/*"]` (entire filesystem readable via `asset://`). One missed escape anywhere becomes full file exfiltration. Set a restrictive CSP and narrow the asset scope.
- ✅ **[MEDIUM] `src-tauri/src/config.rs:27-43`** — `read/write_config_file(filename)` joins unvalidated: `../../.bashrc` escapes the config dir (absolute paths replace it entirely). Defense-in-depth (IPC already exposes `write_text_file`), but validate anyway.
- **[MEDIUM] `src-tauri/capabilities/default.json:14-15`** — `shell:allow-spawn`/`allow-execute` granted with no scope and no JS usage; remove.
- **[LOW]** macOS script injection via filenames containing quotes: `external_apps.rs:40-50` (JXA) and `wallpaper.rs:73-77` (AppleScript) — escape or pass via argv.
- **[LOW] `settings.svelte.ts:126` + config.rs** — Gemini API key stored in plaintext settings.json; consider OS keyring.
- **Clean:** zip-slip (proper `enclosed_name` + `starts_with` guard), both `{@html}` sinks (hljs + escapeHtml verified), git.rs (pure libgit2, no shell), no committed secrets (history scanned), API key passed via env not argv.

---

## P2 — Medium bugs (selected, all traced to source)

**State layer**
- `refresh-manager.ts:14-34` — `pendingRefreshes` keyed by path but closure captures one explorer: two panes viewing the same directory → only one refreshes.
- `conflict-resolver.svelte.ts:31-43` — single `pendingResolve` slot: concurrent conflict prompts (paste in one pane + drop in another) hang the first batch forever.
- `window-tabs.svelte.ts:18,111-113` — all windows share the `"explorer-tabs"` localStorage key: a child window clobbers the main window's saved layout.
- `frecency.svelte.ts:98-105` (+ recent-files) — prune-by-index against a pre-await snapshot: concurrent writes prune wrong entries.
- `thumbnail-cache.ts:13,28-42` — unbounded blob-URL cache; directory rename strands children's entries (never revoked).
- `undo.svelte.ts:77-81` — failed/partial undo pops and discards the action: mixed file state, no retry, no redo.
- `domain/diff.ts:63-75` — header prefixes tested before the `inHunk` guard: a removed line starting with `"-- "` corrupts oldPath and desyncs all gutter numbers (verified).
- `theme.svelte.ts:111-113` — legacy localStorage key permanently overrides an explicit "light" choice.

**Components**
- `use-marquee-selection.svelte.ts:180-191` — rect cache compensates against `.content` but the actual scroller is the inner view: wheel-scroll during marquee selects wrong indices in List/Tiles.
- `use-pointer-drag.svelte.ts:163` — macOS drop path passes `new Set()` as existingNames: conflict dialog bypassed entirely.
- `FileItem.svelte:35-38` — Details view omits `selectOnContextMenu`: right-click doesn't select the row (List/Tiles do) — view divergence.
- `ListView.svelte:57` — no virtualization/chunking at all: large directories freeze only in List mode.
- `WorkspaceDialog.svelte:120-126` — Enter in the rename input bubbles to the row handler: confirming a rename instantly restores that workspace, replacing all tabs.
- `ConflictDialog.svelte:26` — keydown on an unfocusable div: Escape can't cancel the conflict prompt; nothing auto-focused.
- `InlineNewFolder.svelte:49-59` — Enter + blur double-submit creates two concurrent createDirectory calls.
- `BulkRenameDialog.svelte:56-77` — breaks on first error but only refreshes on full success (stale view); no duplicate-target detection; state not reset between opens; dotfiles un-renameable.
- `ContentSearchDialog.svelte` — debounce not cleared on close (orphaned backend search); Enter opens stale result instead of re-searching after editing the query; QuickOpen.svelte:336-349 lacks scroll-into-view (only picker missing it); QuickOpen interleaved-debounce task leak.
- `PreviewPane.svelte:125-137` — diff stale-guard ignores the `staged` flag (stale diff on toggle); diff cache key uses section counts (misses content changes); diffs render unvirtualized (`ScmDiffView` has the same cache-key bug but no stale guard at all, `:33-46`).
- `ScmSidebarView.svelte:943` — hardcoded `#2a2d33` hover gradient renders a dark smear on light themes; status colors hardcoded in 3 places.
- `VirtualList.svelte:26,49-51` — `startIndex` not clamped when items shrink: blank viewport after bulk delete while scrolled deep.

**Backend**
- `thumbnails.rs:68-82` — non-atomic cache writes + no in-flight dedup: torn JPEGs served, duplicate decodes; (`:38-53`) cache key ignores sub-second mtime and length; no eviction ever.
- `archive.rs:124,168` — extraction silently overwrites existing files; symlink-following recursion (cycle → stack overflow); whole-file `read_to_end` (OOM on huge files); exec bits dropped; only `deflate` enabled (bzip2/zstd entries fail mid-extract).
- `fs_watcher.rs:105-113` — refcount incremented before `watch()` attempt: failure leaves a phantom entry, directory silently never watched again. Documented 300ms debounce doesn't exist (event storms during bulk ops).
- `dir_listing.rs:112-121` — cache grows past MAX_CACHE_ENTRIES when all entries are fresh.
- `lib.rs:97-118` — `restore_from_trash` silently skips unmatched paths, reports success.
- `wallpaper.rs:94-116` — rewrites the user's hyprpaper.conf destroying comments/multi-monitor config, pkills all hyprpaper, races a 200ms sleep.
- Pervasive exists-then-act TOCTOU in `file_ops.rs` (rename silently replaces concurrently-created targets); broken symlinks can't be deleted/renamed at all (`Path::exists()` follows links).

**API / mock parity**
- `mock-invoke.ts` missing handlers: `write_text_file`, `create_symlink`, `compress_to_zip`, `extract_archive`, `clipboard_has_image`, `watch_directory`/`unwatch_directory`, `set_window_theme` → these features throw "Unknown command" in browser E2E, so they're untestable there.
- `os-clipboard.ts:10` imports `invoke` directly from `@tauri-apps/api/core`, bypassing the mock wrapper: the mock's clipboard handlers are unreachable dead code; clipboard flows silently no-op in all E2E.
- Dead backend commands: `invalidate_dir_cache`, `get_config_dir`, `get_log_dir` (registered, never called).
- `files.ts:12-22` — `cachedIsTauri` latches on first invoke: an early call before `__TAURI_INTERNALS__` injection permanently sticks the real app on the mock.

---

## Architecture (prioritized)

**What's working — preserve:** single enforced IPC boundary (`invoke()` in exactly one file + uniform `ApiResult<T>`); pure `domain/` layer; consolidated `performFileTransfer` orchestration (paste/drop are thin wrappers — not duplicated); `refresh-manager` source dedup; clean Rust `AppError` mirroring the TS union; mostly shallow, acyclic store graph; no circular imports.

- **[P1] God store: `explorer.svelte.ts`** (766 lines, imports 15 sibling stores, ~40 public methods incl. non-pane concerns like `setAsWallpaper`/`openInTerminal`/`createSymlink`). Extract: `pane-watch.ts` (watch/refresh lifecycle), `pane-mutations.ts`, and move the command-actions to the command layer. Mostly mechanical — these are already near-free functions over `coreState`.
- **[P1] Two "active pane" access paths** — Svelte context (`pane-context.ts`) vs `windowTabsManager.getActiveExplorer()` singleton, used inconsistently across 11 components → ambiguous behavior in dual-pane mode. Pick one: context inside panes, singleton only for window-global features.
- **[P1] God components** — ScmSidebarView (1048: extract pure `domain/scm-tree.ts`, `ScmCommitBox`, `ScmFileRow`; the row-action cluster is copy-pasted 3×), ContentSearchDialog (923: extract a `useContentSearch` composable owning the IPC stream; reuse `VirtualList` instead of hand-rolled scroll math), QuickOpen (886: reuse `FileIcon` instead of ~160 lines of inlined SVG ×2).
- **[P1] No shared Modal primitive** — 11 hand-rolled overlay implementations, **no focus trap in any** (Tab walks out of every modal despite `aria-modal`), 3+ byte-identical style blocks, and the a11y warning pile in `bun run check` all trace here. One `Modal.svelte` (backdrop, Escape, focus containment, ARIA) fixes a dozen findings at once.
- **[P2] Duplicate git state** — `state/scm.svelte.ts` + `state/git-status.svelte.ts` both subscribe to `git-status-changed` and fetch overlapping data via separate IPC; one repo-status source should feed both.
- **[P2] Three parallel progress/job systems** (`operations`, `jobs`, Rust `task_registry`) — manageable now; unify the frontend two before the next long-running feature.
- **[P2] Two parallel DnD pipelines** (HTML5 + pointer-based) — platform-forced per MEMORY.md, but target-resolution and copy-modifier logic are each implemented twice; consolidate the shared parts.
- **[P2] `lib.rs` defines commands *and* registers everything** — move trash/window/log commands to a `system.rs` so lib.rs is pure wiring.
- **[P2] settings search via `$effect` + `querySelectorAll` + `style.display` mutation** (SettingsDialog.svelte:38-60) while the declarative helpers beside it are dead code.

---

## Tech debt, build, CI, hygiene

- **[HIGH] `bun run check` currently FAILS** — 3 errors: two stale `@ts-expect-error` directives in `vite.config.js` (convert to `.ts`) and missing types for `@chenglou/pretext` (add a `.d.ts` shim). Plus 28 warnings including 4 real reactivity bugs-in-waiting (`non_reactive_update` in InlineNewFolder/ScmSidebarView/ThemePicker, `state_referenced_locally` in ExplorerPane).
- **[HIGH] CI gap** — no workflow runs unit tests (430), type check, the 40-spec browser E2E suite, clippy (31 warnings, 24 auto-fixable), or rustfmt. Only e2e-tauri smoke, perf (path-filtered), release. Add a `ci.yml`: check → test → playwright → clippy -D warnings → fmt --check. Also: `e2e-tauri.yml` does `rm -f bun.lock && bun install` — lockfile never validated, builds unreproducible.
- **[HIGH] `.beads/` is dead but half-tracked** — project migrated to GitHub Issues; `.beads/` is gitignored yet 18 files remain tracked (335KB issues.jsonl + backups + hooks), locally 5MB incl. a 3.6MB Dolt DB, a nested git worktree, and a duplicated `.claude/` tree. `git rm -r --cached .beads`, clean `.gitattributes` merge-driver reference, delete the local dir (preserve anything canonical under `.beads/.claude/` first).
- **[MEDIUM] Repo junk** — tracked: `beads_report_…md` (390KB), `test-dnd.mjs` (one-off script), `Vagrantfile`, `playwright_tests.md`; untracked: `New folder/` (stray package.json), ~26MB of `.pkg.tar.zst` artifacts in root, `.dev-port`, `.abacus/`, `.perles/`, stale vitest timestamp file. `screenshots/` is 11MB / ~⅓ of repo pack weight and grows every merge — consider LFS or pruning merged branches' screenshots.
- **[MEDIUM] Dependencies** — unused npm packages: `@tauri-apps/plugin-opener`, `@tauri-apps/plugin-shell`, `tauri-plugin-clipboard-x-api` (JS bindings never imported); `perf:check` uses `npx tsx` with tsx unlisted (and violates bun-only); `typescript ~5.6` notably behind; Rust `dirs@5`/`notify@7` a major behind; full `regex` crate pulled in solely for `regex::escape`.
- **[MEDIUM] tsconfig** — `strict` is on but no `noUncheckedIndexedAccess` (heavy array indexing in virtual lists would benefit).
- **[LOW] Dead code** — `MillerColumn.svelte` contains only `// bogus` lines and is imported nowhere (delete); `CommandPalette.groupedCommands` derived never used; `DeleteDialog` error/shake block dead since toast refactor; `drop-operations.getDropSourcePath` unexported-able; knip unusable without config (add `knip.json` ignoring `src-tauri/**` + Svelte plugin).

---

## Test quality

- **[HIGH] ~15 of 39 unit test files are tautological simulations** importing zero production code — they re-implement the logic locally (or assert on literals) and pass regardless of any regression: `sidebar-cleanup` (asserts `"Bookmarks" !== "Quick Access"`), `titlebar-spacer`, `integrated-titlebar`, `git-status-display`, `mutation-cooldown`, `git-status-refresh`, `quickopen-scoring`, `undo-paste`, `multi-drag` (asserts JSON round-trips), `undo-window-close`, `chord-shortcuts` (hardcoded copy of the chord list), `conflict-dialog-details`, `scm-diff-no-blink`, `addressbar-filter`, `zoom-coordinates`/`responsive-nav`. Fix: extract the real rules (e.g. titlebar visibility from `+page.svelte`) into `domain/` functions and test those; delete the rest.
- **[HIGH] 201 `waitForTimeout` occurrences across 29 of 40 e2e specs** (incl. shared helpers) — the suite's flakiness budget. Replace with condition waits.
- **[HIGH] e2e-tauri smoke covers almost nothing** — exactly 2 assertions (titlebar visible, palette opens). It's the only place real IPC is exercised; add at least one file-op round-trip (create→rename→trash).
- **[MEDIUM]** Vacuous/weak e2e: `quickopen-debug.spec.ts:21-23` (assertion inside `if (visible)`), `git-status.spec.ts` (checks a settings label, never a badge), `selection.spec.ts` (9 silent runtime `test.skip()` escapes), `hook-test.spec.ts` (empty file).
- **Coverage gaps** — untested: 26+ of ~46 state stores (incl. directory-listing, operations, undo, scm, persisted — where this review found most bugs), 5/16 domain modules, 9/14 composables, and Rust `config.rs`, `task_registry.rs`, `fs_watcher.rs`, `git_status.rs`, `external_apps.rs`, `drives.rs`. Suite: 430/430 pass in 4.8s.
- **Mock fidelity** — e2e green ≠ working in Tauri for: DnD (synthetic), native file ops/trash, OS clipboard (bypasses mock entirely), git effects (stage/unstage/discard are no-op stubs), window management, fs-watch events, thumbnails, streaming search events (mock returns id, never emits).

---

## Suggested roadmap

**Phase 0 — stop the bleeding (days)**
1. Fix the two `file_ops.rs` data-loss bugs + non-transactional overwrite + frontend same-parent guards.
2. Fix the emit-before-listen race in directory-listing.ts and ContentSearchDialog (QuickOpen pattern already in-repo).
3. Fix `refresh()` 100-entry truncation + navigation generation guard + window-tabs destroy leaks.
4. Fix the List/Tiles double-drop (`.entry-item` guard).
5. Repo triage: `git rm --cached .beads` & friends, delete junk, convert vite.config to TS (un-breaks `bun run check`).

**Phase 1 — safety net (week)**
6. Add `ci.yml` (check, unit, playwright, clippy -D warnings, fmt) + `cargo clippy --fix`.
7. Delete/rewrite the 15 tautological test files; fix the vacuous e2e assertions; expand e2e-tauri smoke with one real file-op round-trip.
8. Add mock handlers for the 7 missing commands; route os-clipboard through the mock wrapper.

**Phase 2 — correctness burn-down (weeks)**
9. Windows pass: path.ts separators, EXDEV, search depth, undo path reconstruction (+ unit tests with backslash paths).
10. Git pass: subdirectory badges, Conflicted/Conflict, quotepath, trailing debounce, dual-store unification.
11. Blocking-command pass: spawn_blocking + cancellation for archive/copy/search/config/clipboard/external_apps.
12. Atomic-write pass: config.rs, thumbnails cache, archive cleanup-on-error.

**Phase 3 — structural (ongoing)**
13. Shared `Modal.svelte` with focus trap (kills ~12 findings).
14. Decompose explorer.svelte.ts, ScmSidebarView, ContentSearchDialog.
15. Unify active-pane access (context vs singleton); CSP + asset-scope hardening; nano_banana structured args.
