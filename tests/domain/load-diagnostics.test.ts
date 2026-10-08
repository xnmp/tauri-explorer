/** Slow directory-load diagnostics: pure trace, record and report contracts (#1022). */
import { describe, expect, it } from "vitest";
import {
  MAX_TRACE_SPANS,
  SLOW_LOAD_THRESHOLD_MS,
  buildFrontendRecord,
  diagnoseSlowLoad,
  enterPhase,
  finishLoadTrace,
  formatSlowLoadsForReport,
  formatTraceId,
  isSlowLoad,
  isValidTraceId,
  noteEntries,
  noteQueuedBehind,
  pendingPhase,
  recordOnFinish,
  selectReportableSlowLoads,
  startLoadTrace,
  type LoadTrace,
  type NativeLoadSnapshot,
  type SlowLoadRecord,
} from "$lib/domain/load-diagnostics";
import { driveKindFor } from "$lib/domain/drives";

const T0 = 1_000;
const EPOCH = Date.UTC(2026, 9, 9, 12, 0, 0);

function trace(path = "/mnt/nas/photos"): LoadTrace {
  return startLoadTrace({ id: "1791000000000-abc", path, pane: 1, reason: "navigate", spinnerVisible: true }, T0, EPOCH);
}

function native(overrides: Partial<NativeLoadSnapshot> = {}): NativeLoadSnapshot {
  return {
    path: "/mnt/nas/photos",
    elapsedMs: 6900,
    outcome: "pending",
    pendingPhase: "read-dir",
    phases: [
      { phase: "watch-lock", startMs: 0, durationMs: 2, pending: false },
      { phase: "watch-register", startMs: 2, durationMs: 15, pending: false },
      { phase: "read-dir", startMs: 17, durationMs: 6883, pending: true },
    ],
    entriesListed: 0,
    entriesStatted: 0,
    statFailures: 0,
    entriesDone: 0,
    statMs: 0,
    resolveMs: 0,
    symlinks: 0,
    gitRepoProbe: true,
    stalledEntries: [],
    slowestEntry: null,
    ...overrides,
  };
}

function stored(record: ReturnType<typeof buildFrontendRecord>, extra: Partial<SlowLoadRecord> = {}): SlowLoadRecord {
  return {
    ...record,
    schema: 1,
    source: "frontend",
    native: null,
    blocker: null,
    filesystem: null,
    appVersion: "1.11.3",
    os: "linux",
    ...extra,
  };
}

describe("load trace", () => {
  it("keeps exactly one pending phase and measures each closed phase", () => {
    let t = trace();
    t = enterPhase(t, "queued", T0);
    t = enterPhase(t, "watch-ready", T0 + 3);
    t = enterPhase(t, "native", T0 + 10);
    expect(pendingPhase(t)).toBe("native");
    const record = buildFrontendRecord(t, { nowMono: T0 + 7010, nowEpoch: EPOCH + 7010 });
    expect(record.outcome).toBe("pending");
    expect(record.pendingPhase).toBe("native");
    expect(record.elapsedMs).toBe(7010);
    expect(record.phases).toEqual([
      { phase: "queued", startMs: 0, durationMs: 3, pending: false },
      { phase: "watch-ready", startMs: 3, durationMs: 7, pending: false },
      { phase: "native", startMs: 10, durationMs: 7000, pending: true },
    ]);
  });

  it("is final once settled: later phases and notes are ignored", () => {
    let t = enterPhase(trace(), "native", T0);
    t = finishLoadTrace(t, "ok", T0 + 100);
    const settled = t;
    expect(enterPhase(t, "publish", T0 + 200)).toBe(settled);
    expect(noteEntries(t, 5)).toBe(settled);
    expect(finishLoadTrace(t, "error", T0 + 300)).toBe(settled);
    expect(pendingPhase(t)).toBeNull();
    const record = buildFrontendRecord(t, { nowMono: T0 + 9999, nowEpoch: EPOCH });
    expect(record.elapsedMs).toBe(100);
    expect(record.outcome).toBe("ok");
  });

  it("bounds the number of spans a pathological load can grow", () => {
    let t = trace();
    for (let n = 0; n < MAX_TRACE_SPANS * 3; n++) t = enterPhase(t, n % 2 ? "native" : "decode", T0 + n);
    expect(t.spans.length).toBeLessThanOrEqual(MAX_TRACE_SPANS);
  });

  it("tolerates a clock that steps backwards", () => {
    let t = enterPhase(trace(), "native", T0 + 50);
    t = enterPhase(t, "decode", T0 + 10);
    const record = buildFrontendRecord(t, { nowMono: T0 - 5, nowEpoch: EPOCH });
    expect(record.phases.every((phase) => phase.durationMs >= 0)).toBe(true);
    expect(record.elapsedMs).toBe(0);
  });

  it("records a huge entry count as a number, not a list", () => {
    const t = noteEntries(enterPhase(trace(), "publish", T0), 2_000_000.7);
    const record = buildFrontendRecord(t, { nowMono: T0 + 6000, nowEpoch: EPOCH });
    expect(record.entries).toBe(2_000_000);
    expect(JSON.stringify(record).length).toBeLessThan(2000);
  });
});

