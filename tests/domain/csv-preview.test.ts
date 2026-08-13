import { describe, expect, it } from "vitest";
import { parseCsvPreview } from "$lib/domain/csv-preview";

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
