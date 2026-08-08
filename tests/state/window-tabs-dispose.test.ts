/**
 * Window-tab manager teardown must settle explorer cleanup before Vitest
 * closes its worker RPC channel (#611).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cleanup = vi.hoisted(() => ({
  resolve: null as (() => void) | null,
  resolveInitialLoad: null as (() => void) | null,
  started: vi.fn(),
  rejectFirst: false,
  deferFirstInitialLoad: false,
  destroyCalls: 0,
  initialLoadCalls: 0,
}));

vi.mock("$lib/state/explorer.svelte", () => {
  const startInitialLoad = () => {
    if (cleanup.deferFirstInitialLoad && cleanup.initialLoadCalls++ === 0) {
      return new Promise<void>((resolve) => {
        cleanup.resolveInitialLoad = resolve;
      });
    }
    return Promise.resolve();
  };
  return {
    createExplorerState: vi.fn(() => ({
      state: { currentPath: "" },
      initialLoad: vi.fn(startInitialLoad),
      navigateTo: vi.fn(startInitialLoad),
      destroy: () => {
        cleanup.started();
        if (cleanup.rejectFirst && cleanup.destroyCalls++ === 0) {
          return Promise.reject(new Error("first cleanup failed"));
        }
        return new Promise<void>((resolve) => {
          cleanup.resolve = resolve;
        });
      },
    })),
  };
});

import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";

describe("window-tabs disposal (#611)", () => {
  beforeEach(() => {
    cleanup.resolve = null;
    cleanup.resolveInitialLoad = null;
    cleanup.started.mockClear();
    cleanup.rejectFirst = false;
    cleanup.deferFirstInitialLoad = false;
    cleanup.destroyCalls = 0;
    cleanup.initialLoadCalls = 0;
  });

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

  it("waits for pending cleanup and initial load before propagating a cleanup failure", async () => {
    cleanup.rejectFirst = true;
    cleanup.deferFirstInitialLoad = true;
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    manager.splitPane("right");
    expect(cleanup.resolveInitialLoad).not.toBeNull();

    const disposed = manager.dispose() as unknown as Promise<void>;
    expect(cleanup.started).toHaveBeenCalledTimes(2);

    let settled = false;
    void disposed.catch(() => {
      settled = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);

    cleanup.resolve?.();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);

    cleanup.resolveInitialLoad?.();
    await expect(disposed).rejects.toThrow("first cleanup failed");
    expect(settled).toBe(true);
  });
});
