import { describe, expect, it } from "vitest";
import { nearestInDirection, panelRevealTop, panelStep, resolveTileMove, type TileNavigationState } from "$lib/domain/tile-panel-navigation";
import type { FileListKey } from "$lib/domain/file-list-navigation";
import type { PanelBox } from "$lib/domain/tile-panels";
import { MEDIUM, P, modelFor } from "./tile-panels-fixture";

const key = (k: string, mods: Partial<FileListKey> = {}): FileListKey => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

function nav(open: string[], scroll: Record<string, number> = {}, options: Parameters<typeof modelFor>[1] = {}) {
  const { model, tree } = modelFor(open, options);
  const state: TileNavigationState = { model, geometry: model.geometry, panelScrollTop: path => scroll[path] ?? 0 };
  const index = (path: string) => tree.entries.findIndex(e => e.path === path);
  const name = (i: number | undefined) => i === undefined ? undefined : tree.entries[i]?.path.slice(3);
  /** The focused entry's name, or null when the key resolves to nothing. */
  const move = (from: string, k: string, mods: Partial<FileListKey> = {}): string | null | undefined => {
    const result = resolveTileMove(state, key(k, mods), index(P(from)));
    if (result && result.kind !== "focus") throw new Error(`unexpected move ${result.kind}`);
    return result ? name(result.index) : null;
  };
  return { model, tree, state, index, name, move };
}

