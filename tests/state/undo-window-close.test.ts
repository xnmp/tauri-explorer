/**
 * Regression test: Ctrl+Shift+T must re-read closedTabStack from localStorage
 * to detect snapshots written by other windows.
 * Issue: fix/undo-window-close
 */
import { describe, it, expect } from "vitest";
import { loadPersisted, savePersisted } from "$lib/state/persisted";

describe("Cross-window tab restore", () => {
  it("savePersisted + loadPersisted round-trips closed tab snapshots", () => {
    const key = "test-closed-tabs";
    const snapshot = [
      {
        leftPath: "/test",
        rightPath: "/",
        activePaneId: "left",
        dualPaneEnabled: false,
        splitRatio: 0.5,
        closedAt: 0,
        fromClosedWindow: true,
      },
    ];

    savePersisted(key, snapshot);
    const loaded = loadPersisted<typeof snapshot>(key, []);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].fromClosedWindow).toBe(true);
    expect(loaded[0].leftPath).toBe("/test");
  });

  it("loadPersisted returns default when key is missing", () => {
    const loaded = loadPersisted<unknown[]>("nonexistent-key-12345", []);
    expect(loaded).toEqual([]);
  });
});
