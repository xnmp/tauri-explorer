# Execution Plan: Directory Sizes in Status Bar & Details View

**Issue:** `tauri-explorer-spha`
**Priority:** P2
**Status:** Planning

---

## Overview

Display total file size in the status bar and individual directory sizes in the details view size column. All directory size calculations happen asynchronously in background threads with zero impact on UI responsiveness.

---

## Phase 1: Status Bar Total File Size (Frontend-Only)

**Effort:** Trivial — no backend changes needed.

File sizes for all visible files are already in memory (`displayEntries`). This is a pure `reduce()` over the array.

### Files to Modify

- **`src/lib/components/StatusBar.svelte`** (L17-18, L34-37)
  - Add a `$derived` that sums `entry.size` for all file entries (mirrors the existing `selectedSize` pattern at L20-26)
  - Display after the item count breakdown, e.g. `"42 items (12 folders, 30 files) — 1.2 GB"`
  - Only show when `totalSize > 0` to avoid displaying "0 bytes" for empty directories

- **`src/lib/domain/file.ts`** — `formatSize()` (L78-93)
  - No changes needed — already handles all size ranges correctly

### Constraints
- `reduce()` over 100k entries takes <1ms — no performance concern
- Reactively updates via `$derived` when entries change (filter, navigate, etc.)

---

## Phase 2: Backend — Async Directory Size Calculator

**Effort:** Medium. New Tauri command + event streaming infrastructure.

### Architecture

```
Frontend requests sizes     Backend spawns workers     Results stream back
for visible directories --> (Tokio tasks, max 4    --> via Tauri events
                             concurrent walks)          per-directory
```

Key design: follows the exact same pattern as `start_streaming_directory` (uses `TaskRegistry` for cancellation, emits events via `AppHandle::emit`).

### Files to Create

- **`src-tauri/src/files/dir_size.rs`** — New module for directory size calculation
  - `DirectorySizeEvent` struct: `{ session_id: u64, path: String, total_bytes: u64, file_count: u64 }`
  - `start_directory_sizes` command:
    - Accepts `paths: Vec<String>` (the directory paths to calculate)
    - Returns a `session_id` for event correlation and cancellation
    - Spawns a background thread that:
      1. Processes paths sequentially with a concurrency semaphore (max 4 concurrent walks)
      2. For each directory, walks recursively using `fs::read_dir` (iterator-based, not collecting into memory)
      3. Checks cancellation flag (`AtomicBool` from `TaskRegistry`) at each directory boundary
      4. Emits `"directory-size"` event per completed directory
      5. Skips permission-denied subdirectories silently (no error propagation)
  - `cancel_directory_sizes` command: cancels via `TaskRegistry`
  - Reuses existing `TaskRegistry` (`src-tauri/src/task_registry.rs`) — same pattern as streaming dir listing and search

### Files to Modify

- **`src-tauri/src/files/mod.rs`** (L1-4)
  - Add `pub mod dir_size;` declaration

- **`src-tauri/src/lib.rs`**
  - Register new commands: `start_directory_sizes`, `cancel_directory_sizes`

### Why Not Reuse `estimate_size`?

The existing `estimate_size` in `src-tauri/src/files/file_ops.rs` (L340-356) is:
- **Synchronous** — blocks the calling thread until all paths are walked
- **All-or-nothing** — returns one combined result, not per-directory
- **Non-cancellable** — no `AtomicBool` check, no `TaskRegistry` integration
- **Recursive via stack** — uses unbounded recursion (`estimate_path_size` calls itself) which could stack overflow on deeply nested directories

The new implementation should use an iterative approach (explicit stack or `walkdir` crate) and stream results per-directory.

### Backend Implementation Details

```rust
// Pseudocode for the walk — NOT collecting into Vec, purely iterator-based
fn calculate_dir_size(path: &Path, cancelled: &AtomicBool) -> Option<(u64, u64)> {
    let mut total_bytes: u64 = 0;
    let mut file_count: u64 = 0;
    let mut stack = vec![path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if cancelled.load(Ordering::Relaxed) {
            return None; // Cancelled — return immediately
        }
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // Permission denied, etc. — skip
        };
        for entry in entries.flatten() {
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                file_count += 1;
                total_bytes += metadata.len();
            }
        }
    }
    Some((file_count, total_bytes))
}
```

