/**
 * Vitest global setup.
 * Provides minimal browser-like globals for tests running in Node environment.
 */

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
