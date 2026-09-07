import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  watch: vi.fn(), unwatch: vi.fn(), root: vi.fn(), summary: vi.fn(),
  subscribe: vi.fn(), releaseConsumer: vi.fn(),
}));
vi.mock("$lib/api/git", () => ({
  gitRepoRoot: api.root, gitWatchRepo: api.watch, gitUnwatchRepo: api.unwatch,
}));
vi.mock("$lib/state/git-summary-cache", () => ({
  fetchGitSummary: api.summary, releaseGitSummaryConsumer: api.releaseConsumer,
}));
vi.mock("$lib/state/git-refresh", () => ({
  subscribeGitChanges: api.subscribe, notifyLocalGitChange: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  api.root.mockImplementation(async (path: string) => ({ ok: true, data: path }));
  api.watch.mockImplementation(async (path: string) => ({ ok: true, data: { id: path, repoRoot: path } }));
  api.unwatch.mockResolvedValue({ ok: true });
  api.summary.mockResolvedValue({ ok: false, error: "cancelled" });
  api.subscribe.mockResolvedValue(vi.fn());
});

describe("SCM pane lifetime", () => {
  it("retries a failed release before acquiring a replacement repository", async () => {
    const { getScmStore, disposeScmStore } = await import("$lib/state/scm.svelte");
    const store = getScmStore("pane");
    await store.setActivePath("/first");
    api.unwatch.mockResolvedValueOnce({ ok: false, error: "transport unavailable" });
    await store.setActivePath("/second");
    expect(api.watch).not.toHaveBeenCalledWith("/second");
    await store.setActivePath("/third");
    expect(api.unwatch.mock.calls.map(([lease]) => lease.repoRoot)).toEqual(["/first", "/first"]);
    expect(api.watch).toHaveBeenCalledWith("/third");
    await disposeScmStore("pane");
  });

  it("keeps a failed temporary release owned so the next mount can retry it", async () => {
    const { getScmStore, disposeScmStore } = await import("$lib/state/scm.svelte");
    const store = getScmStore("pane");
    await store.setActivePath("/first");
    api.unwatch.mockResolvedValueOnce({ ok: false, error: "transport unavailable" });
    await store.release();
    await store.setActivePath("/second");
    expect(api.unwatch.mock.calls.map(([lease]) => lease.repoRoot)).toEqual(["/first", "/first"]);
    expect(store.repoRoot).toBe("/second");
    await disposeScmStore("pane");
  });

  it("drains a temporary panel release already in progress when the pane is destroyed", async () => {
    const unwatching = deferred<{ ok: true; data?: { id: string; repoRoot: string } }>();
    api.unwatch.mockReturnValue(unwatching.promise);
    const { getScmStore, disposeScmStore } = await import("$lib/state/scm.svelte");
    const store = getScmStore("pane");
    await store.setActivePath("/repo");
    const released = store.release();
    const disposed = disposeScmStore("pane");
    let settled = false;
    void disposed.then(() => { settled = true; });
    await flush();
    const settledBeforeUnwatch = settled;
    unwatching.resolve({ ok: true, data: { id: "/resolved-repository", repoRoot: "/resolved-repository" } });
    await Promise.all([released, disposed]);
    expect(settledBeforeUnwatch).toBe(false);
    expect(api.unwatch).toHaveBeenCalledOnce();
  });

  it("drains a late watcher registration and detaches it after pane disposal", async () => {
    const watching = deferred<{ ok: true; data?: { id: string; repoRoot: string } }>();
    api.watch.mockReturnValue(watching.promise);
    const { getScmStore, disposeScmStore } = await import("$lib/state/scm.svelte");
    const store = getScmStore("pane");
    const activation = store.setActivePath("/repo");
    await flush();
    expect(api.watch).toHaveBeenCalledOnce();
    const disposed = disposeScmStore("pane");
    let settled = false;
    void disposed.then(() => { settled = true; });
    await flush();
    const settledBeforeWatch = settled;
    watching.resolve({ ok: true, data: { id: "/resolved-repository", repoRoot: "/resolved-repository" } });
    await Promise.all([activation, disposed]);
    expect(settledBeforeWatch).toBe(false);
    expect(api.unwatch).toHaveBeenCalledWith({ id: "/resolved-repository", repoRoot: "/resolved-repository" });
    expect(api.summary).not.toHaveBeenCalled();
    expect(store.repoRoot).toBeNull();
  });

  it("unsubscribes even if event registration finishes after pane disposal", async () => {
    const subscription = deferred<() => void>();
    const unsubscribe = vi.fn();
    api.subscribe.mockReturnValue(subscription.promise);
    const { getScmStore, disposeScmStore } = await import("$lib/state/scm.svelte");
    const listening = getScmStore("pane").initWatcherListener();
    const disposed = disposeScmStore("pane");
    subscription.resolve(unsubscribe);
    await Promise.all([listening, disposed]);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps replacement scan ownership separate from a late release of the old pane", async () => {
    const { getScmStore, disposeScmStore } = await import("$lib/state/scm.svelte");
    const old = getScmStore("pane");
    await old.setActivePath("/repo");
    const oldConsumer = api.summary.mock.calls.at(-1)![1].consumerId;
    await disposeScmStore("pane");
    const replacement = getScmStore("pane");
    await replacement.setActivePath("/repo");
    const newConsumer = api.summary.mock.calls.at(-1)![1].consumerId;
    api.releaseConsumer.mockClear();
    await old.release();
    expect(oldConsumer).not.toBe(newConsumer);
    expect(api.releaseConsumer).not.toHaveBeenCalledWith(newConsumer);
    await disposeScmStore("pane");
  });

  it("keeps the latest repository when an earlier watch finishes last", async () => {
    const firstWatch = deferred<{ ok: true; data?: { id: string; repoRoot: string } }>();
    api.watch.mockImplementation((root: string) => root === "/first"
      ? firstWatch.promise : Promise.resolve({ ok: true, data: { id: root, repoRoot: root } }));
    const { getScmStore, disposeScmStore } = await import("$lib/state/scm.svelte");
    const store = getScmStore("pane");
    const previous = store.setActivePath("/first");
    await flush();
    const replacement = store.setActivePath("/second");
    firstWatch.resolve({ ok: true, data: { id: "/first", repoRoot: "/first" } });
    await Promise.all([previous, replacement]);
    expect(store.repoRoot).toBe("/second");
    expect(api.unwatch).toHaveBeenCalledWith({ id: "/first", repoRoot: "/first" });
    await disposeScmStore("pane");
    expect(api.unwatch).toHaveBeenCalledWith({ id: "/second", repoRoot: "/second" });
  });

  it("retains a watch on same-repository navigation while the first watch is pending", async () => {
    const firstWatch = deferred<{ ok: true; data?: { id: string; repoRoot: string } }>();
    api.root.mockResolvedValue({ ok: true, data: "/repo" });
    api.watch.mockReturnValueOnce(firstWatch.promise).mockResolvedValue({ ok: true, data: { id: "/repo", repoRoot: "/repo" } });
    const { getScmStore, disposeScmStore } = await import("$lib/state/scm.svelte");
    const store = getScmStore("pane");
    const previous = store.setActivePath("/repo/first");
    await flush();
    const replacement = store.setActivePath("/repo/second");
    firstWatch.resolve({ ok: true, data: { id: "/repo", repoRoot: "/repo" } });
    await Promise.all([previous, replacement]);
    // Same-repository requests share the acquired reference; it stays live.
    expect(api.watch).toHaveBeenCalledOnce();
    expect(api.unwatch).not.toHaveBeenCalled();
    await disposeScmStore("pane");
    expect(api.unwatch).toHaveBeenCalledOnce();
  });
});