Key properties:
- **Iterative** — explicit stack, no recursion, no stack overflow risk
- **No allocation** — doesn't collect entries, processes inline
- **Cancellation check per directory** — responsive to cancellation even in deeply nested trees
- **Graceful error handling** — skips unreadable dirs, never fails

---

## Phase 3: Frontend — Directory Size Store & UI Integration

**Effort:** Medium. New reactive store + updates to FileItem and StatusBar.

### Files to Create

- **`src/lib/state/directory-sizes.svelte.ts`** — New reactive store
  - State: `Map<string, { totalBytes: number; fileCount: number } | 'loading'>` — maps directory path to its calculated size or loading sentinel
  - `requestSizes(directoryPaths: string[]): void` — sends paths to backend, sets entries to `'loading'`
  - `cancelAll(): void` — cancels active session
  - `getSize(path: string): { totalBytes: number; fileCount: number } | 'loading' | undefined` — lookup
  - `clear(): void` — resets on navigation
  - Listens for `"directory-size"` Tauri events, updates map reactively
  - Manages a single active session ID — new requests cancel previous ones automatically

- **`src/lib/api/files.ts`** — Add API wrappers
  - `startDirectorySizes(paths: string[]): Promise<ApiResult<number>>` — returns session ID
  - `cancelDirectorySizes(sessionId: number): Promise<ApiResult<void>>`

### Files to Modify

- **`src/lib/components/FileItem.svelte`** (L263-271 — size column)
  - For directories: look up size from `directorySizesStore.getSize(entry.path)`
    - `undefined` → show "—" (not yet requested)
    - `'loading'` → show subtle "..." or small spinner
    - `{ totalBytes }` → show `formatSize(totalBytes)` with distinct style (lighter color or `~` prefix)
  - Keep the existing file size display unchanged

- **`src/lib/components/DetailsView.svelte`** (wraps FileItem in VirtualList)
  - No direct changes needed — FileItem handles its own size display
  - VirtualList already handles viewport-aware rendering

- **`src/lib/components/StatusBar.svelte`**
  - Add total of all visible file sizes (Phase 1)
  - Optionally: once directory sizes are available, include them in the total (clearly marked as approximate)

- **`src/lib/components/PreviewPane.svelte`** (L194-200)
  - For selected directories: show calculated size if available
  - Show "Calculating..." while loading

### Viewport-Aware Size Requests

The key UX question: *when* do we request directory sizes?

**Approach:** Request sizes for all directories in the current listing when the listing loads. This is simpler than viewport tracking and the backend concurrency limit (4 walks) naturally throttles I/O.

**Why not viewport-aware?** The VirtualList (`src/lib/components/VirtualList.svelte`) only renders visible items, but we want sizes for sorting and status bar totals. Viewport-limiting would mean sort-by-size can't work for off-screen directories. The concurrency limit is sufficient protection.

**Trigger point:** In `explorer.svelte.ts`, after `navigateInternal` completes successfully (L140-165):
1. Extract directory paths from the loaded entries
2. Call `directorySizesStore.requestSizes(dirPaths)`
3. The store handles cancelling previous sessions automatically

### Navigation Cancellation

- **`src/lib/state/explorer.svelte.ts`** — `navigateInternal()` (L125-171)
  - At the start of navigation (before loading), call `directorySizesStore.cancelAll()`
  - After entries load, request sizes for the new directory's subdirectories
  - This ensures navigating away instantly cancels all in-flight walks

---

## Phase 4: Sorting by Directory Size

**Effort:** Low — once sizes are available.

### Files to Modify

- **`src/lib/domain/file.ts`** — `sortEntries()` (L32-59)
  - Currently sorts directories by size=0, meaning they're all equal
  - Needs access to calculated directory sizes for meaningful sort
  - Options: pass a size lookup function, or augment `FileEntry` with an optional `calculatedSize` field
  - **Recommended:** Pass a `getSizeOverride?: (path: string) => number | undefined` parameter to `sortEntries`. When present, use it instead of `entry.size` for comparison. This keeps `FileEntry` immutable and domain-pure.

- **`src/lib/state/explorer.svelte.ts`** — `displayEntries` derivation (L104-111)
  - Pass the size store lookup to `sortEntries` when sortBy === "size"

---

## Phase 5: Cache & Invalidation (Nice-to-Have)

**Effort:** Low-medium.

### Design

