import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requestRefresh, cancelPendingRefreshes } from "$lib/state/refresh-manager";

describe("refresh-manager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cancelPendingRefreshes();
  });

  afterEach(() => {
    cancelPendingRefreshes();
    vi.useRealTimers();
  });

  it("calls refresh after the debounce delay", () => {
    const refresh = vi.fn();
    requestRefresh(refresh, "/home/user/docs");

    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith({ silent: true });
  });

  it("deduplicates multiple requests for the same directory", () => {
    const refresh = vi.fn();
    requestRefresh(refresh, "/home/user/docs");
    requestRefresh(refresh, "/home/user/docs");
    requestRefresh(refresh, "/home/user/docs");

    vi.advanceTimersByTime(150);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("resets the debounce timer on repeated requests", () => {
    const refresh = vi.fn();
    requestRefresh(refresh, "/home/user/docs");

    vi.advanceTimersByTime(100);
    expect(refresh).not.toHaveBeenCalled();

    // Second request resets the 150ms window
    requestRefresh(refresh, "/home/user/docs");

    vi.advanceTimersByTime(100);
    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("handles different directories independently", () => {
    const refreshA = vi.fn();
    const refreshB = vi.fn();
    requestRefresh(refreshA, "/home/user/docs");
    requestRefresh(refreshB, "/home/user/pictures");

    vi.advanceTimersByTime(150);
    expect(refreshA).toHaveBeenCalledOnce();
    expect(refreshB).toHaveBeenCalledOnce();
  });

  it("passes silent=false when explicitly requested", () => {
    const refresh = vi.fn();
    requestRefresh(refresh, "/home/user/docs", false);

    vi.advanceTimersByTime(150);
    expect(refresh).toHaveBeenCalledWith({ silent: false });
  });

  it("cancelPendingRefreshes prevents queued refreshes from firing", () => {
    const refresh = vi.fn();
    requestRefresh(refresh, "/home/user/docs");
    requestRefresh(refresh, "/home/user/pictures");

    cancelPendingRefreshes();
    vi.advanceTimersByTime(300);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("fans out to all distinct subscribers targeting the same directory", () => {
    // Two panes showing the same directory must BOTH refresh
    const paneA = vi.fn();
    const paneB = vi.fn();
    requestRefresh(paneA, "/home/user/docs");
    requestRefresh(paneB, "/home/user/docs");

    vi.advanceTimersByTime(150);
    expect(paneA).toHaveBeenCalledOnce();
    expect(paneB).toHaveBeenCalledOnce();
  });

  it("collapses repeated requests sharing a subscriber key into one refresh", () => {
    const first = vi.fn();
    const second = vi.fn();
    requestRefresh(first, "/home/user/docs", true, "pane-1");
    requestRefresh(second, "/home/user/docs", true, "pane-1");

    vi.advanceTimersByTime(150);
    // Same subscriber: only the latest callback fires, exactly once
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("fan-out flush fires each subscriber once and respects per-subscriber silent flag", () => {
    const silentPane = vi.fn();
    const loudPane = vi.fn();
    requestRefresh(silentPane, "/home/user/docs", true, "pane-1");
    requestRefresh(loudPane, "/home/user/docs", false, "pane-2");

    vi.advanceTimersByTime(150);
    expect(silentPane).toHaveBeenCalledOnce();
    expect(silentPane).toHaveBeenCalledWith({ silent: true });
    expect(loudPane).toHaveBeenCalledOnce();
    expect(loudPane).toHaveBeenCalledWith({ silent: false });
  });

  it("rate-limits consecutive refreshes to the same directory", () => {
    const refresh = vi.fn();

    // First refresh fires at debounce delay (no prior history)
    requestRefresh(refresh, "/home/user/docs");
    vi.advanceTimersByTime(150);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Immediate second request is delayed to enforce MIN_INTERVAL_MS
    requestRefresh(refresh, "/home/user/docs");
    vi.advanceTimersByTime(150);
    expect(refresh).toHaveBeenCalledTimes(1); // still 1 — rate-limited

    vi.advanceTimersByTime(1850);
    expect(refresh).toHaveBeenCalledTimes(2); // fires after remaining interval
  });

  it("rate-limiting does not affect different directories", () => {
    const refreshA = vi.fn();
    const refreshB = vi.fn();

    requestRefresh(refreshA, "/home/user/docs");
    vi.advanceTimersByTime(150);
    expect(refreshA).toHaveBeenCalledTimes(1);

    // Different directory is not rate-limited by the first
    requestRefresh(refreshB, "/home/user/pictures");
    vi.advanceTimersByTime(150);
    expect(refreshB).toHaveBeenCalledTimes(1);
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

    // Establish a baseline, then start a listing that remains in flight.
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(250);
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(2);

    requestRefresh(refresh, "/home/user/docs");
    requestRefresh(refresh, "/home/user/docs");
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(2);

    finishSlowListing();
    await vi.advanceTimersByTimeAsync(8000);
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
