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

