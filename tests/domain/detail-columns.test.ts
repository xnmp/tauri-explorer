import { describe, it, expect } from "vitest";
import { normalizeColumnWidths, columnGridTemplate } from "$lib/domain/detail-columns";

describe("Details column layout", () => {
  it("normalizes missing and malformed sizes without hiding columns", () => {
    expect(normalizeColumnWidths(null)).toEqual({ name: 300, date: 180, type: 140, size: 100 });
    expect(normalizeColumnWidths({ name: NaN, date: "200", type: Infinity, size: null }))
      .toEqual({ name: 300, date: 180, type: 140, size: 100 });
  });
  it("bounds extreme sizes while retaining valid fractional pointer sizes", () => {
    expect(normalizeColumnWidths({ name: -1, date: 0, type: Number.MAX_VALUE, size: 100.5 }))
      .toEqual({ name: 150, date: 80, type: 4096, size: 100.5 });
  });
  it("projects visible columns in order and retains widths when they return", () => {
    const widths = normalizeColumnWidths({ date: 240 });
    expect(columnGridTemplate(widths, { date: false, type: false, size: true })).toBe("300px 100px");
    expect(columnGridTemplate(widths, { date: true, type: true, size: true })).toBe("300px 240px 140px 100px");
    expect(columnGridTemplate(widths, { date: false, type: false, size: false })).toBe("300px");
  });
});
