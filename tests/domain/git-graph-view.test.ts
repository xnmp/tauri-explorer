/**
 * Git-graph table geometry (#256 windowing, #221 inline expansion, #341
 * column widths) and the synthetic uncommitted row (#466).
 */
import { describe, expect, it } from "vitest";
import type { BranchLine } from "$lib/domain/git-graph";
import {
  clampMenuPosition,
  formatGraphDate,
  inlineRowExpand,
  minimumGraphTableWidth,
  renderWindow,
  rowAtY,
  rowY,
  splitUncommittedLine,
  windowGraphGeometry,
  windowTraceSegments,
  withUncommittedRow,
} from "$lib/domain/git-graph-view";

const H = 28;

describe("row offsets with an inline expansion", () => {
  const expand = { afterRow: 2, extra: 100 };

  it("maps offsets to rows at a fixed pitch without an expansion", () => {
    expect(rowAtY(0, H)).toBe(0);
    expect(rowAtY(27.9, H)).toBe(0);
    expect(rowAtY(28, H)).toBe(1);
    expect(rowY(5, H)).toBe(140);
  });

  it("pushes only rows after the expanded one down", () => {
    expect(rowY(2, H, expand)).toBe(56);
    expect(rowY(3, H, expand)).toBe(84 + 100);
  });

  it("treats the expansion's own pixels as belonging to the row below it", () => {
    // The block starts at row 3's unshifted top (84) and spans 100px.
    expect(rowAtY(83, H, expand)).toBe(2);
    expect(rowAtY(84, H, expand)).toBe(3);
    expect(rowAtY(150, H, expand)).toBe(3);
    expect(rowAtY(84 + 100 + 28, H, expand)).toBe(4);
  });

  it("round-trips every row's offset back to its index", () => {
    for (let i = 0; i < 10; i++) expect(rowAtY(rowY(i, H, expand), H, expand)).toBe(i);
  });
});

describe("renderWindow", () => {
  it("adds overscan and clamps to the row range", () => {
    expect(renderWindow({ scrollTop: 0, viewportHeight: 280, rowCount: 1000, rowHeight: H, overscan: 12 }))
      .toEqual({ startRow: 0, endRow: 22 });
    expect(renderWindow({ scrollTop: 2800, viewportHeight: 280, rowCount: 1000, rowHeight: H, overscan: 12 }))
      .toEqual({ startRow: 88, endRow: 122 });
    expect(renderWindow({ scrollTop: 0, viewportHeight: 280, rowCount: 5, rowHeight: H, overscan: 12 }))
      .toEqual({ startRow: 0, endRow: 4 });
  });

  it("is empty (end before start) for an empty history", () => {
    const { startRow, endRow } = renderWindow({ scrollTop: 0, viewportHeight: 280, rowCount: 0, rowHeight: H, overscan: 12 });
    expect(endRow).toBeLessThan(startRow);
  });
});

describe("inlineRowExpand", () => {
  it("adds the block's bottom gap once it has been measured", () => {
    expect(inlineRowExpand(4, 200)).toEqual({ afterRow: 4, extra: 206 });
  });

  it("does not stretch for an unmeasured block or a row outside the history", () => {
    expect(inlineRowExpand(4, 0)).toBeUndefined();
    expect(inlineRowExpand(-1, 200)).toBeUndefined();
  });
});

describe("splitUncommittedLine", () => {
  const line: BranchLine = {
    colorIndex: 3,
    points: [{ lane: 0, row: 0 }, { lane: 0, row: 1 }, { lane: 0, row: 4 }],
  };

  it("splits at HEAD's row, sharing that point between both halves", () => {
    const { dirty, rest } = splitUncommittedLine(line, 1);
    expect(dirty.points).toEqual([{ lane: 0, row: 0 }, { lane: 0, row: 1 }]);
    expect(rest.points).toEqual([{ lane: 0, row: 1 }, { lane: 0, row: 4 }]);
    expect(rest.colorIndex).toBe(3);
  });

  it("falls back to the first segment when HEAD is not on the line", () => {
    const { dirty, rest } = splitUncommittedLine(line, 99);
    expect(dirty.points).toHaveLength(2);
    expect(rest.points[0]).toEqual({ lane: 0, row: 1 });
  });
});