describe("threshold", () => {
  it("is inclusive at exactly 5 s and rejects garbage elapsed values", () => {
    expect(isSlowLoad(SLOW_LOAD_THRESHOLD_MS - 1)).toBe(false);
    expect(isSlowLoad(SLOW_LOAD_THRESHOLD_MS)).toBe(true);
    expect(isSlowLoad(SLOW_LOAD_THRESHOLD_MS + 1)).toBe(true);
    expect(isSlowLoad(Number.NaN)).toBe(false);
    expect(isSlowLoad(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("records a finished load only when it crossed the threshold or was already recorded", () => {
    const under = finishLoadTrace(trace(), "ok", T0 + 4999);
    const exactly = finishLoadTrace(trace(), "ok", T0 + 5000);
    const superseded = finishLoadTrace(trace(), "superseded", T0 + 200);
    expect(recordOnFinish(under, false)).toBe(false);
    expect(recordOnFinish(exactly, false)).toBe(true);
    expect(recordOnFinish(superseded, false)).toBe(false);
    // A load recorded while stuck is always finalised, whatever its outcome.
    expect(recordOnFinish(superseded, true)).toBe(true);
    expect(recordOnFinish(trace(), true)).toBe(false);
  });
});

describe("record context", () => {
  it("reports what the load was queued behind and other loads in flight", () => {
    let stuck = enterPhase(trace("/a"), "queued", T0);
    stuck = noteQueuedBehind(stuck, { path: "/a", reason: "refresh", startedMono: T0 - 2000, traceId: "1791000000000-blk" });
    const other = enterPhase(
      startLoadTrace({ id: "1791000000001-xyz", path: "/b", reason: "initial", spinnerVisible: true }, T0 + 100, EPOCH),
      "native",
      T0 + 100,
    );
    const settled = finishLoadTrace(startLoadTrace({ id: "1791000000002-q", path: "/c", reason: "history", spinnerVisible: true }, T0, EPOCH), "ok", T0 + 1);
    const record = buildFrontendRecord(stuck, {
      nowMono: T0 + 5000,
      nowEpoch: EPOCH + 5000,
      driveKind: "network",
      sinceBootMs: 812.4,
      others: [stuck, other, settled],
    });
    expect(record.queuedBehind).toEqual({ path: "/a", reason: "refresh", elapsedMs: 7000, traceId: "1791000000000-blk" });
    expect(record.othersInFlight).toEqual([{ path: "/b", pendingPhase: "native", elapsedMs: 4900 }]);
    expect(record.driveKind).toBe("network");
    expect(record.sinceBootMs).toBe(812);
  });
});

describe("diagnosis", () => {
  it("descends into the native breakdown when the native command is the slow phase", () => {
    const t = enterPhase(enterPhase(trace(), "watch-ready", T0), "native", T0 + 4);
    const record = stored(buildFrontendRecord(t, { nowMono: T0 + 7000, nowEpoch: EPOCH }), { native: native() });
    expect(diagnoseSlowLoad(record)).toEqual({
      phase: "native read-dir",
      label: "reading directory entries (readdir)",
      durationMs: 6883,
      pending: true,
    });
  });

  it("names a frontend phase when the native command never started", () => {
    const t = enterPhase(trace(), "queued", T0);
    const record = stored(buildFrontendRecord(t, { nowMono: T0 + 5000, nowEpoch: EPOCH }));
    expect(diagnoseSlowLoad(record)).toMatchObject({ phase: "queued", pending: true, durationMs: 5000 });
  });

  it("names the slowest phase of a finished load", () => {
    let t = enterPhase(trace(), "native", T0);
    t = enterPhase(t, "publish", T0 + 300);
    t = finishLoadTrace(t, "ok", T0 + 6300);
    const record = stored(buildFrontendRecord(t, { nowMono: T0 + 6300, nowEpoch: EPOCH }));
    expect(diagnoseSlowLoad(record)).toMatchObject({ phase: "publish", pending: false, durationMs: 6000 });
  });

  it("explains a native-only record without frontend phases", () => {
    const record = stored(buildFrontendRecord(trace(), { nowMono: T0 + 7000, nowEpoch: EPOCH }), {
      source: "native-watchdog",
      native: native({ pendingPhase: "entry-metadata", phases: [{ phase: "entry-metadata", startMs: 0, durationMs: 7000, pending: true }] }),
    });
    expect(diagnoseSlowLoad(record)?.phase).toBe("native entry-metadata");
    expect(diagnoseSlowLoad(stored(buildFrontendRecord(trace(), { nowMono: T0, nowEpoch: EPOCH })))).toBeNull();
  });
});

describe("report text", () => {
  const stuck = () => {
    const t = enterPhase(enterPhase(trace(), "watch-ready", T0), "native", T0 + 4);
    return stored(buildFrontendRecord(t, { nowMono: T0 + 7000, nowEpoch: EPOCH + 7000 }), {
      native: native({ stalledEntries: [{ name: "hung-link", elapsedMs: 6000 }] }),
      filesystem: { fsType: "fuse.sshfs", mountPoint: "/mnt/nas", category: "network-fuse" },
    });
  };

  it("states the path, timing, stuck phase, entries and filesystem", () => {
    const text = formatSlowLoadsForReport([stuck()]);
    expect(text).toContain("1. /mnt/nas/photos");
    expect(text).toContain("2026-10-09T12:00:00.000Z · 7.0 s · still pending when captured · navigate");
    expect(text).toContain("stuck in: native read-dir — reading directory entries (readdir) (6.9 s)");
    expect(text).toContain("stalled entries: hung-link (6.0 s)");
    expect(text).toContain("filesystem: fuse.sshfs, network-fuse, mounted at /mnt/nas");
  });

  it("includes only whole records that fit the budget, newest first", () => {
    const records = Array.from({ length: 10 }, () => stuck());
    const one = formatSlowLoadsForReport(records.slice(0, 1));
    const text = formatSlowLoadsForReport(records, one.length * 2 + 2);
    expect(text.split("\n\n")).toHaveLength(2);
    expect(text.length).toBeLessThanOrEqual(one.length * 2 + 2);
  });

  it("cuts a single oversized record at a line boundary, and handles nothing to report", () => {
    const record = stuck();
    record.path = `/${"deep/".repeat(2000)}`;
    const text = formatSlowLoadsForReport([record], 400);
    expect(text.length).toBeLessThanOrEqual(400);
    expect(formatSlowLoadsForReport([])).toBe("");
    expect(formatSlowLoadsForReport([stuck()], 0)).toBe("");
  });

  it("offers only recent records, newest first, at most the limit", () => {
    const at = (capturedAt: number) => ({ ...stuck(), capturedAt });
    const now = EPOCH + 30 * 86_400_000;
    const chosen = selectReportableSlowLoads(
      [at(now - 1000), at(now - 8 * 86_400_000), at(now - 10), at(Number.NaN), at(now - 500), at(now - 2000)],
      now,
    );
    expect(chosen.map((record) => now - record.capturedAt)).toEqual([10, 500, 1000]);
  });
});

describe("trace identity", () => {
  it("formats chronological, file-name-safe IDs that the native side accepts", () => {
    const id = formatTraceId(1_791_466_540_015, "A_b/../9z");
    expect(id).toBe("1791466540015-ab9z");
    expect(isValidTraceId(id)).toBe(true);
    expect(isValidTraceId(formatTraceId(5, ""))).toBe(true);
    expect(isValidTraceId(formatTraceId(Number.NaN, "x"))).toBe(true);
    expect(isValidTraceId("../../etc/passwd")).toBe(false);
    expect(formatTraceId(1, "x") < formatTraceId(2, "a")).toBe(true);
  });
});

describe("drive kind of a path", () => {
  it("uses the most specific mounted drive root", () => {
    const drives = [
      { root: "/", kind: "fixed" as const },
      { root: "/run/media/u/usb", kind: "removable" as const },
      { root: "/mnt/nas", kind: "network" as const },
    ];
    expect(driveKindFor("/run/media/u/usb/photos", drives)).toBe("removable");
    expect(driveKindFor("/mnt/nas", drives)).toBe("network");
    expect(driveKindFor("/mnt/nasty", drives)).toBe("fixed");
    expect(driveKindFor("", drives)).toBeNull();
    expect(driveKindFor("/x", [])).toBeNull();
  });
});

describe("auto-enter and report budget", () => {
  it("retargets a load to the descended folder, keeping the requested one", async () => {
    const { retarget } = await import("$lib/domain/load-diagnostics");
    let t = retarget(trace("/local"), "/local/remote");
    t = retarget(t, "/local/remote/deeper");
    expect([t.path, t.requestedPath]).toEqual(["/local/remote/deeper", "/local"]);
    expect(retarget(trace("/same"), "/same").requestedPath).toBeNull();
    const record = stored(buildFrontendRecord(t, { nowMono: T0 + 5000, nowEpoch: EPOCH }));
    expect(formatSlowLoadsForReport([record])).toContain("1. /local/remote/deeper (auto-entered from /local)");
  });

  it("leaves diagnostics only the room the relay body has left", async () => {
    const { slowLoadReportBudget, MAX_SLOW_LOAD_REPORT_UNITS } = await import("$lib/domain/load-diagnostics");
    expect(slowLoadReportBudget("")).toBe(MAX_SLOW_LOAD_REPORT_UNITS);
    expect(slowLoadReportBudget("d".repeat(4000), "@me")).toBe(8500 - 600 - 4000 - 3);
    expect(slowLoadReportBudget("d".repeat(8000), "c".repeat(100))).toBe(0);
  });
});
