import { describe, expect, it } from "vitest";
import type { FileEntry, ViewMode } from "$lib/domain/file";
import {
  resolveFileCursor,
  resolveFileListMove,
  type FileListKey,
} from "$lib/domain/file-list-navigation";

type Layout = Parameters<typeof resolveFileListMove>[1];

function entry(name: string): FileEntry {
  return {
    name,
    path: `/files/${name}`,
    kind: "file",
    size: 1,
    modified: "2026-09-08T00:00:00.000Z",
  };
}

function key(
  value: string,
  modifiers: Partial<Omit<FileListKey, "key">> = {},
): FileListKey {
  return {
    key: value,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  };
}

function layout(overrides: Partial<Layout> = {}): Layout {
  return {
    viewMode: "details",
    columns: 1,
    count: 12,
    cursorIndex: 4,
    directory: false,
    yazi: false,
    ...overrides,
  };
}

describe("resolveFileCursor", () => {
  it("keeps the cursor on the same path when displayed entries are reordered", () => {
    const alpha = entry("alpha.txt");
    const beta = entry("beta.txt");
    const gamma = entry("gamma.txt");
    const reordered = [gamma, alpha, beta];

    expect(resolveFileCursor(reordered, beta.path, new Set([alpha.path]))).toBe(beta);
  });

  it("falls back to the first displayed selected entry, then the first entry", () => {
    const alpha = entry("alpha.txt");
    const beta = entry("beta.txt");
    const gamma = entry("gamma.txt");
    const displayed = [gamma, alpha, beta];

    expect(
      resolveFileCursor(displayed, "/files/removed.txt", new Set([beta.path, gamma.path])),
    ).toBe(gamma);
    expect(resolveFileCursor(displayed, "/files/removed.txt", new Set())).toBe(gamma);
  });

  it("has no cursor for an empty listing", () => {
    expect(resolveFileCursor([], "/files/removed.txt", new Set())).toBeUndefined();
  });
});

