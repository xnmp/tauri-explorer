/**
 * Tests for window-tabs state management.
 * Tests pure functions and persistence logic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  generateId,
  extractFolderName,
} from "$lib/state/window-tabs.svelte";

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


describe("refreshAllPanes", () => {
  it("silently refreshes both panes of the active tab", async () => {
    const { createWindowTabsManager } = await import("$lib/state/window-tabs.svelte");
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);

    const calls: Array<{ pane: string; silent: boolean | undefined }> = [];
    for (const pane of ["left", "right"] as const) {
      const explorer = manager.getExplorer(pane);
      expect(explorer).toBeDefined();
      const original = explorer!.refresh;
      // Wrap rather than fake: assert the real method is invoked with silent
      (explorer as any).refresh = (opts?: { silent?: boolean }) => {
        calls.push({ pane, silent: opts?.silent });
        return original(opts);
      };
    }

    manager.refreshAllPanes();

    expect(calls).toEqual([
      { pane: "left", silent: true },
      { pane: "right", silent: true },
    ]);
  });
});

describe("cross-window tab transfer primitives", () => {
  async function freshManager() {
    const { createWindowTabsManager } = await import("$lib/state/window-tabs.svelte");
    const manager = createWindowTabsManager();
    manager.init("/home/user", true);
    return manager;
  }

  it("exportTab serializes the live tab layout", async () => {
    const manager = await freshManager();
    manager.setDualPane(true);
    manager.setSplitRatio(0.7);

    const snapshot = manager.exportTab(manager.activeTabId!);
    expect(snapshot).toMatchObject({
      leftPath: "/home/user",
      dualPaneEnabled: true,
      splitRatio: 0.7,
      activePaneId: expect.any(String),
    });
  });

  it("exportTab returns null for unknown tabs", async () => {
    const manager = await freshManager();
    expect(manager.exportTab("nope")).toBeNull();
  });

  it("adoptTab inserts at the requested index and activates it", async () => {
    const manager = await freshManager();
    manager.createTab("/tmp/second");
    expect(manager.tabs.length).toBe(2);

    const adopted = manager.adoptTab(
      {
        leftPath: "/srv/incoming",
        rightPath: "/srv",
        activePaneId: "left",
        dualPaneEnabled: true,
        splitRatio: 0.6,
      },
      1,
    );

    expect(manager.tabs.length).toBe(3);
    expect(manager.tabs[1].id).toBe(adopted.id);
    expect(manager.activeTabId).toBe(adopted.id);
    expect(manager.dualPaneEnabled).toBe(true);
    expect(manager.getTabPath(adopted.id)).toBe("/srv/incoming");
  });

  it("adoptTab without an index appends at the end", async () => {
    const manager = await freshManager();
    const adopted = manager.adoptTab({
      leftPath: "/var/log",
      rightPath: "/var",
      activePaneId: "left",
      dualPaneEnabled: false,
      splitRatio: 0.5,
    });
    expect(manager.tabs[manager.tabs.length - 1].id).toBe(adopted.id);
  });

  it("removeTransferredTab removes without adding a closed-tab snapshot", async () => {
    const manager = await freshManager();
    const moved = manager.createTab("/tmp/moving");
    expect(manager.tabs.length).toBe(2);

    manager.removeTransferredTab(moved.id);

    expect(manager.tabs.length).toBe(1);
    expect(manager.tabs.some((t) => t.id === moved.id)).toBe(false);
    // The tab moved elsewhere — Ctrl+Shift+T must not resurrect it here.
    expect(manager.canRestoreTab).toBe(false);
  });
});
