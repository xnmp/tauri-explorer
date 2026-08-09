import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  initFileChangeListener: vi.fn(),
  cleanupFileChangeListener: vi.fn(),
  gitRefresh: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("$lib/state/file-events", () => ({
  initFileChangeListener: mocks.initFileChangeListener,
  cleanupFileChangeListener: mocks.cleanupFileChangeListener,
}));
vi.mock("$lib/state/settings.svelte", () => ({
  settingsStore: { showGitStatus: false },
}));
vi.mock("$lib/state/git-status.svelte", () => ({
  gitStatusStore: { currentPath: "", refresh: mocks.gitRefresh },
}));

import { useFileWatchers } from "$lib/composables/use-file-watchers";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";

type TauriDirectoryEvent = { payload: { path: string; observed_at_ms?: number } };

describe("useFileWatchers refresh coalescing", () => {
  let broadcastHandler: ((dirs: string[]) => void) | undefined;
  let tauriHandler: ((event: TauriDirectoryEvent) => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    cancelPendingRefreshes();
    mocks.listen.mockReset();
    mocks.initFileChangeListener.mockReset();
    mocks.cleanupFileChangeListener.mockReset();
    mocks.gitRefresh.mockReset();
    broadcastHandler = undefined;
    tauriHandler = undefined;
    mocks.initFileChangeListener.mockImplementation((handler) => {
      broadcastHandler = handler;
    });
    mocks.listen.mockImplementation((_eventName, handler) => {
      tauriHandler = handler;
      return Promise.resolve(vi.fn());
    });
  });

  afterEach(() => {
    cancelPendingRefreshes();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ["Tauri directory watcher", () => tauriHandler?.({ payload: { path: "/slow" } })],
    ["cross-window file watcher", () => broadcastHandler?.(["/slow"])],
  ])("retains one trailing listing for repeated %s events", async (_source, emitEvent) => {
    let finishSlowListing!: () => void;
    const refresh = vi
      .fn<ExplorerInstance["refresh"]>()
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          finishSlowListing = resolve;
        }),
      )
      .mockResolvedValue(undefined);
    const explorer = {
      currentPath: "/slow",
      refresh,
    } as unknown as ExplorerInstance;
    const watchers = useFileWatchers({ getAllExplorers: () => [explorer] });
    watchers.setup();

    emitEvent();
    await vi.advanceTimersByTimeAsync(150);
    expect(refresh).toHaveBeenCalledTimes(1);

    emitEvent();
    emitEvent();
    emitEvent();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);

    finishSlowListing();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    watchers.cleanup();
  });

  it("does not turn a delayed Tauri notification into a third listing", async () => {
    let finishInitialListing!: () => void;
    let finishTrailingListing!: () => void;
    const refresh = vi
      .fn<ExplorerInstance["refresh"]>()
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          finishInitialListing = resolve;
        }),
      )
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          finishTrailingListing = resolve;
        }),
      );
    const explorer = {
      currentPath: "/slow",
      refresh,
    } as unknown as ExplorerInstance;
    const watchers = useFileWatchers({ getAllExplorers: () => [explorer] });
    const epoch = Date.now();
    watchers.setup();

    tauriHandler?.({ payload: { path: "/slow", observed_at_ms: epoch } });
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(50);
    tauriHandler?.({ payload: { path: "/slow", observed_at_ms: epoch + 200 } });

    finishInitialListing();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1949);
    expect(refresh).toHaveBeenCalledTimes(2);

    // The backend can deliver another notification for the same old change
    // after the trailing listing has begun.
    tauriHandler?.({ payload: { path: "/slow", observed_at_ms: epoch + 200 } });
    finishTrailingListing();
    await vi.advanceTimersByTimeAsync(2500);
    expect(refresh).toHaveBeenCalledTimes(2);

    watchers.cleanup();
  });

  it("publishes application-side listener readiness and watcher receipts", async () => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    const watchers = useFileWatchers({ getAllExplorers: () => [] });
    watchers.setup();
    await Promise.resolve();

    expect(document.documentElement.dataset.e2eDirectoryWatcherListenerReady).toBe("true");
    tauriHandler?.({
      payload: { path: "/watched", observed_at_ms: 1234 },
    });
    const receipts = JSON.parse(
      document.documentElement.dataset.e2eDirectoryWatcherReceipts ?? "{}",
    );
    expect(receipts["/watched"]).toEqual({ count: 1, observedAt: 1234 });

    watchers.cleanup();
  });

  it.each([
    ["Tauri directory watcher", () => tauriHandler?.({ payload: { path: "/old" } })],
    ["cross-window file watcher", () => broadcastHandler?.(["/old"])],
  ])("drops a trailing %s refresh after the pane navigates", async (_source, emitEvent) => {
    let finishOldListing!: () => void;
    const refresh = vi
      .fn<ExplorerInstance["refresh"]>()
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          finishOldListing = resolve;
        }),
      )
      .mockResolvedValue(undefined);
    let currentPath = "/old";
    const explorer = {
      get currentPath() {
        return currentPath;
      },
      refresh,
    } as unknown as ExplorerInstance;
    const watchers = useFileWatchers({ getAllExplorers: () => [explorer] });
    watchers.setup();

    emitEvent();
    await vi.advanceTimersByTimeAsync(150);
    expect(refresh).toHaveBeenCalledTimes(1);

    emitEvent();
    currentPath = "/new";
    finishOldListing();
    await vi.advanceTimersByTimeAsync(2000);

    expect(refresh).toHaveBeenCalledTimes(1);
    watchers.cleanup();
  });
});
