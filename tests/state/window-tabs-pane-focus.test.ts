/**
 * Directional pane focus on the live window-tabs manager (#501).
 *
 * Asserts on `activePaneId` — the value ExplorerPane derives `isActive` (and
 * so the active-pane border and arrow-key ownership) from.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";

const managers: Array<ReturnType<typeof createWindowTabsManager>> = [];

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

function freshManager() {
  const manager = createWindowTabsManager();
  manager.init("/home/user", true);
  managers.push(manager);
  return manager;
}

describe("focusPaneInDirection (#501)", () => {
  it("focusPaneInDirection moves focus across a horizontal split (#501)", () => {
    const manager = freshManager();
    const original = manager.activePaneId;
    manager.splitPane("right");
    const created = manager.activePaneId;
    expect(created).not.toBe(original);

    manager.focusPaneInDirection("left");
    expect(manager.activePaneId).toBe(original);

    manager.focusPaneInDirection("right");
    expect(manager.activePaneId).toBe(created);
  });

  it("focusPaneInDirection moves focus across a vertical split (#501)", () => {
    const manager = freshManager();
    const original = manager.activePaneId;
    manager.splitPane("down");
    const created = manager.activePaneId;

    manager.focusPaneInDirection("up");
    expect(manager.activePaneId).toBe(original);

    manager.focusPaneInDirection("down");
    expect(manager.activePaneId).toBe(created);
  });

  it("focusPaneInDirection is a no-op at the layout edge — it never splits (#501)", () => {
    const manager = freshManager();
    manager.splitPane("right");
    const focused = manager.activePaneId;
    const paneCount = manager.activePaneIds.length;

    // The focused pane is the rightmost one; nothing lies right of or above it.
    manager.focusPaneInDirection("right");
    manager.focusPaneInDirection("up");
    manager.focusPaneInDirection("down");

    expect(manager.activePaneId).toBe(focused);
    expect(manager.activePaneIds).toHaveLength(paneCount);
  });

  it("focusPaneInDirection is a no-op on a single-pane tab (#501)", () => {
    const manager = freshManager();
    const only = manager.activePaneId;

    for (const dir of ["left", "right", "up", "down"] as const) {
      manager.focusPaneInDirection(dir);
    }

    expect(manager.activePaneId).toBe(only);
    expect(manager.activePaneIds).toHaveLength(1);
  });

  it("focusPaneInDirection picks the geometric neighbour, not the next in cycle (#501)", () => {
    const manager = freshManager();
    const left = manager.activePaneId;
    manager.splitPane("right"); // left | right
    const rightTop = manager.activePaneId;
    manager.splitPane("down"); // left | (rightTop / rightBottom)
    const rightBottom = manager.activePaneId;

    // Cyclic order is [left, rightTop, rightBottom]; from the bottom-right pane
    // "left" must reach the tall left pane rather than wrapping to the next id.
    manager.focusPaneInDirection("left");
    expect(manager.activePaneId).toBe(left);

    // Both right-hand panes share equal edge with the tall left pane, so the
    // documented tie-break applies: visual order, i.e. the upper one.
    manager.focusPaneInDirection("right");
    expect(manager.activePaneId).toBe(rightTop);
    expect(manager.activePaneId).not.toBe(rightBottom);
  });
});
