import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelPendingRefreshes, requestRefresh } from "$lib/state/refresh-manager";

describe("refresh-manager adaptive backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cancelPendingRefreshes();
  });

  afterEach(() => {
    cancelPendingRefreshes();
    vi.useRealTimers();
  });

  it("extends cadence after a degraded listing and restores it after recovery", async () => {
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 100)))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 600)))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 100)))
      .mockResolvedValue(undefined);

    // Learn a healthy 100ms listing baseline, then observe a six-times-slower listing.
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(250);
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(2350);
    expect(refresh).toHaveBeenCalledTimes(2);

    // The slow listing is still in flight. Its trailing watcher request must
    // wait longer than the normal two-second cadence.
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6000);
    expect(refresh).toHaveBeenCalledTimes(3);

    // The healthy trailing listing restores the standard cadence for later events.
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });
});
