import { expect, it } from "vitest";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";

const state = {
  version: 3,
  tabs: [{ id: "tab", kind: "explorer", activePaneId: "left", layout: {
    type: "split", id: "divider", direction: "row", ratio: 0.5,
    first: { type: "leaf", id: "left", path: "/home/user" },
    second: { type: "leaf", id: "right", path: "/home/user/Documents" },
  } }],
  activeTabId: "tab",
};

it("a queued divider move cannot resize a restored tab with reused IDs", async () => {
  const manager = createWindowTabsManager();
  try {
    manager.restoreFromState(state);
    const resize = manager.beginSplitResize("divider");
    manager.restoreFromState(state);
    const accepted = resize(0.8);
    expect(manager.captureState()).toEqual(state);
    expect(accepted).toBe(false);
  } finally { await manager.dispose(); }
});

it("a divider move cannot resize a different active tab", async () => {
  const manager = createWindowTabsManager();
  try {
    manager.restoreFromState(state);
    const resize = manager.beginSplitResize("divider");
    const other = manager.createTab("/home/user/Pictures");
    expect(manager.activeTabId).toBe(other.id);
    const before = manager.captureState();
    expect(resize(0.8)).toBe(false);
    expect(manager.captureState()).toEqual(before);
  } finally { await manager.dispose(); }
});

it("a divider move retires with its tab and does not revive after disposal", async () => {
  const manager = createWindowTabsManager();
  manager.restoreFromState(state);
  const resize = manager.beginSplitResize("divider");
  await manager.dispose();
  expect(resize(0.8)).toBe(false);
});
