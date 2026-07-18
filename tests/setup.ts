/**
 * Vitest global setup.
 * Provides minimal browser-like globals for tests running in Node environment.
 */

// Pin navigator.platform to a fixed, non-Windows/non-Mac value.
//
// LOCAL-ONLY FIX — do not remove without re-reading this comment.
//
// Node/Bun both now expose a built-in global `navigator` (added ~Node 21 /
// Bun) whose `.platform` reflects the REAL host OS, not a neutral/absent
// value like older runtimes. src/lib/domain/platform.ts's `isWindows` reads
// exactly this (`navigator.platform.startsWith("Win")`), and
// src/lib/state/explorer.svelte.ts uses `isWindows` to rewrite every
// navigated path to backslashes — correct for a real Windows Tauri build,
// but this suite's fixtures (e.g. tests/state/explorer.test.ts) use
// POSIX-style test paths ("/root", "/a", "/b", ...). On a Windows dev
// machine that made `isWindows` true here, silently mangling every fixture
// path to "\root" etc. and breaking the mocked directory-listing lookups —
// 6/6 failures in explorer.test.ts with `expected '' to be '/root'`. CI's
// ubuntu-latest runners report a Linux platform, so `isWindows` was always
// false there and the mismatch never surfaced (green CI, red locally, same
// commit). Pinning navigator.platform here makes unit tests OS-independent,
// matching CI regardless of the machine running them.
{
  const platform = "Linux x86_64";
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  if (nav) {
    Object.defineProperty(nav, "platform", { value: platform, configurable: true });
  } else {
    globalThis.navigator = { platform } as Navigator;
  }
}

// Provide a minimal localStorage stub for modules that check availability at import time.
// Individual tests can override via vi.stubGlobal if needed.
// Node 25 exposes a native empty localStorage global, so check for functional methods
// rather than just existence.
const existing = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
if (!existing || typeof existing.setItem !== "function") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  } as Storage;
}