- Cache computed sizes in the `directory-sizes` store (already a `Map`)
- Invalidate when filesystem changes are detected:
  - **`src/lib/state/file-events.ts`** — `broadcastFileChange` already broadcasts affected directories
  - Listen for these events in the directory sizes store and clear affected entries
  - Optionally re-request sizes for invalidated directories if they're in the current listing

### Files to Modify

- **`src/lib/state/directory-sizes.svelte.ts`** — Add invalidation logic
  - Subscribe to file change events
  - Clear cached sizes for affected directories and their parents
  - Re-request if the affected directory is in the current listing

---

## UX Specification

### Visual Design

| State | Size Cell Display | Style |
|-------|------------------|-------|
| File | `1.2 MB` | Default (`--text-tertiary`) |
| Directory — not yet loaded | `—` | Faded (`opacity: 0.3`) |
| Directory — loading | `...` | Faded, maybe subtle pulse animation |
| Directory — loaded | `~1.2 GB` | Slightly lighter than file sizes, `~` prefix indicates calculated/recursive |
| Directory — failed | `—` | Same as not loaded (silent failure) |

### Status Bar

```
Before: "42 items (12 folders, 30 files)"
After:  "42 items (12 folders, 30 files) — 1.2 GB"
                                           ^^^^^^ sum of visible file sizes
```

With selection:
```
"42 items (12 folders, 30 files) — 1.2 GB | 3 selected (45.2 MB)"
```

### Preview Pane (Directory Selected)

```
Size        ~2.3 GB (1,247 files)
Modified    2024-03-15 14:30
```

Or while calculating:
```
Size        Calculating...
Modified    2024-03-15 14:30
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Huge directory (e.g. `/usr`) takes minutes to walk | Concurrency limit (4) prevents I/O saturation. User navigates away → instant cancellation. Size appears progressively — no waiting. |
| Stack overflow on deeply nested dirs | Iterative walk with explicit stack (no recursion) |
| Memory pressure from walk | Iterator-based, no full collection into memory |
| Race conditions (navigate while calculating) | Single session ID — new navigation cancels previous session. `TaskRegistry` ensures clean cancellation. |
| Permission errors mid-walk | Silently skip unreadable subdirectories |
| Network/FUSE mounts stalling | Cancellation check per directory boundary. If a single `read_dir` hangs, the thread is blocked but UI is unaffected (it's a background thread). Could add per-directory timeout in future. |
| Too many Tauri events flooding frontend | One event per directory (not per file). Even 500 subdirectories = 500 small events, trivially handled. |

---

## Implementation Order

1. **Phase 1** — Status bar total file size (5 min, frontend only, immediate value)
2. **Phase 2** — Backend async calculator (core infrastructure)
3. **Phase 3** — Frontend store + UI integration (makes directory sizes visible)
4. **Phase 4** — Sort by directory size (small enhancement once data flows)
5. **Phase 5** — Cache invalidation (polish)

Each phase is independently shippable and testable.

---

## File Reference Summary

### Backend (Rust)
| File | Role | Changes |
|------|------|---------|
| `src-tauri/src/files/dir_size.rs` | **NEW** — Async directory size calculator | Create |
| `src-tauri/src/files/mod.rs` | Module declarations, `metadata_to_entry` | Add `pub mod dir_size` |
| `src-tauri/src/files/file_ops.rs` | Existing `estimate_size` (won't reuse) | None |
| `src-tauri/src/task_registry.rs` | Cancellable task registry | None (reuse as-is) |
| `src-tauri/src/lib.rs` | Command registration | Register new commands |

### Frontend (Svelte/TypeScript)
| File | Role | Changes |
|------|------|---------|
| `src/lib/state/directory-sizes.svelte.ts` | **NEW** — Reactive directory size store | Create |
| `src/lib/api/files.ts` | API client for Tauri commands | Add 2 wrapper functions |
| `src/lib/components/StatusBar.svelte` | Status bar display | Add total file size |
| `src/lib/components/FileItem.svelte` | File row in details view | Show directory sizes |
| `src/lib/components/PreviewPane.svelte` | Preview pane info | Show directory size |
| `src/lib/components/DetailsView.svelte` | Details view container | No changes expected |
| `src/lib/domain/file.ts` | Domain types and `formatSize` | Add size override to `sortEntries` |
| `src/lib/state/explorer.svelte.ts` | Explorer state management | Trigger size requests on navigate |
| `src/lib/state/directory-listing.ts` | Streaming directory loader | No changes expected |
| `src/lib/state/file-events.ts` | Cross-window file change events | Size store subscribes to these |
