import { describe, expect, it } from "vitest";
import { COLUMN_KEYS, DETAIL_COLUMNS, columnGridTemplate, normalizeColumnWidths, type ColumnVisibility } from "$lib/domain/detail-columns";
import { normalizeSettingsInput } from "$lib/state/settings.svelte";

describe("Details Length column (#995)", () => {
  it("is a resizable Details column labelled Length", () => {
    expect(COLUMN_KEYS).toContain("length");
    expect((DETAIL_COLUMNS as Record<string, { label: string }>).length?.label).toBe("Length");
  });

  it("contributes its own width to the grid only while visible", () => {
    const widths = { ...normalizeColumnWidths(), length: 123 } as ReturnType<typeof normalizeColumnWidths>;
    const visible = { date: true, type: true, size: true, length: true } as ColumnVisibility;
    expect(columnGridTemplate(widths, visible).split(" ")).toContain("123px");
    expect(columnGridTemplate(widths, { ...visible, length: false } as ColumnVisibility).split(" ")).not.toContain("123px");
  });

  it("is visible by default, including for settings saved before the column existed", () => {
    const legacy = normalizeSettingsInput({ columnVisibility: { date: true, type: false, size: true } });
    expect(legacy.columnVisibility).toEqual({ prompt: true, date: true, type: false, size: true, length: true, resolution: true });
  });
});
