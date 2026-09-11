import { describe, expect, it } from "vitest";
import {
  emptyRecoveryStorage,
  formatRecoveryBytes,
  mergeRecoveryPresentation,
  summarizeRecoveryStorage,
} from "$lib/domain/file-recovery";
import type { FileRecoveryItem, FileRecoveryStorage } from "$lib/domain/file-recovery";

function storage(overrides: Partial<FileRecoveryStorage> = {}): FileRecoveryStorage {
  return { ...emptyRecoveryStorage(), budgetBytes: "2147483648", recordBudget: 256, ...overrides };
}

describe("retained byte formatting", () => {
  it("scales binary units and keeps one decimal above bytes", () => {
    expect(formatRecoveryBytes("0")).toBe("0 B");
    expect(formatRecoveryBytes("512")).toBe("512 B");
    expect(formatRecoveryBytes("1024")).toBe("1 KB");
    expect(formatRecoveryBytes("1536")).toBe("1.5 KB");
    expect(formatRecoveryBytes("742391808")).toBe("708 MB");
    expect(formatRecoveryBytes("2147483648")).toBe("2 GB");
  });

  it("reports an unmeasured or malformed counter as unknown instead of zero", () => {
    expect(formatRecoveryBytes(null)).toBe("unknown");
    expect(formatRecoveryBytes("")).toBe("unknown");
    expect(formatRecoveryBytes("-1")).toBe("unknown");
    expect(formatRecoveryBytes("12.5")).toBe("unknown");
    expect(formatRecoveryBytes("007")).toBe("unknown");
    expect(formatRecoveryBytes("not a number")).toBe("unknown");
    // Beyond the signed 64-bit journal range.
    expect(formatRecoveryBytes("99999999999999999999")).toBe("unknown");
  });

  it("keeps counters beyond exact number range in the largest unit", () => {
    // 2^60 bytes is exactly 1024 TB and exceeds Number.MAX_SAFE_INTEGER.
    expect(formatRecoveryBytes("1152921504606846976")).toMatch(/TB$/);
  });
});

describe("retention summary", () => {
  it("reports usage against whichever bound is closest to capacity", () => {
    const summary = summarizeRecoveryStorage(storage({ usedBytes: "1073741824", records: 4 }));
    expect(summary.usedLabel).toBe("1 GB");
    expect(summary.budgetLabel).toBe("2 GB");
    expect(summary.percent).toBeCloseTo(50, 5);
    expect(summary.atCapacity).toBe(false);
    expect(summary.notes).toEqual([]);
  });

  it("uses the record bound when it is the binding constraint", () => {
    const summary = summarizeRecoveryStorage(storage({ usedBytes: "1024", records: 128 }));
    expect(summary.percent).toBeCloseTo(50, 5);
  });

  it("clamps to the meter range and survives an unknown budget", () => {
    expect(summarizeRecoveryStorage(storage({ usedBytes: "4294967296" })).percent).toBe(100);
    const unknown = summarizeRecoveryStorage(storage({ budgetBytes: "0", recordBudget: 0, usedBytes: "10" }));
    expect(unknown.percent).toBe(0);
    expect(unknown.budgetLabel).toBe("0 B");
  });

  it("explains unavailable and unmeasured records, and capacity", () => {
    const summary = summarizeRecoveryStorage(storage({
      usedBytes: "2147483648", records: 2, unavailable: 1, unmeasured: 2, atCapacity: true,
    }));
    expect(summary.atCapacity).toBe(true);
    expect(summary.notes).toEqual([
      "1 record is on an unavailable location and cannot be discarded",
      "2 records have not been measured yet",
      "New overwrites will not retain a recoverable copy until space is freed",
    ]);
  });
});

describe("presentation merge", () => {
  function item(overrides: Partial<FileRecoveryItem> = {}): FileRecoveryItem {
    return {
      id: "a", generation: "3", originalPath: "/a", retainedPath: null, retainedBytes: null,
      status: "pending", message: "m", actions: [], ...overrides,
    };
  }

  it("keeps an inspected retained presentation for an unchanged record", () => {
    const inspected = { revision: "3", items: [item({ status: "retained", actions: ["discard" as const], retainedBytes: "10" })], storage: storage(), error: null };
    const incoming = { revision: "4", items: [item()], storage: storage({ records: 1 }), error: null };
    const merged = mergeRecoveryPresentation(inspected, incoming);
    expect(merged.items[0].status).toBe("retained");
    expect(merged.items[0].actions).toEqual(["discard"]);
    // Fresh native accounting always wins over the retained presentation.
    expect(merged.storage.records).toBe(1);
  });

  it("drops the retained presentation once the record's generation changes", () => {
    const inspected = { revision: "3", items: [item({ status: "retained", actions: ["discard" as const] })], storage: storage(), error: null };
    const incoming = { revision: "4", items: [item({ generation: "4" })], storage: storage(), error: null };
    expect(mergeRecoveryPresentation(inspected, incoming).items[0].status).toBe("pending");
  });
});
