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

  it("last-writer-wins when different callbacks target the same directory", () => {
    const firstRefresh = vi.fn();
    const secondRefresh = vi.fn();
    requestRefresh(firstRefresh, "/home/user/docs");
    requestRefresh(secondRefresh, "/home/user/docs");

    vi.advanceTimersByTime(150);
    expect(firstRefresh).not.toHaveBeenCalled();
    expect(secondRefresh).toHaveBeenCalledOnce();
  });
});
