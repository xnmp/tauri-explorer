/**
 * Split tab titles (#1935): a multi-pane tab exposes each pane's name, which
 * pane holds focus, and the layout geometry its icon draws.
 */
import { describe, it, expect } from "vitest";
import { splitTabDisplay } from "$lib/domain/tab-title";
import { leaf, splitLeaf, type PaneNode } from "$lib/domain/pane-layout";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";

const names: Record<string, string> = { a: "Pictures", b: "Documents", c: "Music" };
const nameOf = (id: string) => names[id] ?? id;

function twoUp(): PaneNode {
  return splitLeaf(leaf("a"), "a", "right", "b", "s1");
}

describe("splitTabDisplay", () => {
  it("lists panes in reading order with the focused one marked", () => {
    const d = splitTabDisplay(twoUp(), "b", nameOf);
    expect(d.panes.map((p) => [p.name, p.focused])).toEqual([["Pictures", false], ["Documents", true]]);
    expect(d.customName).toBeNull();
  });

  it("places side-by-side panes as left and right halves", () => {
    const [left, right] = splitTabDisplay(twoUp(), "a", nameOf).panes;
    expect(left.rect).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(right.rect).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it("places a nested stacked split under the right pane", () => {
    const layout = splitLeaf(twoUp(), "b", "down", "c", "s2");
    const panes = splitTabDisplay(layout, "c", nameOf).panes;
    expect(panes.map((p) => p.name)).toEqual(["Pictures", "Documents", "Music"]);
    expect(panes[2]).toMatchObject({ focused: true, rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } });
  });

  it("marks no pane focused when the active id is not in the layout", () => {
    expect(splitTabDisplay(twoUp(), "gone", nameOf).panes.some((p) => p.focused)).toBe(false);
  });

  it("keeps a custom name, treating an empty one as absent", () => {
    expect(splitTabDisplay(twoUp(), "a", nameOf, "Photos work").customName).toBe("Photos work");
    expect(splitTabDisplay(twoUp(), "a", nameOf, "").customName).toBeNull();
  });
});

describe("window tab display for split tabs", () => {
  function manager() {
    const m = createWindowTabsManager();
    m.init("/home/user/Pictures", true);
    return m;
  }

  it("follows pane focus and leaves single-pane tabs without split info", () => {
    const m = manager();
    const tab = () => m.tabs.find((t) => t.id === m.activeTabId)!;
    expect(m.getTabDisplay(tab()).split).toBeUndefined();

    m.splitPane("right", "/home/user/Documents");
    const [first, second] = m.activePaneIds;
    let d = m.getTabDisplay(tab());
    expect(d.split?.panes.map((p) => [p.name, p.focused])).toEqual([["Pictures", false], ["Documents", true]]);
    expect(m.getTabTitle(tab())).toBe("Pictures | Documents");

    m.setActivePane(first);
    d = m.getTabDisplay(tab());
    expect(d.split?.panes.find((p) => p.id === first)?.focused).toBe(true);
    expect(d.split?.panes.find((p) => p.id === second)?.focused).toBe(false);
  });
});