describe("minimumGraphTableWidth", () => {
  const base = { graph: 56, author: null, date: null, commit: false, parent: false };

  it("keeps a usable message region beside the graph", () => {
    expect(minimumGraphTableWidth(base)).toBe(56 + 20 + 14 + 160);
  });

  it("adds each visible metadata column with its gap", () => {
    expect(minimumGraphTableWidth({ ...base, author: 120, date: 84, commit: true, parent: true }))
      .toBe(250 + 128 + 92 + 76 + 136);
  });
});

describe("clampMenuPosition", () => {
  const viewport = { width: 1000, height: 800 };

  it("leaves a menu that fits untouched", () => {
    expect(clampMenuPosition({ x: 10, y: 10 }, { width: 200, height: 100 }, viewport)).toEqual({ x: 10, y: 10 });
  });

  it("pulls an overflowing menu back inside the padded viewport", () => {
    expect(clampMenuPosition({ x: 900, y: 750 }, { width: 200, height: 100 }, viewport))
      .toEqual({ x: 792, y: 692 });
  });

  it("pins a menu larger than the viewport to the padding", () => {
    expect(clampMenuPosition({ x: 500, y: 500 }, { width: 2000, height: 2000 }, viewport)).toEqual({ x: 8, y: 8 });
  });
});

describe("windowGraphGeometry", () => {
  const long: BranchLine = { colorIndex: 0, points: [{ lane: 0, row: 0 }, { lane: 0, row: 50 }, { lane: 1, row: 100 }] };
  const far: BranchLine = { colorIndex: 1, points: [{ lane: 2, row: 200 }, { lane: 2, row: 210 }] };
  const vertices = Array.from({ length: 300 }, (_, i) => ({ lane: 0, colorIndex: i }));

  it("drops lines outside the window and keeps vertex row indices", () => {
    const view = windowGraphGeometry({
      branches: [long, far], vertices, uncommittedBranch: undefined, startRow: 40, endRow: 60,
    });
    expect(view.branches).toHaveLength(1);
    expect(view.vertices[0]).toEqual({ vertex: vertices[40], vi: 40 });
    expect(view.vertices).toHaveLength(21);
  });

  it("keeps the uncommitted line whole by identity", () => {
    const view = windowGraphGeometry({
      branches: [far], vertices, uncommittedBranch: far, startRow: 0, endRow: 10,
    });
    expect(view.branches).toEqual([far]);
  });
});

describe("windowTraceSegments", () => {
  const near: BranchLine = { colorIndex: 0, points: [{ lane: 0, row: 5 }, { lane: 0, row: 8 }] };
  const far: BranchLine = { colorIndex: 1, points: [{ lane: 2, row: 200 }, { lane: 2, row: 210 }] };

  it("is empty without a trace", () => {
    expect(windowTraceSegments(null, 0, 10)).toEqual([]);
  });

  it("drops traced segments outside the window, unlike the whole uncommitted line", () => {
    const traced = windowTraceSegments([near, far], 0, 10);
    expect(traced).toHaveLength(1);
    expect(traced[0].points.every((point) => point.row <= 12)).toBe(true);
  });
});

describe("withUncommittedRow", () => {
  const commits = [{ oid: "abc" }];
  const input = { oid: "*", workingChanges: 3, headOid: "abc", filePath: "", nowMs: 1_700_000_000_500 };

  it("prepends a synthetic row parented on HEAD for a dirty tree", () => {
    const rows = withUncommittedRow(commits, input);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ oid: "*", short_oid: "*", parents: ["abc"], summary: "Uncommitted Changes (3)", author_time: 1_700_000_000 });
    expect(rows[1]).toBe(commits[0]);
  });

  it("omits it for a clean tree, unloaded HEAD or an active path filter", () => {
    expect(withUncommittedRow(commits, { ...input, workingChanges: 0 })).toBe(commits);
    expect(withUncommittedRow(commits, { ...input, headOid: null })).toBe(commits);
    expect(withUncommittedRow(commits, { ...input, filePath: "src/a.ts" })).toBe(commits);
    expect(withUncommittedRow(commits, { ...input, filePath: "   " })).toHaveLength(2);
  });
});

describe("formatGraphDate", () => {
  it("formats a commit from another day as a date, not an age", () => {
    const text = formatGraphDate(0, Date.UTC(2026, 0, 1));
    expect(text).toMatch(/19(69|70)/);
  });
});
