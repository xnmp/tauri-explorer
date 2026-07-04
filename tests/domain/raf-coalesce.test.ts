/**
 * rAF coalescing for high-frequency streams (VirtualList scroll batching,
 * issue #133): many pushes within one frame must collapse into a single
 * apply with the LATEST value; cancel must drop pending work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRafCoalescer } from "$lib/domain/raf-coalesce";

type RafCallback = (time: number) => void;

function installRafHarness() {
  const pending = new Map<number, RafCallback>();
  let nextId = 1;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb: RafCallback) => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      pending.delete(id);
    }),
  );
  return {
    pendingCount: () => pending.size,
    flushFrame: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((cb) => cb(performance.now()));
    },
  };
}

let raf: ReturnType<typeof installRafHarness>;

beforeEach(() => {
  raf = installRafHarness();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRafCoalescer", () => {
  it("collapses many pushes in one frame into a single apply of the latest value", () => {
    const apply = vi.fn();
    const c = createRafCoalescer<number>(apply);

    c.push(10);
    c.push(250);
    c.push(999);

    expect(apply).not.toHaveBeenCalled(); // nothing until the frame
    expect(raf.pendingCount()).toBe(1); // one scheduled callback, not three

    raf.flushFrame();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(999);
  });

  it("schedules a fresh frame for pushes after a flush", () => {
    const apply = vi.fn();
    const c = createRafCoalescer<number>(apply);

    c.push(1);
    raf.flushFrame();
    c.push(2);
    raf.flushFrame();

    expect(apply.mock.calls.map((args) => args[0])).toEqual([1, 2]);
  });

  it("an empty frame applies nothing", () => {
    const apply = vi.fn();
    createRafCoalescer<number>(apply);
    raf.flushFrame();
    expect(apply).not.toHaveBeenCalled();
  });

  it("cancel drops the pending value and the scheduled frame", () => {
    const apply = vi.fn();
    const c = createRafCoalescer<number>(apply);

    c.push(42);
    c.cancel();

    expect(raf.pendingCount()).toBe(0);
    raf.flushFrame();
    expect(apply).not.toHaveBeenCalled();
  });

  it("push after cancel works again", () => {
    const apply = vi.fn();
    const c = createRafCoalescer<number>(apply);

    c.push(1);
    c.cancel();
    c.push(7);
    raf.flushFrame();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(7);
  });
});