describe("resolveFileListMove", () => {
  it("advances the Shift-selection endpoint on every repeated move", () => {
    const down = key("ArrowDown", { shiftKey: true });
    const first = resolveFileListMove(down, layout({ cursorIndex: 1 }));
    expect(first).toEqual({ kind: "focus", index: 2, selection: "extend" });

    const second = resolveFileListMove(
      down,
      layout({ cursorIndex: first?.kind === "focus" ? first.index : -1 }),
    );
    expect(second).toEqual({ kind: "focus", index: 3, selection: "extend" });

    const reverse = resolveFileListMove(
      key("ArrowUp", { shiftKey: true }),
      layout({ cursorIndex: second?.kind === "focus" ? second.index : -1 }),
    );
    expect(reverse).toEqual({ kind: "focus", index: 2, selection: "extend" });
  });

  it.each([
    ["Control", { ctrlKey: true }],
    ["Command", { metaKey: true }],
  ] as const)("moves focus without replacing selection for %s+Arrow", (_label, modifier) => {
    expect(resolveFileListMove(
      key("ArrowDown", modifier),
      layout({ cursorIndex: 4 }),
    )).toEqual({ kind: "focus", index: 5, selection: "preserve" });
  });

  it("keeps Home, End, and eight-entry page movement behavior", () => {
    expect(resolveFileListMove(
      key("Home", { ctrlKey: true }),
      layout({ count: 20, cursorIndex: 10 }),
    )).toEqual({ kind: "focus", index: 0, selection: "replace" });
    expect(resolveFileListMove(
      key("End", { metaKey: true }),
      layout({ count: 20, cursorIndex: 10 }),
    )).toEqual({ kind: "focus", index: 19, selection: "replace" });
    expect(resolveFileListMove(
      key("Home", { ctrlKey: true, shiftKey: true }),
      layout({ count: 20, cursorIndex: 10 }),
    )).toEqual({ kind: "focus", index: 0, selection: "extend" });
    expect(resolveFileListMove(
      key("End", { metaKey: true, shiftKey: true }),
      layout({ count: 20, cursorIndex: 10 }),
    )).toEqual({ kind: "focus", index: 19, selection: "extend" });
    expect(resolveFileListMove(
      key("PageDown"),
      layout({ count: 20, cursorIndex: 5 }),
    )).toEqual({ kind: "focus", index: 13, selection: "replace" });
    expect(resolveFileListMove(
      key("PageUp", { shiftKey: true }),
      layout({ count: 20, cursorIndex: 12 }),
    )).toEqual({ kind: "focus", index: 4, selection: "extend" });
    expect(resolveFileListMove(
      key("PageDown"),
      layout({ count: 20, cursorIndex: 15 }),
    )).toEqual({ kind: "focus", index: 19, selection: "replace" });
    expect(resolveFileListMove(
      key("PageUp"),
      layout({ count: 20, cursorIndex: 4 }),
    )).toEqual({ kind: "focus", index: 0, selection: "replace" });
  });

  it.each(["list", "tiles"] satisfies ViewMode[])(
    "uses row and column geometry in %s view without crossing listing edges",
    (viewMode) => {
      const grid = (cursorIndex: number) => layout({
        viewMode,
        columns: 3,
        count: 10,
        cursorIndex,
      });

      expect(resolveFileListMove(key("ArrowLeft"), grid(4))).toEqual({
        kind: "focus", index: 3, selection: "replace",
      });
      expect(resolveFileListMove(key("ArrowRight"), grid(4))).toEqual({
        kind: "focus", index: 5, selection: "replace",
      });
      expect(resolveFileListMove(key("ArrowUp"), grid(4))).toEqual({
        kind: "focus", index: 1, selection: "replace",
      });
      expect(resolveFileListMove(key("ArrowDown"), grid(4))).toEqual({
        kind: "focus", index: 7, selection: "replace",
      });
      expect(resolveFileListMove(key("ArrowUp"), grid(1))).toBeNull();
      expect(resolveFileListMove(key("ArrowDown"), grid(7))).toBeNull();
    },
  );

  it("uses linear vertical movement and leaves horizontal keys alone in Details view", () => {
    expect(resolveFileListMove(key("ArrowUp"), layout({ cursorIndex: 4 }))).toEqual({
      kind: "focus", index: 3, selection: "replace",
    });
    expect(resolveFileListMove(key("ArrowDown"), layout({ cursorIndex: 4 }))).toEqual({
      kind: "focus", index: 5, selection: "replace",
    });
    expect(resolveFileListMove(key("ArrowLeft"), layout({ cursorIndex: 4 }))).toBeNull();
    expect(resolveFileListMove(key("ArrowRight"), layout({ cursorIndex: 4 }))).toBeNull();
  });

  it("applies Yazi parent/open behavior only to unmodified keys in eligible layouts", () => {
    const yaziList = layout({
      viewMode: "list",
      columns: 1,
      count: 6,
      cursorIndex: 3,
      directory: true,
      yazi: true,
    });

    expect(resolveFileListMove(key("ArrowLeft"), yaziList)).toEqual({ kind: "parent" });
    expect(resolveFileListMove(key("ArrowRight"), yaziList)).toEqual({
      kind: "open", index: 3,
    });
    const yaziDetails = { ...yaziList, viewMode: "details" as const };
    expect(resolveFileListMove(key("ArrowLeft"), yaziDetails)).toEqual({ kind: "parent" });
    expect(resolveFileListMove(key("ArrowRight"), yaziDetails)).toEqual({
      kind: "open", index: 3,
    });
    expect(resolveFileListMove(key("ArrowLeft", { ctrlKey: true }), yaziList)).toEqual({
      kind: "focus", index: 2, selection: "preserve",
    });
    expect(resolveFileListMove(key("ArrowRight", { metaKey: true }), yaziList)).toEqual({
      kind: "focus", index: 4, selection: "preserve",
    });
    expect(resolveFileListMove(key("ArrowLeft", { shiftKey: true }), yaziList)).toEqual({
      kind: "focus", index: 2, selection: "extend",
    });

    expect(resolveFileListMove(
      key("ArrowLeft"),
      { ...yaziList, viewMode: "tiles" },
    )).toEqual({ kind: "focus", index: 2, selection: "replace" });
    expect(resolveFileListMove(
      key("ArrowLeft"),
      { ...yaziList, columns: 2 },
    )).toEqual({ kind: "focus", index: 2, selection: "replace" });
  });

  it("allows Yazi parent navigation from an empty eligible listing", () => {
    expect(resolveFileListMove(
      key("ArrowLeft"),
      layout({ count: 0, cursorIndex: -1, yazi: true }),
    )).toEqual({ kind: "parent" });
    expect(resolveFileListMove(
      key("ArrowLeft"),
      layout({ viewMode: "list", columns: 1, count: 0, cursorIndex: -1, yazi: true }),
    )).toEqual({ kind: "parent" });
  });

  it("ignores Alt chords regardless of the other modifiers", () => {
    expect(resolveFileListMove(
      key("ArrowDown", { altKey: true }),
      layout(),
    )).toBeNull();
    expect(resolveFileListMove(
      key("Home", { altKey: true, ctrlKey: true }),
      layout(),
    )).toBeNull();
  });

  it.each([0, -4, Number.NaN, Number.POSITIVE_INFINITY])(
    "bounds invalid column count %s to one column",
    (columns) => {
      expect(resolveFileListMove(
        key("ArrowDown"),
        layout({ viewMode: "list", columns, count: 6, cursorIndex: 2 }),
      )).toEqual({ kind: "focus", index: 3, selection: "replace" });
    },
  );

  it("floors fractional columns and rejects moves beyond the final entry", () => {
    expect(resolveFileListMove(
      key("ArrowDown"),
      layout({ viewMode: "tiles", columns: 2.9, count: 8, cursorIndex: 2 }),
    )).toEqual({ kind: "focus", index: 4, selection: "replace" });
    expect(resolveFileListMove(
      key("ArrowDown"),
      layout({ viewMode: "tiles", columns: Number.MAX_VALUE, count: 8, cursorIndex: 2 }),
    )).toBeNull();
  });

  it.each([
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [5.5, 0],
    [5, Number.NaN],
    [5, Number.POSITIVE_INFINITY],
    [5, 2.5],
  ])("fails closed for malformed count %s or cursor %s", (count, cursorIndex) => {
    expect(resolveFileListMove(
      key("ArrowDown"),
      layout({ count, cursorIndex }),
    )).toBeNull();
  });
});
