import { describe, expect, it } from "vitest";
import { sanitizeRecentHistory, sanitizeFrecencyHistory } from "$lib/domain/history";
describe("optional persisted history validation", () => {
  it("normalizes missing, malformed and wrong-shaped roots", () => {
    for (const value of [null, undefined, 0, "entries", {}]) {
      expect(sanitizeRecentHistory(value)).toEqual([]);
      expect(sanitizeFrecencyHistory(value)).toEqual([]);
    }
  });
  it("keeps valid entries and rejects malformed records without mutating input", () => {
    const recent = { name: "notes.md", path: "/notes.md", kind: "file", timestamp: 12 };
    expect(sanitizeRecentHistory([null, recent, { ...recent, kind: "invalid" }, { ...recent, timestamp: NaN }, { ...recent, path: "a".repeat(40000) }])).toEqual([recent]);
    const frequent = { path: "/data", accesses: [1, "wrong", Infinity, -1, 2], dismissedFromRecent: true };
    expect(sanitizeFrecencyHistory([null, frequent])).toEqual([{ path: "/data", accesses: [1, 2], dismissedFromRecent: true }]);
    expect(frequent.accesses).toEqual([1, "wrong", Infinity, -1, 2]);
  });
  it("bounds records and access histories", () => {
    expect(sanitizeRecentHistory(Array.from({ length: 1000 }, (_, i) => ({ name: "file", path: `/${i}`, kind: "file", timestamp: i })))).toHaveLength(50);
    const result = sanitizeFrecencyHistory(Array.from({ length: 1000 }, (_, i) => ({ path: `/${i}`, accesses: Array.from({ length: 100 }, (_, j) => j) })));
    expect(result).toHaveLength(200); expect(result[0].accesses).toEqual([90,91,92,93,94,95,96,97,98,99]);
  });
});
