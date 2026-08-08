/**
 * Per-pane SCM store disposal (#439).
 *
 * Pane ids are minted unique per pane creation and never reused, so the
 * `paneScmStores` map would grow one entry per pane ever opened unless the
 * store is disposed when its pane closes. These tests pin the disposal
 * contract: `disposeScmStore` frees a store, and the window-tabs close/collapse
 * paths keep the map bounded as panes and tabs come and go.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const directoryListing = vi.hoisted(() => ({
  load: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock("$lib/state/directory-listing", () => ({
  createDirectoryListing: () => ({
    load: directoryListing.load,
    cleanup: directoryListing.cleanup,
  }),
}));
import {
  getScmStore,
  disposeScmStore,
  scmStoreCount,
} from "$lib/state/scm.svelte";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";

beforeEach(() => {
  localStorage.clear();
  directoryListing.load.mockReset();
  directoryListing.cleanup.mockReset();
  directoryListing.load.mockResolvedValue({
    ok: true,
    path: "/home/user",
    entries: [],
    streaming: false,
  });
  directoryListing.cleanup.mockResolvedValue(undefined);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(times = 10) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("disposeScmStore", () => {
  it("frees the store and drops the map entry", () => {
    const before = scmStoreCount();
    getScmStore("pane-dispose-a");
    expect(scmStoreCount()).toBe(before + 1);

    disposeScmStore("pane-dispose-a");
    expect(scmStoreCount()).toBe(before);
  });

  it("is a no-op for a pane that never had a store", () => {
    const before = scmStoreCount();
    expect(() => disposeScmStore("pane-never-created")).not.toThrow();
    expect(scmStoreCount()).toBe(before);
  });

  it("re-creates a fresh store after disposal (ids never reused)", () => {
    const a = getScmStore("pane-dispose-b");
    disposeScmStore("pane-dispose-b");
    const b = getScmStore("pane-dispose-b");
    expect(b).not.toBe(a);
    disposeScmStore("pane-dispose-b");
  });
});

describe("window-tabs pane close disposes scm stores (#439)", () => {
  function freshManager() {
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    return manager;
  }

  it("waits for a pane's initial directory load before teardown", async () => {
    const load = deferred<{
      ok: true;
      path: string;
      entries: [];
      streaming: false;
    }>();
    directoryListing.load.mockReturnValueOnce(load.promise);
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    await flush();

    const disposal = manager.dispose();
    let settled = false;
    void Promise.resolve(disposal).then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);

    load.resolve({
      ok: true,
      path: "/home/user",
      entries: [],
      streaming: false,
    });
    await expect(disposal).resolves.toBeUndefined();
  });

  it("waits for every explorer cleanup before reporting a cleanup failure", async () => {
    const cleanup = deferred<void>();
    const manager = freshManager();
    manager.splitPane("right");
    await flush();
    directoryListing.cleanup
      .mockRejectedValueOnce(new Error("first cleanup failed"))
      .mockReturnValueOnce(cleanup.promise);

    const disposal = manager.dispose();
    let settled = false;
    void disposal.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await flush();
    expect(settled).toBe(false);

    cleanup.resolve();
    await expect(disposal).rejects.toThrow("first cleanup failed");
  });
  it("closePane disposes the closed pane's scm store", async () => {
    const manager = freshManager();
    manager.splitPane("right");
    const [p0, p1] = manager.activePaneIds;

    getScmStore(p0);
    getScmStore(p1);
    const baseline = scmStoreCount();

    manager.closePane(); // closes the focused (second) pane
    expect(scmStoreCount()).toBe(baseline - 1);

    // Clean up the survivor so the module map returns to its prior size.
    for (const id of manager.activePaneIds) disposeScmStore(id);
    await manager.dispose();
  });

  it("collapsing dual pane disposes the removed panes' stores", async () => {
    const manager = freshManager();
    manager.splitPane("right");
    manager.splitPane("down");
    for (const id of manager.activePaneIds) getScmStore(id);
    const baseline = scmStoreCount();
    expect(manager.activePaneIds.length).toBe(3);

    manager.toggleDualPane(); // collapse to the focused pane only
    // Two panes removed → two stores disposed.
    expect(scmStoreCount()).toBe(baseline - 2);

    for (const id of manager.activePaneIds) disposeScmStore(id);
    await manager.dispose();
  });

  it("keeps the store map bounded across repeated open/close churn", async () => {
    const manager = freshManager();
    const baseline = scmStoreCount();

    for (let i = 0; i < 25; i++) {
      manager.splitPane("right");
      for (const id of manager.activePaneIds) getScmStore(id);
      manager.closePane();
    }

    // Only the single surviving pane's store may remain.
    expect(scmStoreCount()).toBeLessThanOrEqual(baseline + 1);

    for (const id of manager.activePaneIds) disposeScmStore(id);
    await manager.dispose();
  });
});
