/** Slow-load watchdog: capture while stuck, finalise on settle (#1022). */
import { describe, expect, it, vi } from "vitest";
import type { FrontendSlowLoadRecord } from "$lib/domain/load-diagnostics";
import { createLoadWatchdog } from "$lib/state/load-watchdog";

vi.mock("$lib/api/load-diagnostics", () => ({ recordSlowLoad: vi.fn(async () => {}) }));

/** A deterministic clock whose timers fire only when advanced past them. */
function harness(options: { persist?: (record: FrontendSlowLoadRecord) => Promise<void> } = {}) {
  let mono = 10_000;
  let epoch = 1_791_000_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const records: FrontendSlowLoadRecord[] = [];
  const watchdog = createLoadWatchdog({
    nowMono: () => mono,
    nowEpoch: () => epoch,
    setTimer: (callback, ms) => {
      const id = ++seq;
      timers.set(id, { at: mono + ms, callback });
      return id;
    },
    clearTimer: (id) => { timers.delete(id as number); },
    persist: options.persist ?? (async (record) => { records.push(structuredClone(record)); }),
    randomSuffix: () => "r",
    sinceBootMs: () => 1234,
  });
  return {
    watchdog,
    records,
    pendingTimers: () => timers.size,
    /** Advance time, firing due timers in order. */
    advance(ms: number) {
      const target = mono + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        mono = Math.max(mono, due[1].at);
        epoch += due[1].at - mono;
        due[1].callback();
      }
      epoch += target - mono;
      mono = target;
    },
    /** Advance time without firing timers: a blocked event loop. */
    stall(ms: number) { mono += ms; epoch += ms; },
  };
}

const begin = (h: ReturnType<typeof harness>, path = "/mnt/nas") =>
  h.watchdog.begin({ path, pane: 1, reason: "navigate", spinnerVisible: true });

describe("slow-load watchdog", () => {
  it("records a load that never finishes at the 5 s mark, naming the pending phase", () => {
    const h = harness();
    const load = begin(h);
    load.phase("queued");
    h.advance(2);
    load.phase("watch-ready");
    h.advance(3);
    load.phase("native");
    h.advance(4994);
    expect(h.records).toHaveLength(0);
    h.advance(1);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      id: load.id,
      path: "/mnt/nas",
      outcome: "pending",
      pendingPhase: "native",
      elapsedMs: 5000,
      thresholdMs: 5000,
      sinceBootMs: 1234,
    });
    // Nothing else is ever written for a load that stays stuck.
    h.advance(600_000);
    expect(h.records).toHaveLength(1);
    expect(h.watchdog.inFlight().map((trace) => trace.id)).toEqual([load.id]);
  });

  it("writes nothing for a load that finishes just under the threshold", () => {
    const h = harness();
    const load = begin(h);
    load.phase("native");
    h.advance(4999);
    load.finish("ok");
    h.advance(10_000);
    expect(h.records).toEqual([]);
    expect(h.pendingTimers()).toBe(0);
    expect(h.watchdog.inFlight()).toEqual([]);
  });

  it("replaces the pending record with the outcome when a recorded load finishes just over", () => {
    const h = harness();
    const load = begin(h);
    load.phase("native");
    h.advance(5000);
    h.advance(1);
    load.phase("publish");
    load.entries(42);
    load.finish("ok");
    expect(h.records.map((record) => record.outcome)).toEqual(["pending", "ok"]);
    expect(h.records[1]).toMatchObject({ id: load.id, elapsedMs: 5001, entries: 42, pendingPhase: null });
    expect(h.records[1].phases.map((phase) => phase.phase)).toEqual(["native", "publish"]);
  });

  it("still records a slow load whose timer was starved by a blocked event loop", () => {
    const h = harness();
    const load = begin(h);
    load.phase("publish");
    h.stall(8000);
    load.finish("ok");
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ outcome: "ok", elapsedMs: 8000 });
    expect(h.records[0].phases[0]).toMatchObject({ phase: "publish", durationMs: 8000 });
  });

  it("drops a load superseded before the threshold, but finalises one superseded after it", () => {
    const h = harness();
    const quick = begin(h, "/quick");
    quick.phase("native");
    h.advance(300);
    quick.finish("superseded");
    const stuck = begin(h, "/stuck");
    stuck.phase("native");
    h.advance(6000);
    stuck.finish("superseded");
    expect(h.records.map((record) => [record.path, record.outcome])).toEqual([
      ["/stuck", "pending"],
      ["/stuck", "superseded"],
    ]);
  });

  it("keeps overlapping loads in different panes independent", () => {
    const h = harness();
    const left = h.watchdog.begin({ path: "/left", pane: 1, reason: "initial", spinnerVisible: true });
    left.phase("native");
    h.advance(1000);
    const right = h.watchdog.begin({ path: "/right", pane: 2, reason: "initial", spinnerVisible: true });
    right.phase("watch-ready");
    expect(left.id).not.toBe(right.id);
    h.advance(4000);
    expect(h.records.map((record) => record.path)).toEqual(["/left"]);
    expect(h.records[0].othersInFlight).toEqual([{ path: "/right", pendingPhase: "watch-ready", elapsedMs: 4000 }]);
    right.finish("ok");
    h.advance(10_000);
    expect(h.records.map((record) => record.path)).toEqual(["/left"]);
    left.finish("error");
    expect(h.records.map((record) => [record.path, record.outcome])).toEqual([["/left", "pending"], ["/left", "error"]]);
  });

  it("ignores repeated or late calls on a settled load", () => {
    const h = harness();
    const load = begin(h);
    h.advance(6000);
    load.finish("ok");
    load.finish("error");
    load.phase("publish");
    load.entries(3);
    expect(h.records.map((record) => record.outcome)).toEqual(["pending", "ok"]);
  });

  it("never throws into the load when the sink fails or the drive resolver throws", () => {
    const h = harness({
      persist: () => Promise.reject(new Error("disk full")),
    });
    h.watchdog.setDriveKindResolver(() => { throw new Error("drives unavailable"); });
    const load = begin(h);
    expect(() => h.advance(5000)).not.toThrow();
    expect(() => load.finish("ok")).not.toThrow();
  });

  it("attaches the drive kind of the stuck path", () => {
    const h = harness();
    h.watchdog.setDriveKindResolver((path) => (path.startsWith("/run/media") ? "removable" : null));
    begin(h, "/run/media/u/usb");
    h.advance(5000);
    expect(h.records[0].driveKind).toBe("removable");
  });

  it("mints distinct valid trace IDs even within one millisecond", () => {
    const h = harness();
    const ids = new Set([h.watchdog.mintTraceId(), h.watchdog.mintTraceId(), begin(h).id, begin(h).id]);
    expect(ids.size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^\d{13}-[0-9a-z]{1,16}$/);
  });
});

describe("slow-load watchdog bounds", () => {
  it("never retains more than a bounded number of unsettled loads", () => {
    const h = harness();
    const loads = Array.from({ length: 200 }, (_, n) => begin(h, `/leak/${n}`));
    expect(h.watchdog.inFlight().length).toBe(64);
    expect(h.watchdog.inFlight().at(-1)?.path).toBe("/leak/199");
    expect(h.pendingTimers()).toBe(64);
    for (const load of loads) load.finish("ok");
    expect(h.watchdog.inFlight()).toEqual([]);
  });
});
