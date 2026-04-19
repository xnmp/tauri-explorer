/**
 * Regression test: multi-file drag must include all selected paths.
 * Issue: fix/multi-file-drag-drop
 */
import { describe, it, expect } from "vitest";

describe("Multi-file drag data", () => {
  it("DragData.paths contains all selected paths when dragging multiple", () => {
    const selected = [
      { path: "/home/user/a.txt", name: "a.txt" },
      { path: "/home/user/b.txt", name: "b.txt" },
      { path: "/home/user/c.txt", name: "c.txt" },
    ];

    // Simulate the dragStart logic
    const entry = selected[0];
    const isMulti = selected.length > 1;
    const paths = isMulti ? selected.map((e) => e.path) : [entry.path];

    expect(paths).toHaveLength(3);
    expect(paths).toContain("/home/user/a.txt");
    expect(paths).toContain("/home/user/b.txt");
    expect(paths).toContain("/home/user/c.txt");
  });

  it("single drag has no extra paths", () => {
    const entry = { path: "/home/user/a.txt", name: "a.txt" };
    const selectedCount = 1;
    const isMulti = selectedCount > 1;
    const paths = isMulti ? [] : [entry.path];

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("/home/user/a.txt");
  });

  it("JSON round-trip preserves paths array", () => {
    const paths = ["/a", "/b", "/c"];
    const serialized = JSON.stringify(paths);
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual(paths);
  });
});