describe("spatial arrows with panels open (§6)", () => {
  it("enters the panel under its parent and leaves it again", () => {
    const { move } = nav(["Career"]);
    // Career's panel: 5 columns, Applications..References over Resume..salary.
    // The panel tile under the parent's centre.
    expect(move("Career", "ArrowDown")).toBe("Career/Portfolio");
    expect(move("Career/Portfolio", "ArrowUp")).toBe("Career");
    // Leaving the bottom row reaches the next grid row, under the item.
    const below = move("Career/offer-letter.pdf", "ArrowDown");
    expect(below?.includes("/")).toBe(false);
    expect(below).not.toBe("Career");
  });

  it("walks the panel's grid, wrapping Left/Right in reading order", () => {
    const { move, model } = nav(["Career"]);
    expect(model.panels.get(P("Career"))!.cols).toBe(5);
    expect(move("Career/Applications", "ArrowRight")).toBe("Career/Cover Letters");
    // Nothing beside the panel: the row end wraps in reading order, within the panel.
    expect(move("Career/References.docx", "ArrowRight")).toBe("Career/Resume-2026.pdf");
    expect(move("Career/Resume-2026.pdf", "ArrowLeft")).toBe("Career/References.docx");
    expect(move("Career/Applications", "ArrowDown")).toBe("Career/Resume-2026.pdf");
    // Down onto a shorter last row lands on its last item.
    expect(move("Career/References.docx", "ArrowDown")).toBe("Career/salary-research.xlsx");
    // The panel's first and last items do not wrap out of it.
    expect(move("Career/Applications", "ArrowLeft")).toBeNull();
    expect(move("Career/salary-research.xlsx", "ArrowRight")).toBeNull();
  });

  it("leaves a panel sideways for the nearest item in that direction", () => {
    const { move } = nav(["Career", "Personal"]);
    // Career's 3-column grid ends beside Personal's panel in the same band.
    expect(move("Career/Portfolio", "ArrowRight")).toBe("Personal/Health");
    expect(move("Personal/Health", "ArrowLeft")).toBe("Career/Portfolio");
  });

  it("moves between grid tiles spatially and wraps at row ends like the classic grid", () => {
    const { move, model, name } = nav(["Career"]);
    expect(move("Career", "ArrowRight")).toBe("Codex");
    expect(move("Codex", "ArrowLeft")).toBe("Career");
    // Row 1's first tile: nothing to its left, so Left wraps to row 0's last tile.
    const rowOneFirst = name(model.items[7].entryIndex!);
    const rowZeroLast = name(model.items[6].entryIndex!);
    expect(move(rowOneFirst!, "ArrowLeft")).toBe(rowZeroLast);
    expect(move(rowZeroLast!, "ArrowRight")).toBe(rowOneFirst);
    // A tile beside the panel's parent skips the band if the panel is not under it.
    const lastInRow = name(model.items[6].entryIndex!)!;
    expect(move(lastInRow, "ArrowDown")).toBe(name(model.items[13].entryIndex!));
  });

  it("enters an above panel from its row and reaches the band's visible bottom row", () => {
    const { move } = nav(["Career", "Personal", "Inbox"]);
    expect(move("Inbox", "ArrowUp")).toMatch(/^Inbox\//);
    // Inbox's 3x2 grid: the bottom row's middle item sits over Inbox itself.
    expect(move("Inbox/invoice-oct.pdf", "ArrowDown")).toBe("Inbox/scan-0193.pdf");
    expect(move("Inbox/scan-0193.pdf", "ArrowDown")).toBe("Inbox");
  });

  it("enters a scrolled panel at its first visible row", () => {
    const { move, model } = nav(["Archive"], { [P("Archive")]: 2 * MEDIUM.rowHeight });
    expect(model.panels.get(P("Archive"))!.cols).toBe(6);
    const target = move("Archive", "ArrowDown")!;
    const offset = model.panels.get(P("Archive"))!.entries.findIndex(e => e === nav(["Archive"]).index(P(target)));
    expect(Math.floor(offset / 6)).toBe(2);
  });

  it("reaches a stacked panel past the below band", () => {
    const { move } = nav(["Career", "Personal", "Inbox", "AI Draft Archive", "Codex"]);
    expect(move("Codex", "ArrowDown")).toMatch(/^Career\//);
    // From the bottom of the below band, Down continues into the stacked panel.
    expect(move("Career/salary-research.xlsx", "ArrowDown")).toMatch(/^Codex\//);
  });

  it("maps selection modifiers like the classic resolver", () => {
    const { state, index } = nav(["Career"]);
    const from = index(P("Career"));
    expect(resolveTileMove(state, key("ArrowDown", { shiftKey: true }), from)).toMatchObject({ selection: "extend" });
    expect(resolveTileMove(state, key("ArrowDown", { ctrlKey: true }), from)).toMatchObject({ selection: "preserve" });
    expect(resolveTileMove(state, key("ArrowDown"), from)).toMatchObject({ selection: "replace" });
    expect(resolveTileMove(state, key("ArrowDown", { altKey: true }), from)).toBeNull();
    expect(resolveTileMove(state, key("Home"), from)).toBeNull();
    expect(resolveTileMove(state, key("a"), from)).toBeNull();
  });

  it("jumps to the first/last top-level entry and pages within a level", () => {
    const { move, model, name } = nav(["Career"]);
    const top = model.items.map(item => name(item.entryIndex!));
    expect(move("Career/Portfolio", "End", { ctrlKey: true })).toBe(top.at(-1));
    expect(move("Codex", "Home", { ctrlKey: true })).toBe(top[0]);
    expect(move("Career/Applications", "PageDown")).toBe("Career/salary-research.xlsx");
    expect(move("Career/Portfolio", "PageUp")).toBe("Career/Applications");
    expect(move("Career/Portfolio", "PageDown", { shiftKey: true })).toBe("Career/salary-research.xlsx");
    expect(move("Career", "PageDown")).toBe(top[10]);
  });

  it("starts at the first top-level entry without a cursor, and ignores a stale cursor", () => {
    const { state, name, model } = nav(["Career"]);
    const first = resolveTileMove(state, key("ArrowRight"), -1);
    expect(first?.kind === "focus" && name(first.index)).toBe(name(model.items[0].entryIndex!));
    expect(resolveTileMove(state, key("ArrowRight"), 10_000)).toMatchObject({ kind: "focus", index: model.items[0].entryIndex });
  });

  it("stays put where nothing lies in the arrow's direction", () => {
    const { move, model, name } = nav(["Career"]);
    expect(move(name(model.items[0].entryIndex!)!, "ArrowUp")).toBeNull();
    expect(move(name(model.items[0].entryIndex!)!, "ArrowLeft")).toBeNull();
  });
});

describe("navigation helpers", () => {
  it("nearestInDirection prefers overlap, then distance along the arrow", () => {
    const from = { x0: 0, x1: 100, y0: 0, y1: 100 };
    const pool = [
      { entry: 1, rect: { x0: 150, x1: 250, y0: 110, y1: 210 } },
      { entry: 2, rect: { x0: 50, x1: 150, y0: 300, y1: 400 } },
      { entry: 3, rect: { x0: -40, x1: 60, y0: 300, y1: 400 } },
    ];
    // 1 is nearer but does not overlap the cursor's columns.
    expect(nearestInDirection(from, pool, "ArrowDown")).toBe(3);
    expect(nearestInDirection(from, pool.slice(0, 1), "ArrowDown")).toBe(1);
    expect(nearestInDirection(from, pool, "ArrowUp")).toBeNull();
  });

  it("panelStep stops at the edges of the grid and of each row", () => {
    const spec = { entries: [0, 1, 2, 3, 4, 5, 6], cols: 3 } as never;
    expect(panelStep(spec, 0, "ArrowLeft")).toBeNull();
    expect(panelStep(spec, 3, "ArrowLeft")).toBeNull();
    expect(panelStep(spec, 2, "ArrowRight")).toBeNull();
    expect(panelStep(spec, 6, "ArrowRight")).toBeNull();
    expect(panelStep(spec, 4, "ArrowRight")).toBe(5);
    expect(panelStep(spec, 1, "ArrowUp")).toBeNull();
    expect(panelStep(spec, 6, "ArrowDown")).toBeNull();
    expect(panelStep(spec, 5, "ArrowDown")).toBe(6);
  });

  it("panelRevealTop scrolls minimally to show a row", () => {
    const box = { side: "below", height: 212 } as PanelBox;
    expect(panelRevealTop(box, 96, 0, 0, 404)).toBe(0);
    expect(panelRevealTop(box, 96, 3, 0, 404)).toBe(192);
    expect(panelRevealTop(box, 96, 0, 150, 404)).toBe(0);
    expect(panelRevealTop(box, 96, 1, 50, 404)).toBe(50);
    expect(panelRevealTop(box, 96, 9, 0, 404)).toBe(192);
    expect(panelRevealTop(box, 96, 1, Number.NaN, 404)).toBe(0);
  });
});
