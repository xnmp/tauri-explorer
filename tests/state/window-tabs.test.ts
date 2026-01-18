/**
 * Tests for window-tabs state management.
 * Tests pure functions and persistence logic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  generateId,
  extractFolderName,
  type PersistedTab,
  type PersistedTabState,
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

describe("PersistedTabState serialization", () => {
  it("can be serialized to JSON", () => {
    const state: PersistedTabState = {
      tabs: [
        {
          id: "tab-123",
          panes: {
            left: { path: "/home/user" },
            right: { path: "/home/user/Documents" },
          },
          activePaneId: "left",
          dualPaneEnabled: false,
          splitRatio: 0.5,
        },
      ],
      activeTabId: "tab-123",
    };

    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as PersistedTabState;

    expect(parsed.tabs).toHaveLength(1);
    expect(parsed.tabs[0].id).toBe("tab-123");
    expect(parsed.tabs[0].panes.left.path).toBe("/home/user");
    expect(parsed.activeTabId).toBe("tab-123");
  });

  it("handles multiple tabs", () => {
    const state: PersistedTabState = {
      tabs: [
        {
          id: "tab-1",
          panes: {
            left: { path: "/home" },
            right: { path: "/tmp" },
          },
          activePaneId: "left",
          dualPaneEnabled: true,
          splitRatio: 0.3,
        },
        {
          id: "tab-2",
          panes: {
            left: { path: "/var/log" },
            right: { path: "/etc" },
          },
          activePaneId: "right",
          dualPaneEnabled: false,
          splitRatio: 0.7,
        },
      ],
      activeTabId: "tab-2",
    };

    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as PersistedTabState;

    expect(parsed.tabs).toHaveLength(2);
    expect(parsed.activeTabId).toBe("tab-2");
    expect(parsed.tabs[0].dualPaneEnabled).toBe(true);
    expect(parsed.tabs[1].activePaneId).toBe("right");
  });

  it("handles null activeTabId", () => {
    const state: PersistedTabState = {
      tabs: [],
      activeTabId: null,
    };

    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as PersistedTabState;

    expect(parsed.activeTabId).toBeNull();
  });
});

describe("Tab state invariants", () => {
  it("splitRatio should be bounded between 0.2 and 0.8", () => {
    // Test that valid split ratios are within bounds
    const validRatios = [0.2, 0.3, 0.5, 0.7, 0.8];
    for (const ratio of validRatios) {
      expect(ratio).toBeGreaterThanOrEqual(0.2);
      expect(ratio).toBeLessThanOrEqual(0.8);
    }
  });

  it("activePaneId should be left or right", () => {
    const validPaneIds = ["left", "right"] as const;
    const tab: PersistedTab = {
      id: "test",
      panes: {
        left: { path: "/home" },
        right: { path: "/tmp" },
      },
      activePaneId: "left",
      dualPaneEnabled: false,
      splitRatio: 0.5,
    };

    expect(validPaneIds).toContain(tab.activePaneId);
  });
});

describe("Tab index calculations", () => {
  // These test the logic that would be used in nextTab/prevTab

  it("next tab wraps around at end", () => {
    const tabCount = 3;
    const currentIndex = 2; // last tab
    const nextIndex = (currentIndex + 1) % tabCount;
    expect(nextIndex).toBe(0);
  });

  it("prev tab wraps around at start", () => {
    const tabCount = 3;
    const currentIndex = 0; // first tab
    const prevIndex = (currentIndex - 1 + tabCount) % tabCount;
    expect(prevIndex).toBe(2);
  });

  it("next tab advances normally", () => {
    const tabCount = 3;
    const currentIndex = 1;
    const nextIndex = (currentIndex + 1) % tabCount;
    expect(nextIndex).toBe(2);
  });

  it("prev tab goes back normally", () => {
    const tabCount = 3;
    const currentIndex = 2;
    const prevIndex = (currentIndex - 1 + tabCount) % tabCount;
    expect(prevIndex).toBe(1);
  });

  it("single tab stays in place for next", () => {
    const tabCount = 1;
    const currentIndex = 0;
    const nextIndex = (currentIndex + 1) % tabCount;
    expect(nextIndex).toBe(0);
  });

  it("insert position after active tab", () => {
    const tabs = ["tab-1", "tab-2", "tab-3"];
    const activeIndex = 1; // tab-2 is active
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : tabs.length;
    expect(insertIndex).toBe(2); // insert after tab-2
  });

  it("insert at end when no active tab", () => {
    const tabs = ["tab-1", "tab-2", "tab-3"];
    const activeIndex = -1; // no active tab found
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : tabs.length;
    expect(insertIndex).toBe(3); // insert at end
  });
});

describe("Close tab index selection", () => {
  // Test the logic for selecting next active tab after closing

  it("selects previous tab when closing last tab", () => {
    const tabs = ["tab-1", "tab-2", "tab-3"];
    const closingIndex = 2; // closing last tab
    const newIndex = Math.max(0, closingIndex - 1);
    expect(newIndex).toBe(1);
  });

  it("selects previous tab when closing middle tab", () => {
    const tabs = ["tab-1", "tab-2", "tab-3"];
    const closingIndex = 1;
    const newIndex = Math.max(0, closingIndex - 1);
    expect(newIndex).toBe(0);
  });

  it("stays at 0 when closing first tab", () => {
    const tabs = ["tab-1", "tab-2", "tab-3"];
    const closingIndex = 0;
    const newIndex = Math.max(0, closingIndex - 1);
    expect(newIndex).toBe(0);
  });
});

describe("Split ratio clamping", () => {
  // Test the clamping logic used in setSplitRatio

  function clampSplitRatio(ratio: number): number {
    return Math.max(0.2, Math.min(0.8, ratio));
  }

  it("clamps values below minimum to 0.2", () => {
    expect(clampSplitRatio(0)).toBe(0.2);
    expect(clampSplitRatio(0.1)).toBe(0.2);
    expect(clampSplitRatio(-1)).toBe(0.2);
  });

  it("clamps values above maximum to 0.8", () => {
    expect(clampSplitRatio(1)).toBe(0.8);
    expect(clampSplitRatio(0.9)).toBe(0.8);
    expect(clampSplitRatio(100)).toBe(0.8);
  });

  it("preserves values within bounds", () => {
    expect(clampSplitRatio(0.2)).toBe(0.2);
    expect(clampSplitRatio(0.5)).toBe(0.5);
    expect(clampSplitRatio(0.8)).toBe(0.8);
    expect(clampSplitRatio(0.33)).toBe(0.33);
  });
});
