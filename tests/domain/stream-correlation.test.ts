import { describe, expect, it } from "vitest";
import {
  heldEventsFor,
  holdStreamEvent,
  noHeldStreamEvents,
  type HeldStreamEvents,
} from "$lib/domain/stream-correlation";

/** Events of broadcast search streams received before a run knows its id (#1581). */
interface Ev {
  readonly searchId: number;
  readonly n: number;
}

const hold = (events: readonly Ev[], retention: "latest" | "all"): HeldStreamEvents<Ev> =>
  events.reduce((held, event) => holdStreamEvent(held, event, retention), noHeldStreamEvents<Ev>());

describe("stream correlation", () => {
  it("releases nothing for a stream that sent nothing", () => {
    const held = hold([{ searchId: 1, n: 1 }], "all");
    expect(heldEventsFor(held, 2)).toEqual([]);
    expect(heldEventsFor(noHeldStreamEvents<Ev>(), 1)).toEqual([]);
  });

  it("keeps every increment of each stream, in arrival order, apart from other streams", () => {
    const held = hold(
      [
        { searchId: 7, n: 1 },
        { searchId: 9, n: 1 },
        { searchId: 7, n: 2 },
        { searchId: 7, n: 3 },
      ],
      "all",
    );
    expect(heldEventsFor(held, 7).map((e) => e.n)).toEqual([1, 2, 3]);
    expect(heldEventsFor(held, 9).map((e) => e.n)).toEqual([1]);
  });

  it("keeps only the newest snapshot per stream, so a long wait holds one event each", () => {
    const events = Array.from({ length: 10_000 }, (_, i) => ({ searchId: i % 2, n: i }));
    const held = hold(events, "latest");
    expect(heldEventsFor(held, 0)).toEqual([{ searchId: 0, n: 9998 }]);
    expect(heldEventsFor(held, 1)).toEqual([{ searchId: 1, n: 9999 }]);
    expect(held.size).toBe(2);
  });

  it("never mutates an earlier hold", () => {
    const before = hold([{ searchId: 1, n: 1 }], "all");
    const after = holdStreamEvent(before, { searchId: 1, n: 2 }, "all");
    expect(heldEventsFor(before, 1).map((e) => e.n)).toEqual([1]);
    expect(heldEventsFor(after, 1).map((e) => e.n)).toEqual([1, 2]);
  });
});
