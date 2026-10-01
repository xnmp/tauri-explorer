import fs from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const driver = vi.hoisted(() => ({
  getWindowHandles: vi.fn(),
  switchToWindow: vi.fn(),
  execute: vi.fn(),
  getUrl: vi.fn(),
  pause: vi.fn(),
}));
vi.mock("@wdio/globals", () => ({ browser: driver, $: vi.fn(), $$: vi.fn() }));

// Keep fresh-window diagnostics (#781) out of the checkout during unit runs.
const diagnostics = vi.hoisted(() => {
  // Hoisted before any import, so build the path without node:fs/os helpers.
  const directory = `${process.env.TMPDIR ?? "/tmp"}/fresh-native-window-${process.pid}`;
  process.env.TAURI_NATIVE_DIAGNOSTICS_DIR = directory;
  return directory;
});

import { switchToFreshWindow } from "../../e2e-tauri/specs/helpers";

describe("fresh native window selection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Each pause between scans spends a third of the 20 s selection budget.
    vi.useFakeTimers({ toFake: ["Date"] });
    driver.pause.mockImplementation(async () => { vi.setSystemTime(Date.now() + 7_000); });
    driver.getUrl.mockResolvedValue("tauri://localhost/?path=%2Fhome");
  });
  afterEach(() => { vi.useRealTimers(); });

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

  it("does not script a warm window spawned while the child launches (#931)", async () => {
    let current = "main";
    driver.getWindowHandles.mockResolvedValue(["main", "warm", "child"]);
    driver.switchToWindow.mockImplementation(async (handle: string) => { current = handle; });
    driver.getUrl.mockImplementation(async () => current === "warm"
      ? "tauri://localhost/?warm=1&path=%2Fhome"
      : "tauri://localhost/?path=%2Fhome");
    driver.execute.mockImplementation(async () => {
      if (current === "warm") throw new Error("session deleted because of page crash or hang");
      return "explorer-child";
    });

    await expect(switchToFreshWindow("explorer-child", ["main"])).resolves.toBe("child");
  });

  it("does not accept an existing page as evidence of a fresh launch", async () => {
    driver.getWindowHandles.mockResolvedValue(["old"]);
    driver.execute.mockResolvedValue("explorer-child");

    await expect(switchToFreshWindow("explorer-child", ["old"]))
      .rejects.toThrow("fresh native window explorer-child did not become ready");
  });
});

afterAll(() => fs.rmSync(diagnostics, { recursive: true, force: true }));
