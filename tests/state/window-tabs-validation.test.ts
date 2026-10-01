import { describe, expect, it } from "vitest";
import { normalizePersistedState, type PersistedNode } from "$lib/state/window-tabs-persistence";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";

const leaf = (id: string): PersistedNode => ({ type: "leaf", id, path: `/home/${id}` });
const tab = (id: string, layout: PersistedNode, activePaneId = "missing") => ({
  id, kind: "explorer", layout, activePaneId,
});
const normalize = (tabs: unknown[]) => normalizePersistedState({ version: 3, tabs, activeTabId: "missing" });
const split = (id: string, first: PersistedNode, second: PersistedNode): PersistedNode => ({
  type: "split", id, first, second, direction: "row", ratio: 0.5,
});

describe("saved layout identity boundary", () => {
  it("restores inactive tab descriptors without opening their directories until activation", async () => {
    const manager = createWindowTabsManager();
    const savedTabs = Array.from({ length: 64 }, (_, i) => tab(`tab-${i}`, leaf(`pane-${i}`), `pane-${i}`));
    try {
      manager.restoreFromState({ version: 3, tabs: savedTabs, activeTabId: "tab-0" });
      expect(manager.captureState().tabs).toHaveLength(64);
      expect(manager.getAllExplorers()).toHaveLength(1);
      expect(manager.getExplorer("pane-63")).toBeUndefined();
      expect(manager.exportTab("tab-63")?.tab?.layout).toEqual(leaf("pane-63"));
      manager.setActiveTab("tab-63");
      const activated = manager.getActiveExplorer();
      expect(activated).toBeDefined();
      expect(manager.getAllExplorers()).toHaveLength(2);
      manager.prevTab();
      expect(manager.getActiveExplorer()).toBeDefined();
      manager.nextTab();
      expect(manager.getActiveExplorer()).toBe(activated);
      manager.closeTab("tab-63");
      expect(manager.getActiveExplorer()).toBeDefined();
      expect(manager.captureState().tabs).toHaveLength(63);
    } finally { await manager.dispose(); }
  });

  it("bounds total allocation before migrating or traversing saved tabs", () => {
    expect(normalize(Array.from({ length: 4097 }, (_, i) => tab(`t${i}`, leaf(`p${i}`))))).toBeNull();
    expect(normalizePersistedState({ tabs: new Array(100_000) })).toBeNull();
  });

  it("restores finite split geometry within the same bounds as interactive resizing", () => {
    const node = split("split", leaf("left"), leaf("right"));
    if (node.type !== "split") throw new Error("Expected split fixture");
    expect(normalize([tab("tab", { ...node, ratio: 100 })])?.tabs[0].layout).toMatchObject({ ratio: 0.9 });
    expect(normalize([tab("tab", { ...node, ratio: -100 })])?.tabs[0].layout).toMatchObject({ ratio: 0.1 });
  });
  it("ignores malformed directory seeds and still starts a usable explorer", async () => {
    localStorage.setItem("dir-seed:main", JSON.stringify({
      ts: Date.now(), currentPath: "/home/user", entries: [null],
      sortBy: "invalid", sortAscending: "no", viewMode: "invalid",
    }));
    const manager = createWindowTabsManager();
    try {
      manager.init("/home/user", true);
      expect(["details", "list", "tiles"]).toContain(manager.getActiveExplorer()?.viewMode);
      expect(() => manager.getActiveExplorer()?.displayEntries).not.toThrow();
      expect(localStorage.getItem("dir-seed:main")).toBeNull();
    } finally { await manager.dispose(); }
  });

  it("keeps valid tabs and drops later tabs sharing a tab or pane identity", () => {
    const result = normalize([
      tab("one", leaf("pane")), tab("two", leaf("pane")),
      tab("one", leaf("another")), tab("three", leaf("third")),
    ]);
    expect(result?.tabs.map((entry) => entry.id)).toEqual(["one", "three"]);
    expect(result?.activeTabId).toBe("one");
    expect(result?.tabs[0].activePaneId).toBe("pane");
  });

  it("rejects duplicate node identities within a layout before allocating resources", () => {
    expect(normalize([tab("bad", split("split", leaf("same"), leaf("same")))])?.tabs).toEqual([]);
    expect(normalize([tab("bad", split("same", leaf("same"), leaf("other")))])?.tabs).toEqual([]);
  });

  it("rejects cycles, excessive depth, and non-finite geometry without recursing indefinitely", () => {
    const cyclic = split("cycle", leaf("a"), leaf("b"));
    if (cyclic.type === "split") cyclic.first = cyclic;
    let deep = leaf("end");
    for (let i = 0; i < 10_000; i++) deep = split(`split-${i}`, leaf(`leaf-${i}`), deep);
    const nonfinite = { ...split("split", leaf("a"), leaf("b")), ratio: NaN };
    expect(normalize([tab("cycle", cyclic), tab("deep", deep)])).toBeNull();
    expect(normalize([tab("nan", nonfinite)])?.tabs).toEqual([]);
  });

  it("handles malformed legacy input and repairs absent active panes", () => {
    expect(normalizePersistedState({ tabs: [null] })).toBeNull();
    expect(normalize([null, {}, tab("valid", leaf("present"))])?.tabs[0].activePaneId).toBe("present");
  });

  it("restores unusual string IDs as own pane properties", async () => {
    const manager = createWindowTabsManager();
    manager.restoreFromState(normalize([tab("valid", leaf("__proto__"))])!);
    expect(manager.getExplorer("__proto__")).toBeDefined();
    expect(manager.captureState().tabs[0].layout).toEqual(leaf("__proto__"));
    const original = manager.getExplorer("__proto__");
    manager.createTab("/home/other");
    manager.closeTab("valid");
    expect(manager.getAllExplorers()).not.toContain(original);
    await manager.dispose();
  });

  it("starts a working default pane when every saved tab is invalid", async () => {
    localStorage.setItem("explorer-tabs", JSON.stringify({
      version: 3, tabs: [tab("", leaf("bad"))], activeTabId: "",
    }));
    const manager = createWindowTabsManager();
    manager.init("/home/user");
    expect(manager.getActiveExplorer()).toBeDefined();
    expect(manager.captureState().tabs[0].layout).toMatchObject({ type: "leaf", path: "/home/user" });
    await manager.dispose();
    localStorage.removeItem("explorer-tabs");
  });
});
