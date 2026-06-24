# Deferred Windows Issues — 2026-06-11

> **RESOLVED 2026-06-14** (branch `windows`). Issues 1–7 below are all fixed, plus a
> marquee-under-zoom bug not in the original list (WebView2 is Chromium, which handles
> CSS `zoom` coordinates like WKWebView, not WebKitGTK — see `domain/zoom.ts` and
> `lessons_learnt.md`). The cfg-gated Windows clipboard/wallpaper backends compile only on
> the Windows CI runner (`e2e-tauri.yml`), not under a Linux `cargo check`. This file is
> kept for historical context.

Windows-specific findings from the comprehensive review, deferred by decision on 2026-06-11.
Everything else from the review is being fixed; these remain open. Windows is a CI target
(`e2e-tauri.yml` runs `windows-latest`), so these should be scheduled before any Windows release.

## 1. Path domain functions don't understand backslashes (critical)

`src/lib/domain/path.ts`

- `parentDir` (lines 44-47) only splits on `/`: `parentDir("C:\\Users\\foo")` → `"/"` (verified by execution). Up-navigation from any backslash path jumps to a bogus root.
- `parentDir("C:/Users")` → bare `"C:"` (line 46) — the exact malformed form `normalizePathInput`'s own doc comment (lines 12-14) says breaks downstream `..`/join logic. Drive-letter parents should yield `"C:/"`.
- `basename` (lines 57-62) ignores backslashes and returns the entire string for `"C:\\Users\\foo"`, breaking fuzzy filename weighting and copy/move naming.
- `normalizePathInput` (lines 20-27) handles only bare drive letters; UNC paths (`\\server\share`) and backslash separators pass through unnormalized.

**Fix sketch:** normalize `\` → `/` at the boundary (address bar input, backend responses) or make `parentDir`/`basename` separator-agnostic; handle `C:/` roots and UNC prefixes explicitly. Add unit tests with backslash/drive/UNC fixtures.

**Blast radius:** every consumer of these helpers — navigation, breadcrumbs, QuickOpen scoring, undo path reconstruction, copy naming. Fixing this unlocks issue 4 below.

## 2. Cross-device moves always fail on Windows

`src-tauri/src/files/file_ops.rs:221` — cross-device move detection compares `e.raw_os_error()` against `libc::EXDEV` (CRT errno 18). On Windows, `raw_os_error()` returns the Win32 `GetLastError()` code — `ERROR_NOT_SAME_DEVICE` = 17 — so the comparison is always false and **C:→D: moves return a raw IO error instead of falling back to copy+delete** (verified: `libc` is an unconditional dependency, this code compiles and runs on Windows).

**Fix sketch:** match on `std::io::ErrorKind::CrossesDevices` (stable since Rust 1.85) instead of raw OS codes, or `#[cfg(windows)]` compare against 17.

## 3. Search depth ranking broken on Windows

`src-tauri/src/search.rs:155-156` — depth is computed as `relative_path.matches('/').count() + 1`, but `strip_prefix` yields `\`-separated paths on Windows, so every entry counts as depth 1: the depth-ranking bonus is dead and the frontend-visible `relativePath` separator convention breaks.

**Fix sketch:** count `std::path::MAIN_SEPARATOR` or iterate `Path::components()`; normalize `relativePath` to `/` before serializing.

## 4. Hardcoded "/" path reconstruction in undo/redo and explorer

- `src/lib/domain/undo-operations.ts:64-71` — redo of rename/move reconstructs paths via `lastIndexOf("/")` + `"/"` joins; on backslash paths this yields `"/" + name` and issues API calls against garbage paths.
- `src/lib/state/explorer.svelte.ts:413-414,594-596` — `navigateAwayIfNeeded` and `createSymlinkForEntry` hardcode `"/"` separators.

**Status:** call sites are being migrated to the `domain/path` helpers as part of the current fix pass, so the remaining work collapses into issue 1 — once `parentDir`/`basename` are Windows-safe, these become correct for free.

## 5. Clipboard has no Windows implementation

`src-tauri/src/clipboard.rs` — the whole module shells out to `wl-paste`/`wl-copy`/`xclip` (Linux-only), yet all five clipboard commands are registered unconditionally. On Windows, copy/paste-files silently returns `false`/empty rather than an "unsupported" error.

**Fix sketch:** implement via the Windows clipboard `CF_HDROP` format (e.g. `clipboard-win` crate), or `#[cfg]`-gate and surface a clear unsupported error to the frontend.

## 6. Wallpaper has no Windows backend

`src-tauri/src/wallpaper.rs:23-58,261-263` — desktop-environment detection uses `which` over Linux/macOS tools only; Windows users always hit "Could not detect desktop environment".

**Fix sketch:** `SystemParametersInfoW(SPI_SETDESKWALLPAPER, …)` via the `windows` crate, or hide the menu entry on Windows until implemented.

## 7. Win-key (Meta) handling in keybindings

`src/lib/domain/keybinding-parser.ts` — the general Meta-modifier matching bugs (pure-Meta bindings unmatchable; `Ctrl+Meta+X` matching plain `Ctrl+X`) are being fixed in the current pass. Remaining Windows-specific work: decide intended semantics for the Win key (typically reserved by the OS), and add Windows-layout coverage for shifted-symbol bindings (`event.key` is layout-dependent, e.g. `Ctrl+Shift+1` → `"!"`).

## Related (fixed now, noted for context)

- Case-only renames (`foo` → `Foo`) were rejected on case-insensitive filesystems (Windows **and** macOS) — fixed in the current pass since it also affects macOS.
- `git status --porcelain` path parsing — fixed in the current pass; the fix uses `/`-separators as git always emits, so it is Windows-safe.

## Recommended approach when picking this up

1. Fix `domain/path.ts` first (issue 1) with a backslash/UNC/drive-letter unit-test suite — issues 3 and 4 partially collapse into it.
2. Fix the `EXDEV` comparison (issue 2) — one line plus a unit test.
3. Decide product scope for clipboard/wallpaper on Windows (implement vs. graceful unsupported).
4. Add a Windows path-handling test matrix to `tests/domain/path.test.ts` and extend the `e2e-tauri` Windows job with a navigation + move-across-drives smoke (needs a runner with two volumes, or mock at the command layer).
