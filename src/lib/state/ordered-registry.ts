import { createOwnedRegistry } from "./owned-registry";

/** Owned contributions presented by `order` (a plugin's list position), then
 *  by registration. Unordered contributions sort last. */
export function createOrderedRegistry<T>() {
  const registrations = createOwnedRegistry<{ value: T; order: number }>();
  return {
    register(id: string, value: T, order = Number.MAX_SAFE_INTEGER): () => boolean {
      return registrations.register(id, { value, order });
    },
    /** Array sort is stable, so equal orders keep registration order. */
    values(): T[] {
      return registrations.values()
        .sort((a, b) => a.order - b.order)
        .map(({ value }) => value);
    },
    clear(): void {
      registrations.clear();
    },
  };
}
