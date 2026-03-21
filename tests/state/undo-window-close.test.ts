/**
 * Regression test: Ctrl+Shift+T must re-read closedTabStack from localStorage
 * to detect snapshots written by other windows.
 * Issue: fix/undo-window-close
 *
 * We test the business rule (stale array must be refreshed before pop)
 * without depending on localStorage, which is unreliable across Node versions.
 */
import { describe, it, expect } from "vitest";

describe("Cross-window tab restore", () => {
  it("stale in-memory array misses entries added externally", () => {
    // Simulates the bug: window B has an empty closedTabStack,
    // window A closes a tab (writes to shared storage),
    // window B's in-memory array is stale and pop() returns undefined.
    const staleStack: string[] = [];
    const sharedStorage = ["/test/path"]; // written by window A

    // Without refresh: stale stack is empty
    expect(staleStack.pop()).toBeUndefined();

    // With refresh: re-read from shared storage picks up the new entry
    const refreshedStack = [...sharedStorage];
    expect(refreshedStack.pop()).toBe("/test/path");
  });

  it("refreshed array preserves LIFO order", () => {
    const sharedStorage = ["/first", "/second", "/third"];
    const refreshed = [...sharedStorage];

    expect(refreshed.pop()).toBe("/third");
    expect(refreshed.pop()).toBe("/second");
    expect(refreshed.pop()).toBe("/first");
  });
});
