import { describe, expect, it } from "vitest";
import {
  cornerOwnership, islandAt, stripShownView, tabFootFor, tabFootHole, tabHome, tabPresence,
} from "$lib/domain/tab-seam";

describe("tabPresence", () => {
  it("is zero up to 2px, rises over the next 16px, and is whole from 18px", () => {
    expect(tabPresence(0)).toBe(0);
    expect(tabPresence(2)).toBe(0);
    expect(tabPresence(10)).toBe(0.5);
    expect(tabPresence(18)).toBe(1);
    expect(tabPresence(400)).toBe(1);
  });

  it("a malformed width shows nothing", () => {
    expect(tabPresence(Number.NaN)).toBe(0);
    expect(tabPresence(-5)).toBe(0);
  });
});

describe("stripShownView", () => {
  const view = { left: 100, right: 600 };

  it("an unfaded viewport shows tabs across its whole width", () => {
    expect(stripShownView(view, { start: false, end: false }, 39)).toEqual(view);
  });

  it("each faded end hides its transparent run", () => {
    expect(stripShownView(view, { start: true, end: false }, 39)).toEqual({ left: 139, right: 600 });
    expect(stripShownView(view, { start: false, end: true }, 39)).toEqual({ left: 100, right: 561 });
    expect(stripShownView(view, { start: true, end: true }, 39)).toEqual({ left: 139, right: 561 });
  });

  it("a negative or malformed run hides nothing", () => {
    expect(stripShownView(view, { start: true, end: true }, -10)).toEqual(view);
    expect(stripShownView(view, { start: true, end: true }, Number.NaN)).toEqual(view);
  });
});

const island = (left: number, right: number, structural: boolean, name: string) =>
  ({ left, right, radius: 10, structural, name });

describe("tabHome", () => {
  const sidebar = island(0, 200, true, "sidebar");
  const pane = island(204, 800, false, "pane");
  const preview = island(804, 1200, false, "preview");
  const islands = [sidebar, pane, preview];

  it("the tab wears the island under most of its foot, and opens only islands of that kind", () => {
    const stance = tabHome(islands, { left: 150, right: 300 });
    expect(stance.home?.name).toBe("pane");
    expect(stance.kind).toBe("content");
    expect(stance.islands.map((i) => [i.name, i.home])).toEqual([["sidebar", false], ["pane", true], ["preview", true]]);
  });

  it("a structural home opens only structural islands", () => {
    const stance = tabHome(islands, { left: 20, right: 180 });
    expect(stance.kind).toBe("structural");
    expect(stance.islands.filter((i) => i.home).map((i) => i.name)).toEqual(["sidebar"]);
  });

  it("with no island under it the tab has no home and opens none", () => {
    const stance = tabHome(islands, { left: 1300, right: 1400 });
    expect(stance).toMatchObject({ home: null, kind: "none" });
    expect(stance.islands.some((i) => i.home)).toBe(false);
  });

  it("a tab partly outside the view takes its home from the part over the view", () => {
    // Its hole reaches mostly over the sidebar, but the strip is scrolled so
    // only the part over the pane shows: the shown part decides.
    const hole = { left: 40, right: 260 };
    const view = { left: 190, right: 700 };
    const foot = tabFootHole(hole, view);
    expect(foot).toEqual({ left: 190, right: 260 });
    // The whole hole would have worn the hidden sidebar's surface.
    expect(tabHome(islands, hole).home?.name).toBe("sidebar");
    const stance = tabHome(islands, foot);
    expect(stance.home?.name).toBe("pane");
    // The foot it opens and squares islands with is the same clamped one.
    const opened = tabFootFor(foot, stance.islands);
    expect(opened.seams.map((seam) => seam.island.name)).toEqual(["pane"]);
    expect(opened.seams[0].row.left).toBeGreaterThanOrEqual(view.left);
  });
});

describe("tabFootHole", () => {
  it("clamps the hole to the viewport on each side", () => {
    expect(tabFootHole({ left: 10, right: 90 }, { left: 0, right: 100 })).toEqual({ left: 10, right: 90 });
    expect(tabFootHole({ left: -20, right: 90 }, { left: 0, right: 100 })).toEqual({ left: 0, right: 90 });
    expect(tabFootHole({ left: 10, right: 140 }, { left: 0, right: 100 })).toEqual({ left: 10, right: 100 });
  });
});

describe("cornerOwnership", () => {
  const square = { left: false, right: false };
  const pane = { left: 100, right: 500, radius: 10 };
  const other = { left: 504, right: 900, radius: 10 };

  it("an island's corner beyond the hole's edge is its own rounded corner", () => {
    const hole = { left: 200, right: 300 };
    expect(cornerOwnership("left", pane, islandAt([pane], hole.left), hole, square)).toBe("round");
    expect(cornerOwnership("right", pane, islandAt([pane], hole.right), hole, square)).toBe("round");
  });

  it("a corner squared beside the foot is turned by the stroke", () => {
    const hole = { left: 90, right: 300 };
    // The hole's left edge is outside the pane, so the pane is not the edge island there.
    expect(cornerOwnership("left", pane, islandAt([pane], hole.left), hole, { left: true, right: false })).toBeNull();
    const inner = { left: 105, right: 300 };
    expect(cornerOwnership("left", pane, islandAt([pane], inner.left), inner, { left: true, right: false })).toBe("square");
  });

  it("a corner under the tab gets no stroke", () => {
    const hole = { left: 100, right: 300 };
    expect(cornerOwnership("left", pane, pane, hole, square)).toBeNull();
    expect(cornerOwnership("right", pane, pane, { left: 200, right: 500 }, square)).toBeNull();
  });

  it("an island that is not the one at that edge owns no corner there", () => {
    const hole = { left: 450, right: 600 };
    expect(cornerOwnership("right", pane, islandAt([pane, other], hole.right), hole, square)).toBeNull();
    expect(cornerOwnership("left", other, islandAt([pane, other], hole.left), hole, square)).toBeNull();
    expect(cornerOwnership("left", pane, null, hole, square)).toBeNull();
  });
});
