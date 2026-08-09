import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelPendingRefreshes, requestRefresh } from "$lib/state/refresh-manager";

describe("adaptive watcher refresh cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cancelPendingRefreshes();
  });

  afterEach(() => {
    cancelPendingRefreshes();
    vi.useRealTimers();
  });

  it("backs off watcher refreshes after a listing is much slower than its baseline", async () => {
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 100)))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 600)))
      .mockResolvedValue(undefined);

    // Establish a 100ms normal-listing baseline.
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledTimes(1);

    // The next listing takes six times as long as normal.
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(2350);
    expect(refresh).toHaveBeenCalledTimes(2);

    // A later watcher event must wait longer than the usual two-second cadence.
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(6000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("coalesces watcher events received during a slow listing into one trailing refresh", async () => {
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
    const pane = {};
    const watcherEvent = () =>
      requestRefresh((_opts) => refresh(), "/home/user/docs", true, pane);

    // Establish a baseline, then start a listing that remains in flight.
    watcherEvent();
    await vi.advanceTimersByTimeAsync(250);
    watcherEvent();
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(2);

    watcherEvent();
    watcherEvent();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(2);

    finishSlowListing();
    await vi.advanceTimersByTimeAsync(8000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("does not cascade when an old watcher notification arrives during the trailing listing", async () => {
    let finishInitialListing!: () => void;
    let finishTrailingListing!: () => void;
    const refresh = vi
      .fn<() => Promise<void>>()
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
    const pane = {};
    const epoch = Date.now();
    const watcherEvent = (observedAt: number) =>
      requestRefresh((_opts) => refresh(), "/home/user/docs", true, pane, observedAt);

    watcherEvent(epoch);
    await vi.advanceTimersByTimeAsync(150);
    expect(refresh).toHaveBeenCalledTimes(1);

    // This change happened during the initial listing and requires one trailing listing.
    watcherEvent(epoch + 200);
    finishInitialListing();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(refresh).toHaveBeenCalledTimes(2);

    // Its backend notification is delivered late, but the trailing listing
    // started after the change and therefore already contains it.
    watcherEvent(epoch + 200);
    finishTrailingListing();
    await vi.advanceTimersByTimeAsync(2500);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("retains changes observed after the trailing listing starts", async () => {
    let finishListing!: () => void;
    const refresh = vi.fn<() => Promise<void>>().mockImplementation(
      () => new Promise<void>((resolve) => {
        finishListing = resolve;
      }),
    );
    const pane = {};
    const epoch = Date.now();
    const watcherEvent = (observedAt: number) =>
      requestRefresh((_opts) => refresh(), "/home/user/docs", true, pane, observedAt);

    watcherEvent(epoch);
    await vi.advanceTimersByTimeAsync(150);
    watcherEvent(epoch + 200);
    finishListing();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(refresh).toHaveBeenCalledTimes(2);

    watcherEvent(epoch + 2200);
    finishListing();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("returns to the normal cadence after a later listing is healthy", async () => {
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 100)))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 600)))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 100)))
      .mockResolvedValue(undefined);

    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(250);
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(2350);

    // Wait through the degraded interval and complete a healthy trailing listing.
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(8000);
    expect(refresh).toHaveBeenCalledTimes(3);

    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });
});
