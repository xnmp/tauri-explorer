import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  initFileChangeListener: vi.fn(),
  cleanupFileChangeListener: vi.fn(),
  subscribeToLocalFileChanges: vi.fn(),
  subscribeGitChanges: vi.fn(),
  invalidateRepoRoot: vi.fn(),
  gitRefresh: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("$lib/state/file-events", () => ({
  initFileChangeListener: mocks.initFileChangeListener,
  cleanupFileChangeListener: mocks.cleanupFileChangeListener,
  subscribeToLocalFileChanges: mocks.subscribeToLocalFileChanges,
}));
vi.mock("$lib/state/git-refresh", () => ({ subscribeGitChanges: mocks.subscribeGitChanges }));
vi.mock("$lib/state/repo-root-cache.svelte", () => ({
  repoRootCache: { invalidate: mocks.invalidateRepoRoot },
}));
vi.mock("$lib/state/settings.svelte", () => ({
  settingsStore: { showGitStatus: false },
}));
vi.mock("$lib/state/git-status.svelte", () => ({
  gitStatusStore: { currentPath: "", refresh: mocks.gitRefresh },
}));

import { useFileWatchers } from "$lib/composables/use-file-watchers";
import { createPaneWatch } from "$lib/state/pane-watch";
import { cancelPendingRefreshes } from "$lib/state/refresh-manager";

type TauriDirectoryEvent = { payload: { path: string; observed_at_ms?: number } };
type PaneWatch = ReturnType<typeof createPaneWatch>;

async function commitPath(watch: PaneWatch, path: string): Promise<void> {
  const navigation = watch.begin(path);
  await navigation.ready;
  expect(navigation.accept(null)).toBe(true);
  expect(navigation.commit()).toBe(true);
}

