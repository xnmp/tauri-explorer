/**
 * The window-tab manager publishes which tabs keep their pane tree mounted
 * (#1173). PaneContainer renders exactly this list, so a switch back to a
 * retained tab keeps its mount identity instead of rebuilding the tree.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";
import { RETAINED_TAB_CAPACITY } from "$lib/domain/retained-tabs";

beforeEach(() => localStorage.clear());

function managerWithTabs(count: number) {
  const manager = createWindowTabsManager();
  manager.init("/home/user", true);
  for (let i = 1; i < count; i++) manager.createTab(`/tmp/${i}`);
  return manager;
}

/** Activate a tab and render it: PaneContainer reads the list every switch. */
function show(manager: ReturnType<typeof createWindowTabsManager>, tabId: string) {
  manager.setActiveTab(tabId);
  return manager.retainedTabs;
}

const mountKeys = (manager: ReturnType<typeof createWindowTabsManager>) =>
  manager.retainedTabs.map((tab) => manager.tabInstance(tab));

describe("windowTabsManager.retainedTabs (#1173)", () => {
  it("keeps visited tabs mounted with stable identities across switches", () => {
    const manager = managerWithTabs(1);
    const first = manager.activeTab!;
    expect(mountKeys(manager)).toEqual([manager.tabInstance(first)]);
    const second = manager.createTab("/tmp/second");
    expect(manager.retainedTabs.map((tab) => tab.id)).toEqual([first.id, second.id]);
    const before = mountKeys(manager);

    for (let i = 0; i < 10; i++) {
      manager.nextTab();
      expect(mountKeys(manager)).toEqual(before);
    }
    manager.setActiveTab(first.id);
    expect(mountKeys(manager)).toEqual(before);
  });

  it("bounds the retained tabs and evicts the least recently active", () => {
    const manager = managerWithTabs(RETAINED_TAB_CAPACITY + 2);
    for (const tab of manager.tabs) show(manager, tab.id);
    const ids = manager.tabs.map((tab) => tab.id);
    expect(manager.retainedTabs.map((tab) => tab.id)).toEqual(ids.slice(-RETAINED_TAB_CAPACITY));
    show(manager, ids[0]);
    expect(manager.retainedTabs).toHaveLength(RETAINED_TAB_CAPACITY);
    expect(manager.retainedTabs.map((tab) => tab.id)).toContain(ids[0]);
    expect(manager.retainedTabs.map((tab) => tab.id)).not.toContain(ids[ids.length - RETAINED_TAB_CAPACITY]);
  });

  it("unmounts a closed tab and publishes current tab objects", () => {
    const manager = managerWithTabs(3);
    for (const tab of manager.tabs) show(manager, tab.id);
    const closed = manager.tabs[1].id;
    manager.closeTab(closed);
    expect(manager.retainedTabs.map((tab) => tab.id)).not.toContain(closed);
    for (const tab of manager.retainedTabs) expect(manager.tabs).toContain(tab);
  });
});
