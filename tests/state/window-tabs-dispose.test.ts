/**
 * Window-tab manager teardown must settle explorer cleanup before Vitest
 * closes its worker RPC channel (#611).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cleanup = vi.hoisted(() => ({
  resolve: null as (() => void) | null,
  resolvers: [] as Array<() => void>,
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
          cleanup.resolvers.push(resolve);
        });
      },
    })),
  };
});

import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";
import { getCommitPanelStore } from "$lib/state/commit-panel.svelte";
import { getScmStore } from "$lib/state/scm.svelte";
import { queueGraphFileHistory, registerGraphFileHistoryHandler } from "$lib/state/git-graph-file-history";

describe("window-tabs disposal (#611)", () => {
  beforeEach(() => {
    cleanup.resolve = null;
    cleanup.resolvers = [];
    cleanup.resolveInitialLoad = null;
    cleanup.started.mockClear();
    cleanup.rejectFirst = false;
    cleanup.deferFirstInitialLoad = false;
    cleanup.destroyCalls = 0;
    cleanup.initialLoadCalls = 0;
  });

  it("restores pane resources fresh even when the persisted pane ID is reused", async () => {
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    const paneId = manager.activePaneId;
    const previousScm = getScmStore(paneId);
    getCommitPanelStore(paneId).setMessage("Draft from the previous session");
    queueGraphFileHistory(paneId, "previous-session.txt");
    manager.restoreFromState(manager.captureState());
    const history = vi.fn();
    const unregister = registerGraphFileHistoryHandler(paneId, history);
    try {
      expect(getCommitPanelStore(paneId).message).toBe("");
      expect(getScmStore(paneId)).not.toBe(previousScm);
      expect(history).not.toHaveBeenCalled();
    } finally {
      unregister();
      const disposed = manager.dispose();
      cleanup.resolvers.forEach((resolve) => resolve());
      await disposed;
    }
  });

  it("awaits SCM release as well as the explorer when disposing a pane", async () => {
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    let finishScm!: () => void;
    const release = vi.spyOn(getScmStore(manager.activePaneId), "destroy")
      .mockImplementation(() => new Promise<void>((resolve) => { finishScm = resolve; }));
    const disposed = manager.dispose();
    let settled = false;
    void disposed.then(() => { settled = true; });
    cleanup.resolvers.forEach((resolve) => resolve());
    try {
      expect(release).toHaveBeenCalledOnce();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      finishScm?.();
      await disposed;
    }
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

  it("shares teardown started without awaiting with a later test drain", async () => {
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    // Let the initial load settle so only the deferred explorer cleanup can
    // keep the second disposal pending.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    void manager.dispose();
    const drained = manager.dispose();
    let settled = false;
    void drained.then(() => {
      settled = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);

    cleanup.resolve?.();
    await expect(drained).resolves.toBeUndefined();
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

  it("keeps disposal pending for cleanup started by closing a pane", async () => {
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    manager.splitPane("right");
    manager.closePane();
    expect(cleanup.started).toHaveBeenCalledOnce();

    const disposed = manager.dispose();
    expect(cleanup.started).toHaveBeenCalledTimes(2);
    cleanup.resolvers[1]?.();

    let settled = false;
    void disposed.then(() => {
      settled = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);

    cleanup.resolvers[0]?.();
    await expect(disposed).resolves.toBeUndefined();
  });

  it("keeps disposal pending for cleanup started by collapsing panes", async () => {
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    manager.splitPane("right");
    manager.splitPane("down");
    manager.toggleDualPane();
    expect(cleanup.started).toHaveBeenCalledTimes(2);

    const disposed = manager.dispose();
    expect(cleanup.started).toHaveBeenCalledTimes(3);
    cleanup.resolvers[2]?.();

    let settled = false;
    void disposed.then(() => {
      settled = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);

    cleanup.resolvers[0]?.();
    cleanup.resolvers[1]?.();
    await expect(disposed).resolves.toBeUndefined();
  });

  it("reports a rejected cleanup started by closing a pane", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    manager.splitPane("right");
    cleanup.rejectFirst = true;
    manager.closePane();

    try {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(error).toHaveBeenCalledWith(
        "Failed to clean up removed explorer:",
        expect.objectContaining({ message: "first cleanup failed" }),
      );
    } finally {
      const disposed = manager.dispose();
      cleanup.resolve?.();
      await expect(disposed).resolves.toBeUndefined();
    }
  });

  it("reports replaced-explorer cleanup failures instead of leaking a rejection", async () => {
    cleanup.rejectFirst = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    manager.init("/home/user", true);

    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(error).toHaveBeenCalledWith(
      "Failed to clean up previous explorers:",
      expect.objectContaining({ message: "first cleanup failed" }),
    );

    const disposed = manager.dispose();
    cleanup.resolve?.();
    await expect(disposed).resolves.toBeUndefined();
  });

  it("propagates a replacement cleanup failure that overlaps disposal after draining remaining work", async () => {
    cleanup.rejectFirst = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    manager.init("/home/user", true);

    const disposed = manager.dispose();
    const outcome = expect(disposed).rejects.toThrow("first cleanup failed");
    cleanup.resolve?.();
    await outcome;
  });

  it("registers initialized managers for the shared test teardown drain", async () => {
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    const registry = (globalThis as typeof globalThis & {
      __tauriExplorerTestManagerRegistry?: Set<{ dispose(): Promise<void> }>;
    }).__tauriExplorerTestManagerRegistry;
    expect(registry).toContain(manager);

    const disposed = manager.dispose();
    cleanup.resolve?.();
    await disposed;
    expect(registry).not.toContain(manager);
  });
});
