/** Shared input ownership for built-in and contributed modal surfaces.
 * Storage is non-reactive: teardown must read current ownership, not Svelte's
 * snapshot from an earlier effect batch. Only the observable count is reactive. */
export function createModalOwnership() {
  const entries = new Set<{ close: () => void }>();
  let count = $state(0);
  function release(entry: { close: () => void }): void {
    entries.delete(entry);
    count = entries.size;
  }
  return {
    get hasOpen(): boolean { return count > 0; },
    register(close: () => void): () => void {
      const entry = { close };
      entries.add(entry);
      count = entries.size;
      return () => release(entry);
    },
    closeAll(): void {
      for (const entry of [...entries].reverse()) {
        // A rendered surface may release its registry owner synchronously.
        if (!entries.has(entry)) continue;
        release(entry); // Detach before a callback can recursively close others.
        try { entry.close(); } catch (error) { console.error("Modal close failed:", error); }
      }
    },
  };
}

export const modalOwnership = createModalOwnership();
