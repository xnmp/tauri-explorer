import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";

let directoryChanged: ((event: { payload: { path: string } }) => void) | undefined;
let broadcastFileChange: ((paths: string[]) => void) | undefined;
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: { path: string } }) => void) => {
    directoryChanged = handler;
    return unlisten;
  }),
}));

vi.mock("$lib/state/file-events", () => ({
  initFileChangeListener: (handler: (paths: string[]) => void) => {
    broadcastFileChange = handler;
  },
  cleanupFileChangeListener: vi.fn(),
}));

vi.mock("$lib/state/settings.svelte", () => ({
  settingsStore: { showGitStatus: false },
}));

vi.mock("$lib/state/git-status.svelte", () => ({
  gitStatusStore: { currentPath: "", refresh: vi.fn() },
}));

import { useFileWatchers } from "$lib/composables/use-file-watchers";

const WATCHED_PATH = "/home/user/docs";

describe("useFileWatchers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    directoryChanged = undefined;
    broadcastFileChange = undefined;
    unlisten.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function expectOneTrailingRefresh(trigger: () => void): Promise<void> {
    let finishSlowListing!: () => void;
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 100)))
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          finishSlowListing = resolve;
        }),
      )
      .mockResolvedValue(undefined);
    const explorer = { currentPath: WATCHED_PATH, refresh } as unknown as ExplorerInstance;
    const watchers = useFileWatchers({ getAllExplorers: () => [explorer] });
    watchers.setup();
    await Promise.resolve();

    // Establish a healthy baseline then enter a deliberately slow listing.
    trigger();
    await vi.advanceTimersByTimeAsync(250);
    trigger();
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(2);

    // These events construct fresh production callback wrappers. They must
    // identify the same explorer and produce one trailing directory listing.
    trigger();
    trigger();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(2);

    finishSlowListing();
    await vi.advanceTimersByTimeAsync(8000);
    expect(refresh).toHaveBeenCalledTimes(3);
    watchers.cleanup();
  }

  it("coalesces repeated native watcher events for a slow explorer refresh", async () => {
    const trigger = () => directoryChanged?.({ payload: { path: WATCHED_PATH } });
    await expectOneTrailingRefresh(trigger);
  });

  it("coalesces repeated cross-window file-change events for a slow explorer refresh", async () => {
    const trigger = () => broadcastFileChange?.([WATCHED_PATH]);
    await expectOneTrailingRefresh(trigger);
  });
});
