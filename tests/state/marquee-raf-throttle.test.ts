/**
 * Marquee rAF batching: a high-frequency mousemove stream must coalesce into a
 * single dragCurrent update per animation frame, preserving the latest pointer
 * position but not running the reactive chain more than once per frame.
 * Issue: #47
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("$lib/domain/zoom", () => ({
  getZoomFactor: () => 1,
  clientToCSSRelative: (c: number, r: number) => c - r,
  rectDimToCSS: (v: number) => v,
  cssToRect: (v: number) => v,
}));

import { useMarqueeSelection } from "$lib/composables/use-marquee-selection.svelte";

type RafCallback = (time: number) => void;

function installRafHarness() {
  const pending = new Map<number, RafCallback>();
  let nextId = 1;
  const raf = vi.fn((cb: RafCallback) => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  });
  const caf = vi.fn((id: number) => {
    pending.delete(id);
  });
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", caf);

  return {
    raf,
    caf,
    pendingCount: () => pending.size,
    flushFrame: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((cb) => cb(performance.now()));
    },
  };
}

function makeMouseEvent(clientX: number, clientY: number): MouseEvent {
  return { clientX, clientY, buttons: 1, button: 0, target: null, ctrlKey: false, metaKey: false, preventDefault: () => {} } as unknown as MouseEvent;
}

function makeRect(): DOMRect {
  return { left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => ({}) };
}

function makeBackgroundStart(): MouseEvent {
  const el = { classList: { contains: (cls: string) => cls === "content" } } as unknown as HTMLElement;
  return { clientX: 10, clientY: 10, buttons: 1, button: 0, target: el, ctrlKey: false, metaKey: false, preventDefault: () => {} } as unknown as MouseEvent;
}

describe("marquee rAF batching", () => {
  let harness: ReturnType<typeof installRafHarness>;

  beforeEach(() => {
    (globalThis as { document?: unknown }).document = { activeElement: null };
    if (!(globalThis as { HTMLElement?: unknown }).HTMLElement) {
      (globalThis as { HTMLElement?: unknown }).HTMLElement = class {};
    }
    harness = installRafHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces many mousemove calls into a single rAF per frame", () => {
    const marquee = useMarqueeSelection();
    marquee.start(makeBackgroundStart(), makeRect());

    // rAF count before any moves
    const rafCountBefore = harness.raf.mock.calls.length;

    for (let i = 0; i < 20; i++) {
      marquee.move(makeMouseEvent(100 + i, 100 + i), makeRect());
    }

    // Only one rAF should have been scheduled despite 20 moves
    expect(harness.raf.mock.calls.length - rafCountBefore).toBe(1);
    expect(harness.pendingCount()).toBe(1);
  });

  it("commits the latest event's coordinates when the frame fires", () => {
    const marquee = useMarqueeSelection({ headerHeight: 0 });
    marquee.start(makeBackgroundStart(), makeRect(), 0);

    marquee.move(makeMouseEvent(100, 100), makeRect(), 0);
    marquee.move(makeMouseEvent(200, 200), makeRect(), 0);
    marquee.move(makeMouseEvent(300, 350), makeRect(), 0);

    // Before the frame fires, marqueeRect still reflects the start position (width 0)
    expect(marquee.marqueeRect?.width).toBe(0);

    harness.flushFrame();

    // After flush, marqueeRect reflects the LAST move, not the first or intermediate
    expect(marquee.marqueeRect).toEqual({ left: 10, top: 10, width: 290, height: 340 });
  });

  it("schedules a fresh rAF for the next frame's moves", () => {
    const marquee = useMarqueeSelection();
    marquee.start(makeBackgroundStart(), makeRect());

    marquee.move(makeMouseEvent(50, 50), makeRect());
    marquee.move(makeMouseEvent(60, 60), makeRect());
    harness.flushFrame();

    const rafCountAfterFirstFrame = harness.raf.mock.calls.length;

    marquee.move(makeMouseEvent(70, 70), makeRect());
    marquee.move(makeMouseEvent(80, 80), makeRect());

    expect(harness.raf.mock.calls.length - rafCountAfterFirstFrame).toBe(1);
  });

  it("cancels pending rAF on end()", () => {
    const marquee = useMarqueeSelection();
    marquee.start(makeBackgroundStart(), makeRect());
    marquee.move(makeMouseEvent(100, 100), makeRect());

    expect(harness.pendingCount()).toBe(1);

    marquee.end();

    expect(harness.caf).toHaveBeenCalled();
    expect(harness.pendingCount()).toBe(0);
  });

  it("calls onFlush after committing dragCurrent", () => {
    const marquee = useMarqueeSelection({ headerHeight: 0 });
    marquee.start(makeBackgroundStart(), makeRect(), 0);

    const flush = vi.fn(() => {
      // At the time onFlush runs, marqueeRect must reflect the latest move
      expect(marquee.marqueeRect).toEqual({ left: 10, top: 10, width: 290, height: 340 });
    });

    marquee.move(makeMouseEvent(300, 350), makeRect(), 0, flush);
    expect(flush).not.toHaveBeenCalled();

    harness.flushFrame();
    expect(flush).toHaveBeenCalledOnce();
  });

  it("calls only the last onFlush when moves coalesce", () => {
    const marquee = useMarqueeSelection();
    marquee.start(makeBackgroundStart(), makeRect());

    const flushA = vi.fn();
    const flushB = vi.fn();
    const flushC = vi.fn();

    marquee.move(makeMouseEvent(50, 50), makeRect(), undefined, flushA);
    marquee.move(makeMouseEvent(100, 100), makeRect(), undefined, flushB);
    marquee.move(makeMouseEvent(150, 150), makeRect(), undefined, flushC);

    harness.flushFrame();

    expect(flushA).not.toHaveBeenCalled();
    expect(flushB).not.toHaveBeenCalled();
    expect(flushC).toHaveBeenCalledOnce();
  });

  it("does not call onFlush if end() cancels the pending rAF", () => {
    const marquee = useMarqueeSelection();
    marquee.start(makeBackgroundStart(), makeRect());

    const flush = vi.fn();
    marquee.move(makeMouseEvent(100, 100), makeRect(), undefined, flush);

    expect(harness.pendingCount()).toBe(1);

    marquee.end();

    expect(harness.pendingCount()).toBe(0);
    expect(flush).not.toHaveBeenCalled();
  });
});
