import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  requestRefresh,
  cancelPendingRefreshes,
  refreshManagerRetention,
} from "$lib/state/refresh-manager";

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

  it("bounds settled directory metadata over a long session and fully clears on teardown", () => {
    const refresh = vi.fn();
    // Churn 5,000 distinct directories in bursts larger than the retention cap.
    // Draining 5,000 same-deadline fake timers at once spends seconds in the
    // timer harness and times out under CI contention; this is a retention
    // contract, not a benchmark of the fake clock's timer lookup algorithm.
    const burst = 1250;
    for (let start = 0; start < 5000; start += burst) {
      for (let index = start; index < start + burst; index++) {
        requestRefresh(refresh, `/long-session/${index}`);
      }
      expect(refreshManagerRetention().pending).toBe(burst);
      expect(vi.getTimerCount()).toBe(burst);
      vi.advanceTimersByTime(150);
      expect(refresh).toHaveBeenCalledTimes(start + burst);
      expect(refreshManagerRetention().lastRefresh).toBe(1024);
    }

    expect(refresh).toHaveBeenCalledTimes(5000);
    expect(refreshManagerRetention()).toEqual({
      pending: 0,
      lastRefresh: 1024,
      inFlight: 0,
      baselines: 0,
      intervals: 0,
    });
    expect(vi.getTimerCount()).toBe(0);

    cancelPendingRefreshes();
    expect(refreshManagerRetention()).toEqual({
      pending: 0,
      lastRefresh: 0,
      inFlight: 0,
      baselines: 0,
      intervals: 0,
    });
  });
});
