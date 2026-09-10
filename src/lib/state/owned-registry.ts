/** Registration identity belongs to an invocation, even when values are reused.
 * Disposing an old registration must never remove its replacement. */
export function createOwnedRegistry<T>() {
  const entries = new Map<string, { value: T }>();
  return {
    register(id: string, value: T, replace = false): () => boolean {
      if (!replace && entries.has(id)) throw new Error(`Already registered: ${id}`);
      const entry = { value };
      entries.set(id, entry);
      return () => entries.get(id) === entry && entries.delete(id);
    },
    get(id: string): T | undefined { return entries.get(id)?.value; },
    values(): T[] { return [...entries.values()].map((entry) => entry.value); },
    delete(id: string): void { entries.delete(id); },
    clear(): void { entries.clear(); },
  };
}
