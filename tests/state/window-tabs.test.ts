/**
 * Tests for window tabs state management (#228: window tabs own pane
 * layout trees). Tests pure functions, persistence migration (v1/v2 → v3),
 * pane splitting, titles, rename-to-workspace, and tab behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateId,
  extractFolderName,
  migrateLegacyState,
  migrateV2State,
  normalizePersistedState,
  countPersistedTabs,
  createWindowTabsManager,
  type PersistedWindowTab,
} from "$lib/state/window-tabs.svelte";
import { persistedLeaves } from "$lib/state/window-tabs-persistence";
import { workspacesStore } from "$lib/state/workspaces.svelte";
import { settingsStore } from "$lib/state/settings.svelte";

beforeEach(() => {
  localStorage.clear();
});

/** Leaf paths of a persisted explorer tab, in visual order. */
function tabPaths(tab: PersistedWindowTab): string[] {
  return persistedLeaves(tab.layout).map((l) => l.path);
}

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

  it("includes random suffix for uniqueness", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId("test"));
    }
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
    expect(extractFolderName("/")).toBe("/");
  });

  it("handles empty path", () => {
    expect(extractFolderName("")).toBe("Explorer");
  });

  it("handles path with trailing slash", () => {
    expect(extractFolderName("/home/user/")).toBe("user");
  });
});

describe("v1 (legacy) state migration", () => {
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

  it("maps a single-pane legacy tab to a one-leaf tab", () => {
    const migrated = migrateLegacyState(legacy);
    expect(migrated.version).toBe(3);
    expect(tabPaths(migrated.tabs[0])).toEqual(["/home/a"]);
  });

  it("maps a dual-pane legacy tab to a two-leaf row split with its ratio", () => {
    const migrated = migrateLegacyState(legacy);
    const tab = migrated.tabs[1];
    expect(tabPaths(tab)).toEqual(["/home/b", "/srv/b"]);
    expect(tab.kind === "explorer" && tab.layout.type === "split" && tab.layout.ratio).toBe(0.7);
  });

  it("preserves the active tab and its focused pane side", () => {
    const migrated = migrateLegacyState(legacy);
    expect(migrated.activeTabId).toBe("tab-2");
    const tab = migrated.tabs[1];
    // Active pane was "right" → the second leaf.
    expect(tab.kind === "explorer" && tab.activePaneId).toBe(
      persistedLeaves((tab as any).layout)[1].id,
    );
  });
});

describe("v2 (per-pane strips) state migration", () => {
  const v2 = {
    version: 2 as const,
    panes: {
      left: {
        tabs: [
          { id: "l1", path: "/home/a" },
          { id: "l2", path: "/home/b" },
        ],
        activeTabId: "l2",
      },
      right: {
        tabs: [
          { id: "r1", path: "/srv/a" },
          { id: "r2", path: "/srv/b", kind: "git-graph" as const },
        ],
        activeTabId: "r1",
      },
    },
    activePaneId: "left" as const,
    dualPaneEnabled: true,
    splitRatio: 0.6,
  };

  it("merges the two active strip tabs into one two-pane tab", () => {
    const migrated = migrateV2State(v2);
    const merged = migrated.tabs.find((t) => t.id === "l2")!;
    expect(tabPaths(merged)).toEqual(["/home/b", "/srv/a"]);
    expect(merged.kind === "explorer" && merged.layout.type === "split" && merged.layout.ratio).toBe(0.6);
    expect(migrated.activeTabId).toBe("l2");
    // The consumed right tab doesn't reappear as its own tab.
    expect(migrated.tabs.some((t) => t.id === "r1")).toBe(false);
  });

  it("keeps the remaining strip tabs as single-pane tabs; v2 git-graph tabs become graph panes (#272)", () => {
    const migrated = migrateV2State(v2);
    expect(migrated.tabs.map((t) => t.id)).toEqual(["l1", "l2", "r2"]);
    expect(tabPaths(migrated.tabs[0])).toEqual(["/home/a"]);
    const graphTab = migrated.tabs[2];
    expect(graphTab.kind).toBe("explorer");
    expect(graphTab.layout).toMatchObject({ type: "leaf", path: "/srv/b", gitGraph: "/srv/b" });
  });

  it("does not merge when dual pane was off", () => {
    const migrated = migrateV2State({ ...v2, dualPaneEnabled: false });
    expect(migrated.tabs.map((t) => t.id)).toEqual(["l1", "l2", "r1", "r2"]);
    for (const t of migrated.tabs) {
      expect(tabPaths(t)).toHaveLength(1);
    }
    expect(migrated.activeTabId).toBe("l2");
  });
});

