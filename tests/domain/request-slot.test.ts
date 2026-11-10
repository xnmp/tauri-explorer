import { describe, expect, it } from "vitest";
import {
  beginSlot, cancelSlot, clearSlot, idleSlot, isSlotCurrent, isSlotLoading, settleSlot, slotData, type Slot,
} from "$lib/domain/request-slot";

type S = Slot<string, string, string>;
const idle = idleSlot<string, string, string>();
const readyOf = (key: string, data: string): S => settleSlot(beginSlot(idle, key, 0), 0, { ok: true, data });

describe("request slot", () => {
  it("starts idle and begins loading with its key and no previous data", () => {
    expect(idle).toEqual({ kind: "idle" });
    const s = beginSlot(idle, "k", 1);
    expect(s).toMatchObject({ kind: "loading", key: "k", token: 1 });
    expect(slotData(s)).toBeUndefined();
    expect(isSlotLoading(s)).toBe(true);
  });

  it("settles the current token to ready or failed under the begun key", () => {
    const loading = beginSlot(idle, "k", 1);
    expect(settleSlot(loading, 1, { ok: true, data: "d" })).toEqual({ kind: "ready", key: "k", data: "d" });
    expect(settleSlot(loading, 1, { ok: false, error: "boom" })).toEqual({ kind: "failed", key: "k", error: "boom", previous: undefined });
  });

  it("ignores a stale settle by returning the same slot object", () => {
    const first = beginSlot(idle, "a", 1);
    const second = beginSlot(first, "b", 2);
    expect(settleSlot(second, 1, { ok: true, data: "late" })).toBe(second);
    expect(settleSlot(second, 1, { ok: false, error: "late" })).toBe(second);
  });

  it("ignores a settle after clear, and clear of idle is identity", () => {
    const loading = beginSlot(idle, "k", 1);
    const cleared: S = clearSlot(loading);
    expect(cleared).toEqual({ kind: "idle" });
    expect(settleSlot(cleared, 1, { ok: true, data: "late" })).toBe(cleared);
    expect(clearSlot(cleared)).toBe(cleared);
  });

  it("ignores a second settle once the slot is ready or failed", () => {
    const ready = settleSlot(beginSlot(idle, "k", 1), 1, { ok: true, data: "d" });
    expect(settleSlot(ready, 1, { ok: true, data: "again" })).toBe(ready);
    const failed = settleSlot(beginSlot(idle, "k", 1), 1, { ok: false, error: "e" });
    expect(settleSlot(failed, 1, { ok: true, data: "d" })).toBe(failed);
  });

  it("keeps ready data as previous while reloading, through superseded reloads", () => {
    const ready = settleSlot(beginSlot(idle, "k", 1), 1, { ok: true, data: "old" });
    const reload = beginSlot(ready, "k", 2);
    expect(slotData(reload)).toBe("old");
    expect(slotData(beginSlot(reload, "k", 3))).toBe("old");
    expect(slotData(settleSlot(reload, 2, { ok: false, error: "e" }))).toBeUndefined();
  });

  it("drops previous data after failed or cleared slots", () => {
    const failed = settleSlot(beginSlot(idle, "k", 1), 1, { ok: false, error: "e" });
    expect(slotData(beginSlot(failed, "k", 2))).toBeUndefined();
    const ready = settleSlot(beginSlot(idle, "k", 1), 1, { ok: true, data: "d" });
    expect(slotData(beginSlot(clearSlot(ready), "k", 2))).toBeUndefined();
  });

  it("reports data only for ready and loading-with-previous", () => {
    expect(slotData(idle)).toBeUndefined();
    expect(slotData(settleSlot(beginSlot(idle, "k", 1), 1, { ok: true, data: "d" }))).toBe("d");
    expect(isSlotLoading(idle)).toBe(false);
  });

  it("keeps previous data after a failed reload only when the failure opts in", () => {
    const ready = readyOf("k", "old");
    const dropped = settleSlot(beginSlot(ready, "k", 1), 1, { ok: false, error: "e" });
    expect(slotData(dropped)).toBeUndefined();
    const kept = settleSlot(beginSlot(ready, "k", 1), 1, { ok: false, error: "e", keepPrevious: true });
    expect(kept).toMatchObject({ kind: "failed", error: "e", previous: "old" });
    expect(slotData(kept)).toBe("old");
    // A retry from the kept failure still shows the old data, and can fail again.
    const retry = beginSlot(kept, "k", 2);
    expect(slotData(retry)).toBe("old");
    expect(settleSlot(retry, 2, { ok: true, data: "new" })).toEqual({ kind: "ready", key: "k", data: "new" });
  });

  it("reports whether a token is the request in flight", () => {
    const loading = beginSlot(idle, "k", 4);
    expect(isSlotCurrent(loading, 4)).toBe(true);
    expect(isSlotCurrent(loading, 3)).toBe(false);
    expect(isSlotCurrent(clearSlot(loading), 4)).toBe(false);
    expect(isSlotCurrent(settleSlot(loading, 4, { ok: true, data: "d" }), 4)).toBe(false);
  });

  it("cancel revokes the request but restores the previous data", () => {
    const reload = beginSlot(readyOf("k", "old"), "k", 2);
    const cancelled = cancelSlot(reload);
    expect(cancelled).toEqual({ kind: "ready", key: "k", data: "old" });
    expect(settleSlot(cancelled, 2, { ok: true, data: "late" })).toBe(cancelled);
    expect(cancelSlot(beginSlot(idle, "k", 1))).toEqual({ kind: "idle" });
  });

  it("cancel leaves non-loading slots untouched", () => {
    const ready = readyOf("k", "d");
    expect(cancelSlot(ready)).toBe(ready);
    expect(cancelSlot(idle)).toBe(idle);
  });
});
