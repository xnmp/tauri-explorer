import { describe, it, expect, vi } from "vitest";
import { createHistoryChannel } from "$lib/state/shared-history";
import type { HistorySnapshot, HistoryMutation } from "$lib/domain/history";
const empty: HistorySnapshot = { recent: [], frecency: [] };
const operation: HistoryMutation = { type: "access", key: "/a", path: "/a", timestamp: 1 };
describe("native history channel", () => {
  it("migrates before ordered writes and flushes accepted work", async () => {
    const events: string[] = [];
    const channel = createHistoryChannel({ read: async () => { events.push("read"); return empty; }, mutate: async value => { events.push(value.type); }, seed: () => empty, native: () => true, reportError: vi.fn() });
    channel.enqueue(operation); channel.enqueue({ type: "clear", collection: "recent" });
    await channel.flush(); expect(events).toEqual(["read", "access", "clear"]);
    await channel.refresh(); expect(events).toEqual(["read", "access", "clear", "read"]);
  });
  it("does not apply an old read over newer optimistic work", async () => {
    let resolve!: (value: HistorySnapshot) => void;
    const read = vi.fn().mockResolvedValueOnce(empty).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const channel = createHistoryChannel({ read, mutate: vi.fn().mockResolvedValue(undefined), seed: () => empty, native: () => true, reportError: vi.fn() });
    const refreshed = channel.refresh();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    channel.enqueue(operation); resolve(empty);
    expect(await refreshed).toBeNull(); await channel.flush();
  });
  it("publishes synchronously before newer optimistic work and rejects its stale return value", async () => {
    const events: string[] = [];
    let reads = 0;
    let channel: ReturnType<typeof createHistoryChannel>;
    channel = createHistoryChannel({ native: () => true, seed: () => empty,
      mutate: async () => {}, reportError: vi.fn(), read: async () => {
        if (++reads === 2) queueMicrotask(() => queueMicrotask(() => {
          channel.enqueue(operation);
          events.push("new optimistic entry");
        }));
        return empty;
      },
    });
    expect(await channel.refresh(() => events.push("snapshot"))).toBeNull();
    expect(events).toEqual(["snapshot", "new optimistic entry"]);
    await channel.flush();
  });
  it("optional history failures do not reject flush or prevent later writes", async () => {
    const mutate = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(undefined);
    const channel = createHistoryChannel({ read: async () => empty, mutate, seed: () => empty, native: () => true, reportError: () => { throw new Error("logger unavailable"); } });
    channel.enqueue(operation); await expect(channel.flush()).resolves.toBeUndefined();
    channel.enqueue(operation); await channel.flush(); expect(mutate).toHaveBeenCalledTimes(2);
  });
  it("browser fallback never claims a native history read", async () => {
    const read = vi.fn(), mutate = vi.fn();
    const channel = createHistoryChannel({ read, mutate, seed: () => empty, native: () => false, reportError: vi.fn() });
    channel.enqueue(operation); expect(await channel.refresh()).toBeNull(); await channel.flush();
    expect(read).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
  });
});
