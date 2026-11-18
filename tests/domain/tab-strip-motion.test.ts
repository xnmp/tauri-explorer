import { describe, expect, it } from "vitest";
import { stripStep, stripTabsOf, stripTabWidth } from "$lib/domain/tab-strip-motion";
import { TAB_SLIDE_IN_MS, TAB_SLIDE_OUT_MS } from "$lib/domain/tab-slide";

const tabs = (...ids: string[]) => ids.map((id) => ({ id }));

describe("stripTabsOf", () => {
  it("records the count, the active tab and every id", () => {
    const strip = stripTabsOf(tabs("a", "b", "c"), "b");
    expect(strip.count).toBe(3);
    expect(strip.activeId).toBe("b");
    expect([...strip.ids]).toEqual(["a", "b", "c"]);
  });

  it("an empty window has no tabs and may have no active tab", () => {
    expect(stripTabsOf([], null)).toEqual({ count: 0, activeId: null, ids: new Set() });
  });
});

describe("stripStep", () => {
  it("an opening tab slides, and the others ease over an opening slide", () => {
    expect(stripStep(2, stripTabsOf(tabs("a", "b", "c"), "c"))).toEqual({ widthEaseMs: TAB_SLIDE_IN_MS, slides: true });
  });

  it("a closing tab slides, and the others ease over a closing slide", () => {
    expect(stripStep(3, stripTabsOf(tabs("a", "b"), "a"))).toEqual({ widthEaseMs: TAB_SLIDE_OUT_MS, slides: true });
  });

  it("switching tabs keeps the count: no slide, the widths swap with the opening ease", () => {
    expect(stripStep(3, stripTabsOf(tabs("a", "b", "c"), "a"))).toEqual({ widthEaseMs: TAB_SLIDE_IN_MS, slides: false });
  });

  it("closing the last tab is a closing slide", () => {
    expect(stripStep(1, stripTabsOf([], null))).toEqual({ widthEaseMs: TAB_SLIDE_OUT_MS, slides: true });
  });
});

describe("stripTabWidth", () => {
  const laidOut = { activeWidth: 200, inactiveWidth: 150 };
  const entering = { activeWidth: 180, inactiveWidth: 100 };

  it("a tab the strip lays out takes the laid-out width for its role there", () => {
    const strip = stripTabsOf(tabs("a", "b"), "a");
    expect(stripTabWidth("a", strip, laidOut, "a", entering)).toBe(200);
    expect(stripTabWidth("b", strip, laidOut, "a", entering)).toBe(150);
  });

  it("while the strip still lays out the old tabs, a tab keeps its old role (the switch lands with the new count)", () => {
    // "c" opened active; the strip still lays out a and b with a active.
    const strip = stripTabsOf(tabs("a", "b"), "a");
    expect(stripTabWidth("a", strip, laidOut, "c", entering)).toBe(200);
  });

  it("a tab sliding in grows to the width it has under the new count", () => {
    const strip = stripTabsOf(tabs("a", "b"), "a");
    expect(stripTabWidth("c", strip, laidOut, "c", entering)).toBe(180);
    expect(stripTabWidth("d", strip, laidOut, "c", entering)).toBe(100);
  });
});
