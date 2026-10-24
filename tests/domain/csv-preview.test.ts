import { describe, expect, it } from "vitest";
import { csvColumnTemplate, csvRowHeight, parseCsvPreview } from "$lib/domain/csv-preview";

describe("parseCsvPreview", () => {
  it("preserves quoted commas, escaped quotes, and embedded newlines in table cells", () => {
    expect(
      parseCsvPreview('name,note\nAda,"first, second"\nGrace,"said ""hello""\nand left"'),
    ).toEqual({
      header: ["name", "note"],
      rows: [
        ["Ada", "first, second"],
        ["Grace", 'said "hello"\nand left'],
      ],
      totalRows: 2,
    });
  });

  it("returns null for malformed CSV so callers can use plain-text fallback", () => {
    expect(parseCsvPreview('name,note\nAda,"unterminated')).toBeNull();
  });

  it("keeps the bounded preview row count while retaining the header", () => {
    expect(parseCsvPreview("id\n1\n2\n3", 2)).toEqual({
      header: ["id"],
      rows: [["1"], ["2"]],
      totalRows: 3,
    });
  });

  it("does not create a blank record for a trailing line ending", () => {
    expect(parseCsvPreview("id\n1\n")).toEqual({
      header: ["id"],
      rows: [["1"]],
      totalRows: 1,
    });
  });
});

describe("csvRowHeight", () => {
  it("keeps single-line and empty rows at the 28px floor", () => {
    expect(csvRowHeight(["a", "b"])).toBe(28);
    expect(csvRowHeight([])).toBe(28);
  });

  it("grows by 16px per line of the tallest quoted multi-line cell", () => {
    expect(csvRowHeight(["one", "two\nlines\nhere"])).toBe(12 + 3 * 16);
  });
});

describe("csvColumnTemplate", () => {
  it("sizes each track by its longest header or cell, with a 128px minimum", () => {
    const csv = { header: ["id", "note"], rows: [["1", "x".repeat(30)], ["2"]], totalRows: 2 };
    expect(csvColumnTemplate(csv)).toBe(`128px ${30 * 8 + 20}px`);
  });

  it("measures a long header when the cells are shorter or missing", () => {
    const header = "h".repeat(20);
    expect(csvColumnTemplate({ header: [header], rows: [], totalRows: 0 })).toBe(`${20 * 8 + 20}px`);
  });
});
