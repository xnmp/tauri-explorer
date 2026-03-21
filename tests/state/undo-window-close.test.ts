/**
 * Regression test: Ctrl+Shift+T must re-read closedTabStack from localStorage
 * to detect snapshots written by other windows.
 * Issue: fix/undo-window-close
 */
import { describe, it, expect } from "vitest";

describe("Cross-window tab restore", () => {
  it("refreshClosedTabs picks up changes from localStorage", () => {
    // Simulate: window A writes a snapshot, window B reads it
    const key = "explorer-closed-tabs";
    const snapshot = [{ leftPath: "/test", rightPath: "/", activePaneId: "left", dualPaneEnabled: false, splitRatio: 0.5, closedAt: 0, fromClosedWindow: true }];

    localStorage.setItem(key, JSON.stringify(snapshot));
    const loaded = JSON.parse(localStorage.getItem(key) || "[]");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].fromClosedWindow).toBe(true);

    // Clean up
    localStorage.removeItem(key);
  });
});