describe("normalizePersistedState", () => {
  it("passes v3 through, migrates v1 and v2, rejects garbage", () => {
    const v3 = migrateLegacyState({ tabs: [], activeTabId: null });
    expect(normalizePersistedState(v3)?.version).toBe(3);
    expect(
      normalizePersistedState({
        tabs: [
          {
            id: "t",
            panes: { left: { path: "/a" }, right: { path: "/b" } },
            activePaneId: "left",
            dualPaneEnabled: false,
            splitRatio: 0.5,
          },
        ],
        activeTabId: "t",
      })?.version,
    ).toBe(3);
    expect(normalizePersistedState(null)).toBeNull();
    expect(normalizePersistedState({ garbage: true })).toBeNull();
  });

  it("drops malformed tabs from a v3 state instead of throwing", () => {
    const state = normalizePersistedState({
      version: 3,
      tabs: [
        { id: "ok", kind: "explorer", layout: { type: "leaf", id: "p", path: "/a" }, activePaneId: "p" },
        { id: "bad", kind: "explorer" },
        null,
      ],
      activeTabId: "bad",
    });
    expect(state?.tabs.map((t) => t.id)).toEqual(["ok"]);
    expect(state?.activeTabId).toBe("ok");
  });

  it("countPersistedTabs counts tabs for any shape", () => {
    const legacy = {
      tabs: [
        {
          id: "t1",
          panes: { left: { path: "/a" }, right: { path: "/b" } },
          activePaneId: "left",
          dualPaneEnabled: true,
          splitRatio: 0.5,
        },
      ],
      activeTabId: "t1",
    };
    expect(countPersistedTabs(legacy)).toBe(1);
    expect(countPersistedTabs(undefined)).toBe(0);
  });
});

function freshManager() {
  const manager = createWindowTabsManager();
  manager.init("/home/user", true);
  return manager;
}

describe("pane splitting (#228)", () => {
  it("splitPane adds a pane and focuses it", () => {
    const manager = freshManager();
    expect(manager.activePaneIds).toHaveLength(1);

    manager.splitPane("right");

    expect(manager.activePaneIds).toHaveLength(2);
    expect(manager.dualPaneEnabled).toBe(true);
    // New pane focused, positioned second, showing the source directory.
    expect(manager.activePaneId).toBe(manager.activePaneIds[1]);
    expect(manager.getPanePath(manager.activePaneId)).toBe("/home/user");
  });

  it("directional placements position the new pane before/after the target", () => {
    const manager = freshManager();
    const original = manager.activePaneId;

    manager.splitPane("left");

    expect(manager.activePaneIds[0]).toBe(manager.activePaneId);
    expect(manager.activePaneIds[1]).toBe(original);
  });

  it("supports more than two panes", () => {
    const manager = freshManager();
    manager.splitPane("right");
    manager.splitPane("down");
    expect(manager.activePaneIds).toHaveLength(3);
  });

  it("switchPane cycles panes in visual order", () => {
    const manager = freshManager();
    manager.splitPane("right");
    manager.splitPane("down");
    const ids = manager.activePaneIds;
    manager.setActivePane(ids[0]);

    manager.switchPane();
    expect(manager.activePaneId).toBe(ids[1]);
    manager.switchPane();
    expect(manager.activePaneId).toBe(ids[2]);
    manager.switchPane();
    expect(manager.activePaneId).toBe(ids[0]);
  });

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

  it("closePane removes the focused pane and focuses a survivor", () => {
    const manager = freshManager();
    const first = manager.activePaneId;
    manager.splitPane("right");

    manager.closePane();

    expect(manager.activePaneIds).toEqual([first]);
    expect(manager.activePaneId).toBe(first);
    expect(manager.dualPaneEnabled).toBe(false);
  });

  it("closing the last pane closes the tab", () => {
    const manager = freshManager();
    manager.createTab("/tmp/second");
    expect(manager.tabs).toHaveLength(2);

    manager.closePane();

    expect(manager.tabs).toHaveLength(1);
  });

  it("split explorers are independent after creation", () => {
    const manager = freshManager();
    manager.splitPane("right");
    const [a, b] = manager.activePaneIds;
    expect(manager.getExplorer(a)).toBeDefined();
    expect(manager.getExplorer(b)).toBeDefined();
    expect(manager.getExplorer(a)).not.toBe(manager.getExplorer(b));
  });
});

