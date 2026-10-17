import { expect, it, vi } from "vitest";
import { createPaneWatch } from "$lib/state/pane-watch";
import { createPathWatch } from "$lib/state/directory-watch";
import type { DirectoryWatchLease } from "$lib/api/files";
import type { requestRefresh } from "$lib/state/refresh-manager";
function harness() {
  const held = new Map<string, DirectoryWatchLease>();
  let peak = 0;
  const calls: { cb: Parameters<typeof requestRefresh>[0]; path: string; observedAt?: number; origin?: string }[] = [];
  const refreshed: string[] = [];
  const watch = createPaneWatch({
    refresh: async () => {}, refreshPath: async path => { refreshed.push(path); },
    subscribe: () => ({ ready: async () => {}, stop: () => {} }), prepare: async () => {},
    createWatch: () => createPathWatch({
      watch: async path => { const lease = { id: crypto.randomUUID(), path }; held.set(lease.id, lease); peak = Math.max(peak, held.size); return lease; },
      unwatch: async lease => { held.delete(lease.id); },
    }),
    schedule: (cb, path, _silent, _key, observedAt, origin) => { calls.push({ cb, path, observedAt, origin }); },
  });
  return { watch, calls, refreshed, held, peak: () => peak };
}
it("owns only newest 16 nonrecursive peek leases and retires before promoting replacements", async () => {
  const h = harness();
  try {
    const paths = Array.from({ length: 17 }, (_, i) => `/r/${i}`);
    h.watch.reconcilePeeks(paths, new Map(paths.map((p, i) => [p, i])));
    await vi.waitFor(() => expect(h.calls).toHaveLength(17));
    expect([...h.held.values()].map(l => l.path)).not.toContain("/r/0"); expect(h.held.size).toBe(16);
    h.watch.refreshPeeks(false);
    expect(h.calls.at(-1)?.path).toBe("/r/0");
    const stale = h.calls.find(c => c.path === "/r/16")!;
    h.watch.reconcilePeeks(paths.slice(0, 16), new Map(paths.map((p, i) => [p, i])));
    await vi.waitFor(() => expect([...h.held.values()].some(l => l.path === "/r/0")).toBe(true));
    expect(stale.cb({ silent: true })).toBe(false); expect(h.peak()).toBe(16);
    expect(h.calls.filter(call => call.path === "/r/0")).toHaveLength(3); // initial, fallback and post-acquisition scan
  } finally { await h.watch.destroy(); }
  expect(h.held.size).toBe(0);
});
it("routes exact child observations and retains original observation time and mutation origin", async () => {
  const h = harness();
  try {
    h.watch.reconcilePeeks(["/r/a"], new Map([["/r/a", 1]]));
    h.watch.changed({ path: "/r/a", observedAt: 123, origin: "mutation" });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0]).toMatchObject({ path: "/r/a", observedAt: 123, origin: "mutation" });
    await h.calls[0].cb({ silent: true }); expect(h.refreshed).toEqual(["/r/a"]);
    h.watch.invalidatePeeks(); expect(h.calls[0].cb({ silent: true })).toBe(false);
  } finally { await h.watch.destroy(); }
});
it("releases a lease returned after collapse, without reviving its refresh subscriber", async () => {
  let acquire!: (lease: DirectoryWatchLease) => void;
  const release = vi.fn(async () => {});
  const refreshPath = vi.fn();
  const watch = createPaneWatch({ refresh: async () => {}, refreshPath,
    subscribe: () => ({ ready: async () => {}, stop: () => {} }), prepare: async () => {},
    createWatch: () => createPathWatch({ watch: () => new Promise(resolve => { acquire = resolve; }), unwatch: release }),
  });
  watch.reconcilePeeks(["/r/a"], new Map([["/r/a", 1]]));
  await vi.waitFor(() => expect(acquire).toBeTypeOf("function"));
  watch.reconcilePeeks([], new Map()); acquire({ id: "late", path: "/r/a" });
  await watch.destroy(); expect(release).toHaveBeenCalledWith({ id: "late", path: "/r/a" }); expect(refreshPath).not.toHaveBeenCalled();
});
