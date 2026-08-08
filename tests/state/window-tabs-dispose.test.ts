/**
 * Window-tab manager teardown must settle explorer cleanup before Vitest
 * closes its worker RPC channel (#611).
 */
import { describe, expect, it, vi } from "vitest";

const cleanup = vi.hoisted(() => ({
  resolve: null as (() => void) | null,
  started: vi.fn(),
}));

vi.mock("$lib/state/explorer.svelte", () => ({
  createExplorerState: vi.fn(() => ({
    state: { currentPath: "" },
    initialLoad: vi.fn(),
    navigateTo: vi.fn(),
    destroy: () =>
      new Promise<void>((resolve) => {
        cleanup.started();
        cleanup.resolve = resolve;
      }),
  })),
}));

import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";

describe("window-tabs disposal (#611)", () => {
  it("does not settle until every explorer's asynchronous cleanup finishes", async () => {
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);

    const disposed = manager.dispose() as unknown as Promise<void>;
    expect(disposed).toBeInstanceOf(Promise);
    expect(cleanup.started).toHaveBeenCalledOnce();

    let settled = false;
    void disposed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    cleanup.resolve?.();
    await disposed;
    expect(settled).toBe(true);
  });
});