describe("dual pane toggle (Ctrl+\\)", () => {
  it("splits right, seeding the new pane at the parent directory", () => {
    const manager = freshManager();

    manager.setDualPane(true);

    expect(manager.dualPaneEnabled).toBe(true);
    expect(manager.activePaneIds).toHaveLength(2);
    const second = manager.activePaneIds[1];
    expect(manager.getPanePath(second)).toBe("/home");
  });

  it("toggling off collapses to only the focused pane", () => {
    const manager = freshManager();
    manager.setDualPane(true);
    manager.splitPane("down");
    expect(manager.activePaneIds).toHaveLength(3);
    const focused = manager.activePaneId;

    manager.setDualPane(false);

    expect(manager.activePaneIds).toEqual([focused]);
    expect(manager.dualPaneEnabled).toBe(false);
  });
});

describe("tab titles (#228)", () => {
  it("a single-pane tab shows its folder name", () => {
    const manager = freshManager();
    expect(manager.getTabTitle(manager.activeTab!)).toBe("user");
  });

  it("a multi-pane tab joins every pane's folder name", () => {
    const manager = freshManager();
    manager.splitPane("right", "/srv/docs");
    expect(manager.getTabTitle(manager.activeTab!)).toBe("user | docs");

    manager.splitPane("down", "/var/log");
    expect(manager.getTabTitle(manager.activeTab!)).toBe("user | docs | log");
  });

  it("a custom name overrides the joined title", () => {
    const manager = freshManager();
    manager.splitPane("right", "/srv/docs");
    manager.renameTab(manager.activeTabId!, "My Workspace");
    expect(manager.getTabTitle(manager.activeTab!)).toBe("My Workspace");
  });

  it("tooltip lists every pane's path", () => {
    const manager = freshManager();
    manager.splitPane("right", "/srv/docs");
    expect(manager.getTabTooltip(manager.activeTab!)).toBe("/home/user\n/srv/docs");
  });
});

describe("rename to workspace (#228)", () => {
  it("single-pane tabs cannot be renamed", () => {
    const manager = freshManager();
    expect(manager.canRenameTab(manager.activeTabId!)).toBe(false);
    expect(manager.renameTab(manager.activeTabId!, "Nope")).toBe(false);
  });

  it("renaming a multi-pane tab saves it as a workspace", () => {
    const manager = freshManager();
    manager.splitPane("right", "/srv/docs");
    expect(manager.canRenameTab(manager.activeTabId!)).toBe(true);

    const ok = manager.renameTab(manager.activeTabId!, "Research");

    expect(ok).toBe(true);
    const ws = workspacesStore.list.find((w) => w.name === "Research");
    expect(ws).toBeDefined();
    expect(ws!.state.tabs).toHaveLength(1);
    expect(tabPaths(ws!.state.tabs[0])).toEqual(["/home/user", "/srv/docs"]);
    workspacesStore.remove(ws!.id);
  });

  it("a workspace saved from a renamed tab restores the full layout", () => {
    const manager = freshManager();
    manager.splitPane("right", "/srv/docs");
    manager.renameTab(manager.activeTabId!, "Restore Me");
    const ws = workspacesStore.list.find((w) => w.name === "Restore Me")!;

    const restored = createWindowTabsManager();
    restored.restoreFromState(ws.state);

    expect(restored.tabs).toHaveLength(1);
    expect(restored.activePaneIds).toHaveLength(2);
    expect(restored.getTabTitle(restored.activeTab!)).toBe("Restore Me");
    workspacesStore.remove(ws.id);
  });

  it("collapsing to a single pane drops the custom name", () => {
    const manager = freshManager();
    manager.splitPane("right", "/srv/docs");
    manager.renameTab(manager.activeTabId!, "Temp");
    manager.closePane();
    expect(manager.getTabTitle(manager.activeTab!)).toBe("user");
    const ws = workspacesStore.list.find((w) => w.name === "Temp");
    if (ws) workspacesStore.remove(ws.id);
  });
});

