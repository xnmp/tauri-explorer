/**
 * Single-source git change notifications (src/lib/state/git-refresh.ts):
 * one Tauri listener shared by all subscribers, watcher + local fan-out.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let watcherCallback: ((event: { payload: string }) => void) | null = null;
const listen = vi.fn(async (_name: string, cb: (event: { payload: string }) => void) => {
  watcherCallback = cb;
  return () => {};
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (event: { payload: string }) => void) => listen(name, cb),
}));

async function freshModule() {
  vi.resetModules();
  return await import("../../src/lib/state/git-refresh");
}

beforeEach(() => {
  watcherCallback = null;
  listen.mockClear();
});

describe("git-refresh", () => {
  it("attaches exactly one Tauri listener no matter how many subscribers", async () => {
    const { subscribeGitChanges } = await freshModule();

    await subscribeGitChanges(() => {});
    await subscribeGitChanges(() => {});
    await subscribeGitChanges(() => {});

    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith("git-status-changed", expect.any(Function));
  });

  it("fans watcher events out to every subscriber tagged as 'watcher'", async () => {
    const { subscribeGitChanges } = await freshModule();
    const a = vi.fn();
    const b = vi.fn();
    await subscribeGitChanges(a);
    await subscribeGitChanges(b);

    watcherCallback!({ payload: "/repo" });

    const expected = { repoRoot: "/repo", source: "watcher" };
    expect(a).toHaveBeenCalledWith(expected);
    expect(b).toHaveBeenCalledWith(expected);
  });

  it("delivers local notifications tagged as 'local'", async () => {
    const { subscribeGitChanges, notifyLocalGitChange } = await freshModule();
    const fn = vi.fn();
    await subscribeGitChanges(fn);

    notifyLocalGitChange("/repo");

    expect(fn).toHaveBeenCalledWith({ repoRoot: "/repo", source: "local" });
  });

  it("unsubscribe stops delivery without affecting other subscribers", async () => {
    const { subscribeGitChanges, notifyLocalGitChange } = await freshModule();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = await subscribeGitChanges(a);
    await subscribeGitChanges(b);

    unsubscribeA();
    notifyLocalGitChange("/repo");

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("survives environments where listen() rejects (browser mode)", async () => {
    listen.mockRejectedValueOnce(new Error("not in tauri"));
    const { subscribeGitChanges, notifyLocalGitChange } = await freshModule();
    const fn = vi.fn();

    await expect(subscribeGitChanges(fn)).resolves.toBeTypeOf("function");

    // Local notifications still work without the watcher.
    notifyLocalGitChange(null);
    expect(fn).toHaveBeenCalledWith({ repoRoot: null, source: "local" });
  });
});
