# Session Handover

**Previous session summary:** Fixed the mock API detection bug (tauri-explorer-5jci). The Tauri app was showing mock data instead of real filesystem data.

**Key context:**
- Branch: `feature/command-palette`
- Beads issue tracker: use `bd` CLI for issue management
- All unit tests pass (68 tests)
- TypeScript check passes

**FIXED: Mock API Detection Bug**

Root cause: The `isTauri()` function in `src/lib/api/mock-invoke.ts` was checking for `window.__TAURI__` (Tauri v1), but the project uses Tauri v2 which uses `window.__TAURI_INTERNALS__` instead.

The fix was a one-line change:
```typescript
// Before (Tauri v1):
return typeof window !== "undefined" && "__TAURI__" in window;

// After (Tauri v2):
return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
```

The TitleBar.svelte component already had the correct check, which served as a reference.

**Next steps:**
- Verify the fix by running `bun tauri dev` and checking that real filesystem data loads
- Address pre-existing E2E test failures (18 tests failing, unrelated to this fix)

---

## Architecture & Learnings

### Relevant Files for This Fix
```
src/lib/api/
├── files.ts          # API client - line 11 has the problematic invoke selection
├── mock-invoke.ts    # isTauri() detection and mock data
```

### The Problem in Detail
```typescript
// files.ts - CURRENT (buggy)
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isTauri, mockInvoke } from "./mock-invoke";

// This line executes at module load time
const invoke = isTauri() ? tauriInvoke : mockInvoke;

// mock-invoke.ts
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}
```

**Issue:** Tauri's `__TAURI__` global may not be injected until after the JS bundle starts executing, causing `isTauri()` to return `false` even in the Tauri app.

### Potential Fixes

**Option 1: Lazy evaluation (recommended)**
```typescript
// Make invoke a function that checks each time
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    return tauriInvoke<T>(cmd, args);
  }
  return mockInvoke<T>(cmd, args);
}
```

**Option 2: Use Vite environment variable**
```typescript
// vite.config.ts sets VITE_TAURI based on build target
const invoke = import.meta.env.VITE_TAURI ? tauriInvoke : mockInvoke;
```

**Option 3: Check for Tauri IPC**
```typescript
export function isTauri(): boolean {
  return typeof window !== "undefined" &&
         window.__TAURI_INTERNALS__ !== undefined;
}
```

### Testing Commands
```bash
bun run check          # TypeScript + Svelte check
bun run test:run       # Unit tests (should pass)
bun tauri dev          # Run actual Tauri app - verify real data loads
npx playwright test    # E2E tests - verify mock data loads
```

### State Management (for context)
```
src/lib/state/
├── explorer.svelte.ts   # Per-pane state, calls API functions
├── tabs.svelte.ts       # Tab management
└── ...other stores
```

The explorer state calls functions from `files.ts`, which uses the `invoke` variable. All API calls flow through this single point, so fixing it here fixes the entire app.