describe("refreshAllPanes", () => {
  function spyPane(
    manager: ReturnType<typeof createWindowTabsManager>,
    paneId: string,
    calls: Array<{ pane: string; silent: boolean | undefined }>,
  ) {
    const explorer = manager.getExplorer(paneId);
    expect(explorer).toBeDefined();
    const original = explorer!.refresh;
    // Wrap rather than fake: assert the real method is invoked with silent
    (explorer as any).refresh = (opts?: { silent?: boolean }) => {
      calls.push({ pane: paneId, silent: opts?.silent });
      return original(opts);
    };
  }

  it("silently refreshes every pane of the active tab", () => {
    const manager = freshManager();
    manager.splitPane("right");
    const [a, b] = manager.activePaneIds;
    const calls: Array<{ pane: string; silent: boolean | undefined }> = [];
    spyPane(manager, a, calls);
    spyPane(manager, b, calls);

    manager.refreshAllPanes();

    expect(calls).toEqual([
      { pane: a, silent: true },
      { pane: b, silent: true },
    ]);
  });

  it("skips panes of inactive tabs", () => {
    const manager = freshManager();
    const firstPane = manager.activePaneId;
    manager.createTab("/tmp/second");
    const calls: Array<{ pane: string; silent: boolean | undefined }> = [];
    spyPane(manager, firstPane, calls);

    manager.refreshAllPanes();

    expect(calls).toEqual([]);
  });
});

