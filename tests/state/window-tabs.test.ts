/**
 * Tests for per-pane tabs state management (#140).
 * Tests pure functions, persistence migration, and pane/tab behavior.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  generateId,
  extractFolderName,
  migrateLegacyState,
  normalizePersistedState,
  countPersistedTabs,
  createWindowTabsManager,
} from "$lib/state/window-tabs.svelte";

beforeEach(() => {
  localStorage.clear();
});

describe("generateId", () => {
  it("generates IDs with the given prefix", () => {
    const id = generateId("tab");
    expect(id.startsWith("tab-")).toBe(true);
  });

  it("generates unique IDs on successive calls", () => {
    const id1 = generateId("tab");
    const id2 = generateId("tab");
    expect(id1).not.toBe(id2);
  });

  it("includes timestamp component", () => {
    const before = Date.now();
    const id = generateId("explorer");
    const after = Date.now();

    // Extract timestamp from ID (format: prefix-timestamp-random)
    const parts = id.split("-");
    const timestamp = parseInt(parts[1], 10);

    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it("includes random suffix for uniqueness", () => {
    // Generate many IDs at the same timestamp and check for collisions
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId("test"));
    }
    // All should be unique
    expect(ids.size).toBe(100);
  });
});

describe("extractFolderName", () => {
  it("extracts folder name from Unix path", () => {
    expect(extractFolderName("/home/user/Documents")).toBe("Documents");
  });

  it("extracts folder name from Windows path", () => {
    expect(extractFolderName("C:\\Users\\user\\Documents")).toBe("Documents");
  });

  it("handles root Unix path", () => {
    // Root path "/" is valid as display name
    expect(extractFolderName("/")).toBe("/");
  });

  it("handles empty path", () => {
    expect(extractFolderName("")).toBe("Explorer");
  });

  it("handles single folder name", () => {
    expect(extractFolderName("Documents")).toBe("Documents");
  });

  it("handles path with trailing slash", () => {
    expect(extractFolderName("/home/user/")).toBe("user");
  });

  it("handles mixed separators", () => {
    expect(extractFolderName("/home\\user/docs")).toBe("docs");
  });
});

describe("legacy state migration", () => {
  const legacy = {
    tabs: [
      {
        id: "tab-1",
        panes: { left: { path: "/home/a" }, right: { path: "/srv/a" } },
        activePaneId: "left" as const,
        dualPaneEnabled: false,
        splitRatio: 0.5,
      },
      {
        id: "tab-2",
        panes: { left: { path: "/home/b" }, right: { path: "/srv/b" } },
        activePaneId: "right" as const,
        dualPaneEnabled: true,
        splitRatio: 0.7,
      },
    ],
    activeTabId: "tab-2",
  };

  it("maps every tab's left pane to a left tab", () => {
    const migrated = migrateLegacyState(legacy);
    expect(migrated.panes.left.tabs.map((t) => t.path)).toEqual(["/home/a", "/home/b"]);
    expect(migrated.panes.left.activeTabId).toBe("tab-2");
  });

  it("maps right panes of dual-pane tabs to right tabs", () => {
    const migrated = migrateLegacyState(legacy);
    expect(migrated.panes.right.tabs.map((t) => t.path)).toEqual(["/srv/b"]);
  });

  it("takes layout state from the active tab", () => {
    const migrated = migrateLegacyState(legacy);
    expect(migrated.dualPaneEnabled).toBe(true);
    expect(migrated.splitRatio).toBe(0.7);
    expect(migrated.activePaneId).toBe("right");
  });

  it("stays single-pane when the active tab was single-pane", () => {
    const migrated = migrateLegacyState({ ...legacy, activeTabId: "tab-1" });
    expect(migrated.dualPaneEnabled).toBe(false);
    expect(migrated.activePaneId).toBe("left");
    // The other tab's right pane still becomes a (hidden) right tab.
    expect(migrated.panes.right.tabs.length).toBe(1);
  });

  it("normalizePersistedState passes v2 state through and migrates v1", () => {
    const migrated = migrateLegacyState(legacy);
    expect(normalizePersistedState(migrated)).toBe(migrated);
    expect(normalizePersistedState(legacy)?.version).toBe(2);
    expect(normalizePersistedState(null)).toBeNull();
    expect(normalizePersistedState({ garbage: true })).toBeNull();
  });

  it("countPersistedTabs counts across panes for either shape", () => {
    expect(countPersistedTabs(legacy)).toBe(3);
    expect(countPersistedTabs(migrateLegacyState(legacy))).toBe(3);
    expect(countPersistedTabs(undefined)).toBe(0);
  });
});

function freshManager() {
  const manager = createWindowTabsManager();
  manager.init("/home/user", true);
  return manager;
}

describe("refreshAllPanes", () => {
  function spyPane(manager: ReturnType<typeof createWindowTabsManager>, pane: "left" | "right", calls: Array<{ pane: string; silent: boolean | undefined }>) {
    const explorer = manager.getExplorer(pane);
    expect(explorer).toBeDefined();
    const original = explorer!.refresh;
    // Wrap rather than fake: assert the real method is invoked with silent
    (explorer as any).refresh = (opts?: { silent?: boolean }) => {
      calls.push({ pane, silent: opts?.silent });
      return original(opts);
    };
  }

  it("silently refreshes both panes when dual pane is enabled", () => {
    const manager = freshManager();
    manager.setDualPane(true);
    const calls: Array<{ pane: string; silent: boolean | undefined }> = [];
    spyPane(manager, "left", calls);
    spyPane(manager, "right", calls);

    manager.refreshAllPanes();

    expect(calls).toEqual([
      { pane: "left", silent: true },
      { pane: "right", silent: true },
    ]);
  });

  it("skips the hidden right pane in single-pane mode", () => {
    const manager = freshManager();
    const calls: Array<{ pane: string; silent: boolean | undefined }> = [];
    spyPane(manager, "left", calls);

    manager.refreshAllPanes();

    expect(calls).toEqual([{ pane: "left", silent: true }]);
  });

  it("catches the right pane up when dual pane is re-enabled", () => {
    const manager = freshManager();
    manager.setDualPane(true);
    const calls: Array<{ pane: string; silent: boolean | undefined }> = [];
    spyPane(manager, "right", calls);
    manager.setDualPane(false);
    calls.length = 0;

    manager.setDualPane(true);

    expect(calls).toContainEqual({ pane: "right", silent: true });
  });
});

describe("dual pane as second tab strip", () => {
  it("enabling dual pane seeds the right pane with one tab at the parent dir", () => {
    const manager = freshManager();
    expect(manager.panes.right.tabs.length).toBe(0);

    manager.setDualPane(true);

    expect(manager.dualPaneEnabled).toBe(true);
    expect(manager.panes.right.tabs.length).toBe(1);
    expect(manager.getExplorer("right")).toBeDefined();
  });

  it("right pane tabs survive a dual-pane off/on cycle", () => {
    const manager = freshManager();
    manager.setDualPane(true);
    manager.createTabIn("right", "/srv/extra");
    expect(manager.panes.right.tabs.length).toBe(2);

    manager.setDualPane(false);
    expect(manager.activePaneId).toBe("left");
    manager.setDualPane(true);

    expect(manager.panes.right.tabs.length).toBe(2);
  });

  it("each pane cycles its own tabs independently", () => {
    const manager = freshManager();
    manager.createTab("/home/user/second"); // left pane, 2 tabs
    manager.setDualPane(true); // right pane, 1 tab

    manager.setActivePane("right");
    const rightActive = manager.activeTabId;
    manager.nextTab(); // single right tab — no-op
    expect(manager.activeTabId).toBe(rightActive);

    manager.setActivePane("left");
    const leftActive = manager.activeTabId;
    manager.nextTab();
    expect(manager.activeTabId).not.toBe(leftActive);
    // Right pane untouched by left-pane cycling
    expect(manager.panes.right.activeTabId).toBe(rightActive);
  });

  it("closing the right pane's last tab collapses back to single pane", () => {
    const manager = freshManager();
    manager.setDualPane(true);
    const rightTab = manager.panes.right.tabs[0];

    manager.closeTab(rightTab.id);

    expect(manager.dualPaneEnabled).toBe(false);
    expect(manager.activePaneId).toBe("left");
    expect(manager.panes.right.tabs.length).toBe(0);
    expect(manager.panes.left.tabs.length).toBe(1);
  });

  it("closing the left pane's last tab promotes the right pane's tabs", () => {
    const manager = freshManager();
    const leftTab = manager.panes.left.tabs[0];
    manager.setDualPane(true);
    const rightTab = manager.panes.right.tabs[0];

    manager.closeTab(leftTab.id);

    expect(manager.dualPaneEnabled).toBe(false);
    expect(manager.panes.left.tabs.map((t) => t.id)).toEqual([rightTab.id]);
    expect(manager.panes.right.tabs.length).toBe(0);
    expect(manager.activePaneId).toBe("left");
  });

  it("moveTabToPane moves a live tab across strips and keeps its explorer", () => {
    const manager = freshManager();
    manager.createTab("/home/user/second");
    manager.setDualPane(true);
    const moving = manager.panes.left.tabs[1];
    const explorerBefore = manager.getTabPath(moving.id);

    manager.moveTabToPane(moving.id, "right");

    expect(manager.panes.left.tabs.some((t) => t.id === moving.id)).toBe(false);
    expect(manager.panes.right.tabs.some((t) => t.id === moving.id)).toBe(true);
    expect(manager.panes.right.activeTabId).toBe(moving.id);
    expect(manager.activePaneId).toBe("right");
    expect(manager.getTabPath(moving.id)).toBe(explorerBefore);
  });

  it("moveTabToPane is a no-op for a pane's last tab", () => {
    const manager = freshManager();
    manager.setDualPane(true);
    const onlyLeft = manager.panes.left.tabs[0];

    manager.moveTabToPane(onlyLeft.id, "right");

    expect(manager.panes.left.tabs.map((t) => t.id)).toEqual([onlyLeft.id]);
  });
});

describe("cross-window tab transfer primitives", () => {
  it("exportTab serializes the tab's live path", () => {
    const manager = freshManager();
    const snapshot = manager.exportTab(manager.activeTabId!);
    expect(snapshot).toEqual({ path: "/home/user" });
  });

  it("exportTab returns null for unknown tabs", () => {
    const manager = freshManager();
    expect(manager.exportTab("nope")).toBeNull();
  });

  it("adoptTab inserts at the requested index and activates it", () => {
    const manager = freshManager();
    manager.createTab("/tmp/second");
    expect(manager.tabs.length).toBe(2);

    const adopted = manager.adoptTab({ path: "/srv/incoming" }, 1);

    expect(manager.tabs.length).toBe(3);
    expect(manager.tabs[1].id).toBe(adopted.id);
    expect(manager.activeTabId).toBe(adopted.id);
    expect(manager.getTabPath(adopted.id)).toBe("/srv/incoming");
  });

  it("adoptTab without an index appends at the end", () => {
    const manager = freshManager();
    const adopted = manager.adoptTab({ path: "/var/log" });
    expect(manager.tabs[manager.tabs.length - 1].id).toBe(adopted.id);
  });

  it("adoptTab accepts a legacy dual-pane snapshot's active path", () => {
    const manager = freshManager();
    const adopted = manager.adoptTab({
      leftPath: "/var/log",
      rightPath: "/var",
      activePaneId: "right",
      dualPaneEnabled: true,
      splitRatio: 0.5,
    } as any);
    expect(manager.getTabPath(adopted.id)).toBe("/var");
  });

  it("removeTransferredTab removes without adding a closed-tab snapshot", () => {
    const manager = freshManager();
    const moved = manager.createTab("/tmp/moving");
    expect(manager.tabs.length).toBe(2);

    manager.removeTransferredTab(moved.id);

    expect(manager.tabs.length).toBe(1);
    expect(manager.tabs.some((t) => t.id === moved.id)).toBe(false);
    // The tab moved elsewhere — Ctrl+Shift+T must not resurrect it here.
    expect(manager.canRestoreTab).toBe(false);
  });
});

describe("closed-tab restore (Ctrl+Shift+T)", () => {
  it("restores a closed tab into the pane it was closed from", () => {
    const manager = freshManager();
    manager.setDualPane(true);
    manager.createTabIn("right", "/srv/gone");
    const closing = manager.panes.right.tabs.find((t) => manager.getTabPath(t.id) === "/srv/gone")!;

    manager.closeTab(closing.id);
    expect(manager.panes.right.tabs.some((t) => manager.getTabPath(t.id) === "/srv/gone")).toBe(false);

    const result = manager.restoreClosedTab();
    expect(result).toMatchObject({ restored: true });
    expect(manager.panes.right.tabs.some((t) => manager.getTabPath(t.id) === "/srv/gone")).toBe(true);
  });

  it("restores into the left pane when the right pane is closed", () => {
    const manager = freshManager();
    manager.setDualPane(true);
    manager.createTabIn("right", "/srv/gone");
    const closing = manager.panes.right.tabs.find((t) => manager.getTabPath(t.id) === "/srv/gone")!;
    manager.closeTab(closing.id);
    manager.setDualPane(false);

    manager.restoreClosedTab();

    expect(manager.panes.left.tabs.some((t) => manager.getTabPath(t.id) === "/srv/gone")).toBe(true);
  });
});

describe("persistence round-trip", () => {
  it("captureState/restoreFromState preserves panes, layout, and active ids", () => {
    const manager = freshManager();
    manager.createTab("/home/user/second");
    manager.setDualPane(true);
    manager.setSplitRatio(0.7);

    const state = manager.captureState();
    expect(state.version).toBe(2);

    const restored = createWindowTabsManager();
    restored.restoreFromState(state);

    expect(restored.panes.left.tabs.length).toBe(2);
    expect(restored.panes.right.tabs.length).toBe(1);
    expect(restored.dualPaneEnabled).toBe(true);
    expect(restored.splitRatio).toBe(0.7);
    expect(restored.panes.left.activeTabId).toBe(state.panes.left.activeTabId);
  });

  it("restoreFromState accepts a legacy v1 workspace state", () => {
    const manager = createWindowTabsManager();
    manager.restoreFromState({
      tabs: [
        {
          id: "t1",
          panes: { left: { path: "/home/a" }, right: { path: "/srv/a" } },
          activePaneId: "left",
          dualPaneEnabled: true,
          splitRatio: 0.6,
        },
      ],
      activeTabId: "t1",
    });

    expect(manager.panes.left.tabs.map((t) => manager.getTabPath(t.id))).toEqual(["/home/a"]);
    expect(manager.panes.right.tabs.map((t) => manager.getTabPath(t.id))).toEqual(["/srv/a"]);
    expect(manager.dualPaneEnabled).toBe(true);
    expect(manager.splitRatio).toBe(0.6);
  });
});

describe("tagged-union tab kinds (#56)", () => {
  it("openGitGraphTab creates a git-graph tab and reuses it per repo", () => {
    const manager = freshManager();
    const tab = manager.openGitGraphTab("/home/user/project");

    expect(tab.kind).toBe("git-graph");
    expect(manager.activeTabId).toBe(tab.id);
    expect(manager.getTabPath(tab.id)).toBe("/home/user/project");
    expect(manager.getTabTitle(tab)).toBe("Graph: project");

    // Same repo → reuse, no duplicate.
    const again = manager.openGitGraphTab("/home/user/project");
    expect(again.id).toBe(tab.id);
    expect(manager.tabs.filter((t) => t.kind === "git-graph")).toHaveLength(1);
  });

  it("a git-graph tab has no explorer and survives a persistence round-trip", () => {
    const manager = freshManager();
    manager.openGitGraphTab("/home/user/project");
    expect(manager.getActiveExplorer()).toBeUndefined();

    const state = manager.captureState();
    const restored = createWindowTabsManager();
    restored.restoreFromState(state);

    const graphTab = restored.panes.left.tabs.find((t) => t.kind === "git-graph")!;
    expect(graphTab).toBeDefined();
    expect(restored.getTabPath(graphTab.id)).toBe("/home/user/project");
    // Old persisted tabs without a kind stay explorers (defaulting migration).
    expect(restored.panes.left.tabs[0].kind).toBe("explorer");
  });

  it("closing a git-graph tab works and snapshots its repo path", () => {
    const manager = freshManager();
    const tab = manager.openGitGraphTab("/home/user/project");
    manager.closeTab(tab.id);
    expect(manager.tabs.some((t) => t.id === tab.id)).toBe(false);
    expect(manager.canRestoreTab).toBe(true);
  });
});

describe("adversarial review regressions (#167)", () => {
  it("Ctrl+Shift+T restores a closed git-graph tab as a git-graph tab", () => {
    const manager = freshManager();
    const graph = manager.openGitGraphTab("/home/user/project");
    manager.closeTab(graph.id);

    const result = manager.restoreClosedTab();

    expect(result).toMatchObject({ restored: true });
    const restored = manager.panes.left.tabs.find((t) => t.kind === "git-graph");
    expect(restored).toBeDefined();
    expect(manager.getTabPath(restored!.id)).toBe("/home/user/project");
    expect(manager.getTabTitle(restored!)).toBe("Graph: project");
  });

  it("normalizePersistedState rejects v2 states missing tabs arrays", () => {
    expect(
      normalizePersistedState({ version: 2, panes: { left: {}, right: {} }, activePaneId: "left", dualPaneEnabled: false, splitRatio: 0.5 }),
    ).toBeNull();
    expect(countPersistedTabs({ version: 2, panes: { left: {}, right: {} } })).toBe(0);
  });

  it("init survives a corrupt v2 saved state (falls back to a fresh tab)", () => {
    localStorage.setItem(
      "explorer-tabs",
      JSON.stringify({ version: 2, panes: { left: {}, right: {} }, activePaneId: "left", dualPaneEnabled: false, splitRatio: 0.5 }),
    );
    const manager = createWindowTabsManager();
    expect(() => manager.init("/home/user")).not.toThrow();
    expect(manager.panes.left.tabs.length).toBe(1);
  });
});