describe("useFileWatchers refresh coalescing", () => {
  let broadcastHandler: ((dirs: string[]) => void) | undefined;
  let tauriHandler: ((event: TauriDirectoryEvent) => void) | undefined;
  let localChangeHandler: ((dirs: string[]) => void) | undefined;
  let gitChangeHandler: ((change: { repoRoot: string | null }) => void) | undefined;
  let paneWatches: PaneWatch[];
  let watcherCleanups: Array<() => void>;

  function setupWatchers(explorers: ExplorerInstance[]) {
    const watchers = useFileWatchers({ getAllExplorers: () => explorers });
    watchers.setup();
    watcherCleanups.push(watchers.cleanup);
    return watchers;
  }

  async function observedExplorer(
    path: string,
    refresh: ExplorerInstance["refresh"],
  ): Promise<{ explorer: ExplorerInstance; watch: PaneWatch }> {
    const watch = createPaneWatch({
      refresh,
      prepare: async () => {},
      release: async () => {},
    });
    paneWatches.push(watch);
    await commitPath(watch, path);
    return {
      explorer: { directoryChanged: watch.changed } as unknown as ExplorerInstance,
      watch,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    cancelPendingRefreshes();
    mocks.listen.mockReset();
    mocks.initFileChangeListener.mockReset();
    mocks.cleanupFileChangeListener.mockReset();
    mocks.subscribeToLocalFileChanges.mockReset().mockReturnValue(vi.fn());
    mocks.subscribeGitChanges.mockReset().mockResolvedValue(vi.fn());
    mocks.invalidateRepoRoot.mockReset();
    mocks.gitRefresh.mockReset();
    broadcastHandler = undefined;
    tauriHandler = undefined;
    localChangeHandler = undefined;
    gitChangeHandler = undefined;
    paneWatches = [];
    watcherCleanups = [];
    mocks.initFileChangeListener.mockImplementation((handler) => {
      broadcastHandler = handler;
    });
    mocks.listen.mockImplementation((_eventName, handler) => {
      tauriHandler = handler;
      return Promise.resolve(vi.fn());
    });
    mocks.subscribeToLocalFileChanges.mockImplementation((handler) => {
      localChangeHandler = handler;
      return vi.fn();
    });
    mocks.subscribeGitChanges.mockImplementation(async (handler) => {
      gitChangeHandler = handler;
      return vi.fn();
    });
  });

  it("invalidates repository probes through filesystem and git lifecycle buses", async () => {
    const watchers = setupWatchers([]);
    await Promise.resolve();

    localChangeHandler?.(["/repo/a", "/repo/b"]);
    tauriHandler?.({ payload: { path: "/repo/native" } });
    gitChangeHandler?.({ repoRoot: "/repo/git" });
    gitChangeHandler?.({ repoRoot: null });

    expect(mocks.invalidateRepoRoot.mock.calls).toEqual([
      ["/repo/a"],
      ["/repo/b"],
      ["/repo/native"],
      ["/repo/git"],
      [undefined],
    ]);
    watchers.cleanup();
  });

  afterEach(async () => {
    for (const cleanup of watcherCleanups) cleanup();
    await Promise.all(paneWatches.map((watch) => watch.destroy()));
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
    const { explorer } = await observedExplorer("/slow", refresh);
    const watchers = setupWatchers([explorer]);

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
    const { explorer } = await observedExplorer("/slow", refresh);
    const watchers = setupWatchers([explorer]);
    const epoch = Date.now();

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

  it("replays a pending pane's newer event when its queued callback did not start a scan", async () => {
    let finishPaneA!: () => void;
    const refreshA = vi.fn<ExplorerInstance["refresh"]>(() =>
      new Promise<void>((resolve) => {
        finishPaneA = resolve;
      }),
    );
    const refreshB = vi.fn<ExplorerInstance["refresh"]>().mockResolvedValue(undefined);
    const paneA = await observedExplorer("/shared", refreshA);
    const paneB = await observedExplorer("/shared", refreshB);
    const watchers = setupWatchers([paneA.explorer, paneB.explorer]);
    const epoch = Date.now();

    tauriHandler?.({ payload: { path: "/shared", observed_at_ms: epoch } });
    const navigatingB = paneB.watch.begin("/shared");
    await navigatingB.ready;
    tauriHandler?.({ payload: { path: "/shared", observed_at_ms: epoch + 100 } });

    await vi.advanceTimersByTimeAsync(150);
    expect(refreshA).toHaveBeenCalledOnce();
    expect(refreshB).not.toHaveBeenCalled();

    expect(navigatingB.accept(null)).toBe(true);
    expect(navigatingB.commit()).toBe(true);
    finishPaneA();
    await vi.advanceTimersByTimeAsync(2000);

    expect(refreshB).toHaveBeenCalledOnce();
    watchers.cleanup();
  });

  it("publishes application-side listener readiness and watcher receipts", async () => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    vi.stubGlobal("window", new EventTarget());
    const received: unknown[] = [];
    window.addEventListener("e2e-directory-watcher-receipt", (event) => {
      received.push((event as CustomEvent).detail);
    });
    const watchers = setupWatchers([]);
    await vi.advanceTimersByTimeAsync(0);

    expect(document.documentElement.dataset.e2eDirectoryWatcherListenerReady).toBe("true");
    tauriHandler?.({
      payload: { path: "/watched", observed_at_ms: 1234 },
    });
    const receipts = JSON.parse(
      document.documentElement.dataset.e2eDirectoryWatcherReceipts ?? "{}",
    );
    expect(receipts["/watched"]).toEqual({ count: 1, observedAt: 1234 });
    expect(received).toEqual([{ path: "/watched", count: 1, observedAt: 1234 }]);

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
    const { explorer, watch } = await observedExplorer("/old", refresh);
    const watchers = setupWatchers([explorer]);

    emitEvent();
    await vi.advanceTimersByTimeAsync(150);
    expect(refresh).toHaveBeenCalledTimes(1);

    emitEvent();
    await commitPath(watch, "/new");
    finishOldListing();
    await vi.advanceTimersByTimeAsync(2000);

    expect(refresh).toHaveBeenCalledTimes(1);
    watchers.cleanup();
  });
});
