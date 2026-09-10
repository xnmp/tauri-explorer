import { beforeEach, describe, expect, it, vi } from "vitest";

const driver = vi.hoisted(() => ({
  getWindowHandles: vi.fn(),
  switchToWindow: vi.fn(),
  execute: vi.fn(),
  waitUntil: vi.fn(),
}));
vi.mock("@wdio/globals", () => ({ browser: driver, $: vi.fn(), $$: vi.fn() }));

import { switchToFreshWindow } from "../../e2e-tauri/specs/helpers";

describe("fresh native window selection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    driver.waitUntil.mockImplementation(async (ready: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await ready()) return;
      }
      throw new Error("window did not become ready");
    });
  });

  it("finds the newly launched child without executing script in an unresponsive existing page", async () => {
    let current = "main";
    driver.getWindowHandles.mockResolvedValue(["parked", "main", "child"]);
    driver.switchToWindow.mockImplementation(async (handle: string) => { current = handle; });
    let reads = 0;
    driver.execute.mockImplementation(async () => {
      if (current !== "child") throw new Error("existing page cannot execute script");
      return ++reads === 1 ? undefined : "explorer-child";
    });

    await expect(switchToFreshWindow("explorer-child", ["parked", "main"]))
      .resolves.toBe("child");
  });

  it("does not accept an existing page as evidence of a fresh launch", async () => {
    driver.getWindowHandles.mockResolvedValue(["old"]);
    driver.execute.mockResolvedValue("explorer-child");

    await expect(switchToFreshWindow("explorer-child", ["old"]))
      .rejects.toThrow("window did not become ready");
  });
});
