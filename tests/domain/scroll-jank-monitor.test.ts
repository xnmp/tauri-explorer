/**
 * Tests for the scroll jank monitor (#593).
 */
import { describe, it, expect, vi } from "vitest";
import { createScrollJankMonitor } from "$lib/domain/scroll-jank-monitor";

/** Builds injectable raf/caf where raf captures its callback for manual driving. */
function makeInjectables() {
  let nextId = 1;
  let pending: { id: number; cb: (ts: number) => void } | null = null;
  const caf = vi.fn((id: number) => {
    if (pending?.id === id) pending = null;
  });
  const raf = vi.fn((cb: (ts: number) => void) => {
    const id = nextId++;
    pending = { id, cb };
    return id;
  });
  /** Invokes the currently pending raf callback with the given timestamp. */
  function frame(ts: number) {
    const current = pending;
    if (!current) throw new Error("no pending raf callback to drive");
    current.cb(ts);
  }
  return { raf, caf, frame };
}

describe("createScrollJankMonitor", () => {
  it("reports 0 longFrames for normal 16ms cadence", () => {
    const { raf, caf, frame } = makeInjectables();
    const monitor = createScrollJankMonitor({ raf, caf });
    monitor.start();
    frame(0);
    frame(16);
    frame(32);
    frame(48);
    const report = monitor.stop();
    expect(report?.longFrames).toBe(0);
    expect(report?.frames).toBe(3);
    expect(report?.worstFrameMs).toBe(16);
  });

  it("counts gaps over the threshold and tracks the worst one", () => {
    const { raf, caf, frame } = makeInjectables();
    const monitor = createScrollJankMonitor({ raf, caf });
    monitor.start();
    frame(0);
    frame(16); // gap 16, fine
    frame(66); // gap 50, long
    frame(82); // gap 16, fine
    frame(182); // gap 100, long, new worst
    const report = monitor.stop();
    expect(report?.longFrames).toBe(2);
    expect(report?.worstFrameMs).toBe(100);
  });

  it("respects a custom longFrameMs threshold", () => {
    const { raf, caf, frame } = makeInjectables();
    const monitor = createScrollJankMonitor({ raf, caf, longFrameMs: 10 });
    monitor.start();
    frame(0);
    frame(16); // gap 16 > 10 -> long
    frame(24); // gap 8 <= 10 -> fine
    const report = monitor.stop();
    expect(report?.longFrames).toBe(1);
  });

  it("computes durationMs as the span from first to last frame", () => {
    const { raf, caf, frame } = makeInjectables();
    const monitor = createScrollJankMonitor({ raf, caf });
    monitor.start();
    frame(100);
    frame(116);
    frame(250);
    const report = monitor.stop();
    expect(report?.durationMs).toBe(150);
  });

  it("counts frames as gaps between samples, not raw callback invocations", () => {
    const { raf, caf, frame } = makeInjectables();
    const monitor = createScrollJankMonitor({ raf, caf });
    monitor.start();
    frame(0); // first sample, no gap yet
    const afterOne = monitor.stop();
    expect(afterOne?.frames).toBe(0);

    monitor.start();
    frame(0);
    frame(16);
    frame(32);
    const afterThree = monitor.stop();
    expect(afterThree?.frames).toBe(2);
  });

  it("returns null from stop() if never started", () => {
    const { raf, caf } = makeInjectables();
    const monitor = createScrollJankMonitor({ raf, caf });
    expect(monitor.stop()).toBeNull();
  });

  it("returns null the second time stop() is called", () => {
    const { raf, caf, frame } = makeInjectables();
    const monitor = createScrollJankMonitor({ raf, caf });
    monitor.start();
    frame(0);
    frame(16);
    expect(monitor.stop()).not.toBeNull();
    expect(monitor.stop()).toBeNull();
  });

  it("is a no-op when start() is called while already running", () => {
    const { raf, caf, frame } = makeInjectables();
    const monitor = createScrollJankMonitor({ raf, caf });
    monitor.start();
    frame(0);
    frame(66); // long frame, counted
    monitor.start(); // should not reset counters mid-run
    frame(82); // gap from ts=66 -> 16, fine
    const report = monitor.stop();
    expect(report?.longFrames).toBe(1);
    expect(report?.frames).toBe(2);
  });

  it("resets counters when restarted after a prior stop()", () => {
    const { raf, caf, frame } = makeInjectables();
    const monitor = createScrollJankMonitor({ raf, caf });
    monitor.start();
    frame(0);
    frame(66); // long frame
    monitor.stop();

    monitor.start();
    frame(200);
    frame(216); // normal gap
    const report = monitor.stop();
    expect(report?.longFrames).toBe(0);
    expect(report?.frames).toBe(1);
    expect(report?.worstFrameMs).toBe(16);
  });

  it("calls caf with the pending raf id on stop", () => {
    const { raf, caf, frame } = makeInjectables();
    const monitor = createScrollJankMonitor({ raf, caf });
    monitor.start();
    frame(0);
    const idAfterFirstFrame = raf.mock.results[raf.mock.calls.length - 1]
      .value as number;
    monitor.stop();
    expect(caf).toHaveBeenCalledWith(idAfterFirstFrame);
  });

  it("exposes running as true while active and false after stop", () => {
    const { raf, caf, frame } = makeInjectables();
    const monitor = createScrollJankMonitor({ raf, caf });
    expect(monitor.running).toBe(false);
    monitor.start();
    expect(monitor.running).toBe(true);
    frame(0);
    monitor.stop();
    expect(monitor.running).toBe(false);
  });
});
