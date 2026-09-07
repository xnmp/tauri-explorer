import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import {
  createDirectoryEvents,
  directoryEvents,
  type DirectoryChange,
} from "$lib/state/directory-events";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("createDirectoryEvents", () => {
  it("attaches eagerly, shares one registration, and gives duplicate callbacks independent identities", async () => {
    let dispatch!: (change: DirectoryChange) => void;
    const unlisten = vi.fn();
    const start = vi.fn(async (send: (change: DirectoryChange) => void) => {
      dispatch = send;
      return unlisten;
    });
    const events = createDirectoryEvents(start);
    const callback = vi.fn();

    const first = events.subscribe(callback);
    const second = events.subscribe(callback);
    expect(start).toHaveBeenCalledOnce();
    await Promise.all([first.ready(), second.ready()]);

    dispatch({ path: "/first" });
    expect(callback).toHaveBeenCalledTimes(2);
    first.stop();
    dispatch({ path: "/second" });
    expect(callback).toHaveBeenCalledTimes(3);
    expect(unlisten).not.toHaveBeenCalled();

    second.stop();
    expect(unlisten).toHaveBeenCalledOnce();
    dispatch({ path: "/late" });
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("exposes an attachment failure and retries it on a later ready call", async () => {
    const dispatches: Array<(change: DirectoryChange) => void> = [];
    const unlisten = vi.fn();
    const start = vi
      .fn<(dispatch: (change: DirectoryChange) => void) => Promise<() => void>>()
      .mockImplementationOnce((dispatch) => {
        dispatches.push(dispatch);
        return Promise.reject(new Error("listener unavailable"));
      })
      .mockImplementationOnce(async (dispatch) => {
        dispatches.push(dispatch);
        return unlisten;
      });
    const events = createDirectoryEvents(start);
    const callback = vi.fn();
    const subscription = events.subscribe(callback);

    await expect(subscription.ready()).rejects.toThrow("listener unavailable");
    expect(start).toHaveBeenCalledOnce();
    await expect(subscription.ready()).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);

    dispatches[0]({ path: "/failed" });
    dispatches[1]({ path: "/ready" });
    expect(callback).toHaveBeenCalledExactlyOnceWith({ path: "/ready" });
    subscription.stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("retires a stopped pending attachment while a new subscription attaches independently", async () => {
    const attempts = [deferred<() => void>(), deferred<() => void>()];
    const dispatches: Array<(change: DirectoryChange) => void> = [];
    const start = vi.fn((dispatch: (change: DirectoryChange) => void) => {
      dispatches.push(dispatch);
      return attempts[dispatches.length - 1].promise;
    });
    const events = createDirectoryEvents(start);
    const oldCallback = vi.fn();
    const old = events.subscribe(oldCallback);
    const oldReady = old.ready();

    old.stop();
    await expect(old.ready()).rejects.toThrow("stopped");
    const newCallback = vi.fn();
    const current = events.subscribe(newCallback);
    expect(start).toHaveBeenCalledTimes(2);

    const oldUnlisten = vi.fn();
    attempts[0].resolve(oldUnlisten);
    await expect(oldReady).rejects.toThrow("stopped");
    expect(oldUnlisten).toHaveBeenCalledOnce();
    dispatches[0]({ path: "/retired" });
    expect(oldCallback).not.toHaveBeenCalled();
    expect(newCallback).not.toHaveBeenCalled();

    const currentUnlisten = vi.fn();
    attempts[1].resolve(currentUnlisten);
    await current.ready();
    dispatches[1]({ path: "/current" });
    expect(newCallback).toHaveBeenCalledExactlyOnceWith({ path: "/current" });
    current.stop();
    expect(currentUnlisten).toHaveBeenCalledOnce();
  });

  it("dispatches a membership snapshot and isolates throwing subscribers", async () => {
    let dispatch!: (change: DirectoryChange) => void;
    const unlisten = vi.fn();
    const events = createDirectoryEvents(async (send) => {
      dispatch = send;
      return unlisten;
    });
    const late = vi.fn();
    const removed = vi.fn();
    const survivor = vi.fn();
    let removedSubscription!: ReturnType<typeof events.subscribe>;
    let lateSubscription: ReturnType<typeof events.subscribe> | undefined;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = events.subscribe(() => {
      removedSubscription.stop();
      lateSubscription ??= events.subscribe(late);
      throw new Error("subscriber failure");
    });
    removedSubscription = events.subscribe(removed);
    const last = events.subscribe(survivor);
    await first.ready();

    dispatch({ path: "/one" });
    expect(removed).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    expect(survivor).toHaveBeenCalledExactlyOnceWith({ path: "/one" });
    expect(consoleError).toHaveBeenCalledOnce();

    dispatch({ path: "/two" });
    expect(late).toHaveBeenCalledExactlyOnceWith({ path: "/two" });
    expect(survivor).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledTimes(2);

    first.stop();
    last.stop();
    lateSubscription?.stop();
    expect(unlisten).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});

describe("directoryEvents Tauri adapter", () => {
  beforeEach(() => {
    tauri.listen.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps observation time and preserves the bounded E2E readiness and receipt protocol", async () => {
    let handler!: (event: {
      payload: { path: string; observed_at_ms?: number };
    }) => void;
    const unlisten = vi.fn();
    tauri.listen.mockImplementation(async (_event, receive) => {
      handler = receive;
      return unlisten;
    });
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    vi.stubGlobal("window", new EventTarget());
    const receipts: unknown[] = [];
    window.addEventListener("e2e-directory-watcher-receipt", (event) => {
      receipts.push((event as CustomEvent).detail);
    });
    const callback = vi.fn();

    const subscription = directoryEvents.subscribe(callback);
    await subscription.ready();
    expect(tauri.listen).toHaveBeenCalledExactlyOnceWith(
      "directory-changed",
      expect.any(Function),
    );
    expect(document.documentElement.dataset.e2eDirectoryWatcherListenerReady)
      .toBe("true");

    handler({ payload: { path: "/watched", observed_at_ms: 1234 } });
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      path: "/watched",
      observedAt: 1234,
    });
    expect(receipts).toEqual([{
      path: "/watched",
      count: 1,
      observedAt: 1234,
    }]);

    for (let index = 0; index < 257; index += 1) {
      handler({ payload: { path: `/bounded/${index}` } });
    }
    const retained = JSON.parse(
      document.documentElement.dataset.e2eDirectoryWatcherReceipts ?? "{}",
    );
    expect(Object.keys(retained)).toHaveLength(256);
    expect(retained["/bounded/256"]).toEqual({ count: 1, observedAt: null });

    subscription.stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
