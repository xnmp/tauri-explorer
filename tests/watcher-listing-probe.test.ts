import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdListingForWatcherWrites } from "../src/test-support/watcher-listing-probe";

let events: EventTarget;
let dataset: Record<string, string>;
function receipt(path: string, count: number, observedAt = Date.now(), origin: "watcher" | "mutation" = "mutation") {
  events.dispatchEvent(Object.assign(new Event("e2e-directory-watcher-receipt"), {
    detail: { path, count, observedAt, origin },
  }));
}
const result = () => JSON.parse(dataset.e2eWatcherWriteOperation);

beforeEach(() => {
  vi.useFakeTimers();
  events = new EventTarget();
  dataset = {};
  vi.stubGlobal("window", events);
  vi.stubGlobal("document", { documentElement: { dataset } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("native held-listing write protocol", () => {
  it("requires a fresh receipt for each real write and publishes all three acknowledgements", async () => {
    const writes: string[] = [];
    const pending = holdListingForWatcherWrites({
      path: "/fixture", operation: "unique", signal: new AbortController().signal,
      write: async (path) => { writes.push(path); },
    });
    await vi.advanceTimersByTimeAsync(0);
    receipt("/elsewhere", 100);
    receipt("/fixture", 1, Date.now() - 1);
    receipt("/fixture", 100, Date.now(), "watcher");
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(["/fixture/unique-0.txt"]);
    for (let count = 1; count <= 3; count++) {
      receipt("/fixture", count);
      await vi.advanceTimersByTimeAsync(0);
      if (count < 3) {
        receipt("/fixture", count); // A reused acknowledgement cannot advance.
        await vi.advanceTimersByTimeAsync(0);
        expect(writes).toHaveLength(count + 1);
      }
    }
    await pending;
    expect(writes).toEqual([0, 1, 2].map(i => `/fixture/unique-${i}.txt`));
    expect(result().status).toBe("completed");
    expect(result().acknowledgements.map((ack: { count: number }) => ack.count)).toEqual([1, 2, 3]);
    expect(result().acknowledgements.map((ack: { origin: string }) => ack.origin)).toEqual(["mutation", "mutation", "mutation"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out even when a receipt arrives but the write response never returns", async () => {
    const remove = vi.spyOn(events, "removeEventListener");
    const pending = holdListingForWatcherWrites({
      path: "/fixture", operation: "stalled", signal: new AbortController().signal,
      write: () => { receipt("/fixture", 1); return new Promise(() => {}); },
    });
    const rejected = expect(pending).rejects.toThrow("within 15 seconds");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(result().status).toBe("failed");
    expect(remove).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an outstanding operation without publishing over its replacement", async () => {
    const controller = new AbortController();
    const write = vi.fn(async () => {});
    const pending = holdListingForWatcherWrites({
      path: "/fixture", operation: "cancelled", signal: controller.signal, write,
    });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    dataset.e2eWatcherWriteOperation = "replacement";
    controller.abort();
    await rejected;
    receipt("/fixture", 1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(dataset.e2eWatcherWriteOperation).toBe("replacement");
    expect(vi.getTimerCount()).toBe(0);
  });
});
