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

type TauriDirectoryEvent = { payload: { path: string } };

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
});
