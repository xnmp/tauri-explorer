# Session Handover

Continuing work on fixing the mock API detection issue - mocked endpoints are being used by the Tauri app when they should only be used for browser E2E testing.

**Previous session summary:** Fixed P0 keyboard shortcuts bug (Caps Lock issue) and added Tauri API mocks for browser-based E2E testing. The mock detection has a bug where it may incorrectly use mocks in the actual Tauri app.

**Key context:**
- Branch: `feature/command-palette`
- The `isTauri()` check in `src/lib/api/mock-invoke.ts` uses `window.__TAURI__`
- The invoke selection happens at module load time (files.ts line 11), which may execute before Tauri injects `__TAURI__`
- Beads issue tracker: use `bd` CLI for issue management

**Current state:**
- Mock invoke works for E2E tests but incorrectly activates in Tauri app
- All unit tests pass (89 tests)
- TypeScript check passes (0 errors)

**The bug (files.ts line 11):**
```javascript
const invoke = isTauri() ? tauriInvoke : mockInvoke;
```
This runs at module load time. If `window.__TAURI__` isn't set yet, it falls back to mock.

**Next steps:**
1. Make the Tauri detection lazy (check on each invoke call, not at module load)
2. Alternative: Check `import.meta.env` or use Vite environment variables
3. Test that real Tauri app uses real invoke, browser uses mock

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