describe("cross-window tab transfer primitives", () => {
  it("exportTab serializes the live path and the full tab payload", () => {
    const manager = freshManager();
    const snapshot = manager.exportTab(manager.activeTabId!);
    expect(snapshot?.path).toBe("/home/user");
    expect(snapshot?.tab?.kind).toBe("explorer");
    expect(tabPaths(snapshot!.tab!)).toEqual(["/home/user"]);
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

  it("adopting a multi-pane snapshot rebuilds the layout with fresh ids", () => {
    const source = freshManager();
    source.splitPane("right", "/srv/docs");
    const snapshot = source.exportTab(source.activeTabId!)!;

    const target = freshManager();
    const adopted = target.adoptTab(snapshot);

    expect(adopted.kind).toBe("explorer");
    expect(target.activeTabId).toBe(adopted.id);
    expect(target.activePaneIds).toHaveLength(2);
    // Fresh ids: no collision with the source's pane ids.
    for (const paneId of target.activePaneIds) {
      expect(source.activePaneIds).not.toContain(paneId);
    }
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
  it("restores a closed tab at its old index", () => {
    const manager = freshManager();
    const closing = manager.createTab("/srv/gone");
    manager.createTab("/tmp/third");

    manager.closeTab(closing.id);
    expect(manager.tabs.some((t) => manager.getTabPath(t.id) === "/srv/gone")).toBe(false);

    const result = manager.restoreClosedTab();
    expect(result).toMatchObject({ restored: true });
    expect(manager.getTabPath(manager.tabs[1].id)).toBe("/srv/gone");
  });

  it("restores a closed multi-pane tab with its full layout", () => {
    const manager = freshManager();
    const closing = manager.createTab("/srv/gone");
    manager.splitPane("down", "/srv/extra");

    manager.closeTab(closing.id);
    manager.restoreClosedTab();

    const restored = manager.activeTab!;
    expect(restored.kind).toBe("explorer");
    expect(manager.activePaneIds).toHaveLength(2);
    expect(manager.getTabTitle(restored)).toBe("gone | extra");
  });
});

describe("persistence round-trip", () => {
  it("captureState/restoreFromState preserves tabs, layout, and active ids", () => {
    const manager = freshManager();
    manager.splitPane("right", "/srv/docs");
    manager.createTab("/tmp/second");

    const state = manager.captureState();
    expect(state.version).toBe(3);

    const restored = createWindowTabsManager();
    restored.restoreFromState(state);

    expect(restored.tabs.length).toBe(2);
    expect(restored.activeTabId).toBe(state.activeTabId);
    expect(restored.getTabPath(restored.activeTabId!)).toBe("/tmp/second");
    // The multi-pane tab kept its layout.
    const multi = restored.tabs[0];
    expect(multi.kind === "explorer" && restored.getTabTitle(multi)).toBe("user | docs");
  });

  it("split ratios survive the round-trip", () => {
    const manager = freshManager();
    manager.splitPane("right");
    const tab = manager.activeTab!;
    const splitId = tab.kind === "explorer" && tab.layout.type === "split" ? tab.layout.id : "";
    manager.setSplitRatio(splitId, 0.7);

    const restored = createWindowTabsManager();
    restored.restoreFromState(manager.captureState());

    const rTab = restored.activeTab!;
    expect(rTab.kind === "explorer" && rTab.layout.type === "split" && rTab.layout.ratio).toBe(0.7);
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

    expect(manager.tabs).toHaveLength(1);
    expect(manager.activePaneIds).toHaveLength(2);
    expect(manager.getPanePath(manager.activePaneIds[0])).toBe("/home/a");
    expect(manager.getPanePath(manager.activePaneIds[1])).toBe("/srv/a");
  });

  it("restoreFromState accepts a v2 per-pane-strips state", () => {
    const manager = createWindowTabsManager();
    manager.restoreFromState({
      version: 2,
      panes: {
        left: { tabs: [{ id: "l1", path: "/home/a" }], activeTabId: "l1" },
        right: { tabs: [{ id: "r1", path: "/srv/a" }], activeTabId: "r1" },
      },
      activePaneId: "left",
      dualPaneEnabled: true,
      splitRatio: 0.5,
    });

    // Actives merged into one dual-pane tab.
    expect(manager.tabs).toHaveLength(1);
    expect(manager.activePaneIds).toHaveLength(2);
  });
});

describe("per-pane git graph (#272)", () => {
  it("toggleGitGraphInActivePane sets and clears the active pane's graph", () => {
    const manager = freshManager();
    const paneId = manager.activePaneId;

    manager.toggleGitGraphInActivePane("/home/user/project");
    expect(manager.getPaneGitGraph(paneId)).toBe("/home/user/project");

    // Toggling again returns the pane to the file listing.
    manager.toggleGitGraphInActivePane(null);
    expect(manager.getPaneGitGraph(paneId)).toBeUndefined();
  });

  it("a graph pane survives a persistence round-trip", () => {
    const manager = freshManager();
    manager.toggleGitGraphInActivePane("/home/user/project");

    const state = manager.captureState();
    const restored = createWindowTabsManager();
    restored.restoreFromState(state);

    const paneId = restored.activePaneId;
    expect(restored.getPaneGitGraph(paneId)).toBe("/home/user/project");
  });

  it("pre-#272 persisted git-graph TABS migrate to explorer tabs with a graph pane", () => {
    const manager = freshManager();
    manager.restoreFromState({
      version: 3,
      tabs: [{ id: "g1", kind: "git-graph", path: "/home/user/project" }],
      activeTabId: "g1",
    });

    expect(manager.tabs).toHaveLength(1);
    const tab = manager.tabs[0];
    expect(tab.kind).toBe("explorer");
    expect(manager.getTabPath(tab.id)).toBe("/home/user/project");
    expect(manager.getPaneGitGraph(tab.activePaneId)).toBe("/home/user/project");
  });

  it("pane operations still work while a pane shows the graph", () => {
    const manager = freshManager();
    manager.toggleGitGraphInActivePane("/home/user/project");
    expect(() => {
      manager.splitPane("right");
      manager.newPane();
      manager.closePane();
    }).not.toThrow();
  });
});

describe("adversarial review regressions (#167)", () => {
  it("Ctrl+Shift+T restores a closed tab with its graph pane intact", () => {
    const manager = freshManager();
    manager.createTab("/home/user/project");
    const graphTabId = manager.activeTabId!;
    manager.toggleGitGraphInActivePane("/home/user/project");
    manager.closeTab(graphTabId);

    const result = manager.restoreClosedTab();

    expect(result).toMatchObject({ restored: true });
    const restored = manager.tabs.find(
      (t) => manager.getPaneGitGraph(t.activePaneId) === "/home/user/project",
    );
    expect(restored).toBeDefined();
    expect(manager.getTabPath(restored!.id)).toBe("/home/user/project");
  });

  it("init survives a corrupt saved state (falls back to a fresh tab)", () => {
    localStorage.setItem(
      "explorer-tabs",
      JSON.stringify({ version: 3, tabs: [{ id: "bad", kind: "explorer" }], activeTabId: "bad" }),
    );
    const manager = createWindowTabsManager();
    expect(() => manager.init("/home/user")).not.toThrow();
    expect(manager.tabs.length).toBe(1);
  });

  it("init survives a corrupt v2 saved state", () => {
    localStorage.setItem(
      "explorer-tabs",
      JSON.stringify({
        version: 2,
        panes: { left: {}, right: {} },
        activePaneId: "left",
        dualPaneEnabled: false,
        splitRatio: 0.5,
      }),
    );
    const manager = createWindowTabsManager();
    expect(() => manager.init("/home/user")).not.toThrow();
    expect(manager.tabs.length).toBe(1);
  });
});

describe("close surface (#229)", () => {
  it("closes the focused pane when the tab has several", () => {
    const manager = freshManager();
    manager.splitPane("right", "/srv/docs");
    expect(manager.activePaneIds).toHaveLength(2);

    manager.closeSurface();

    expect(manager.tabs).toHaveLength(1);
    expect(manager.activePaneIds).toHaveLength(1);
    expect(manager.getPanePath(manager.activePaneId)).toBe("/home/user");
  });

  it("closes the whole tab when it has a single pane", () => {
    const manager = freshManager();
    manager.createTab("/srv/gone");
    expect(manager.tabs).toHaveLength(2);

    manager.closeSurface();

    expect(manager.tabs).toHaveLength(1);
    expect(manager.getTabPath(manager.activeTabId!)).toBe("/home/user");
  });
});

describe("closed-pane restore (#229)", () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let clock = 0;

  beforeEach(() => {
    clock = 1_000_000;
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++clock);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it("Ctrl+Shift+T restores the last closed pane back into its split position", () => {
    const manager = freshManager();
    manager.splitPane("down", "/srv/docs");
    const orderBefore = [...manager.activePaneIds];
    expect(orderBefore).toHaveLength(2);

    manager.closePane(); // closes the focused (second) pane
    expect(manager.activePaneIds).toHaveLength(1);

    const result = manager.restoreClosedSurface();
    expect(result).toMatchObject({ restored: true });
    expect(manager.activePaneIds).toHaveLength(2);
    // Restored below the surviving pane, focused, at its old path.
    expect(manager.activePaneId).toBe(manager.activePaneIds[1]);
    expect(manager.getPanePath(manager.activePaneId)).toBe("/srv/docs");
    // No tab was restored in the process.
    expect(manager.tabs).toHaveLength(1);
  });

  it("restores a pane closed on the LEFT back to the left", () => {
    const manager = freshManager();
    manager.splitPane("left", "/srv/first");
    // Focused pane is the new left pane.
    manager.closePane();

    manager.restoreClosedSurface();

    expect(manager.activePaneIds).toHaveLength(2);
    expect(manager.getPanePath(manager.activePaneIds[0])).toBe("/srv/first");
  });

  it("restores the tab, not the pane, when the tab close is more recent", () => {
    const manager = freshManager();
    manager.splitPane("right", "/srv/docs");
    manager.closePane(); // pane close first
    const gone = manager.createTab("/tmp/gone");
    manager.closeTab(gone.id); // tab close second (more recent)

    manager.restoreClosedSurface();
    expect(manager.tabs).toHaveLength(2);
    expect(manager.tabs.some((t) => manager.getTabPath(t.id) === "/tmp/gone")).toBe(true);
  });

  it("skips pane snapshots whose tab is gone and restores the closed tab", () => {
    const manager = freshManager();
    const tab = manager.createTab("/srv/multi");
    manager.splitPane("right", "/srv/extra");
    manager.closePane(); // pane snapshot for this tab
    manager.closeTab(tab.id); // the whole tab goes (more recent anyway)
    manager.createTab("/tmp/keepalive");

    manager.restoreClosedSurface();
    // The multi-pane tab returns; its pane snapshot is stale and pruned.
    expect(manager.tabs.some((t) => manager.getTabPath(t.id) === "/srv/multi")).toBe(true);
    manager.restoreClosedSurface();
    expect(manager.canRestoreSurface).toBe(false);
  });
});

describe("per-pane miller columns (#229)", () => {
  it("changing miller layers on one pane leaves the other pane alone", () => {
    const manager = freshManager();
    manager.splitPane("right", "/srv/docs");
    const [firstId, secondId] = manager.activePaneIds;
    const first = manager.getExplorer(firstId)!;
    const second = manager.getExplorer(secondId)!;
    expect(first.millerLayers).toBe(0);

    second.setMillerLayers(2);

    expect(second.millerLayers).toBe(2);
    expect(first.millerLayers).toBe(0);
  });

  it("toggle turns miller on to the preferred layer count and off again", () => {
    const manager = freshManager();
    const explorer = manager.getActiveExplorer()!;
    explorer.toggleMillerColumns();
    expect(explorer.millerLayers).toBeGreaterThan(0);
    explorer.toggleMillerColumns();
    expect(explorer.millerLayers).toBe(0);
  });
});

describe("per-pane SCM panel visibility (#434)", () => {
  it("panes follow the global showScmPanel default until they override it", () => {
    const manager = freshManager();
    const paneId = manager.activePaneId;
    // Default global setting is false → panes hidden by default.
    settingsStore.update({ showScmPanel: false });
    expect(manager.getPaneScmVisible(paneId)).toBe(false);

    // Flipping the global default is picked up by panes without an override.
    settingsStore.update({ showScmPanel: true });
    expect(manager.getPaneScmVisible(paneId)).toBe(true);

    settingsStore.update({ showScmPanel: false });
  });

  it("toggling one pane's panel leaves sibling panes on the global default", () => {
    const manager = freshManager();
    settingsStore.update({ showScmPanel: false });
    manager.splitPane("right", "/srv/docs");
    const [firstId, secondId] = manager.activePaneIds;

    // The split focused the second pane; toggle acts on it only.
    expect(manager.activePaneId).toBe(secondId);
    const opened = manager.toggleScmInActivePane();

    expect(opened).toBe(true);
    expect(manager.getPaneScmVisible(secondId)).toBe(true);
    expect(manager.getPaneScmVisible(firstId)).toBe(false);

    // Toggling again hides just that pane.
    const closed = manager.toggleScmInActivePane();
    expect(closed).toBe(false);
    expect(manager.getPaneScmVisible(secondId)).toBe(false);
    expect(manager.getPaneScmVisible(firstId)).toBe(false);
  });

  it("a per-pane override wins over a later change to the global default", () => {
    const manager = freshManager();
    settingsStore.update({ showScmPanel: false });
    const paneId = manager.activePaneId;

    // Explicit per-pane choice: visible.
    manager.toggleScmInActivePane();
    expect(manager.getPaneScmVisible(paneId)).toBe(true);

    // Turning the global default on must not disturb the explicit choice, and
    // turning it off must not hide a pane the user explicitly opened.
    settingsStore.update({ showScmPanel: true });
    expect(manager.getPaneScmVisible(paneId)).toBe(true);
    settingsStore.update({ showScmPanel: false });
    expect(manager.getPaneScmVisible(paneId)).toBe(true);

    settingsStore.update({ showScmPanel: false });
  });
});
